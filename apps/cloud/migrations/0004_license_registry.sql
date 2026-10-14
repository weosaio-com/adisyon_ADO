-- Lisans kaydi (registry): saticinin verdigi lisanslar, son imzali anahtar ve iptal durumu.
-- Etkinlestirme ve yenileme buraya yazar; satici API'si (sonra admin paneli) kayit ekler ya da
-- iptal eder. POS heartbeat'te daha yeni anahtari buradan alir. 0001-0003'e dokunulmaz.

CREATE TABLE licenses (
  -- Lisanstaki `id` (lic_...): yenilemede ayni kalir.
  id TEXT PRIMARY KEY,
  -- Isletme silinse de kayit (ozellikle iptal) kalir: iptal edilen lisans yeniden baglanamaz.
  tenant_id TEXT REFERENCES tenants (id) ON DELETE SET NULL,
  -- Imzali anahtarin tamami: POS'a yenileme olarak gonderilir (gizli degil; imza saticinin).
  license_key TEXT NOT NULL,
  -- Lisanstaki alanlar: c (musteri), p (plan), exp, g (ek gun), f (ozellikler, JSON).
  customer TEXT NOT NULL,
  plan TEXT,
  exp TEXT NOT NULL,
  grace_days INTEGER NOT NULL DEFAULT 0,
  -- exp gununun UTC basi + g gun (ISO 8601; licenseExpiresAtUtc).
  expires_at TEXT NOT NULL,
  features TEXT NOT NULL DEFAULT '{}',
  -- Kaydi kim yazdi: POS'un etkinlestirmesi, POS'un yenilemesi ya da satici.
  source TEXT NOT NULL CHECK (source IN ('activation', 'renewal', 'admin')),
  issued_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT,
  notes TEXT,
  -- Bulut yedegi kotasi (bayt). NULL = Worker'daki varsayilan.
  backup_quota_bytes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX licenses_tenant ON licenses (tenant_id);

-- POS'un saatlik heartbeat'te bildirdigi saglik bilgileri (yalniz son deger tutulur).
ALTER TABLE branches ADD COLUMN health_reported_at TEXT;
ALTER TABLE branches ADD COLUMN health_db_bytes INTEGER;
ALTER TABLE branches ADD COLUMN health_backups_bytes INTEGER;
ALTER TABLE branches ADD COLUMN health_free_disk_bytes INTEGER;
ALTER TABLE branches ADD COLUMN health_last_backup_at TEXT;
ALTER TABLE branches ADD COLUMN health_last_cloud_backup_at TEXT;
ALTER TABLE branches ADD COLUMN health_license_exp TEXT;
