// Bulut baglanti ve QR menu durumunun self-check'i: `ts-node src/cloud/cloud.state.selfcheck.ts`
import assert from 'node:assert';
import { heartbeatRequestSchema } from '@ado/shared';
import {
  autoLinkAllowed,
  blockedFromStatus,
  classifyCloudError,
  connectionInfo,
  EMPTY_STATE,
  heartbeatBody,
  linkMode,
  payloadHash,
  qrMode,
  remoteFromInfo,
  statusDue,
  withDefaults,
  withPendingUnpair,
  type CloudState,
} from './cloud.state';

const at = new Date().toISOString();
const state = (patch: Partial<CloudState>): CloudState => ({ ...EMPTY_STATE, ...patch });

// --- Hata siniflari ---
assert.deepStrictEqual(classifyCloudError(401, 'POS_TOKEN_SUPERSEDED'), {
  kind: 'lost',
  reason: 'superseded',
});
assert.deepStrictEqual(classifyCloudError(401, 'POS_TOKEN_ROTATED'), {
  kind: 'lost',
  reason: 'rotated',
});
assert.deepStrictEqual(classifyCloudError(401, 'POS_TOKEN_REVOKED'), {
  kind: 'lost',
  reason: 'revoked',
});
assert.deepStrictEqual(classifyCloudError(401, 'BILINMEYEN'), { kind: 'lost', reason: 'invalid' });
for (const [code, reason] of [
  ['TENANT_SUSPENDED', 'suspended'],
  ['LICENSE_EXPIRED', 'expired'],
  ['QR_MENU_NOT_LICENSED', 'not_licensed'],
  ['LICENSE_REVOKED', 'revoked'],
] as const) {
  assert.deepStrictEqual(classifyCloudError(403, code), { kind: 'blocked', reason }, code);
}
assert.deepStrictEqual(classifyCloudError(409, 'ACTIVE_ON_OTHER_INSTALL'), { kind: 'conflict' });
// Ayni anda iki baglanma denemesi gecicidir.
assert.deepStrictEqual(classifyCloudError(409, 'ACTIVATION_CONFLICT'), { kind: 'network' });
for (const [status, code] of [
  [0, 'CLOUD_UNREACHABLE'],
  [502, 'CLOUD_ERROR'],
  [503, 'UNAVAILABLE'],
  [429, 'TOO_MANY_ATTEMPTS'],
] as const) {
  assert.deepStrictEqual(classifyCloudError(status, code), { kind: 'network' }, code);
}
// Bulutta uc yok (eski Worker): heartbeat /status'a, kapatma masa listesine duser.
assert.deepStrictEqual(classifyCloudError(404, 'NOT_FOUND'), { kind: 'unsupported' });
assert.deepStrictEqual(classifyCloudError(503, 'ACTIVATION_DISABLED'), { kind: 'other' });
assert.deepStrictEqual(classifyCloudError(400, 'LICENSE_INVALID'), { kind: 'other' });
assert.deepStrictEqual(classifyCloudError(409, 'LICENSE_ID_MISMATCH'), { kind: 'other' });
assert.deepStrictEqual(classifyCloudError(403, 'FORBIDDEN'), { kind: 'other' });

// --- Baglanti durumu (lisans karti) ---
const license = { id: 'lic_test_0001' };
const link = (input: Partial<Parameters<typeof linkMode>[0]>) =>
  linkMode({ configured: true, license, connected: false, state: EMPTY_STATE, ...input });
assert.strictEqual(link({ configured: false }), 'unconfigured');
assert.strictEqual(link({ configured: false, connected: true }), 'unconfigured');
assert.strictEqual(link({ license: null }), 'no_license');
assert.strictEqual(link({ license: { id: null } }), 'legacy_license');
assert.strictEqual(link({}), 'linking');
assert.strictEqual(
  link({ state: state({ activationPending: { takeover: false, at } }) }),
  'waiting_network',
);
assert.strictEqual(link({ state: state({ conflict: { lastSeenAt: null, at } }) }), 'conflict');
// Devralinan baglanti: kendiliginden geri alinmaz, "Bu bilgisayara al" istenir.
assert.strictEqual(
  link({
    state: state({ lost: { reason: 'superseded', at }, conflict: { lastSeenAt: null, at } }),
  }),
  'conflict',
);
assert.strictEqual(link({ state: state({ lost: { reason: 'revoked', at } }) }), 'lost');
// Yenilenen/kapatilan/gecersiz baglanti kendiliginden yeniden kurulur.
for (const reason of ['rotated', 'unpaired', 'invalid'] as const) {
  assert.strictEqual(link({ state: state({ lost: { reason, at } }) }), 'linking', reason);
}
const linkError = (code: string) => state({ linkError: { code, message: 'x', at } });
assert.strictEqual(link({ state: linkError('LICENSE_REVOKED') }), 'revoked');
assert.strictEqual(link({ state: linkError('TENANT_SUSPENDED') }), 'suspended');
assert.strictEqual(link({ state: linkError('LICENSE_INVALID') }), 'error');
assert.strictEqual(link({ connected: true }), 'linked');
// Bagliyken lisans bilgisinden once bulutun karari gelir.
assert.strictEqual(link({ connected: true, license: null }), 'linked');
for (const remote of ['revoked', 'suspended', 'expired'] as const) {
  assert.strictEqual(link({ connected: true, state: state({ remoteState: remote }) }), remote);
  assert.strictEqual(link({ connected: true, state: state({ blocked: remote }) }), remote);
}
assert.strictEqual(
  link({ connected: true, state: state({ remoteState: 'suspended', blocked: 'revoked' }) }),
  'revoked',
);
// QR menu hakki olmamasi baglantiyi etkilemez.
assert.strictEqual(link({ connected: true, state: state({ blocked: 'not_licensed' }) }), 'linked');

// --- Kendiliginden baglanma ---
const now = new Date('2030-01-01T12:00:00Z');
assert.ok(autoLinkAllowed(EMPTY_STATE, now));
assert.ok(autoLinkAllowed(state({ activationPending: { takeover: false, at } }), now));
assert.ok(!autoLinkAllowed(state({ conflict: { lastSeenAt: null, at } }), now));
assert.ok(!autoLinkAllowed(state({ lost: { reason: 'superseded', at } }), now));
assert.ok(!autoLinkAllowed(state({ lost: { reason: 'revoked', at } }), now));
assert.ok(autoLinkAllowed(state({ lost: { reason: 'rotated', at } }), now));
assert.ok(autoLinkAllowed(state({ lost: { reason: 'invalid', at } }), now));
// Bulutun reddi: heartbeat araliginda bir yeniden denenir.
const refused = (when: string) =>
  state({ linkError: { code: 'LICENSE_REVOKED', message: 'x', at: when } });
assert.ok(!autoLinkAllowed(refused('2030-01-01T11:30:00Z'), now, 3600));
assert.ok(autoLinkAllowed(refused('2030-01-01T10:59:00Z'), now, 3600));
assert.ok(autoLinkAllowed(refused('2030-01-01T11:59:00Z'), now, 30));

// --- QR menu karti ---
const qrLicense = { id: 'lic_test_0001', qrMenu: true };
const qr = (input: Partial<Parameters<typeof qrMode>[0]>) =>
  qrMode({ qrPublish: false, license: qrLicense, connected: true, state: EMPTY_STATE, ...input });
assert.strictEqual(qr({}), 'off');
assert.strictEqual(qr({ qrPublish: true }), 'on');
// Bagli degilken de acik kalir (baglaninca yayinlanir).
assert.strictEqual(qr({ qrPublish: true, connected: false }), 'on');
assert.strictEqual(qr({ license: null }), 'not_licensed');
assert.strictEqual(qr({ license: { id: null, qrMenu: true } }), 'not_licensed');
assert.strictEqual(
  qr({ qrPublish: true, license: { ...qrLicense, qrMenu: false } }),
  'not_licensed',
);
assert.strictEqual(
  qr({ qrPublish: true, state: state({ blocked: 'not_licensed' }) }),
  'not_licensed',
);
assert.strictEqual(qr({ qrPublish: true, state: state({ blocked: 'suspended' }) }), 'on');

// --- Buluttan gelen durum ---
const tenant = { status: 'active', features: { 'qr.menu': true } };
assert.strictEqual(blockedFromStatus(tenant, null), null);
assert.strictEqual(blockedFromStatus({ ...tenant, status: 'suspended' }, null), 'suspended');
assert.strictEqual(blockedFromStatus(tenant, '2000-01-01T00:00:00.000Z'), 'expired');
assert.strictEqual(blockedFromStatus(tenant, '2999-01-01T00:00:00.000Z'), null);
assert.strictEqual(blockedFromStatus({ ...tenant, features: {} }, null), 'not_licensed');
assert.strictEqual(blockedFromStatus(tenant, null, 'revoked'), 'revoked');
assert.strictEqual(
  blockedFromStatus({ ...tenant, status: 'suspended' }, null, 'revoked'),
  'revoked',
);
assert.strictEqual(remoteFromInfo(tenant, null), 'active');
assert.strictEqual(remoteFromInfo({ status: 'suspended' }, null), 'suspended');
assert.strictEqual(remoteFromInfo(tenant, '2000-01-01T00:00:00.000Z'), 'expired');

// --- Zamanlama ---
assert.ok(statusDue(null, now));
assert.ok(!statusDue('2030-01-01T11:30:00Z', now));
assert.ok(statusDue('2030-01-01T10:59:59Z', now));
assert.ok(statusDue('2030-01-01T11:59:58Z', now, 1));

// --- Bekleyen kapatmalar ---
const a = { url: 'https://a.example', token: 'tok-a' };
const b = { url: 'https://b.example', token: 'tok-b' };
assert.deepStrictEqual(withPendingUnpair([], a), [a]);
assert.deepStrictEqual(withPendingUnpair([a], b), [a, b]);
assert.deepStrictEqual(withPendingUnpair([a, b], { ...a }), [b, a]);
assert.deepStrictEqual(EMPTY_STATE.pendingUnpairs, []);

// --- Eski kayit ve ozet ---
assert.deepStrictEqual(withDefaults({ lastMenuVersion: 3 }), {
  ...EMPTY_STATE,
  lastMenuVersion: 3,
});
assert.deepStrictEqual(withDefaults(null), EMPTY_STATE);
// 0.3.0 kaydi: bilinmeyen alan atilir, bekleyen acma (artik "baglan") korunur.
const legacy = withDefaults({
  lastStatusAt: at,
  activationPending: { takeover: true, at },
} as Partial<CloudState>);
assert.ok(!('lastStatusAt' in legacy));
assert.deepStrictEqual(legacy.activationPending, { takeover: true, at });
assert.strictEqual(payloadHash({ a: [1, 2] }), payloadHash({ a: [1, 2] }));
assert.notStrictEqual(payloadHash({ a: [1, 2] }), payloadHash({ a: [2, 1] }));

// --- Heartbeat govdesi ---
const beat = heartbeatBody({
  appVersion: '0.4.0',
  dbBytes: 1234.6,
  backupsBytes: BigInt(5000),
  freeDiskBytes: -5,
  lastBackupAt: new Date('2026-10-14T06:00:00.000Z'),
  lastCloudBackupAt: 'dun',
  licenseId: 'lic_test_0001',
  licenseExp: '2027-01-01',
});
assert.deepStrictEqual(beat, {
  appVersion: '0.4.0',
  dbBytes: 1235,
  backupsBytes: 5000,
  freeDiskBytes: null,
  lastBackupAt: '2026-10-14T06:00:00.000Z',
  lastCloudBackupAt: null,
  licenseId: 'lic_test_0001',
  licenseExp: '2027-01-01',
});
assert.ok(heartbeatRequestSchema.safeParse(beat).success, 'temizlenmis govde sozlesmeye uyar');
// Bos surum (gelistirme) ve eksik alanlar null gider: alan atlanmaz.
const empty = heartbeatBody({ appVersion: '' });
assert.strictEqual(empty.appVersion, null);
assert.strictEqual(empty.licenseExp, null);
assert.ok(heartbeatRequestSchema.safeParse(empty).success);
// Saglayicilarin (yedek, bulut yedegi) degerleri oldugu gibi gider.
const metricsBeat = heartbeatBody({
  dbBytes: 2048,
  lastBackupAt: '2026-10-17T03:00:00.000Z',
  lastCloudBackupAt: '2026-10-17T03:05:00.000Z',
});
assert.strictEqual(metricsBeat.dbBytes, 2048);
assert.strictEqual(metricsBeat.lastBackupAt, '2026-10-17T03:00:00.000Z');
assert.strictEqual(metricsBeat.lastCloudBackupAt, '2026-10-17T03:05:00.000Z');

// --- Baglanti kaydi: bulutun ozellik haritasi oldugu gibi kalir (bulut yedegi cloud.backup'a bakar) ---
const info = {
  branch: { id: 'b1', name: 'Şube' },
  tenant: {
    name: 'İşletme',
    status: 'active' as const,
    plan: 'menu',
    planLabel: 'QR Menü',
    features: { 'qr.menu': true, 'cloud.backup': false, 'gelecek.ozellik': true },
  },
  license: { id: 'lic_test_0001', expiresAt: '2099-01-15T00:00:00.000Z' },
};
assert.deepStrictEqual(connectionInfo(info), {
  branchId: 'b1',
  branchName: 'Şube',
  tenantName: 'İşletme',
  tenantStatus: 'active',
  planLabel: 'QR Menü',
  features: { 'qr.menu': true, 'cloud.backup': false, 'gelecek.ozellik': true },
  licenseExpiresAt: '2099-01-15T00:00:00.000Z',
});
assert.strictEqual(connectionInfo({ ...info, license: null }).licenseExpiresAt, null);

console.log('cloud.state.selfcheck OK');
