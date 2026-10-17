import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  createDomainEvent,
  DomainEventName,
  newId,
  type BackupCreatedEventPayload,
} from '@ado/shared';
import type { Backup } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { EventBusService } from '../common/events/event-bus.service';
import { resolveDataDir } from '../common/util/data-dir';
import { isLocalRequest } from '../common/http/local-request';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { SettingKeys } from '../settings/setting-keys';
import { formatRecoveryKey, recoveryKeyCandidates } from './backup.keys';
import {
  BACKUP_FORMAT_V2,
  BackupFormatError,
  decryptBackupFile,
  encryptFileV2,
  inspectBackupFile,
  sha256File,
} from './backup.format';
import {
  buildFingerprintQuery,
  FINGERPRINT_SCHEMA_SQL,
  fingerprintHash,
  volatileSettingKeys,
  type FingerprintRow,
  type SchemaColumnRow,
} from './backup.fingerprint';
import {
  cloudCopyCandidate,
  isLowDisk,
  isOwnBackupFile,
  isSafeCloudCopy,
  planRetention,
} from './backup.retention';
import { readDiskSpace } from './backup.disk';

// Iceri aktarilan yedek siniri. Yukleme diske akitilir (bellekte tutulmaz); boyut BigInt.
const MAX_IMPORT_BYTES = 8 * 1024 * 1024 * 1024;
/** Windows'ta antivirus/OneDrive dosyayi kisa sure kilitleyebilir: bu hatalarda sonra tekrar. */
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

type BackupActor = { branchId: string; userId?: string };
type CreatedBackupType = 'auto' | 'manual' | 'pre_update';

/** Bulut kopyasi silme sonucu: silindi / zaten yok / dokunulmadi (klasor disi) / kilitli. */
type CloudRemoval = 'removed' | 'missing' | 'skipped' | 'busy';

export interface RetentionResult {
  deleted: number;
  freedBytes: number;
  cloudCopiesDeleted: number;
  /** Kilitli oldugu icin silinemeyen (sonraki calismada tekrar denenir). */
  failed: number;
  lowDisk: boolean;
}

const errorCode = (err: unknown): string | undefined =>
  err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined;

async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (attempt >= attempts || !BUSY_CODES.has(errorCode(err) ?? '')) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

const formatError = (err: BackupFormatError) =>
  new BadRequestException({ code: err.code, message: err.message });

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);
  private readonly dataDir = resolveDataDir();
  private readonly backupDir = join(this.dataDir, 'backups');
  /** Saklama calismalari sirayla (yedek sonrasi + gunluk bakim ayni anda gelebilir). */
  private retentionQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
  ) {
    if (!existsSync(this.backupDir)) {
      mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /** Yerel yedek klasoru (bakim modulu artik dosyalari burada temizler). */
  get directory(): string {
    return this.backupDir;
  }

  /** Bu kurulumun ham yedek anahtari (paketli surumde userData/secrets.json). */
  private currentRawKey(): string {
    const rawKey = process.env.BACKUP_ENCRYPTION_KEY?.trim();
    if (!rawKey) {
      throw new BadRequestException({
        code: 'BACKUP_KEY_MISSING',
        message: 'Yedek şifreleme anahtarı tanımlı değil.',
      });
    }
    return rawKey;
  }

  /** Branch bazli ayari oku (JSON deger); yoksa null. */
  private async getSetting(branchId: string, key: string): Promise<unknown> {
    const row = await this.prisma.applicationSetting.findUnique({
      where: { branchId_key: { branchId, key } },
    });
    if (!row || row.deletedAt) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  /** Ayarli bulut klasoru (OneDrive/Drive/Dropbox senkron klasoru); bos ya da yoksa null. */
  private async cloudDirSetting(branchId: string): Promise<string | null> {
    const value = await this.getSetting(branchId, SettingKeys.backupCloudDir);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  /**
   * Gunluk otomatik yedek (06:00, gun donusuyle uyumlu). `backup.autoDaily=false` ayariyla
   * kapatilir. Son otomatik yedekten beri veri degismediyse yedek alinmaz (parmak izi).
   * Eski yedekler akilli saklama kurallariyla silinir (applyRetention).
   */
  @Cron('0 6 * * *')
  async dailyAutoBackup(): Promise<void> {
    const branch = await this.prisma.branch.findFirst({ where: { deletedAt: null } });
    if (!branch) return;
    if ((await this.getSetting(branch.id, SettingKeys.backupAutoDaily)) === false) return;
    try {
      const result = await this.autoBackupIfChanged(branch.id);
      if (result.skipped) {
        this.logger.log(
          `Otomatik gunluk yedek atlandi: son otomatik yedekten (${result.backupId}) beri veri degismedi.`,
        );
      }
    } catch (err) {
      this.logger.error('Otomatik gunluk yedek basarisiz', err);
    }
  }

  /**
   * Otomatik yedek: en yeni otomatik yedegin parmak izi bugunkuyle ayniysa (ve dosyasi duruyorsa)
   * atlanir. Iz hesaplanamazsa yedek her zaman alinir.
   */
  async autoBackupIfChanged(
    branchId: string,
  ): Promise<{ skipped: boolean; backupId: string | null }> {
    const fingerprint = await this.safeFingerprint();
    if (fingerprint) {
      const last = await this.prisma.backup.findFirst({
        where: { branchId, type: 'auto', deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      if (last && last.fingerprint === fingerprint && existsSync(last.path)) {
        return { skipped: true, backupId: last.id };
      }
    }
    const backup = await this.createBackup({ branchId }, 'auto');
    return { skipped: false, backupId: backup.id };
  }

  /** Veritabaninin degisiklik parmak izi (backup.fingerprint.ts). */
  async computeFingerprint(): Promise<string> {
    const columns = await this.prisma.$queryRawUnsafe<SchemaColumnRow[]>(FINGERPRINT_SCHEMA_SQL);
    const query = buildFingerprintQuery(columns, volatileSettingKeys());
    const rows = query
      ? await this.prisma.$queryRawUnsafe<FingerprintRow[]>(query.sql, ...query.params)
      : [];
    return fingerprintHash(rows);
  }

  private async safeFingerprint(): Promise<string | null> {
    try {
      return await this.computeFingerprint();
    } catch (err) {
      this.logger.warn(`Veri parmak izi hesaplanamadi: ${String(err)}`);
      return null;
    }
  }

  async createBackup(actor: BackupActor, type: CreatedBackupType) {
    const rawKey = this.currentRawKey(); // anahtar yoksa sifresiz kopya hic olusmasin
    const backupId = newId();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tempFile = join(this.backupDir, `temp_${backupId}.db`);
    const tempEncrypted = join(this.backupDir, `temp_${backupId}.db.enc`);
    const finalFileName = `backup_${timestamp}.db.enc`;
    const finalPath = join(this.backupDir, finalFileName);

    this.logger.log(`Starting backup of database. Temp: ${tempFile}`);
    // Iz VACUUM'dan once alinir: arada degisiklik olursa yedek izden yenidir, ertesi gun yine alinir.
    const fingerprint = await this.safeFingerprint();

    let backup: Backup;
    let finalWritten = false;
    let cloudCopyPath: string | null = null;
    try {
      // 1. VACUUM INTO: canli veritabaninin tutarli kopyasi (hedef dosya var olmamali).
      await this.prisma.$executeRawUnsafe(`VACUUM INTO '${tempFile.replace(/'/g, "''")}'`);

      // 2. Akisla sikistir + sifrele (v2). Ozet, diskteki dosyanin tamaminin sha256'si.
      const { sha256: checksum, sizeBytes } = await encryptFileV2(tempFile, tempEncrypted, rawKey);
      await rm(tempFile, { force: true });
      await renameWithRetry(tempEncrypted, finalPath);
      finalWritten = true;

      // 3. Istege bagli bulut kopyasi: `backup.cloudDir` doluysa sifreli dosya senkron
      // klasorune (OneDrive/Drive/Dropbox) kopyalanir; buluta tasimayi saglayicinin uygulamasi
      // yapar. Kopya hatasi yedegi DUSURMEZ. Yol kaydedilir: yedek silinince kopya da silinir.
      const cloudDir = await this.cloudDirSetting(actor.branchId);
      if (cloudDir) {
        try {
          await mkdir(cloudDir, { recursive: true });
          const target = join(cloudDir, finalFileName);
          await copyFile(finalPath, target);
          cloudCopyPath = target;
        } catch (err) {
          this.logger.error(`Bulut klasorune kopyalanamadi: ${cloudDir}`, err);
        }
      }

      // 4. Kayit
      backup = await this.prisma.backup.create({
        data: {
          id: backupId,
          branchId: actor.branchId,
          path: finalPath,
          sizeBytes: BigInt(sizeBytes),
          type,
          format: BACKUP_FORMAT_V2,
          encrypted: true,
          checksum,
          fingerprint,
          cloudCopyPath,
          createdBy: actor.userId ?? null,
        },
      });
      this.logger.log(`Backup completed successfully: ${finalFileName} (${sizeBytes} bytes)`);
    } catch (err) {
      this.logger.error('Failed to create database backup', err);
      // Kaydi olmayan dosya kalmasin (gecici kopya, sifreli dosya, bulut kopyasi).
      const leftovers = [tempFile, tempEncrypted];
      if (finalWritten) leftovers.push(finalPath);
      if (cloudCopyPath) leftovers.push(cloudCopyPath);
      for (const leftover of leftovers) await rm(leftover, { force: true }).catch(() => undefined);
      if (err instanceof BadRequestException) throw err;
      throw new Error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.publishCreated(backup, actor.userId);
    // Akilli saklama: eski yedekler (ve bulut kopyalari) silinir. Hata yedegi dusurmez.
    await this.applyRetention(actor.branchId).catch((err: unknown) => {
      this.logger.error(`Yedek saklama kurallari uygulanamadi: ${String(err)}`);
    });
    return { ...backup, cloudCopied: backup.cloudCopyPath !== null };
  }

  /** `backup.created`: bulut yedegi yeni dosyayi beklemeden yukler. Boyut sayi (BigInt degil). */
  private publishCreated(backup: Backup, userId?: string): void {
    const payload: BackupCreatedEventPayload = {
      backupId: backup.id,
      type: backup.type as BackupCreatedEventPayload['type'],
      format: backup.format === 2 ? 2 : 1,
      sizeBytes: Number(backup.sizeBytes),
      createdAt: backup.createdAt.toISOString(),
    };
    // Dinleyici hatasi/yavasligi yedegi beklemez; publish hatalari kendi icinde loglar.
    void this.events.publish(
      createDomainEvent<string, BackupCreatedEventPayload>(DomainEventName.BackupCreated, payload, {
        branchId: backup.branchId,
        ...(userId ? { actorId: userId } : {}),
      }),
    );
  }

  /**
   * Disaridan gelen sifreli yedegi (bulut klasoru / baska bilgisayar) kaydeder. Govde diske
   * akitilir (bellekte tutulmaz; en fazla 8 GB); bicim (v1/v2) dosyadan okunur. Cozme ve
   * dogrulama geri yuklemede.
   */
  async importBackup(actor: BackupActor, body: Readable) {
    const tooLarge = () =>
      new PayloadTooLargeException({
        code: 'BACKUP_TOO_LARGE',
        message: 'Yedek dosyası çok büyük (en fazla 8 GB).',
      });
    const declared = Number(
      (body as Readable & { headers?: Record<string, unknown> }).headers?.['content-length'],
    );
    if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) throw tooLarge();

    const id = newId();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tempPath = join(this.backupDir, `temp_${id}.db.enc`);
    const path = join(this.backupDir, `imported_${timestamp}_${id}.db.enc`);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > MAX_IMPORT_BYTES) {
          done(tooLarge());
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });

    try {
      await pipeline(body, meter, createWriteStream(tempPath));
    } catch (err) {
      await rm(tempPath, { force: true });
      if (err instanceof HttpException) throw err;
      throw new BadRequestException({
        code: 'BACKUP_UPLOAD_FAILED',
        message: 'Yedek dosyası yüklenemedi.',
      });
    }

    let format: 1 | 2;
    try {
      ({ format } = await inspectBackupFile(tempPath));
    } catch (err) {
      await rm(tempPath, { force: true });
      if (err instanceof BackupFormatError) throw formatError(err);
      throw err;
    }
    await renameWithRetry(tempPath, path);

    const backup = await this.prisma.backup.create({
      data: {
        id,
        branchId: actor.branchId,
        path,
        sizeBytes: BigInt(size),
        type: 'imported',
        format,
        encrypted: true,
        checksum: hash.digest('hex'),
        createdBy: actor.userId ?? null,
      },
    });
    await this.audit.record({
      branchId: actor.branchId,
      action: 'backup.import',
      entityType: 'backup',
      entityId: id,
      ...(actor.userId ? { userId: actor.userId } : {}),
      newValue: { sizeBytes: size, format },
    });
    this.publishCreated(backup, actor.userId);
    return backup;
  }

  /**
   * Yedegi coz + butunluk dogrula + staging dosyasina yaz. Canli SQLite'i surec
   * calisirken yerinde takas etmek kilit/bozulma riski tasidigindan ATOMIK TAKAS
   * yapilmaz; denetci (Electron) yeniden baslatmada staging dosyasini devreye alir.
   *
   * Yedek bu kurulumun anahtariyla acilmazsa kurtarma anahtari istenir. Kurtarma
   * anahtariyla acildiysa isarete `backupKey` yazilir: denetci bu anahtari yeni
   * bilgisayarda da kullanir (sahibinin sakladigi anahtar gecerli kalir).
   * v2 dosyalar akisla cozulur (bellek veritabani boyutuyla buyumez); v1 eski yoldan.
   */
  async restoreBackup(actor: BackupActor, id: string, recoveryKey?: string) {
    const backup = await this.prisma.backup.findFirst({
      where: { id, branchId: actor.branchId, deletedAt: null },
    });
    if (!backup) throw new NotFoundException('Yedek bulunamadı.');
    if (!existsSync(backup.path)) {
      throw new NotFoundException('Yedek dosyası diskte bulunamadı.');
    }

    try {
      await inspectBackupFile(backup.path);
    } catch (err) {
      if (err instanceof BackupFormatError) throw formatError(err);
      throw err;
    }
    // Butunluk: kayitli checksum (dosyanin tamaminin sha256'si) ile karsilastir.
    const checksum = await sha256File(backup.path);
    if (backup.checksum && checksum !== backup.checksum) {
      throw new BadRequestException({
        code: 'BACKUP_CORRUPT',
        message: 'Yedek bütünlük doğrulaması başarısız (checksum uyuşmuyor).',
      });
    }

    const stagePath = join(this.backupDir, `restore_staging_${backup.id}.db`);
    const open = async (rawKey: string): Promise<boolean> => {
      try {
        return await decryptBackupFile(backup.path, stagePath, rawKey);
      } catch (err) {
        if (err instanceof BackupFormatError) throw formatError(err);
        throw err;
      }
    };
    const currentKey = process.env.BACKUP_ENCRYPTION_KEY?.trim();
    let opened = currentKey ? await open(currentKey) : false;
    let adoptedKey: string | undefined;
    if (!opened && recoveryKey) {
      for (const candidate of recoveryKeyCandidates(recoveryKey)) {
        opened = await open(candidate);
        if (opened) {
          if (candidate !== currentKey) adoptedKey = candidate;
          break;
        }
      }
    }
    if (!opened) {
      if (recoveryKey) {
        throw new BadRequestException({
          code: 'BACKUP_DECRYPT_FAILED',
          message: 'Kurtarma anahtarı bu yedeği açmıyor (anahtar veya dosya hatalı).',
        });
      }
      throw new ConflictException({
        code: 'BACKUP_KEY_REQUIRED',
        message: 'Bu yedek başka bir kurulumun anahtarıyla şifrelenmiş. Kurtarma anahtarını girin.',
      });
    }

    try {
      const db = new DatabaseSync(stagePath, { readOnly: true });
      const result = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
      db.close();
      if (result.integrity_check !== 'ok') throw new Error(result.integrity_check ?? 'unknown');
    } catch {
      if (existsSync(stagePath)) unlinkSync(stagePath);
      throw new BadRequestException({
        code: 'BACKUP_CORRUPT',
        message: 'Yedek SQLite bütünlük kontrolünden geçemedi.',
      });
    }
    writeFileSync(
      join(this.dataDir, 'restore-pending.json'),
      JSON.stringify({
        stagePath,
        createdAt: new Date().toISOString(),
        ...(adoptedKey ? { backupKey: adoptedKey } : {}),
      }),
    );
    this.logger.warn(
      `Backup ${backup.id} restore icin hazirlandi: ${stagePath}. Atomik takas yeniden baslatmada yapilir.`,
    );
    await this.audit.record({
      branchId: actor.branchId,
      action: 'backup.restore',
      entityType: 'backup',
      entityId: backup.id,
      ...(actor.userId ? { userId: actor.userId } : {}),
      newValue: { keyAdopted: Boolean(adoptedKey) },
    });
    return {
      staged: true,
      stagePath,
      keyAdopted: Boolean(adoptedKey),
      message:
        'Yedek çözüldü ve doğrulandı. Uygulanması için yeniden başlatma gerekir (atomik takas denetleyici tarafından yapılır).',
    };
  }

  /** Kurtarma anahtari (cagiran yonetici sifresini dogrulamis olmali). Gosterim denetlenir. */
  async revealRecoveryKey(user: AuthUser): Promise<{ recoveryKey: string }> {
    const recoveryKey = formatRecoveryKey(this.currentRawKey());
    await this.audit.record({
      branchId: user.branchId,
      action: 'backup.recovery_key.view',
      entityType: 'backup',
      entityId: 'recovery-key',
      userId: user.userId,
      ...(user.deviceId ? { deviceId: user.deviceId } : {}),
    });
    return { recoveryKey };
  }

  /**
   * Ilk kurulum (henuz kullanici yok) ekranindan geri yukleme: yalniz ana
   * bilgisayardan ve yalniz kullanici yokken. Varsayilan subeyi dondurur.
   */
  async setupBranchOrThrow(ip: string | undefined): Promise<string> {
    if (!isLocalRequest(ip)) {
      throw new ForbiddenException({
        code: 'SETUP_LOCAL_ONLY',
        message: 'Ilk kurulum yalnizca ana bilgisayardan yapilabilir.',
      });
    }
    if ((await this.prisma.user.count({ where: { deletedAt: null } })) > 0) {
      throw new ForbiddenException({
        code: 'SETUP_ALREADY_DONE',
        message: 'Kurulum zaten yapilmis; geri yukleme icin Ayarlar > Yedekler bolumunu kullanin.',
      });
    }
    const branch = await this.prisma.branch.findFirst({
      where: { isDefault: true, deletedAt: null },
    });
    if (!branch) {
      throw new ForbiddenException({
        code: 'SETUP_NOT_READY',
        message: 'Kurulum verisi eksik (varsayilan sube bulunamadi).',
      });
    }
    return branch.id;
  }

  async listBackups(user: AuthUser) {
    return this.prisma.backup.findMany({
      where: { branchId: user.branchId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Elle silme: yerel dosya + bulut klasorundeki kopya + kaydin soft-delete'i. */
  async deleteBackup(user: AuthUser, id: string) {
    const backup = await this.prisma.backup.findFirst({
      where: { id, branchId: user.branchId, deletedAt: null },
    });
    if (!backup) throw new NotFoundException('Yedek bulunamadı.');

    const outcome = await this.removeBackup(
      backup,
      await this.cloudDirSetting(user.branchId),
    ).catch((err: unknown) => {
      this.logger.error(`Failed to delete backup file from disk: ${backup.path}`, err);
      return null;
    });
    if (!outcome) {
      throw new BadRequestException({
        code: 'BACKUP_DELETE_FAILED',
        message:
          'Yedek dosyası diskten silinemedi (kullanımda olabilir; biraz sonra tekrar deneyin).',
      });
    }
    return { success: true, cloudCopyRemoved: outcome.cloud === 'removed' };
  }

  /**
   * Akilli saklama (backup.retention.ts): silinmemis yedeklerden kurallarin disinda kalanlari
   * siler; once silinemeyen bulut kopyalarini tekrar dener. Calismalar sirayla.
   */
  applyRetention(branchId: string): Promise<RetentionResult> {
    const run = this.retentionQueue.then(() => this.runRetention(branchId));
    this.retentionQueue = run.catch(() => undefined);
    return run;
  }

  private async runRetention(branchId: string): Promise<RetentionResult> {
    const rows = await this.prisma.backup.findMany({
      where: { branchId, deletedAt: null },
      select: { id: true, type: true, createdAt: true, path: true, cloudCopyPath: true },
    });
    const lowDisk = isLowDisk(await readDiskSpace(this.backupDir));
    const doomed = new Set(planRetention(rows, { now: new Date(), lowDisk }).remove);
    const cloudDir = await this.cloudDirSetting(branchId);
    const result: RetentionResult = {
      deleted: 0,
      freedBytes: 0,
      cloudCopiesDeleted: 0,
      failed: 0,
      lowDisk,
    };

    for (const row of rows) {
      if (!doomed.has(row.id)) continue;
      try {
        const outcome = await this.removeBackup(row, cloudDir);
        if (!outcome) {
          result.failed += 1;
          continue;
        }
        // Ayni anda elle silindiyse sayilmaz (kayit zaten silinmisti).
        if (outcome.marked) result.deleted += 1;
        result.freedBytes += outcome.bytes;
        if (outcome.cloud === 'removed') result.cloudCopiesDeleted += 1;
      } catch (err) {
        result.failed += 1;
        this.logger.error(`Eski yedek silinemedi (${row.id}): ${String(err)}`);
      }
    }

    // Once kilitli oldugu icin silinemeyen bulut kopyalari (silinmis kayitlarda yol duruyor).
    const pending = await this.prisma.backup.findMany({
      where: { branchId, deletedAt: { not: null }, cloudCopyPath: { not: null } },
      select: { id: true, path: true, cloudCopyPath: true },
    });
    for (const row of pending) {
      const cloud = await this.removeCloudCopy(row, cloudDir);
      if (cloud === 'removed' || cloud === 'missing') {
        await this.prisma.backup.update({ where: { id: row.id }, data: { cloudCopyPath: null } });
        if (cloud === 'removed') result.cloudCopiesDeleted += 1;
      }
    }

    if (result.deleted > 0 || result.failed > 0) {
      this.logger.log(
        `Yedek saklama: ${result.deleted} eski yedek silindi (${result.freedBytes} bayt), ` +
          `${result.cloudCopiesDeleted} bulut kopyasi, ${result.failed} sonraya kaldi` +
          (lowDisk ? ' (disk azaldi kurallari)' : ''),
      );
    }
    return result;
  }

  /**
   * Yedegi siler: yerel dosya (yalniz bizim klasorumuzde ve bizim adimizla) + bulut kopyasi +
   * kaydin soft-delete'i. Yerel dosya kilitliyse (Windows) null: kayit kalir, sonra tekrar
   * denenir. Bulut kopyasi kilitliyse kayit silinir ama yol tutulur; sonraki calisma dener.
   * `marked`: kaydi bu cagri mi isaretledi (ayni anda baska silme olduysa false).
   */
  private async removeBackup(
    row: { id: string; path: string; cloudCopyPath: string | null },
    cloudDir: string | null,
  ): Promise<{ bytes: number; cloud: CloudRemoval; marked: boolean } | null> {
    let bytes = 0;
    if (isOwnBackupFile(row.path, this.backupDir)) {
      try {
        bytes = (await stat(row.path)).size;
        await unlink(row.path);
        this.logger.log(`Deleted backup file from disk: ${row.path}`);
      } catch (err) {
        const code = errorCode(err);
        if (code === 'ENOENT') {
          bytes = 0;
        } else if (BUSY_CODES.has(code ?? '')) {
          this.logger.warn(`Yedek dosyasi kullanimda, sonra tekrar denenecek: ${row.path}`);
          return null;
        } else {
          throw err;
        }
      }
    } else if (existsSync(row.path)) {
      this.logger.warn(`Yedek klasoru disindaki dosyaya dokunulmadi: ${row.path}`);
    }

    const cloud = await this.removeCloudCopy(row, cloudDir);
    const keepCloudPath =
      cloud === 'busy'
        ? cloudCopyCandidate(row, cloudDir)
        : cloud === 'skipped'
          ? row.cloudCopyPath
          : null;
    const { count } = await this.prisma.backup.updateMany({
      where: { id: row.id, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 }, cloudCopyPath: keepCloudPath },
    });
    return { bytes, cloud, marked: count > 0 };
  }

  /** Bulut klasorundeki kopyayi siler (yalniz ayarli klasorun icindeki backup_*.db.enc). */
  private async removeCloudCopy(
    row: { path: string; cloudCopyPath: string | null },
    cloudDir: string | null,
  ): Promise<CloudRemoval> {
    const target = cloudCopyCandidate(row, cloudDir);
    if (!target) return 'missing';
    if (!isSafeCloudCopy(target, cloudDir)) return 'skipped';
    try {
      await unlink(target);
      return 'removed';
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return 'missing';
      this.logger.warn(
        `Bulut kopyasi silinemedi, sonra tekrar denenecek: ${target} (${String(err)})`,
      );
      return 'busy';
    }
  }
}
