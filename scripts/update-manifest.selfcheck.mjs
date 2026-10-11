// Guncelleme imza aracinin ve programdaki dogrulamanin self-check'i:
// `node scripts/update-manifest.selfcheck.mjs`
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './license.mjs';
import {
  buildManifestPayload,
  generateUpdateKeyPair,
  latestMatchesManifest,
  parseLatestYml,
  signManifest,
  UPDATE_KEY_FILE,
} from './update-manifest.mjs';
import {
  compareVersions,
  parseVersion,
  sha512File,
  updateFeedUrl,
  verifyUpdateManifest,
} from '../apps/desktop/update-manifest.mjs';

const dir = mkdtempSync(join(tmpdir(), 'ado-update-'));
const installer = join(dir, 'Adisyon-POS-Setup-0.3.1.exe');
writeFileSync(installer, randomBytes(4096));

// --- Surumler ve adres ---
assert.deepStrictEqual(parseVersion('0.3.1'), [0, 3, 1]);
for (const bad of ['0.3', '0.3.1-beta', '01.2.3', 'v1.2.3', '', null]) {
  assert.strictEqual(parseVersion(bad), null, String(bad));
}
assert.ok(compareVersions('0.3.10', '0.3.9') > 0);
assert.ok(compareVersions('0.3.1', '1.0.0') < 0);
assert.strictEqual(compareVersions('2.0.0', '2.0.0'), 0);
assert.throws(() => compareVersions('0.3', '0.3.1'));
assert.strictEqual(updateFeedUrl('https://x.dev/', 'stable'), 'https://x.dev/updates/stable');
assert.strictEqual(updateFeedUrl('https://x.dev', 'nightly'), null);
assert.strictEqual(updateFeedUrl('', 'stable'), null);

// --- Imzala ve dogrula ---
const key = generateUpdateKeyPair();
const other = generateUpdateKeyPair();
const payload = await buildManifestPayload({
  installer,
  version: '0.3.1',
  channel: 'stable',
  notes: 'Deneme surumu',
  releaseDate: '2026-10-11T12:00:00.000Z',
});
assert.strictEqual(payload.sha512, await sha512File(installer));
assert.strictEqual(payload.file, 'Adisyon-POS-Setup-0.3.1.exe');
const manifest = signManifest(payload, key.privateKeyPem);
assert.deepStrictEqual(verifyUpdateManifest(manifest, [key.publicKeyB64]), payload);
// Anahtar degisimi: listede eski ve yeni anahtar birlikte.
assert.deepStrictEqual(
  verifyUpdateManifest(manifest, [other.publicKeyB64, 'bozuk', key.publicKeyB64]),
  payload,
);
assert.strictEqual(verifyUpdateManifest(manifest, [other.publicKeyB64]), null, 'baska anahtar');
assert.strictEqual(verifyUpdateManifest('{bozuk', [key.publicKeyB64]), null);

// Icerigi degistirilen bildirim reddedilir (surum yukseltme denemesi).
const envelope = JSON.parse(manifest);
const forged = Buffer.from(JSON.stringify({ ...payload, version: '9.9.9' })).toString('base64url');
assert.strictEqual(
  verifyUpdateManifest(JSON.stringify({ ...envelope, payload: forged }), [key.publicKeyB64]),
  null,
);
// Imzali ama bicimi bozuk icerik de reddedilir.
const unsafe = signManifest({ ...payload, file: '../../evil.exe' }, key.privateKeyPem);
assert.strictEqual(verifyUpdateManifest(unsafe, [key.publicKeyB64]), null, 'dosya adi');

await assert.rejects(buildManifestPayload({ installer, version: '0.3', channel: 'stable' }));
await assert.rejects(buildManifestPayload({ installer, version: '0.3.1', channel: 'nightly' }));
await assert.rejects(
  buildManifestPayload({ installer: join(dir, 'yok.exe'), version: '0.3.1', channel: 'stable' }),
);

// --- CLI: gen-key repo icine yazmaz; sign + verify ---
const cli = (...args) =>
  execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'update-manifest.mjs'), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
assert.throws(() => cli('gen-key', '--out', join(REPO_ROOT, 'tmp-anahtar')), /repo/);
const keyDir = join(dir, 'anahtar');
const pub = /Acik anahtar \(base64 SPKI\): (\S+)/.exec(cli('gen-key', '--out', keyDir))[1];
const out = join(dir, 'ado-update.json');
cli('sign', '--key', join(keyDir, UPDATE_KEY_FILE), '--installer', installer, '--version', '0.3.1', '--channel', 'stable', '--out', out); // prettier-ignore
assert.strictEqual(JSON.parse(cli('verify', '--pub', pub, '--manifest', out, '--installer', installer)).version, '0.3.1'); // prettier-ignore
// Profildeki gibi virgullu anahtar listesi (anahtar degisimi).
const signed = JSON.parse(cli('verify', '--pub', `${other.publicKeyB64}, ${pub}`, '--manifest', out)); // prettier-ignore
assert.throws(() => cli('verify', '--pub', other.publicKeyB64, '--manifest', out));
assert.throws(() => cli('verify', '--pub', ' , ', '--manifest', out), /--pub ve --manifest/);

// --- latest.yml (electron-builder ciktisi) bildirimle ayni olmali ---
const latestYml = ({ version = '0.3.1', sha512 = signed.sha512, size = signed.size } = {}) =>
  [
    `version: ${version}`,
    'files:',
    `  - url: ${signed.file}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${signed.file}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-10-11T12:00:00.000Z'",
    '',
  ].join('\n');
assert.deepStrictEqual(parseLatestYml(latestYml()), {
  version: '0.3.1',
  files: [{ url: signed.file, sha512: signed.sha512, size: signed.size }],
});
// Tirnakli degerler ve Windows satir sonu da okunur.
const quoted = latestYml().replace('version: 0.3.1', "version: '0.3.1'").replaceAll('\n', '\r\n');
assert.ok(latestMatchesManifest(parseLatestYml(quoted), signed));
const otherSha = Buffer.alloc(64, 7).toString('base64');
for (const bad of [{ version: '0.3.2' }, { sha512: otherSha }, { size: signed.size + 1 }]) {
  assert.ok(!latestMatchesManifest(parseLatestYml(latestYml(bad)), signed), JSON.stringify(bad));
}
assert.ok(!latestMatchesManifest(parseLatestYml('version: 0.3.1\nfiles: []\n'), signed));
// Boyut yazilmamissa yalniz surum ve ozet karsilastirilir.
const withoutSize = latestYml().replace(/^ {4}size: .*\n/m, '');
assert.strictEqual(parseLatestYml(withoutSize).files[0].size, undefined);
assert.ok(latestMatchesManifest(parseLatestYml(withoutSize), signed));
const latestPath = join(dir, 'latest.yml');
writeFileSync(latestPath, latestYml());
cli('verify', '--pub', pub, '--manifest', out, '--installer', installer, '--latest', latestPath);
writeFileSync(latestPath, latestYml({ sha512: otherSha }));
assert.throws(
  () => cli('verify', '--pub', pub, '--manifest', out, '--latest', latestPath),
  /latest\.yml bildirimle/,
);
writeFileSync(installer, randomBytes(4096)); // dosya degisti
assert.throws(() => cli('verify', '--pub', pub, '--manifest', out, '--installer', installer));
assert.ok(readFileSync(out, 'utf8').includes('"format": "ADOU1"'));

rmSync(dir, { recursive: true, force: true });
console.log('✓ update-manifest self-check OK');
