// Bulut yedegi saf kararlarinin self-check'i:
// `ts-node --transpile-only src/cloud-backup/cloud-backup.plan.selfcheck.ts`
import assert from 'node:assert';
import { CLOUD_BACKUP_MAX_PARTS, CLOUD_BACKUP_MIN_PART_BYTES } from '@ado/shared';
import {
  backoffSeconds,
  choosePartSize,
  classifyUploadError,
  parseByLicenseResponse,
  partsList,
  pendingBackups,
  planParts,
  readMultipartState,
  resolveDownloadUrl,
  uploadTimeoutMs,
} from './cloud-backup.plan';

// --- Geri cekilme: 1 dk, 5 dk, 15 dk, sonra 1 saat (ust sinir denetim araligi) ---
assert.deepStrictEqual(
  [0, 1, 2, 3, 4, 9].map((n) => backoffSeconds(n)),
  [0, 60, 300, 900, 3600, 3600],
);
assert.deepStrictEqual(
  [1, 2, 5].map((n) => backoffSeconds(n, 2)),
  [2, 2, 2],
  'kisa aralikta (test) bekleme araligi asmaz',
);
assert.equal(backoffSeconds(3, 600), 600);
assert.equal(uploadTimeoutMs(0), 60_000);
assert.equal(uploadTimeoutMs(95_000_000), 155_000, '95 MB: 60 sn + 95 sn');

// --- Parca plani: esit parcalar, son parca kalan ---
const MIB = 1024 * 1024;
assert.deepStrictEqual(planParts(5 * MIB + 1024, 5 * MIB), [
  { partNumber: 1, offset: 0, length: 5 * MIB },
  { partNumber: 2, offset: 5 * MIB, length: 1024 },
]);
assert.deepStrictEqual(planParts(100, 8 * MIB), [{ partNumber: 1, offset: 0, length: 100 }]);
const exact = planParts(16 * MIB, 8 * MIB);
assert.equal(exact.length, 2, 'tam bolunende bos son parca yok');
assert.equal(exact[1]!.length, 8 * MIB);
assert.throws(() => planParts(0, 8 * MIB), /boyu/);
assert.throws(() => planParts(10, 0), /parca/);
assert.equal(choosePartSize(10 * MIB, 8 * MIB), 8 * MIB);
assert.equal(choosePartSize(10 * MIB, 1), CLOUD_BACKUP_MIN_PART_BYTES, 'en az 5 MiB');
const huge = 200 * 1024 * MIB; // 200 GB
const hugePart = choosePartSize(huge, 8 * MIB);
assert.ok(planParts(huge, hugePart).length <= CLOUD_BACKUP_MAX_PARTS, 'parca siniri asilmaz');

// --- Yukleme sirasi ---
const now = new Date('2026-10-14T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const backups = [
  { id: 'b-new', type: 'manual', createdAt: hoursAgo(1) },
  { id: 'b-imported', type: 'imported', createdAt: hoursAgo(0.5) },
  { id: 'b-deleted', type: 'auto', createdAt: hoursAgo(0.2), deletedAt: hoursAgo(0.1) },
  { id: 'b-done', type: 'auto', createdAt: hoursAgo(2) },
  { id: 'b-failed', type: 'auto', createdAt: hoursAgo(3) },
  { id: 'b-old', type: 'pre_update', createdAt: hoursAgo(30) },
  { id: 'b-resume', type: 'auto', createdAt: hoursAgo(50) },
];
const uploads = [
  { backupId: 'b-done', status: 'done' },
  { backupId: 'b-failed', status: 'failed' },
  { backupId: 'b-resume', status: 'pending', uploadId: 'up-1' },
  { backupId: 'b-old', status: 'pending', uploadId: null },
];
assert.deepStrictEqual(
  pendingBackups(backups, uploads, now).map((b) => b.id),
  ['b-resume', 'b-new', 'b-old'],
  'once yarim multipart, sonra en yeni; imported/silinmis/done/failed yok',
);
assert.deepStrictEqual(pendingBackups([], [], now), []);

// Saklama kurali: en yeni 30 + son 12 ayin en yenisi disindaki eski yedek yuklenmez.
const daily = Array.from({ length: 40 }, (_, d) => ({
  id: `gun-${d}`,
  type: 'auto',
  createdAt: new Date(Date.UTC(2026, 9, 14 - d, 6)),
}));
const monthly = { id: 'ay-2026-03', type: 'auto', createdAt: new Date(Date.UTC(2026, 2, 10)) };
const ancient = { id: 'eski-2024', type: 'auto', createdAt: new Date(Date.UTC(2024, 0, 10)) };
const queue = pendingBackups([...daily, monthly, ancient], [], now).map((b) => b.id);
assert.equal(queue[0], 'gun-0', 'en yeni once');
assert.ok(queue.includes('gun-29') && !queue.includes('gun-30'), 'en yeni 30 (Eylul zaten var)');
assert.ok(queue.includes('ay-2026-03'), 'son 12 ayin en yenisi');
assert.ok(!queue.includes('eski-2024'), '12 aydan eski yedek yuklenmez');
assert.equal(queue.length, 31);

// --- Hata sinifi ---
assert.equal(classifyUploadError(0, 'CLOUD_UNREACHABLE'), 'network');
assert.equal(classifyUploadError(409, 'BACKUP_ALREADY_UPLOADED'), 'done');
assert.equal(classifyUploadError(404, 'UPLOAD_NOT_FOUND'), 'restart');
assert.equal(classifyUploadError(409, 'UPLOAD_ID_MISMATCH'), 'restart');
assert.equal(classifyUploadError(400, 'BACKUP_CHECKSUM_MISMATCH'), 'permanent');
assert.equal(classifyUploadError(409, 'BACKUP_CONFLICT'), 'permanent');
assert.equal(classifyUploadError(413, 'BACKUP_QUOTA_EXCEEDED'), 'retry', 'kota: sonra yeniden');
assert.equal(classifyUploadError(403, 'TENANT_SUSPENDED'), 'retry');
assert.equal(classifyUploadError(503, 'BACKUPS_DISABLED'), 'retry');
assert.equal(classifyUploadError(404, 'NOT_FOUND'), 'retry', 'eski bulut surumu: vazgecilmez');
assert.equal(classifyUploadError(500, 'BACKUP_CHECKSUM_MISMATCH'), 'retry');

// --- Multipart devam bilgisi ---
assert.equal(readMultipartState({ uploadId: null, partSize: null, partsDone: null }), null);
const state = readMultipartState({
  uploadId: 'up-9',
  partSize: 5 * MIB,
  partsDone: JSON.stringify([
    { partNumber: 2, etag: 'e2' },
    { partNumber: 1, etag: 'e1' },
    { partNumber: 'x', etag: 'bozuk' },
  ]),
});
assert.ok(state);
assert.deepStrictEqual(partsList(state), [
  { partNumber: 1, etag: 'e1' },
  { partNumber: 2, etag: 'e2' },
]);
assert.equal(
  readMultipartState({ uploadId: 'up', partSize: 5 * MIB, partsDone: '{bozuk' })?.parts.size,
  0,
  'bozuk JSON: parcalar yeniden yuklenir',
);

// --- Lisansla liste yaniti ---
const item = {
  id: 'cb-1',
  posBackupId: '01JABCDEFGHJKMNPQRSTVWXYZ0',
  type: 'auto',
  format: 2,
  sizeBytes: 2048,
  sha256: 'c'.repeat(64),
  createdAt: '2026-10-14T06:00:00.000Z',
  uploadedAt: '2026-10-14T06:01:00.000Z',
  downloadUrl: '/api/pos/backups/download/jeton',
  expiresAt: '2026-10-14T06:16:00.000Z',
};
assert.deepStrictEqual(parseByLicenseResponse({ backups: [item] })?.backups[0], item);
assert.equal(parseByLicenseResponse({ backups: [{ ...item, sha256: 'kisa' }] }), null);
assert.equal(parseByLicenseResponse({ backups: [{ ...item, type: 'imported' }] }), null);
assert.equal(parseByLicenseResponse(null), null);

assert.equal(
  resolveDownloadUrl('https://bulut.example', item.downloadUrl),
  'https://bulut.example/api/pos/backups/download/jeton',
);
assert.equal(
  resolveDownloadUrl('http://127.0.0.1:4297', 'http://127.0.0.1:4297/api/x'),
  'http://127.0.0.1:4297/api/x',
);
assert.throws(() => resolveDownloadUrl('https://bulut.example', 'https://kotu.example/x'));
assert.throws(() => resolveDownloadUrl('https://bulut.example', '//kotu.example/x'));

console.log('✓ cloud-backup.plan self-check OK');
