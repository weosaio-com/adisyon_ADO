// Masaustu kabugunun Electron'suz yardimcilari icin self-check: `node selfcheck.mjs`
import assert from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotatingLog } from './rotating-log.mjs';
import { applyPendingRestore, ensureSecrets } from './restore.mjs';
import {
  appConfigEnv,
  cloudOrigin,
  isEd25519PublicKey,
  loadAppConfig,
  validateAppConfig,
} from './app-config.mjs';

const tempDir = (prefix) => mkdtempSync(join(tmpdir(), prefix));

// --- rotatingLog: sinir asilinca .1'e doner ---
{
  const dir = tempDir('ado-log-');
  const path = join(dir, 'backend.log');
  const write = rotatingLog(path, 100);
  write(Buffer.from('a'.repeat(60)));
  write(Buffer.from('b'.repeat(60))); // 120 > 100 -> doner
  write(Buffer.from('c'.repeat(30))); // 90 <= 100 -> ayni dosya
  await write.close();
  assert.strictEqual(readFileSync(`${path}.1`, 'utf8'), 'a'.repeat(60), 'eski kisim .1de');
  assert.strictEqual(readFileSync(path, 'utf8'), 'b'.repeat(60) + 'c'.repeat(30), 'yeni kisim');
  rmSync(dir, { recursive: true, force: true });
}

// --- rotatingLog: eski surumden kalan dev log acilista kirpilir ---
{
  const dir = tempDir('ado-log-');
  const path = join(dir, 'backend.log');
  writeFileSync(path, 'x'.repeat(500) + 'SON-KAYIT');
  const write = rotatingLog(path, 100);
  await write.close();
  const tail = readFileSync(`${path}.1`, 'utf8');
  assert.strictEqual(tail.length, 100, 'yalniz son maxBytes tutulur');
  assert.ok(tail.endsWith('SON-KAYIT'), 'en yeni kayitlar korunur');
  assert.ok(!existsSync(path) || readFileSync(path).length === 0, 'dev dosya silinir');
  rmSync(dir, { recursive: true, force: true });
}

// --- ensureSecrets: eksikler uretilir, mevcutlar korunur ---
{
  const dir = tempDir('ado-secrets-');
  const path = join(dir, 'secrets.json');
  const first = ensureSecrets(path);
  for (const name of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'BACKUP_ENCRYPTION_KEY']) {
    assert.match(first[name], /^[0-9a-f]{64}$/, `${name} uretilmeli`);
  }
  assert.deepStrictEqual(ensureSecrets(path), first, 'ikinci cagri ayni anahtarlar');
  writeFileSync(path, JSON.stringify({ BACKUP_ENCRYPTION_KEY: 'tasinan-anahtar-0123456789' }));
  const partial = ensureSecrets(path);
  assert.strictEqual(partial.BACKUP_ENCRYPTION_KEY, 'tasinan-anahtar-0123456789', 'korunur');
  assert.ok(partial.JWT_ACCESS_SECRET && partial.JWT_REFRESH_SECRET, 'eksik JWT uretilir');
  rmSync(dir, { recursive: true, force: true });
}

// --- applyPendingRestore: takas + anahtar tasima + temizlik ---
const restoreFixture = (marker) => {
  const dir = tempDir('ado-restore-');
  mkdirSync(join(dir, 'backups'));
  const dbPath = join(dir, 'ado.db');
  const secretsPath = join(dir, 'secrets.json');
  const stagePath = join(dir, 'backups', 'restore_staging_x.db');
  writeFileSync(dbPath, 'ESKI-DB');
  writeFileSync(stagePath, 'YEDEK-DB');
  writeFileSync(
    secretsPath,
    JSON.stringify({ JWT_ACCESS_SECRET: 'j1', BACKUP_ENCRYPTION_KEY: 'eski' }),
  );
  writeFileSync(join(dir, 'restore-pending.json'), JSON.stringify({ stagePath, ...marker }));
  return { dir, dbPath, secretsPath, stagePath };
};
{
  const f = restoreFixture({ backupKey: 'aaaa'.repeat(16) });
  assert.strictEqual(applyPendingRestore(f.dir, f.dbPath, f.secretsPath), true, 'takas yapildi');
  assert.strictEqual(readFileSync(f.dbPath, 'utf8'), 'YEDEK-DB', 'canli DB yedekten');
  const rollback = readdirSync(f.dir).find((n) => n.startsWith('ado.pre-restore-'));
  assert.ok(rollback, 'eski DB geri donus icin saklanir');
  assert.strictEqual(readFileSync(join(f.dir, rollback), 'utf8'), 'ESKI-DB');
  assert.ok(!existsSync(join(f.dir, 'restore-pending.json')), 'isaret silinir');
  assert.ok(!existsSync(f.stagePath), 'staging silinir');
  const secrets = JSON.parse(readFileSync(f.secretsPath, 'utf8'));
  assert.strictEqual(secrets.BACKUP_ENCRYPTION_KEY, 'aaaa'.repeat(16), 'yedek anahtari tasinir');
  assert.strictEqual(secrets.JWT_ACCESS_SECRET, 'j1', 'diger anahtarlar korunur');
  assert.strictEqual(applyPendingRestore(f.dir, f.dbPath, f.secretsPath), false, 'isaret yok');
  rmSync(f.dir, { recursive: true, force: true });
}
{
  // Ayni kurulumun yedegi: anahtar degismez.
  const f = restoreFixture({});
  applyPendingRestore(f.dir, f.dbPath, f.secretsPath);
  assert.strictEqual(JSON.parse(readFileSync(f.secretsPath, 'utf8')).BACKUP_ENCRYPTION_KEY, 'eski');
  rmSync(f.dir, { recursive: true, force: true });
}
{
  // Veri dizini disini gosteren staging reddedilir, DB'ye dokunulmaz.
  const f = restoreFixture({ backupKey: 'bbbb'.repeat(16) });
  const outside = join(tempDir('ado-outside-'), 'evil.db');
  writeFileSync(outside, 'KOTU');
  writeFileSync(join(f.dir, 'restore-pending.json'), JSON.stringify({ stagePath: outside }));
  assert.throws(() => applyPendingRestore(f.dir, f.dbPath, f.secretsPath), /Gecersiz restore/);
  assert.strictEqual(readFileSync(f.dbPath, 'utf8'), 'ESKI-DB', 'DB degismedi');
  assert.strictEqual(JSON.parse(readFileSync(f.secretsPath, 'utf8')).BACKUP_ENCRYPTION_KEY, 'eski');
  rmSync(f.dir, { recursive: true, force: true });
}

// --- Derleme profili (app-config) ---
{
  const { publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 })
    .publicKey.export({ format: 'der', type: 'spki' })
    .toString('base64');
  assert.ok(isEd25519PublicKey(pub));
  assert.ok(!isEd25519PublicKey(rsa), 'RSA anahtari Ed25519 sayilmaz');
  assert.ok(!isEd25519PublicKey('bozuk anahtar'));

  assert.strictEqual(cloudOrigin('https://ornek.workers.dev'), 'https://ornek.workers.dev');
  assert.strictEqual(cloudOrigin('https://ornek.workers.dev/'), 'https://ornek.workers.dev');
  assert.strictEqual(cloudOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.strictEqual(cloudOrigin('http://ornek.workers.dev'), null, 'http yalniz yerelde');
  assert.strictEqual(cloudOrigin('https://ornek.workers.dev/panel'), null, 'yol olmamali');
  assert.strictEqual(cloudOrigin('adres'), null);

  const ok = validateAppConfig(
    { profile: 'prod', cloudUrl: 'https://menu.ornek.com/', licensePublicKey: pub },
    { strict: true },
  );
  assert.deepStrictEqual(ok.errors, []);
  assert.deepStrictEqual(ok.config, {
    profile: 'prod',
    cloudUrl: 'https://menu.ornek.com',
    licensePublicKey: pub,
  });
  assert.deepStrictEqual(appConfigEnv(ok.config), {
    CLOUD_API_URL: 'https://menu.ornek.com',
    ADO_LICENSE_PUBLIC_KEY: pub,
    ADO_BUILD_PROFILE: 'prod',
  });

  // Derlemede (strict) uretim profili lisans anahtari ve adres olmadan gecmez.
  assert.ok(validateAppConfig({ profile: 'prod' }, { strict: true }).errors.length >= 2);
  // Calisirken (lenient) hatali alan bos kalir, digerleri kullanilir.
  const lenient = validateAppConfig({
    profile: 'test',
    cloudUrl: 'http://x.com',
    licensePublicKey: pub,
  });
  assert.strictEqual(lenient.errors.length, 1);
  assert.deepStrictEqual(lenient.config, { profile: 'test', cloudUrl: '', licensePublicKey: pub });

  // Eksik dosya acilisi durdurmaz: her sey kapali.
  const missing = loadAppConfig(join(tempDir('ado-cfg-'), 'yok.json'));
  assert.strictEqual(missing.errors.length, 1);
  assert.deepStrictEqual(appConfigEnv(missing.config), {
    CLOUD_API_URL: '',
    ADO_LICENSE_PUBLIC_KEY: '',
    ADO_BUILD_PROFILE: '',
  });

  // Repodaki profiller: test derlenebilir olmali; uretim en azindan bicimce dogru.
  const profile = (name) =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'profiles', `${name}.json`), 'utf8'));
  assert.deepStrictEqual(validateAppConfig(profile('test'), { strict: true }).errors, []);
  assert.deepStrictEqual(validateAppConfig(profile('prod')).errors, []);
}

console.log('desktop selfcheck OK');
