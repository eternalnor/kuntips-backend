-- 0010_tip_disputes_patch.sql
PRAGMA foreign_keys = ON;

-- Ensure tip_disputes exists (older envs should already have it from 0008/0009).
-- If it doesn't exist, create it in the "full" shape we actually want.
CREATE TABLE IF NOT EXISTS tip_disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id TEXT NOT NULL UNIQUE,
  tip_id INTEGER NOT NULL,
  creator_id INTEGER,
  payment_intent_id TEXT,
  status TEXT NOT NULL,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  fee_minor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tip_id) REFERENCES tips(id),
  FOREIGN KEY (creator_id) REFERENCES creators(id)
);

-- Patch old tip_disputes tables that were created without these columns.
ALTER TABLE tip_disputes ADD COLUMN creator_id INTEGER;
ALTER TABLE tip_disputes ADD COLUMN payment_intent_id TEXT;

-- Backfill where possible from tips.
UPDATE tip_disputes
SET creator_id = (
  SELECT tips.creator_id
  FROM tips
  WHERE tips.id = tip_disputes.tip_id
)
WHERE creator_id IS NULL;

UPDATE tip_disputes
SET payment_intent_id = (
  SELECT tips.psp_tx_id
  FROM tips
  WHERE tips.id = tip_disputes.tip_id
)
WHERE payment_intent_id IS NULL;

-- Keep the useful index (0008 adds idx_tip_disputes_tip_id, but this is safe).
CREATE INDEX IF NOT EXISTS idx_tip_disputes_tip_id ON tip_disputes(tip_id);
CREATE INDEX IF NOT EXISTS idx_tip_disputes_dispute_id ON tip_disputes(dispute_id);
CREATE INDEX IF NOT EXISTS idx_tip_disputes_payment_intent_id ON tip_disputes(payment_intent_id);

-- tip_refunds table (0009 currently creates this in your repo, but we make it reliable)
CREATE TABLE IF NOT EXISTS tip_refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_id TEXT NOT NULL UNIQUE,
  tip_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  payment_intent_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tip_id) REFERENCES tips(id),
  FOREIGN KEY (creator_id) REFERENCES creators(id)
);

CREATE INDEX IF NOT EXISTS idx_tip_refunds_tip_id ON tip_refunds(tip_id);
CREATE INDEX IF NOT EXISTS idx_tip_refunds_refund_id ON tip_refunds(refund_id);
CREATE INDEX IF NOT EXISTS idx_tip_refunds_payment_intent_id ON tip_refunds(payment_intent_id);
