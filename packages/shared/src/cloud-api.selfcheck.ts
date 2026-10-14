// POS <-> bulut sozlesmesinin runnable self-check'i. Derlenmis ciktiyi (dist) sinar.
// Calistir: pnpm --filter @ado/shared test  (once tsup, sonra bu dosya)
import assert from 'node:assert';
import {
  byLicenseRequestSchema,
  CLOUD_BACKUP_MIN_PART_BYTES,
  CLOUD_BACKUP_SINGLE_MAX_BYTES,
  cloudBackupMetaSchema,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  multipartCreateRequestSchema,
} from '../dist/cloud-api.js';
import { CLOUD_BACKUP_FEATURE, isCloudBackupEnabled } from '../dist/license.js';

// Bulut yedegi varsayilan acik: yalniz acik `false` kapatir.
assert.equal(CLOUD_BACKUP_FEATURE, 'cloud.backup');
assert.equal(isCloudBackupEnabled(undefined), true);
assert.equal(isCloudBackupEnabled({}), true);
assert.equal(isCloudBackupEnabled({ 'qr.menu': true }), true);
assert.equal(isCloudBackupEnabled({ 'cloud.backup': false }), false);

// Heartbeat istegi: bilinmeyen degerler null, alan atlanmaz.
const beat = {
  appVersion: '0.4.0',
  dbBytes: 12_345_678,
  backupsBytes: null,
  freeDiskBytes: 50_000_000_000,
  lastBackupAt: '2026-10-14T06:00:01.000Z',
  lastCloudBackupAt: null,
  licenseId: 'lic_UN4zZ1ntzCjB',
  licenseExp: '2027-10-11',
};
assert.ok(heartbeatRequestSchema.safeParse(beat).success, 'gecerli heartbeat');
assert.ok(!heartbeatRequestSchema.safeParse({ ...beat, dbBytes: -1 }).success, 'eksi bayt');
assert.ok(!heartbeatRequestSchema.safeParse({ ...beat, licenseExp: '2027-1-1' }).success, 'tarih');
const { lastCloudBackupAt: _omitted, ...missing } = beat;
assert.ok(!heartbeatRequestSchema.safeParse(missing).success, 'alan atlanamaz (null gonderilir)');

const reply = {
  branch: { id: 'b1', name: 'Deneme Lokantası' },
  tenant: {
    name: 'Deneme Lokantası',
    status: 'active',
    plan: 'menu',
    planLabel: 'QR Menü',
    features: { 'qr.menu': true },
  },
  license: { id: 'lic_UN4zZ1ntzCjB', expiresAt: '2027-10-11T00:00:00.000Z' },
  remote: { state: 'active' },
  serverTime: '2026-10-14T06:00:02.000Z',
  menu: null,
};
assert.ok(heartbeatResponseSchema.safeParse(reply).success, 'gecerli heartbeat yaniti');
assert.ok(
  !heartbeatResponseSchema.safeParse({ ...reply, remote: { state: 'deleted' } }).success,
  'bilinmeyen uzak durum',
);

// Bulut yedegi meta verisi ve multipart.
const meta = {
  id: 'cb_1',
  posBackupId: '01JABCDEF',
  type: 'auto',
  format: 2,
  sizeBytes: 1024,
  sha256: 'a'.repeat(64),
  createdAt: '2026-10-14T06:00:01.000Z',
  uploadedAt: null,
};
assert.ok(cloudBackupMetaSchema.safeParse(meta).success, 'gecerli yedek meta');
assert.ok(!cloudBackupMetaSchema.safeParse({ ...meta, type: 'imported' }).success, 'imported yok');
assert.ok(!cloudBackupMetaSchema.safeParse({ ...meta, format: 3 }).success, 'bilinmeyen bicim');
assert.ok(CLOUD_BACKUP_MIN_PART_BYTES < CLOUD_BACKUP_SINGLE_MAX_BYTES);
assert.ok(CLOUD_BACKUP_SINGLE_MAX_BYTES < 100 * 1000 * 1000, 'Workers istek sinirinin altinda');
const create = { ...meta, partSize: CLOUD_BACKUP_MIN_PART_BYTES };
assert.ok(multipartCreateRequestSchema.safeParse(create).success, 'multipart baslat');
assert.ok(
  !multipartCreateRequestSchema.safeParse({ ...create, partSize: CLOUD_BACKUP_MIN_PART_BYTES - 1 })
    .success,
  'R2 parca alt siniri',
);
assert.ok(
  !byLicenseRequestSchema.safeParse({ licenseKey: 'x'.repeat(30), installId: 'a' }).success,
  'kurulum kimligi deseni',
);

console.log('✓ cloud-api self-check OK');
