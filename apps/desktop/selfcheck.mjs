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
import { DatabaseSync } from 'node:sqlite';
import { rotatingLog } from './rotating-log.mjs';
import { applyPendingRestore, ensureSecrets } from './restore.mjs';
import {
  appConfigEnv,
  cloudOrigin,
  isEd25519PublicKey,
  loadAppConfig,
  validateAppConfig,
} from './app-config.mjs';
import { applyMigrations, backupBeforeMigrate, pendingMigrations } from './migrations.mjs';
import { startBackendProcess, stopBackendProcess } from './backend-process.mjs';

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

// --- Veritabani guncellemesi: once kopya, sirali uygulama, hata geri alinir ---
{
  const dir = tempDir('ado-migrate-');
  const migrations = join(dir, 'migrations');
  const backups = join(dir, 'pre-migrate');
  const addMigration = (name, sql) => {
    mkdirSync(join(migrations, name), { recursive: true });
    writeFileSync(join(migrations, name, 'migration.sql'), sql);
  };
  const dbPath = join(dir, 'ado.db');
  const query = (sql) => {
    const db = new DatabaseSync(dbPath);
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };
  addMigration('20260101000000_init', 'CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);');
  mkdirSync(join(migrations, 'migration_lock.toml.d')); // migration.sql olmayan klasor atlanir

  const first = applyMigrations(dbPath, migrations, { backupDir: backups });
  assert.deepStrictEqual(first.applied, ['20260101000000_init']);
  assert.deepStrictEqual(applyMigrations(dbPath, migrations, { backupDir: backups }), {
    applied: [],
    backup: null,
  });

  addMigration('20260102000000_add', 'ALTER TABLE t ADD COLUMN y TEXT;');
  const second = applyMigrations(dbPath, migrations, { backupDir: backups });
  assert.deepStrictEqual(second.applied, ['20260102000000_add']);
  assert.ok(second.backup && existsSync(second.backup), 'guncellemeden once kopya alinir');
  const copy = new DatabaseSync(second.backup);
  assert.deepStrictEqual(
    copy
      .prepare('SELECT * FROM t')
      .all()
      .map((row) => ({ ...row })),
    [{ x: 1 }],
    'kopya guncelleme oncesi hali',
  );
  copy.close();

  // Hatali migration geri alinir, kaydedilmez; acilis hata verir.
  addMigration('20260103000000_bad', 'ALTER TABLE t ADD COLUMN z TEXT; BOZUK SQL;');
  assert.throws(() => applyMigrations(dbPath, migrations, { backupDir: backups }));
  assert.ok(!query('PRAGMA table_info(t)').some((col) => col.name === 'z'), 'yarim is geri alindi');
  const db = new DatabaseSync(dbPath);
  assert.deepStrictEqual(pendingMigrations(db, migrations), ['20260103000000_bad']);

  // Gelistirme DB'si `prisma migrate` ile kurulduysa yalniz kaydedilir, kopya alinmaz.
  db.exec('CREATE TABLE "_prisma_migrations" ("migration_name" TEXT)');
  db.prepare('INSERT INTO "_prisma_migrations" VALUES (?)').run('20260103000000_bad');
  db.close();
  const recorded = applyMigrations(dbPath, migrations, { backupDir: backups });
  assert.deepStrictEqual(recorded, { applied: ['20260103000000_bad'], backup: null });

  // En yeni 3 kopya tutulur.
  const db2 = new DatabaseSync(dbPath);
  for (const day of ['05', '06', '07', '08']) {
    backupBeforeMigrate(db2, backups, { now: new Date(`2026-11-${day}T10:00:00Z`) });
  }
  db2.close();
  assert.deepStrictEqual(readdirSync(backups).sort(), [
    'ado-20261106T100000.db',
    'ado-20261107T100000.db',
    'ado-20261108T100000.db',
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// --- Backend sureci: IPC ile duzgun kapanis, yanit vermezse zorla ---
{
  const dir = tempDir('ado-proc-');
  const script = (name, body) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };
  const start = (entry) =>
    startBackendProcess({
      execPath: process.execPath,
      entry,
      env: process.env,
      onOutput: () => {},
    });
  const polite = start(
    script(
      'polite.cjs',
      "process.on('message', (m) => { if (m && m.type === 'shutdown') setTimeout(() => process.exit(0), 20); });\nsetInterval(() => {}, 1000);\n",
    ),
  );
  assert.strictEqual(await stopBackendProcess(polite, 5000), 'graceful', 'mesajla kapanir');

  const stubborn = start(
    script('stubborn.cjs', "process.on('message', () => {});\nsetInterval(() => {}, 1000);\n"),
  );
  assert.strictEqual(await stopBackendProcess(stubborn, 300), 'killed', 'sure dolunca zorla');

  const gone = start(script('gone.cjs', 'process.exit(0);\n'));
  await new Promise((resolve) => gone.once('exit', resolve));
  assert.strictEqual(await stopBackendProcess(gone), 'exited');
  assert.strictEqual(await stopBackendProcess(null), 'exited');
  rmSync(dir, { recursive: true, force: true });
}

console.log('desktop selfcheck OK');
