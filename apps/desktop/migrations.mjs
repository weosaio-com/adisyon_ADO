// Veritabani guncellemesi (Electron'suz; selfcheck.mjs). Paketle gelen Prisma migration'lari
// acilista, backend baslamadan uygulanir. Calistirilacak migration varsa once tutarli bir kopya
// alinir (`VACUUM INTO`, en yeni 3'u tutulur): guncelleme hata verirse veri bu kopyadan donulur.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const PRE_MIGRATE_KEEP = 3;
const COPY_PATTERN = /^ado-\d{8}T\d{6}\.db$/;

/** `_prisma_migrations`'ta kayitli adlar (gelistirme DB'si `prisma migrate` ile kurulduysa). */
function prismaAppliedNames(db) {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'`)
    .get();
  if (!exists) return new Set();
  return new Set(
    db
      .prepare('SELECT "migration_name" FROM "_prisma_migrations"')
      .all()
      .map((row) => row.migration_name),
  );
}

/** Henuz `_ado_migrations`'a yazilmamis migration klasorleri (sirali). */
export function pendingMigrations(db, migrationsDir) {
  const applied = new Set(
    db
      .prepare('SELECT "name" FROM "_ado_migrations"')
      .all()
      .map((row) => row.name),
  );
  return readdirSync(migrationsDir)
    .sort()
    .filter((name) => existsSync(join(migrationsDir, name, 'migration.sql')) && !applied.has(name));
}

/** Tutarli kopya: `<backupDir>/ado-<UTC zaman>.db`; en yeni `keep` kopya kalir. Kopya yolu doner. */
export function backupBeforeMigrate(
  db,
  backupDir,
  { keep = PRE_MIGRATE_KEEP, now = new Date() } = {},
) {
  mkdirSync(backupDir, { recursive: true });
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '');
  const target = join(backupDir, `ado-${stamp}.db`);
  rmSync(target, { force: true }); // ayni saniyede ikinci deneme
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  const copies = readdirSync(backupDir)
    .filter((name) => COPY_PATTERN.test(name))
    .sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - keep))) {
    rmSync(join(backupDir, old), { force: true });
  }
  return target;
}

/**
 * Bekleyen migration'lari sirayla uygular; her biri kendi islemindedir (hata verirse geri alinir ve
 * acilis durur). `_prisma_migrations`'ta olanlar yalniz kaydedilir. Uygulananlar ve kopya yolu doner.
 */
export function applyMigrations(dbPath, migrationsDir, { backupDir } = {}) {
  if (!existsSync(migrationsDir)) return { applied: [], backup: null };
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS "_ado_migrations" ("name" TEXT PRIMARY KEY, "applied_at" TEXT NOT NULL)',
    );
    const pending = pendingMigrations(db, migrationsDir);
    const prismaApplied = prismaAppliedNames(db);
    const willChange = pending.some((name) => !prismaApplied.has(name));
    const backup = willChange && backupDir ? backupBeforeMigrate(db, backupDir) : null;
    for (const name of pending) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!prismaApplied.has(name)) {
          db.exec(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
        }
        db.prepare('INSERT INTO "_ado_migrations" ("name", "applied_at") VALUES (?, ?)').run(
          name,
          new Date().toISOString(),
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    return { applied: pending, backup };
  } finally {
    db.close();
  }
}
