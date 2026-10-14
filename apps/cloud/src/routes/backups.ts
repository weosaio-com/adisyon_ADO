import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import {
  byLicenseRequestSchema,
  CLOUD_BACKUP_HEADERS,
  CLOUD_BACKUP_MAX_PARTS,
  CLOUD_BACKUP_POS_ID_PATTERN,
  CLOUD_BACKUP_SINGLE_MAX_BYTES,
  cloudBackupTypeSchema,
  multipartCompleteRequestSchema,
  multipartCreateRequestSchema,
} from '@ado/shared/cloud-api';
import type { AppEnv } from '../env';
import {
  abortUnfinishedUploads,
  abortUpload,
  applyRetention,
  assertQuota,
  backupMeta,
  backupObjectKey,
  DEFAULT_BACKUP_QUOTA_BYTES,
  expectedPartBytes,
  findBackup,
  findBackupById,
  findDownload,
  issueDownloadTokens,
  listCompleteBackups,
  partCount,
  purgeExpiredDownloads,
  r2ErrorCode,
  R2_ERRORS,
} from '../lib/backup-store';
import type { CloudBackupRow } from '../lib/db';
import { ApiError, ok, readJson } from '../lib/http';
import { licensePublicKeys, verifyLicense } from '../lib/license';
import { licenseExpired, tenantFeatures } from '../lib/plans';
import { posAuth } from '../lib/pos-auth';
import { limit } from '../lib/rate-limit';
import { findLicense, isRevoked } from '../lib/registry';

/**
 * Otomatik bulut yedegi (/api/pos/backups). POS gunluk yedeklerinin SIFRELI halini yukler; bulut
 * icerigi okuyamaz (anahtar dukkanda, "kurtarma anahtari"). Yeni bilgisayarda lisans anahtariyla
 * liste alinir ve kisa omurlu baglantiyla indirilir (/by-license, /download/:token; belirtecsiz).
 * Tasarim: CLOUD_BACKUP.md.
 *
 * Govde siniri: genel 5 MB siniri bu yolda yok (index.ts); her govdeli uc Content-Length ister
 * (R2 uzunlugu bilinmeyen akisi kabul etmez) ve kendi ust sinirini uygular. Isolate'te ozet
 * hesaplanmaz (Workers Free CPU siniri): tek parcada SHA-256'yi R2 dogrular.
 *
 * Ara katmanlar her uca ayri verilir (Hono `use('/yol')` yalniz tam yolu eslesir).
 */
export const BACKUP_ROUTE_PREFIX = '/api/pos/backups';
export const backupRoutes = new Hono<AppEnv>();

/** JSON govdeli uclarin ust siniri (complete: en cok 10.000 parcalik liste, ~700 KB). */
const JSON_MAX_BYTES = 1024 * 1024;
const DOWNLOAD_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

/** Yol bulut yedeginin mi (genel govde siniri bu yolda uygulanmaz). */
export function isBackupPath(path: string): boolean {
  return path === BACKUP_ROUTE_PREFIX || path.startsWith(`${BACKUP_ROUTE_PREFIX}/`);
}

// -----------------------------------------------------------------------------
// Ara katmanlar
// -----------------------------------------------------------------------------

const requireBucket: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.env.BACKUPS) {
    throw new ApiError(503, 'BACKUPS_DISABLED', 'Bulut yedeği bu bulutta açık değil.');
  }
  await next();
};

/** Content-Length zorunlu (chunked istek 411) ve en fazla `maxBytes`. */
function bodyLength(maxBytes: number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('Content-Length')?.trim() ?? '';
    if (!/^\d{1,16}$/.test(header)) {
      throw new ApiError(411, 'LENGTH_REQUIRED', 'İstek boyutu (Content-Length) belirtilmeli.');
    }
    if (Number(header) > maxBytes) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'İstek çok büyük.');
    }
    await next();
  };
}
const uploadBody = bodyLength(CLOUD_BACKUP_SINGLE_MAX_BYTES);
const jsonBody = bodyLength(JSON_MAX_BYTES);

/**
 * Yukleme, liste ve indirme kapisi: isletme askida degil, lisans iptal edilmemis ve suresi
 * (ek sure dahil) dolmamis, bulut yedegi lisansta kapatilmamis.
 */
const requireBackupAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { tenant } = c.get('pos');
  const bucket = c.env.BACKUPS;
  if (!bucket) throw new ApiError(503, 'BACKUPS_DISABLED', 'Bulut yedeği bu bulutta açık değil.');
  if (tenant.status === 'suspended') {
    throw new ApiError(
      403,
      'TENANT_SUSPENDED',
      'İşletme askıya alınmış; bulut yedeği durduruldu. Satıcınıza başvurun.',
    );
  }
  if (!tenant.license_id) {
    throw new ApiError(403, 'LICENSE_REQUIRED', 'Bulut yedeği için lisans gerekir.');
  }
  const license = await findLicense(c.env.DB, tenant.license_id);
  if (isRevoked(license)) {
    throw new ApiError(403, 'LICENSE_REVOKED', 'Lisans iptal edilmiş. Satıcınıza başvurun.');
  }
  if (licenseExpired(tenant)) {
    throw new ApiError(403, 'LICENSE_EXPIRED', 'Lisansın süresi dolmuş.');
  }
  if (!tenantFeatures(tenant)['cloud.backup']) {
    throw new ApiError(403, 'CLOUD_BACKUP_NOT_LICENSED', 'Lisansınız bulut yedeğini içermiyor.');
  }
  c.set('backup', {
    licenseId: tenant.license_id,
    quotaBytes: license?.backup_quota_bytes ?? DEFAULT_BACKUP_QUOTA_BYTES,
    bucket,
  });
  await next();
};

// -----------------------------------------------------------------------------
// Yardimcilar
// -----------------------------------------------------------------------------

function posBackupIdParam(c: Context<AppEnv>): string {
  const id = c.req.param('posBackupId') ?? '';
  if (!CLOUD_BACKUP_POS_ID_PATTERN.test(id)) {
    throw new ApiError(400, 'BACKUP_ID_INVALID', 'Geçersiz yedek kimliği.');
  }
  return id;
}

const contentLength = (c: Context<AppEnv>) => Number(c.req.header('Content-Length'));
const toUtcIso = (value: string) => new Date(value).toISOString();

const uploadHeadersSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  type: cloudBackupTypeSchema,
  format: z.enum(['1', '2']),
  createdAt: z.string().datetime({ offset: true }),
});

function uploadHeaders(c: Context<AppEnv>) {
  const parsed = uploadHeadersSchema.safeParse({
    sha256: c.req.header(CLOUD_BACKUP_HEADERS.sha256)?.trim().toLowerCase(),
    type: c.req.header(CLOUD_BACKUP_HEADERS.type)?.trim(),
    format: c.req.header(CLOUD_BACKUP_HEADERS.format)?.trim(),
    createdAt: c.req.header(CLOUD_BACKUP_HEADERS.createdAt)?.trim(),
  });
  if (!parsed.success) {
    throw new ApiError(
      400,
      'BACKUP_META_INVALID',
      'Yedek bilgileri (başlıklar) eksik ya da geçersiz.',
      parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        issue: issue.message,
      })),
    );
  }
  return {
    ...parsed.data,
    format: parsed.data.format === '2' ? 2 : 1,
    createdAt: toUtcIso(parsed.data.createdAt),
  };
}

const emptyBackup = () => new ApiError(400, 'BACKUP_EMPTY', 'Yedek dosyası boş.');
const alreadyUploaded = (row: CloudBackupRow) =>
  new ApiError(409, 'BACKUP_ALREADY_UPLOADED', 'Bu yedek zaten bulutta.', backupMeta(row));
const uploadGone = () =>
  new ApiError(404, 'UPLOAD_NOT_FOUND', 'Yükleme bulunamadı; baştan başlatılmalı.');
const notFound = () => new ApiError(404, 'BACKUP_NOT_FOUND', 'Yedek bulunamadı.');

/** Suren multipart yukleme: kayit `uploading` ve kimligi istekteki ile ayni olmali. */
async function requireUpload(
  c: Context<AppEnv>,
  posBackupId: string,
  uploadId: string,
): Promise<CloudBackupRow & { upload_id: string; part_size: number }> {
  const row = await findBackup(c.env.DB, c.get('backup').licenseId, posBackupId);
  if (!row) throw uploadGone();
  if (row.status === 'complete') throw alreadyUploaded(row);
  if (!row.upload_id || !row.part_size || row.upload_id !== uploadId) {
    throw new ApiError(409, 'UPLOAD_ID_MISMATCH', 'Yükleme yenilenmiş; baştan başlatılmalı.');
  }
  return { ...row, upload_id: row.upload_id, part_size: row.part_size };
}

/** Yukleme bitince saklama kurali; hatasi yuklemeyi dusurmez (sonraki yuklemede yeniden denenir). */
async function retain(c: Context<AppEnv>): Promise<void> {
  const { licenseId, bucket } = c.get('backup');
  try {
    await applyRetention(c.env.DB, bucket, licenseId);
  } catch (err) {
    console.error('Bulut yedegi saklama kurali uygulanamadi', err);
  }
}

function streamBackup(c: Context<AppEnv>, object: R2ObjectBody, row: CloudBackupRow): Response {
  return c.body(object.body, 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(object.size),
    'Content-Disposition': `attachment; filename="${row.pos_backup_id}.adobak"`,
    'Cache-Control': 'no-store',
    [CLOUD_BACKUP_HEADERS.sha256]: row.sha256,
  });
}

// -----------------------------------------------------------------------------
// Yeni bilgisayar: lisansla liste ve kisa omurlu indirme (POS belirteci YOK)
// -----------------------------------------------------------------------------

// Lisansin imzasi dogrulanir; suresi dolmus lisans da listeler (veri rehin tutulmaz), iptal
// edilmis lisans listelemez. Yanit her yedek icin 15 dk gecerli indirme adresi tasir.
backupRoutes.post('/by-license', requireBucket, jsonBody, async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  await limit(c.env.DB, [`backups:ip:${ip}`], 10, 15 * 60);
  const body = await readJson(c, byLicenseRequestSchema);
  const payload = await verifyLicense(body.licenseKey, licensePublicKeys(c.env));
  if (!payload) {
    throw new ApiError(400, 'LICENSE_INVALID', 'Lisans anahtarı geçersiz ya da bozuk.');
  }
  if (!payload.id) {
    throw new ApiError(
      400,
      'LICENSE_ID_REQUIRED',
      'Bu lisansta lisans numarası yok; bulut yedeği kullanılamaz.',
    );
  }
  await limit(c.env.DB, [`backups:license:${payload.id}`], 20, 60 * 60);
  if (isRevoked(await findLicense(c.env.DB, payload.id))) {
    throw new ApiError(403, 'LICENSE_REVOKED', 'Lisans iptal edilmiş. Satıcınıza başvurun.');
  }
  const now = new Date();
  await purgeExpiredDownloads(c.env.DB, now);
  const issued = await issueDownloadTokens(
    c.env.DB,
    await listCompleteBackups(c.env.DB, payload.id),
    now,
  );
  return ok(c, {
    backups: issued.map(({ row, token, expiresAt }) => ({
      ...backupMeta(row),
      downloadUrl: `${BACKUP_ROUTE_PREFIX}/download/${token}`,
      expiresAt,
    })),
  });
});

backupRoutes.get('/download/:token', requireBucket, async (c) => {
  const token = c.req.param('token');
  const found = DOWNLOAD_TOKEN_PATTERN.test(token) ? await findDownload(c.env.DB, token) : null;
  if (!found) throw new ApiError(404, 'DOWNLOAD_NOT_FOUND', 'İndirme bağlantısı geçersiz.');
  if (found.expired) {
    throw new ApiError(
      410,
      'DOWNLOAD_EXPIRED',
      'İndirme bağlantısının süresi doldu. Yedek listesini yenileyin.',
    );
  }
  const object = await c.env.BACKUPS!.get(found.row.r2_key);
  if (!object) throw notFound();
  return streamBackup(c, object, found.row);
});

// -----------------------------------------------------------------------------
// POS belirteciyle: liste ve indirme
// -----------------------------------------------------------------------------

backupRoutes.get('/', requireBucket, posAuth, requireBackupAccess, async (c) => {
  const rows = await listCompleteBackups(c.env.DB, c.get('backup').licenseId);
  return ok(c, rows.map(backupMeta));
});

backupRoutes.get('/:id/download', requireBucket, posAuth, requireBackupAccess, async (c) => {
  const { licenseId, bucket } = c.get('backup');
  const row = await findBackupById(c.env.DB, licenseId, c.req.param('id'));
  if (!row || row.status !== 'complete') throw notFound();
  const object = await bucket.get(row.r2_key);
  if (!object) throw notFound();
  return streamBackup(c, object, row);
});

// -----------------------------------------------------------------------------
// Tek parca yukleme (en fazla 95 MB): govde dogrudan R2'ye akar, SHA-256'yi R2 dogrular.
// -----------------------------------------------------------------------------

backupRoutes.put(
  '/:posBackupId',
  requireBucket,
  posAuth,
  requireBackupAccess,
  uploadBody,
  async (c) => {
    const posBackupId = posBackupIdParam(c);
    const meta = uploadHeaders(c);
    const sizeBytes = contentLength(c);
    const body = c.req.raw.body;
    if (sizeBytes === 0 || !body) throw emptyBackup();
    const db = c.env.DB;
    const { branch, tenant } = c.get('pos');
    const access = c.get('backup');

    // Ayni yedek ikinci kez gelirse (yanit POS'a ulasmamis) mevcut kayit doner.
    const existing = await findBackup(db, access.licenseId, posBackupId);
    if (existing?.status === 'complete') {
      if (existing.sha256 !== meta.sha256) {
        throw new ApiError(409, 'BACKUP_CONFLICT', 'Bu kimlikle farklı bir yedek zaten bulutta.');
      }
      return ok(c, backupMeta(existing));
    }
    await assertQuota(db, access, { posBackupId, createdAt: meta.createdAt, sizeBytes });
    if (existing) await abortUpload(access.bucket, existing.r2_key, existing.upload_id);

    const key = backupObjectKey(access.licenseId, posBackupId);
    let object: R2Object;
    try {
      object = await access.bucket.put(key, body, {
        sha256: meta.sha256,
        httpMetadata: { contentType: 'application/octet-stream' },
      });
    } catch (err) {
      if (r2ErrorCode(err) === R2_ERRORS.BAD_DIGEST) {
        throw new ApiError(
          400,
          'BACKUP_CHECKSUM_MISMATCH',
          'Yüklenen dosyanın özeti (SHA-256) bildirilenle eşleşmiyor.',
        );
      }
      throw err;
    }
    if (object.size !== sizeBytes) {
      await access.bucket.delete(key);
      throw new ApiError(400, 'BACKUP_SIZE_MISMATCH', 'Yüklenen dosyanın boyutu eksik.');
    }
    const now = new Date().toISOString();
    const row = await db
      .prepare(
        `INSERT INTO cloud_backups (id, license_id, tenant_id, branch_id, install_id, pos_backup_id,
           r2_key, backup_type, format, size_bytes, sha256, pos_created_at, status, upload_id,
           part_size, created_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'complete', NULL, NULL, ?13, ?13)
         ON CONFLICT (license_id, pos_backup_id) DO UPDATE SET
           tenant_id = excluded.tenant_id, branch_id = excluded.branch_id,
           install_id = excluded.install_id, backup_type = excluded.backup_type,
           format = excluded.format, size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
           pos_created_at = excluded.pos_created_at, status = 'complete', upload_id = NULL,
           part_size = NULL, completed_at = excluded.completed_at
         RETURNING *`,
      )
      .bind(
        crypto.randomUUID(),
        access.licenseId,
        tenant.id,
        branch.id,
        branch.install_id,
        posBackupId,
        key,
        meta.type,
        meta.format,
        sizeBytes,
        meta.sha256,
        meta.createdAt,
        now,
      )
      .first<CloudBackupRow>();
    if (!row) throw new ApiError(500, 'BACKUP_SAVE_FAILED', 'Yedek kaydedilemedi.');
    await retain(c);
    return ok(c, backupMeta(row), 201);
  },
);

// -----------------------------------------------------------------------------
// Multipart (95 MB ustu): baslat, parca parca yukle, tamamla. Parcalar esit boyludur (son haric).
// -----------------------------------------------------------------------------

backupRoutes.post(
  '/:posBackupId/multipart',
  requireBucket,
  posAuth,
  requireBackupAccess,
  jsonBody,
  async (c) => {
    const posBackupId = posBackupIdParam(c);
    const body = await readJson(c, multipartCreateRequestSchema);
    if (body.sizeBytes === 0) throw emptyBackup();
    if (partCount(body.sizeBytes, body.partSize) > CLOUD_BACKUP_MAX_PARTS) {
      throw new ApiError(413, 'BACKUP_TOO_LARGE', 'Yedek çok büyük (parça sınırı aşıldı).');
    }
    const db = c.env.DB;
    const { branch, tenant } = c.get('pos');
    const access = c.get('backup');
    const createdAt = toUtcIso(body.createdAt);

    const existing = await findBackup(db, access.licenseId, posBackupId);
    if (existing?.status === 'complete') throw alreadyUploaded(existing);
    await assertQuota(db, access, { posBackupId, createdAt, sizeBytes: body.sizeBytes });
    // Yeniden baslatma: bu yedegin (ve lisansin diger) yarim yuklemesi iptal edilir.
    await abortUnfinishedUploads(db, access.bucket, access.licenseId);

    const key = backupObjectKey(access.licenseId, posBackupId);
    const upload = await access.bucket.createMultipartUpload(key, {
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    await db
      .prepare(
        `INSERT INTO cloud_backups (id, license_id, tenant_id, branch_id, install_id, pos_backup_id,
           r2_key, backup_type, format, size_bytes, sha256, pos_created_at, status, upload_id,
           part_size, created_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'uploading', ?13, ?14, ?15, NULL)
         ON CONFLICT (license_id, pos_backup_id) DO UPDATE SET
           tenant_id = excluded.tenant_id, branch_id = excluded.branch_id,
           install_id = excluded.install_id, backup_type = excluded.backup_type,
           format = excluded.format, size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
           pos_created_at = excluded.pos_created_at, status = 'uploading',
           upload_id = excluded.upload_id, part_size = excluded.part_size,
           created_at = excluded.created_at, completed_at = NULL`,
      )
      .bind(
        crypto.randomUUID(),
        access.licenseId,
        tenant.id,
        branch.id,
        branch.install_id,
        posBackupId,
        key,
        body.type,
        body.format,
        body.sizeBytes,
        body.sha256,
        createdAt,
        upload.uploadId,
        body.partSize,
        new Date().toISOString(),
      )
      .run();
    return ok(c, { uploadId: upload.uploadId, partSize: body.partSize }, 201);
  },
);

backupRoutes.put(
  '/:posBackupId/parts/:partNumber',
  requireBucket,
  posAuth,
  requireBackupAccess,
  uploadBody,
  async (c) => {
    const posBackupId = posBackupIdParam(c);
    const uploadId = c.req.header(CLOUD_BACKUP_HEADERS.uploadId)?.trim() ?? '';
    const row = await requireUpload(c, posBackupId, uploadId);
    const partText = c.req.param('partNumber');
    const partNumber = /^\d{1,5}$/.test(partText) ? Number(partText) : NaN;
    const expected = expectedPartBytes(row.size_bytes, row.part_size, partNumber);
    if (expected === null) {
      throw new ApiError(400, 'PART_NUMBER_INVALID', 'Parça numarası geçersiz.');
    }
    const body = c.req.raw.body;
    if (contentLength(c) !== expected || !body) {
      throw new ApiError(400, 'PART_SIZE_INVALID', 'Parça boyu beklenenden farklı.', {
        expectedBytes: expected,
      });
    }
    try {
      const part = await c
        .get('backup')
        .bucket.resumeMultipartUpload(row.r2_key, uploadId)
        .uploadPart(partNumber, body);
      return ok(c, { partNumber: part.partNumber, etag: part.etag });
    } catch (err) {
      if (r2ErrorCode(err) === R2_ERRORS.NO_SUCH_UPLOAD) throw uploadGone();
      throw err;
    }
  },
);

backupRoutes.post(
  '/:posBackupId/complete',
  requireBucket,
  posAuth,
  requireBackupAccess,
  jsonBody,
  async (c) => {
    const posBackupId = posBackupIdParam(c);
    const body = await readJson(c, multipartCompleteRequestSchema);
    const row = await requireUpload(c, posBackupId, body.uploadId);
    const parts = [...body.parts].sort((a, b) => a.partNumber - b.partNumber);
    const count = partCount(row.size_bytes, row.part_size);
    if (parts.length !== count || parts.some((part, i) => part.partNumber !== i + 1)) {
      throw new ApiError(400, 'PARTS_INVALID', 'Parça listesi eksik ya da hatalı.');
    }
    const { bucket } = c.get('backup');
    let object: R2Object;
    try {
      object = await bucket.resumeMultipartUpload(row.r2_key, body.uploadId).complete(parts);
    } catch (err) {
      const code = r2ErrorCode(err);
      if (code === R2_ERRORS.NO_SUCH_UPLOAD) throw uploadGone();
      if (
        code === R2_ERRORS.INVALID_PART ||
        code === R2_ERRORS.ENTITY_TOO_SMALL ||
        code === R2_ERRORS.BAD_UPLOAD
      ) {
        throw new ApiError(400, 'PARTS_INVALID', 'Parça listesi eksik ya da hatalı.');
      }
      throw err;
    }
    const db = c.env.DB;
    if (object.size !== row.size_bytes) {
      await db.prepare('DELETE FROM cloud_backups WHERE id = ?').bind(row.id).run();
      await bucket.delete(row.r2_key);
      throw new ApiError(400, 'BACKUP_SIZE_MISMATCH', 'Yüklenen dosyanın boyutu eksik.');
    }
    const done = await db
      .prepare(
        `UPDATE cloud_backups SET status = 'complete', upload_id = NULL, part_size = NULL,
           completed_at = ? WHERE id = ? RETURNING *`,
      )
      .bind(new Date().toISOString(), row.id)
      .first<CloudBackupRow>();
    if (!done) throw new ApiError(500, 'BACKUP_SAVE_FAILED', 'Yedek kaydedilemedi.');
    await retain(c);
    return ok(c, backupMeta(done));
  },
);
