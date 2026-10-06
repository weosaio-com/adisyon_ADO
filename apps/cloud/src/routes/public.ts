import { Hono } from 'hono';
import {
  MENU_IMAGE_KEY_PATTERN,
  MENU_IMAGE_TYPES,
  TABLE_CODE_PATTERN,
  type MenuImageExt,
} from '@ado/shared/menu';
import type { AppEnv } from '../env';
import { sha256Hex } from '../lib/crypto';
import { ApiError } from '../lib/http';
import { imageObjectKey } from '../lib/menu-store';
import { tenantFeatures } from '../lib/plans';

/** Musteri tarafi: masadaki QR'dan menu ve urun gorselleri (oturum yok). */
export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get('/api/m/:code', async (c) => {
  const code = c.req.param('code').toUpperCase();
  if (!TABLE_CODE_PATTERN.test(code)) {
    throw new ApiError(404, 'TABLE_NOT_FOUND', 'Bu QR kod bir masaya ait değil.');
  }
  const row = await c.env.DB.prepare(
    `SELECT t.name AS table_name, t.hall AS table_hall,
            ten.plan, ten.features, ten.status,
            m.version, m.snapshot, m.updated_at
     FROM tables t
     JOIN branches b ON b.id = t.branch_id
     JOIN tenants ten ON ten.id = b.tenant_id
     LEFT JOIN menus m ON m.branch_id = b.id
     WHERE t.code = ?`,
  )
    .bind(code)
    .first<{
      table_name: string;
      table_hall: string;
      plan: string;
      features: string;
      status: string;
      version: number | null;
      snapshot: string | null;
      updated_at: string | null;
    }>();
  if (!row) throw new ApiError(404, 'TABLE_NOT_FOUND', 'Bu QR kod bir masaya ait değil.');

  const features = tenantFeatures(row);
  if (!features['qr.menu']) {
    throw new ApiError(403, 'MENU_DISABLED', 'Bu işletmenin QR menüsü şu an kapalı.');
  }
  if (!row.snapshot) {
    throw new ApiError(404, 'MENU_NOT_PUBLISHED', 'Menü henüz yayınlanmadı.');
  }

  const body = JSON.stringify({
    success: true,
    data: {
      table: { name: row.table_name, hall: row.table_hall },
      version: row.version,
      updatedAt: row.updated_at,
      // Sonraki asamalarin arayuzu (siparis, odeme) buna gore acilir.
      features: { order: features['qr.order'], pay: features['qr.pay'] },
      menu: JSON.parse(row.snapshot) as unknown,
    },
  });
  // Tukendi gibi degisiklikler hemen gorunsun: her acilista dogrula, degismediyse 304.
  const etag = `"${(await sha256Hex(body)).slice(0, 32)}"`;
  const headers = { ETag: etag, 'Cache-Control': 'no-cache' };
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304, headers);
  return c.body(body, 200, { ...headers, 'Content-Type': 'application/json; charset=UTF-8' });
});

publicRoutes.get('/img/:key', async (c) => {
  const key = c.req.param('key');
  if (!MENU_IMAGE_KEY_PATTERN.test(key)) {
    throw new ApiError(404, 'IMAGE_NOT_FOUND', 'Görsel bulunamadı.');
  }
  const object = await c.env.IMAGES.get(imageObjectKey(key), { onlyIf: c.req.raw.headers });
  if (!object) throw new ApiError(404, 'IMAGE_NOT_FOUND', 'Görsel bulunamadı.');
  const ext = key.slice(key.lastIndexOf('.') + 1) as MenuImageExt;
  const headers = {
    'Content-Type': MENU_IMAGE_TYPES[ext],
    // Anahtar icerik ozetidir: ayni adreste icerik hic degismez.
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: object.httpEtag,
  };
  // onlyIf kosulu (If-None-Match) tuttuysa govde gelmez.
  if (!('body' in object)) return c.body(null, 304, headers);
  return c.body(object.body, 200, headers);
});
