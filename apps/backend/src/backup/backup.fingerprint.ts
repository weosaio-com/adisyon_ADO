import { createHash } from 'node:crypto';
import { isVolatileSettingKey, SettingKeys } from '../settings/setting-keys';

/**
 * "Son yedekten beri veri degisti mi?" parmak izi (saf; backup.fingerprint.selfcheck.ts).
 * sqlite_master'daki her tablo icin satir sayisi + en son degisiklik ani: updated_at, yoksa
 * created_at. Isletme verisi degismeden kendiliginden degisen teknik tablolar ve gecici ayarlar
 * sayilmaz. Yalniz denetim kaydina (audit_logs) bakmak yetmez: kasa, gelir-gider, musteri ve
 * kullanici islemleri denetim kaydi yazmaz.
 */
export const FINGERPRINT_EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  'backups',
  'background_jobs',
  'sessions',
  'print_jobs',
  'processed_client_ops',
  'cloud_backup_uploads',
  '_prisma_migrations',
  '_ado_migrations',
  'sqlite_sequence',
]);

/** Gecici anahtarlari (durum, saat, son calisma) parmak izine girmeyen ayar tablosu. */
export const SETTINGS_TABLE = 'application_settings';

/** Tablo ve sutun listesi tek sorguda (table-valued pragma). */
export const FINGERPRINT_SCHEMA_SQL =
  "SELECT m.name AS t, p.name AS c FROM sqlite_master AS m JOIN pragma_table_info(m.name) AS p WHERE m.type = 'table' ORDER BY m.name, p.cid";

export interface SchemaColumnRow {
  t: string;
  c: string;
}

/** Tablo basina bir satir: ad, satir sayisi, en son degisiklik (metin; bos tablo -> null). */
export interface FingerprintRow {
  t: string;
  n: string;
  m: string | null;
}

/** Parmak izi algoritmasinin surumu: kural degisirse eski izlerle eslesmesin. */
const FINGERPRINT_VERSION = 'fp1';

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Parmak izine giren tablo mu: sqlite_ ic tablolari (sqlite_stat1...) ve teknik tablolar girmez. */
export function isFingerprintTable(name: string): boolean {
  return !name.toLowerCase().startsWith('sqlite_') && !FINGERPRINT_EXCLUDED_TABLES.has(name);
}

/** Parmak izine girmeyen ayar anahtarlari (setting-keys.ts'teki gecici anahtarlar). */
export function volatileSettingKeys(): string[] {
  return Object.values(SettingKeys).filter((key) => isVolatileSettingKey(key));
}

/**
 * Tablo basina tek SELECT, hepsi UNION ALL ile TEK ifadede: SQLite tek ifadeyi tek okuma
 * anliginda calistirir, iz tutarli olur. Sayilar ve zamanlar metne cevrilir; boylece Prisma ve
 * node:sqlite ayni degeri dondurur. Sayilacak tablo yoksa null.
 */
export function buildFingerprintQuery(
  columns: readonly SchemaColumnRow[],
  volatileKeys: readonly string[],
): { sql: string; params: string[] } | null {
  const tables = new Map<string, Set<string>>();
  for (const { t, c } of columns) {
    if (!isFingerprintTable(t)) continue;
    const set = tables.get(t) ?? new Set<string>();
    set.add(c);
    tables.set(t, set);
  }
  const parts: string[] = [];
  const params: string[] = [];
  const names = [...tables.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const table of names) {
    const cols = tables.get(table) ?? new Set<string>();
    const stamp = cols.has('updated_at')
      ? 'updated_at'
      : cols.has('created_at')
        ? 'created_at'
        : null;
    const latest = stamp ? `CAST(MAX(${quoteIdent(stamp)}) AS TEXT)` : 'NULL';
    const filterVolatile = table === SETTINGS_TABLE && cols.has('key') && volatileKeys.length > 0;
    const where = filterVolatile
      ? ` WHERE ${quoteIdent('key')} NOT IN (${volatileKeys.map(() => '?').join(', ')})`
      : '';
    parts.push(
      `SELECT ? AS t, CAST(COUNT(*) AS TEXT) AS n, ${latest} AS m FROM ${quoteIdent(table)}${where}`,
    );
    params.push(table);
    if (filterVolatile) params.push(...volatileKeys);
  }
  return parts.length > 0 ? { sql: parts.join(' UNION ALL '), params } : null;
}

/** Satirlardan sha256 (hex). Satir sirasi sonucu degistirmez. */
export function fingerprintHash(rows: readonly FingerprintRow[]): string {
  const lines = rows.map((row) => `${row.t}\t${row.n}\t${row.m ?? ''}`).sort();
  return createHash('sha256')
    .update([FINGERPRINT_VERSION, ...lines].join('\n'))
    .digest('hex');
}
