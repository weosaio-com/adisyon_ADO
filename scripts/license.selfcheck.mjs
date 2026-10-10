// Satici lisans aracinin self-check'i: `node scripts/license.selfcheck.mjs`
// Araci paylasilan bicimle (packages/shared/dist/license.js) capraz kontrol eder;
// once `pnpm --filter @ado/shared build` (kok `pnpm test` bunu zaten yapar).
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPayload,
  generateLicenseKeyPair,
  isInsideRepo,
  PRIVATE_KEY_FILE,
  publicKeyFromPrivate,
  REPO_ROOT,
  signLicense,
  verifyLicense,
} from './license.mjs';

const sharedDist = join(REPO_ROOT, 'packages', 'shared', 'dist', 'license.js');
if (!existsSync(sharedDist)) {
  throw new Error('packages/shared derlenmemis: once `pnpm --filter @ado/shared build`.');
}
const shared = await import(sharedDist);

const { privateKeyPem, publicKeyB64 } = generateLicenseKeyPair();
assert.strictEqual(Buffer.from(publicKeyB64, 'base64').length, 44, 'Ed25519 SPKI 44 bayt');
assert.strictEqual(publicKeyFromPrivate(privateKeyPem), publicKeyB64);

// Imzala -> dogrula; paylasilan bicim de ayni payload'i okur.
const payload = buildPayload({
  customer: 'Deneme Lokantası',
  exp: '2030-01-01',
  plan: 'yearly',
  grace: 14,
  features: { 'qr.menu': true },
});
assert.match(payload.id, shared.LICENSE_ID_PATTERN, 'uretilen kimlik desene uymali');
const token = signLicense(payload, privateKeyPem);
assert.deepStrictEqual(verifyLicense(token, publicKeyB64), payload);
const parts = shared.splitLicenseKey(token);
assert.ok(parts, 'paylasilan bicim parcalayabilmeli');
assert.deepStrictEqual(shared.parseLicensePayload(parts.payloadRaw), payload);

// Yabanci anahtar ve kurcalama reddedilir.
const other = generateLicenseKeyPair();
assert.strictEqual(verifyLicense(token, other.publicKeyB64), null, 'yabanci anahtar');
const [tag, , sig] = token.split('.');
const tampered = Buffer.from(JSON.stringify({ ...payload, exp: '2099-01-01' })).toString(
  'base64url',
);
assert.strictEqual(verifyLicense(`${tag}.${tampered}.${sig}`, publicKeyB64), null, 'kurcalama');

// Girdi dogrulamasi.
for (const bad of [
  { customer: '', exp: '2030-01-01' },
  { customer: 'x', exp: '2030-02-30' },
  { customer: 'x', exp: '2030-01-01', id: 'kisa' },
  { customer: 'x', exp: '2030-01-01', grace: -1 },
  { customer: 'x', exp: '2030-01-01', plan: '' },
]) {
  assert.throws(() => buildPayload(bad), JSON.stringify(bad));
}

// Ozel anahtar repo icine yazilamaz.
assert.ok(isInsideRepo(REPO_ROOT));
assert.ok(isInsideRepo(join(REPO_ROOT, 'apps')));
assert.ok(!isInsideRepo(tmpdir()));

// CLI uctan uca: gen-key (0600) -> sign -> verify.
const dir = mkdtempSync(join(tmpdir(), 'ado-license-'));
try {
  const cli = (args) =>
    execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'license.mjs'), ...args], {
      encoding: 'utf8',
    });
  const genOut = cli(['gen-key', '--out', dir]);
  const keyPath = join(dir, PRIVATE_KEY_FILE);
  if (process.platform !== 'win32') {
    assert.strictEqual(statSync(keyPath).mode & 0o777, 0o600, 'ozel anahtar 0600');
  }
  const pub = /Acik anahtar \(base64 SPKI\): (\S+)/.exec(genOut)?.[1];
  assert.strictEqual(pub, publicKeyFromPrivate(readFileSync(keyPath, 'utf8')));
  assert.throws(() => cli(['gen-key', '--out', dir]), 'var olan anahtarin ustune yazmaz');
  assert.throws(() => cli(['gen-key', '--out', join(REPO_ROOT, 'tmp-key')]), 'repo icine yazmaz');

  const signed = cli([
    'sign',
    '--key',
    keyPath,
    '--customer',
    'CLI Lokanta',
    '--exp',
    '2031-06-30',
    '--id',
    'lic_cli_000001',
    '--feature',
    'qr.menu=true',
  ]).trim();
  const verified = JSON.parse(cli(['verify', '--pub', pub, '--license', signed]));
  assert.deepStrictEqual(verified, {
    id: 'lic_cli_000001',
    c: 'CLI Lokanta',
    exp: '2031-06-30',
    f: { 'qr.menu': true },
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('✓ license CLI self-check OK');
