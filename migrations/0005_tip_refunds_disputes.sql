-- 0005_tip_refunds_disputes.sql

ALTER TABLE tips
ADD COLUMN refund_amount_minor INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tips
ADD COLUMN refund_status TEXT;

ALTER TABLE tips
ADD COLUMN refund_reason TEXT;

ALTER TABLE tips
ADD COLUMN dispute_status TEXT;

ALTER TABLE tips
ADD COLUMN dispute_amount_minor INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tips
ADD COLUMN dispute_fee_minor INTEGER NOT NULL DEFAULT 0;
