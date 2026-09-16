// src/db/stripeAccountState.ts
//
// Single source of truth for "can this creator actually receive money?".
//
// The old definition — `psp_subaccount_id IS NOT NULL` — was written the moment
// a creator clicked Connect, so it counted clicks rather than completions. These
// helpers persist what Stripe actually reports and give every caller one
// consistent answer.

import type Stripe from "stripe";
import type { Env } from "../env";
import { getStripe } from "../stripeClient";

export type StripeAccountState = {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /**
   * The `transfers` capability. THIS is what decides whether a creator can
   * receive a tip, because tips are destination charges. payoutsEnabled only
   * decides whether they can withdraw to a bank.
   */
  transfersActive: boolean;
  requirementsDue: string[];
};

/** Reduce a Stripe account object down to the bits we store. */
export function readAccountState(account: Stripe.Account): StripeAccountState {
  const req = account.requirements;
  const due = [
    ...((req?.currently_due as string[] | undefined) ?? []),
    ...((req?.past_due as string[] | undefined) ?? []),
  ];
  return {
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled: account.payouts_enabled === true,
    detailsSubmitted: account.details_submitted === true,
    transfersActive: account.capabilities?.transfers === "active",
    // de-duplicate; past_due is usually a subset of currently_due
    requirementsDue: Array.from(new Set(due)),
  };
}

/**
 * Persist account state against a creator. Sets the completion timestamp the
 * first time payouts become enabled, and never clears it afterwards.
 */
export async function persistAccountState(
  env: Env,
  creatorId: number,
  state: StripeAccountState,
): Promise<void> {
  await env.kuntips_db
    .prepare(
      `
      UPDATE creators
      SET
        stripe_charges_enabled = ?,
        stripe_payouts_enabled = ?,
        stripe_details_submitted = ?,
        stripe_transfers_active = ?,
        stripe_requirements_due = ?,
        stripe_state_synced_at = datetime('now'),
        stripe_onboarding_completed_at = CASE
          WHEN ? = 1 AND stripe_onboarding_completed_at IS NULL
            THEN datetime('now')
          ELSE stripe_onboarding_completed_at
        END
      WHERE id = ?
      `,
    )
    .bind(
      state.chargesEnabled ? 1 : 0,
      state.payoutsEnabled ? 1 : 0,
      state.detailsSubmitted ? 1 : 0,
      state.transfersActive ? 1 : 0,
      JSON.stringify(state.requirementsDue),
      // "Onboarding complete" means they can actually take money.
      state.transfersActive ? 1 : 0,
      creatorId,
    )
    .run();
}

/** Find the creator that owns a given Stripe connected-account id. */
export async function findCreatorIdByStripeAccount(
  env: Env,
  stripeAccountId: string,
): Promise<number | null> {
  const row = (await env.kuntips_db
    .prepare(`SELECT id FROM creators WHERE psp_subaccount_id = ? LIMIT 1`)
    .bind(stripeAccountId)
    .first()) as { id: number } | null;
  return row?.id ?? null;
}

/**
 * Pull the current state from Stripe and store it.
 *
 * Only call this while a creator is still onboarding — once payouts are
 * enabled the webhook keeps things current and this extra API round-trip on
 * every dashboard load is wasted. Never throws; tracking must not break the
 * dashboard.
 */
export async function syncAccountFromStripe(
  env: Env,
  creatorId: number,
  stripeAccountId: string,
): Promise<StripeAccountState | null> {
  try {
    return await syncAccountFromStripeOrThrow(env, creatorId, stripeAccountId);
  } catch (err) {
    console.error(
      `[stripeAccountState] sync failed creator=${creatorId} account=${stripeAccountId}:`,
      err,
    );
    return null;
  }
}

/**
 * Same as above but throws. Used by the backfill, which must be able to report
 * which creators failed — a silently-swallowed error there would leave a
 * creator stuck at "never synced" with nobody knowing.
 */
export async function syncAccountFromStripeOrThrow(
  env: Env,
  creatorId: number,
  stripeAccountId: string,
): Promise<StripeAccountState> {
  const stripe = getStripe(env);
  // Correct as written for a connected account: the acct_ id goes in the path.
  // Do NOT pass { stripeAccount } here — that is for acting *as* the account.
  const account = await stripe.accounts.retrieve(stripeAccountId);
  const state = readAccountState(account as Stripe.Account);
  await persistAccountState(env, creatorId, state);
  return state;
}
