import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDataDir } from './data-dir';

/**
 * Bu kurulumun kalici kimligi. Bulut baglantisi kurulumu bununla tanir.
 *
 * Bilerek veritabaninin DISINDA (veri dizininde ado-install.json): yedekler yalniz veritabanini
 * tasir, bu yuzden bir yedek baska bilgisayara geri yuklendiginde kimlik onunla gitmez ve iki
 * bilgisayar ayni kurulum gibi gorunmez. ADO_INSTALL_ID ortam degiskeni (testler) onceliklidir.
 */
export const INSTALL_ID_FILE = 'ado-install.json';
export const INSTALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

const cache = new Map<string, string>();

function readInstallId(path: string): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const installId =
      value && typeof value === 'object' ? (value as { installId?: unknown }).installId : null;
    return typeof installId === 'string' && INSTALL_ID_PATTERN.test(installId) ? installId : null;
  } catch {
    return null;
  }
}

export function resolveInstallId(dataDir: string = resolveDataDir()): string {
  const fromEnv = process.env.ADO_INSTALL_ID?.trim();
  if (fromEnv && INSTALL_ID_PATTERN.test(fromEnv)) return fromEnv;

  const cached = cache.get(dataDir);
  if (cached) return cached;

  const path = join(dataDir, INSTALL_ID_FILE);
  let installId = readInstallId(path);
  if (!installId) {
    installId = `inst_${randomBytes(12).toString('base64url')}`;
    mkdirSync(dataDir, { recursive: true });
    // tmp + rename: yarim yazilmis dosyayla acilis olmasin.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ installId, createdAt: new Date().toISOString() }));
    renameSync(tmp, path);
  }
  cache.set(dataDir, installId);
  return installId;
}

// --- self-check: `ts-node src/common/util/install-id.ts` ---
if (require.main === module) {
  delete process.env.ADO_INSTALL_ID;
  const dir = mkdtempSync(join(tmpdir(), 'ado-install-'));
  try {
    const first = resolveInstallId(dir);
    assert.match(first, INSTALL_ID_PATTERN);
    cache.clear();
    assert.strictEqual(resolveInstallId(dir), first, 'dosyadan ayni kimlik okunmali');

    // Bozuk dosya yeni kimlikle degistirilir.
    writeFileSync(join(dir, INSTALL_ID_FILE), '{bozuk');
    cache.clear();
    const second = resolveInstallId(dir);
    assert.notStrictEqual(second, first);
    assert.strictEqual(readInstallId(join(dir, INSTALL_ID_FILE)), second);

    // Ortam degiskeni oncelikli; gecersizse yok sayilir.
    process.env.ADO_INSTALL_ID = 'inst_test_000001';
    assert.strictEqual(resolveInstallId(dir), 'inst_test_000001');
    process.env.ADO_INSTALL_ID = 'gecersiz kimlik';
    assert.strictEqual(resolveInstallId(dir), second);
  } finally {
    delete process.env.ADO_INSTALL_ID;
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('✓ install-id self-check OK');
}
