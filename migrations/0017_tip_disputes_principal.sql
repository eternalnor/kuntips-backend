-- migrations/0010_tip_disputes_principal.sql

ALTER TABLE tip_disputes
ADD COLUMN principal_applied_minor INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tip_disputes
ADD COLUMN principal_applied_at TEXT NULL;
