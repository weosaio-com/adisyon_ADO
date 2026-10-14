import {
  byLicenseResponseSchema,
  CLOUD_BACKUP_MAX_PARTS,
  CLOUD_BACKUP_MIN_PART_BYTES,
  cloudBackupTypeSchema,
  planCloudBackupRetention,
  type ByLicenseResponse,
} from '@ado/shared';

/**
 * Bulut yedeginin saf (yan etkisiz) kararlari: geri cekilme, parca plani, yukleme sirasi, hata
 * sinifi ve bulut yanitinin okunmasi. Servis bunlari kullanir; self-check bunlari dogrular.
 */

/** Buluta giden yedek turleri (disaridan alinan `imported` yuklenmez). */
export const CLOUD_BACKUP_TYPES: readonly string[] = cloudBackupTypeSchema.options;

/** Ardisik basarisizliklarda bekleme adimlari (sn): 1 dk, 5 dk, 15 dk, sonra en cok 1 saat. */
export const BACKOFF_STEPS_SECONDS = [60, 300, 900, 3600] as const;

/**
 * `failures` ardisik basarisizliktan sonra beklenecek sure (sn). Ust sinir denetim araligidir
 * (varsayilan 1 saat): aralik kisaysa (testler) bekleme de kisalir.
 */
export function backoffSeconds(failures: number, capSeconds = 3600): number {
  if (failures <= 0) return 0;
  const step = BACKOFF_STEPS_SECONDS[Math.min(failures, BACKOFF_STEPS_SECONDS.length) - 1]!;
  return Math.max(1, Math.min(step, capSeconds));
}

/** Yukleme zaman asimi: 60 sn + MB basina 1 sn. */
export function uploadTimeoutMs(bytes: number): number {
  return 60_000 + Math.ceil(bytes / 1_000_000) * 1000;
}

/** Indirme zaman asimi (yeni bilgisayar): 2 dk + MB basina 2 sn (yavas hatlar icin genis). */
export function downloadTimeoutMs(bytes: number): number {
  return 120_000 + Math.ceil(bytes / 1_000_000) * 2000;
}

export interface PartPlan {
  partNumber: number;
  offset: number;
  length: number;
}

/** Parca boyu: ayardaki boy (en az 5 MiB); 10.000 parcayi asacak dosyada buyutulur. */
export function choosePartSize(sizeBytes: number, configured: number): number {
  return Math.max(
    CLOUD_BACKUP_MIN_PART_BYTES,
    configured,
    Math.ceil(sizeBytes / CLOUD_BACKUP_MAX_PARTS),
  );
}

/** Dosyanin parcalari: hepsi `partSize`, son parca kalan (R2 esit parca ister). */
export function planParts(sizeBytes: number, partSize: number): PartPlan[] {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`Gecersiz dosya boyu: ${sizeBytes}`);
  }
  if (!Number.isSafeInteger(partSize) || partSize <= 0) {
    throw new Error(`Gecersiz parca boyu: ${partSize}`);
  }
  const count = Math.ceil(sizeBytes / partSize);
  if (count > CLOUD_BACKUP_MAX_PARTS) throw new Error(`Parca sayisi siniri asildi: ${count}`);
  return Array.from({ length: count }, (_, i) => ({
    partNumber: i + 1,
    offset: i * partSize,
    length: Math.min(partSize, sizeBytes - i * partSize),
  }));
}

export interface LocalBackupLite {
  id: string;
  type: string;
  createdAt: Date;
  deletedAt?: Date | null;
}

export interface UploadLite {
  backupId: string;
  status: string;
  uploadId?: string | null;
}

/**
 * Yuklenecek yedekler, oncelik sirasiyla. Aday: buluta giden tur, silinmemis, `done` ya da kalici
 * `failed` degil ve bulutun saklama kuralinin tutacagi yedek (en yeni 30 + son 12 ayin en yenisi;
 * yuklenip hemen silinecek eski yedek bosuna gonderilmez). Sira: once yarim kalmis multipart
 * (yuklenen parcalar bosa gitmesin), sonra en yeniden eskiye.
 */
export function pendingBackups<T extends LocalBackupLite>(
  backups: readonly T[],
  uploads: readonly UploadLite[],
  now: Date = new Date(),
): T[] {
  const eligible = backups.filter((b) => !b.deletedAt && CLOUD_BACKUP_TYPES.includes(b.type));
  const keep = planCloudBackupRetention(
    eligible.map((b) => ({ id: b.id, createdAt: b.createdAt.toISOString() })),
    now,
  );
  const byBackup = new Map(uploads.map((u) => [u.backupId, u]));
  const resumable = (b: T) => (byBackup.get(b.id)?.uploadId ? 1 : 0);
  return eligible
    .filter((b) => {
      const status = byBackup.get(b.id)?.status;
      return keep.has(b.id) && status !== 'done' && status !== 'failed';
    })
    .sort(
      (a, b) =>
        resumable(b) - resumable(a) ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
}

/**
 * Bulut hatasinin sinifi:
 * - network: buluta ulasilamadi (sessizce, geri cekilerek yeniden denenir)
 * - done: yedek zaten bulutta (basari sayilir)
 * - restart: multipart yenilenmeli (yarim yukleme bulutta yok/degisti)
 * - permanent: bu yedek hic yuklenemez (dosya bozuk vb.); siradakine gecilir
 * - retry: gecici (askida, kota, bakim...): geri cekilerek yeniden denenir, hata ekranda gorunur
 */
export type UploadErrorKind = 'network' | 'done' | 'restart' | 'permanent' | 'retry';

const RESTART_CODES = new Set([
  'UPLOAD_NOT_FOUND',
  'UPLOAD_ID_MISMATCH',
  'PARTS_INVALID',
  'PART_SIZE_INVALID',
  'PART_NUMBER_INVALID',
]);
const PERMANENT_CODES = new Set([
  'BACKUP_CHECKSUM_MISMATCH',
  'BACKUP_CONFLICT',
  'BACKUP_TOO_LARGE',
  'BACKUP_EMPTY',
  'BACKUP_META_INVALID',
  'BACKUP_ID_INVALID',
]);

export function classifyUploadError(status: number, code: string): UploadErrorKind {
  if (status === 0) return 'network';
  if (code === 'BACKUP_ALREADY_UPLOADED') return 'done';
  if (RESTART_CODES.has(code)) return 'restart';
  if (status >= 400 && status < 500 && PERMANENT_CODES.has(code)) return 'permanent';
  return 'retry';
}

/** Multipart devam bilgisi (`cloud_backup_uploads.parts_done` JSON). */
export interface MultipartState {
  uploadId: string;
  partSize: number;
  parts: Map<number, string>;
}

export function readMultipartState(row: {
  uploadId: string | null;
  partSize: number | null;
  partsDone: string | null;
}): MultipartState | null {
  if (!row.uploadId || !row.partSize) return null;
  const parts = new Map<number, string>();
  try {
    const value: unknown = JSON.parse(row.partsDone ?? '[]');
    if (Array.isArray(value)) {
      for (const item of value) {
        const part = item as { partNumber?: unknown; etag?: unknown };
        if (Number.isInteger(part.partNumber) && typeof part.etag === 'string' && part.etag) {
          parts.set(part.partNumber as number, part.etag);
        }
      }
    }
  } catch {
    // Bozuk kayit: parcalar yeniden yuklenir (ayni numara ustune yazilir).
  }
  return { uploadId: row.uploadId, partSize: row.partSize, parts };
}

export function partsList(state: MultipartState): Array<{ partNumber: number; etag: string }> {
  return [...state.parts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([partNumber, etag]) => ({ partNumber, etag }));
}

/** Bulutun lisansla liste yaniti; sozlesmeye uymuyorsa null. */
export function parseByLicenseResponse(data: unknown): ByLicenseResponse | null {
  const parsed = byLicenseResponseSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/**
 * Indirme adresi: bulutun verdigi goreli yol bulut adresine eklenir. Baska bir sunucuya giden
 * mutlak adres kabul edilmez.
 */
export function resolveDownloadUrl(cloudUrl: string, downloadUrl: string): string {
  const base = new URL(cloudUrl);
  const url = new URL(downloadUrl, base);
  if (url.origin !== base.origin) throw new Error('Indirme adresi bulut adresinin disinda.');
  return url.toString();
}
