import { planCloudBackupRetention, type CloudBackupMeta } from '@ado/shared/cloud-api';
import type { BackupAccess } from '../env';
import { randomToken, sha256Hex } from './crypto';
import type { CloudBackupRow } from './db';
import { ApiError } from './http';

/**
 * Bulut yedegi deposu (D1 `cloud_backups` + R2 BACKUPS). Yedekler POS'ta dukkanin kendi anahtariyla
 * sifrelenir; bulut yalniz sifreli dosyayi saklar (icerigi okuyamaz). Kayitlar lisans kimligine
 * baglidir: saklama ve kota lisans basinadir. Tasarim: CLOUD_BACKUP.md.
 */

/** Lisans kaydinda kota yoksa (licenses.backup_quota_bytes NULL ya da kayit yok): 10 GB. */
export const DEFAULT_BACKUP_QUOTA_BYTES = 10 * 1024 ** 3;
/** Yeni bilgisayardan indirme baglantisinin omru. */
export const DOWNLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;
/**
 * Tamamlanmayan multipart kaydi bu sureden sonra temizlenir. R2 de yarim yuklemeyi varsayilan
 * olarak 7 gun sonra kendiliginden iptal eder (ek yasam dongusu kurali gerekmez).
 */
const STALE_UPLOAD_MS = 7 * 24 * 60 * 60 * 1000;
/** R2 toplu silme siniri. */
const R2_DELETE_BATCH = 1000;

/** R2 hata kodlari (workerd mesajin sonuna "(10037)" gibi ekler). */
export const R2_ERRORS = {
  ENTITY_TOO_SMALL: 10011,
  NO_SUCH_UPLOAD: 10024,
  INVALID_PART: 10025,
  BAD_DIGEST: 10037,
  BAD_UPLOAD: 10048,
} as const;

export function r2ErrorCode(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = /\((\d{5,6})\)\s*$/.exec(message);
  return match ? Number(match[1]) : null;
}

export const backupObjectKey = (licenseId: string, posBackupId: string) =>
  `backups/${licenseId}/${posBackupId}.adobak`;

export function backupMeta(row: CloudBackupRow): CloudBackupMeta {
  return {
    id: row.id,
    posBackupId: row.pos_backup_id,
    type: row.backup_type,
    format: row.format === 2 ? 2 : 1,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.pos_created_at,
    uploadedAt: row.completed_at,
  };
}

/** Multipart parca sayisi (bos olmayan dosya icin en az 1). */
export function partCount(sizeBytes: number, partSize: number): number {
  return Math.max(1, Math.ceil(sizeBytes / partSize));
}

/** n. parcanin beklenen boyu: son parca haric hepsi `partSize` (R2 esit parca ister). */
export function expectedPartBytes(
  sizeBytes: number,
  partSize: number,
  partNumber: number,
): number | null {
  const count = partCount(sizeBytes, partSize);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) return null;
  return partNumber < count ? partSize : sizeBytes - (count - 1) * partSize;
}

export function findBackup(
  db: D1Database,
  licenseId: string,
  posBackupId: string,
): Promise<CloudBackupRow | null> {
  return db
    .prepare('SELECT * FROM cloud_backups WHERE license_id = ? AND pos_backup_id = ?')
    .bind(licenseId, posBackupId)
    .first<CloudBackupRow>();
}

export function findBackupById(
  db: D1Database,
  licenseId: string,
  id: string,
): Promise<CloudBackupRow | null> {
  return db
    .prepare('SELECT * FROM cloud_backups WHERE id = ? AND license_id = ?')
    .bind(id, licenseId)
    .first<CloudBackupRow>();
}

/** Lisansin tamamlanmis yedekleri, en yenisi once (pos_created_at UTC ISO yazilir). */
export async function listCompleteBackups(
  db: D1Database,
  licenseId: string,
): Promise<CloudBackupRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM cloud_backups WHERE license_id = ? AND status = 'complete'
       ORDER BY pos_created_at DESC, id DESC`,
    )
    .bind(licenseId)
    .all<CloudBackupRow>();
  return results;
}

export interface IncomingBackup {
  posBackupId: string;
  /** UTC ISO. */
  createdAt: string;
  sizeBytes: number;
}

/**
 * Kota: yeni yedekle birlikte saklama kuralindan sonra kalacak toplam boyut kotayi asarsa 413.
 * Yuklemeden ONCE bakilir (bosuna veri gelmesin).
 */
export async function assertQuota(
  db: D1Database,
  access: Pick<BackupAccess, 'licenseId' | 'quotaBytes'>,
  incoming: IncomingBackup,
  now = new Date(),
): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT id, pos_created_at, size_bytes FROM cloud_backups
       WHERE license_id = ? AND status = 'complete' AND pos_backup_id != ?`,
    )
    .bind(access.licenseId, incoming.posBackupId)
    .all<{ id: string; pos_created_at: string; size_bytes: number }>();
  const NEW = '\u0000yeni';
  const items = [
    ...results.map((row) => ({ id: row.id, createdAt: row.pos_created_at, size: row.size_bytes })),
    { id: NEW, createdAt: incoming.createdAt, size: incoming.sizeBytes },
  ];
  const keep = planCloudBackupRetention(items, now);
  const total = items.reduce((sum, item) => (keep.has(item.id) ? sum + item.size : sum), 0);
  if (total > access.quotaBytes) {
    throw new ApiError(
      413,
      'BACKUP_QUOTA_EXCEEDED',
      'Bulut yedek kotası doldu. Satıcınıza başvurun.',
      { quotaBytes: access.quotaBytes, requiredBytes: total },
    );
  }
}

/** Yarim multipart yuklemeyi R2'de iptal eder; zaten yoksa sessiz. */
export async function abortUpload(
  bucket: R2Bucket,
  key: string,
  uploadId: string | null,
): Promise<void> {
  if (!uploadId) return;
  try {
    await bucket.resumeMultipartUpload(key, uploadId).abort();
  } catch {
    // Tamamlanmis, iptal edilmis ya da yasam dongusuyle silinmis.
  }
}

async function deleteRowsAndObjects(
  db: D1Database,
  bucket: R2Bucket,
  rows: Array<{ id: string; r2_key: string; upload_id?: string | null; status?: string }>,
): Promise<void> {
  if (rows.length === 0) return;
  // Once kayit: nesne silinemezse yetim kalir (gorunmez, kotaya sayilmaz); tersi listede bozuk kayit.
  await db
    .prepare('DELETE FROM cloud_backups WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(rows.map((row) => row.id)))
    .run();
  for (const row of rows) {
    if (row.status === 'uploading') await abortUpload(bucket, row.r2_key, row.upload_id ?? null);
  }
  const keys = rows.filter((row) => row.status !== 'uploading').map((row) => row.r2_key);
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
    try {
      await bucket.delete(keys.slice(i, i + R2_DELETE_BATCH));
    } catch (err) {
      console.error('Bulut yedegi nesneleri silinemedi', err);
    }
  }
}

/**
 * Lisansin yarim kalan multipart yuklemelerini iptal eder. POS ayni anda tek yukleme yapar;
 * baska bir yarim yukleme eskidir (ya da onceki bilgisayarindir).
 */
export async function abortUnfinishedUploads(
  db: D1Database,
  bucket: R2Bucket,
  licenseId: string,
): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT id, r2_key, upload_id, status FROM cloud_backups
       WHERE license_id = ? AND status = 'uploading'`,
    )
    .bind(licenseId)
    .all<{ id: string; r2_key: string; upload_id: string | null; status: string }>();
  await deleteRowsAndObjects(db, bucket, results);
}

/**
 * Saklama (her yukleme sonunda, lisans basina): en yeni 30 yedek + son 12 ayin her birinin en yeni
 * yedegi kalir, gerisi R2'den ve kayitlardan silinir. Bir haftadan eski yarim yuklemeler de temizlenir.
 */
export async function applyRetention(
  db: D1Database,
  bucket: R2Bucket,
  licenseId: string,
  now = new Date(),
): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id, r2_key, pos_created_at, status FROM cloud_backups
       WHERE license_id = ? AND status = 'complete'`,
    )
    .bind(licenseId)
    .all<{ id: string; r2_key: string; pos_created_at: string; status: string }>();
  const keep = planCloudBackupRetention(
    results.map((row) => ({ id: row.id, createdAt: row.pos_created_at })),
    now,
  );
  const drop = results.filter((row) => !keep.has(row.id));
  const stale = await db
    .prepare(
      `SELECT id, r2_key, upload_id, status FROM cloud_backups
       WHERE license_id = ? AND status = 'uploading' AND created_at < ?`,
    )
    .bind(licenseId, new Date(now.getTime() - STALE_UPLOAD_MS).toISOString())
    .all<{ id: string; r2_key: string; upload_id: string | null; status: string }>();
  await deleteRowsAndObjects(db, bucket, [...drop, ...stale.results]);
  return drop.length;
}

// -----------------------------------------------------------------------------
// Yeni bilgisayar: kisa omurlu indirme jetonlari (yalniz SHA-256 ozeti saklanir)
// -----------------------------------------------------------------------------

export interface IssuedDownload {
  row: CloudBackupRow;
  token: string;
  expiresAt: string;
}

export async function issueDownloadTokens(
  db: D1Database,
  rows: CloudBackupRow[],
  now = new Date(),
): Promise<IssuedDownload[]> {
  const expiresAt = new Date(now.getTime() + DOWNLOAD_TOKEN_TTL_MS).toISOString();
  const issued = await Promise.all(
    rows.map(async (row) => {
      const token = randomToken();
      return { row, token, hash: await sha256Hex(token) };
    }),
  );
  if (issued.length) {
    await db.batch(
      issued.map((item) =>
        db
          .prepare(
            `INSERT INTO cloud_backup_downloads (token_hash, backup_id, expires_at, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(item.hash, item.row.id, expiresAt, now.toISOString()),
      ),
    );
  }
  return issued.map(({ row, token }) => ({ row, token, expiresAt }));
}

/** Suresi dolan jetonlari siler (liste isteginde, firsat buldukca). */
export async function purgeExpiredDownloads(db: D1Database, now = new Date()): Promise<void> {
  await db
    .prepare('DELETE FROM cloud_backup_downloads WHERE expires_at < ?')
    .bind(now.toISOString())
    .run();
}

/** Jetonun yedegi; jeton yoksa null, suresi dolmussa `expired`. */
export async function findDownload(
  db: D1Database,
  token: string,
  now = new Date(),
): Promise<{ row: CloudBackupRow; expired: boolean } | null> {
  const row = await db
    .prepare(
      `SELECT b.*, d.expires_at AS d_expires_at FROM cloud_backup_downloads d
       JOIN cloud_backups b ON b.id = d.backup_id
       WHERE d.token_hash = ? AND b.status = 'complete'`,
    )
    .bind(await sha256Hex(token))
    .first<CloudBackupRow & { d_expires_at: string }>();
  if (!row) return null;
  const { d_expires_at, ...backup } = row;
  return { row: backup, expired: d_expires_at <= now.toISOString() };
}
