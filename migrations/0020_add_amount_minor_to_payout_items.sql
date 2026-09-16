-- 0020_add_amount_minor_to_payout_items.sql
ALTER TABLE payout_items ADD COLUMN amount_minor INTEGER NOT NULL DEFAULT 0;
