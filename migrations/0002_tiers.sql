-- 0002_tiers.sql
-- Tier + platform fee columns for creators

PRAGMA foreign_keys = ON;

ALTER TABLE creators
  ADD COLUMN current_tier INTEGER NOT NULL DEFAULT 1;

ALTER TABLE creators
  ADD COLUMN platform_fee_bps INTEGER NOT NULL DEFAULT 500;

ALTER TABLE creators
  ADD COLUMN tier_last_promotion_at TEXT;
