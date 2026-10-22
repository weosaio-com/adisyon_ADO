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
  createDomainEvent,
  DomainEventName,
  heartbeatResponseSchema,
  MENU_LIMITS,
  menuSnapshotSchema,
  newId,
  QR_MENU_FEATURE,
  type DomainEvent,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type LicenseRemoteEventPayload,
} from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { EventBusService } from '../common/events/event-bus.service';
import { InstallMetricsService } from '../common/metrics/install-metrics.service';
import { BackgroundWorkerService, CLOUD_LANE } from '../common/worker/worker.service';
import { AppConfigService } from '../config/app-config.service';
import { resolveInstallId } from '../common/util/install-id';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { LicenseService } from '../license/license.service';
import { SettingKeys } from '../settings/setting-keys';
import { categoryView, productView } from '../catalog/catalog.views';
import { menuImagePath } from '../catalog/catalog.images';
import { buildMenuSnapshot, buildTableList, normalizeCloudUrl } from './cloud.snapshot';
import {
  cloudApi,
  CloudError,
  type CloudConnection,
  type CloudLink,
  type PosInfo,
} from './cloud.client';
import {
  autoLinkAllowed,
  blockedFromStatus,
  classifyCloudError,
  connectionInfo,
  EMPTY_STATE,
  heartbeatBody,
  linkMode,
  payloadHash,
  qrMode,
  remoteFromInfo,
  statusDue,
  withDefaults,
  withPendingUnpair,
  type CloudErrorKind,
  type CloudState,
  type LostReason,
} from './cloud.state';

export const CLOUD_PUBLISH_TASK = 'cloud.publish';
const CONNECTION_KEY = SettingKeys.cloudConnection;
const STATE_KEY = SettingKeys.cloudState;
const QR_PUBLISH_KEY = SettingKeys.cloudQrPublish;
/** Arka arkaya urun duzenlemeleri tek yayinda birlesir. */
const PUBLISH_DELAY_SECONDS = 5;

interface UsableLicense {
  key: string;
  id: string | null;
  qrMenu: boolean;
  expired: boolean;
}
/** Baglanmaya uygun lisans: kimligi var (bulut isletmeyi bununla tanir). */
type LinkableLicense = UsableLicense & { id: string };

/**
 * Bulut baglantisi ve QR menu yayini. Bulut adresi programa gomuludur (derleme profili ->
 * CLOUD_API_URL); kullanici adres ya da kod girmez.
 *
 * - Baglanti: lisansli (kimlikli) her kurulum acilista, yeni lisans girilince ve uzlastirmada buluta
 *   KENDILIGINDEN baglanir (QR menu sart degil). Lisans baska bilgisayarda bagliysa kendiliginden
 *   devralinmaz: sahip "Bu bilgisayara al" der. Bagliyken `cloudHeartbeatSeconds`'ta bir heartbeat
 *   (son gorulme, surum, saglik); yanittaki uzak lisans durumu `license.remote` olayiyla lisans
 *   politikasina gider, isletme bilgisi baglanti kaydina yazilir.
 * - QR menu: ayri ayar (`cloud.qrPublish`). Acikken menu, gorseller ve masalar her degisiklikten
 *   5 sn sonra yayinlanir; kapatinca bulutta menu ve masalar kalkar, baglanti kalir.
 * - Uzlastirma (CLOUD_RECONCILE_SECONDS): kacan yayini, internet yokken istenen baglanma/kapatmayi,
 *   lisans bildirimini tamamlar ve heartbeat zamani geldiyse gonderir.
 *
 * Kayitlar ApplicationSetting'te durur (`/settings` listesine cikmaz). Tasarim: QR_MENU_DESIGN.md.
 */
@Injectable()
export class CloudService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CloudService.name);
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;
  /** Ayni subede ayni anda iki baglanma istegi gitmesin (cift tiklama, uzlastirma). */
  private readonly activating = new Set<string>();
  /** Sube basina `cloud.state` yazim sirasi (bkz. mutateState). */
  private readonly stateWrites = new Map<string, Promise<void>>();
  /** Sube basina uzlastirma sirasi (bkz. reconcileBranch). */
  private readonly reconcileRuns = new Map<string, Promise<void>>();
  /** Bu surecte heartbeat'i bulutun yanitladigi subeler: acilistan sonra ilk heartbeat hemen gider. */
  private readonly heartbeatSent = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: BackgroundWorkerService,
    private readonly licenses: LicenseService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly events: EventBusService,
    private readonly metrics: InstallMetricsService,
  ) {}

  onModuleInit() {
    // Kendi seridinde: gorsel yuklemesi internete takilsa da mutfak fisi kuyrugu beklemez (PLT-7).
    this.worker.registerHandler(
      CLOUD_PUBLISH_TASK,
      (_payload, branchId) => this.publish(branchId),
      {
        lane: CLOUD_LANE,
      },
    );
  }

  async onApplicationBootstrap() {
    await this.migrateLegacySettings().catch((err: unknown) => {
      this.logger.error(`Bulut ayarlari tasinamadi: ${String(err)}`);
    });
    await this.checkConnectionsOnBoot().catch((err: unknown) => {
      this.logger.error(`Bulut baglanti denetimi yapilamadi: ${String(err)}`);
    });
    void this.reconcileAll();
    // Heartbeat araligi uzlastirmadan kisaysa (testler) zamanlayici ona uyar.
    const tickSeconds = Math.min(
      this.config.cloudReconcileSeconds,
      this.config.cloudHeartbeatSeconds,
    );
    this.reconcileTimer = setInterval(() => void this.reconcileAll(), tickSeconds * 1000);
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

  private async hasSetting(branchId: string, key: string): Promise<boolean> {
    const row = await this.prisma.applicationSetting.findUnique({
      where: { branchId_key: { branchId, key } },
      select: { deletedAt: true },
    });
    return Boolean(row && !row.deletedAt);
  }

  private connection(branchId: string) {
    return this.readSetting<CloudConnection>(branchId, CONNECTION_KEY);
  }

  /** QR menu acik mi (sahibin ayari; baglantidan bagimsiz). Ayar yoksa kapali. */
  private async qrPublish(branchId: string): Promise<boolean> {
    return (await this.readSetting<boolean>(branchId, QR_PUBLISH_KEY)) === true;
  }

  /**
   * Diger moduller icin (bulut yedegi): bu subenin gecerli bulut baglantisi, yoksa null.
   * Acilistaki denetim adres/kurulum uyusmazliginda baglantiyi zaten duser.
   */
  async currentLink(branchId: string): Promise<CloudLink | null> {
    const conn = await this.connection(branchId);
    if (!conn) return null;
    return {
      url: conn.url,
      token: conn.token,
      installId: conn.installId,
      licenseId: conn.licenseId,
      features: conn.features,
    };
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
    this.heartbeatSent.delete(branchId);
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

  /**
   * Kendiliginden baglanacak sube: baglantisi olan, yoksa varsayilan (ilk) sube. Lisans kuruluma
   * aittir; iki sube ayni lisansla birbirinin belirtecini yenilemesin diye tek sube baglanir.
   */
  private async primaryBranchId(): Promise<string | null> {
    const linked = await this.prisma.applicationSetting.findFirst({
      where: { key: CONNECTION_KEY, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { branchId: true },
    });
    if (linked) return linked.branchId;
    const branch = await this.prisma.branch.findFirst({
      where: { deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    return branch?.id ?? null;
  }

  private requireCloudUrl(): string {
    const url = this.cloudUrl();
    if (!url) {
      throw new ConflictException({
        code: 'CLOUD_NOT_CONFIGURED',
        message: 'Bu kurulumda bulut tanımlı değil.',
      });
    }
    return url;
  }

  private async requireLinkableLicense(): Promise<LinkableLicense> {
    const license = await this.license();
    if (!license) {
      throw new ForbiddenException({
        code: 'LICENSE_REQUIRED',
        message: 'Önce Ayarlar › Lisans bölümünden lisansınızı girin.',
      });
    }
    if (!license.id) {
      throw new ForbiddenException({
        code: 'LICENSE_ID_REQUIRED',
        message:
          'Bu lisans buluta bağlanamaz (lisans numarası yok). Satıcınızdan yeni lisans isteyin.',
      });
    }
    return { ...license, id: license.id };
  }

  // ===========================================================================
  // Durum
  // ===========================================================================
  async status(user: AuthUser) {
    const branchId = user.branchId;
    const [conn, state, license, qrPublish, publishing] = await Promise.all([
      this.connection(branchId),
      this.state(branchId),
      this.license(),
      this.qrPublish(branchId),
      this.prisma.backgroundJob.count({
        where: { branchId, taskName: CLOUD_PUBLISH_TASK, status: { in: ['pending', 'running'] } },
      }),
    ]);
    const url = this.cloudUrl();
    const connected = Boolean(conn);
    const lic = license && { id: license.id, qrMenu: license.qrMenu };
    return {
      // --- Bulut baglantisi (Ayarlar > Lisans satiri) ---
      /** Bu kurulumda bulut tanimli mi (satir ve QR karti gorunur). */
      enabled: Boolean(url),
      /** QR kartlarindaki adres: bagliysa baglanti adresi, degilse gomulu adres. */
      url: conn?.url ?? url,
      connected,
      link: linkMode({ configured: Boolean(url), license: lic, connected, state }),
      licenseId: license?.id ?? null,
      remoteState: connected ? state.remoteState : null,
      /** Bulutla son basarili temas. */
      lastSeenAt: state.lastSeenAt,
      lastHeartbeatAt: state.lastHeartbeatAt,
      lostReason: connected ? null : (state.lost?.reason ?? null),
      conflictLastSeenAt: state.conflict?.lastSeenAt ?? null,
      linkError: connected ? null : (state.linkError?.message ?? null),
      branchName: conn?.branchName ?? null,
      tenantName: conn?.tenantName ?? null,
      tenantStatus: conn?.tenantStatus ?? null,
      planLabel: conn?.planLabel ?? null,
      licenseExpiresAt: conn?.licenseExpiresAt ?? null,
      pairedAt: conn?.pairedAt ?? null,
      // --- QR menu (Ayarlar > QR Menu karti) ---
      qr: qrMode({ qrPublish, license: lic, connected, state }),
      qrPublish,
      /** Bulutun QR menu hakki (paket); bagli degilken bilinmez. */
      menuEnabled: conn ? conn.features[QR_MENU_FEATURE] === true : null,
      blocked: connected ? state.blocked : null,
      unpublishPending: state.unpublishPending,
      lastPublishedAt: state.lastPublishedAt,
      lastMenuVersion: state.lastMenuVersion,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
      publishing: publishing > 0,
    };
  }

  // ===========================================================================
  // Baglanti
  // ===========================================================================

  /**
   * "Simdi baglan": bagli degilse lisansla baglanir (`takeover`: baska bilgisayardaki baglantiyi
   * sahibin onayiyla alir); bagliysa durum hemen yenilenir (heartbeat). Internet yoksa istek
   * saklanir, uzlastirma yeniden dener.
   */
  async activate(user: AuthUser, opts: { takeover?: boolean | undefined } = {}) {
    const url = this.requireCloudUrl();
    const license = await this.requireLinkableLicense();
    const branchId = user.branchId;
    if (await this.connection(branchId)) {
      await this.runForBranch(branchId, () => this.heartbeat(branchId));
      return this.status(user);
    }
    await this.linkNow(branchId, url, license, Boolean(opts.takeover), user);
    return this.status(user);
  }

  /** Sahibin istegiyle baglanma: onceki engeller (baska bilgisayar, satici kaldirdi, red) kalkar. */
  private async linkNow(
    branchId: string,
    url: string,
    license: LinkableLicense,
    takeover: boolean,
    user: AuthUser,
  ): Promise<void> {
    if (this.activating.has(branchId)) return;
    this.activating.add(branchId);
    let linked = false;
    try {
      await this.updateState(branchId, { conflict: null, lost: null, linkError: null });
      linked = await this.tryActivate(branchId, url, license, takeover, user);
    } finally {
      this.activating.delete(branchId);
    }
    // Ilk heartbeat (ve QR aciksa yayin) beklemeden.
    if (linked) void this.reconcileBranch(branchId);
  }

  /** Kendiliginden baglanma (acilis, uzlastirma, yeni lisans). Baglandiysa true. */
  private async autoLink(branchId: string): Promise<boolean> {
    const url = this.cloudUrl();
    if (!url || this.activating.has(branchId)) return false;
    const license = await this.license();
    if (!license?.id) return false;
    const state = await this.state(branchId);
    // Internetsiz kalan istek her zaman denenir; yoksa yalniz birincil sube baglanir.
    const pending = state.activationPending;
    if (!pending && branchId !== (await this.primaryBranchId())) return false;
    if (!autoLinkAllowed(state, new Date(), this.config.cloudHeartbeatSeconds)) return false;
    this.activating.add(branchId);
    try {
      return await this.tryActivate(
        branchId,
        url,
        { ...license, id: license.id },
        pending?.takeover ?? false,
      );
    } finally {
      this.activating.delete(branchId);
    }
  }

  /**
   * Buluta lisansla baglanir (`POST /api/pos/activate`). Internet yoksa istek saklanir; lisans
   * baska kurulumda bagliysa sahibin onayi beklenir; bulut reddederse neden saklanir (sahibin
   * istegiyse HTTP hatasi olarak da doner).
   */
  private async tryActivate(
    branchId: string,
    url: string,
    license: LinkableLicense,
    takeover: boolean,
    user?: AuthUser,
  ): Promise<boolean> {
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
          linkError: null,
          lastError: errorMessage(err),
          lastErrorAt: now,
        });
        return false;
      }
      if (kind.kind === 'conflict') {
        const details = err instanceof CloudError ? err.details : null;
        const lastSeenAt =
          details && typeof details === 'object' && 'lastSeenAt' in details
            ? String((details as { lastSeenAt: unknown }).lastSeenAt ?? '') || null
            : null;
        await this.updateState(branchId, {
          activationPending: null,
          linkError: null,
          conflict: { lastSeenAt, at: now },
        });
        return false;
      }
      const code = err instanceof CloudError ? err.code : 'CLOUD_ERROR';
      await this.updateState(branchId, {
        activationPending: null,
        conflict: null,
        linkError: { code, message: errorMessage(err), at: now },
      });
      if (user) throw toHttpError(err);
      this.logger.warn(`Buluta baglanilamadi (${code}): ${errorMessage(err)}`);
      return false;
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
    // Yeni surumde baglanti varken QR ayari hep yazilidir (yukseltme denetimi buna bakar).
    if (!(await this.hasSetting(branchId, QR_PUBLISH_KEY))) {
      await this.writeSetting(branchId, QR_PUBLISH_KEY, false);
    }
    const expiresAt = result.license?.expiresAt ?? null;
    const remote = remoteFromInfo(result.tenant, expiresAt);
    // Henuz kapatilamayan eski baglantilar (internet yok, eski adres) denenmeye devam eder.
    await this.mutateState(
      branchId,
      (state) => ({
        ...EMPTY_STATE,
        pendingUnpairs: state.pendingUnpairs,
        remoteState: remote,
        blocked: blockedFromStatus(result.tenant, expiresAt, remote),
        lastSeenAt: now,
      }),
      user?.userId,
    );
    this.heartbeatSent.delete(branchId);
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
    return true;
  }

  /**
   * Baglanti bulutta gecersiz kilindi (401): yerelde kaldirilir, kart nedenini gosterir. Istekteki
   * belirtec artik kayitli degilse (bu arada yeniden baglanildi) dokunulmaz. Baska bilgisayar
   * devraldiysa ya da satici kaldirdiysa kendiliginden yeniden baglanilmaz.
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
      conflict: reason === 'superseded' ? { lastSeenAt: null, at: now } : null,
      activationPending: null,
      linkError: null,
      blocked: null,
      remoteState: null,
      licenseSyncPending: false,
      unpublishPending: false,
      lastError: message,
      lastErrorAt: now,
    });
    // Yenilenen/gecersiz baglanti bir sonraki uzlastirmada kendiliginden yeniden kurulur
    // (autoLinkAllowed karar verir; hemen denenmez ki bozuk bir bulutla dongu olmasin).
    this.logger.warn(`Bulut baglantisi gecersiz (${reason}): ${message}`);
  }

  // ===========================================================================
  // QR menu
  // ===========================================================================

  async setQr(user: AuthUser, enabled: boolean) {
    return enabled ? this.enableQr(user) : this.disableQr(user);
  }

  /** "QR menuyu ac": ayar acilir, bagli degilse baglanilir, menu hemen yayinlanir. */
  private async enableQr(user: AuthUser) {
    const url = this.requireCloudUrl();
    const license = await this.requireLinkableLicense();
    if (!license.qrMenu) {
      throw new ForbiddenException({
        code: 'QR_MENU_NOT_LICENSED',
        message: 'Lisansınız QR menüyü içermiyor.',
      });
    }
    if (license.expired) {
      throw new ForbiddenException({ code: 'LICENSE_EXPIRED', message: 'Lisansın süresi dolmuş.' });
    }
    const branchId = user.branchId;
    const wasOn = await this.qrPublish(branchId);
    await this.writeSetting(branchId, QR_PUBLISH_KEY, true, user.userId);
    await this.updateState(branchId, {
      unpublishPending: false,
      lastError: null,
      lastErrorAt: null,
      lastAttemptFailed: false,
    });
    if (!wasOn) {
      await this.audit.record({
        branchId,
        action: 'cloud.qr.enable',
        entityType: 'cloud',
        entityId: branchId,
        userId: user.userId,
        ...(user.deviceId ? { deviceId: user.deviceId } : {}),
      });
    }
    if (await this.connection(branchId)) await this.requestPublish(branchId, 0);
    else await this.linkNow(branchId, url, license, false, user);
    return this.status(user);
  }

  /**
   * "QR menuyu kapat": bulutta menu ve masalar yayindan kalkar, baglanti kalir (heartbeat, lisans
   * yenilemesi, bulut yedegi surer). Internet yoksa yerelde hemen kapanir; bulut tarafi uzlastirmada
   * tamamlanir. Yeniden acinca ayni masa kodlari yayinlanir.
   */
  private async disableQr(user: AuthUser) {
    const branchId = user.branchId;
    const wasOn = await this.qrPublish(branchId);
    await this.writeSetting(branchId, QR_PUBLISH_KEY, false, user.userId);
    await this.prisma.backgroundJob.deleteMany({
      where: { branchId, taskName: CLOUD_PUBLISH_TASK, status: 'pending' },
    });
    await this.updateState(branchId, {
      lastPublishedAt: null,
      lastMenuVersion: null,
      lastPayloadHash: null,
      lastAttemptFailed: false,
      lastError: null,
      lastErrorAt: null,
      unpublishPending: false,
    });
    const conn = await this.connection(branchId);
    if (conn) await this.unpublish(branchId, conn);
    if (wasOn) {
      await this.audit.record({
        branchId,
        action: 'cloud.qr.disable',
        entityType: 'cloud',
        entityId: conn?.branchId ?? branchId,
        userId: user.userId,
        ...(user.deviceId ? { deviceId: user.deviceId } : {}),
      });
    }
    return this.status(user);
  }

  /**
   * Bulutta menu ve masalari kaldirir (baglanti kalir). Eski bulutta uc yoksa masa listesi
   * bosaltilir: QR kodlari menu acmaz. Olmazsa (internet yok vb.) uzlastirma yeniden dener.
   */
  private async unpublish(branchId: string, conn: CloudConnection): Promise<boolean> {
    try {
      try {
        await cloudApi.unpublish(conn);
      } catch (err) {
        if (errorKind(err).kind !== 'unsupported') throw err;
        await cloudApi.putTables(conn, []);
      }
    } catch (err) {
      const kind = errorKind(err);
      if (kind.kind === 'lost') {
        await this.loseConnection(branchId, conn.token, kind.reason, errorMessage(err));
        return false;
      }
      // Eski bulutta yayin zaten reddediliyorsa (askida, iptal, QR hakki yok) musteri menuyu
      // goremez: her turda yeniden denenmez; heartbeat bulutta menu kaldiysa yeniden dener.
      await this.updateState(branchId, { unpublishPending: kind.kind !== 'blocked' });
      if (kind.kind !== 'network') {
        this.logger.warn(`QR menu bulutta kaldirilamadi: ${errorMessage(err)}`);
      }
      return false;
    }
    await this.updateState(branchId, { unpublishPending: false });
    return true;
  }

  // ===========================================================================
  // Yayin
  // ===========================================================================

  /**
   * Yayin isi kuyruklar (bagli ve QR menu acikken); bekleyen varsa yenisi acilmaz ("Simdi yayinla"
   * onu one alir).
   */
  async requestPublish(branchId: string, delaySeconds = PUBLISH_DELAY_SECONDS): Promise<boolean> {
    if (!(await this.connection(branchId)) || !(await this.qrPublish(branchId))) return false;
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
    if (!(await this.qrPublish(user.branchId))) {
      throw new ConflictException({ code: 'QR_MENU_OFF', message: 'QR menü açık değil.' });
    }
    if (!(await this.requestPublish(user.branchId, 0))) {
      throw new ConflictException({
        code: 'CLOUD_NOT_CONNECTED',
        message: 'Bulut bağlantısı henüz kurulmadı; bağlanınca menü kendiliğinden yayınlanır.',
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

  // Yeni lisans: bagliysa buluta bildirilir (ayni kimlik: belirtec degismeden yenilenir; farkli
  // kimlik: eski baglanti kapanir, yenisi kurulur); bagli degilse hemen baglanmayi dener. Beklenmez:
  // lisans etkinlestirme yaniti internete takilmasin; olmazsa uzlastirma yeniden dener.
  @OnEvent('license.activated')
  async onLicenseActivated(event: DomainEvent) {
    const branchId = event.branchId;
    if (await this.connection(branchId)) {
      await this.updateState(branchId, { licenseSyncPending: true });
    } else {
      // Yeni lisans yeni bir baslangictir; baska bilgisayardaki baglanti yine onaysiz alinmaz.
      await this.updateState(branchId, { conflict: null, lost: null, linkError: null });
    }
    void this.reconcileBranch(branchId);
  }

  /** Arka plan isi: menu, eksik gorseller ve masalar buluta gonderilir. */
  async publish(branchId: string): Promise<void> {
    const conn = await this.connection(branchId);
    if (!conn || !(await this.qrPublish(branchId))) return;
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
      const now = new Date().toISOString();
      // Bulut yayini kabul ettiyse lisans etkin (iptal/askida/dolmus olsa 403 donerdi).
      await this.updateState(branchId, {
        lastPublishedAt: now,
        lastMenuVersion: saved.version,
        lastError: null,
        lastErrorAt: null,
        lastPayloadHash: sourceHash,
        lastAttemptFailed: false,
        blocked: null,
        remoteState: 'active',
        lastSeenAt: now,
      });
      // Yayin surerken QR menu kapatildiysa geri al.
      if (!(await this.qrPublish(branchId))) await this.unpublish(branchId, conn);
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
      // Bulut yayini reddediyorsa (askida/dolmus/iptal) tekrar denemek anlamsiz; durum duzelince
      // heartbeat ve uzlastirma devam ettirir. Digerleri worker ile geri cekilerek denenir.
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
  // Heartbeat
  // ===========================================================================

  /** Acilistan sonra ilk heartbeat hemen; sonra araliginda. Yayin engelliyken her turda. */
  private heartbeatDue(branchId: string, state: CloudState, qrPublish: boolean): boolean {
    if (!this.heartbeatSent.has(branchId)) return true;
    if (qrPublish && state.blocked) return true;
    return statusDue(state.lastHeartbeatAt, new Date(), this.config.cloudHeartbeatSeconds);
  }

  private async heartbeatPayload(): Promise<HeartbeatRequest> {
    const [metrics, license] = await Promise.all([
      this.metrics.collect(),
      this.licenses.getActiveLicense(),
    ]);
    return heartbeatBody({
      appVersion: this.config.appVersion,
      ...metrics,
      licenseId: license?.payload.id ?? null,
      licenseExp: license?.payload.exp ?? null,
    });
  }

  /**
   * Heartbeat (`POST /api/pos/heartbeat`): son gorulme, surum, saglik. Yanittaki isletme bilgisi
   * baglanti kaydina, uzak lisans durumu `license.remote` olayina gider. Bulutta uc yoksa (eski
   * Worker) `GET /status`'a duser.
   */
  private async heartbeat(branchId: string): Promise<void> {
    const conn = await this.connection(branchId);
    if (!conn) return;
    const body = await this.heartbeatPayload();
    let reply: unknown;
    try {
      reply = await cloudApi.heartbeat(conn, body);
    } catch (err) {
      const kind = errorKind(err);
      if (kind.kind === 'lost') {
        await this.loseConnection(branchId, conn.token, kind.reason, errorMessage(err));
        return;
      }
      if (kind.kind === 'network') return; // sonraki turda yeniden
      this.heartbeatSent.add(branchId);
      await this.updateState(branchId, { lastHeartbeatAt: new Date().toISOString() });
      if (kind.kind === 'unsupported') {
        await this.refreshStatus(branchId);
        return;
      }
      this.logger.warn(`Heartbeat reddedildi: ${errorMessage(err)}`);
      return;
    }
    const receivedAt = new Date().toISOString();
    this.heartbeatSent.add(branchId);
    const parsed = heartbeatResponseSchema.safeParse(reply);
    if (!parsed.success) {
      await this.updateState(branchId, { lastHeartbeatAt: receivedAt });
      this.logger.warn('Heartbeat yaniti beklenen bicimde degil; yok sayildi.');
      return;
    }
    await this.applyHeartbeat(branchId, conn, parsed.data, receivedAt);
  }

  private async applyHeartbeat(
    branchId: string,
    conn: CloudConnection,
    reply: HeartbeatResponse,
    receivedAt: string,
  ) {
    const applied = await this.applyPosInfo(branchId, conn, reply, {
      remoteState: reply.remote.state,
      lastHeartbeatAt: receivedAt,
    });
    if (!applied) return;
    // QR kapaliyken bulutta menu kalmissa (internetsiz kapatma, yedekten donus) kaldirilir.
    if (reply.menu && !(await this.qrPublish(branchId))) await this.unpublish(branchId, conn);
    // Lisans politikasi (LicenseService) uzak durumu ve varsa yeni anahtari isler. Kalici degil:
    // bir sonraki heartbeat yeniden bildirir. Anahtar loglanmaz (olay gunlugu yalniz adi yazar).
    await this.events.publish(
      createDomainEvent<string, LicenseRemoteEventPayload>(
        DomainEventName.LicenseRemote,
        {
          licenseId: reply.license?.id ?? conn.licenseId,
          state: reply.remote.state,
          ...(reply.remote.update ? { update: reply.remote.update } : {}),
          serverTime: reply.serverTime,
          receivedAt,
        },
        { branchId },
      ),
    );
  }

  /** Eski bulut (heartbeat yok): isletme durumu /status'tan okunur. */
  private async refreshStatus(branchId: string): Promise<void> {
    const conn = await this.connection(branchId);
    if (!conn) return;
    let info: PosInfo & { tableCount: number };
    try {
      info = await cloudApi.status(conn);
    } catch (err) {
      const kind = errorKind(err);
      if (kind.kind === 'lost') {
        await this.loseConnection(branchId, conn.token, kind.reason, errorMessage(err));
      }
      return; // gecici hata: sonraki turda yeniden sorulur
    }
    if (!(await this.applyPosInfo(branchId, conn, info))) return;
    if (info.tableCount > 0 && !(await this.qrPublish(branchId))) {
      await this.unpublish(branchId, conn);
    }
  }

  /**
   * Buluttan gelen isletme bilgisini (askiya alma, paket, lisans bitisi) baglanti kaydina ve
   * duruma yazar; yayin engeli kalktiysa yayin surer. Bu arada baglanti degistiyse yazmaz.
   */
  private async applyPosInfo(
    branchId: string,
    conn: CloudConnection,
    info: PosInfo,
    extra: Partial<CloudState> = {},
  ): Promise<boolean> {
    if ((await this.connection(branchId))?.token !== conn.token) return false;
    await this.writeSetting(branchId, CONNECTION_KEY, { ...conn, ...connectionInfo(info) });
    const expiresAt = info.license?.expiresAt ?? null;
    const remote = extra.remoteState ?? remoteFromInfo(info.tenant, expiresAt);
    const blocked = blockedFromStatus(info.tenant, expiresAt, remote);
    const before = await this.state(branchId);
    await this.updateState(branchId, {
      blocked,
      remoteState: remote,
      lastSeenAt: new Date().toISOString(),
      ...extra,
    });
    if (before.blocked && !blocked) await this.requestPublish(branchId, 0);
    return true;
  }

  // ===========================================================================
  // Acilis: yukseltme, baglanti denetimi
  // ===========================================================================

  /**
   * 0.3.0'dan yukseltme (bir kez). Eski surum yalniz "QR menuyu ac" denince baglanirdi: kayitli
   * baglanti varsa QR menu acikti. QR ayari yoksa acik yazilir ve lisans buluta bir kez bildirilir
   * (bulutun lisans kaydi eski isletmeleri baska yoldan ogrenemez). Yeni surum baglanirken ayari
   * hep yazar; "baglanti var, ayar yok" yalniz eski surumden kalir.
   */
  private async migrateLegacySettings() {
    const rows = await this.prisma.applicationSetting.findMany({
      where: { key: CONNECTION_KEY, deletedAt: null },
      select: { branchId: true },
    });
    for (const { branchId } of rows) {
      const exists = await this.prisma.applicationSetting.findUnique({
        where: { branchId_key: { branchId, key: QR_PUBLISH_KEY } },
        select: { id: true },
      });
      if (exists) continue;
      await this.writeSetting(branchId, QR_PUBLISH_KEY, true);
      await this.updateState(branchId, { licenseSyncPending: true });
      this.logger.log('Bulut baglantisi yeni surume tasindi: QR menu acik, lisans bildirilecek.');
    }
  }

  /**
   * Kayitli baglanti bu kuruluma ait degilse duser: eski (eslestirme kodlu) baglanti, baska
   * bilgisayardan geri yuklenen yedek, degisen bulut adresi ya da farkli lisans. Yedek disindaki
   * durumlarda eski baglanti bulutta da kapatilir (eski menu yayinda kalmasin). Sonra uzlastirma
   * yeniden baglanir (yedekte: lisans o bilgisayarda bagliysa sahibin onayiyla).
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
      // Baska bilgisayarin yedegiyse o bilgisayar hala bagli olabilir: bulutta kapatilmaz.
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
      this.logger.warn(`Bulut baglantisi kaldirildi (${reason}); yeniden baglanilacak.`);
    }
  }

  // ===========================================================================
  // Uzlastirma
  // ===========================================================================

  async reconcileAll(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const rows = await this.prisma.applicationSetting.findMany({
        where: { key: { in: [CONNECTION_KEY, STATE_KEY] }, deletedAt: null },
        select: { branchId: true },
      });
      const branches = new Set(rows.map((row) => row.branchId));
      // Henuz hic baglanmamis kurulum: birincil sube kendiliginden baglanir.
      const primary = await this.primaryBranchId();
      if (primary) branches.add(primary);
      for (const branchId of branches) {
        await this.reconcileBranch(branchId);
      }
    } catch (err) {
      this.logger.warn(`Bulut uzlastirmasi baslatilamadi: ${errorMessage(err)}`);
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Ayni subenin bulut isleri sirayla calisir (uzlastirma: zamanlayici, acilis, olaylar; "simdi
   * yenile" heartbeat'i); hata yutulur.
   */
  private runForBranch(branchId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.reconcileRuns.get(branchId) ?? Promise.resolve();
    const run = previous.then(() =>
      task().catch((err: unknown) => {
        this.logger.warn(`Bulut uzlastirmasi basarisiz: ${errorMessage(err)}`);
      }),
    );
    this.reconcileRuns.set(branchId, run);
    void run.then(() => {
      if (this.reconcileRuns.get(branchId) === run) this.reconcileRuns.delete(branchId);
    });
    return run;
  }

  private reconcileBranch(branchId: string): Promise<void> {
    return this.runForBranch(branchId, () => this.reconcile(branchId));
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

    let conn = await this.connection(branchId);
    if (conn && (await this.state(branchId)).licenseSyncPending) {
      await this.syncLicense(branchId, conn);
      conn = await this.connection(branchId);
    }
    if (!conn) {
      if (!(await this.autoLink(branchId))) return;
      conn = await this.connection(branchId);
      if (!conn) return;
    }

    const qrPublish = await this.qrPublish(branchId);
    if (this.heartbeatDue(branchId, await this.state(branchId), qrPublish)) {
      await this.heartbeat(branchId);
    }
    conn = await this.connection(branchId);
    if (!conn) return;
    const state = await this.state(branchId);
    if (!qrPublish) {
      if (state.unpublishPending) await this.unpublish(branchId, conn);
      return;
    }

    // Kacan yayin: son deneme basarisizsa ya da kaynak degistiyse (olay kacti, worker vazgecti).
    if (state.blocked) return;
    const busy = await this.prisma.backgroundJob.count({
      where: { branchId, taskName: CLOUD_PUBLISH_TASK, status: { in: ['pending', 'running'] } },
    });
    if (busy > 0) return;
    const { menu, tables } = await this.buildPayload(branchId);
    if (state.lastAttemptFailed || payloadHash({ menu, tables }) !== state.lastPayloadHash) {
      await this.requestPublish(branchId, 0);
    }
  }

  /**
   * Yeni lisansi buluta bildirir (`PUT /api/pos/license`; belirtec degismez). Farkli kimlikse eski
   * baglanti kapatilir; uzlastirma yeni lisansla yeniden baglanir.
   */
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
      this.logger.warn(
        'Farkli lisans girildi: eski bulut baglantisi kapatiliyor, yenisi kurulacak.',
      );
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
          ...(kind.kind === 'blocked' ? { blocked: kind.reason } : {}),
          lastError: errorMessage(err),
          lastErrorAt: new Date().toISOString(),
        });
      }
      return;
    }
    await this.updateState(branchId, { licenseSyncPending: false });
    await this.applyPosInfo(branchId, conn, info);
  }
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
