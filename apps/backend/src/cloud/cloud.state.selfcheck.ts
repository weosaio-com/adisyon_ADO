// Bulut baglanti durumunun self-check'i: `ts-node src/cloud/cloud.state.selfcheck.ts`
import assert from 'node:assert';
import {
  blockedFromStatus,
  classifyCloudError,
  cloudMode,
  EMPTY_STATE,
  payloadHash,
  statusDue,
  withDefaults,
  withPendingUnpair,
} from './cloud.state';

// --- Hata siniflari ---
assert.deepStrictEqual(classifyCloudError(401, 'POS_TOKEN_SUPERSEDED'), {
  kind: 'lost',
  reason: 'superseded',
});
assert.deepStrictEqual(classifyCloudError(401, 'POS_TOKEN_ROTATED'), {
  kind: 'lost',
  reason: 'rotated',
});
assert.deepStrictEqual(classifyCloudError(401, 'BILINMEYEN'), { kind: 'lost', reason: 'invalid' });
assert.deepStrictEqual(classifyCloudError(403, 'TENANT_SUSPENDED'), {
  kind: 'blocked',
  reason: 'suspended',
});
assert.deepStrictEqual(classifyCloudError(403, 'LICENSE_EXPIRED'), {
  kind: 'blocked',
  reason: 'expired',
});
assert.deepStrictEqual(classifyCloudError(409, 'ACTIVE_ON_OTHER_INSTALL'), { kind: 'conflict' });
for (const [status, code] of [
  [0, 'CLOUD_UNREACHABLE'],
  [502, 'CLOUD_ERROR'],
  [503, 'UNAVAILABLE'],
  [429, 'TOO_MANY_ATTEMPTS'],
] as const) {
  assert.deepStrictEqual(classifyCloudError(status, code), { kind: 'network' }, code);
}
assert.deepStrictEqual(classifyCloudError(503, 'ACTIVATION_DISABLED'), { kind: 'other' });
assert.deepStrictEqual(classifyCloudError(400, 'LICENSE_INVALID'), { kind: 'other' });
assert.deepStrictEqual(classifyCloudError(403, 'FORBIDDEN'), { kind: 'other' });

// --- Kart durumu ---
const license = { id: 'lic_test_0001', qrMenu: true, expired: false };
const mode = (input: Partial<Parameters<typeof cloudMode>[0]>) =>
  cloudMode({ configured: true, license, connected: false, state: EMPTY_STATE, ...input });
assert.strictEqual(mode({ configured: false }), 'unconfigured');
assert.strictEqual(mode({ license: null }), 'no_license');
assert.strictEqual(mode({ license: { ...license, id: null } }), 'not_licensed');
assert.strictEqual(mode({ license: { ...license, qrMenu: false } }), 'not_licensed');
assert.strictEqual(mode({ license: { ...license, expired: true } }), 'expired');
assert.strictEqual(mode({}), 'off');
const at = new Date().toISOString();
assert.strictEqual(
  mode({ state: { ...EMPTY_STATE, activationPending: { takeover: false, at } } }),
  'waiting_network',
);
assert.strictEqual(
  mode({ state: { ...EMPTY_STATE, conflict: { lastSeenAt: null, at } } }),
  'conflict',
);
assert.strictEqual(mode({ state: { ...EMPTY_STATE, lost: { reason: 'revoked', at } } }), 'lost');
assert.strictEqual(mode({ connected: true }), 'on');
// Bagliyken lisans/kart bilgisinden once bulutun karari gelir.
assert.strictEqual(mode({ connected: true, license: null }), 'on');
assert.strictEqual(
  mode({ connected: true, state: { ...EMPTY_STATE, blocked: 'suspended' } }),
  'suspended',
);
assert.strictEqual(
  mode({ connected: true, state: { ...EMPTY_STATE, blocked: 'expired' } }),
  'expired',
);

// --- Buluttan gelen durum ---
const tenant = { status: 'active', features: { 'qr.menu': true } };
assert.strictEqual(blockedFromStatus(tenant, null), null);
assert.strictEqual(blockedFromStatus({ ...tenant, status: 'suspended' }, null), 'suspended');
assert.strictEqual(blockedFromStatus(tenant, '2000-01-01T00:00:00.000Z'), 'expired');
assert.strictEqual(blockedFromStatus(tenant, '2999-01-01T00:00:00.000Z'), null);
assert.strictEqual(blockedFromStatus({ ...tenant, features: {} }, null), 'not_licensed');

// --- Durum sorgusu zamani ---
const now = new Date('2030-01-01T12:00:00Z');
assert.ok(statusDue(null, now));
assert.ok(!statusDue('2030-01-01T11:30:00Z', now));
assert.ok(statusDue('2030-01-01T10:59:59Z', now));

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
assert.strictEqual(payloadHash({ a: [1, 2] }), payloadHash({ a: [1, 2] }));
assert.notStrictEqual(payloadHash({ a: [1, 2] }), payloadHash({ a: [2, 1] }));

console.log('cloud.state.selfcheck OK');
