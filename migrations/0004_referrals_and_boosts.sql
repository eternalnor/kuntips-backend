-- 0004_referrals_and_boosts.sql
-- Schema for:
-- - Creator referrals (who referred whom)
-- - Referral join boost expiry
-- - Generic temporary tier boosts (e.g. December Boost)

-- =========================================================
-- 1) Track who referred whom (creator → creator)
--    and when the referral happened
-- =========================================================

CREATE TABLE IF NOT EXISTS creator_referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_creator_id INTEGER NOT NULL,
  referred_creator_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT datetime('now'),
  UNIQUE (referrer_creator_id, referred_creator_id)
);

-- Helpful index for "last 365 days" queries per referrer
CREATE INDEX IF NOT EXISTS idx_creator_referrals_referrer_created
  ON creator_referrals (referrer_creator_id, created_at);

-- =========================================================
-- 2) Extra columns on creators for referral + temporary boosts
-- =========================================================

-- Who referred this creator (if any)
ALTER TABLE creators
  ADD COLUMN referred_by_creator_id INTEGER;

-- When the referral join boost (extra +1 tier for 30 days) expires
ALTER TABLE creators
  ADD COLUMN referral_join_boost_expires_at TEXT;

-- Generic temporary tier boost (e.g. +1 or +2 tiers from events)
-- This is an offset added on top of:
--   - base earnings tier
--   - referral tier boost
-- but must always respect the global Tier 5 cap in logic.
ALTER TABLE creators
  ADD COLUMN temporary_tier_boost INTEGER NOT NULL DEFAULT 0;

-- When the generic temporary tier boost expires
ALTER TABLE creators
  ADD COLUMN temporary_tier_boost_expires_at TEXT;

-- Optional index for lookup by referrer
CREATE INDEX IF NOT EXISTS idx_creators_referred_by
  ON creators (referred_by_creator_id);
