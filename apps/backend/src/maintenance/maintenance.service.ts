import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Prisma } from '@prisma/client';
import { newId } from '@ado/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import {
  InstallMetricsService,
  type InstallMetrics,
} from '../common/metrics/install-metrics.service';
import { resolveDataDir } from '../common/util/data-dir';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { SettingKeys } from '../settings/setting-keys';
import { imagesDir } from '../catalog/catalog.images';
import { BackupService } from '../backup/backup.service';
import { readDiskSpace } from '../backup/backup.disk';
import { isLowDisk } from '../backup/backup.retention';
import {
  FINISHED_JOB_STATUSES,
  isLogFile,
  isOrphanImage,
  isPreRestoreCopy,
  isStaleBackupLeftover,
  preRestoreToDelete,
  PRINTED_JOB_STATUS,
  PURGE_BATCH,
  purgeCutoffs,
} from './maintenance.rules';

export type CleanupTrigger = 'schedule' | 'manual';

/** Son temizligin ozeti (ayar: storage.lastCleanup; ekranda "Son temizlik"). */
export interface CleanupSummary {
  at: string;
  trigger: CleanupTrigger;
  lowDisk: boolean;
  deleted: {
    backups: number;
    cloudCopies: number;
    backgroundJobs: number;
    printJobs: number;
    clientOps: number;
    sessions: number;
    images: number;
    tempFiles: number;
    preRestoreFiles: number;
  };
  freedBytes: number;
  /** Basarisiz adim + kilitli oldugu icin sonraya kalan yedek sayisi (loga yazilir). */
  errors: number;
}

/** GET /storage: diskte ne yer kapliyor. Disk okunamazsa bos/toplam alan null. */
export interface StorageInfo {
  dbBytes: number;
  backups: { count: number; totalBytes: number };
  imagesBytes: number;
  logsBytes: number;
  freeDiskBytes: number | null;
  totalDiskBytes: number | null;
  lowDisk: boolean;
  lastCleanup: CleanupSummary | null;
}

const errorCode = (err: unknown): string | undefined =>
  err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined;

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * Depolama ve gunluk bakim (Faz A / A1). Kendi zamanlayicisiyla calisir (05:30, gunluk yedekten
 * once); arka plan is kuyruguna (mutfak fisleri de orada) yuk bindirmez. Adimlar: akilli yedek
 * saklama, eski teknik kayitlarin silinmesi, artik dosyalar, PRAGMA optimize, ozet.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit {
  private readonly logger = new Logger(MaintenanceService.name);
  private readonly dataDir = resolveDataDir();
  private running: Promise<CleanupSummary> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly backups: BackupService,
    private readonly audit: AuditService,
    private readonly metrics: InstallMetricsService,
  ) {}

  onModuleInit() {
    // Bulut heartbeat'i: veritabani/yedek boyutu, bos disk, son yedek.
    this.metrics.register('storage', () => this.metricsSnapshot());
  }

  @Cron('30 5 * * *')
  async dailyCleanup(): Promise<void> {
    const branch = await this.prisma.branch.findFirst({ where: { deletedAt: null } });
    if (!branch) return;
    try {
      await this.runCleanup(branch.id, 'schedule');
    } catch (err) {
      this.logger.error(`Gunluk bakim basarisiz: ${String(err)}`);
    }
  }

  /** Elle temizlik (Ayarlar > Depolama "Şimdi temizle"); denetim kaydina yazilir. */
  async cleanupNow(user: AuthUser): Promise<CleanupSummary> {
    const summary = await this.runCleanup(user.branchId, 'manual');
    await this.audit.record({
      branchId: user.branchId,
      action: 'storage.cleanup',
      entityType: 'storage',
      entityId: 'cleanup',
      userId: user.userId,
      newValue: { deleted: summary.deleted, freedBytes: summary.freedBytes },
      ...(user.deviceId ? { deviceId: user.deviceId } : {}),
    });
    return summary;
  }

  /** Ayni anda tek temizlik: ikinci istek suren calismanin sonucunu alir. */
  runCleanup(branchId: string, trigger: CleanupTrigger): Promise<CleanupSummary> {
    if (!this.running) {
      this.running = this.cleanup(branchId, trigger).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async cleanup(branchId: string, trigger: CleanupTrigger): Promise<CleanupSummary> {
    const now = new Date();
    const cutoffs = purgeCutoffs(now);
    const summary: CleanupSummary = {
      at: now.toISOString(),
      trigger,
      lowDisk: false,
      deleted: {
        backups: 0,
        cloudCopies: 0,
        backgroundJobs: 0,
        printJobs: 0,
        clientOps: 0,
        sessions: 0,
        images: 0,
        tempFiles: 0,
        preRestoreFiles: 0,
      },
      freedBytes: 0,
      errors: 0,
    };
    // Bir adimin hatasi digerlerini durdurmaz.
    const step = async (label: string, run: () => Promise<void>) => {
      try {
        await run();
      } catch (err) {
        summary.errors += 1;
        this.logger.error(`Bakim adimi basarisiz (${label}): ${String(err)}`);
      }
    };

    await step('yedek saklama', async () => {
      const retention = await this.backups.applyRetention(branchId);
      summary.lowDisk = retention.lowDisk;
      summary.deleted.backups = retention.deleted;
      summary.deleted.cloudCopies = retention.cloudCopiesDeleted;
      summary.freedBytes += retention.freedBytes;
      summary.errors += retention.failed;
    });

    await step('arka plan isleri', async () => {
      const where: Prisma.BackgroundJobWhereInput = {
        status: { in: [...FINISHED_JOB_STATUSES] },
        updatedAt: { lt: cutoffs.backgroundJobs },
      };
      summary.deleted.backgroundJobs = await this.deleteInBatches(
        (take) => this.prisma.backgroundJob.findMany({ where, select: { id: true }, take }),
        (ids) => this.prisma.backgroundJob.deleteMany({ where: { ...where, id: { in: ids } } }),
      );
    });

    await step('fis isleri', async () => {
      const where: Prisma.PrintJobWhereInput = {
        OR: [{ status: PRINTED_JOB_STATUS }, { deletedAt: { not: null } }],
        updatedAt: { lt: cutoffs.printJobs },
      };
      summary.deleted.printJobs = await this.deleteInBatches(
        (take) => this.prisma.printJob.findMany({ where, select: { id: true }, take }),
        (ids) => this.prisma.printJob.deleteMany({ where: { ...where, id: { in: ids } } }),
      );
    });

    await step('cevrimdisi islem defteri', async () => {
      const where: Prisma.ProcessedClientOpWhereInput = { createdAt: { lt: cutoffs.clientOps } };
      summary.deleted.clientOps = await this.deleteInBatches(
        (take) => this.prisma.processedClientOp.findMany({ where, select: { id: true }, take }),
        (ids) => this.prisma.processedClientOp.deleteMany({ where: { ...where, id: { in: ids } } }),
      );
    });

    await step('oturumlar', async () => {
      const where: Prisma.SessionWhereInput = {
        OR: [{ revokedAt: { lt: cutoffs.sessions } }, { expiresAt: { lt: cutoffs.sessions } }],
      };
      summary.deleted.sessions = await this.deleteInBatches(
        (take) => this.prisma.session.findMany({ where, select: { id: true }, take }),
        (ids) => this.prisma.session.deleteMany({ where: { ...where, id: { in: ids } } }),
      );
    });

    await step('sahipsiz gorseller', async () => {
      const removed = await this.purgeOrphanImages(cutoffs.orphanImages);
      summary.deleted.images = removed.count;
      summary.freedBytes += removed.bytes;
    });

    await step('artik yedek dosyalari', async () => {
      const removed = await this.purgeBackupLeftovers(cutoffs.tempFiles);
      summary.deleted.tempFiles = removed.count;
      summary.freedBytes += removed.bytes;
    });

    await step('geri yukleme oncesi kopyalar', async () => {
      const removed = await this.purgePreRestoreCopies();
      summary.deleted.preRestoreFiles = removed.count;
      summary.freedBytes += removed.bytes;
    });

    // Sorgu planlayicisinin istatistikleri (uzun acik baglantilarda SQLite onerisi).
    await step('PRAGMA optimize', async () => {
      await this.prisma.$executeRawUnsafe('PRAGMA optimize');
    });

    await step('ozet', () => this.saveSummary(branchId, summary));
    this.logger.log(
      `Bakim tamam (${trigger}): ${JSON.stringify(summary.deleted)}, ` +
        `${summary.freedBytes} bayt bosaldi, ${summary.errors} hata`,
    );
    return summary;
  }

  /** Kosula uyan kayitlari PURGE_BATCH'lik parcalarla siler (yazma kilidi kisa surer). */
  private async deleteInBatches(
    findIds: (take: number) => Promise<Array<{ id: string }>>,
    remove: (ids: string[]) => Promise<{ count: number }>,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const ids = (await findIds(PURGE_BATCH)).map((row) => row.id);
      if (ids.length === 0) return total;
      const { count } = await remove(ids);
      total += count;
      if (count === 0 || ids.length < PURGE_BATCH) return total;
    }
  }

  /** Dosyayi siler; yoksa/kilitliyse false (kilitliyse sonraki bakimda tekrar). */
  private async removeFile(path: string): Promise<boolean> {
    try {
      await unlink(path);
      return true;
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') {
        this.logger.warn(`Dosya silinemedi, sonra tekrar denenecek: ${path} (${String(err)})`);
      }
      return false;
    }
  }

  /** Klasordeki duz dosyalar (ad + boyut + son degisiklik); klasor yoksa bos. */
  private async listFiles(
    dir: string,
  ): Promise<Array<{ name: string; size: number; mtimeMs: number }>> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return [];
      throw err;
    }
    const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      const info = await stat(join(dir, name)).catch(() => null);
      if (info?.isFile()) files.push({ name, size: info.size, mtimeMs: info.mtimeMs });
    }
    return files;
  }

  /**
   * Hicbir urunun gostermedigi, 7 gunden eski gorseller. Silmeden hemen once kayit yeniden
   * sorulur: ayni gorsel tam o anda yeniden yuklendiyse (dosya ayni ad) silinmez.
   */
  private async purgeOrphanImages(cutoff: Date): Promise<{ count: number; bytes: number }> {
    const dir = imagesDir();
    const files = await this.listFiles(dir);
    if (files.length === 0) return { count: 0, bytes: 0 };
    const products = await this.prisma.product.findMany({
      where: { imagePath: { not: null } },
      select: { imagePath: true },
    });
    const referenced = new Set(products.map((product) => product.imagePath ?? ''));
    let count = 0;
    let bytes = 0;
    for (const file of files) {
      if (!isOrphanImage(file.name, referenced, file.mtimeMs, cutoff)) continue;
      if ((await this.prisma.product.count({ where: { imagePath: file.name } })) > 0) continue;
      if (await this.removeFile(join(dir, file.name))) {
        count += 1;
        bytes += file.size;
      }
    }
    return { count, bytes };
  }

  /** Bekleyen geri yuklemenin staging dosyasi. Isaret var ama okunamiyorsa 'unknown'. */
  private pendingRestoreStage(): string | null | 'unknown' {
    const markerPath = join(this.dataDir, 'restore-pending.json');
    if (!existsSync(markerPath)) return null;
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { stagePath?: unknown };
      return typeof marker.stagePath === 'string' ? resolve(marker.stagePath) : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Yedek klasorunde 1 gunden eski temp_*.db(.enc) ve kullanilmayan restore_staging_*.db. */
  private async purgeBackupLeftovers(cutoff: Date): Promise<{ count: number; bytes: number }> {
    const dir = this.backups.directory;
    const pending = this.pendingRestoreStage();
    let count = 0;
    let bytes = 0;
    for (const file of await this.listFiles(dir)) {
      const path = join(dir, file.name);
      const isStaging = file.name.startsWith('restore_staging_');
      // Isaret okunamiyorsa hicbir staging dosyasina dokunulmaz (acilista takas gerekebilir).
      const referenced =
        isStaging &&
        (pending === 'unknown' || (pending !== null && samePath(resolve(path), pending)));
      if (!isStaleBackupLeftover(file.name, file.mtimeMs, cutoff, referenced)) continue;
      if (await this.removeFile(path)) {
        count += 1;
        bytes += file.size;
      }
    }
    return { count, bytes };
  }

  /** Veri dizinindeki ado.pre-restore-*.db kopyalari: yalniz en yenisi kalir. */
  private async purgePreRestoreCopies(): Promise<{ count: number; bytes: number }> {
    const files = (await this.listFiles(this.dataDir)).filter((file) =>
      isPreRestoreCopy(file.name),
    );
    const doomed = new Set(preRestoreToDelete(files.map((file) => file.name)));
    let count = 0;
    let bytes = 0;
    for (const file of files) {
      if (!doomed.has(file.name)) continue;
      if (await this.removeFile(join(this.dataDir, file.name))) {
        count += 1;
        bytes += file.size;
      }
    }
    return { count, bytes };
  }

  private async saveSummary(branchId: string, summary: CleanupSummary): Promise<void> {
    const value = JSON.stringify(summary);
    await this.prisma.applicationSetting.upsert({
      where: { branchId_key: { branchId, key: SettingKeys.storageLastCleanup } },
      update: { value, deletedAt: null, version: { increment: 1 } },
      create: { id: newId(), branchId, key: SettingKeys.storageLastCleanup, value },
    });
  }

  private async lastCleanup(branchId: string): Promise<CleanupSummary | null> {
    const row = await this.prisma.applicationSetting.findUnique({
      where: { branchId_key: { branchId, key: SettingKeys.storageLastCleanup } },
    });
    if (!row || row.deletedAt) return null;
    try {
      return JSON.parse(row.value) as CleanupSummary;
    } catch {
      return null;
    }
  }

  /** Canli veritabani dosyasi (+ WAL/SHM) boyutu; yol okunamazsa sayfa sayisi x sayfa boyutu. */
  private async databaseBytes(): Promise<number> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ file: string | null }>>(
        "SELECT file FROM pragma_database_list WHERE name = 'main'",
      );
      const file = rows[0]?.file;
      if (file) {
        let total = 0;
        for (const path of [file, `${file}-wal`, `${file}-shm`]) {
          total += (await stat(path).catch(() => null))?.size ?? 0;
        }
        if (total > 0) return total;
      }
    } catch (err) {
      this.logger.warn(`Veritabani yolu okunamadi: ${String(err)}`);
    }
    const rows = await this.prisma.$queryRawUnsafe<Array<{ size: bigint | number | null }>>(
      'SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()',
    );
    return Number(rows[0]?.size ?? 0);
  }

  private async directoryBytes(dir: string, filter: (name: string) => boolean = () => true) {
    return (await this.listFiles(dir))
      .filter((file) => filter(file.name))
      .reduce((sum, file) => sum + file.size, 0);
  }

  private async backupTotals(where: Prisma.BackupWhereInput) {
    const totals = await this.prisma.backup.aggregate({
      where: { ...where, deletedAt: null },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    });
    return { count: totals._count._all, totalBytes: Number(totals._sum.sizeBytes ?? 0) };
  }

  /** GET /storage */
  async storageInfo(branchId: string): Promise<StorageInfo> {
    const [dbBytes, backups, imagesBytes, logsBytes, disk, lastCleanup] = await Promise.all([
      this.databaseBytes(),
      this.backupTotals({ branchId }),
      this.directoryBytes(imagesDir()),
      this.directoryBytes(this.dataDir, isLogFile),
      readDiskSpace(this.dataDir),
      this.lastCleanup(branchId),
    ]);
    return {
      dbBytes,
      backups,
      imagesBytes,
      logsBytes,
      freeDiskBytes: disk?.freeBytes ?? null,
      totalDiskBytes: disk?.totalBytes ?? null,
      lowDisk: isLowDisk(disk),
      lastCleanup,
    };
  }

  /** Heartbeat saglik bilgisi (InstallMetricsService 'storage'). */
  private async metricsSnapshot(): Promise<Partial<InstallMetrics>> {
    const [dbBytes, backups, disk, last] = await Promise.all([
      this.databaseBytes(),
      this.backupTotals({}),
      readDiskSpace(this.dataDir),
      this.prisma.backup.findFirst({
        where: { deletedAt: null, type: { not: 'imported' } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);
    return {
      dbBytes,
      backupsBytes: backups.totalBytes,
      freeDiskBytes: disk?.freeBytes ?? null,
      lastBackupAt: last?.createdAt.toISOString() ?? null,
    };
  }
}
