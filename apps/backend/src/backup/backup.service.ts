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
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { newId } from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { resolveDataDir } from '../common/util/data-dir';
import { isLocalRequest } from '../common/http/local-request';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  BACKUP_HEADER_BYTES,
  decryptBackup,
  encryptBackup,
  formatRecoveryKey,
  recoveryKeyCandidates,
} from './backup.keys';

// Iceri aktarilan yedek siniri (POS SQLite'i bunun cok altinda kalir; Prisma Int 32-bit).
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

type BackupActor = { branchId: string; userId?: string };

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);
  private readonly dataDir = resolveDataDir();
  private readonly backupDir = join(this.dataDir, 'backups');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    if (!existsSync(this.backupDir)) {
      mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /** Bu kurulumun ham yedek anahtari (paketli surumde userData/secrets.json). */
  private currentRawKey(): string {
    const rawKey = process.env.BACKUP_ENCRYPTION_KEY?.trim();
    if (!rawKey) {
      throw new BadRequestException({
        code: 'BACKUP_KEY_MISSING',
        message: 'Yedek sifreleme anahtari tanimli degil.',
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

  /**
   * Gunluk otomatik yedek (06:00, gun donusuyle uyumlu). `backup.autoDaily=false`
   * ayariyla kapatilir. Yedekler ASLA otomatik silinmez (kullanici karari).
   */
  @Cron('0 6 * * *')
  async dailyAutoBackup(): Promise<void> {
    const branch = await this.prisma.branch.findFirst({ where: { deletedAt: null } });
    if (!branch) return;
    if ((await this.getSetting(branch.id, 'backup.autoDaily')) === false) return;
    try {
      await this.createBackup({ branchId: branch.id }, 'auto');
    } catch (err) {
      this.logger.error('Otomatik gunluk yedek basarisiz', err);
    }
  }

  async createBackup(actor: BackupActor, type: 'auto' | 'manual' | 'pre_update') {
    const rawKey = this.currentRawKey(); // anahtar yoksa sifresiz kopya hic olusmasin
    const backupId = newId();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tempFile = join(this.backupDir, `temp_${backupId}.db`);
    const finalFileName = `backup_${timestamp}.db.enc`;
    const finalPath = join(this.backupDir, finalFileName);

    this.logger.log(`Starting backup of database. Temp: ${tempFile}`);

    try {
      // 1. Run VACUUM INTO to create a consistent hot copy of the database
      // SQLite requires the destination file to not exist.
      await this.prisma.$executeRawUnsafe(`VACUUM INTO '${tempFile.replace(/'/g, "''")}'`);

      // 2. Encrypt: IV (12 bytes) + AuthTag (16 bytes) + EncryptedData
      const finalBuffer = encryptBackup(readFileSync(tempFile), rawKey);
      writeFileSync(finalPath, finalBuffer);

      // Clean up temporary unencrypted copy
      unlinkSync(tempFile);

      // 3. Compute checksum of the final encrypted file
      const checksum = createHash('sha256').update(finalBuffer).digest('hex');
      const sizeBytes = statSync(finalPath).size;

      // 4. Create metadata entry in database
      const backup = await this.prisma.backup.create({
        data: {
          id: backupId,
          branchId: actor.branchId,
          path: finalPath,
          sizeBytes,
          type,
          encrypted: true,
          checksum,
          createdBy: actor.userId ?? null,
        },
      });

      this.logger.log(`Backup completed successfully: ${finalFileName} (${sizeBytes} bytes)`);

      // 5. Istege bagli bulut kopyasi: `backup.cloudDir` ayari doluysa sifreli dosyayi
      // senkron klasorune (OneDrive/Drive/Dropbox) kopyala. Buluta tasima isini
      // saglayicinin masaustu istemcisi yapar. Kopya hatasi yedegi DUSURMEZ.
      let cloudCopied = false;
      const cloudDir = await this.getSetting(actor.branchId, 'backup.cloudDir');
      if (typeof cloudDir === 'string' && cloudDir.trim()) {
        try {
          mkdirSync(cloudDir.trim(), { recursive: true });
          copyFileSync(finalPath, join(cloudDir.trim(), finalFileName));
          cloudCopied = true;
        } catch (err) {
          this.logger.error(`Bulut klasorune kopyalanamadi: ${cloudDir}`, err);
        }
      }
      return { ...backup, cloudCopied };
    } catch (err) {
      this.logger.error('Failed to create database backup', err);
      // Clean up temp file if it exists
      if (existsSync(tempFile)) {
        try {
          unlinkSync(tempFile);
        } catch {
          // ignore
        }
      }
      if (err instanceof BadRequestException) throw err;
      throw new Error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Disaridan gelen sifreli yedegi (bulut klasoru / baska bilgisayar) kaydeder.
   * Govde diske akitilir (bellekte tutulmaz); cozme ve dogrulama geri yuklemede.
   */
  async importBackup(actor: BackupActor, body: Readable) {
    const id = newId();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(this.backupDir, `imported_${timestamp}_${id}.db.enc`);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > MAX_IMPORT_BYTES) {
          done(
            new PayloadTooLargeException({
              code: 'BACKUP_TOO_LARGE',
              message: 'Yedek dosyasi cok buyuk (en fazla 1 GB).',
            }),
          );
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });

    try {
      await pipeline(body, meter, createWriteStream(path));
    } catch (err) {
      rmSync(path, { force: true });
      if (err instanceof HttpException) throw err;
      throw new BadRequestException({
        code: 'BACKUP_UPLOAD_FAILED',
        message: 'Yedek dosyasi yuklenemedi.',
      });
    }
    if (size <= BACKUP_HEADER_BYTES) {
      rmSync(path, { force: true });
      throw new BadRequestException({
        code: 'BACKUP_INVALID',
        message: 'Gecerli bir yedek dosyasi degil.',
      });
    }

    const backup = await this.prisma.backup.create({
      data: {
        id,
        branchId: actor.branchId,
        path,
        sizeBytes: size,
        type: 'imported',
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
      newValue: { sizeBytes: size },
    });
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
   */
  async restoreBackup(actor: BackupActor, id: string, recoveryKey?: string) {
    const backup = await this.prisma.backup.findFirst({
      where: { id, branchId: actor.branchId, deletedAt: null },
    });
    if (!backup) throw new NotFoundException('Yedek bulunamadı.');
    if (!existsSync(backup.path)) {
      throw new NotFoundException('Yedek dosyası diskte bulunamadı.');
    }

    const raw = readFileSync(backup.path);
    // Butunluk: kayitli checksum ile karsilastir.
    const checksum = createHash('sha256').update(raw).digest('hex');
    if (backup.checksum && checksum !== backup.checksum) {
      throw new BadRequestException({
        code: 'BACKUP_CORRUPT',
        message: 'Yedek bütünlük doğrulaması başarısız (checksum uyuşmuyor).',
      });
    }

    const currentKey = process.env.BACKUP_ENCRYPTION_KEY?.trim();
    let decrypted = currentKey ? decryptBackup(raw, currentKey) : null;
    let adoptedKey: string | undefined;
    if (!decrypted && recoveryKey) {
      for (const candidate of recoveryKeyCandidates(recoveryKey)) {
        decrypted = decryptBackup(raw, candidate);
        if (decrypted) {
          if (candidate !== currentKey) adoptedKey = candidate;
          break;
        }
      }
    }
    if (!decrypted) {
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

    const stagePath = join(this.backupDir, `restore_staging_${backup.id}.db`);
    writeFileSync(stagePath, decrypted);
    try {
      const db = new DatabaseSync(stagePath, { readOnly: true });
      const result = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
      db.close();
      if (result.integrity_check !== 'ok') throw new Error(result.integrity_check ?? 'unknown');
    } catch {
      if (existsSync(stagePath)) unlinkSync(stagePath);
      throw new BadRequestException({
        code: 'BACKUP_CORRUPT',
        message: 'Yedek SQLite butunluk kontrolunden gecemedi.',
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

  async deleteBackup(user: AuthUser, id: string) {
    const backup = await this.prisma.backup.findFirst({
      where: { id, branchId: user.branchId, deletedAt: null },
    });
    if (!backup) throw new NotFoundException('Yedek bulunamadı.');

    // Delete the file on disk
    if (existsSync(backup.path)) {
      try {
        unlinkSync(backup.path);
        this.logger.log(`Deleted backup file from disk: ${backup.path}`);
      } catch (err) {
        this.logger.error(`Failed to delete backup file from disk: ${backup.path}`, err);
        throw new BadRequestException({
          code: 'BACKUP_DELETE_FAILED',
          message: 'Yedek dosyasi diskten silinemedi.',
        });
      }
    }

    await this.prisma.backup.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        version: { increment: 1 },
      },
    });

    return { success: true };
  }
}
