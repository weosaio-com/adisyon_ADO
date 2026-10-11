import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { MENU_LIMITS } from '@ado/shared/menu';
import type { AppEnv } from '../env';
import { safeEqual } from '../lib/crypto';
import { branchSummaries, tenantById, type TenantRow } from '../lib/db';
import { ApiError, nowIso, ok, readJson } from '../lib/http';
import { FEATURES, PLAN_IDS, PLANS, tenantFeatures } from '../lib/plans';

/**
 * Satici (vendor) API'si: isletmeleri listeleme, askiya alma, ozellik istisnasi, POS baglantisini
 * kaldirma, silme. Isletmeler POS'un lisansla ilk etkinlestirmesinde kendiliginden acilir; ad, paket
 * ve ozellikler her etkinlestirme ve yenilemede imzali lisanstan yeniden yazilir.
 * `ADMIN_TOKEN` gizli degeriyle korunur; tanimli degilse tamamen kapalidir.
 */
export const adminRoutes = new Hono<AppEnv>();

const adminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!expected || expected.length < 16 || !token || !(await safeEqual(token, expected))) {
    throw new ApiError(401, 'ADMIN_TOKEN_INVALID', 'Yetkisiz.');
  }
  await next();
};
adminRoutes.use('*', adminAuth);

function tenantView(tenant: TenantRow) {
  return {
    id: tenant.id,
    name: tenant.name,
    plan: tenant.plan,
    status: tenant.status,
    features: tenantFeatures(tenant),
    licenseId: tenant.license_id,
    licenseExpiresAt: tenant.license_expires_at,
    createdAt: tenant.created_at,
  };
}

adminRoutes.get('/plans', (c) => ok(c, { plans: PLANS, features: FEATURES }));

adminRoutes.get('/tenants', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM tenants ORDER BY created_at DESC',
  ).all<TenantRow>();
  return ok(c, results.map(tenantView));
});

adminRoutes.get('/tenants/:id', async (c) => {
  const tenant = await tenantById(c.env.DB, c.req.param('id'));
  if (!tenant) throw new ApiError(404, 'TENANT_NOT_FOUND', 'İşletme bulunamadı.');
  return ok(c, { ...tenantView(tenant), branches: await branchSummaries(c.env.DB, tenant.id) });
});

adminRoutes.patch('/tenants/:id', async (c) => {
  const tenant = await tenantById(c.env.DB, c.req.param('id'));
  if (!tenant) throw new ApiError(404, 'TENANT_NOT_FOUND', 'İşletme bulunamadı.');
  const body = await readJson(
    c,
    z.object({
      name: z.string().trim().min(1).max(MENU_LIMITS.branchName).optional(),
      plan: z.enum(PLAN_IDS).optional(),
      // Paketin disinda tek tek acilan/kapatilan ozellikler (null: paketteki gibi).
      features: z.record(z.enum(FEATURES), z.boolean().nullable()).optional(),
      status: z.enum(['active', 'suspended']).optional(),
    }),
  );
  let features = tenant.features;
  if (body.features) {
    const current = JSON.parse(tenant.features) as Record<string, boolean>;
    for (const [feature, flag] of Object.entries(body.features)) {
      if (flag === null || flag === undefined) delete current[feature];
      else current[feature] = flag;
    }
    features = JSON.stringify(current);
  }
  const row = await c.env.DB.prepare(
    'UPDATE tenants SET name = ?, plan = ?, features = ?, status = ?, updated_at = ? WHERE id = ? RETURNING *',
  )
    .bind(
      body.name ?? tenant.name,
      body.plan ?? tenant.plan,
      features,
      body.status ?? tenant.status,
      nowIso(),
      tenant.id,
    )
    .first<TenantRow>();
  return ok(c, row ? tenantView(row) : null);
});

// POS baglantilarini kaldirir (calinan lisans, bilgisayar degisimi): belirtecler iptal edilir,
// POS "satici tarafindan kaldirildi" gorur. Menu yayinda kalir; gizlemek icin askiya alin.
adminRoutes.post('/tenants/:id/revoke', async (c) => {
  const tenant = await tenantById(c.env.DB, c.req.param('id'));
  if (!tenant) throw new ApiError(404, 'TENANT_NOT_FOUND', 'İşletme bulunamadı.');
  const now = nowIso();
  const [revocations] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO pos_token_revocations (token_hash, branch_id, reason, created_at)
       SELECT pos_token_hash, id, 'revoked', ?1 FROM branches
       WHERE tenant_id = ?2 AND pos_token_hash IS NOT NULL
       ON CONFLICT (token_hash) DO NOTHING`,
    ).bind(now, tenant.id),
    c.env.DB.prepare(
      `UPDATE branches SET pos_token_hash = NULL, pos_paired_at = NULL, install_id = NULL,
         updated_at = ?1 WHERE tenant_id = ?2 AND pos_token_hash IS NOT NULL`,
    ).bind(now, tenant.id),
  ]);
  return ok(c, { revoked: revocations?.meta.changes ?? 0 });
});

// Isletmeyi tamamen siler (subeler, menu, masalar, iptal kayitlari birlikte). Gorseller icerik
// adreslidir ve baska isletmelerce de kullanilabilir; R2'de kalir.
adminRoutes.delete('/tenants/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM tenants WHERE id = ?')
    .bind(c.req.param('id'))
    .run();
  if (!result.meta.changes) throw new ApiError(404, 'TENANT_NOT_FOUND', 'İşletme bulunamadı.');
  return ok(c, { deleted: true });
});
