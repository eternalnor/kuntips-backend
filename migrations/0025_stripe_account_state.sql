-- 0025_stripe_account_state.sql
--
-- Until now "Stripe connected" meant only `psp_subaccount_id IS NOT NULL`,
-- which is written the instant a creator clicks Connect — before Stripe has
-- collected a single field. So an abandoned onboarding was indistinguishable
-- from a finished one: the dashboard told them they were done, they shared a
-- tip link that could not take money, and the admin funnel over-reported.
--
-- These columns store what Stripe actually reports, kept current by the
-- `account.updated` Connect webhook (and a sync on dashboard load while a
-- creator is still onboarding).

PRAGMA foreign_keys = ON;

-- Capability flags straight from the Stripe account object.
--
-- IMPORTANT distinction: tips are DESTINATION CHARGES (a PaymentIntent on the
-- platform with transfer_data.destination), so whether a creator can RECEIVE a
-- tip depends on the `transfers` capability — NOT on payouts_enabled.
-- payouts_enabled governs money leaving the connected balance for a bank, and
-- our payout schedule is manual anyway. Conflating the two would take
-- creators offline who can perfectly well accept money.
ALTER TABLE creators ADD COLUMN stripe_charges_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE creators ADD COLUMN stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE creators ADD COLUMN stripe_details_submitted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE creators ADD COLUMN stripe_transfers_active INTEGER NOT NULL DEFAULT 0;

-- NULL means "we have never asked Stripe", which is different from "Stripe said
-- no". Without this, 0 is ambiguous and every creator reads as broken until the
-- backfill lands — a platform-wide tip blackout during rollout.
ALTER TABLE creators ADD COLUMN stripe_state_synced_at TEXT;

-- Timestamps so we can measure how long onboarding takes and who stalled.
ALTER TABLE creators ADD COLUMN stripe_onboarding_started_at TEXT;
ALTER TABLE creators ADD COLUMN stripe_onboarding_completed_at TEXT;

-- Whatever Stripe still wants from the creator, stored as a JSON array so the
-- dashboard can tell them specifically what is outstanding.
ALTER TABLE creators ADD COLUMN stripe_requirements_due TEXT;

CREATE INDEX IF NOT EXISTS idx_creators_stripe_payouts_enabled
  ON creators (stripe_payouts_enabled);

CREATE INDEX IF NOT EXISTS idx_creators_stripe_transfers_active
  ON creators (stripe_transfers_active);

-- Backfill the started-at timestamp for creators who already have an account,
-- so existing rows are not treated as "never started". The capability flags
-- intentionally stay 0 until Stripe tells us otherwise — assuming they are
-- enabled is exactly the bug this migration fixes.
UPDATE creators
SET stripe_onboarding_started_at = COALESCE(stripe_onboarding_started_at, created_at)
WHERE psp_subaccount_id IS NOT NULL AND psp_subaccount_id != '';
