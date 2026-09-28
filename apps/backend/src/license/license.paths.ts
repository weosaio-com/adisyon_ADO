import assert from 'node:assert';
import { API_PREFIX } from '../common/http/api-prefix';

// Lisans suresi dolsa bile ASLA engellenmeyen yazma uclari:
//   - /auth/*    -> giris yapip lisansi yenileyebilmeli
//   - /license/* -> yeni anahtari girebilmeli
//   - /backups/* -> verisini disari alabilmeli (rehin tutma yok)
//   - /health    -> saglik kontrolu
const ALWAYS_ALLOWED = ['/auth', '/license', '/backups', '/health'];

/**
 * Istek yolu (req.path, global onek DAHIL gelir: /api/v1/...) izin listesinde mi.
 * Onek soyulmadan karsilastirma hicbir zaman eslesmiyordu.
 */
export function isAlwaysAllowed(path: string): boolean {
  const prefix = `/${API_PREFIX}`;
  const bare = path === prefix || path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
  return ALWAYS_ALLOWED.some((p) => bare === p || bare.startsWith(`${p}/`));
}

// --- self-check: `ts-node src/license/license.paths.ts` ---
if (require.main === module) {
  assert.ok(isAlwaysAllowed('/api/v1/license/activate'), 'lisans etkinlestirme');
  assert.ok(isAlwaysAllowed('/api/v1/auth/login'), 'giris');
  assert.ok(isAlwaysAllowed('/api/v1/backups'), 'yedek al');
  assert.ok(isAlwaysAllowed('/api/v1/backups/01ABC/restore'), 'yedek geri yukle');
  assert.ok(isAlwaysAllowed('/api/v1/health'), 'saglik');
  assert.ok(isAlwaysAllowed('/license/activate'), 'oneksiz yol da desteklenir');

  assert.ok(!isAlwaysAllowed('/api/v1/orders'), 'satis engellenir');
  assert.ok(!isAlwaysAllowed('/api/v1/licensex'), 'onek benzerligi eslesmez');
  assert.ok(!isAlwaysAllowed('/api/v1/backupsx/1'), 'onek benzerligi eslesmez (backups)');
  assert.ok(!isAlwaysAllowed('/api/v1'), 'kok yol izinli degil');
  assert.ok(!isAlwaysAllowed('/api/v2/license'), 'baska onek soyulmaz');

  console.log('✓ license.paths self-check OK');
}
