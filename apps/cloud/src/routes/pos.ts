import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { menuImageKeySchema, menuSnapshotSchema, menuTableListSchema } from '@ado/shared/menu';
import type { AppEnv } from '../env';
import { normalizePairingCode, randomToken, sha256Hex } from '../lib/crypto';
import { menuMeta, type BranchRow, type TenantRow } from '../lib/db';
import { ApiError, nowIso, ok, readJson } from '../lib/http';
import { missingImages, readImageBody, saveMenu, storeImage, syncTables } from '../lib/menu-store';
import { PLANS, tenantFeatures, type PlanId } from '../lib/plans';
import { limit } from '../lib/rate-limit';

/**
 * POS (yerel adisyon sunucusu) API'si. Panelden alinan eslestirme koduyla bir kez eslesir, sonra
 * Bearer belirteciyle menu, masa ve gorsel yayinlar. Eslesen subenin menusunu POS yonetir.
 */
export const posRoutes = new Hono<AppEnv>();

const POS_TOKEN_PREFIX = 'adoqr_pos_';

function posInfo(branch: BranchRow, tenant: TenantRow) {
  return {
    branch: { id: branch.id, name: branch.name },
    tenant: {
      name: tenant.name,
      plan: tenant.plan,
      planLabel: PLANS[tenant.plan as PlanId]?.label ?? tenant.plan,
      features: tenantFeatures(tenant),
    },
  };
}

posRoutes.post('/pair', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  await limit(c.env.DB, [`pair:ip:${ip}`], 10, 15 * 60);
  const { code } = await readJson(c, z.object({ code: z.string().min(1).max(32) }));
  const codeHash = await sha256Hex(normalizePairingCode(code));
  const now = nowIso();
  // Tek kullanimlik: kod okunurken silinir (iki POS ayni kodla eslesemez).
  const used = await c.env.DB.prepare(
    'DELETE FROM pairing_codes WHERE code_hash = ? AND expires_at > ? RETURNING branch_id',
  )
    .bind(codeHash, now)
    .first<{ branch_id: string }>();
  if (!used) {
    throw new ApiError(
      400,
      'PAIRING_CODE_INVALID',
      'Eşleştirme kodu geçersiz ya da süresi dolmuş.',
    );
  }
  const token = randomToken(POS_TOKEN_PREFIX);
  const branch = await c.env.DB.prepare(
    `UPDATE branches SET source = 'pos', pos_token_hash = ?, pos_paired_at = ?,
       pos_last_seen_at = ?, updated_at = ?
     WHERE id = ? RETURNING *`,
  )
    .bind(await sha256Hex(token), now, now, now, used.branch_id)
    .first<BranchRow>();
  const tenant = branch
    ? await c.env.DB.prepare('SELECT * FROM tenants WHERE id = ?')
        .bind(branch.tenant_id)
        .first<TenantRow>()
    : null;
  if (!branch || !tenant) throw new ApiError(404, 'BRANCH_NOT_FOUND', 'Şube bulunamadı.');
  // Belirtec yalniz bu yanitta duz metin doner; bulutta ozeti durur.
  return ok(c, { token, ...posInfo(branch, tenant) }, 201);
});

const posAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token.startsWith(POS_TOKEN_PREFIX)) {
    throw new ApiError(401, 'POS_TOKEN_INVALID', 'POS bağlantısı geçersiz. Yeniden eşleştirin.');
  }
  const row = await c.env.DB.prepare(
    `SELECT b.*, t.name AS t_name, t.plan AS t_plan, t.features AS t_features,
            t.status AS t_status, t.created_at AS t_created_at, t.updated_at AS t_updated_at
     FROM branches b JOIN tenants t ON t.id = b.tenant_id
     WHERE b.pos_token_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first<
      BranchRow & {
        t_name: string;
        t_plan: string;
        t_features: string;
        t_status: TenantRow['status'];
        t_created_at: string;
        t_updated_at: string;
      }
    >();
  if (!row) {
    throw new ApiError(401, 'POS_TOKEN_INVALID', 'POS bağlantısı geçersiz. Yeniden eşleştirin.');
  }
  const { t_name, t_plan, t_features, t_status, t_created_at, t_updated_at, ...branch } = row;
  c.set('pos', {
    branch,
    tenant: {
      id: branch.tenant_id,
      name: t_name,
      plan: t_plan,
      features: t_features,
      status: t_status,
      created_at: t_created_at,
      updated_at: t_updated_at,
    },
  });
  // "Son gorulme" dakikada en fazla bir kez yazilir.
  const now = new Date();
  await c.env.DB.prepare(
    'UPDATE branches SET pos_last_seen_at = ?1 WHERE id = ?2 AND (pos_last_seen_at IS NULL OR pos_last_seen_at < ?3)',
  )
    .bind(now.toISOString(), branch.id, new Date(now.getTime() - 60_000).toISOString())
    .run();
  await next();
};

posRoutes.use('/status', posAuth);
posRoutes.use('/menu', posAuth);
posRoutes.use('/tables', posAuth);
posRoutes.use('/images/*', posAuth);
posRoutes.use('/unpair', posAuth);

posRoutes.get('/status', async (c) => {
  const { branch, tenant } = c.get('pos');
  const tables = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM tables WHERE branch_id = ?')
    .bind(branch.id)
    .first<{ n: number }>();
  return ok(c, {
    ...posInfo(branch, tenant),
    menu: await menuMeta(c.env.DB, branch.id),
    tableCount: tables?.n ?? 0,
  });
});

posRoutes.put('/menu', async (c) => {
  const { branch } = c.get('pos');
  const menu = await readJson(c, menuSnapshotSchema);
  return ok(c, await saveMenu(c.env, branch.id, menu));
});

posRoutes.put('/tables', async (c) => {
  const { branch } = c.get('pos');
  const { tables } = await readJson(c, z.object({ tables: menuTableListSchema }));
  await syncTables(c.env.DB, branch.id, tables);
  return ok(c, { count: tables.length });
});

// Yayindan once: hangi gorseller bulutta yok? (tek istek; yalniz eksikler yuklenir)
posRoutes.post('/images/check', async (c) => {
  const { keys } = await readJson(c, z.object({ keys: z.array(menuImageKeySchema).max(2000) }));
  return ok(c, { missing: await missingImages(c.env.DB, keys) });
});

posRoutes.put('/images/:key', async (c) => {
  const key = c.req.param('key');
  if (!menuImageKeySchema.safeParse(key).success) {
    throw new ApiError(400, 'IMAGE_KEY_INVALID', 'Geçersiz görsel anahtarı.');
  }
  await storeImage(c.env, await readImageBody(c.req.raw), key);
  return ok(c, { key }, 201);
});

// POS baglantiyi kaldirinca menu panelden yonetilmeye doner (son yayinlanan menu kalir).
posRoutes.post('/unpair', async (c) => {
  const { branch } = c.get('pos');
  await c.env.DB.prepare(
    `UPDATE branches SET source = 'panel', pos_token_hash = NULL, pos_paired_at = NULL,
       pos_last_seen_at = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(nowIso(), branch.id)
    .run();
  return ok(c, { unpaired: true });
});
