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
import { applyPendingRestore, ensureSecrets, restoreSkippedDialog } from './restore.mjs';
import { spawnSync } from 'node:child_process';
import {
  appConfigEnv,
  cloudOrigin,
  isEd25519PublicKey,
  loadAppConfig,
  validateAppConfig,
} from './app-config.mjs';
import { applyMigrations, backupBeforeMigrate, pendingMigrations } from './migrations.mjs';
import { startBackendProcess, stopBackendProcess } from './backend-process.mjs';
import { createUpdater, INSTALL_FAILED_MESSAGE } from './updater.mjs';
import { generateUpdateKeyPair, signManifest } from '../../scripts/update-manifest.mjs';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

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
// Gecersiz isaret programi acilmaz hale getirmez (PLT-3): takas yapilmaz, isaret kenara alinir,
// her acilista ayni hata tekrarlanmaz, sorun bildirilir.
const asideFiles = (dir) =>
  readdirSync(dir).filter((n) => /^restore-pending\.invalid-.+\.json$/.test(n));
const invalidMarker = (f, content) => {
  const before = asideFiles(f.dir);
  writeFileSync(join(f.dir, 'restore-pending.json'), content);
  const problems = [];
  const applied = applyPendingRestore(f.dir, f.dbPath, f.secretsPath, {
    onProblem: (problem) => problems.push(problem),
  });
  assert.strictEqual(applied, false, 'takas yapilmaz');
  assert.strictEqual(readFileSync(f.dbPath, 'utf8'), 'ESKI-DB', 'DB degismedi');
  assert.strictEqual(problems.length, 1);
  assert.strictEqual(problems[0].retry, false);
  assert.ok(!existsSync(join(f.dir, 'restore-pending.json')), 'isaret yerinde kalmaz');
  const aside = asideFiles(f.dir).filter((n) => !before.includes(n));
  assert.strictEqual(
    aside.length,
    1,
    'isaret restore-pending.invalid-<zaman>.json olarak saklanir',
  );
  assert.strictEqual(problems[0].setAside, join(f.dir, aside[0]));
  assert.strictEqual(
    readFileSync(join(f.dir, aside[0]), 'utf8'),
    content,
    'icerik korunur (destek)',
  );
  // Sonraki acilis normal: isaret yok.
  assert.strictEqual(applyPendingRestore(f.dir, f.dbPath, f.secretsPath), false);
  return problems[0];
};
{
  // Veri dizini disini gosteren staging reddedilir, DB'ye ve anahtara dokunulmaz.
  const f = restoreFixture({ backupKey: 'bbbb'.repeat(16) });
  const outside = join(tempDir('ado-outside-'), 'evil.db');
  writeFileSync(outside, 'KOTU');
  const problem = invalidMarker(
    f,
    JSON.stringify({ stagePath: outside, backupKey: 'bbbb'.repeat(16) }),
  );
  assert.match(problem.reason, /Gecersiz restore/);
  assert.strictEqual(JSON.parse(readFileSync(f.secretsPath, 'utf8')).BACKUP_ENCRYPTION_KEY, 'eski');
  rmSync(f.dir, { recursive: true, force: true });
}
{
  // Yarim yazilmis isaret (elektrik kesintisi) ve silinmis staging (antivirus, elle temizlik).
  const f = restoreFixture({});
  assert.match(invalidMarker(f, '{"stagePath":"C:\\\\Us').reason, /okunamadi/);
  rmSync(f.stagePath);
  const missing = invalidMarker(f, JSON.stringify({ stagePath: f.stagePath }));
  assert.match(missing.reason, /bulunamadi/);
  rmSync(f.dir, { recursive: true, force: true });
}
{
  // Takas sirasinda hata (or. disk dolu): geri alinir, anahtar eski haline doner, isaret sonraki
  // acilis icin kalir; engel kalkinca takas yapilir.
  const f = restoreFixture({ backupKey: 'cccc'.repeat(16) });
  mkdirSync(join(f.dir, 'ado.restore-incoming.db')); // kopya yazilamaz
  const problems = [];
  const applied = applyPendingRestore(f.dir, f.dbPath, f.secretsPath, {
    onProblem: (problem) => problems.push(problem),
  });
  assert.strictEqual(applied, false);
  assert.strictEqual(problems[0]?.retry, true, 'sonraki acilista yeniden denenir');
  assert.strictEqual(readFileSync(f.dbPath, 'utf8'), 'ESKI-DB');
  assert.strictEqual(JSON.parse(readFileSync(f.secretsPath, 'utf8')).BACKUP_ENCRYPTION_KEY, 'eski');
  assert.ok(existsSync(join(f.dir, 'restore-pending.json')), 'isaret kalir');
  assert.ok(!readdirSync(f.dir).some((n) => n.startsWith('ado.pre-restore-')), 'yarim takas yok');
  rmSync(join(f.dir, 'ado.restore-incoming.db'), { recursive: true });
  assert.strictEqual(applyPendingRestore(f.dir, f.dbPath, f.secretsPath), true);
  assert.strictEqual(readFileSync(f.dbPath, 'utf8'), 'YEDEK-DB');
  assert.strictEqual(
    JSON.parse(readFileSync(f.secretsPath, 'utf8')).BACKUP_ENCRYPTION_KEY,
    'cccc'.repeat(16),
  );
  rmSync(f.dir, { recursive: true, force: true });
}
{
  // PLT-2: canli DB yarim kalmis bir yazmanin sicak gunlugunu tasiyor (zorla kapatma). Gunluk
  // yeni DB'ye uygulanmamali: geri yuklenen veri tam yedek, geri donus kopyasi tutarli olmali.
  const f = restoreFixture({});
  const fill = (path, label) => {
    rmSync(path, { force: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE sales(id INTEGER PRIMARY KEY, note TEXT)');
    const insert = db.prepare('INSERT INTO sales(note) VALUES (?)');
    db.exec('BEGIN');
    for (let i = 0; i < 2000; i++) insert.run(`${label}-${i}-${'-'.repeat(200)}`);
    db.exec('COMMIT');
    db.close();
  };
  fill(f.stagePath, 'YEDEK');
  fill(f.dbPath, 'CANLI');
  const crash =
    "const { DatabaseSync } = require('node:sqlite');" +
    `const db = new DatabaseSync(${JSON.stringify(f.dbPath)});` +
    "db.exec('PRAGMA cache_size=1'); db.exec('BEGIN');" +
    "db.exec(\"UPDATE sales SET note='YARIM-'||id\"); process.kill(process.pid, 'SIGKILL');";
  spawnSync(process.execPath, ['-e', crash]);
  assert.ok(existsSync(`${f.dbPath}-journal`), 'sicak gunluk olustu (deney gecerli)');
  const logged = [];
  assert.strictEqual(
    applyPendingRestore(f.dir, f.dbPath, f.secretsPath, { log: (line) => logged.push(line) }),
    true,
  );
  assert.ok(!existsSync(`${f.dbPath}-journal`), 'yeni DB yaninda eski gunluk kalmaz');
  const prefixes = (path) => {
    const db = new DatabaseSync(path);
    const rows = db.prepare('SELECT substr(note, 1, 5) p, count(*) c FROM sales GROUP BY p').all();
    db.close();
    return Object.fromEntries(rows.map((row) => [row.p, row.c]));
  };
  assert.deepStrictEqual(prefixes(f.dbPath), { YEDEK: 2000 }, 'geri yuklenen veri tam yedek');
  const rollback = readdirSync(f.dir).find((n) => /^ado\.pre-restore-\d+\.db$/.test(n));
  assert.deepStrictEqual(
    prefixes(join(f.dir, rollback)),
    { CANLI: 2000 },
    'geri donus kopyasi yarim islem olmadan',
  );
  assert.ok(logged.some((line) => /geri alindi/.test(line)));
  rmSync(f.dir, { recursive: true, force: true });
}
{
  // Bozuk eski DB'nin gecersiz yan dosyalarini SQLite temizler; yeni DB'nin yaninda kalmaz.
  const f = restoreFixture({});
  writeFileSync(`${f.dbPath}-journal`, 'ESKI-GUNLUK');
  writeFileSync(`${f.dbPath}-wal`, 'ESKI-WAL');
  assert.strictEqual(applyPendingRestore(f.dir, f.dbPath, f.secretsPath), true);
  assert.ok(!existsSync(`${f.dbPath}-journal`) && !existsSync(`${f.dbPath}-wal`));
  assert.strictEqual(readFileSync(f.dbPath, 'utf8'), 'YEDEK-DB');
  rmSync(f.dir, { recursive: true, force: true });
}
{
  // Eski DB hic acilamiyorsa (kilitli/okunamaz) gunluk eski DB ile birlikte tasinir, kayda yazilir.
  const f = restoreFixture({});
  rmSync(f.dbPath);
  mkdirSync(f.dbPath); // acilamayan "veritabani"
  writeFileSync(`${f.dbPath}-journal`, 'ESKI-GUNLUK');
  const logged = [];
  assert.strictEqual(
    applyPendingRestore(f.dir, f.dbPath, f.secretsPath, { log: (line) => logged.push(line) }),
    true,
  );
  assert.ok(!existsSync(`${f.dbPath}-journal`), 'yeni DB yaninda eski gunluk kalmaz');
  const rollback = readdirSync(f.dir).find((n) => /^ado\.pre-restore-\d+\.db$/.test(n));
  assert.strictEqual(readFileSync(join(f.dir, `${rollback}-journal`), 'utf8'), 'ESKI-GUNLUK');
  assert.ok(
    logged.some((line) => /uygulanamadi/.test(line)),
    'kayda yazilir',
  );
  rmSync(f.dir, { recursive: true, force: true });
}
// Kullaniciya pencere: iki durum ayri anlatilir, kayit dosyasi yolu var.
assert.match(restoreSkippedDialog({ retry: true }, 'C:/k.log').message, /bir sonraki/);
assert.match(
  restoreSkippedDialog({ retry: false }, 'C:/k.log').message,
  /yeniden\s+başlatabilirsiniz/,
);
assert.match(restoreSkippedDialog({ retry: false }, 'C:/k.log').message, /C:\/k\.log/);

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

  const pub2 = generateKeyPairSync('ed25519')
    .publicKey.export({ format: 'der', type: 'spki' })
    .toString('base64');
  const ok = validateAppConfig(
    {
      profile: 'prod',
      cloudUrl: 'https://menu.ornek.com/',
      licensePublicKey: pub,
      updatePublicKey: `${pub}, ${pub2}`,
    },
    { strict: true },
  );
  assert.deepStrictEqual(ok.errors, [], 'uretim profili: lisans ve guncelleme anahtari var');
  // Lisans politikasi profilde yoksa varsayilan: zorunlu, deneme 0, ek sure 7 gun.
  const policyDefaults = { licenseEnforce: true, trialDays: 0, graceDays: 7, supportContact: '' };
  const policyEnvDefaults = {
    ADO_LICENSE_ENFORCE: '1',
    ADO_TRIAL_DAYS: '0',
    ADO_GRACE_DAYS: '7',
    ADO_SUPPORT_CONTACT: '',
  };
  assert.deepStrictEqual(ok.config, {
    profile: 'prod',
    cloudUrl: 'https://menu.ornek.com',
    licensePublicKey: pub,
    channel: 'stable',
    updatePublicKeys: [pub, pub2],
    ...policyDefaults,
  });
  assert.deepStrictEqual(appConfigEnv(ok.config), {
    CLOUD_API_URL: 'https://menu.ornek.com',
    ADO_LICENSE_PUBLIC_KEY: pub,
    ADO_BUILD_PROFILE: 'prod',
    ...policyEnvDefaults,
  });

  // Lisans politikasi alanlari: zorunluluk, deneme/ek sure (0-90 gun), destek iletisimi.
  const policy = validateAppConfig({
    profile: 'test',
    licenseEnforce: false,
    trialDays: 14,
    graceDays: 3,
    supportContact: '  0850 000 00 00 · destek@ornek.com  ',
  });
  assert.deepStrictEqual(policy.errors, []);
  assert.deepStrictEqual(
    {
      licenseEnforce: policy.config.licenseEnforce,
      trialDays: policy.config.trialDays,
      graceDays: policy.config.graceDays,
      supportContact: policy.config.supportContact,
    },
    {
      licenseEnforce: false,
      trialDays: 14,
      graceDays: 3,
      supportContact: '0850 000 00 00 · destek@ornek.com',
    },
  );
  const policyEnv = appConfigEnv(policy.config);
  assert.strictEqual(policyEnv.ADO_LICENSE_ENFORCE, '0', 'yalniz false kapatir');
  assert.strictEqual(policyEnv.ADO_TRIAL_DAYS, '14');
  assert.strictEqual(policyEnv.ADO_GRACE_DAYS, '3');
  assert.strictEqual(policyEnv.ADO_SUPPORT_CONTACT, '0850 000 00 00 · destek@ornek.com');
  const badPolicy = validateAppConfig({
    profile: 'test',
    licenseEnforce: 'evet',
    trialDays: 91,
    graceDays: 1.5,
    supportContact: 'x'.repeat(201),
  });
  assert.strictEqual(badPolicy.errors.length, 4, 'hatali politika alanlari raporlanir');
  assert.deepStrictEqual(
    {
      licenseEnforce: badPolicy.config.licenseEnforce,
      trialDays: badPolicy.config.trialDays,
      graceDays: badPolicy.config.graceDays,
      supportContact: badPolicy.config.supportContact,
    },
    policyDefaults,
    'hatali alan varsayilanda kalir (zorunluluk acik)',
  );
  assert.strictEqual(validateAppConfig({ profile: 'test', graceDays: -1 }).errors.length, 1);
  assert.strictEqual(validateAppConfig({ profile: 'test', supportContact: 42 }).errors.length, 1);
  assert.deepStrictEqual(validateAppConfig({ profile: 'test', trialDays: 90 }).errors, []);

  // Derlemede (strict) uretim profili lisans/guncelleme anahtari ve adres olmadan gecmez.
  assert.ok(validateAppConfig({ profile: 'prod' }, { strict: true }).errors.length >= 3);
  const badUpdate = validateAppConfig({
    profile: 'test',
    channel: 'nightly',
    updatePublicKey: rsa,
  });
  assert.deepStrictEqual(badUpdate.config.channel, 'stable', 'gecersiz kanal: stable');
  assert.deepStrictEqual(
    badUpdate.config.updatePublicKeys,
    [],
    'gecersiz anahtar: guncelleme kapali',
  );
  assert.strictEqual(badUpdate.errors.length, 2);
  assert.strictEqual(
    validateAppConfig({ profile: 'test', channel: 'beta' }).config.channel,
    'beta',
  );
  // Calisirken (lenient) hatali alan bos kalir, digerleri kullanilir.
  const lenient = validateAppConfig({
    profile: 'test',
    cloudUrl: 'http://x.com',
    licensePublicKey: pub,
  });
  assert.strictEqual(lenient.errors.length, 1);
  assert.deepStrictEqual(lenient.config, {
    profile: 'test',
    cloudUrl: '',
    licensePublicKey: pub,
    channel: 'stable',
    updatePublicKeys: [],
    ...policyDefaults,
  });

  // Eksik dosya acilisi durdurmaz: bulut ve lisans anahtari bos (acik anahtar yokken zorunluluk
  // backend'de etkisizdir, kimse kilitlenmez).
  const missing = loadAppConfig(join(tempDir('ado-cfg-'), 'yok.json'));
  assert.strictEqual(missing.errors.length, 1);
  assert.deepStrictEqual(appConfigEnv(missing.config), {
    CLOUD_API_URL: '',
    ADO_LICENSE_PUBLIC_KEY: '',
    ADO_BUILD_PROFILE: '',
    ...policyEnvDefaults,
  });

  // Repodaki profiller: test derlenebilir olmali; uretim en azindan bicimce dogru.
  const profile = (name) =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'profiles', `${name}.json`), 'utf8'));
  const built = validateAppConfig(profile('test'), { strict: true });
  assert.deepStrictEqual(built.errors, []);
  assert.deepStrictEqual(validateAppConfig(profile('prod')).errors, []);
  assert.strictEqual(appConfigEnv(built.config).ADO_LICENSE_ENFORCE, '1', 'test: lisans zorunlu');
  assert.strictEqual(appConfigEnv(built.config).ADO_TRIAL_DAYS, '0', 'test: deneme yok');
  assert.strictEqual(appConfigEnv(built.config).ADO_GRACE_DAYS, '7');
  assert.strictEqual(
    appConfigEnv(validateAppConfig(profile('prod')).config).ADO_LICENSE_ENFORCE,
    '1',
    'uretim: profilde yoksa zorunlu',
  );

  // Derleme -> calisma: build-bundle dogrulanmis config'i app-config.json'a yazar, main.mjs onu
  // yeniden dogrular. Hicbir alan (guncelleme anahtarlari, lisans politikasi) yolda kaybolmamali.
  const cfgDir = tempDir('ado-cfg-');
  writeFileSync(join(cfgDir, 'app-config.json'), `${JSON.stringify(built.config, null, 2)}\n`);
  const runtime = loadAppConfig(join(cfgDir, 'app-config.json'));
  assert.deepStrictEqual(runtime.errors, []);
  assert.deepStrictEqual(runtime.config, built.config, 'paketteki config aynen okunur');
  assert.deepStrictEqual(appConfigEnv(runtime.config), appConfigEnv(built.config));
  assert.ok(runtime.config.updatePublicKeys.length > 0, 'guncelleme anahtari kaybolmaz');
  const policyRoundTrip = validateAppConfig(JSON.parse(JSON.stringify(policy.config)));
  assert.deepStrictEqual(policyRoundTrip.config, policy.config, 'politika alanlari da korunur');
  rmSync(cfgDir, { recursive: true, force: true });
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

// --- Guncelleyici: imzali bildirim, latest.yml ve indirilen dosya imzali ozetle eslesmeli ---
{
  const dir = tempDir('ado-updater-');
  const key = generateUpdateKeyPair();
  const installer = randomBytes(2048);
  const sha512 = createHash('sha512').update(installer).digest('base64');
  const file = 'Adisyon-POS-Setup-0.3.1.exe';
  const payload = {
    version: '0.3.1',
    channel: 'stable',
    file,
    sha512,
    size: installer.length,
    releaseDate: '2026-10-11T12:00:00.000Z',
    notes: 'Duzeltmeler',
  };
  const served = { manifest: signManifest(payload, key.privateKeyPem) };
  const server = createServer((req, res) => {
    if (req.url === '/updates/stable/ado-update.json' && served.manifest) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(served.manifest);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cloudUrl = `http://127.0.0.1:${server.address().port}`;

  // electron-updater sahtesi: latest.yml bilgisi, indirme ve kurulum davranisi ayarlanabilir.
  // installerPath: electron-updater'in kuracagi dosya (null: yolu kaybolmus).
  const fakeUpdater = (
    latest = { version: '0.3.1', sha512 },
    bytes = installer,
    { installerPath, onQuitAndInstall } = {},
  ) => {
    const listeners = {};
    const calls = { feed: null, installed: null, downloaded: null };
    return {
      calls,
      listeners,
      get installerPath() {
        return installerPath === undefined ? calls.downloaded : installerPath;
      },
      on: (event, fn) => (listeners[event] = fn),
      setFeedURL: (options) => (calls.feed = options),
      checkForUpdates: async () => ({
        updateInfo: { version: latest.version, files: [{ url: file, sha512: latest.sha512 }] },
      }),
      downloadUpdate: async () => {
        listeners['download-progress']?.({ percent: 50 });
        const path = join(dir, `${Math.random().toString(36).slice(2)}-${file}`);
        writeFileSync(path, bytes);
        calls.downloaded = path;
        return [path];
      },
      quitAndInstall: (...args) => {
        calls.installed = args;
        onQuitAndInstall?.(listeners);
      },
    };
  };
  const config = { cloudUrl, channel: 'stable', updatePublicKeys: [key.publicKeyB64] };
  const make = (overrides = {}) => {
    const states = [];
    const failures = [];
    const autoUpdater = overrides.autoUpdater ?? fakeUpdater();
    const updater = createUpdater({
      currentVersion: overrides.currentVersion ?? '0.3.0',
      config: { ...config, ...overrides.config },
      log: () => {},
      onStatus: (status) => states.push(status.state),
      autoUpdater,
      onInstallFailed: (reason) => failures.push(reason),
      installTimeoutMs: 30,
    });
    return { updater, autoUpdater, states, failures };
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const disabled = make({ config: { updatePublicKeys: [] } });
  assert.strictEqual((await disabled.updater.check()).state, 'disabled', 'anahtarsiz: kapali');

  const fresh = make();
  const ready = await fresh.updater.check();
  assert.strictEqual(ready.state, 'ready', ready.error ?? 'hazir olmali');
  assert.strictEqual(ready.version, '0.3.1');
  assert.deepStrictEqual(fresh.states, ['checking', 'downloading', 'downloading', 'ready']);
  assert.strictEqual(fresh.autoUpdater.calls.feed.url, `${cloudUrl}/updates/stable`);
  assert.strictEqual(fresh.autoUpdater.autoDownload, false, 'kendiliginden indirme yok');
  assert.strictEqual(fresh.autoUpdater.autoInstallOnAppQuit, false, 'kapanista kurulum yok');
  assert.strictEqual(await fresh.updater.install('0.3.2', async () => {}), false, 'baska surum');
  let prepared = false;
  assert.strictEqual(
    await fresh.updater.install('0.3.1', async () => {
      prepared = true;
    }),
    true,
  );
  assert.ok(prepared, 'kurulumdan once hazirlik (backend kapanisi) beklenir');
  assert.deepStrictEqual(fresh.autoUpdater.calls.installed, [true, true], 'sessiz kur, yeniden ac');
  assert.ok(fresh.updater.installing());
  fresh.updater.quitting(); // before-quit: program kapaniyor, zaman asimi beklenmez
  await wait(60);
  assert.deepStrictEqual(fresh.failures, [], 'kapanan kurulum basarisiz sayilmaz');

  // PLT-6: kurulum baslamazsa program "guncelleniyor"da kapali kalmaz.
  // a) electron-updater dosyanin yolunu kaybetmis: backend durdurulmadan reddedilir.
  const lost = make({ autoUpdater: fakeUpdater(undefined, installer, { installerPath: null }) });
  await lost.updater.check();
  let stopped = false;
  const stopBackend = async () => {
    stopped = true;
  };
  assert.strictEqual(await lost.updater.install('0.3.1', stopBackend), false);
  assert.strictEqual(stopped, false, 'kurulum dosyasi hazir degilse backend durdurulmaz');
  assert.match(lost.updater.status().error, /hazır değil/);
  assert.strictEqual(lost.autoUpdater.calls.installed, null);
  // b) Yarim/eksik dosya (boyut imzali bilgiden farkli): backend durdurulmaz.
  const short = make();
  await short.updater.check();
  writeFileSync(short.autoUpdater.calls.downloaded, installer.subarray(0, 1000));
  assert.strictEqual(await short.updater.install('0.3.1', stopBackend), false);
  assert.strictEqual(stopped, false);
  assert.match(short.updater.status().error, /eksik ya da değişmiş/);
  // c) quitAndInstall kurulumu baslatamadi (electron-updater 'error' olayi, program kapanmaz).
  const failing = make({
    autoUpdater: fakeUpdater(undefined, installer, {
      onQuitAndInstall: (listeners) =>
        listeners.error?.(new Error("No update filepath provided, can't quit and install")),
    }),
  });
  await failing.updater.check();
  assert.strictEqual(await failing.updater.install('0.3.1', stopBackend), false);
  assert.ok(stopped, 'backend durdurulmustu');
  assert.deepStrictEqual(failing.failures, ["No update filepath provided, can't quit and install"]);
  assert.strictEqual(failing.updater.status().state, 'error');
  assert.strictEqual(failing.updater.status().error, INSTALL_FAILED_MESSAGE);
  assert.strictEqual(failing.updater.installing(), false);
  await wait(60);
  assert.strictEqual(failing.failures.length, 1, 'tek kez bildirilir (zaman asimi iptal)');
  assert.strictEqual(
    (await failing.updater.check()).state,
    'ready',
    'yeniden indirilip denenebilir',
  );
  // d) quitAndInstall sessizce dondu, program kapanmadi: zaman asiminda basarisiz sayilir.
  const silent = make();
  await silent.updater.check();
  assert.strictEqual(await silent.updater.install('0.3.1', async () => {}), true);
  await wait(60);
  assert.deepStrictEqual(silent.failures, ['program kurulum icin kapanmadi']);
  assert.strictEqual(silent.updater.status().state, 'error');
  // e) Kurulum disindaki hata olayi kurulum basarisizligi sayilmaz.
  const idle = make();
  idle.autoUpdater.listeners.error?.(new Error('net::ERR_INTERNET_DISCONNECTED'));
  assert.deepStrictEqual(idle.failures, []);

  const current = make({ currentVersion: '0.3.1' });
  assert.strictEqual((await current.updater.check()).state, 'idle', 'ayni surum: guncel');

  const mismatch = make({
    autoUpdater: fakeUpdater({ version: '0.3.1', sha512: 'A'.repeat(86) + '==' }),
  });
  const m = await mismatch.updater.check();
  assert.strictEqual(m.state, 'error');
  assert.match(m.error, /eşleşmiyor/, 'latest.yml imzali ozetle eslesmeli');

  const corrupt = make({ autoUpdater: fakeUpdater(undefined, randomBytes(2048)) });
  const c = await corrupt.updater.check();
  assert.strictEqual(c.state, 'error');
  assert.match(c.error, /İndirilen dosya/, 'indirilen dosya imzali ozetle eslesmeli');
  assert.strictEqual(await corrupt.updater.install('0.3.1', async () => {}), false);

  // Hazir dosya diskte degisirse kurulmaz.
  const tamper = make();
  await tamper.updater.check();
  const downloaded = tamper.autoUpdater.calls.downloaded;
  writeFileSync(downloaded, randomBytes(2048));
  assert.strictEqual(await tamper.updater.install('0.3.1', async () => {}), false, 'degisen dosya');
  assert.strictEqual(tamper.updater.status().state, 'error');
  assert.strictEqual(tamper.autoUpdater.calls.installed, null);

  // Imzasi bozuk bildirim ve bildirim yok.
  const envelope = JSON.parse(served.manifest);
  served.manifest = JSON.stringify({
    ...envelope,
    signature: envelope.signature.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A')),
  });
  const forged = await make().updater.check();
  assert.strictEqual(forged.state, 'error');
  assert.match(forged.error, /imzası geçersiz/);
  served.manifest = null;
  assert.strictEqual((await make().updater.check()).state, 'idle', 'yayin yok: guncel');

  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}

console.log('desktop selfcheck OK');
