PRAGMA foreign_keys = ON;

-- Track whether we've already applied the principal debt for this tip/payment intent.
ALTER TABLE tips ADD COLUMN dispute_principal_applied_minor INTEGER NOT NULL DEFAULT 0;

-- Helpful for debugging/auditing (optional but good)
ALTER TABLE tips ADD COLUMN dispute_principal_applied_at TEXT;
