/**
 * D1 satir turleri (migrations/0001_init.sql, 0002_license_activation.sql, 0003_remove_panel.sql,
 * 0004_license_registry.sql, 0005_cloud_backups.sql).
 */
export interface TenantRow {
  id: string;
  name: string;
  plan: string;
  features: string;
  status: 'active' | 'suspended';
  /** Lisans kimligi (isletme bununla taninir; 0003'ten sonra her kiracida dolu). */
  license_id: string | null;
  /** Lisans bitis ani (exp + ek sure, UTC ISO). */
  license_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BranchRow {
  id: string;
  tenant_id: string;
  name: string;
  pos_token_hash: string | null;
  pos_paired_at: string | null;
  pos_last_seen_at: string | null;
  install_id: string | null;
  pos_branch_id: string | null;
  pos_app_version: string | null;
  // Saatlik heartbeat saglik bilgisi (0004; yalniz son deger).
  health_reported_at: string | null;
  health_db_bytes: number | null;
  health_backups_bytes: number | null;
  health_free_disk_bytes: number | null;
  health_last_backup_at: string | null;
  health_last_cloud_backup_at: string | null;
  health_license_exp: string | null;
  created_at: string;
  updated_at: string;
}

/** Lisans kaydi (0004). */
export interface LicenseRow {
  id: string;
  tenant_id: string | null;
  license_key: string;
  customer: string;
  plan: string | null;
  exp: string;
  grace_days: number;
  expires_at: string;
  /** JSON: {"qr.menu": true} */
  features: string;
  source: 'activation' | 'renewal' | 'admin';
  issued_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  notes: string | null;
  backup_quota_bytes: number | null;
  created_at: string;
  updated_at: string;
}

/** Bulut yedegi kaydi (0005); dosyanin kendisi R2 BACKUPS'ta `r2_key` altinda. */
export interface CloudBackupRow {
  id: string;
  license_id: string;
  tenant_id: string | null;
  branch_id: string | null;
  install_id: string | null;
  pos_backup_id: string;
  r2_key: string;
  backup_type: 'auto' | 'manual' | 'pre_update';
  format: number;
  size_bytes: number;
  sha256: string;
  pos_created_at: string;
  status: 'uploading' | 'complete';
  upload_id: string | null;
  part_size: number | null;
  created_at: string;
  completed_at: string | null;
}

/** Kisa omurlu indirme jetonu (0005; yalniz ozeti). */
export interface CloudBackupDownloadRow {
  token_hash: string;
  backup_id: string;
  expires_at: string;
  created_at: string;
}

export interface TableRow {
  id: string;
  branch_id: string;
  code: string;
  name: string;
  hall: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface MenuRow {
  branch_id: string;
  version: number;
  snapshot: string;
  updated_at: string;
}

export async function tenantById(db: D1Database, id: string): Promise<TenantRow | null> {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').bind(id).first<TenantRow>();
}

export async function menuMeta(
  db: D1Database,
  branchId: string,
): Promise<{ version: number; updatedAt: string } | null> {
  const row = await db
    .prepare('SELECT version, updated_at FROM menus WHERE branch_id = ?')
    .bind(branchId)
    .first<{ version: number; updated_at: string }>();
  return row ? { version: row.version, updatedAt: row.updated_at } : null;
}

/** POS'un son heartbeat'te bildirdigi saglik bilgisi (satici API'si); hic bildirmediyse null. */
export type HealthColumns = Pick<
  BranchRow,
  | 'health_reported_at'
  | 'health_db_bytes'
  | 'health_backups_bytes'
  | 'health_free_disk_bytes'
  | 'health_last_backup_at'
  | 'health_last_cloud_backup_at'
  | 'health_license_exp'
>;

export function healthView(row: HealthColumns) {
  if (!row.health_reported_at) return null;
  return {
    reportedAt: row.health_reported_at,
    dbBytes: row.health_db_bytes,
    backupsBytes: row.health_backups_bytes,
    freeDiskBytes: row.health_free_disk_bytes,
    lastBackupAt: row.health_last_backup_at,
    lastCloudBackupAt: row.health_last_cloud_backup_at,
    licenseExp: row.health_license_exp,
  };
}

/** Sube ozeti (satici API'si): bagli POS, son gorulme, surum, saglik, menu. */
export async function branchSummaries(db: D1Database, tenantId: string) {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.name, b.pos_paired_at, b.pos_last_seen_at, b.pos_app_version, b.install_id,
              b.health_reported_at, b.health_db_bytes, b.health_backups_bytes,
              b.health_free_disk_bytes, b.health_last_backup_at, b.health_last_cloud_backup_at,
              b.health_license_exp,
              m.version AS menu_version, m.updated_at AS menu_updated_at,
              (SELECT COUNT(*) FROM tables t WHERE t.branch_id = b.id) AS table_count
       FROM branches b LEFT JOIN menus m ON m.branch_id = b.id
       WHERE b.tenant_id = ? ORDER BY b.created_at`,
    )
    .bind(tenantId)
    .all<
      HealthColumns & {
        id: string;
        name: string;
        pos_paired_at: string | null;
        pos_last_seen_at: string | null;
        pos_app_version: string | null;
        install_id: string | null;
        menu_version: number | null;
        menu_updated_at: string | null;
        table_count: number;
      }
    >();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    pos: row.pos_paired_at
      ? {
          pairedAt: row.pos_paired_at,
          lastSeenAt: row.pos_last_seen_at,
          appVersion: row.pos_app_version,
          installId: row.install_id,
        }
      : null,
    health: healthView(row),
    menu: row.menu_version ? { version: row.menu_version, updatedAt: row.menu_updated_at } : null,
    tableCount: row.table_count,
  }));
}
