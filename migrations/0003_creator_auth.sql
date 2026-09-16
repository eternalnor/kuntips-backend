-- 0003_creator_auth.sql
-- Email login + password + 2FA + sessions

PRAGMA foreign_keys = ON;

-- 1) Add login + security fields to creators
ALTER TABLE creators ADD COLUMN email TEXT;
ALTER TABLE creators ADD COLUMN password_hash TEXT;
ALTER TABLE creators ADD COLUMN password_salt TEXT;
ALTER TABLE creators ADD COLUMN twofa_secret TEXT;
ALTER TABLE creators ADD COLUMN twofa_enabled INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_creators_email
  ON creators (email);

-- 2) Creator sessions (if not already present)
CREATE TABLE IF NOT EXISTS creator_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id   INTEGER NOT NULL,
  username     TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at   TEXT NOT NULL,
  FOREIGN KEY (creator_id) REFERENCES creators(id)
);

CREATE INDEX IF NOT EXISTS idx_creator_sessions_token_hash
  ON creator_sessions (token_hash);

CREATE INDEX IF NOT EXISTS idx_creator_sessions_creator_id
  ON creator_sessions (creator_id);
