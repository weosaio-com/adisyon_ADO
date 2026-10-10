-- Lisansla etkinlestirme: POS, imzali lisansiyla buluta kendisi baglanir (eslestirme kodu ve
-- panel gerekmez). 0001'e dokunulmaz; yalniz ekleme yapilir.

-- Lisans kimligi (lisanstaki `id`): isletme bununla taninir, yenilemede ayni kalir.
-- SQLite ADD COLUMN UNIQUE tasiyamaz; benzersizlik ayri indeksle (NULL'lar birbirinden farkli).
ALTER TABLE tenants ADD COLUMN license_id TEXT;
CREATE UNIQUE INDEX tenants_license_id ON tenants (license_id);
-- Lisansin bitis ani (exp + ek sure, UTC ISO 8601). NULL = lisanssiz (eski panel kiracisi).
ALTER TABLE tenants ADD COLUMN license_expires_at TEXT;

-- Baglanan kurulum (POS'taki ado-install.json), POS'un kendi sube kimligi ve surumu.
ALTER TABLE branches ADD COLUMN install_id TEXT;
ALTER TABLE branches ADD COLUMN pos_branch_id TEXT;
ALTER TABLE branches ADD COLUMN pos_app_version TEXT;

-- Gecersiz kilinan POS belirtecleri (yalniz ozet): POS'a NEDENINI soyleyebilmek icin.
-- rotated: ayni kurulum yeniden baglandi · superseded: baska kurulum devraldi ·
-- revoked: satici kaldirdi · unpaired: POS "QR menuyu kapat" dedi.
CREATE TABLE pos_token_revocations (
  token_hash TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('rotated', 'superseded', 'revoked', 'unpaired')),
  created_at TEXT NOT NULL
);
CREATE INDEX pos_token_revocations_branch ON pos_token_revocations (branch_id);
