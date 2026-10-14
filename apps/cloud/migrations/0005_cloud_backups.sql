-- Otomatik bulut yedegi: POS'un sifreli yedek dosyalari R2'de (BACKUPS bucket), kayitlari burada.
-- Yedekler dukkanin kendi anahtariyla sifrelidir; bulut icerigi okuyamaz. Kayitlar lisans
-- kimligine baglidir (yabanci anahtar yok): isletme silinse de saklama ve kota kurali isler.

CREATE TABLE cloud_backups (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL,
  tenant_id TEXT REFERENCES tenants (id) ON DELETE SET NULL,
  branch_id TEXT REFERENCES branches (id) ON DELETE SET NULL,
  install_id TEXT,
  -- POS'taki yedek kaydinin kimligi: ayni yedek iki kez yuklenmez.
  pos_backup_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  backup_type TEXT NOT NULL CHECK (backup_type IN ('auto', 'manual', 'pre_update')),
  -- 1: IV + etiket + veri (eski), 2: sikistirilmis akis bicimi.
  format INTEGER NOT NULL DEFAULT 1,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  pos_created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'complete')),
  -- R2 multipart yuklemesi suruyorsa kimligi ve parca boyu.
  upload_id TEXT,
  part_size INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (license_id, pos_backup_id)
);
CREATE INDEX cloud_backups_license ON cloud_backups (license_id, status, pos_created_at);

-- Yeni bilgisayarda geri yukleme icin kisa omurlu indirme jetonlari (yalniz SHA-256 ozeti).
CREATE TABLE cloud_backup_downloads (
  token_hash TEXT PRIMARY KEY,
  backup_id TEXT NOT NULL REFERENCES cloud_backups (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX cloud_backup_downloads_expires ON cloud_backup_downloads (expires_at);
