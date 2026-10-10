import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { MENU_LIMITS } from '@ado/shared/menu';
import type { AppEnv } from '../env';
import { hashPassword, safeEqual } from '../lib/crypto';
import { branchSummaries, tenantById, type TenantRow } from '../lib/db';
import { ApiError, nowIso, ok, readJson } from '../lib/http';
import { FEATURES, PLAN_IDS, PLANS, tenantFeatures } from '../lib/plans';
import { createPairingCode, emailSchema, passwordSchema } from './panel';

/**
 * Satici (vendor) API'si: isletme acma, paket degistirme, askiya alma, POS baglantisini kaldirma,
 * parola sifirlama. Lisansla baglanan isletmeler POS'un ilk etkinlestirmesinde kendiliginden acilir.
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

adminRoutes.post('/tenants', async (c) => {
  const body = await readJson(
    c,
    z.object({
      name: z.string().trim().min(1).max(MENU_LIMITS.branchName),
      plan: z.enum(PLAN_IDS),
      branchName: z.string().trim().min(1).max(MENU_LIMITS.branchName).optional(),
      owner: z.object({ email: emailSchema, password: passwordSchema }),
    }),
  );
  const taken = await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?')
    .bind(body.owner.email)
    .first();
  if (taken) throw new ApiError(409, 'EMAIL_TAKEN', 'Bu e-posta başka bir hesapta kayıtlı.');

  const now = nowIso();
  const tenantId = crypto.randomUUID();
  const branchId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO tenants (id, name, plan, features, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(tenantId, body.name, body.plan, '{}', 'active', now, now),
    c.env.DB.prepare(
      'INSERT INTO branches (id, tenant_id, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(branchId, tenantId, body.branchName ?? body.name, 'panel', now, now),
    c.env.DB.prepare(
      'INSERT INTO users (id, tenant_id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(userId, tenantId, body.owner.email, await hashPassword(body.owner.password), now, now),
  ]);
  return ok(c, { tenantId, branchId, userId }, 201);
});

adminRoutes.get('/tenants', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM tenants ORDER BY created_at DESC',
  ).all<TenantRow>();
  return ok(c, results.map(tenantView));
});

adminRoutes.get('/tenants/:id', async (c) => {
  const tenant = await tenantById(c.env.DB, c.req.param('id'));
  if (!tenant) throw new ApiError(404, 'TENANT_NOT_FOUND', 'İşletme bulunamadı.');
  const { results: users } = await c.env.DB.prepare(
    'SELECT id, email, created_at FROM users WHERE tenant_id = ? ORDER BY created_at',
  )
    .bind(tenant.id)
    .all<{ id: string; email: string; created_at: string }>();
  return ok(c, {
    ...tenantView(tenant),
    users: users.map((user) => ({ id: user.id, email: user.email, createdAt: user.created_at })),
    branches: await branchSummaries(c.env.DB, tenant.id),
  });
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

adminRoutes.post('/branches/:id/pairing-code', async (c) => {
  const branch = await c.env.DB.prepare('SELECT id FROM branches WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string }>();
  if (!branch) throw new ApiError(404, 'BRANCH_NOT_FOUND', 'Şube bulunamadı.');
  return ok(c, await createPairingCode(c.env.DB, branch.id), 201);
});

// Parola sifirlama: tum oturumlar kapanir.
adminRoutes.post('/users/:id/password', async (c) => {
  const { password } = await readJson(c, z.object({ password: passwordSchema }));
  const userId = c.req.param('id');
  const results = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(
      await hashPassword(password),
      nowIso(),
      userId,
    ),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
  ]);
  if (!results[0]?.meta.changes) throw new ApiError(404, 'USER_NOT_FOUND', 'Kullanıcı bulunamadı.');
  return ok(c, { reset: true });
});
