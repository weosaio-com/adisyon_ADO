import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { readFileSync } from 'node:fs';
import {
  MENU_LIMITS,
  menuSnapshotSchema,
  newId,
  QR_MENU_FEATURE,
  type DomainEvent,
} from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { BackgroundWorkerService } from '../common/worker/worker.service';
import { AppConfigService } from '../config/app-config.service';
import { resolveInstallId } from '../common/util/install-id';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { LicenseService } from '../license/license.service';
import { categoryView, productView } from '../catalog/catalog.views';
import { menuImagePath } from '../catalog/catalog.images';
import { buildMenuSnapshot, buildTableList, normalizeCloudUrl } from './cloud.snapshot';
import { cloudApi, CloudError, type CloudConnection, type PosInfo } from './cloud.client';
import {
  blockedFromStatus,
  classifyCloudError,
  cloudMode,
  EMPTY_STATE,
  payloadHash,
  statusDue,
  withDefaults,
  withPendingUnpair,
  type CloudErrorKind,
  type CloudState,
  type LostReason,
  type PendingUnpair,
} from './cloud.state';

export const CLOUD_PUBLISH_TASK = 'cloud.publish';
const CONNECTION_KEY = 'cloud.connection';
const STATE_KEY = 'cloud.state';
/** Arka arkaya urun duzenlemeleri tek yayinda birlesir. */
const PUBLISH_DELAY_SECONDS = 5;

interface UsableLicense {
  key: string;
  id: string | null;
  qrMenu: boolean;
  expired: boolean;
}
/** Acmaya uygun lisans: kimligi var (bulut isletmeyi bununla tanir). */
type ActivatableLicense = UsableLicense & { id: string };

/**
 * QR menu bulut baglantisi: lisansla acma ("QR menuyu ac"), otomatik yayin (menu + gorseller +
 * masalar), kapatma, durum. Bulut adresi programa gomuludur (derleme profili -> CLOUD_API_URL);
 * kullanici adres ya da kod girmez. Baglanti ApplicationSetting'te durur (`/settings` listesine
 * cikmaz). Yayin arka plan isidir: menuyu etkileyen her degisiklikten 5 sn sonra. Ayrica her
 * CLOUD_RECONCILE_SECONDS'ta bir uzlastirma: kacan yayini, internet yokken istenen acma/kapatmayi ve
 * lisans yenilemesini tamamlar, saatte bir buluttan isletme durumunu okur. Tasarim: QR_MENU_DESIGN.md.
 */
@Injectable()
export class CloudService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CloudService.name);
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;
  /** Ayni subede ayni anda iki acma istegi gitmesin (cift tiklama). */
  private readonly activating = new Set<string>();
  /** Sube basina `cloud.state` yazim sirasi (bkz. mutateState). */
  private readonly stateWrites = new Map<string, Promise<void>>();
  /** Sube basina uzlastirma sirasi (bkz. reconcileBranch). */
  private readonly reconcileRuns = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: BackgroundWorkerService,
    private readonly licenses: LicenseService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit() {
    this.worker.registerHandler(CLOUD_PUBLISH_TASK, (_payload, branchId) => this.publish(branchId));
  }

  async onApplicationBootstrap() {
    await this.checkConnectionsOnBoot().catch((err: unknown) => {
      this.logger.error(`Bulut baglanti denetimi yapilamadi: ${String(err)}`);
    });
    void this.reconcileAll();
    this.reconcileTimer = setInterval(
      () => void this.reconcileAll(),
      this.config.cloudReconcileSeconds * 1000,
    );
    this.reconcileTimer.unref();
  }

  onModuleDestroy() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
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

  private async state(branchId: string): Promise<CloudState> {
    return withDefaults(await this.readSetting<Partial<CloudState>>(branchId, STATE_KEY));
  }

  /**
   * `cloud.state` oku-degistir-yaz. Yayin isi, uzlastirma ve istekler ayni anda calisabilir; ayni
   * subede yazimlar sirayla yapilir ki biri digerinin degisikligini ezmesin.
   */
  private async mutateState(
    branchId: string,
    change: (state: CloudState) => CloudState,
    userId?: string,
  ): Promise<void> {
    const previous = this.stateWrites.get(branchId) ?? Promise.resolve();
    const run = previous.then(async () => {
      await this.writeSetting(branchId, STATE_KEY, change(await this.state(branchId)), userId);
    });
    const settled = run.catch(() => undefined);
    this.stateWrites.set(branchId, settled);
    try {
      await run;
    } finally {
      if (this.stateWrites.get(branchId) === settled) this.stateWrites.delete(branchId);
    }
  }

  private updateState(branchId: string, patch: Partial<CloudState>) {
    return this.mutateState(branchId, (state) => ({ ...state, ...patch }));
  }

  /** Baglantiyi yerelde kaldirir (bekleyen yayinlar da). Buluta bildirmez. */
  private async dropConnection(branchId: string) {
    await this.prisma.backgroundJob.deleteMany({
      where: { branchId, taskName: CLOUD_PUBLISH_TASK, status: 'pending' },
    });
    await this.prisma.applicationSetting.deleteMany({ where: { branchId, key: CONNECTION_KEY } });
  }

  /** Programa gomulu bulut adresi (derleme profili -> CLOUD_API_URL); gecersizse null. */
  private cloudUrl(): string | null {
    const raw = this.config.cloudApiUrl;
    if (!raw) return null;
    try {
      return normalizeCloudUrl(raw);
    } catch {
      return null;
    }
  }

  /** Imzasi bu kurulumda dogrulanan lisans (LicenseService her okumada yeniden dogrular). */
  private async license(): Promise<UsableLicense | null> {
    const active = await this.licenses.getActiveLicense();
    if (!active) return null;
    return {
      key: active.key,
      id: active.payload.id ?? null,
      qrMenu: active.payload.f?.[QR_MENU_FEATURE] === true,
      expired: active.state === 'expired',
    };
  }

  // ===========================================================================
  // Durum / acma / kapatma
  // ===========================================================================
  async status(user: AuthUser) {
    const branchId = user.branchId;
    const [conn, state, license, publishing] = await Promise.all([
      this.connection(branchId),
      this.state(branchId),
      this.license(),
      this.prisma.backgroundJob.count({
        where: { branchId, taskName: CLOUD_PUBLISH_TASK, status: { in: ['pending', 'running'] } },
      }),
    ]);
    const url = this.cloudUrl();
    return {
      mode: cloudMode({
        configured: Boolean(url),
        license: license && { id: license.id, qrMenu: license.qrMenu, expired: license.expired },
        connected: Boolean(conn),
        state,
      }),
      /** Bu kurulumda QR menu bulutu tanimli mi (kart gorunur). */
      enabled: Boolean(url),
      /** QR kartlarindaki adres: bagliysa baglanti adresi, degilse gomulu adres. */
      url: conn?.url ?? url,
      connected: Boolean(conn),
      licenseId: license?.id ?? null,
      branchName: conn?.branchName ?? null,
      tenantName: conn?.tenantName ?? null,
      tenantStatus: conn?.tenantStatus ?? null,
      planLabel: conn?.planLabel ?? null,
      // Paket QR menuyu icermiyorsa musteri sayfasi acilmaz; kasada uyari gosterilir.
      menuEnabled: conn ? conn.features[QR_MENU_FEATURE] !== false : null,
      licenseExpiresAt: conn?.licenseExpiresAt ?? null,
      pairedAt: conn?.pairedAt ?? null,
      lostReason: conn ? null : (state.lost?.reason ?? null),
      conflictLastSeenAt: state.conflict?.lastSeenAt ?? null,
      lastPublishedAt: state.lastPublishedAt,
      lastMenuVersion: state.lastMenuVersion,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
      publishing: publishing > 0,
    };
  }

  /**
   * "QR menuyu ac": lisansla buluta baglanir, ilk yayin hemen baslar. Internet yoksa istek saklanir
   * ve uzlastirma yeniden dener; lisans baska kurulumda aciksa sahibin onayi (takeover) beklenir.
   */
  async activate(user: AuthUser, opts: { takeover?: boolean | undefined } = {}) {
    const url = this.cloudUrl();
    if (!url) {
      throw new ConflictException({
        code: 'CLOUD_NOT_CONFIGURED',
        message: 'Bu kurulumda QR menü bulutu tanımlı değil.',
      });
    }
    const license = await this.license();
    if (!license) {
      throw new ForbiddenException({
        code: 'LICENSE_REQUIRED',
        message: 'QR menü için önce Ayarlar › Lisans bölümünden lisansınızı girin.',
      });
    }
    if (!license.id || !license.qrMenu) {
      throw new ForbiddenException({
        code: 'QR_MENU_NOT_LICENSED',
        message: 'Lisansınız QR menüyü içermiyor.',
      });
    }
    if (license.expired) {
      throw new ForbiddenException({ code: 'LICENSE_EXPIRED', message: 'Lisansın süresi dolmuş.' });
    }
    if (!(await this.connection(user.branchId)) && !this.activating.has(user.branchId)) {
      this.activating.add(user.branchId);
      try {
        const activatable = { ...license, id: license.id };
        await this.tryActivate(user.branchId, url, activatable, Boolean(opts.takeover), user);
      } finally {
        this.activating.delete(user.branchId);
      }
    }
    return this.status(user);
  }

  private async tryActivate(
    branchId: string,
    url: string,
    license: ActivatableLicense,
    takeover: boolean,
    user?: AuthUser,
  ): Promise<void> {
    const now = new Date().toISOString();
    const installId = resolveInstallId();
    // Eski baglantilar once kapatilir: masa kodlari eski subede kalirsa yeni sube yayinlayamaz.
    await this.flushPendingUnpairs(branchId);
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { name: true },
    });
    let result: PosInfo & { token: string };
    try {
      result = await cloudApi.activate(url, {
        licenseKey: license.key,
        installId,
        posBranchId: branchId,
        ...(branch?.name.trim()
          ? { branchName: branch.name.trim().slice(0, MENU_LIMITS.branchName) }
          : {}),
        ...(takeover ? { takeover: true } : {}),
      });
    } catch (err) {
      const kind = errorKind(err);
      if (kind.kind === 'network') {
        await this.updateState(branchId, {
          activationPending: { takeover, at: now },
          conflict: null,
          lastError: errorMessage(err),
          lastErrorAt: now,
        });
        return;
      }
      if (kind.kind === 'conflict') {
        const details = err instanceof CloudError ? err.details : null;
        const lastSeenAt =
          details && typeof details === 'object' && 'lastSeenAt' in details
            ? String((details as { lastSeenAt: unknown }).lastSeenAt ?? '') || null
            : null;
        await this.updateState(branchId, {
          activationPending: null,
          conflict: { lastSeenAt, at: now },
        });
        return;
      }
      await this.updateState(branchId, { activationPending: null });
      if (user) throw toHttpError(err);
      this.logger.warn(`QR menu acilamadi: ${errorMessage(err)}`);
      return;
    }

    const conn: CloudConnection = {
      url,
      token: result.token,
      installId,
      licenseId: license.id,
      ...connectionInfo(result),
      pairedAt: now,
    };
    await this.writeSetting(branchId, CONNECTION_KEY, conn, user?.userId);
    // Henuz kapatilamayan eski baglantilar (internet yok, eski adres) denenmeye devam eder.
    await this.mutateState(
      branchId,
      (state) => ({ ...EMPTY_STATE, pendingUnpairs: state.pendingUnpairs, lastStatusAt: now }),
      user?.userId,
    );
    await this.audit.record({
      branchId,
      action: 'cloud.activate',
      entityType: 'cloud',
      entityId: conn.branchId,
      ...(user ? { userId: user.userId } : {}),
      newValue: { url, branch: conn.branchName, tenant: conn.tenantName, takeover },
      ...(user?.deviceId ? { deviceId: user.deviceId } : {}),
    });
    await this.requestPublish(branchId, 0);
  }

  /**
   * "QR menuyu kapat": bulutta menu ve masalar yayindan kalkar, belirtec iptal edilir. Internet
   * yoksa yerelde hemen kapanir; bulut tarafi uzlastirmada tamamlanir.
   */
  async disconnect(user: AuthUser) {
    const branchId = user.branchId;
    const conn = await this.connection(branchId);
    let pending: PendingUnpair | null = null;
    if (conn) {
      try {
        await cloudApi.unpair(conn);
      } catch (err) {
        // 401: bulutta zaten gecersiz. Gecici hatada sonra yeniden denenir.
        if (errorKind(err).kind === 'network') pending = { url: conn.url, token: conn.token };
        this.logger.warn(`Buluttan ayrilma bildirilemedi: ${errorMessage(err)}`);
      }
    }
    await this.dropConnection(branchId);
    await this.mutateState(
      branchId,
      (state) => ({
        ...EMPTY_STATE,
        pendingUnpairs: pending
          ? withPendingUnpair(state.pendingUnpairs, pending)
          : state.pendingUnpairs,
      }),
      user.userId,
    );
    await this.audit.record({
      branchId,
      action: 'cloud.disconnect',
      entityType: 'cloud',
      entityId: conn?.branchId ?? branchId,
      userId: user.userId,
      oldValue: conn ? { url: conn.url, branch: conn.branchName } : null,
      ...(user.deviceId ? { deviceId: user.deviceId } : {}),
    });
    return this.status(user);
  }

  /**
   * Baglanti bulutta gecersiz kilindi (401): yerelde kaldirilir, kart nedenini gosterir. Istekteki
   * belirtec artik kayitli degilse (bu arada kapatildi ya da yeniden acildi) dokunulmaz.
   */
  private async loseConnection(
    branchId: string,
    token: string,
    reason: LostReason,
    message: string,
  ) {
    if ((await this.connection(branchId))?.token !== token) return;
    await this.dropConnection(branchId);
    const now = new Date().toISOString();
    await this.updateState(branchId, {
      lost: { reason, at: now },
      blocked: null,
      licenseSyncPending: false,
      lastError: message,
      lastErrorAt: now,
    });
    this.logger.warn(`QR menu baglantisi gecersiz (${reason}): ${message}`);
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
        message: 'QR menü açık değil.',
      });
    }
    return this.status(user);
  }

  // Menuyu etkileyen her degisiklik yayin ister (dinleyici hizli: yalniz kuyruga yazar).
  @OnEvent('product.*')
  @OnEvent('category.*')
  @OnEvent('table.*')
  @OnEvent('hall.*')
  @OnEvent('branch.updated')
  async onMenuChanged(event: DomainEvent) {
    await this.requestPublish(event.branchId);
  }

  // Yeni lisans: bagliysa buluta bildirilir (ayni kimlik: belirtec degismeden yenilenir). Beklenmez:
  // lisans etkinlestirme yaniti internete takilmasin; olmazsa uzlastirma yeniden dener.
  @OnEvent('license.activated')
  async onLicenseActivated(event: DomainEvent) {
    if (!(await this.connection(event.branchId))) return;
    await this.updateState(event.branchId, { licenseSyncPending: true });
    void this.reconcileBranch(event.branchId);
  }

  /** Arka plan isi: menu, eksik gorseller ve masalar buluta gonderilir. */
  async publish(branchId: string): Promise<void> {
    const conn = await this.connection(branchId);
    if (!conn) return;
    try {
      const { menu, tables } = await this.buildPayload(branchId);
      // Ozet, gorsel ayiklamasindan ONCE: uzlastirma ayni kaynagi karsilastirir.
      const sourceHash = payloadHash({ menu, tables });
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
        lastPayloadHash: sourceHash,
        lastAttemptFailed: false,
        blocked: null,
      });
    } catch (err) {
      const kind = errorKind(err);
      if (kind.kind === 'lost') {
        await this.loseConnection(branchId, conn.token, kind.reason, errorMessage(err));
        return;
      }
      const now = new Date().toISOString();
      await this.updateState(branchId, {
        lastError: errorMessage(err),
        lastErrorAt: now,
        lastAttemptFailed: true,
        ...(kind.kind === 'blocked' ? { blocked: kind.reason } : {}),
      });
      // Bulut yayini reddediyorsa (askida/dolmus) tekrar denemek anlamsiz; durum duzelince
      // uzlastirma devam ettirir. Digerleri worker ile geri cekilerek denenir.
      if (kind.kind !== 'blocked') throw err;
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

  // ===========================================================================
  // Acilis denetimi ve uzlastirma
  // ===========================================================================

  /**
   * Kayitli baglanti bu kuruluma ait degilse duser: eski (eslestirme kodlu) baglanti, baska
   * bilgisayardan geri yuklenen yedek, degisen bulut adresi ya da farkli lisans. Yedek disindaki
   * durumlarda eski baglanti bulutta da kapatilir (eski menu yayinda kalmasin).
   */
  private async checkConnectionsOnBoot() {
    const rows = await this.prisma.applicationSetting.findMany({
      where: { key: CONNECTION_KEY, deletedAt: null },
    });
    if (rows.length === 0) return;
    const url = this.cloudUrl();
    const installId = resolveInstallId();
    const license = await this.license();
    for (const row of rows) {
      let conn: Partial<CloudConnection> | null = null;
      try {
        conn = JSON.parse(row.value) as Partial<CloudConnection>;
      } catch {
        conn = null;
      }
      const reason =
        !conn?.installId || !conn.licenseId
          ? 'eski baglanti'
          : conn.installId !== installId
            ? 'baska kurulumun yedegi'
            : conn.url !== url
              ? 'bulut adresi degisti'
              : license?.id && license.id !== conn.licenseId
                ? 'farkli lisans'
                : null;
      if (!reason) continue;
      // Baska bilgisayarin yedegiyse o bilgisayar hala yayinda olabilir: bulutta kapatilmaz.
      const pending =
        reason !== 'baska kurulumun yedegi' && conn?.url && conn.token
          ? { url: conn.url, token: conn.token }
          : null;
      await this.dropConnection(row.branchId);
      await this.mutateState(row.branchId, (state) => ({
        ...EMPTY_STATE,
        pendingUnpairs: pending
          ? withPendingUnpair(state.pendingUnpairs, pending)
          : state.pendingUnpairs,
      }));
      this.logger.warn(`QR menu baglantisi kaldirildi (${reason}); yeniden acilmali.`);
    }
  }

  async reconcileAll(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const rows = await this.prisma.applicationSetting.findMany({
        where: { key: { in: [CONNECTION_KEY, STATE_KEY] }, deletedAt: null },
        select: { branchId: true },
      });
      for (const branchId of new Set(rows.map((row) => row.branchId))) {
        await this.reconcileBranch(branchId);
      }
    } catch (err) {
      this.logger.warn(`QR menu uzlastirmasi baslatilamadi: ${errorMessage(err)}`);
    } finally {
      this.reconciling = false;
    }
  }

  /** Ayni subenin uzlastirmalari sirayla calisir (zamanlayici, acilis, lisans olayi); hata yutulur. */
  private reconcileBranch(branchId: string): Promise<void> {
    const previous = this.reconcileRuns.get(branchId) ?? Promise.resolve();
    const run = previous.then(() =>
      this.reconcile(branchId).catch((err: unknown) => {
        this.logger.warn(`QR menu uzlastirmasi basarisiz: ${errorMessage(err)}`);
      }),
    );
    this.reconcileRuns.set(branchId, run);
    void run.then(() => {
      if (this.reconcileRuns.get(branchId) === run) this.reconcileRuns.delete(branchId);
    });
    return run;
  }

  /** Bekleyen kapatmalari buluta bildirir; internet yoksa sonraki turda yeniden denenir. */
  private async flushPendingUnpairs(branchId: string): Promise<void> {
    const { pendingUnpairs } = await this.state(branchId);
    for (const auth of pendingUnpairs) {
      try {
        await cloudApi.unpair(auth);
      } catch (err) {
        // Belirtec zaten gecersizse (401) is bitmistir; gecici hatada beklemede kalir.
        if (errorKind(err).kind === 'network') continue;
      }
      await this.mutateState(branchId, (state) => ({
        ...state,
        pendingUnpairs: state.pendingUnpairs.filter((item) => item.token !== auth.token),
      }));
    }
  }

  private async reconcile(branchId: string): Promise<void> {
    await this.flushPendingUnpairs(branchId);

    const conn = await this.connection(branchId);
    let state = await this.state(branchId);
    if (!conn) {
      const url = this.cloudUrl();
      if (!state.activationPending || !url || this.activating.has(branchId)) return;
      const license = await this.license();
      if (!license?.id || !license.qrMenu || license.expired) {
        await this.updateState(branchId, { activationPending: null });
        return;
      }
      const takeover = state.activationPending.takeover;
      this.activating.add(branchId);
      try {
        await this.tryActivate(branchId, url, { ...license, id: license.id }, takeover);
      } finally {
        this.activating.delete(branchId);
      }
      return;
    }

    if (state.licenseSyncPending) await this.syncLicense(branchId, conn);
    state = await this.state(branchId);
    // Yayin engelliyken (askida, lisans bitti) engelin kalktigini ancak durum sorgusu gosterir.
    if (state.blocked || statusDue(state.lastStatusAt)) await this.refreshStatus(branchId);

    // Kacan yayin: son deneme basarisizsa ya da kaynak degistiyse (olay kacti, worker vazgecti).
    const current = await this.connection(branchId);
    state = await this.state(branchId);
    if (!current || state.blocked) return;
    const busy = await this.prisma.backgroundJob.count({
      where: { branchId, taskName: CLOUD_PUBLISH_TASK, status: { in: ['pending', 'running'] } },
    });
    if (busy > 0) return;
    const { menu, tables } = await this.buildPayload(branchId);
    if (state.lastAttemptFailed || payloadHash({ menu, tables }) !== state.lastPayloadHash) {
      await this.requestPublish(branchId, 0);
    }
  }

  /** Buluttan isletme durumu (askiya alma, paket, lisans bitisi); engel kalktiysa yayin surer. */
  private async refreshStatus(branchId: string): Promise<void> {
    const conn = await this.connection(branchId);
    if (!conn) return;
    let info: PosInfo;
    try {
      info = await cloudApi.status(conn);
    } catch (err) {
      const kind = errorKind(err);
      if (kind.kind === 'lost') {
        await this.loseConnection(branchId, conn.token, kind.reason, errorMessage(err));
      }
      return; // gecici hata: sonraki turda yeniden sorulur
    }
    await this.applyPosInfo(branchId, conn, info);
  }

  /** Yeni lisansi buluta bildirir; farkli kimlikse eski baglanti kapatilir (yeniden acilmali). */
  private async syncLicense(branchId: string, conn: CloudConnection): Promise<void> {
    const license = await this.license();
    if (!license?.id) {
      await this.updateState(branchId, { licenseSyncPending: false });
      return;
    }
    if (license.id !== conn.licenseId) {
      await this.dropConnection(branchId);
      await this.mutateState(branchId, (state) => ({
        ...EMPTY_STATE,
        pendingUnpairs: withPendingUnpair(state.pendingUnpairs, conn),
      }));
      this.logger.warn('Farkli lisans girildi: QR menu baglantisi kapatildi, yeniden acilmali.');
      await this.flushPendingUnpairs(branchId);
      return;
    }
    let info: PosInfo;
    try {
      info = await cloudApi.refreshLicense(conn, license.key);
    } catch (err) {
      const kind = errorKind(err);
      if (kind.kind === 'lost') {
        await this.loseConnection(branchId, conn.token, kind.reason, errorMessage(err));
      } else if (kind.kind !== 'network') {
        await this.updateState(branchId, {
          licenseSyncPending: false,
          lastError: errorMessage(err),
          lastErrorAt: new Date().toISOString(),
        });
      }
      return;
    }
    await this.updateState(branchId, { licenseSyncPending: false });
    await this.applyPosInfo(branchId, conn, info);
  }

  private async applyPosInfo(branchId: string, conn: CloudConnection, info: PosInfo) {
    await this.writeSetting(branchId, CONNECTION_KEY, { ...conn, ...connectionInfo(info) });
    const before = await this.state(branchId);
    const blocked = blockedFromStatus(info.tenant, info.license?.expiresAt ?? null);
    await this.updateState(branchId, { blocked, lastStatusAt: new Date().toISOString() });
    if (before.blocked && !blocked) await this.requestPublish(branchId, 0);
  }
}

function connectionInfo(info: PosInfo) {
  return {
    branchId: info.branch.id,
    branchName: info.branch.name,
    tenantName: info.tenant.name,
    tenantStatus: info.tenant.status,
    planLabel: info.tenant.planLabel,
    features: info.tenant.features,
    licenseExpiresAt: info.license?.expiresAt ?? null,
  };
}

function errorKind(err: unknown): CloudErrorKind {
  return err instanceof CloudError ? classifyCloudError(err.status, err.code) : { kind: 'other' };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toHttpError(err: unknown) {
  if (err instanceof CloudError) {
    const body = { code: err.code, message: err.message };
    if (err.status === 0 || err.status >= 500) return new BadGatewayException(body);
    if (err.status === 403) return new ForbiddenException(body);
    if (err.status === 409) return new ConflictException(body);
    return new BadRequestException(body);
  }
  return new BadGatewayException({ code: 'CLOUD_ERROR', message: errorMessage(err) });
}

export type CloudStatus = Awaited<ReturnType<CloudService['status']>>;
