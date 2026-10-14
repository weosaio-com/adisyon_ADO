import { Hono } from 'hono';
import { z } from 'zod';
import {
  MENU_LIMITS,
  menuImageKeySchema,
  menuSnapshotSchema,
  menuTableListSchema,
} from '@ado/shared/menu';
import type { AppEnv } from '../env';
import { randomToken, sha256Hex } from '../lib/crypto';
import { menuMeta, type BranchRow, type TenantRow } from '../lib/db';
import { ApiError, nowIso, ok, readJson } from '../lib/http';
import { requireUsableLicense } from '../lib/license';
import { appVersion, POS_TOKEN_PREFIX, posAuth, requireActive } from '../lib/pos-auth';
import { missingImages, readImageBody, saveMenu, storeImage, syncTables } from '../lib/menu-store';
import {
  licenseFeatureOverrides,
  planFromLicense,
  PLANS,
  tenantFeatures,
  type PlanId,
} from '../lib/plans';
import { limit } from '../lib/rate-limit';

/**
 * POS (yerel adisyon sunucusu) API'si. POS imzali lisansiyla buluta kendisi baglanir (/activate),
 * sonra Bearer belirteciyle menu, masa ve gorsel yayinlar. Subenin menusunu yalniz POS yonetir.
 * Tasarim: QR_MENU_DESIGN.md, LICENSING.md.
 */
export const posRoutes = new Hono<AppEnv>();

// POS'taki ado-install.json kimligi (apps/backend/src/common/util/install-id.ts ile ayni desen).
const INSTALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

function posInfo(branch: BranchRow, tenant: TenantRow) {
  return {
    branch: { id: branch.id, name: branch.name },
    tenant: {
      name: tenant.name,
      status: tenant.status,
      plan: tenant.plan,
      planLabel: PLANS[tenant.plan as PlanId]?.label ?? tenant.plan,
      features: tenantFeatures(tenant),
    },
    license: tenant.license_id
      ? { id: tenant.license_id, expiresAt: tenant.license_expires_at }
      : null,
  };
}

// -----------------------------------------------------------------------------
// Lisansla etkinlestirme
// -----------------------------------------------------------------------------

const activateSchema = z.object({
  licenseKey: z.string().trim().min(20).max(4096),
  installId: z.string().regex(INSTALL_ID_PATTERN),
  posBranchId: z.string().trim().min(1).max(64).optional(),
  branchName: z.string().trim().min(1).max(MENU_LIMITS.branchName).optional(),
  // Lisans baska bir kurulumda aciksa yalniz sahibin onayiyla devralinir.
  takeover: z.boolean().optional(),
});

posRoutes.post('/activate', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  await limit(c.env.DB, [`activate:ip:${ip}`], 10, 15 * 60);
  const body = await readJson(c, activateSchema);
  const { payload, expiresAt } = await requireUsableLicense(c.env, body.licenseKey);
  await limit(c.env.DB, [`activate:license:${payload.id}`], 20, 60 * 60);

  const db = c.env.DB;
  const now = nowIso();
  // Isletme lisans kimligiyle tektir: ilk etkinlestirmede acilir, sonrakilerde ad, paket,
  // ozellikler ve bitis imzali lisanstan tazelenir (askiya alma satici kararidir, korunur).
  const tenant = await db
    .prepare(
      `INSERT INTO tenants (id, name, plan, features, status, license_id, license_expires_at,
         created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?7, ?7)
       ON CONFLICT (license_id) DO UPDATE SET name = excluded.name, plan = excluded.plan,
         features = excluded.features, license_expires_at = excluded.license_expires_at,
         updated_at = excluded.updated_at
       RETURNING *`,
    )
    .bind(
      crypto.randomUUID(),
      payload.c,
      planFromLicense(payload.f),
      JSON.stringify(licenseFeatureOverrides(payload.f)),
      payload.id,
      expiresAt,
      now,
    )
    .first<TenantRow>();
  if (!tenant) throw new ApiError(500, 'TENANT_UPSERT_FAILED', 'İşletme kaydedilemedi.');
  if (tenant.status === 'suspended') {
    throw new ApiError(
      403,
      'TENANT_SUSPENDED',
      'İşletmenin QR menüsü askıya alınmış. Satıcınıza başvurun.',
    );
  }

  const existing = await db
    .prepare('SELECT * FROM branches WHERE tenant_id = ? ORDER BY created_at LIMIT 1')
    .bind(tenant.id)
    .first<BranchRow>();
  const otherInstall =
    existing?.pos_token_hash && existing.install_id && existing.install_id !== body.installId;
  if (otherInstall && !body.takeover) {
    throw new ApiError(
      409,
      'ACTIVE_ON_OTHER_INSTALL',
      'Bu lisansla QR menü başka bir bilgisayarda açık.',
      { lastSeenAt: existing.pos_last_seen_at },
    );
  }

  const token = randomToken(POS_TOKEN_PREFIX);
  const tokenHash = await sha256Hex(token);
  const statements: D1PreparedStatement[] = [
    // Sube yoksa olustur (ayni anda iki istek iki sube acmasin).
    db
      .prepare(
        `INSERT INTO branches (id, tenant_id, name, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?4
         WHERE NOT EXISTS (SELECT 1 FROM branches WHERE tenant_id = ?2)`,
      )
      .bind(crypto.randomUUID(), tenant.id, body.branchName ?? payload.c, now),
  ];
  if (existing?.pos_token_hash) {
    // Eski belirtec neden gecersiz kaldigini POS'a soyleyebilsin.
    statements.push(
      db
        .prepare(
          `INSERT INTO pos_token_revocations (token_hash, branch_id, reason, created_at)
           VALUES (?, ?, ?, ?) ON CONFLICT (token_hash) DO NOTHING`,
        )
        .bind(existing.pos_token_hash, existing.id, otherInstall ? 'superseded' : 'rotated', now),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE branches SET pos_token_hash = ?1, pos_paired_at = ?2, pos_last_seen_at = ?2,
           install_id = ?3, pos_branch_id = ?4, pos_app_version = ?5, updated_at = ?2
         WHERE id = (SELECT id FROM branches WHERE tenant_id = ?6 ORDER BY created_at LIMIT 1)`,
      )
      .bind(tokenHash, now, body.installId, body.posBranchId ?? null, appVersion(c), tenant.id),
  );
  await db.batch(statements);

  // Ayni anda iki etkinlestirme: son yazan kazanir; kaybeden POS'a gecersiz belirtec donmesin.
  const branch = await db
    .prepare('SELECT * FROM branches WHERE pos_token_hash = ?')
    .bind(tokenHash)
    .first<BranchRow>();
  if (!branch) {
    throw new ApiError(
      409,
      'ACTIVATION_CONFLICT',
      'Aynı anda başka bir bağlanma denemesi yapıldı. Tekrar deneyin.',
    );
  }
  // Belirtec yalniz bu yanitta duz metin doner; bulutta ozeti durur.
  return ok(c, { token, ...posInfo(branch, tenant) }, 201);
});

// -----------------------------------------------------------------------------
// Belirtecle korunan uclar
// -----------------------------------------------------------------------------

posRoutes.use('/status', posAuth);
posRoutes.use('/license', posAuth);
posRoutes.use('/unpair', posAuth);
posRoutes.use('/menu', posAuth, requireActive);
posRoutes.use('/tables', posAuth, requireActive);
posRoutes.use('/images/*', posAuth, requireActive);

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

// Lisans yenileme: ayni lisans kimligi, belirtec degismez. QR menusuz lisans da kabul edilir
// (ozellik kapanir); farkli kimlik icin once kapatip yeni lisansla acmak gerekir.
posRoutes.put('/license', async (c) => {
  const { branch, tenant } = c.get('pos');
  const { licenseKey } = await readJson(
    c,
    z.object({ licenseKey: z.string().trim().min(20).max(4096) }),
  );
  const { payload, expiresAt } = await requireUsableLicense(c.env, licenseKey, {
    requireQrMenu: false,
  });
  if (payload.id !== tenant.license_id) {
    throw new ApiError(
      409,
      'LICENSE_ID_MISMATCH',
      'Bu lisans bağlı işletmenin lisansı değil. QR menüyü kapatıp yeni lisansla açın.',
    );
  }
  const updated = await c.env.DB.prepare(
    `UPDATE tenants SET name = ?, plan = ?, features = ?, license_expires_at = ?, updated_at = ?
     WHERE id = ? RETURNING *`,
  )
    .bind(
      payload.c,
      planFromLicense(payload.f),
      JSON.stringify(licenseFeatureOverrides(payload.f)),
      expiresAt,
      nowIso(),
      tenant.id,
    )
    .first<TenantRow>();
  return ok(c, posInfo(branch, updated ?? tenant));
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

// "QR menuyu kapat": menu ve masalar yayindan kalkar (musteri QR'i gecersiz gorur), belirtec
// iptal edilir, kurulum baglantisi cozulur. Yeniden acinca POS ayni masa kodlarini yayinlar.
posRoutes.post('/unpair', async (c) => {
  const { branch } = c.get('pos');
  const db = c.env.DB;
  const now = nowIso();
  await db.batch([
    db.prepare('DELETE FROM menus WHERE branch_id = ?').bind(branch.id),
    db.prepare('DELETE FROM tables WHERE branch_id = ?').bind(branch.id),
    db
      .prepare(
        `INSERT INTO pos_token_revocations (token_hash, branch_id, reason, created_at)
         VALUES (?, ?, 'unpaired', ?) ON CONFLICT (token_hash) DO NOTHING`,
      )
      .bind(branch.pos_token_hash, branch.id, now),
    db
      .prepare(
        `UPDATE branches SET pos_token_hash = NULL, pos_paired_at = NULL, pos_last_seen_at = NULL,
           install_id = NULL, updated_at = ? WHERE id = ?`,
      )
      .bind(now, branch.id),
  ]);
  return ok(c, { unpaired: true });
});
