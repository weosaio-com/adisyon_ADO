import {
  encodeTableCode,
  MENU_IMAGE_MAX_BYTES,
  MENU_IMAGE_TYPES,
  menuImageKey,
  sniffImageType,
  TABLE_CODE_BYTES,
  type MenuImageExt,
  type MenuSnapshot,
  type MenuTable,
} from '@ado/shared/menu';
import type { Env } from '../env';
import { randomBytes, sha256Hex } from './crypto';
import { ApiError, nowIso } from './http';

// -----------------------------------------------------------------------------
// Gorseller (R2, anahtar = icerik ozeti)
// -----------------------------------------------------------------------------

export const imageObjectKey = (key: string) => `img/${key}`;

/** Gorseli dogrular ve saklar. `expectedKey` verilirse icerik ozeti ve tur onunla ayni olmali. */
export async function storeImage(
  env: Env,
  bytes: Uint8Array,
  expectedKey?: string,
): Promise<string> {
  if (bytes.length === 0) throw new ApiError(400, 'IMAGE_EMPTY', 'Görsel boş.');
  if (bytes.length > MENU_IMAGE_MAX_BYTES) {
    throw new ApiError(413, 'IMAGE_TOO_LARGE', 'Görsel en fazla 1 MB olabilir.');
  }
  const ext = sniffImageType(bytes);
  if (!ext) {
    throw new ApiError(400, 'IMAGE_TYPE_INVALID', 'Görsel JPEG, PNG ya da WebP olmalı.');
  }
  const key = menuImageKey(await sha256Hex(bytes), ext);
  if (expectedKey && expectedKey !== key) {
    throw new ApiError(400, 'IMAGE_KEY_MISMATCH', 'Görsel içeriği anahtarla eşleşmiyor.');
  }
  const known = await env.DB.prepare('SELECT 1 FROM images WHERE key = ?').bind(key).first();
  if (known) return key;
  await env.IMAGES.put(imageObjectKey(key), bytes, {
    httpMetadata: {
      contentType: MENU_IMAGE_TYPES[ext as MenuImageExt],
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });
  await env.DB.prepare(
    'INSERT INTO images (key, size, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING',
  )
    .bind(key, bytes.length, nowIso())
    .run();
  return key;
}

/** Istek govdesini en fazla gorsel sinirina kadar okur. */
export async function readImageBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MENU_IMAGE_MAX_BYTES) {
    throw new ApiError(413, 'IMAGE_TOO_LARGE', 'Görsel en fazla 1 MB olabilir.');
  }
  return new Uint8Array(await request.arrayBuffer());
}

/** Bulutta olmayan gorsel anahtarlari (tek sorgu; json_each ile parametre siniri yok). */
export async function missingImages(db: D1Database, keys: string[]): Promise<string[]> {
  const unique = Array.from(new Set(keys));
  if (unique.length === 0) return [];
  const { results } = await db
    .prepare('SELECT value AS key FROM json_each(?) WHERE value NOT IN (SELECT key FROM images)')
    .bind(JSON.stringify(unique))
    .all<{ key: string }>();
  return results.map((row) => row.key);
}

// -----------------------------------------------------------------------------
// Menu
// -----------------------------------------------------------------------------

/**
 * Menuyu kaydeder, surumu bir artirir. `baseVersion` verilirse (panel) yalniz mevcut surum
 * onunla ayniysa yazar; aksi halde 409 VERSION_CONFLICT (baska sekmede degismis).
 */
export async function saveMenu(
  env: Env,
  branchId: string,
  menu: MenuSnapshot,
  baseVersion?: number | null,
): Promise<{ version: number; updatedAt: string }> {
  const missing = await missingImages(
    env.DB,
    menu.products.flatMap((product) => (product.imageKey ? [product.imageKey] : [])),
  );
  if (missing.length) {
    throw new ApiError(409, 'IMAGES_MISSING', 'Menüdeki bazı görseller yüklenmemiş.', missing);
  }
  const snapshot = JSON.stringify(menu);
  const updatedAt = nowIso();
  let row: { version: number } | null;
  if (baseVersion === undefined) {
    row = await env.DB.prepare(
      `INSERT INTO menus (branch_id, version, snapshot, updated_at) VALUES (?1, 1, ?2, ?3)
       ON CONFLICT(branch_id) DO UPDATE SET
         version = menus.version + 1, snapshot = excluded.snapshot, updated_at = excluded.updated_at
       RETURNING version`,
    )
      .bind(branchId, snapshot, updatedAt)
      .first<{ version: number }>();
  } else if (baseVersion === null) {
    row = await env.DB.prepare(
      `INSERT INTO menus (branch_id, version, snapshot, updated_at) VALUES (?1, 1, ?2, ?3)
       ON CONFLICT(branch_id) DO NOTHING RETURNING version`,
    )
      .bind(branchId, snapshot, updatedAt)
      .first<{ version: number }>();
  } else {
    row = await env.DB.prepare(
      `UPDATE menus SET version = version + 1, snapshot = ?3, updated_at = ?4
       WHERE branch_id = ?1 AND version = ?2 RETURNING version`,
    )
      .bind(branchId, baseVersion, snapshot, updatedAt)
      .first<{ version: number }>();
  }
  if (!row) {
    throw new ApiError(
      409,
      'VERSION_CONFLICT',
      'Menü bu arada değişmiş. Sayfayı yenileyip tekrar deneyin.',
    );
  }
  // Satici listesinde guncel isletme adi gorunsun.
  await env.DB.prepare('UPDATE branches SET name = ?, updated_at = ? WHERE id = ?')
    .bind(menu.branch.name, updatedAt, branchId)
    .run();
  return { version: row.version, updatedAt };
}

// -----------------------------------------------------------------------------
// Masalar
// -----------------------------------------------------------------------------

export function newTableCode(): string {
  return encodeTableCode(randomBytes(TABLE_CODE_BYTES));
}

/**
 * POS'un masa listesini esitler: koda gore gunceller/ekler, listede olmayanlari siler.
 * Kod baska bir subeye aitse 409 (kod tahmin edilemez; cakisma yalniz kotuye kullanimda olur).
 */
export async function syncTables(db: D1Database, branchId: string, tables: MenuTable[]) {
  const payload = JSON.stringify(tables);
  const taken = await db
    .prepare(
      `SELECT code FROM tables
       WHERE branch_id != ?1 AND code IN (SELECT json_extract(value, '$.code') FROM json_each(?2))`,
    )
    .bind(branchId, payload)
    .all<{ code: string }>();
  if (taken.results.length) {
    throw new ApiError(
      409,
      'TABLE_CODE_TAKEN',
      'Bazı masa kodları başka bir işletmede kullanılıyor.',
      taken.results.map((row) => row.code),
    );
  }
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `DELETE FROM tables WHERE branch_id = ?1
         AND code NOT IN (SELECT json_extract(value, '$.code') FROM json_each(?2))`,
      )
      .bind(branchId, payload),
    db
      .prepare(
        `INSERT INTO tables (id, branch_id, code, name, hall, sort_order, created_at, updated_at)
         SELECT lower(hex(randomblob(16))), ?1, json_extract(value, '$.code'),
                json_extract(value, '$.name'), json_extract(value, '$.hall'), key, ?3, ?3
         FROM json_each(?2) WHERE true
         ON CONFLICT(code) DO UPDATE SET
           name = excluded.name, hall = excluded.hall, sort_order = excluded.sort_order,
           updated_at = excluded.updated_at
         WHERE tables.branch_id = excluded.branch_id`,
      )
      .bind(branchId, payload, now),
  ]);
}
