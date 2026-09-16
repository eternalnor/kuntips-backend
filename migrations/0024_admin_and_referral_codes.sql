-- 0024_admin_and_referral_codes.sql
-- Admin panel foundation: admin_users + admin_sessions, and trackable referral_codes.

PRAGMA foreign_keys = ON;

-- 1) Admin users (separate from creators)
CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- 2) Admin sessions (mirrors creator_sessions pattern)
CREATE TABLE IF NOT EXISTS admin_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id     INTEGER NOT NULL,
  username     TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at   TEXT NOT NULL,
  FOREIGN KEY (admin_id) REFERENCES admin_users(id)
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_token_hash
  ON admin_sessions (token_hash);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id
  ON admin_sessions (admin_id);

-- 3) Trackable referral codes
CREATE TABLE IF NOT EXISTS referral_codes (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  code                 TEXT UNIQUE NOT NULL,
  description          TEXT,
  referrer_creator_id  INTEGER,
  is_active            INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_admin_id  INTEGER,
  FOREIGN KEY (referrer_creator_id) REFERENCES creators(id),
  FOREIGN KEY (created_by_admin_id) REFERENCES admin_users(id)
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_code
  ON referral_codes (code);

CREATE INDEX IF NOT EXISTS idx_referral_codes_is_active
  ON referral_codes (is_active);

-- 4) Track which code (if any) a creator signed up with
ALTER TABLE creators ADD COLUMN signup_code TEXT;

CREATE INDEX IF NOT EXISTS idx_creators_signup_code
  ON creators (signup_code);
