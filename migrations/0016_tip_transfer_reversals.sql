CREATE TABLE IF NOT EXISTS tip_transfer_reversals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_reversal_id TEXT NOT NULL UNIQUE,
  transfer_id TEXT NOT NULL,
  tip_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  payment_intent_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ttr_tip_id ON tip_transfer_reversals(tip_id);
CREATE INDEX IF NOT EXISTS idx_ttr_transfer_id ON tip_transfer_reversals(transfer_id);
CREATE INDEX IF NOT EXISTS idx_ttr_creator_id ON tip_transfer_reversals(creator_id);
