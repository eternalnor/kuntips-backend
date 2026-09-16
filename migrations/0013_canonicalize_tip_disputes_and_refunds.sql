PRAGMA foreign_keys = OFF;

-- =========================
-- Canonical tip_disputes
-- =========================
CREATE TABLE IF NOT EXISTS tip_disputes_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id TEXT NOT NULL UNIQUE,
  tip_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  payment_intent_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  fee_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  fee_applied_minor INTEGER NOT NULL DEFAULT 0,
  fee_applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tip_id) REFERENCES tips(id),
  FOREIGN KEY (creator_id) REFERENCES creators(id)
);

-- Copy from existing tip_disputes if it exists
-- (works whether it came from 0008/0009/0010, as long as the table exists)
INSERT INTO tip_disputes_v2 (
  id,
  dispute_id,
  tip_id,
  creator_id,
  payment_intent_id,
  amount_minor,
  fee_minor,
  status,
  fee_applied_minor,
  fee_applied_at,
  created_at,
  updated_at
)
SELECT
  td.id,
  td.dispute_id,
  td.tip_id,
  COALESCE(td.creator_id, (SELECT t.creator_id FROM tips t WHERE t.id = td.tip_id)),
  COALESCE(td.payment_intent_id, (SELECT t.psp_tx_id FROM tips t WHERE t.id = td.tip_id)),
  COALESCE(td.amount_minor, 0),
  COALESCE(td.fee_minor, 0),
  td.status,
  COALESCE(td.fee_applied_minor, 0),
  td.fee_applied_at,
  td.created_at,
  td.updated_at
FROM tip_disputes td
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='tip_disputes');


DROP TABLE IF EXISTS tip_disputes;
ALTER TABLE tip_disputes_v2 RENAME TO tip_disputes;

CREATE INDEX IF NOT EXISTS idx_tip_disputes_tip_id ON tip_disputes(tip_id);
CREATE INDEX IF NOT EXISTS idx_tip_disputes_dispute_id ON tip_disputes(dispute_id);
CREATE INDEX IF NOT EXISTS idx_tip_disputes_payment_intent_id ON tip_disputes(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_tip_disputes_creator_id ON tip_disputes(creator_id);

-- =========================
-- Canonical tip_refunds
-- =========================
CREATE TABLE IF NOT EXISTS tip_refunds_v2 (
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

INSERT INTO tip_refunds_v2 (
  id, refund_id, tip_id, creator_id, payment_intent_id, amount_minor, status, reason, created_at, updated_at
)
SELECT
  tr.id, tr.refund_id, tr.tip_id, tr.creator_id, tr.payment_intent_id, tr.amount_minor, tr.status, tr.reason, tr.created_at, tr.updated_at
FROM tip_refunds tr
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='tip_refunds');


DROP TABLE IF EXISTS tip_refunds;
ALTER TABLE tip_refunds_v2 RENAME TO tip_refunds;

CREATE INDEX IF NOT EXISTS idx_tip_refunds_tip_id ON tip_refunds(tip_id);
CREATE INDEX IF NOT EXISTS idx_tip_refunds_refund_id ON tip_refunds(refund_id);
CREATE INDEX IF NOT EXISTS idx_tip_refunds_payment_intent_id ON tip_refunds(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_tip_refunds_creator_id ON tip_refunds(creator_id);

PRAGMA foreign_keys = ON;
