-- QR menu bulutu (QR-1): isletme, sube, panel kullanicilari, POS eslestirme, menu, masa, gorsel.
-- Zaman damgalari ISO 8601 metin. Gizli degerler (POS belirteci, oturum, eslestirme kodu)
-- yalniz SHA-256 ozetiyle, parolalar PBKDF2 ile saklanir.

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL,
  -- Plan disi ozellik acma/kapama: {"qr.order": true}
  features TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Menuyu kim yonetir: panel (POS'suz isletme) ya da pos (eslestirilmis POS yayinlar).
  source TEXT NOT NULL DEFAULT 'panel' CHECK (source IN ('panel', 'pos')),
  pos_token_hash TEXT UNIQUE,
  pos_paired_at TEXT,
  pos_last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX branches_tenant ON branches (tenant_id);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX users_tenant ON users (tenant_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Tek kullanimlik, kisa omurlu: POS eslesince silinir.
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX pairing_codes_branch ON pairing_codes (branch_id);

-- Sube basina tek menu anlik goruntusu (@ado/shared MenuSnapshot JSON).
CREATE TABLE menus (
  branch_id TEXT PRIMARY KEY REFERENCES branches (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tables (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  -- QR'daki /m/<kod>; tum isletmeler arasinda benzersiz.
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  hall TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tables_branch ON tables (branch_id);

-- R2'deki gorseller (anahtar icerik ozetidir). Menu kaydedilirken varligi buradan denetlenir.
CREATE TABLE images (
  key TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
