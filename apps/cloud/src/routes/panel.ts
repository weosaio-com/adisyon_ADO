import { Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { z } from 'zod';
import { MENU_LIMITS, menuSnapshotSchema } from '@ado/shared/menu';
import type { AppEnv } from '../env';
import {
  burnPasswordCheck,
  hashPassword,
  newPairingCode,
  randomToken,
  sha256Hex,
  verifyPassword,
} from '../lib/crypto';
import { branchSummaries, tableView, tenantById, type BranchRow, type TableRow } from '../lib/db';
import { ApiError, nowIso, ok, readJson } from '../lib/http';
import { newTableCode, readImageBody, saveMenu, storeImage } from '../lib/menu-store';
import { PLANS, tenantFeatures, type PlanId } from '../lib/plans';
import { limit } from '../lib/rate-limit';

/**
 * Isletme paneli: POS'suz isletme menusunu buradan yonetir; POS'lu isletme durumu gorur ve POS
 * eslestirme kodu alir. Oturum HttpOnly cerezde; durum degistiren istekler CSRF korumali.
 */
export const panelRoutes = new Hono<AppEnv>();

export const SESSION_COOKIE = '__Host-ado_session';
const SESSION_DAYS = 30;
const PAIRING_MINUTES = 15;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Geçerli bir e-posta girin.')
  .max(200);
export const passwordSchema = z
  .string()
  .min(10, 'Parola en az 10 karakter olmalı.')
  .max(128, 'Parola en fazla 128 karakter olabilir.');

panelRoutes.use('*', csrf());

panelRoutes.post('/login', async (c) => {
  const body = await readJson(c, z.object({ email: emailSchema, password: z.string().max(128) }));
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  await limit(c.env.DB, [`login:ip:${ip}`, `login:email:${body.email}`], 10, 15 * 60);

  const user = await c.env.DB.prepare(
    'SELECT id, tenant_id, password_hash FROM users WHERE email = ?',
  )
    .bind(body.email)
    .first<{ id: string; tenant_id: string; password_hash: string }>();
  const valid = user
    ? await verifyPassword(body.password, user.password_hash)
    : await burnPasswordCheck(body.password);
  if (!user || !valid) {
    throw new ApiError(401, 'LOGIN_FAILED', 'E-posta ya da parola hatalı.');
  }

  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    ).bind(await sha256Hex(token), user.id, expires.toISOString(), now.toISOString()),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(
      user.id,
      now.toISOString(),
    ),
  ]);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });
  return ok(c, { email: body.email });
});

const session: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const row = token
    ? await c.env.DB.prepare(
        `SELECT u.id, u.email, u.tenant_id FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
        .bind(await sha256Hex(token), nowIso())
        .first<{ id: string; email: string; tenant_id: string }>()
    : null;
  if (!row) throw new ApiError(401, 'SESSION_REQUIRED', 'Oturum açmanız gerekiyor.');
  c.set('user', { id: row.id, email: row.email, tenantId: row.tenant_id });
  await next();
};

panelRoutes.use('/logout', session);
panelRoutes.use('/me', session);
panelRoutes.use('/password', session);
panelRoutes.use('/branches/*', session);

panelRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(await sha256Hex(token))
      .run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
  return ok(c, { loggedOut: true });
});

panelRoutes.get('/me', async (c) => {
  const user = c.get('user');
  const tenant = await tenantById(c.env.DB, user.tenantId);
  if (!tenant) throw new ApiError(401, 'SESSION_REQUIRED', 'Oturum açmanız gerekiyor.');
  return ok(c, {
    user: { email: user.email },
    tenant: {
      name: tenant.name,
      plan: tenant.plan,
      planLabel: PLANS[tenant.plan as PlanId]?.label ?? tenant.plan,
      status: tenant.status,
      features: tenantFeatures(tenant),
    },
    branches: await branchSummaries(c.env.DB, tenant.id),
  });
});

panelRoutes.post('/password', async (c) => {
  const user = c.get('user');
  const body = await readJson(
    c,
    z.object({ currentPassword: z.string().max(128), newPassword: passwordSchema }),
  );
  await limit(c.env.DB, [`password:user:${user.id}`], 10, 15 * 60);
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) {
    throw new ApiError(403, 'PASSWORD_INVALID', 'Mevcut parola hatalı.');
  }
  // Parola degisince diger cihazlardaki oturumlar kapanir (bu oturum acik kalir).
  const current = await sha256Hex(getCookie(c, SESSION_COOKIE) ?? '');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(
      await hashPassword(body.newPassword),
      nowIso(),
      user.id,
    ),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(
      user.id,
      current,
    ),
  ]);
  return ok(c, { changed: true });
});

// -----------------------------------------------------------------------------
// Sube kapsamli uclar: /branches/:branchId/...
// -----------------------------------------------------------------------------

const branchAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  const branch = await c.env.DB.prepare('SELECT * FROM branches WHERE id = ? AND tenant_id = ?')
    .bind(c.req.param('branchId'), c.get('user').tenantId)
    .first<BranchRow>();
  if (!branch) throw new ApiError(404, 'BRANCH_NOT_FOUND', 'Şube bulunamadı.');
  c.set('branch', branch);
  await next();
};
panelRoutes.use('/branches/:branchId/*', branchAccess);

function assertPanelManaged(branch: BranchRow, what: 'menu' | 'tables'): void {
  if (branch.source === 'pos') {
    throw new ApiError(
      409,
      what === 'menu' ? 'MENU_MANAGED_BY_POS' : 'TABLES_MANAGED_BY_POS',
      what === 'menu'
        ? 'Bu şubenin menüsü adisyon programından (POS) yönetiliyor.'
        : 'Bu şubenin masaları adisyon programından (POS) yönetiliyor.',
    );
  }
}

panelRoutes.get('/branches/:branchId/menu', async (c) => {
  const branch = c.get('branch');
  const row = await c.env.DB.prepare(
    'SELECT version, snapshot, updated_at FROM menus WHERE branch_id = ?',
  )
    .bind(branch.id)
    .first<{ version: number; snapshot: string; updated_at: string }>();
  return ok(c, {
    source: branch.source,
    version: row?.version ?? null,
    updatedAt: row?.updated_at ?? null,
    menu: row ? (JSON.parse(row.snapshot) as unknown) : null,
  });
});

panelRoutes.put('/branches/:branchId/menu', async (c) => {
  const branch = c.get('branch');
  assertPanelManaged(branch, 'menu');
  const body = await readJson(
    c,
    z.object({ baseVersion: z.number().int().positive().nullable(), menu: menuSnapshotSchema }),
  );
  return ok(c, await saveMenu(c.env, branch.id, body.menu, body.baseVersion));
});

panelRoutes.post('/branches/:branchId/images', async (c) => {
  const key = await storeImage(c.env, await readImageBody(c.req.raw));
  return ok(c, { key }, 201);
});

const tableInput = z.object({
  name: z.string().trim().min(1, 'Masa adı gerekli.').max(MENU_LIMITS.tableName),
  hall: z.string().trim().max(MENU_LIMITS.hallName).default(''),
});

panelRoutes.get('/branches/:branchId/tables', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM tables WHERE branch_id = ? ORDER BY sort_order, name',
  )
    .bind(c.get('branch').id)
    .all<TableRow>();
  return ok(c, results.map(tableView));
});

panelRoutes.post('/branches/:branchId/tables', async (c) => {
  const branch = c.get('branch');
  assertPanelManaged(branch, 'tables');
  const body = await readJson(c, tableInput);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM tables WHERE branch_id = ?')
    .bind(branch.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MENU_LIMITS.tables) {
    throw new ApiError(409, 'TABLE_LIMIT', `En fazla ${MENU_LIMITS.tables} masa eklenebilir.`);
  }
  const now = nowIso();
  const row = await c.env.DB.prepare(
    `INSERT INTO tables (id, branch_id, code, name, hall, sort_order, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5,
       (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tables WHERE branch_id = ?2), ?6, ?6)
     RETURNING *`,
  )
    .bind(crypto.randomUUID(), branch.id, newTableCode(), body.name, body.hall, now)
    .first<TableRow>();
  return ok(c, row ? tableView(row) : null, 201);
});

async function tableOrThrow(db: D1Database, branchId: string, id: string): Promise<TableRow> {
  const row = await db
    .prepare('SELECT * FROM tables WHERE id = ? AND branch_id = ?')
    .bind(id, branchId)
    .first<TableRow>();
  if (!row) throw new ApiError(404, 'TABLE_NOT_FOUND', 'Masa bulunamadı.');
  return row;
}

panelRoutes.patch('/branches/:branchId/tables/:tableId', async (c) => {
  const branch = c.get('branch');
  assertPanelManaged(branch, 'tables');
  const table = await tableOrThrow(c.env.DB, branch.id, c.req.param('tableId'));
  const body = await readJson(c, tableInput.partial());
  const row = await c.env.DB.prepare(
    'UPDATE tables SET name = ?, hall = ?, updated_at = ? WHERE id = ? RETURNING *',
  )
    .bind(body.name ?? table.name, body.hall ?? table.hall, nowIso(), table.id)
    .first<TableRow>();
  return ok(c, row ? tableView(row) : null);
});

panelRoutes.delete('/branches/:branchId/tables/:tableId', async (c) => {
  const branch = c.get('branch');
  assertPanelManaged(branch, 'tables');
  const table = await tableOrThrow(c.env.DB, branch.id, c.req.param('tableId'));
  await c.env.DB.prepare('DELETE FROM tables WHERE id = ?').bind(table.id).run();
  return ok(c, { deleted: true });
});

// Kod yenilenince masadaki eski QR artik menuyu acmaz (QR yeniden basilmali).
panelRoutes.post('/branches/:branchId/tables/:tableId/rotate', async (c) => {
  const branch = c.get('branch');
  assertPanelManaged(branch, 'tables');
  const table = await tableOrThrow(c.env.DB, branch.id, c.req.param('tableId'));
  const row = await c.env.DB.prepare(
    'UPDATE tables SET code = ?, updated_at = ? WHERE id = ? RETURNING *',
  )
    .bind(newTableCode(), nowIso(), table.id)
    .first<TableRow>();
  return ok(c, row ? tableView(row) : null);
});

export async function createPairingCode(db: D1Database, branchId: string) {
  const code = newPairingCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PAIRING_MINUTES * 60_000).toISOString();
  // Subenin yalniz son kodu gecerli.
  await db.batch([
    db.prepare('DELETE FROM pairing_codes WHERE branch_id = ?').bind(branchId),
    db
      .prepare(
        'INSERT INTO pairing_codes (code_hash, branch_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      )
      .bind(await sha256Hex(code), branchId, expiresAt, now.toISOString()),
  ]);
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
}

panelRoutes.post('/branches/:branchId/pairing-code', async (c) =>
  ok(c, await createPairingCode(c.env.DB, c.get('branch').id), 201),
);

// POS baglantisini panelden kaldir: menu ve masalar panelden duzenlenebilir olur.
panelRoutes.delete('/branches/:branchId/pos', async (c) => {
  const branch = c.get('branch');
  await c.env.DB.prepare(
    `UPDATE branches SET source = 'panel', pos_token_hash = NULL, pos_paired_at = NULL,
       pos_last_seen_at = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(nowIso(), branch.id)
    .run();
  return ok(c, { unpaired: true });
});
