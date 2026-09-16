ALTER TABLE tips ADD COLUMN charge_id TEXT;
ALTER TABLE tips ADD COLUMN transfer_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tips_charge_id ON tips(charge_id);
CREATE INDEX IF NOT EXISTS idx_tips_transfer_id ON tips(transfer_id);
