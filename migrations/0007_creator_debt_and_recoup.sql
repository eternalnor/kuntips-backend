-- 0007_creator_debt_and_recoup.sql
PRAGMA foreign_keys = ON;

-- How much this creator currently owes KunTips (in minor units, NOK øre).
-- 0 = no debt; >0 = we should claw this back from future tips.
ALTER TABLE creators
  ADD COLUMN creator_debt_minor INTEGER NOT NULL DEFAULT 0;

-- How much debt was recouped on this specific tip.
-- This is for bookkeeping / dashboard, and to make the webhook idempotent.
ALTER TABLE tips
  ADD COLUMN recouped_debt_minor INTEGER NOT NULL DEFAULT 0;
