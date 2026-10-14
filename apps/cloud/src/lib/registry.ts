import type { LicenseRow } from './db';

/**
 * Lisans kaydi (0004_license_registry.sql) yardimcilari. Etkinlestirme, yenileme, heartbeat ve
 * satici API'si ayni kayda bakar; iptal edilen lisans isletme silinse bile yeniden baglanamaz.
 */

/** Kimlige gore lisans kaydi; yoksa null. */
export async function findLicense(db: D1Database, id: string): Promise<LicenseRow | null> {
  return db.prepare('SELECT * FROM licenses WHERE id = ?').bind(id).first<LicenseRow>();
}

/** Kayit iptal edilmis mi (kayit yoksa iptal sayilmaz). */
export function isRevoked(row: Pick<LicenseRow, 'revoked_at'> | null): boolean {
  return Boolean(row?.revoked_at);
}
