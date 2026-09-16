// src/payouts/payoutStripe.ts
import type Stripe from "stripe";
import type { Env } from "../env";
import { getStripe } from "../stripeClient";

export async function tryCreateStripePayoutForPayoutId(params: {
  env: Env;
  payoutId: number;
}): Promise<
  | {
      ok: true;
      stripe_payout_id: string;
      stripe_balance_txn_id: string | null;
    }
  | {
      ok: false;
      reason: string;
      message: string;
    }
> {
  const { env, payoutId } = params;

  const payoutRow = await env.kuntips_db
    .prepare(
      `
      SELECT
        id,
        creator_id,
        status,
        currency,
        payout_amount_minor,
        stripe_payout_id
      FROM payouts
      WHERE id = ?
      LIMIT 1
      `,
    )
    .bind(payoutId)
    .first<{
      id: number;
      creator_id: number;
      status: string;
      currency: string;
      payout_amount_minor: number;
      stripe_payout_id: string | null;
    }>();

  if (!payoutRow?.id) {
    return {
      ok: false,
      reason: "payout_not_found",
      message: "Payout row not found.",
    };
  }

  if (payoutRow.stripe_payout_id) {
    // Already created on Stripe (idempotent “ok”)
    return {
      ok: true,
      stripe_payout_id: payoutRow.stripe_payout_id,
      stripe_balance_txn_id: null,
    };
  }

  if (payoutRow.status !== "requested") {
    return {
      ok: false,
      reason: "payout_not_requestable",
      message: `Payout status must be 'requested' to process. Got '${payoutRow.status}'.`,
    };
  }

  const creatorRow = await env.kuntips_db
    .prepare(
      `
      SELECT psp_subaccount_id
      FROM creators
      WHERE id = ?
      LIMIT 1
      `,
    )
    .bind(payoutRow.creator_id)
    .first<{ psp_subaccount_id: string | null }>();

  const stripeAccountId =
    typeof creatorRow?.psp_subaccount_id === "string" &&
    creatorRow.psp_subaccount_id.trim()
      ? creatorRow.psp_subaccount_id.trim()
      : null;

  if (!stripeAccountId) {
    await env.kuntips_db
      .prepare(
        `
        UPDATE payouts
        SET
          failure_reason = 'creator_missing_stripe_account',
          updated_at = datetime('now')
        WHERE id = ?
        `,
      )
      .bind(payoutId)
      .run();

    return {
      ok: false,
      reason: "creator_missing_stripe_account",
      message: "Creator has no connected Stripe account (psp_subaccount_id is missing).",
    };
  }

  const amountMinor = Number(payoutRow.payout_amount_minor ?? 0);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    return {
      ok: false,
      reason: "invalid_payout_amount",
      message: `Invalid payout_amount_minor: ${payoutRow.payout_amount_minor}`,
    };
  }

  const currency = (payoutRow.currency ?? "NOK").toLowerCase();

  const stripe = getStripe(env);

  // Optional but useful: check connected account is payout-ready
  try {
    const acct = await stripe.accounts.retrieve(stripeAccountId);
    if ((acct as any)?.payouts_enabled === false) {
      await env.kuntips_db
        .prepare(
          `
          UPDATE payouts
          SET
            failure_reason = 'stripe_payouts_disabled',
            updated_at = datetime('now')
          WHERE id = ?
          `,
        )
        .bind(payoutId)
        .run();

      return {
        ok: false,
        reason: "stripe_payouts_disabled",
        message: "Stripe connected account payouts_enabled=false (onboarding incomplete or restricted).",
      };
    }
  } catch (e: any) {
    // Don’t hard-fail if Stripe account retrieve fails; we can still try creating payout
    console.warn("[payout] accounts.retrieve failed", e?.message ?? e);
  }

  let stripePayout: Stripe.Payout;

  try {
    stripePayout = await stripe.payouts.create(
      {
        amount: amountMinor,
        currency,
        metadata: {
          kuntips_payout_id: String(payoutId),
          kuntips_creator_id: String(payoutRow.creator_id),
        },
      },
      {
        stripeAccount: stripeAccountId,
      },
    );
  } catch (e: any) {
    const msg = e?.message ?? String(e);

    await env.kuntips_db
      .prepare(
        `
        UPDATE payouts
        SET
          failure_reason = ?,
          updated_at = datetime('now')
        WHERE id = ?
        `,
      )
      .bind(`stripe_payout_create_failed: ${msg}`.slice(0, 400), payoutId)
      .run();

    return {
      ok: false,
      reason: "stripe_payout_create_failed",
      message: msg,
    };
  }

  const stripePayoutId = stripePayout.id;
  const balanceTxnId =
    typeof stripePayout.balance_transaction === "string"
      ? stripePayout.balance_transaction
      : stripePayout.balance_transaction?.id ?? null;

  await env.kuntips_db
    .prepare(
      `
      UPDATE payouts
      SET
        status = 'processing',
        stripe_payout_id = ?,
        stripe_balance_txn_id = ?,
        processed_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?
        AND stripe_payout_id IS NULL
      `,
    )
    .bind(stripePayoutId, balanceTxnId, payoutId)
    .run();

  return {
    ok: true,
    stripe_payout_id: stripePayoutId,
    stripe_balance_txn_id: balanceTxnId,
  };
}
