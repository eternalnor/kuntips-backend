CREATE TABLE IF NOT EXISTS tip_disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id TEXT NOT NULL UNIQUE,
  tip_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  payment_intent_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  fee_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tip_id) REFERENCES tips(id),
  FOREIGN KEY (creator_id) REFERENCES creators(id)
);

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
