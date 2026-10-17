import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { sha256Hex } from './crypto';
import type { BranchRow, TenantRow } from './db';
import { ApiError } from './http';
import { licenseExpired, tenantFeatures } from './plans';
import { findLicense, isRevoked, licenseRevokedError } from './registry';

/**
 * POS belirteci (Bearer) dogrulamasi ve ortak POS yardimcilari. routes/pos.ts'ten tasindi:
 * heartbeat (A2) ve bulut yedegi (A3) uclari da ayni dogrulamayi kullanir.
 *
 * DIKKAT: Hono `use('/yol', posAuth)` YALNIZ tam yolu eslesir; alt yollar icin `'/yol/*'`
 * yazilmali ya da ara katman uca dogrudan verilmeli. Yoksa uc belirtecsiz calisir.
 */

export const POS_TOKEN_PREFIX = 'adoqr_pos_';
const APP_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,40}$/;

export type RevocationReason = 'rotated' | 'superseded' | 'revoked' | 'unpaired';

/** Surum metni gecerliyse kendisi, degilse null (baslik ve heartbeat govdesi ayni kural). */
export function validAppVersion(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return APP_VERSION_PATTERN.test(text) ? text : null;
}

/** POS surumu (X-Ado-Version): satici guncelleme yayilimini izler. Gecersizse yok sayilir. */
export function appVersion(c: Context<AppEnv>): string | null {
  return validAppVersion(c.req.header('X-Ado-Version'));
}

export function revocationError(reason: RevocationReason | undefined): ApiError {
  switch (reason) {
    case 'rotated':
      return new ApiError(401, 'POS_TOKEN_ROTATED', 'Bu bilgisayarın bulut bağlantısı yenilendi.');
    case 'superseded':
      return new ApiError(
        401,
        'POS_TOKEN_SUPERSEDED',
        'Bu lisans başka bir bilgisayarda buluta bağlandı.',
      );
    case 'revoked':
      return new ApiError(
        401,
        'POS_TOKEN_REVOKED',
        'Bulut bağlantısı satıcı tarafından kaldırıldı.',
      );
    case 'unpaired':
      return new ApiError(401, 'POS_TOKEN_UNPAIRED', 'Bulut bağlantısı kapatıldı.');
    default:
      return new ApiError(401, 'POS_TOKEN_INVALID', 'POS bağlantısı geçersiz. Yeniden bağlanın.');
  }
}

export const posAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token.startsWith(POS_TOKEN_PREFIX)) throw revocationError(undefined);
  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT b.*, t.name AS t_name, t.plan AS t_plan, t.features AS t_features,
            t.status AS t_status, t.license_id AS t_license_id,
            t.license_expires_at AS t_license_expires_at,
            t.created_at AS t_created_at, t.updated_at AS t_updated_at
     FROM branches b JOIN tenants t ON t.id = b.tenant_id
     WHERE b.pos_token_hash = ?`,
  )
    .bind(tokenHash)
    .first<
      BranchRow & {
        t_name: string;
        t_plan: string;
        t_features: string;
        t_status: TenantRow['status'];
        t_license_id: string | null;
        t_license_expires_at: string | null;
        t_created_at: string;
        t_updated_at: string;
      }
    >();
  if (!row) {
    const revoked = await c.env.DB.prepare(
      'SELECT reason FROM pos_token_revocations WHERE token_hash = ?',
    )
      .bind(tokenHash)
      .first<{ reason: RevocationReason }>();
    throw revocationError(revoked?.reason);
  }
  const {
    t_name,
    t_plan,
    t_features,
    t_status,
    t_license_id,
    t_license_expires_at,
    t_created_at,
    t_updated_at,
    ...branch
  } = row;
  c.set('pos', {
    branch,
    tenant: {
      id: branch.tenant_id,
      name: t_name,
      plan: t_plan,
      features: t_features,
      status: t_status,
      license_id: t_license_id,
      license_expires_at: t_license_expires_at,
      created_at: t_created_at,
      updated_at: t_updated_at,
    },
  });
  // "Son gorulme" (ve POS surumu) dakikada en fazla bir kez yazilir.
  const now = new Date();
  await c.env.DB.prepare(
    `UPDATE branches SET pos_last_seen_at = ?1, pos_app_version = COALESCE(?4, pos_app_version)
     WHERE id = ?2 AND (pos_last_seen_at IS NULL OR pos_last_seen_at < ?3)`,
  )
    .bind(
      now.toISOString(),
      branch.id,
      new Date(now.getTime() - 60_000).toISOString(),
      appVersion(c),
    )
    .run();
  await next();
};

/**
 * Yayin icin: lisans iptal edilmis, isletme askida, lisans dolmus ya da QR menu hakki yoksa 403
 * (belirtec gecerli kalir: POS heartbeat'le durumu ogrenmeye devam eder).
 */
export const requireActive: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { tenant } = c.get('pos');
  if (tenant.license_id && isRevoked(await findLicense(c.env.DB, tenant.license_id))) {
    throw licenseRevokedError();
  }
  if (tenant.status === 'suspended') {
    throw new ApiError(
      403,
      'TENANT_SUSPENDED',
      'İşletmenin QR menüsü askıya alınmış. Satıcınıza başvurun.',
    );
  }
  if (licenseExpired(tenant)) {
    throw new ApiError(403, 'LICENSE_EXPIRED', 'Lisansın süresi dolmuş.');
  }
  if (!tenantFeatures(tenant)['qr.menu']) {
    throw new ApiError(403, 'QR_MENU_NOT_LICENSED', 'Lisansınız QR menüyü içermiyor.');
  }
  await next();
};
