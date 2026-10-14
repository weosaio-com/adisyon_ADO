import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z, type ZodType, type ZodTypeDef } from 'zod';
import { MENU_LIMITS } from '@ado/shared/menu';
import type { AppEnv } from '../env';
import { safeEqual } from '../lib/crypto';
import {
  branchSummaries,
  healthView,
  tenantById,
  type HealthColumns,
  type LicenseRow,
  type TenantRow,
} from '../lib/db';
import { ApiError, nowIso, ok, readJson } from '../lib/http';
import { requireUsableLicense } from '../lib/license';
import { FEATURES, PLAN_IDS, PLANS, tenantFeatures } from '../lib/plans';
import {
  applyLicenseToTenant,
  findLicense,
  isRevoked,
  registryFeatures,
  upsertLicense,
} from '../lib/registry';

/**
 * Satici (vendor) API'si: isletmeleri listeleme, askiya alma, ozellik istisnasi, POS baglantisini
 * kaldirma, silme; lisans kaydi (listeleme, kaydetme, iptal). Isletmeler POS'un lisansla ilk
 * baglanmasinda kendiliginden acilir; ad, paket ve ozellikler her baglanma ve yenilemede kayittaki
 * gecerli lisanstan yeniden yazilir. Sonraki admin paneli (Faz B) lisanslari buradan kaydeder.
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

/** Govdesi istege bagli uclar icin (or. iptal nedeni): bos govde `{}` sayilir. */
async function readOptionalJson<T>(
  c: Context<AppEnv>,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<T> {
  const text = (await c.req.raw.clone().text()).trim();
  if (!text) {
    const empty = schema.safeParse({});
    if (empty.success) return empty.data;
  }
  return readJson(c, schema);
}

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
  const registered = tenant.license_id ? await findLicense(c.env.DB, tenant.license_id) : null;
  return ok(c, {
    ...tenantView(tenant),
    // Lisans kaydindaki durum (iptal, kaynak); kayit yoksa (eski isletme) null.
    registry: registered
      ? {
          revoked: isRevoked(registered),
          revokedAt: registered.revoked_at,
          revokeReason: registered.revoke_reason,
          source: registered.source,
          exp: registered.exp,
          updatedAt: registered.updated_at,
        }
      : null,
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

// POS baglantilarini kaldirir (bilgisayar degisimi): belirtecler iptal edilir, POS "satici
// tarafindan kaldirildi" gorur ve sahibin onayi olmadan yeniden baglanmaz. Menu yayinda kalir;
// gizlemek icin askiya alin. Calinan lisans icin lisansi iptal edin (asagida).
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
// adreslidir ve baska isletmelerce de kullanilabilir; R2'de kalir. Lisans kaydi KALIR
// (tenant_id NULL olur): iptal edilmis lisans silinen isletmeyle yeniden baglanamaz.
adminRoutes.delete('/tenants/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM tenants WHERE id = ?')
    .bind(c.req.param('id'))
    .run();
  if (!result.meta.changes) throw new ApiError(404, 'TENANT_NOT_FOUND', 'İşletme bulunamadı.');
  return ok(c, { deleted: true });
});

// -----------------------------------------------------------------------------
// Lisans kaydi (registry)
// -----------------------------------------------------------------------------

type LicenseListRow = LicenseRow &
  HealthColumns & {
    tenant_name: string | null;
    tenant_status: TenantRow['status'] | null;
    pos_last_seen_at: string | null;
    pos_app_version: string | null;
    install_id: string | null;
  };

// Isletmenin (tek) subesi: son gorulme, surum, kurulum ve son heartbeat sagligi.
const LICENSE_SELECT = `
  SELECT l.*, t.name AS tenant_name, t.status AS tenant_status,
         b.pos_last_seen_at, b.pos_app_version, b.install_id,
         b.health_reported_at, b.health_db_bytes, b.health_backups_bytes,
         b.health_free_disk_bytes, b.health_last_backup_at, b.health_last_cloud_backup_at,
         b.health_license_exp
  FROM licenses l
  LEFT JOIN tenants t ON t.id = l.tenant_id
  LEFT JOIN branches b ON b.id = (
    SELECT id FROM branches WHERE tenant_id = l.tenant_id ORDER BY created_at LIMIT 1
  )`;

function licenseView(row: LicenseListRow, { withKey = false } = {}) {
  return {
    id: row.id,
    customer: row.customer,
    plan: row.plan,
    exp: row.exp,
    graceDays: row.grace_days,
    expiresAt: row.expires_at,
    expired: row.expires_at <= nowIso(),
    features: registryFeatures(row),
    source: row.source,
    revoked: isRevoked(row),
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    notes: row.notes,
    backupQuotaBytes: row.backup_quota_bytes,
    tenant: row.tenant_id
      ? { id: row.tenant_id, name: row.tenant_name, status: row.tenant_status }
      : null,
    lastSeenAt: row.pos_last_seen_at,
    appVersion: row.pos_app_version,
    installId: row.install_id,
    health: healthView(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Imzali anahtar gizli degildir (imza saticinin) ama listede tasinmaz; ayrintida doner.
    ...(withKey ? { licenseKey: row.license_key } : {}),
  };
}

async function licenseDetail(db: D1Database, id: string): Promise<LicenseListRow> {
  const row = await db.prepare(`${LICENSE_SELECT} WHERE l.id = ?`).bind(id).first<LicenseListRow>();
  if (!row) throw new ApiError(404, 'LICENSE_NOT_FOUND', 'Lisans kayıtlı değil.');
  return row;
}

adminRoutes.get('/licenses', async (c) => {
  const { results } = await c.env.DB.prepare(
    `${LICENSE_SELECT} ORDER BY l.updated_at DESC`,
  ).all<LicenseListRow>();
  return ok(
    c,
    results.map((row) => licenseView(row)),
  );
});

adminRoutes.get('/licenses/:id', async (c) =>
  ok(c, licenseView(await licenseDetail(c.env.DB, c.req.param('id')), { withKey: true })),
);

// Lisans kaydet (Faz B admin paneli): imza LICENSE_PUBLIC_KEY listesiyle dogrulanir, kimlik sart.
// Kayit geri gitmez (daha gec bitisli anahtar kayitliysa o kalir; `applied: false`). Isletme varsa
// ad, paket, ozellik ve bitisi yeni anahtardan yazilir; POS yeni anahtari heartbeat'te alir.
adminRoutes.put('/licenses', async (c) => {
  const body = await readJson(
    c,
    z.object({
      licenseKey: z.string().trim().min(20).max(4096),
      notes: z.string().trim().max(1000).optional(),
    }),
  );
  const license = await requireUsableLicense(c.env, body.licenseKey, {
    requireQrMenu: false,
    allowExpired: true,
  });
  const db = c.env.DB;
  const id = license.payload.id;
  const before = await findLicense(db, id);
  const tenant = await db
    .prepare('SELECT * FROM tenants WHERE license_id = ?')
    .bind(id)
    .first<TenantRow>();
  const now = nowIso();
  const stored = await upsertLicense(
    db,
    {
      payload: license.payload,
      licenseKey: body.licenseKey,
      expiresAt: license.expiresAt,
      source: 'admin',
      tenantId: tenant?.id ?? null,
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    },
    now,
  );
  const applied = stored.license_key === body.licenseKey;
  if (tenant && applied) await applyLicenseToTenant(db, tenant.id, stored, now);
  return ok(
    c,
    { ...licenseView(await licenseDetail(db, id), { withKey: true }), applied },
    before ? 200 : 201,
  );
});

// Lisansi iptal et (calinan lisans, iade, sozlesme sonu): baglanma ve yenileme 403
// LICENSE_REVOKED, heartbeat 'revoked' der, yayin durur ve menu ile masalar yayindan kalkar.
// POS belirteci korunur (durumu heartbeat'le ogrenir). Isletme silinse de iptal kalir.
adminRoutes.post('/licenses/:id/revoke', async (c) => {
  const body = await readOptionalJson(
    c,
    z.object({ reason: z.string().trim().min(1).max(500).optional() }),
  );
  const db = c.env.DB;
  const id = c.req.param('id');
  if (!(await findLicense(db, id))) {
    throw new ApiError(
      404,
      'LICENSE_NOT_FOUND',
      'Lisans kayıtlı değil. Önce PUT /api/admin/licenses ile kaydedin.',
    );
  }
  const now = nowIso();
  const branches = `SELECT b.id FROM branches b JOIN tenants t ON t.id = b.tenant_id
                    WHERE t.license_id = ?1`;
  await db.batch([
    db
      .prepare(
        `UPDATE licenses SET revoked_at = COALESCE(revoked_at, ?2),
           revoke_reason = COALESCE(?3, revoke_reason), updated_at = ?2
         WHERE id = ?1`,
      )
      .bind(id, now, body.reason ?? null),
    db.prepare(`DELETE FROM menus WHERE branch_id IN (${branches})`).bind(id),
    db.prepare(`DELETE FROM tables WHERE branch_id IN (${branches})`).bind(id),
  ]);
  return ok(c, licenseView(await licenseDetail(db, id)));
});

// Iptali kaldir: POS bir sonraki heartbeat'te 'active' gorur ve (QR menu aciksa) yeniden yayinlar.
adminRoutes.post('/licenses/:id/unrevoke', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const row = await db
    .prepare(
      `UPDATE licenses SET revoked_at = NULL, revoke_reason = NULL, updated_at = ?
       WHERE id = ? RETURNING id`,
    )
    .bind(nowIso(), id)
    .first<{ id: string }>();
  if (!row) throw new ApiError(404, 'LICENSE_NOT_FOUND', 'Lisans kayıtlı değil.');
  return ok(c, licenseView(await licenseDetail(db, id)));
});
