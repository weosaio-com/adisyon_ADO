import { MENU_IMAGE_KEY_PATTERN, PrintJobStatus } from '@ado/shared';

/**
 * Gunluk bakim kurallari (saf; maintenance.rules.selfcheck.ts). Yalniz TEKNIK kayitlar ve artik
 * dosyalar silinir; denetim kaydi (audit_logs) ve isletme tablolarina (siparis, odeme, kasa,
 * musteri...) asla dokunulmaz.
 */
export const PURGE_DAYS = {
  /** Biten/basarisiz arka plan isleri (worker.service.ts: completed | failed). */
  backgroundJobs: 30,
  /** Basilan ya da listeden kaldirilan fis isleri (fisin kendi kopyasi receipts'te kalir). */
  printJobs: 90,
  /** Tablet cevrimdisi islem defteri (tekrar gonderim korumasi). */
  clientOps: 30,
  /** Iptal edilmis ya da suresi dolmus oturumlar. */
  sessions: 30,
  /** Hicbir urunun gostermedigi gorseller (yuklenen dosya urune baglanmadan once yazilir). */
  orphanImages: 7,
  /** Yedek klasorundeki yarim kalmis gecici dosyalar. */
  tempFiles: 1,
} as const;

/** Tek seferde silinecek kayit sayisi: yazma kilidi kisa surer, satis beklemez. */
export const PURGE_BATCH = 1000;

/** worker.service.ts'teki bitmis is durumlari. */
export const FINISHED_JOB_STATUSES: readonly string[] = ['completed', 'failed'];
/** printing.service.ts: basildi. Kaldirilan (dismiss) fis deletedAt ile isaretlenir. */
export const PRINTED_JOB_STATUS: string = PrintJobStatus.Done;

const DAY_MS = 24 * 60 * 60 * 1000;

export type PurgeCutoffs = { [K in keyof typeof PURGE_DAYS]: Date };

/** Her kural icin "bundan eski" siniri. */
export function purgeCutoffs(now: Date): PurgeCutoffs {
  const entries = Object.entries(PURGE_DAYS).map(([key, days]) => [
    key,
    new Date(now.getTime() - days * DAY_MS),
  ]);
  return Object.fromEntries(entries) as PurgeCutoffs;
}

/** storeMenuImage'in yarim kalan gecici dosyasi: <anahtar>.<hex>.tmp */
const IMAGE_TEMP = /^[a-f0-9]{64}\.(webp|jpg|png)\.[a-f0-9]+\.tmp$/;
const BACKUP_TEMP = /^temp_[^\\/]+\.db(\.enc)?$/;
const RESTORE_STAGING = /^restore_staging_[^\\/]+\.db$/;
const PRE_RESTORE = /^ado\.pre-restore-(\d+)\.db$/;
const LOG_FILE = /\.log(\.\d+)?$/i;

/**
 * images/ altindaki dosya silinebilir mi: gorsel anahtari (ya da yarim .tmp), hicbir urun
 * gostermiyor ve son degisikligi `cutoff`'tan eski. Baska adli dosyalara dokunulmaz.
 */
export function isOrphanImage(
  name: string,
  referenced: ReadonlySet<string>,
  mtimeMs: number,
  cutoff: Date,
): boolean {
  if (!MENU_IMAGE_KEY_PATTERN.test(name) && !IMAGE_TEMP.test(name)) return false;
  if (referenced.has(name)) return false;
  return mtimeMs < cutoff.getTime();
}

/**
 * Yedek klasorundeki artik dosya mi: temp_*.db(.enc) ya da restore_staging_*.db; bekleyen geri
 * yukleme isaretinin (restore-pending.json) gosterdigi dosya degil; `cutoff`'tan eski.
 */
export function isStaleBackupLeftover(
  name: string,
  mtimeMs: number,
  cutoff: Date,
  referencedByRestore: boolean,
): boolean {
  if (!BACKUP_TEMP.test(name) && !RESTORE_STAGING.test(name)) return false;
  if (referencedByRestore) return false;
  return mtimeMs < cutoff.getTime();
}

/** Geri yukleme oncesi kopyasi mi (restore.mjs: ado.pre-restore-<ms>.db). */
export function isPreRestoreCopy(name: string): boolean {
  return PRE_RESTORE.test(name);
}

/** ado.pre-restore-<ms>.db kopyalarindan silinecekler: yalniz en yenisi kalir. */
export function preRestoreToDelete(names: readonly string[]): string[] {
  const copies = names
    .map((name) => ({ name, stamp: Number(PRE_RESTORE.exec(name)?.[1] ?? NaN) }))
    .filter((copy) => Number.isFinite(copy.stamp))
    .sort((a, b) => b.stamp - a.stamp || (a.name < b.name ? 1 : -1));
  return copies.slice(1).map((copy) => copy.name);
}

/** Veri dizinindeki gunluk dosyasi mi (backend-error.log, backend-error.log.1). */
export function isLogFile(name: string): boolean {
  return LOG_FILE.test(name);
}
