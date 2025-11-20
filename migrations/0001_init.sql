-- 0001_init.sql
-- Initial schema for KunTips

PRAGMA foreign_keys = ON;

-- Creators table: one row per creator profile
CREATE TABLE IF NOT EXISTS creators (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE,          -- public slug, e.g. "miaxx"
  display_name    TEXT NOT NULL,                 -- pretty name shown on page
  bio             TEXT DEFAULT '',               -- short description
  avatar_url      TEXT DEFAULT '',               -- R2 or external URL
  psp_subaccount_id TEXT DEFAULT '',             -- CCBill subaccount or similar
  is_active       INTEGER NOT NULL DEFAULT 0,    -- 0 = not live, 1 = live
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tips table: one row per tip
CREATE TABLE IF NOT EXISTS tips (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id           INTEGER NOT NULL,
  tip_amount_intended  INTEGER NOT NULL,   -- in cents, e.g. 1000 = $10
  total_charged        INTEGER NOT NULL,   -- in cents (tip + processor fee)
  currency             TEXT NOT NULL DEFAULT 'USD',
  psp_tx_id            TEXT NOT NULL,      -- payment processor transaction id
  status               TEXT NOT NULL,      -- 'PENDING', 'APPROVED', 'FAILED'
  tipped_at            TEXT NOT NULL DEFAULT (datetime('now')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (creator_id) REFERENCES creators(id)
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_tips_creator_id ON tips (creator_id);
CREATE INDEX IF NOT EXISTS idx_tips_status ON tips (status);
