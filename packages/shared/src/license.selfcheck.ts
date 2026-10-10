// Lisans anahtari biciminin runnable self-check'i. Derlenmis ciktiyi (dist) sinar.
// Calistir: pnpm --filter @ado/shared test  (once tsup, sonra bu dosya)
import assert from 'node:assert';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import {
  decodeBase64Url,
  LICENSE_ID_PATTERN,
  licenseExpiresAtUtc,
  parseLicensePayload,
  splitLicenseKey,
  type LicensePayload,
} from '../dist/license.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const makeKey = (payload: unknown) => {
  const raw = Buffer.from(JSON.stringify(payload));
  return `ADO1.${raw.toString('base64url')}.${sign(null, raw, privateKey).toString('base64url')}`;
};

const good: LicensePayload = {
  id: 'lic_Deneme01',
  c: 'Deneme Lokantası',
  p: 'yearly',
  exp: '2030-01-01',
  g: 7,
  f: { 'qr.menu': true },
};

// Parcalara ayirma + imza ham payload uzerinde dogrulanir (Node ile capraz kontrol).
{
  const parts = splitLicenseKey(makeKey(good));
  assert.ok(parts, 'gecerli anahtar parcalanmali');
  assert.strictEqual(parts.signature.length, 64);
  assert.ok(verify(null, Buffer.from(parts.payloadRaw), publicKey, Buffer.from(parts.signature)));
  assert.deepStrictEqual(parseLicensePayload(parts.payloadRaw), good);
}

// Kimligi olmayan eski bicim hala okunur.
{
  const legacy = { c: 'Eski Lisans', exp: '2030-01-01' };
  const parts = splitLicenseKey(makeKey(legacy));
  assert.deepStrictEqual(parts && parseLicensePayload(parts.payloadRaw), legacy);
}

// Bicim hatalari null doner (exception yok).
for (const bad of ['', 'ADO1.x', 'ADO2.a.b', 'ADO1...', 'ADO1.a.b.c', 'ADO1.@@.AAAA', 'saçma']) {
  assert.strictEqual(splitLicenseKey(bad), null, `gecersiz bicim: ${bad}`);
}
// Kisa imza reddedilir.
assert.strictEqual(splitLicenseKey(`ADO1.${Buffer.from('{}').toString('base64url')}.AAAA`), null);

// Semaya uymayan payload'lar reddedilir.
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
for (const bad of [
  { c: '', exp: '2030-01-01' },
  { c: 'x', exp: '2030-1-1' },
  { c: 'x', exp: '2030-01-01', id: 'kisa' },
  { c: 'x', exp: '2030-01-01', id: '-baslangic-tire' },
  { c: 'x', exp: '2030-01-01', g: -1 },
  { c: 'x', exp: '2030-01-01', f: { 'qr.menu': 'evet' } },
]) {
  assert.strictEqual(parseLicensePayload(encode(bad)), null, JSON.stringify(bad));
}
assert.strictEqual(parseLicensePayload(new TextEncoder().encode('{bozuk')), null);

// base64url cozumu.
assert.deepStrictEqual(decodeBase64Url('AQID'), new Uint8Array([1, 2, 3]));
assert.deepStrictEqual(decodeBase64Url('-_8'), new Uint8Array([0xfb, 0xff]));
assert.strictEqual(decodeBase64Url('a+b/'), null, 'standart base64 karakterleri kabul edilmez');

// Lisans kimligi deseni.
assert.ok(LICENSE_ID_PATTERN.test('lic_0123456789'));
assert.ok(!LICENSE_ID_PATTERN.test('lic 0123456789'));

// Bulut bitis ani: UTC gun basi + grace.
assert.strictEqual(licenseExpiresAtUtc(good).toISOString(), '2030-01-08T00:00:00.000Z');
assert.strictEqual(
  licenseExpiresAtUtc({ exp: '2030-12-31' }).toISOString(),
  '2030-12-31T00:00:00.000Z',
);

console.log('✓ license format self-check OK');
