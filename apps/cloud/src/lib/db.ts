/** D1 satir turleri (migrations/0001_init.sql, 0002_license_activation.sql). */
export interface TenantRow {
  id: string;
  name: string;
  plan: string;
  features: string;
  status: 'active' | 'suspended';
  /** Lisans kimligi; eski (panelden acilmis) kiracilarda null. */
  license_id: string | null;
  /** Lisans bitis ani (exp + ek sure, UTC ISO); lisanssiz kiracida null. */
  license_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BranchRow {
  id: string;
  tenant_id: string;
  name: string;
  source: 'panel' | 'pos';
  pos_token_hash: string | null;
  pos_paired_at: string | null;
  pos_last_seen_at: string | null;
  install_id: string | null;
  pos_branch_id: string | null;
  pos_app_version: string | null;
  created_at: string;
  updated_at: string;
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

/** Istemciye giden masa gorunumu. */
export function tableView(row: TableRow) {
  return { id: row.id, code: row.code, name: row.name, hall: row.hall, sortOrder: row.sort_order };
}

/** Sube ozeti (panel ve satici listeleri). */
export async function branchSummaries(db: D1Database, tenantId: string) {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.name, b.source, b.pos_paired_at, b.pos_last_seen_at, b.pos_app_version,
              m.version AS menu_version, m.updated_at AS menu_updated_at,
              (SELECT COUNT(*) FROM tables t WHERE t.branch_id = b.id) AS table_count
       FROM branches b LEFT JOIN menus m ON m.branch_id = b.id
       WHERE b.tenant_id = ? ORDER BY b.created_at`,
    )
    .bind(tenantId)
    .all<{
      id: string;
      name: string;
      source: 'panel' | 'pos';
      pos_paired_at: string | null;
      pos_last_seen_at: string | null;
      pos_app_version: string | null;
      menu_version: number | null;
      menu_updated_at: string | null;
      table_count: number;
    }>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    source: row.source,
    pos: row.pos_paired_at
      ? {
          pairedAt: row.pos_paired_at,
          lastSeenAt: row.pos_last_seen_at,
          appVersion: row.pos_app_version,
        }
      : null,
    menu: row.menu_version ? { version: row.menu_version, updatedAt: row.menu_updated_at } : null,
    tableCount: row.table_count,
  }));
}
