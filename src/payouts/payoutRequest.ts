// src/payouts/payoutRequest.ts
import type { Env } from "../env";
import { getCreatorPayoutEligibility } from "./payoutEligibility";
import { tryCreateStripePayoutForPayoutId } from "./payoutStripe";
import { sendPayoutConfirmationEmail } from "./payoutEmail";

type EligibleTipRow = {
  id: number;
  creator_id: number;
  psp_tx_id: string;
  tip_amount_intended: number;
  total_charged: number;
  platform_fee_minor: number;
  creator_net_minor: number;
  currency: string;
  status: string;
  created_at: string;
};

type PayoutRow = {
  id: number;
  status: string;
  currency: string | null;
  eligible_amount_minor: number | null;
  payout_amount_minor: number | null;
  stripe_payout_id: string | null;
};

async function getPayoutSummary(env: Env, payoutId: number): Promise<{
  itemsCount: number;
  itemsSumMinor: number;
}> {
  const row = await env.kuntips_db
    .prepare(
      `
      SELECT
        COALESCE(SUM(amount_minor), 0) AS sum_minor,
        COUNT(*) AS cnt
      FROM payout_items
      WHERE payout_id = ?
      `,
    )
    .bind(payoutId)
    .first<{ sum_minor: number; cnt: number }>();

  return {
    itemsCount: Number(row?.cnt ?? 0),
    itemsSumMinor: Number(row?.sum_minor ?? 0),
  };
}

export async function createCreatorPayoutRequest(params: {
  env: Env;
  creatorId: number;
}): Promise<
  | {
      ok: true;
      payout_id: number;
      status: "requested" | "processing";
      currency: string;
      eligible_tip_count: number;
      eligible_amount_minor: number;
      payout_amount_minor: number;
      stripe_payout_id?: string | null;
    }
  | {
      ok: false;
      reason: string;
      next_eligible_at: string;
    }
> {
  const { env, creatorId } = params;

  // 0) Housekeeping: release tips + cancel stale "creating" payouts that have 0 items.
  // Use julianday() to be robust to mixed timestamp formats.
  const stale = await env.kuntips_db
    .prepare(
      `
      SELECT id
      FROM payouts
      WHERE creator_id = ?
        AND status = 'creating'
        AND julianday(created_at) <= julianday('now') - (5.0 / 1440.0)
        AND (SELECT COUNT(*) FROM payout_items pi WHERE pi.payout_id = payouts.id) = 0
      `,
    )
    .bind(creatorId)
    .all<{ id: number }>();

  const staleIds = (stale?.results ?? [])
    .map((r) => Number(r.id))
    .filter(Boolean);

  if (staleIds.length > 0) {
    const cleanupStatements: D1PreparedStatement[] = [];

    for (const pid of staleIds) {
      cleanupStatements.push(
        env.kuntips_db
          .prepare(
            `
            UPDATE tips
            SET payout_id = NULL, updated_at = datetime('now')
            WHERE payout_id = ?
            `,
          )
          .bind(pid),
      );

      cleanupStatements.push(
        env.kuntips_db
          .prepare(
            `
            UPDATE payouts
            SET status = 'cancelled',
                failed_at = datetime('now'),
                failure_reason = 'stale_creating_timeout_released_tips',
                eligible_amount_minor = 0,
                payout_amount_minor = 0,
                updated_at = datetime('now')
            WHERE id = ? AND status = 'creating'
            `,
          )
          .bind(pid),
      );
    }

    await env.kuntips_db.batch(cleanupStatements);
  }

  // Prevent multiple simultaneous payouts per creator,
  // BUT: allow this endpoint to act as a retry mechanism for:
  //   - requested payouts that have no Stripe payout id yet
  // Also: if already processing (Stripe payout created), return that payout info.
  const inflight = await env.kuntips_db
    .prepare(
      `
      SELECT
        id,
        status,
        currency,
        eligible_amount_minor,
        payout_amount_minor,
        stripe_payout_id
      FROM payouts
      WHERE creator_id = ?
        AND status IN ('creating', 'requested', 'processing')
      ORDER BY julianday(created_at) DESC
      LIMIT 1
      `,
    )
    .bind(creatorId)
    .first<PayoutRow>();

  if (inflight?.id) {
    // If another payout is still being assembled, block.
    if (inflight.status === "creating") {
      return {
        ok: false,
        reason: "payout_already_in_progress",
        next_eligible_at: new Date().toISOString(),
      };
    }

    // If Stripe payout already exists (or status is processing), return it.
    if (inflight.status === "processing" || inflight.stripe_payout_id) {
      const { itemsCount, itemsSumMinor } = await getPayoutSummary(
        env,
        Number(inflight.id),
      );

      return {
        ok: true,
        payout_id: Number(inflight.id),
        status: "processing",
        currency: (inflight.currency ?? "NOK").toUpperCase(),
        eligible_tip_count: itemsCount,
        eligible_amount_minor: Number(inflight.eligible_amount_minor ?? itemsSumMinor ?? 0),
        payout_amount_minor: Number(inflight.payout_amount_minor ?? itemsSumMinor ?? 0),
        stripe_payout_id: inflight.stripe_payout_id,
      };
    }

    // If requested but not processed yet, retry Stripe payout creation.
    if (
      inflight.status === "requested" &&
      (!inflight.stripe_payout_id || inflight.stripe_payout_id === "")
    ) {
      const proc = await tryCreateStripePayoutForPayoutId({
        env,
        payoutId: Number(inflight.id),
      });

      if (!proc.ok) {
        return {
          ok: false,
          reason: proc.reason,
          next_eligible_at: new Date().toISOString(),
        };
      }

      const fresh = await env.kuntips_db
        .prepare(
          `
          SELECT
            id,
            status,
            currency,
            eligible_amount_minor,
            payout_amount_minor,
            stripe_payout_id
          FROM payouts
          WHERE id = ?
          LIMIT 1
          `,
        )
        .bind(inflight.id)
        .first<PayoutRow>();

      const { itemsCount, itemsSumMinor } = await getPayoutSummary(
        env,
        Number(inflight.id),
      );

      const finalCurrency = (fresh?.currency ?? inflight.currency ?? "NOK").toUpperCase();
      const finalEligible = Number(fresh?.eligible_amount_minor ?? inflight.eligible_amount_minor ?? itemsSumMinor ?? 0);
      const finalPayout = Number(fresh?.payout_amount_minor ?? inflight.payout_amount_minor ?? itemsSumMinor ?? 0);

      return {
        ok: true,
        payout_id: Number(inflight.id),
        status: fresh?.status === "processing" ? "processing" : "requested",
        currency: finalCurrency,
        eligible_tip_count: itemsCount,
        eligible_amount_minor: finalEligible,
        payout_amount_minor: finalPayout,
        stripe_payout_id: fresh?.stripe_payout_id ?? proc.stripe_payout_id ?? null,
      };
    }

    // Otherwise block.
    return {
      ok: false,
      reason: "payout_already_in_progress",
      next_eligible_at: new Date().toISOString(),
    };
  }

  // 1) Gate: 7-day hold from tip.created_at
  const gate = await getCreatorPayoutEligibility(env, creatorId);
  if (!gate.eligible) {
    return {
      ok: false,
      reason: gate.reason ?? "not_eligible",
      next_eligible_at: gate.next_eligible_at,
    };
  }

  // 2) Currency guard (prevents mixed-currency payouts).
  const currencyRows = await env.kuntips_db
    .prepare(
      `
      SELECT UPPER(COALESCE(currency, 'NOK')) AS cur, COUNT(*) AS cnt
      FROM tips
      WHERE creator_id = ?
        AND payout_id IS NULL
        AND status IN ('succeeded', 'dispute_won')
        AND (refund_status IS NULL OR refund_status != 'succeeded')
        AND datetime(created_at) <= datetime('now', '-7 days')
      GROUP BY UPPER(COALESCE(currency, 'NOK'))
      `,
    )
    .bind(creatorId)
    .all<{ cur: string; cnt: number }>();

  const distinctCurrencies = (currencyRows?.results ?? [])
    .map((r) => (r.cur ?? "").toUpperCase())
    .filter(Boolean);

  if (distinctCurrencies.length === 0) {
    return {
      ok: false,
      reason: "no_eligible_tips",
      next_eligible_at: new Date().toISOString(),
    };
  }

  if (distinctCurrencies.length > 1) {
    return {
      ok: false,
      reason: "mixed_currency_not_supported",
      next_eligible_at: new Date().toISOString(),
    };
  }

  const payoutCurrency = distinctCurrencies[0] ?? "NOK";

  // 3) Snapshot debt for audit (do NOT mutate debt here)
  const creatorRow = await env.kuntips_db
    .prepare(
      `
      SELECT creator_debt_minor
      FROM creators
      WHERE id = ?
      LIMIT 1
      `,
    )
    .bind(creatorId)
    .first<{ creator_debt_minor: number }>();

  const debtBeforeMinor = Number(creatorRow?.creator_debt_minor ?? 0);

  // 4) Create payout header in a non-final state
  const inserted = await env.kuntips_db
    .prepare(
      `
      INSERT INTO payouts (
        creator_id,
        status,
        currency,
        eligible_amount_minor,
        debt_before_minor,
        debt_applied_minor,
        payout_amount_minor,
        requested_at,
        created_at,
        updated_at
      )
      VALUES (?, 'creating', ?, 0, ?, 0, 0, datetime('now'), datetime('now'), datetime('now'))
      RETURNING id
      `,
    )
    .bind(creatorId, payoutCurrency, debtBeforeMinor)
    .first<{ id: number }>();

  const payoutId = Number(inserted?.id ?? 0);
  if (!payoutId) {
    throw new Error("Failed to create payout row (missing id).");
  }

  // 5) Claim tips FIRST (single UPDATE).
  const claimRes = await env.kuntips_db
    .prepare(
      `
      UPDATE tips
      SET payout_id = ?, updated_at = datetime('now')
      WHERE creator_id = ?
        AND payout_id IS NULL
        AND status IN ('succeeded', 'dispute_won')
        AND (refund_status IS NULL OR refund_status != 'succeeded')
        AND datetime(created_at) <= datetime('now', '-7 days')
        AND UPPER(COALESCE(currency, 'NOK')) = ?
      `,
    )
    .bind(payoutId, creatorId, payoutCurrency)
    .run();

  const claimed = Number((claimRes as any)?.meta?.changes ?? 0);

  if (claimed === 0) {
    await env.kuntips_db
      .prepare(
        `
        UPDATE payouts
        SET status = 'cancelled',
            failed_at = datetime('now'),
            failure_reason = 'race_lost_no_claim',
            eligible_amount_minor = 0,
            payout_amount_minor = 0,
            updated_at = datetime('now')
        WHERE id = ? AND status = 'creating'
        `,
      )
      .bind(payoutId)
      .run();

    return {
      ok: false,
      reason: "no_eligible_tips",
      next_eligible_at: new Date().toISOString(),
    };
  }

  // 6) Insert payout_items from the claimed tips (single INSERT...SELECT)
  await env.kuntips_db
    .prepare(
      `
      INSERT INTO payout_items (
        payout_id,
        tip_id,
        creator_id,
        payment_intent_id,
        tip_amount_intended_minor,
        total_charged_minor,
        amount_minor,
        created_at
      )
      SELECT
        ?,                                  -- payout_id
        t.id,                               -- tip_id
        ?,                                  -- creator_id
        t.psp_tx_id,                        -- payment_intent_id
        t.tip_amount_intended,
        t.total_charged,
        CASE
          WHEN COALESCE(t.creator_net_minor, 0) > 0 THEN t.creator_net_minor
          WHEN (COALESCE(t.total_charged, 0) - COALESCE(t.platform_fee_minor, 0)) > 0
            THEN (t.total_charged - t.platform_fee_minor)
          ELSE 0
        END,
        datetime('now')
      FROM tips t
      WHERE t.payout_id = ?
      `,
    )
    .bind(payoutId, creatorId, payoutId)
    .run();

  // 7) Reconcile
  const reconRow = await env.kuntips_db
    .prepare(
      `
      SELECT
        COALESCE(SUM(amount_minor), 0) AS sum_minor,
        COUNT(*) AS cnt
      FROM payout_items
      WHERE payout_id = ?
      `,
    )
    .bind(payoutId)
    .first<{ sum_minor: number; cnt: number }>();

  const itemsSumMinor = Number(reconRow?.sum_minor ?? 0);
  const itemsCount = Number(reconRow?.cnt ?? 0);

  // If items didn't insert, release tips and cancel payout
  if (itemsCount === 0) {
    const rollbackStatements: D1PreparedStatement[] = [
      env.kuntips_db
        .prepare(
          `
          UPDATE tips
          SET payout_id = NULL, updated_at = datetime('now')
          WHERE payout_id = ?
          `,
        )
        .bind(payoutId),
      env.kuntips_db
        .prepare(
          `
          UPDATE payouts
          SET status = 'cancelled',
              failed_at = datetime('now'),
              failure_reason = 'items_insert_failed_released_tips',
              eligible_amount_minor = 0,
              payout_amount_minor = 0,
              updated_at = datetime('now')
          WHERE id = ? AND status = 'creating'
          `,
        )
        .bind(payoutId),
    ];

    await env.kuntips_db.batch(rollbackStatements);

    return {
      ok: false,
      reason: "no_eligible_tips",
      next_eligible_at: new Date().toISOString(),
    };
  }

  // 8) Finalize payout header
  await env.kuntips_db
    .prepare(
      `
      UPDATE payouts
      SET status = 'requested',
          eligible_amount_minor = ?,
          payout_amount_minor = ?,
          updated_at = datetime('now')
      WHERE id = ? AND status = 'creating'
      `,
    )
    .bind(itemsSumMinor, itemsSumMinor, payoutId)
    .run();

  // 9) Immediately try to create Stripe payout (automatic processing)
  const proc = await tryCreateStripePayoutForPayoutId({
    env,
    payoutId,
  });

  if (!proc.ok) {
    // Keep payout as 'requested' so the creator can retry
    return {
      ok: false,
      reason: proc.reason,
      next_eligible_at: new Date().toISOString(),
    };
  }

  // 10) Send payout confirmation email
  await sendPayoutConfirmationEmail(env, payoutId, creatorId).catch((err) => {
    console.error("[payoutRequest] Failed to send payout email:", err);
  });

  // DB should now be 'processing' (set by tryCreateStripePayoutForPayoutId)
  return {
    ok: true,
    payout_id: payoutId,
    status: "processing",
    currency: payoutCurrency,
    eligible_tip_count: itemsCount,
    eligible_amount_minor: itemsSumMinor,
    payout_amount_minor: itemsSumMinor,
    stripe_payout_id: proc.stripe_payout_id,
  };
}
