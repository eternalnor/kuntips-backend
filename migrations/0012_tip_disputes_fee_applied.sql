PRAGMA foreign_keys = ON;

-- Track whether this specific dispute's fee has been applied to creator debt.
ALTER TABLE tip_disputes ADD COLUMN fee_applied_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tip_disputes ADD COLUMN fee_applied_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tip_disputes_fee_applied_minor ON tip_disputes(fee_applied_minor);
