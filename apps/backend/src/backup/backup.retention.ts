import * as nodePath from 'node:path';

/**
 * Akilli yedek saklama kurallari (saf fonksiyonlar; backup.retention.selfcheck.ts).
 *  - Otomatik: en yeni 3 her zaman; son 7 gunun her gunu, son 4 haftanin her ISO haftasi ve son
 *    6 ayin her ayi icin en yeni birer yedek; gerisi silinir.
 *  - Elle, guncelleme oncesi, disaridan: 90 gun; her turun en yeni 3'u her zaman kalir.
 *  - Disk azaldiysa (bos alan %10'un ya da 2 GB'in altinda): yalniz en yeni 3 otomatik ve diger
 *    her turun en yeni 1'i kalir.
 * Gun/hafta/ay yerel saate gore (dukkanin takvimi).
 */
export const RETENTION = {
  keepNewest: 3,
  dailyDays: 7,
  weeklyWeeks: 4,
  monthlyMonths: 6,
  otherKeepDays: 90,
  lowDiskKeepAuto: 3,
  lowDiskKeepOther: 1,
} as const;

/** Disk azaldi esikleri (veri dizininin bulundugu surucu). */
export const LOW_DISK = {
  minFreeRatio: 0.1,
  minFreeBytes: 2 * 1024 * 1024 * 1024,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionItem {
  id: string;
  type: string;
  createdAt: Date;
}

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Yerel takvim gunu: YYYY-AA-GG. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Yerel takvim ayi: YYYY-AA. */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** Yerel tarihin ISO 8601 haftasi: YYYY-Www (hafta yili; haftalar pazartesi baslar). */
export function isoWeekKey(d: Date): string {
  // Yerel gun UTC takvimine tasinir: yaz saati gecisleri gun farkini bozmasin.
  const day = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const weekday = day.getUTCDay() || 7; // pazartesi=1 ... pazar=7
  day.setUTCDate(day.getUTCDate() + 4 - weekday); // haftanin persembesi hafta yilini belirler
  const weekYear = day.getUTCFullYear();
  const yearStart = Date.UTC(weekYear, 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${weekYear}-W${pad(week)}`;
}

/** Ay ekleme/cikarma (yerel; gun tasmasini Date duzeltir). */
function addMonths(d: Date, months: number): Date {
  const next = new Date(d.getTime());
  next.setMonth(next.getMonth() + months);
  return next;
}

const newestFirst = (a: RetentionItem, b: RetentionItem): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** `since`'ten yeni ogeler icinde her kovanin (gun/hafta/ay) en yenisi. Girdi en yeni once. */
function newestPerBucket(
  sorted: readonly RetentionItem[],
  since: number,
  bucket: (d: Date) => string,
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of sorted) {
    if (item.createdAt.getTime() <= since) continue;
    const key = bucket(item.createdAt);
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(item.id);
  }
  return ids;
}

/** Saklanacak ve silinecek yedekler (silinmemis kayitlar uzerinden). */
export function planRetention(
  items: readonly RetentionItem[],
  options: { now: Date; lowDisk: boolean },
): { keep: Set<string>; remove: string[] } {
  const now = options.now.getTime();
  const byType = new Map<string, RetentionItem[]>();
  for (const item of items) {
    const group = byType.get(item.type) ?? [];
    group.push(item);
    byType.set(item.type, group);
  }
  const keep = new Set<string>();
  const add = (id: string) => keep.add(id);
  for (const [type, group] of byType) {
    const sorted = [...group].sort(newestFirst);
    const isAuto = type === 'auto';
    if (options.lowDisk) {
      const count = isAuto ? RETENTION.lowDiskKeepAuto : RETENTION.lowDiskKeepOther;
      sorted.slice(0, count).forEach((item) => add(item.id));
      continue;
    }
    sorted.slice(0, RETENTION.keepNewest).forEach((item) => add(item.id));
    if (isAuto) {
      newestPerBucket(sorted, now - RETENTION.dailyDays * DAY_MS, dayKey).forEach(add);
      newestPerBucket(sorted, now - RETENTION.weeklyWeeks * 7 * DAY_MS, isoWeekKey).forEach(add);
      newestPerBucket(
        sorted,
        addMonths(options.now, -RETENTION.monthlyMonths).getTime(),
        monthKey,
      ).forEach(add);
    } else {
      const since = now - RETENTION.otherKeepDays * DAY_MS;
      sorted.filter((item) => item.createdAt.getTime() > since).forEach((item) => add(item.id));
    }
  }
  const remove = items.filter((item) => !keep.has(item.id)).map((item) => item.id);
  return { keep, remove };
}

/** Bos alan %10'un ya da 2 GB'in altinda mi. Disk okunamadiysa false (normal kurallar). */
export function isLowDisk(space: DiskSpace | null): boolean {
  if (!space || !(space.totalBytes > 0)) return false;
  return (
    space.freeBytes < space.totalBytes * LOW_DISK.minFreeRatio ||
    space.freeBytes < LOW_DISK.minFreeBytes
  );
}

type PathApi = Pick<typeof nodePath, 'relative' | 'resolve' | 'isAbsolute' | 'basename'>;

/** `file`, `dir` klasorunun dogrudan icinde mi (alt klasor ve dizin disi degil). */
function isDirectChild(file: string, dir: string, paths: PathApi): boolean {
  const rel = paths.relative(paths.resolve(dir), paths.resolve(file));
  return (
    rel.length > 0 && !rel.startsWith('..') && !paths.isAbsolute(rel) && paths.basename(rel) === rel
  );
}

/** Bizim yazdigimiz bulut kopyasi adi (yerel yedekle ayni ad). */
const CLOUD_COPY_NAME = /^backup_[^\\/]+\.db\.enc$/;
/** Yerel yedek klasorundeki yedek adlari (alinan + disaridan yuklenen). */
const LOCAL_BACKUP_NAME = /^(backup|imported)_[^\\/]+\.db\.enc$/;

/**
 * Bulut klasorundeki kopya silinebilir mi: yalniz ayarli `backup.cloudDir` klasorunun dogrudan
 * icindeki `backup_*.db.enc` dosyalari. Klasor bos/degismisse ya da ad uymuyorsa dokunulmaz.
 */
export function isSafeCloudCopy(
  copyPath: string,
  cloudDir: string | null,
  paths: PathApi = nodePath,
): boolean {
  if (!cloudDir?.trim() || !copyPath.trim()) return false;
  return (
    isDirectChild(copyPath, cloudDir.trim(), paths) &&
    CLOUD_COPY_NAME.test(paths.basename(copyPath))
  );
}

/** Yerel yedek dosyasi bizim yedek klasorumuzde ve bizim adlandirmamizla mi (baska dosya silinmez). */
export function isOwnBackupFile(
  filePath: string,
  backupDir: string,
  paths: PathApi = nodePath,
): boolean {
  return (
    isDirectChild(filePath, backupDir, paths) && LOCAL_BACKUP_NAME.test(paths.basename(filePath))
  );
}

/**
 * Silinecek bulut kopyasinin yolu: kayitli yol; eski kayitlarda (yol tutulmazdi) ayarli klasor +
 * yerel dosya adi (kopya ayni adla yazilirdi). Ikisi de yoksa null.
 */
export function cloudCopyCandidate(
  row: { path: string; cloudCopyPath: string | null },
  cloudDir: string | null,
  paths: Pick<typeof nodePath, 'join' | 'basename'> = nodePath,
): string | null {
  if (row.cloudCopyPath) return row.cloudCopyPath;
  if (!cloudDir?.trim()) return null;
  return paths.join(cloudDir.trim(), paths.basename(row.path));
}
