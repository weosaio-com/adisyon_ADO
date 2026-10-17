import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDataDir } from './data-dir';

/**
 * Bu kurulumun kalici kimligi. Bulut baglantisi kurulumu bununla tanir; olusma ani (createdAt)
 * lisanssiz deneme suresinin baslangicidir (LICENSING.md §8).
 *
 * Bilerek veritabaninin DISINDA (veri dizininde ado-install.json): yedekler yalniz veritabanini
 * tasir, bu yuzden bir yedek baska bilgisayara geri yuklendiginde kimlik onunla gitmez ve iki
 * bilgisayar ayni kurulum gibi gorunmez. ADO_INSTALL_ID ortam degiskeni (testler) onceliklidir.
 */
export const INSTALL_ID_FILE = 'ado-install.json';
export const INSTALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export interface InstallRecord {
  installId: string;
  /** Dosyanin ilk yazildigi an; eski/bozuk alanda null. */
  createdAt: Date | null;
}

const cache = new Map<string, InstallRecord>();

function readInstallFile(path: string): InstallRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const { installId, createdAt } = value as { installId?: unknown; createdAt?: unknown };
    if (typeof installId !== 'string' || !INSTALL_ID_PATTERN.test(installId)) return null;
    const created = typeof createdAt === 'string' ? new Date(createdAt) : null;
    return {
      installId,
      createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
    };
  } catch {
    return null;
  }
}

/**
 * Kurulum dosyasini okur; yoksa (ya da bozuksa) olusturur. Acilista cagrilir (LicenseService):
 * deneme suresi ilk acilistan sayilsin diye dosya bulut kodunu beklemeden yazilir.
 * Ortam degiskenine bakmaz (o yalniz kimligi ezer).
 */
export function ensureInstallFile(dataDir: string = resolveDataDir()): InstallRecord {
  const cached = cache.get(dataDir);
  if (cached) return cached;

  const path = join(dataDir, INSTALL_ID_FILE);
  let record = readInstallFile(path);
  if (!record) {
    record = { installId: `inst_${randomBytes(12).toString('base64url')}`, createdAt: new Date() };
    mkdirSync(dataDir, { recursive: true });
    // tmp + rename: yarim yazilmis dosyayla acilis olmasin.
    const tmp = `${path}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ installId: record.installId, createdAt: record.createdAt?.toISOString() }),
    );
    renameSync(tmp, path);
  }
  cache.set(dataDir, record);
  return record;
}

export function resolveInstallId(dataDir: string = resolveDataDir()): string {
  const fromEnv = process.env.ADO_INSTALL_ID?.trim();
  if (fromEnv && INSTALL_ID_PATTERN.test(fromEnv)) return fromEnv;
  return ensureInstallFile(dataDir).installId;
}

/** Kurulumun ilk acilis ani (deneme baslangici). Dosya yazilamaz ya da tarihsizse null. */
export function installCreatedAt(dataDir: string = resolveDataDir()): Date | null {
  try {
    return ensureInstallFile(dataDir).createdAt;
  } catch {
    return null;
  }
}

// --- self-check: `ts-node src/common/util/install-id.ts` ---
if (require.main === module) {
  delete process.env.ADO_INSTALL_ID;
  const dir = mkdtempSync(join(tmpdir(), 'ado-install-'));
  try {
    const before = Date.now();
    const first = resolveInstallId(dir);
    assert.match(first, INSTALL_ID_PATTERN);
    const created = installCreatedAt(dir);
    assert.ok(created && created.getTime() >= before - 1000, 'olusma ani dosyaya yazilir');
    cache.clear();
    assert.strictEqual(resolveInstallId(dir), first, 'dosyadan ayni kimlik okunmali');
    assert.strictEqual(
      installCreatedAt(dir)?.toISOString(),
      created?.toISOString(),
      'olusma ani yeniden okununca degismez',
    );

    // Bozuk dosya yeni kimlikle degistirilir.
    writeFileSync(join(dir, INSTALL_ID_FILE), '{bozuk');
    cache.clear();
    const second = resolveInstallId(dir);
    assert.notStrictEqual(second, first);
    assert.strictEqual(readInstallFile(join(dir, INSTALL_ID_FILE))?.installId, second);

    // Tarihsiz eski dosya: kimlik korunur, olusma ani bilinmez (dosyaya dokunulmaz).
    writeFileSync(join(dir, INSTALL_ID_FILE), JSON.stringify({ installId: 'inst_eski_000001' }));
    cache.clear();
    assert.strictEqual(resolveInstallId(dir), 'inst_eski_000001');
    assert.strictEqual(installCreatedAt(dir), null);
    assert.strictEqual(
      readFileSync(join(dir, INSTALL_ID_FILE), 'utf8'),
      JSON.stringify({ installId: 'inst_eski_000001' }),
    );

    // Ortam degiskeni kimlikte oncelikli; gecersizse yok sayilir. Dosya yine olusturulur.
    process.env.ADO_INSTALL_ID = 'inst_test_000001';
    assert.strictEqual(resolveInstallId(dir), 'inst_test_000001');
    process.env.ADO_INSTALL_ID = 'gecersiz kimlik';
    assert.strictEqual(resolveInstallId(dir), 'inst_eski_000001');
    const fresh = join(dir, 'yeni');
    process.env.ADO_INSTALL_ID = 'inst_test_000001';
    assert.ok(installCreatedAt(fresh), 'ortam degiskeni olsa da acilista dosya yazilir');
    assert.match(readInstallFile(join(fresh, INSTALL_ID_FILE))?.installId ?? '', /^inst_/);
  } finally {
    delete process.env.ADO_INSTALL_ID;
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('✓ install-id self-check OK');
}
