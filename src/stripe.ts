// stripe.ts
import Stripe from "stripe";
import type { Env } from "./env";
import { corsJson } from "./http";
import { getStripe } from "./stripeClient";
import { containsBlockedContent } from "./utils/wordFilter";

import {
  getCreatorByUsername,
  createCreator,
  updateCreatorStripeAccount,
} from "./db/creators";
import { computeEffectiveTierForCreator, TIER_DEFINITIONS } from "./tier";
import { insertTipRow } from "./db/tips";
import { getSessionFromRequest } from "./db/passwordAuth";
import { getTipsSettings } from "./settings";

// --- Fee constants (mirrored in the frontend TipWidget breakdown) ---
const KUNTIPS_FEE_RATE = 500 / 10000; // 500 bps => 5%
const PROCESSOR_FEE_RATE = 0.9675;    // 3.25% (intl / worst-case)
const STRIPE_FIXED_FEE_NOK = 2;       // 2 NOK fixed fee

// --- Debt recoup headroom: application fee capped at this fraction of totalCharged ---
const HEADROOM_PCT = 0.5;

// ---------- Route handlers ----------

export async function handleCreateAccountLink(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const stripe = getStripe(env);

    // 0) Require a valid session – we never trust username from the body
    const session = await getSessionFromRequest(env, request);
    if (!session) {
      return corsJson(
        {
          error: "unauthorized",
          message: "You must be logged in to manage payouts.",
        },
        401,
      );
    }

    let body: any = null;
    try {
      body = await request.json();
    } catch {
      // ignore – body is optional, we’ll fall back to defaults
    }

    // Username is always taken from the session (lowercased)
    const username = session.username;
    const displayName =
      typeof body?.displayName === "string" && body.displayName.trim()
        ? body.displayName.trim()
        : username;

    // Optional: allow frontend to specify where to land after onboarding
    const returnUrlPath =
      typeof body?.returnUrlPath === "string" && body.returnUrlPath.trim()
        ? body.returnUrlPath.trim()
        : null;

    // 1) Find or create creator row
    let creator = await getCreatorByUsername(env, username);
    if (!creator) {
      creator = await createCreator(env, username, displayName || username);
    }

    // Require verified email before allowing Stripe onboarding
    if (!creator.email_verified) {
      return corsJson(
        {
          error: "email_not_verified",
          message:
            "Please verify your email address before connecting Stripe.",
        },
        403,
      );
    }

    let stripeAccountId: string | null =
      creator.psp_subaccount_id && creator.psp_subaccount_id !== ""
        ? creator.psp_subaccount_id
        : null;

    // 2) If no Stripe account yet, create one and store it
    if (!stripeAccountId) {
      // Prefill everything we already know. Each field left blank here is one
      // more thing the creator has to re-enter on Stripe's KYC form, which is
      // where onboarding drop-off happens.
      const account = await stripe.accounts.create({
        type: "express",
        country: "NO",
        default_currency: "nok",
        business_type: "individual",
        ...(creator.email ? { email: creator.email } : {}),
        business_profile: {
          url: `${env.FRONTEND_BASE_URL}/${creator.username}`,
          product_description: "Frivillige tips fra fans",
          mcc: "7929",
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        settings: {
          payouts: {
            schedule: {
              interval: "manual",
            },
          },
        },
        metadata: {
          kuntips_creator_id: String(creator.id),
          kuntips_username: creator.username,
        },
      });

      stripeAccountId = account.id;
      await updateCreatorStripeAccount(env, creator.id, stripeAccountId);
    }

    // 3) Create onboarding link for this account
    const refreshUrl = `${env.FRONTEND_BASE_URL}/creator-onboarding/refresh`;
    const defaultSuccess = `${env.FRONTEND_BASE_URL}/creator-onboarding/success`;

    const returnUrl = returnUrlPath
      ? `${env.FRONTEND_BASE_URL}${returnUrlPath}`
      : defaultSuccess;

    const link = await stripe.accountLinks.create({
      account: stripeAccountId,
      type: "account_onboarding",
      refresh_url: refreshUrl,
      return_url: returnUrl,
    });

    return corsJson({ url: link.url });
  } catch (err: any) {
    console.error("Error creating account link", err);
    return corsJson(
      {
        error: "unable_to_create_account_link",
        message: err?.message ?? "Unknown error",
      },
      500,
    );
  }
}


// Create a tip session – returns Stripe client_secret
export async function handleCreateTipSession(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const stripe = getStripe(env);

    let body: any = null;
    try {
      body = await request.json();
    } catch {
      // body stays null; we'll validate below
    }

    // Accept either creatorUsername (from the widget) or username
    const rawUsername =
      typeof body?.creatorUsername === "string"
        ? body.creatorUsername
        : typeof body?.username === "string"
        ? body.username
        : "";

    const username = rawUsername.trim().toLowerCase();
    const tipAmount = Number(body?.tipAmount); // in NOK

    // Optional fan display name — sanitize and cap length
    const rawTipperName =
      typeof body?.tipperName === "string" ? body.tipperName.trim() : "";
    const tipperName =
      rawTipperName.length > 0
        ? rawTipperName.slice(0, 60)
        : null;

    // Optional receipt email — basic sanity check, passed to Stripe as receipt_email
    const rawReceiptEmail =
      typeof body?.receiptEmail === "string" ? body.receiptEmail.trim() : "";
    const receiptEmail =
      rawReceiptEmail.length > 0 &&
      rawReceiptEmail.includes("@") &&
      rawReceiptEmail.includes(".")
        ? rawReceiptEmail.slice(0, 254)
        : null;

    // Marketing consent captured client-side; stored in PI metadata so the
    // webhook can decide whether to fire the server-side Purchase conversion.
    const marketingConsent = body?.marketingConsent === true;

    if (tipperName && containsBlockedContent(tipperName)) {
      return corsJson(
        {
          error: "invalid_tipper_name",
          message:
            "That name isn't allowed. Please use a different name or tip anonymously.",
        },
        400,
      );
    }

    if (!username) {
      return corsJson(
        { error: "invalid_request", message: "username is required" },
        400,
      );
    }

    if (!Number.isFinite(tipAmount)) {
      return corsJson(
        { error: "invalid_request", message: "tipAmount must be a number" },
        400,
      );
    }

    const tipsSettings = await getTipsSettings(env);
    if (tipAmount < tipsSettings.min_nok || tipAmount > tipsSettings.max_nok) {
      return corsJson(
        {
          error: "invalid_tip_amount",
          message: `tipAmount must be between ${tipsSettings.min_nok} and ${tipsSettings.max_nok} NOK`,
        },
        400,
      );
    }

    const creator = await getCreatorByUsername(env, username);
    if (!creator || !creator.is_active) {
      return corsJson(
        {
          error: "creator_not_found",
          message: "Creator does not exist or is not active",
        },
        404,
      );
    }

    if (!creator.psp_subaccount_id) {
      return corsJson(
        {
          error: "creator_not_connected",
          message: "Creator has not completed Stripe onboarding",
        },
        400,
      );
    }

    // Use effective tier fee (includes all boosts: referral, join, temp, global event)
    const defaultPlatformFeeBps = parseInt(env.PLATFORM_FEE_BPS || "500", 10);
    const effectiveTierInfo = await computeEffectiveTierForCreator(
      env.kuntips_db,
      creator.id,
      env.kuntips_rl,
    );
    const effectiveTierDef =
      TIER_DEFINITIONS.find((d) => d.tier === effectiveTierInfo.effectiveTier) ??
      TIER_DEFINITIONS[0];
    const platformFeeBps =
      effectiveTierDef.platformFeeBps >= 0
        ? effectiveTierDef.platformFeeBps
        : defaultPlatformFeeBps;

    // Convert NOK -> øre (minor units for Stripe & DB)
    const tipAmountMinor = Math.round(tipAmount * 100);
    const tipAmountNok = tipAmount; // same as tipAmountMinor / 100

    // --- Same logic as TipWidget.breakdown() ---
    // T = intended tip
    const T = tipAmountNok;

    // Total amount fan pays:
    //   totalCharged = T * (1 + KUNTIPS_FEE_RATE) / PROCESSOR_FEE_RATE + STRIPE_FIXED_FEE
    const totalChargedNok =
      (T * (1 + KUNTIPS_FEE_RATE)) / PROCESSOR_FEE_RATE +
      STRIPE_FIXED_FEE_NOK;

    // “Service fee” (processing + KunTips) = what fan pays above the intended tip
    const serviceFeeNok = totalChargedNok - T;

    // Extra KunTips cut based on creator tier
    const tipsFeeNok = (T * platformFeeBps) / 10000;

    // Convert back to øre for Stripe
    const totalChargedMinor = Math.round(totalChargedNok * 100);
    const platformFeeMinor = Math.round((serviceFeeNok + tipsFeeNok) * 100);

    const currency = "nok";

	// ------------------------------------------------------------------
	// NEW: Debt recoup model (Model B) — WITH HEADROOM (50%)
	// Goal:
	//  - Tips must always work at all sizes (100–2000 NOK)
	//  - Debt is repaid gradually over multiple tips
	//  - Never let recoup force a "minimum tip" behavior
	// ------------------------------------------------------------------

	// 1) Read current creator debt (in minor units, NOK øre)
	const debtResult = await env.kuntips_db
	  .prepare(
		`
		SELECT creator_debt_minor
		FROM creators
		WHERE id = ?
		LIMIT 1
	  `,
	  )
	  .bind(creator.id)
	  .all<{ creator_debt_minor: number }>();

	const creatorDebtMinor =
	  debtResult.results && debtResult.results[0]
		? debtResult.results[0].creator_debt_minor ?? 0
		: 0;

	// 2) HEADROOM: limit how large the application fee is allowed to be.
	// application_fee_amount <= HEADROOM_PCT of totalCharged
	const maxAppFeeAllowedMinor = Math.floor(totalChargedMinor * HEADROOM_PCT);

	// 3) Base fee (what you already calculated): platformFeeMinor
	const baseAppFeeMinor = platformFeeMinor;

	// 4) Remaining room for recoup after base fee
	const maxRecoupThisTipMinor = Math.max(0, maxAppFeeAllowedMinor - baseAppFeeMinor);

	// 5) Recoup only up to allowed room, and up to outstanding debt
	const recoupThisTipMinor = Math.max(
	  0,
	  Math.min(creatorDebtMinor, maxRecoupThisTipMinor),
	);

	// 6) Final application fee used on the PaymentIntent
	const applicationFeeWithRecoupMinor = baseAppFeeMinor + recoupThisTipMinor;

	// Safety: app fee must be > 0 and < total
	if (
	  applicationFeeWithRecoupMinor <= 0 ||
	  applicationFeeWithRecoupMinor >= totalChargedMinor
	) {
	  return corsJson(
		{
		  error: "fee_calculation_error",
		  message:
			"Calculated platform fee (with debt recoup) is invalid for this tip amount.",
		},
		500,
	  );
	}


    // ------------------------------------------------------------------
    // Create PaymentIntent as a destination charge
    // ------------------------------------------------------------------
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalChargedMinor,
      currency,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      application_fee_amount: applicationFeeWithRecoupMinor,
      ...(receiptEmail ? { receipt_email: receiptEmail } : {}),
      transfer_data: {
        destination: creator.psp_subaccount_id,
      },
      metadata: {
		  kuntips_creator_id: String(creator.id),
		  kuntips_username: creator.username,
		  tip_amount_intended_minor: String(tipAmountMinor),

		  // base fee (fan fees + tier cut) without debt
		  base_platform_fee_minor: String(platformFeeMinor),

		  // total app fee actually used in Stripe (base + recoup)
		  platform_fee_minor: String(applicationFeeWithRecoupMinor),

		  // how much of that app fee was debt recoup
		  recoup_debt_minor: String(recoupThisTipMinor),

		  // optional fan display name
		  ...(tipperName ? { tipper_name: tipperName } : {}),

		  // marketing consent for server-side Purchase conversion (webhook reads this)
		  kuntips_consent: marketingConsent ? "1" : "0",
		},
    });

    if (!paymentIntent.client_secret) {
      throw new Error("PaymentIntent missing client_secret");
    }

    // KunTips cut from the creator's share (tier fee only, not the fan-side service fee)
    const creatorPlatformFeeMinor = Math.round(tipAmountMinor * platformFeeBps / 10000);
    const creatorNetMinor = tipAmountMinor - creatorPlatformFeeMinor;

    // Log in tips table
    await insertTipRow(env, {
      creatorId: creator.id,
      tipAmountMinor,
      totalChargedMinor,
      platformFeeMinor: creatorPlatformFeeMinor,
      creatorNetMinor,
      currency: currency.toUpperCase(),
      paymentIntentId: paymentIntent.id,
      tipperName,
      // recouped_debt_minor stays 0 initially; updated on webhook
    });

    return corsJson({
      clientSecret: paymentIntent.client_secret,
      currency: currency.toUpperCase(),
      tipAmountMinor,
      totalChargedMinor,
      platformFeeMinor: applicationFeeWithRecoupMinor, // what we actually use as app fee
      recoupDebtMinor: recoupThisTipMinor,
    });
  } catch (err: any) {
    console.error("Error creating tip session", err);
    return corsJson(
      {
        error: "unable_to_create_tip_session",
        message: err?.message ?? "Unknown error",
      },
      500,
    );
  }
}

// --------- Helper to update tip status ------------

type TipStatus =
  | "created"
  | "succeeded"
  | "failed"
  | "refunded"
  | "dispute_open"
  | "dispute_lost"
  | "dispute_won";

interface TipRefundExtras {
  refundAmountMinor?: number;
  refundReason?: string | null;
  refundStatus?: string | null;
  refundedAt?: string | null;
}

/**
 * Update a tip row by its Stripe payment_intent id.
 * - Always updates: status, updated_at
 * - Optionally updates: refund_amount_minor, refund_reason, refund_status, refunded_at
 */
export async function updateTipStatusByPaymentIntentId(
  env: Env,
  paymentIntentId: string,
  status: TipStatus,
  extras?: TipRefundExtras,
) {
  let sql = `UPDATE tips SET status = ?, updated_at = datetime('now')`;
  const binds: any[] = [status];

  if (extras) {
    if (typeof extras.refundAmountMinor === "number") {
      sql += `, refund_amount_minor = ?`;
      binds.push(extras.refundAmountMinor);
    }
    if (typeof extras.refundReason !== "undefined") {
      sql += `, refund_reason = ?`;
      binds.push(extras.refundReason);
    }
    if (typeof extras.refundStatus !== "undefined") {
      sql += `, refund_status = ?`;
      binds.push(extras.refundStatus);
    }
    if (typeof extras.refundedAt !== "undefined") {
      sql += `, refunded_at = ?`;
      binds.push(extras.refundedAt);
    }
  }

  sql += ` WHERE psp_tx_id = ?`;
  binds.push(paymentIntentId);

  await env.kuntips_db.prepare(sql).bind(...binds).run();
}


// --------- Refund helper -------------------

export async function applyRefundFromStripeRefund(
  env: Env,
  refund: Stripe.Refund,
): Promise<void> {
  // refund.payment_intent can be a string, an object, or null/undefined
  const pi = refund.payment_intent as
    | string
    | Stripe.PaymentIntent
    | null
    | undefined;

  const paymentIntentId =
    typeof pi === "string"
      ? pi
      : pi && typeof pi === "object"
      ? pi.id
      : null;

  if (!paymentIntentId) {
    console.warn(
      "[Stripe webhook] Refund without payment_intent – cannot map to tip row",
      refund.id,
    );
    return;
  }

  const amount = typeof refund.amount === "number" ? refund.amount : 0;

  console.log(
    `[Stripe webhook] Refund ${refund.id} for payment_intent ${paymentIntentId} amount=${amount} status=${refund.status} reason=${refund.reason ?? "n/a"}`,
  );

  // For now we just mark the tip as refunded.
  // Later, when we add refund columns to "tips", we can extend this to store amount/status.
  await updateTipStatusByPaymentIntentId(env, paymentIntentId, "refunded");
}

// Helper: recompute dispute totals + derived status for ONE payment_intent_id
async function recomputeTipDisputeSummary(
  env: Env,
  paymentIntentId: string,
): Promise<{
  disputeCount: number;
  openCount: number;
  lostCount: number;
  totalDisputeAmountMinor: number;
  totalDisputeFeeMinor: number;
}> {
  const row = await env.kuntips_db
    .prepare(
      `
      SELECT
        COUNT(*) AS dispute_count,
        SUM(CASE WHEN status IN ('created', 'funds_withdrawn', 'funds_reinstated') THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status = 'closed_lost' THEN 1 ELSE 0 END) AS lost_count,
        COALESCE(SUM(amount_minor), 0) AS total_amount_minor,
        COALESCE(SUM(fee_minor), 0) AS total_fee_minor
      FROM tip_disputes
      WHERE payment_intent_id = ?
      `,
    )
    .bind(paymentIntentId)
    .first<{
      dispute_count: number;
      open_count: number;
      lost_count: number;
      total_amount_minor: number;
      total_fee_minor: number;
    }>();

  return {
    disputeCount: row?.dispute_count ?? 0,
    openCount: row?.open_count ?? 0,
    lostCount: row?.lost_count ?? 0,
    totalDisputeAmountMinor: row?.total_amount_minor ?? 0,
    totalDisputeFeeMinor: row?.total_fee_minor ?? 0,
  };
}

// Update dispute info + status for a given payment_intent
// NOW: totals are stored per payment_intent, status is derived (no "last write wins")
export async function setTipDisputeOpen(
  env: Env,
  paymentIntentId: string,
  _disputeAmountMinor: number | null,
  _disputeFeeMinor: number | null,
): Promise<void> {
  const nowIso = new Date().toISOString();

  const summary = await recomputeTipDisputeSummary(env, paymentIntentId);

  // If we somehow got called but have no dispute rows, do nothing.
  if (summary.disputeCount <= 0) return;

  // Derive the correct status from all disputes for this payment intent
  let derivedStatus: TipStatus;
  let disputeStatusShort: "open" | "won" | "lost";

  if (summary.openCount > 0) {
    derivedStatus = "dispute_open";
    disputeStatusShort = "open";
  } else if (summary.lostCount > 0) {
    derivedStatus = "dispute_lost";
    disputeStatusShort = "lost";
  } else {
    // All disputes closed, none lost => all won
    derivedStatus = "dispute_won";
    disputeStatusShort = "won";
  }

  await env.kuntips_db
    .prepare(
      `
      UPDATE tips
      SET
        status = ?,
        dispute_status = ?,
        dispute_amount_minor = ?,
        dispute_fee_minor = ?,
        updated_at = ?
      WHERE psp_tx_id = ?
      `,
    )
    .bind(
      derivedStatus,
      disputeStatusShort,
      summary.totalDisputeAmountMinor,
      summary.totalDisputeFeeMinor,
      nowIso,
      paymentIntentId,
    )
    .run();
}


// Mark dispute as won or lost and keep status in sync
// NOW: ignores the single "finalStatus" and derives the REAL status from ALL disputes
export async function setTipDisputeFinalStatus(
  env: Env,
  paymentIntentId: string,
  _finalStatus: "dispute_won" | "dispute_lost",
): Promise<void> {
  const nowIso = new Date().toISOString();

  const summary = await recomputeTipDisputeSummary(env, paymentIntentId);

  // If there are still open disputes, keep it open
  if (summary.disputeCount <= 0) return;

  let status: TipStatus;
  let disputeStatusShort: "open" | "won" | "lost";

  if (summary.openCount > 0) {
    status = "dispute_open";
    disputeStatusShort = "open";
  } else if (summary.lostCount > 0) {
    status = "dispute_lost";
    disputeStatusShort = "lost";
  } else {
    // Has disputes, none open, none lost => all won
    status = "dispute_won";
    disputeStatusShort = "won";
  }

  await env.kuntips_db
    .prepare(
      `
      UPDATE tips
      SET
        status = ?,
        dispute_status = ?,
        dispute_amount_minor = ?,
        dispute_fee_minor = ?,
        updated_at = ?
      WHERE psp_tx_id = ?
      `,
    )
    .bind(
      status,
      disputeStatusShort,
      summary.totalDisputeAmountMinor,
      summary.totalDisputeFeeMinor,
      nowIso,
      paymentIntentId,
    )
    .run();
}

