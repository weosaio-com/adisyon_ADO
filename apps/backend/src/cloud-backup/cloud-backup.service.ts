import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Backup, CloudBackupUpload } from '@prisma/client';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import {
  CLOUD_BACKUP_HEADERS,
  CLOUD_BACKUP_SINGLE_MAX_BYTES,
  cloudBackupMetaSchema,
  DomainEventName,
  isCloudBackupEnabled,
  newId,
  type CloudBackupMeta,
} from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { InstallMetricsService } from '../common/metrics/install-metrics.service';
import { AppConfigService } from '../config/app-config.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { SettingKeys } from '../settings/setting-keys';
import { CloudService } from '../cloud/cloud.service';
import { CloudError, cloudRequest, type CloudLink } from '../cloud/cloud.client';
import { normalizeCloudUrl } from '../cloud/cloud.snapshot';
import {
  backoffSeconds,
  choosePartSize,
  classifyUploadError,
  CLOUD_BACKUP_TYPES,
  partsList,
  pendingBackups,
  planParts,
  readMultipartState,
  uploadTimeoutMs,
  type MultipartState,
} from './cloud-backup.plan';

/** Ayarlar > Bulut yedegi karti (GET /cloud-backups/status). */
export interface CloudBackupStatus {
  /** Bu derlemede bulut adresi var mi (yoksa kart gorunmez). */
  configured: boolean;
  /** Bu bilgisayarda otomatik bulut yedegi acik mi (yerel anahtar; varsayilan acik). */
  switchedOn: boolean;
  /** Yukleme yapilabilir mi: yerel anahtar acik ve lisans/bulut bulut yedegini kapatmamis. */
  enabled: boolean;
  /** Buluta bagli mi (bulut baglantisi; yedekler bununla yuklenir). */
  linked: boolean;
  lastUploadedAt: string | null;
  lastBackupId: string | null;
  lastSizeBytes: number | null;
  /** Yuklenmeyi bekleyen yedek sayisi. */
  pending: number;
  uploading: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
}

/** `cloudBackup.state` ayari: ekranda gosterilen son hata (basarili yuklemede silinir). */
interface CloudBackupState {
  lastError: string | null;
  lastErrorAt: string | null;
}

/** Bu yedek hic yuklenemez (dosya yok/bozuk): kalici `failed`, siradakine gecilir. */
class PermanentUploadError extends Error {}

type Outcome = 'uploaded' | 'skip' | 'retry';

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Otomatik bulut yedegi: yerel yedeklerin (zaten dukkanin anahtariyla sifreli) kopyasini buluta
 * yukler; bulut icerigi okuyamaz. Kendi zamanlayicisi vardir (CLOUD_BACKUP_INTERVAL_SECONDS,
 * varsayilan saatte bir) ve yeni yedek olusunca (backup.created) hemen calisir. Her turda en cok bir
 * yedek yuklenir; ayni anda tek yukleme (kilit). Kasa fislerini de basan BackgroundWorker'a
 * BILEREK konmaz: buyuk bir yukleme fis kuyrugunu bekletmesin.
 *
 * Baglanti yoksa ya da lisans bulut yedegini kapattiysa sessizce atlanir. Hata: 1 dk, 5 dk, 15 dk,
 * sonra saatte bir yeniden denenir; internet yokken ekranda hata gosterilmez. Tasarim: CLOUD_BACKUP.md.
 */
@Injectable()
export class CloudBackupService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CloudBackupService.name);
  private intervalTimer: NodeJS.Timeout | null = null;
  private soonTimer: NodeJS.Timeout | null = null;
  private soonAt = 0;
  private stopped = false;
  /** Tek yukleme kilidi: suren tur; biri surerken istenen tur bittiginde bir kez daha calisir. */
  private running: Promise<void> | null = null;
  private rerun = false;
  private forceNext = false;
  /** Ardisik basarisizlik sayisi ve sonraki deneme ani (geri cekilme). */
  private failures = 0;
  private nextAttemptAt = 0;
  /** Su an yuklenen yedek (durum karti icin). */
  private current: { branchId: string; backupId: string } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloud: CloudService,
    private readonly config: AppConfigService,
    private readonly metrics: InstallMetricsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    // Heartbeat: saticinin panelinde "son bulut yedegi".
    this.metrics.register('cloud-backup', async () => ({
      lastCloudBackupAt: (await this.lastDone())?.uploadedAt?.toISOString() ?? null,
    }));
  }

  onApplicationBootstrap() {
    const intervalMs = this.config.cloudBackupIntervalSeconds * 1000;
    this.intervalTimer = setInterval(() => void this.kick(), intervalMs);
    this.intervalTimer.unref();
    // Acilistan kisa sure sonra ilk tur (en gec 1 dk): kapali gecen surenin yedegi beklemesin.
    this.schedule(Math.min(60_000, intervalMs));
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.soonTimer) clearTimeout(this.soonTimer);
  }

  // Yeni yedek: birkac saniye sonra yuklenir (yedek modulu her yedekten sonra yayinlar).
  @OnEvent(DomainEventName.BackupCreated)
  onBackupCreated() {
    this.schedule(5_000);
  }

  // ===========================================================================
  // Zamanlama ve kilit
  // ===========================================================================

  /** `delayMs` sonra bir tur (daha erken zamanlanmis tur varsa o kalir). */
  private schedule(delayMs: number) {
    if (this.stopped) return;
    const at = Date.now() + delayMs;
    if (this.soonTimer && this.soonAt <= at) return;
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.soonAt = at;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.kick();
    }, delayMs);
    this.soonTimer.unref();
  }

  /** Bir yukleme turu baslatir (`force`: geri cekilmeyi beklemeden). Hata yutulur, loglanir. */
  kick(force = false): Promise<void> {
    if (force) this.forceNext = true;
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    const run = this.runOnce()
      .catch((err: unknown) => {
        this.logger.error(`Bulut yedegi turu basarisiz: ${errorMessage(err)}`);
      })
      .finally(() => {
        this.running = null;
        if (this.rerun && !this.stopped) {
          this.rerun = false;
          void this.kick();
        }
      });
    this.running = run;
    return run;
  }

  private async runOnce(): Promise<void> {
    const force = this.forceNext;
    this.forceNext = false;
    if (this.stopped) return;
    if (!force && Date.now() < this.nextAttemptAt) {
      // Geri cekilme suruyor (daha erken zamanlanan tur ya da saatlik tur): denemeyi kacirma.
      this.schedule(this.nextAttemptAt - Date.now());
      return;
    }
    const branches = await this.prisma.branch.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    for (const { id: branchId } of branches) {
      const link = await this.cloud.currentLink(branchId);
      if (!link || !isCloudBackupEnabled(link.features) || !(await this.switchedOn(branchId))) {
        continue;
      }
      if ((await this.uploadNext(branchId, link)) === 'retry') return;
    }
  }

  /** Siradaki yedegi yukler; kalici hatada (dosya yok vb.) bir sonrakine gecer. */
  private async uploadNext(branchId: string, link: CloudLink): Promise<Outcome | 'idle'> {
    for (const backup of await this.queue(branchId)) {
      const outcome = await this.uploadOne(branchId, link, backup);
      if (outcome !== 'skip') return outcome;
    }
    return 'idle';
  }

  // ===========================================================================
  // Yukleme
  // ===========================================================================

  private async queue(branchId: string): Promise<Backup[]> {
    const [backups, uploads] = await Promise.all([
      this.prisma.backup.findMany({
        where: { branchId, deletedAt: null, type: { in: [...CLOUD_BACKUP_TYPES] } },
      }),
      this.prisma.cloudBackupUpload.findMany({
        where: { branchId, deletedAt: null },
        select: { backupId: true, status: true, uploadId: true },
      }),
    ]);
    return pendingBackups(backups, uploads);
  }

  private async uploadOne(branchId: string, link: CloudLink, backup: Backup): Promise<Outcome> {
    const row = await this.prisma.cloudBackupUpload.upsert({
      where: { backupId: backup.id },
      create: {
        id: newId(),
        branchId,
        backupId: backup.id,
        status: 'uploading',
        sizeBytes: backup.sizeBytes,
        attempts: 1,
      },
      update: { status: 'uploading', attempts: { increment: 1 }, version: { increment: 1 } },
    });
    this.current = { branchId, backupId: backup.id };
    try {
      const meta = await this.transfer(link, backup, row);
      await this.markDone(row.id, meta);
      return 'uploaded';
    } catch (err) {
      return await this.handleFailure(branchId, row, err);
    } finally {
      this.current = null;
    }
  }

  private async transfer(
    link: CloudLink,
    backup: Backup,
    row: CloudBackupUpload,
  ): Promise<CloudBackupMeta | null> {
    let size: number;
    try {
      size = (await stat(backup.path)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PermanentUploadError('Yedek dosyası diskte bulunamadı.');
      }
      throw err;
    }
    if (size === 0) throw new PermanentUploadError('Yedek dosyası boş.');
    if (!/^[a-f0-9]{64}$/.test(backup.checksum)) {
      throw new PermanentUploadError('Yedeğin özeti (checksum) kayıtlı değil.');
    }
    return size <= this.singleMaxBytes()
      ? this.putSingle(link, backup)
      : this.putMultipart(link, backup, row, size);
  }

  /**
   * Tek parca siniri (95 MB). Gelistirme/testte ADO_CLOUD_BACKUP_SINGLE_MAX_BYTES ile kucultulur
   * (multipart yolu kucuk veritabaniyla denenebilsin); paketli surumde (production) yok sayilir.
   */
  private singleMaxBytes(): number {
    if (!this.config.isProduction) {
      const override = Number(process.env.ADO_CLOUD_BACKUP_SINGLE_MAX_BYTES);
      if (Number.isSafeInteger(override) && override > 0) {
        return Math.min(override, CLOUD_BACKUP_SINGLE_MAX_BYTES);
      }
    }
    return CLOUD_BACKUP_SINGLE_MAX_BYTES;
  }

  private metaHeaders(backup: Backup): Record<string, string> {
    return {
      [CLOUD_BACKUP_HEADERS.sha256]: backup.checksum,
      [CLOUD_BACKUP_HEADERS.type]: backup.type,
      [CLOUD_BACKUP_HEADERS.format]: String(backup.format),
      [CLOUD_BACKUP_HEADERS.createdAt]: backup.createdAt.toISOString(),
    };
  }

  /** 95 MB'a kadar tek istek; SHA-256'yi bulut (R2) dosyanin kendisiyle dogrular. */
  private async putSingle(link: CloudLink, backup: Backup): Promise<CloudBackupMeta> {
    const bytes = await readFile(backup.path);
    return cloudRequest<CloudBackupMeta>(
      link.url,
      `/api/pos/backups/${encodeURIComponent(backup.id)}`,
      {
        method: 'PUT',
        token: link.token,
        bytes,
        headers: this.metaHeaders(backup),
        timeoutMs: uploadTimeoutMs(bytes.length),
      },
    );
  }

  /**
   * Buyuk yedek: parca parca (her seferinde tek parca okunur). Yuklenen parcalar kaydedilir;
   * kesilen yukleme kalan parcalardan surer. Multipart'ta butun dosyanin ozetini bulut
   * dogrulayamaz: yeni yuklemeden once dosya yerelde kayitli ozetle karsilastirilir.
   */
  private async putMultipart(
    link: CloudLink,
    backup: Backup,
    row: CloudBackupUpload,
    size: number,
  ): Promise<CloudBackupMeta> {
    const base = `/api/pos/backups/${encodeURIComponent(backup.id)}`;
    let state = readMultipartState(row);
    if (!state) {
      if ((await sha256File(backup.path)) !== backup.checksum) {
        throw new PermanentUploadError('Yerel yedek dosyası bozulmuş (özet uyuşmuyor).');
      }
      const created = await cloudRequest<{ uploadId: string; partSize: number }>(
        link.url,
        `${base}/multipart`,
        {
          method: 'POST',
          token: link.token,
          json: {
            sizeBytes: size,
            sha256: backup.checksum,
            type: backup.type,
            format: backup.format,
            createdAt: backup.createdAt.toISOString(),
            partSize: choosePartSize(size, this.config.cloudBackupPartBytes),
          },
        },
      );
      state = { uploadId: created.uploadId, partSize: created.partSize, parts: new Map() };
      await this.saveMultipart(row.id, state);
    }
    const handle = await open(backup.path, 'r');
    try {
      for (const part of planParts(size, state.partSize)) {
        if (state.parts.has(part.partNumber)) continue;
        const buffer = Buffer.alloc(part.length);
        const { bytesRead } = await handle.read(buffer, 0, part.length, part.offset);
        if (bytesRead !== part.length) {
          throw new PermanentUploadError('Yedek dosyası okunurken değişti.');
        }
        const uploaded = await cloudRequest<{ partNumber: number; etag: string }>(
          link.url,
          `${base}/parts/${part.partNumber}`,
          {
            method: 'PUT',
            token: link.token,
            bytes: buffer,
            headers: { [CLOUD_BACKUP_HEADERS.uploadId]: state.uploadId },
            timeoutMs: uploadTimeoutMs(part.length),
          },
        );
        state.parts.set(part.partNumber, uploaded.etag);
        await this.saveMultipart(row.id, state);
      }
    } finally {
      await handle.close();
    }
    return cloudRequest<CloudBackupMeta>(link.url, `${base}/complete`, {
      method: 'POST',
      token: link.token,
      json: { uploadId: state.uploadId, parts: partsList(state) },
      timeoutMs: 120_000,
    });
  }

  private async saveMultipart(rowId: string, state: MultipartState | null) {
    await this.prisma.cloudBackupUpload.update({
      where: { id: rowId },
      data: {
        uploadId: state?.uploadId ?? null,
        partSize: state?.partSize ?? null,
        partsDone: state ? JSON.stringify(partsList(state)) : null,
      },
    });
  }

  private async markDone(rowId: string, meta: CloudBackupMeta | null) {
    const row = await this.prisma.cloudBackupUpload.update({
      where: { id: rowId },
      data: {
        status: 'done',
        cloudId: meta?.id ?? null,
        uploadedAt: new Date(),
        lastError: null,
        uploadId: null,
        partSize: null,
        partsDone: null,
        version: { increment: 1 },
      },
    });
    this.failures = 0;
    this.nextAttemptAt = 0;
    await this.writeState(row.branchId, { lastError: null, lastErrorAt: null }, true);
    this.logger.log(`Yedek buluta yuklendi: ${row.backupId} (${Number(row.sizeBytes)} bayt)`);
  }

  private async handleFailure(
    branchId: string,
    row: CloudBackupUpload,
    err: unknown,
  ): Promise<Outcome> {
    const message = errorMessage(err);
    const kind =
      err instanceof PermanentUploadError
        ? 'permanent'
        : err instanceof CloudError
          ? classifyUploadError(err.status, err.code)
          : 'retry';

    if (kind === 'done') {
      // Bulut bu yedegi zaten tamamlamis (yanit bize ulasmamis): basari.
      const meta = cloudBackupMetaSchema.safeParse((err as CloudError).details);
      await this.markDone(row.id, meta.success ? meta.data : null);
      return 'uploaded';
    }
    if (kind === 'permanent') {
      await this.prisma.cloudBackupUpload.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          lastError: message,
          uploadId: null,
          partSize: null,
          partsDone: null,
        },
      });
      this.logger.warn(`Yedek buluta yuklenemiyor, atlandi (${row.backupId}): ${message}`);
      return 'skip';
    }

    await this.prisma.cloudBackupUpload.update({
      where: { id: row.id },
      data: {
        status: 'pending',
        lastError: message,
        // Multipart bulutta yoksa/degistiyse bastan baslar; aksi halde kalan parcalardan surer.
        ...(kind === 'restart' ? { uploadId: null, partSize: null, partsDone: null } : {}),
      },
    });
    this.failures += 1;
    const delay = backoffSeconds(this.failures, this.config.cloudBackupIntervalSeconds);
    this.nextAttemptAt = Date.now() + delay * 1000;
    this.schedule(delay * 1000);
    if (kind === 'network') {
      // Internet yok: sessizce yeniden denenir (ekranda hata gosterilmez).
      this.logger.debug(`Bulut yedegi: buluta ulasilamadi, ${delay} sn sonra yeniden.`);
    } else {
      await this.writeState(branchId, {
        lastError: message,
        lastErrorAt: new Date().toISOString(),
      });
      this.logger.warn(`Bulut yedegi yuklenemedi, ${delay} sn sonra yeniden: ${message}`);
    }
    return 'retry';
  }

  // ===========================================================================
  // Ayarlar ve durum
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

  /** Yerel anahtar (varsayilan acik). */
  private async switchedOn(branchId: string): Promise<boolean> {
    return (await this.readSetting<unknown>(branchId, SettingKeys.cloudBackupEnabled)) !== false;
  }

  private async readState(branchId: string): Promise<CloudBackupState> {
    const state = await this.readSetting<Partial<CloudBackupState>>(
      branchId,
      SettingKeys.cloudBackupState,
    );
    return { lastError: state?.lastError ?? null, lastErrorAt: state?.lastErrorAt ?? null };
  }

  /** `onlyIfChanged`: hata zaten yoksa yazilmaz (her basarili yuklemede gereksiz yazim olmasin). */
  private async writeState(branchId: string, next: CloudBackupState, onlyIfChanged = false) {
    if (onlyIfChanged) {
      const current = await this.readState(branchId);
      if (current.lastError === next.lastError) return;
    }
    await this.writeSetting(branchId, SettingKeys.cloudBackupState, next);
  }

  private lastDone(branchId?: string) {
    return this.prisma.cloudBackupUpload.findFirst({
      where: { ...(branchId ? { branchId } : {}), status: 'done', deletedAt: null },
      orderBy: { uploadedAt: 'desc' },
    });
  }

  private configured(): boolean {
    try {
      return Boolean(this.config.cloudApiUrl && normalizeCloudUrl(this.config.cloudApiUrl));
    } catch {
      return false;
    }
  }

  async status(branchId: string): Promise<CloudBackupStatus> {
    const [link, switchedOn, lastDone, state, queue] = await Promise.all([
      this.cloud.currentLink(branchId),
      this.switchedOn(branchId),
      this.lastDone(branchId),
      this.readState(branchId),
      this.queue(branchId),
    ]);
    return {
      configured: this.configured(),
      switchedOn,
      enabled: switchedOn && (link ? isCloudBackupEnabled(link.features) : true),
      linked: Boolean(link),
      lastUploadedAt: lastDone?.uploadedAt?.toISOString() ?? null,
      lastBackupId: lastDone?.backupId ?? null,
      lastSizeBytes: lastDone ? Number(lastDone.sizeBytes) : null,
      pending: queue.length,
      uploading: this.current?.branchId === branchId,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
    };
  }

  /** "Simdi buluta yedekle": bekleyen en yeni yedek geri cekilme beklenmeden yuklenir. */
  async uploadNow(user: AuthUser): Promise<CloudBackupStatus> {
    const branchId = user.branchId;
    if (!this.configured()) {
      throw new ConflictException({
        code: 'CLOUD_NOT_CONFIGURED',
        message: 'Bu kurulumda bulut tanımlı değil.',
      });
    }
    const link = await this.cloud.currentLink(branchId);
    if (!link) {
      throw new ConflictException({
        code: 'CLOUD_NOT_LINKED',
        message: 'Bu bilgisayar buluta bağlı değil.',
      });
    }
    if (!isCloudBackupEnabled(link.features)) {
      throw new ForbiddenException({
        code: 'CLOUD_BACKUP_NOT_LICENSED',
        message: 'Lisansınız bulut yedeğini içermiyor.',
      });
    }
    if (!(await this.switchedOn(branchId))) {
      throw new ConflictException({
        code: 'CLOUD_BACKUP_OFF',
        message: 'Bulut yedeği bu bilgisayarda kapalı.',
      });
    }
    void this.kick(true);
    return this.status(branchId);
  }

  /** Bu bilgisayarda otomatik bulut yedegini ac/kapat (yalniz bu sube; denetim kaydina yazilir). */
  async setSwitch(user: AuthUser, enabled: boolean): Promise<CloudBackupStatus> {
    const before = await this.switchedOn(user.branchId);
    await this.writeSetting(user.branchId, SettingKeys.cloudBackupEnabled, enabled, user.userId);
    if (before !== enabled) {
      await this.audit.record({
        branchId: user.branchId,
        action: 'cloud_backup.switch',
        entityType: 'setting',
        entityId: SettingKeys.cloudBackupEnabled,
        userId: user.userId,
        oldValue: { enabled: before },
        newValue: { enabled },
        ...(user.deviceId ? { deviceId: user.deviceId } : {}),
      });
    }
    if (enabled) this.schedule(1_000);
    return this.status(user.branchId);
  }
}
