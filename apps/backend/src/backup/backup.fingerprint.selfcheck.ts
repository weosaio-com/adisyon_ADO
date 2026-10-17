// Degisiklik parmak izi self-check'i (gercek SQLite, node:sqlite):
// `ts-node --transpile-only src/backup/backup.fingerprint.selfcheck.ts`
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SettingKeys } from '../settings/setting-keys';
import {
  buildFingerprintQuery,
  FINGERPRINT_SCHEMA_SQL,
  fingerprintHash,
  isFingerprintTable,
  volatileSettingKeys,
  type FingerprintRow,
  type SchemaColumnRow,
} from './backup.fingerprint';

const SCHEMA = `
  CREATE TABLE orders (id TEXT PRIMARY KEY, total INTEGER, created_at INTEGER, updated_at INTEGER);
  CREATE TABLE audit_logs (id TEXT PRIMARY KEY, action TEXT, created_at INTEGER);
  CREATE TABLE plain (id TEXT PRIMARY KEY, x TEXT);
  CREATE TABLE application_settings (id TEXT PRIMARY KEY, key TEXT, value TEXT,
    created_at INTEGER, updated_at INTEGER);
  CREATE TABLE backups (id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER);
  CREATE TABLE background_jobs (id TEXT PRIMARY KEY, status TEXT, created_at INTEGER, updated_at INTEGER);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER);
  CREATE TABLE print_jobs (id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER);
  CREATE TABLE processed_client_ops (id TEXT PRIMARY KEY, created_at INTEGER);
  CREATE TABLE cloud_backup_uploads (id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER);
  CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY, migration_name TEXT);
  CREATE TABLE "_ado_migrations" ("name" TEXT PRIMARY KEY, "applied_at" TEXT NOT NULL);
  CREATE TABLE counters (id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT);
  CREATE TABLE "garip ""ad""" (id TEXT, updated_at INTEGER);
  CREATE INDEX orders_total_idx ON orders(total);
`;

function fingerprintOf(db: DatabaseSync): string {
  const columns = db.prepare(FINGERPRINT_SCHEMA_SQL).all() as unknown as SchemaColumnRow[];
  const query = buildFingerprintQuery(columns, volatileSettingKeys());
  const rows = query
    ? (db.prepare(query.sql).all(...query.params) as unknown as FingerprintRow[])
    : [];
  return fingerprintHash(rows);
}

const dir = mkdtempSync(join(tmpdir(), 'ado-fingerprint-'));
try {
  const db = new DatabaseSync(join(dir, 'fp.db'));
  db.exec(SCHEMA);
  let t = 1_791_960_000_000;
  const now = () => ++t;
  const run = (sql: string, ...params: Array<string | number>) => db.prepare(sql).run(...params);

  const base = fingerprintOf(db);
  assert.match(base, /^[0-9a-f]{64}$/, 'sha256 hex');
  assert.strictEqual(fingerprintOf(db), base, 'degisiklik yok -> ayni iz');

  // --- Teknik tablolar ve gecici ayarlar izi degistirmez ---
  run('INSERT INTO backups VALUES (?, ?, ?)', 'b1', now(), now());
  run('INSERT INTO background_jobs VALUES (?, ?, ?, ?)', 'j1', 'completed', now(), now());
  run('INSERT INTO sessions VALUES (?, ?, ?)', 's1', now(), now());
  run('INSERT INTO print_jobs VALUES (?, ?, ?)', 'p1', now(), now());
  run('INSERT INTO processed_client_ops VALUES (?, ?)', 'o1', now());
  run('INSERT INTO cloud_backup_uploads VALUES (?, ?, ?)', 'u1', now(), now());
  run('INSERT INTO _prisma_migrations VALUES (?, ?)', 'm1', 'x');
  run('INSERT INTO "_ado_migrations" VALUES (?, ?)', 'm1', new Date(now()).toISOString());
  for (const key of volatileSettingKeys()) {
    run('INSERT INTO application_settings VALUES (?, ?, ?, ?, ?)', key, key, '{}', now(), now());
  }
  run('UPDATE application_settings SET value = ?, updated_at = ?', '{"a":1}', now());
  assert.strictEqual(fingerprintOf(db), base, 'teknik tablolar + gecici ayarlar sayilmaz');
  assert.ok(volatileSettingKeys().includes(SettingKeys.storageLastCleanup), 'son temizlik gecici');
  assert.ok(volatileSettingKeys().includes(SettingKeys.cloudState), 'bulut durumu gecici');
  assert.ok(!volatileSettingKeys().includes(SettingKeys.backupCloudDir), 'bulut klasoru kalici');

  // --- Isletme verisi izi degistirir ---
  const steps: Array<[string, () => void]> = [
    [
      'kalici ayar',
      () =>
        run(
          'INSERT INTO application_settings VALUES (?, ?, ?, ?, ?)',
          'k1',
          SettingKeys.backupCloudDir,
          '"D:/Yedek"',
          now(),
          now(),
        ),
    ],
    [
      'kalici ayar guncelleme',
      () => run('UPDATE application_settings SET updated_at = ? WHERE id = ?', now(), 'k1'),
    ],
    ['yeni siparis', () => run('INSERT INTO orders VALUES (?, ?, ?, ?)', 'o1', 100, now(), now())],
    [
      'siparis guncelleme',
      () => run('UPDATE orders SET total = 200, updated_at = ? WHERE id = ?', now(), 'o1'),
    ],
    ['ikinci siparis', () => run('INSERT INTO orders VALUES (?, ?, ?, ?)', 'o2', 50, now(), now())],
    ['siparis silme', () => run('DELETE FROM orders WHERE id = ?', 'o1')],
    ['denetim kaydi', () => run('INSERT INTO audit_logs VALUES (?, ?, ?)', 'a1', 'x', now())],
    ['zaman sutunu olmayan tablo (sayi)', () => run('INSERT INTO plain VALUES (?, ?)', 'x1', 'y')],
    ['AUTOINCREMENT tablosu', () => run('INSERT INTO counters (x) VALUES (?)', 'c')],
    ['tirnakli tablo adi', () => run('INSERT INTO "garip ""ad""" VALUES (?, ?)', 'g1', now())],
    [
      'metin zaman damgasi (karisik tur)',
      () => run('UPDATE orders SET updated_at = ? WHERE id = ?', '2026-10-14 06:00:00', 'o2'),
    ],
  ];
  const seen = new Set([base]);
  for (const [label, change] of steps) {
    change();
    const next = fingerprintOf(db);
    assert.ok(!seen.has(next), `degisiklik izi degistirir: ${label}`);
    seen.add(next);
  }

  // --- SQLite istatistik tablolari (ANALYZE / PRAGMA optimize) izi degistirmez ---
  const before = fingerprintOf(db);
  db.exec('ANALYZE');
  db.exec('PRAGMA optimize');
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
  assert.ok(tables.includes('sqlite_stat1'), 'ANALYZE sqlite_stat1 olusturdu');
  assert.ok(tables.includes('sqlite_sequence'), 'AUTOINCREMENT sqlite_sequence olusturdu');
  assert.strictEqual(fingerprintOf(db), before, 'sqlite_ ic tablolari sayilmaz');

  // --- Ayni icerikli iki veritabani ayni izi verir (sira bagimsiz) ---
  const a = new DatabaseSync(':memory:');
  const b = new DatabaseSync(':memory:');
  a.exec(
    'CREATE TABLE x (id TEXT, updated_at INTEGER); CREATE TABLE y (id TEXT, created_at INTEGER);',
  );
  b.exec(
    'CREATE TABLE y (id TEXT, created_at INTEGER); CREATE TABLE x (id TEXT, updated_at INTEGER);',
  );
  for (const d of [a, b]) {
    d.prepare('INSERT INTO x VALUES (?, ?)').run('1', 5);
    d.prepare('INSERT INTO y VALUES (?, ?)').run('1', 7);
  }
  assert.strictEqual(fingerprintOf(a), fingerprintOf(b), 'ayni icerik -> ayni iz');
  b.prepare('UPDATE x SET updated_at = 6').run();
  assert.notStrictEqual(fingerprintOf(a), fingerprintOf(b), 'farkli zaman -> farkli iz');
  a.close();
  b.close();

  // --- Sorgu kurulumu (saf) ---
  assert.strictEqual(buildFingerprintQuery([], []), null, 'tablo yoksa sorgu yok');
  assert.strictEqual(
    buildFingerprintQuery(
      [
        { t: 'backups', c: 'id' },
        { t: 'sqlite_stat1', c: 'tbl' },
      ],
      [],
    ),
    null,
    'yalniz haric tablolar -> sorgu yok',
  );
  const built = buildFingerprintQuery(
    [
      { t: 'application_settings', c: 'key' },
      { t: 'application_settings', c: 'updated_at' },
      { t: 'orders', c: 'created_at' },
    ],
    ['a', 'b'],
  );
  assert.ok(built);
  assert.strictEqual(
    (built.sql.match(/\?/g) ?? []).length,
    built.params.length,
    'yer tutucu sayisi = parametre sayisi',
  );
  assert.deepStrictEqual(built.params, ['application_settings', 'a', 'b', 'orders']);
  assert.match(built.sql, /MAX\("created_at"\)/, 'updated_at yoksa created_at');
  assert.ok(isFingerprintTable('orders') && !isFingerprintTable('SQLITE_STAT4'));
  assert.notStrictEqual(
    fingerprintHash([{ t: 'x', n: '1', m: null }]),
    fingerprintHash([{ t: 'x', n: '1', m: '' + 0 }]),
    'bos zaman ile 0 ayri',
  );
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('✓ backup.fingerprint self-check OK');
