/**
 * POS <-> bulut sozlesmesi (heartbeat ve bulut yedegi). POS (Node, apps/backend) istegi bu
 * semalarla kurar, bulut (Cloudflare Worker, apps/cloud) ayni semalarla dogrular.
 * Yalniz `zod`'a baglidir: Worker `@ado/shared/cloud-api` giris noktasini kullanir.
 *
 * Bolum sahipligi (paralel calisma, Faz A): "Heartbeat" bolumu A2'nin, "Bulut yedegi"
 * bolumu A3'undur; ortak bolumu yalniz entegrasyon degistirir.
 */
import { z } from 'zod';
import { LICENSE_ID_PATTERN } from './license.js';

// =============================================================================
// Ortak
// =============================================================================

/** POS'taki ado-install.json kimligi (apps/backend/src/common/util/install-id.ts). */
export const INSTALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

const byteCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const isoTime = z.string().datetime({ offset: true });

/** Bulutun her POS yanitinda dondurdugu sube/isletme/lisans ozeti (routes/pos.ts posInfo). */
export const posInfoSchema = z.object({
  branch: z.object({ id: z.string(), name: z.string() }),
  tenant: z.object({
    name: z.string(),
    status: z.enum(['active', 'suspended']),
    plan: z.string(),
    planLabel: z.string(),
    features: z.record(z.string(), z.boolean()),
  }),
  license: z.object({ id: z.string(), expiresAt: z.string().nullable() }).nullable(),
});
export type PosInfo = z.infer<typeof posInfoSchema>;

// =============================================================================
// Heartbeat (A2) — POST /api/pos/heartbeat, saatte bir
// =============================================================================

export const licenseRemoteStateSchema = z.enum(['active', 'suspended', 'revoked', 'expired']);

/** POS'un kendisi hakkinda bildirdikleri. Bilinmeyen deger null (alan atlanmaz). */
export const heartbeatRequestSchema = z.object({
  appVersion: z.string().max(40).nullable(),
  dbBytes: byteCount.nullable(),
  backupsBytes: byteCount.nullable(),
  freeDiskBytes: byteCount.nullable(),
  lastBackupAt: isoTime.nullable(),
  lastCloudBackupAt: isoTime.nullable(),
  licenseId: z.string().regex(LICENSE_ID_PATTERN).nullable(),
  /** POS'taki lisansin `exp` degeri (YYYY-MM-DD). */
  licenseExp: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

export const heartbeatResponseSchema = posInfoSchema.extend({
  remote: z.object({
    state: licenseRemoteStateSchema,
    /** Bulutta ayni kimlikli, daha gec bitisli imzali lisans (POS imzayi dogrulayip kurar). */
    update: z.string().min(20).max(4096).optional(),
  }),
  /** Bulutun saati (ISO). */
  serverTime: isoTime,
  menu: z.object({ version: z.number().int(), updatedAt: z.string() }).nullable(),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

// =============================================================================
// Bulut yedegi (A3) — /api/pos/backups/*
// =============================================================================

/** Buluta giden yedek turleri (`imported` yuklenmez). */
export const cloudBackupTypeSchema = z.enum(['auto', 'manual', 'pre_update']);
export type CloudBackupType = z.infer<typeof cloudBackupTypeSchema>;

/** R2 multipart alt siniri (son parca haric her parca en az bu kadar). */
export const CLOUD_BACKUP_MIN_PART_BYTES = 5 * 1024 * 1024;
/** Tek istekte yuklenebilecek en buyuk yedek (Workers istek siniri 100 MB'in altinda). */
export const CLOUD_BACKUP_SINGLE_MAX_BYTES = 95 * 1000 * 1000;
/** R2'nin bir multipart yuklemede kabul ettigi en cok parca. */
export const CLOUD_BACKUP_MAX_PARTS = 10_000;

/** POS yedek kimligi (ULID; R2 anahtarinda kullanilir, yol karakteri icermez). */
export const CLOUD_BACKUP_POS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Meta veri basliklari: tek parca yuklemede (PUT /api/pos/backups/:posBackupId) sha256, type,
 * format, createdAt; parca yuklemede (PUT .../parts/:partNumber) uploadId.
 */
export const CLOUD_BACKUP_HEADERS = {
  sha256: 'x-ado-sha256',
  type: 'x-ado-backup-type',
  format: 'x-ado-backup-format',
  createdAt: 'x-ado-created-at',
  uploadId: 'x-ado-upload-id',
} as const;

/** Saklama: lisans basina en yeni 30 yedek + son 12 ayin her birinin en yeni yedegi. */
export const CLOUD_BACKUP_RETENTION = { newest: 30, months: 12 } as const;

/**
 * Saklanacak yedeklerin kimlikleri. Bulut her yukleme sonunda gerisini siler; POS ayni kuralla
 * yalniz saklanacak yedekleri yukler (silinecek eski yedek bosuna gonderilmez). Aylar UTC'dir;
 * "son 12 ay" bu ay dahil geriye 12 takvim ayidir. Tarihi okunamayan kayit yalniz en yeni 30'a
 * girerse kalir.
 */
export function planCloudBackupRetention(
  items: ReadonlyArray<{ id: string; createdAt: string }>,
  now: Date = new Date(),
): Set<string> {
  const time = (value: string) => {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  const sorted = [...items].sort((a, b) => {
    const diff = time(b.createdAt) - time(a.createdAt);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  const keep = new Set(sorted.slice(0, CLOUD_BACKUP_RETENTION.newest).map((item) => item.id));
  const thisMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const months = new Set<number>();
  for (const item of sorted) {
    const ms = time(item.createdAt);
    if (ms === -Infinity) continue;
    const date = new Date(ms);
    const month = date.getUTCFullYear() * 12 + date.getUTCMonth();
    if (month > thisMonth || month <= thisMonth - CLOUD_BACKUP_RETENTION.months) continue;
    if (months.has(month)) continue;
    months.add(month);
    keep.add(item.id);
  }
  return keep;
}

export const cloudBackupMetaSchema = z.object({
  id: z.string(),
  /** POS'taki yedek kaydinin kimligi (ayni yedek iki kez yuklenmez). */
  posBackupId: z.string().regex(CLOUD_BACKUP_POS_ID_PATTERN),
  type: cloudBackupTypeSchema,
  format: z.union([z.literal(1), z.literal(2)]),
  sizeBytes: byteCount,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Yedegin POS'ta alindigi an. */
  createdAt: isoTime,
  uploadedAt: isoTime.nullable(),
});
export type CloudBackupMeta = z.infer<typeof cloudBackupMetaSchema>;

export const multipartCreateRequestSchema = z.object({
  sizeBytes: byteCount,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  type: cloudBackupTypeSchema,
  format: z.union([z.literal(1), z.literal(2)]),
  createdAt: isoTime,
  partSize: z.number().int().min(CLOUD_BACKUP_MIN_PART_BYTES).max(CLOUD_BACKUP_SINGLE_MAX_BYTES),
});
export const multipartCreateResponseSchema = z.object({
  uploadId: z.string().min(1),
  partSize: z.number().int(),
});
export const multipartPartSchema = z.object({
  partNumber: z.number().int().min(1).max(10_000),
  etag: z.string().min(1),
});
export const multipartCompleteRequestSchema = z.object({
  uploadId: z.string().min(1),
  parts: z.array(multipartPartSchema).min(1).max(10_000),
});

/** Yeni bilgisayarda geri yukleme: baglanti devralinmadan, lisansla liste. */
export const byLicenseRequestSchema = z.object({
  licenseKey: z.string().trim().min(20).max(4096),
  installId: z.string().regex(INSTALL_ID_PATTERN),
});
export const byLicenseResponseSchema = z.object({
  backups: z.array(
    cloudBackupMetaSchema.extend({
      /** Kisa omurlu indirme adresi (bulut adresine gore goreli yol). */
      downloadUrl: z.string(),
      expiresAt: isoTime,
    }),
  ),
});
export type ByLicenseResponse = z.infer<typeof byLicenseResponseSchema>;
