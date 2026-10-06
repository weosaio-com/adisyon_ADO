import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { readFileSync } from 'node:fs';
import { menuSnapshotSchema, newId, type DomainEvent } from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { BackgroundWorkerService } from '../common/worker/worker.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flags.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { categoryView, productView } from '../catalog/catalog.views';
import { menuImagePath } from '../catalog/catalog.images';
import { buildMenuSnapshot, buildTableList, normalizeCloudUrl } from './cloud.snapshot';
import { cloudApi, CloudError, type CloudConnection } from './cloud.client';

export const CLOUD_PUBLISH_TASK = 'cloud.publish';
const CONNECTION_KEY = 'cloud.connection';
const STATE_KEY = 'cloud.state';
/** Arka arkaya urun duzenlemeleri tek yayinda birlesir. */
const PUBLISH_DELAY_SECONDS = 5;

interface PublishState {
  lastPublishedAt: string | null;
  lastMenuVersion: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
}
const EMPTY_STATE: PublishState = {
  lastPublishedAt: null,
  lastMenuVersion: null,
  lastError: null,
  lastErrorAt: null,
};

/**
 * QR menu bulut baglantisi: eslestirme, otomatik yayin (menu + gorseller + masalar), durum.
 * Baglanti ApplicationSetting'te durur (`/settings` listesine cikmaz). Yayin arka plan isidir:
 * urun/kategori/masa degisince 5 sn sonra, subenin bekleyen yayini varsa yenisi acilmaz.
 * Lisans yalniz arayuzu gizler ("qr.menu": false); asil paket kapisi buluttadir.
 */
@Injectable()
export class CloudService implements OnModuleInit {
  private readonly logger = new Logger(CloudService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: BackgroundWorkerService,
    private readonly flags: FeatureFlagService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.worker.registerHandler(CLOUD_PUBLISH_TASK, (_payload, branchId) => this.publish(branchId));
  }

  // ===========================================================================
  // Ayarlar
  // ===========================================================================
  private async readSetting<T>(branchId: string, key: string): Promise<T | null> {
    const row = await this.prisma.applicationSetting.findUnique({
      where: { branchId_key: { branchId, key } },
    });
    if (!row || row.deletedAt) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  private async writeSetting(branchId: string, key: string, value: unknown, userId?: string) {
    const serialized = JSON.stringify(value);
    await this.prisma.applicationSetting.upsert({
      where: { branchId_key: { branchId, key } },
      update: {
        value: serialized,
        deletedAt: null,
        version: { increment: 1 },
        ...(userId ? { updatedBy: userId } : {}),
      },
      create: { id: newId(), branchId, key, value: serialized, updatedBy: userId ?? null },
    });
  }

  private connection(branchId: string) {
    return this.readSetting<CloudConnection>(branchId, CONNECTION_KEY);
  }

  private async updateState(branchId: string, patch: Partial<PublishState>) {
    const current = (await this.readSetting<PublishState>(branchId, STATE_KEY)) ?? EMPTY_STATE;
    await this.writeSetting(branchId, STATE_KEY, { ...current, ...patch });
  }

  /** Lisans QR menuyu acikca kapatmadiysa kart gorunur (lisanssiz gelistirmede de acik). */
  async licenseAllows(): Promise<boolean> {
    return (await this.flags.getAllFlags())['qr.menu'] !== false;
  }

  // ===========================================================================
  // Durum / eslestirme / baglantiyi kaldirma
  // ===========================================================================
  async status(user: AuthUser) {
    const [conn, state, active] = await Promise.all([
      this.connection(user.branchId),
      this.readSetting<PublishState>(user.branchId, STATE_KEY),
      this.prisma.backgroundJob.count({
        where: {
          branchId: user.branchId,
          taskName: CLOUD_PUBLISH_TASK,
          status: { in: ['pending', 'running'] },
        },
      }),
    ]);
    return {
      enabled: await this.licenseAllows(),
      connected: Boolean(conn),
      url: conn?.url ?? null,
      branchName: conn?.branchName ?? null,
      tenantName: conn?.tenantName ?? null,
      planLabel: conn?.planLabel ?? null,
      // Paket QR menuyu icermiyorsa musteri sayfasi acilmaz; kasada uyari gosterilir.
      menuEnabled: conn ? conn.features['qr.menu'] !== false : null,
      pairedAt: conn?.pairedAt ?? null,
      lastPublishedAt: state?.lastPublishedAt ?? null,
      lastMenuVersion: state?.lastMenuVersion ?? null,
      lastError: state?.lastError ?? null,
      lastErrorAt: state?.lastErrorAt ?? null,
      publishing: active > 0,
    };
  }

  async pair(user: AuthUser, dto: { url: string; code: string }) {
    if (!(await this.licenseAllows())) {
      throw new ForbiddenException({
        code: 'QR_MENU_NOT_LICENSED',
        message: 'Lisansınız QR menüyü içermiyor.',
      });
    }
    let url: string;
    try {
      url = normalizeCloudUrl(dto.url);
    } catch (err) {
      throw new BadRequestException({
        code: 'CLOUD_URL_INVALID',
        message: err instanceof Error ? err.message : 'Geçersiz bulut adresi.',
      });
    }
    let result: Awaited<ReturnType<typeof cloudApi.pair>>;
    try {
      result = await cloudApi.pair(url, dto.code);
    } catch (err) {
      throw toHttpError(err);
    }
    const conn: CloudConnection = {
      url,
      token: result.token,
      branchId: result.branch.id,
      branchName: result.branch.name,
      tenantName: result.tenant.name,
      planLabel: result.tenant.planLabel,
      features: result.tenant.features,
      pairedAt: new Date().toISOString(),
    };
    await this.writeSetting(user.branchId, CONNECTION_KEY, conn, user.userId);
    await this.writeSetting(user.branchId, STATE_KEY, EMPTY_STATE, user.userId);
    await this.audit.record({
      branchId: user.branchId,
      action: 'cloud.pair',
      entityType: 'cloud',
      entityId: conn.branchId,
      userId: user.userId,
      newValue: { url, branch: conn.branchName, tenant: conn.tenantName },
      ...(user.deviceId ? { deviceId: user.deviceId } : {}),
    });
    await this.requestPublish(user.branchId, 0);
    return this.status(user);
  }

  async disconnect(user: AuthUser) {
    const conn = await this.connection(user.branchId);
    if (conn) {
      // Bulutta da kaldir (belirtec iptal, menu panele doner). Bulut kapaliysa yerelde yine kaldirilir.
      await cloudApi.unpair(conn).catch((err: unknown) => {
        this.logger.warn(`Buluttan ayrilma bildirilemedi: ${String(err)}`);
      });
    }
    await this.prisma.backgroundJob.deleteMany({
      where: { branchId: user.branchId, taskName: CLOUD_PUBLISH_TASK, status: 'pending' },
    });
    await this.prisma.applicationSetting.deleteMany({
      where: { branchId: user.branchId, key: { in: [CONNECTION_KEY, STATE_KEY] } },
    });
    await this.audit.record({
      branchId: user.branchId,
      action: 'cloud.disconnect',
      entityType: 'cloud',
      entityId: conn?.branchId ?? user.branchId,
      userId: user.userId,
      oldValue: conn ? { url: conn.url, branch: conn.branchName } : null,
      ...(user.deviceId ? { deviceId: user.deviceId } : {}),
    });
    return this.status(user);
  }

  // ===========================================================================
  // Yayin
  // ===========================================================================

  /** Yayin isi kuyruklar; bekleyen varsa yenisi acilmaz ("Simdi yayinla" onu one alir). */
  async requestPublish(branchId: string, delaySeconds = PUBLISH_DELAY_SECONDS): Promise<boolean> {
    if (!(await this.connection(branchId))) return false;
    const pending = await this.prisma.backgroundJob.findFirst({
      where: { branchId, taskName: CLOUD_PUBLISH_TASK, status: 'pending' },
    });
    if (pending) {
      if (delaySeconds === 0 && pending.runAt > new Date()) {
        await this.prisma.backgroundJob.update({
          where: { id: pending.id },
          data: { runAt: new Date() },
        });
      }
      return true;
    }
    await this.worker.enqueue(branchId, CLOUD_PUBLISH_TASK, {}, delaySeconds);
    return true;
  }

  async publishNow(user: AuthUser) {
    if (!(await this.requestPublish(user.branchId, 0))) {
      throw new ConflictException({
        code: 'CLOUD_NOT_CONNECTED',
        message: 'QR menü bulutuna bağlı değil.',
      });
    }
    return this.status(user);
  }

  // Menuyu etkileyen her degisiklik yayin ister (dinleyici hizli: yalniz kuyruga yazar).
  @OnEvent('product.*')
  @OnEvent('category.*')
  @OnEvent('table.*')
  async onCatalogChanged(event: DomainEvent) {
    await this.requestPublish(event.branchId);
  }

  /** Arka plan isi: menu, eksik gorseller ve masalar buluta gonderilir. */
  async publish(branchId: string): Promise<void> {
    const conn = await this.connection(branchId);
    if (!conn) return;
    try {
      const { menu, tables } = await this.buildPayload(branchId);
      const keys = [...new Set(menu.products.flatMap((p) => (p.imageKey ? [p.imageKey] : [])))];
      if (keys.length) {
        const { missing } = await cloudApi.checkImages(conn, keys);
        for (const key of missing) {
          const path = menuImagePath(key);
          if (!path) {
            // Gorsel dosyasi bu bilgisayarda yok: urun gorselsiz yayinlanir.
            this.logger.warn(`Gorsel dosyasi bulunamadi, gorselsiz yayinlaniyor: ${key}`);
            for (const product of menu.products)
              if (product.imageKey === key) product.imageKey = null;
            continue;
          }
          await cloudApi.putImage(conn, key, readFileSync(path));
        }
      }
      const parsed = menuSnapshotSchema.safeParse(menu);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`Menü doğrulanamadı: ${issue?.path.join('.')} ${issue?.message ?? ''}`);
      }
      const saved = await cloudApi.putMenu(conn, parsed.data);
      await cloudApi.putTables(conn, tables);
      await this.updateState(branchId, {
        lastPublishedAt: new Date().toISOString(),
        lastMenuVersion: saved.version,
        lastError: null,
        lastErrorAt: null,
      });
    } catch (err) {
      const unpaired = err instanceof CloudError && err.status === 401;
      await this.updateState(branchId, {
        lastError: unpaired
          ? 'Bulut bu POS bağlantısını tanımıyor (panelden kaldırılmış olabilir). Yeniden eşleştirin.'
          : err instanceof Error
            ? err.message
            : String(err),
        lastErrorAt: new Date().toISOString(),
      });
      // Belirtec gecersizse tekrar denemek anlamsiz; digerleri worker ile geri cekilerek denenir.
      if (!unpaired) throw err;
    }
  }

  private async buildPayload(branchId: string) {
    const [branch, categories, products, tables] = await Promise.all([
      this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { name: true, address: true, phone: true },
      }),
      this.prisma.category.findMany({ where: { branchId, deletedAt: null } }),
      this.prisma.product.findMany({ where: { branchId, deletedAt: null } }),
      this.prisma.table.findMany({
        where: {
          branchId,
          deletedAt: null,
          isActive: true,
          hall: { deletedAt: null, isActive: true },
        },
        include: { hall: { select: { name: true, sortOrder: true } } },
      }),
    ]);
    const menu = buildMenuSnapshot({
      branch: branch ?? { name: '', address: null, phone: null },
      categories: categories.map(categoryView),
      products: products.map(productView),
    });
    return { menu, tables: buildTableList(tables) };
  }
}

function toHttpError(err: unknown) {
  if (err instanceof CloudError) {
    const body = { code: err.code, message: err.message };
    return err.status === 0 || err.status >= 500
      ? new BadGatewayException(body)
      : new BadRequestException(body);
  }
  return new BadGatewayException({
    code: 'CLOUD_ERROR',
    message: err instanceof Error ? err.message : String(err),
  });
}
