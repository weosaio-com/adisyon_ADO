import type { HeartbeatResponse } from '@ado/shared/cloud-api';
import type { LicensePayload } from '@ado/shared/license';
import type { LicenseRow, TenantRow } from './db';
import { ApiError } from './http';
import { licenseExpired, licenseFeatureOverrides, planFromLicense } from './plans';

export type LicenseRemoteState = HeartbeatResponse['remote']['state'];

/**
 * Lisans kaydi (0004_license_registry.sql) yardimcilari. Etkinlestirme, yenileme, heartbeat ve
 * satici API'si ayni kayda bakar; iptal edilen lisans isletme silinse bile yeniden baglanamaz.
 *
 * Kural: kayittaki anahtar GERI GITMEZ. Sunulan anahtar yalniz bitisi (exp + ek sure) kayittakinden
 * daha gec ya da esitse yerine gecer; isletmenin ad, paket, ozellik ve bitisi kayittaki gecerli
 * anahtardan yazilir. Boylece eski anahtarla baglanan POS daha yeni lisansi heartbeat'te alir.
 */

export type LicenseSource = LicenseRow['source'];

/** Kimlige gore lisans kaydi; yoksa null. */
export async function findLicense(db: D1Database, id: string): Promise<LicenseRow | null> {
  return db.prepare('SELECT * FROM licenses WHERE id = ?').bind(id).first<LicenseRow>();
}

/** Kayit iptal edilmis mi (kayit yoksa iptal sayilmaz). */
export function isRevoked(row: Pick<LicenseRow, 'revoked_at'> | null): boolean {
  return Boolean(row?.revoked_at);
}

export function licenseRevokedError(): ApiError {
  return new ApiError(
    403,
    'LICENSE_REVOKED',
    'Bu lisans satıcı tarafından iptal edildi. Satıcınıza başvurun.',
  );
}

export interface RegistryWrite {
  /** Imzasi dogrulanmis payload (kimlikli). */
  payload: LicensePayload & { id: string };
  licenseKey: string;
  /** licenseExpiresAtUtc (ISO). */
  expiresAt: string;
  source: LicenseSource;
  /** Bilinen isletme (yoksa kayittaki korunur). */
  tenantId?: string | null;
  /** Satici notu (yalniz satici API'si; verilmezse korunur). */
  notes?: string | null;
}

/**
 * Lisansi kayda yazar ve kayittaki GECERLI satiri dondurur. Anahtar yalniz bitisi daha gec ya da
 * esitse degisir; kaynak (`source`) yalniz anahtar degistiginde guncellenir (anahtari ilk kim getirdi).
 * Tum karar tek SQL'de: ayni anda gelen iki yazim da geri gidemez.
 */
export async function upsertLicense(
  db: D1Database,
  input: RegistryWrite,
  now: string = new Date().toISOString(),
): Promise<LicenseRow> {
  const { payload } = input;
  // SQLite'ta SET ifadeleri eski satir degerleriyle hesaplanir: `licenses.*` guncelleme oncesidir.
  const newer = 'excluded.expires_at >= licenses.expires_at';
  const changed = `${newer} AND excluded.license_key <> licenses.license_key`;
  const row = await db
    .prepare(
      `INSERT INTO licenses (id, tenant_id, license_key, customer, plan, exp, grace_days,
         expires_at, features, source, notes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
       ON CONFLICT (id) DO UPDATE SET
         tenant_id = COALESCE(excluded.tenant_id, licenses.tenant_id),
         license_key = CASE WHEN ${newer} THEN excluded.license_key ELSE licenses.license_key END,
         customer = CASE WHEN ${newer} THEN excluded.customer ELSE licenses.customer END,
         plan = CASE WHEN ${newer} THEN excluded.plan ELSE licenses.plan END,
         exp = CASE WHEN ${newer} THEN excluded.exp ELSE licenses.exp END,
         grace_days = CASE WHEN ${newer} THEN excluded.grace_days ELSE licenses.grace_days END,
         features = CASE WHEN ${newer} THEN excluded.features ELSE licenses.features END,
         source = CASE WHEN ${changed} THEN excluded.source ELSE licenses.source END,
         expires_at = CASE WHEN ${newer} THEN excluded.expires_at ELSE licenses.expires_at END,
         notes = COALESCE(excluded.notes, licenses.notes),
         updated_at = excluded.updated_at
       RETURNING *`,
    )
    .bind(
      payload.id,
      input.tenantId ?? null,
      input.licenseKey,
      payload.c,
      payload.p ?? null,
      payload.exp,
      payload.g ?? 0,
      input.expiresAt,
      JSON.stringify(payload.f ?? {}),
      input.source,
      input.notes ?? null,
      now,
    )
    .first<LicenseRow>();
  if (!row) throw new ApiError(500, 'LICENSE_SAVE_FAILED', 'Lisans kaydedilemedi.');
  return row;
}

/** Kayittaki ozellik haritasi (bozuksa bos). */
export function registryFeatures(row: Pick<LicenseRow, 'features'>): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(row.features);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
      ),
    );
  } catch {
    return {};
  }
}

/** Isletmenin lisanstan gelen alanlari (ad, paket, ozellik istisnalari, bitis). */
export function tenantFieldsFromLicense(row: LicenseRow) {
  const features = registryFeatures(row);
  return {
    name: row.customer,
    plan: planFromLicense(features),
    features: JSON.stringify(licenseFeatureOverrides(features)),
    licenseExpiresAt: row.expires_at,
  };
}

/** Kayittaki gecerli lisansi isletmeye yazar (yenileme, satici kaydi). */
export async function applyLicenseToTenant(
  db: D1Database,
  tenantId: string,
  row: LicenseRow,
  now: string = new Date().toISOString(),
): Promise<TenantRow | null> {
  const fields = tenantFieldsFromLicense(row);
  return db
    .prepare(
      `UPDATE tenants SET name = ?, plan = ?, features = ?, license_expires_at = ?, updated_at = ?
       WHERE id = ? RETURNING *`,
    )
    .bind(fields.name, fields.plan, fields.features, fields.licenseExpiresAt, now, tenantId)
    .first<TenantRow>();
}

/**
 * Heartbeat'te POS'a bildirilen uzak durum: iptal > askida > suresi dolmus > etkin.
 * (Askiya alma isletmenin, iptal lisansin uzerindedir.)
 */
export function remoteState(
  registered: Pick<LicenseRow, 'revoked_at'> | null,
  tenant: Pick<TenantRow, 'status' | 'license_expires_at'>,
  now = new Date(),
): LicenseRemoteState {
  if (isRevoked(registered)) return 'revoked';
  if (tenant.status === 'suspended') return 'suspended';
  if (licenseExpired(tenant, now)) return 'expired';
  return 'active';
}

/**
 * Heartbeat yenilemesi: kayitta POS'unkiyle AYNI kimlikli ve bitis gunu (`exp`) daha gec bir anahtar
 * varsa o anahtar. POS kurdugu anahtari `license.activated` ile geri bildirir; ayni ya da daha eski
 * anahtar gonderilmez, dongu olmaz. Iptal edilmis lisans yenilenmez.
 */
export function pendingUpdate(
  registered: Pick<LicenseRow, 'id' | 'exp' | 'license_key' | 'revoked_at'> | null,
  posLicenseId: string | null,
  posLicenseExp: string | null,
): string | undefined {
  if (!registered || isRevoked(registered) || !posLicenseId || !posLicenseExp) return undefined;
  if (registered.id !== posLicenseId) return undefined;
  return registered.exp > posLicenseExp ? registered.license_key : undefined;
}
