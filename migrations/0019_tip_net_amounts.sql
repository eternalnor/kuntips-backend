-- 0019_tip_net_amounts.sql
ALTER TABLE tips ADD COLUMN platform_fee_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tips ADD COLUMN creator_net_minor INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tips_creator_payout_status_created
ON tips(creator_id, payout_id, status, created_at);
