CREATE TABLE IF NOT EXISTS tip_disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tip_id INTEGER NOT NULL,
  dispute_id TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  fee_minor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dispute_id),
  FOREIGN KEY (tip_id) REFERENCES tips(id)
);

CREATE INDEX IF NOT EXISTS idx_tip_disputes_tip_id ON tip_disputes(tip_id);
