// src/payouts/payoutPreview.ts
import type { Env } from "../env";
import { getCreatorPayoutEligibility } from "./payoutEligibility";

type TipRow = {
  id: number;
  psp_tx_id: string;
  tip_amount_intended: number;
  total_charged: number;
  platform_fee_minor: number;
  creator_net_minor: number;
  currency: string;
  status: string;
  created_at: string;
  charge_id: string | null;
  transfer_id: string | null;
};

export async function getCreatorPayoutPreview(params: {
  env: Env;
  creatorId: number;
}): Promise<{
  eligible: boolean;
  next_eligible_at: string;
  reason?: string;

  creator_debt_minor: number;

  eligible_tips: TipRow[];
  eligible_tip_count: number;
  eligible_tip_amount_intended_minor: number;
  eligible_total_charged_minor: number;
  eligible_creator_net_minor: number;

  pending_tip_count: number;
  next_tip_becomes_eligible_at: string | null;
}> {
  const { env, creatorId } = params;

  const gate = await getCreatorPayoutEligibility(env, creatorId);

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

  const creatorDebtMinor = creatorRow?.creator_debt_minor ?? 0;

  const eligibleTips = await env.kuntips_db
    .prepare(
      `
      SELECT
        id,
        psp_tx_id,
        tip_amount_intended,
        total_charged,
        platform_fee_minor,
        creator_net_minor,
        currency,
        status,
        created_at,
        charge_id,
        transfer_id
      FROM tips
      WHERE creator_id = ?
        AND payout_id IS NULL
        AND status IN ('succeeded', 'dispute_won')
        AND (refund_status IS NULL OR refund_status != 'succeeded')
        AND datetime(created_at) <= datetime('now', '-7 days')
      ORDER BY datetime(created_at) ASC
      `,
    )
    .bind(creatorId)
    .all<TipRow>();

  const eligibleTipRows = eligibleTips?.results ?? [];

  const computeNetMinor = (t: TipRow) => {
    const net = Number(t.creator_net_minor ?? 0);
    if (net > 0) return net;

    return Math.max(
      0,
      Number(t.total_charged ?? 0) - Number(t.platform_fee_minor ?? 0),
    );
  };

  let eligibleTipAmountIntendedMinor = 0;
  let eligibleTotalChargedMinor = 0;
  let eligibleCreatorNetMinor = 0;

  for (const t of eligibleTipRows) {
    eligibleTipAmountIntendedMinor += Number(t.tip_amount_intended ?? 0);
    eligibleTotalChargedMinor += Number(t.total_charged ?? 0);
    eligibleCreatorNetMinor += computeNetMinor(t);
  }

  const pendingCountRow = await env.kuntips_db
    .prepare(
      `
      SELECT COUNT(*) AS cnt
      FROM tips
      WHERE creator_id = ?
        AND payout_id IS NULL
        AND status IN ('succeeded', 'dispute_won')
        AND (refund_status IS NULL OR refund_status != 'succeeded')
        AND datetime(created_at) > datetime('now', '-7 days')
      `,
    )
    .bind(creatorId)
    .first<{ cnt: number }>();

  const pendingTipCount = Number(pendingCountRow?.cnt ?? 0);

  const newestPendingRow = await env.kuntips_db
    .prepare(
      `
      SELECT created_at
      FROM tips
      WHERE creator_id = ?
        AND payout_id IS NULL
        AND status IN ('succeeded', 'dispute_won')
        AND (refund_status IS NULL OR refund_status != 'succeeded')
        AND datetime(created_at) > datetime('now', '-7 days')
      ORDER BY datetime(created_at) DESC
      LIMIT 1
      `,
    )
    .bind(creatorId)
    .first<{ created_at: string }>();

  let nextTipBecomesEligibleAt: string | null = null;
  if (newestPendingRow?.created_at) {
    const dt = new Date(newestPendingRow.created_at);
    nextTipBecomesEligibleAt = new Date(
      dt.getTime() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
  }

  return {
    eligible: gate.eligible,
    next_eligible_at: gate.next_eligible_at,
    reason: gate.reason,

    creator_debt_minor: creatorDebtMinor,

    eligible_tips: eligibleTipRows,
    eligible_tip_count: eligibleTipRows.length,
    eligible_tip_amount_intended_minor: eligibleTipAmountIntendedMinor,
    eligible_total_charged_minor: eligibleTotalChargedMinor,
    eligible_creator_net_minor: eligibleCreatorNetMinor,

    pending_tip_count: pendingTipCount,
    next_tip_becomes_eligible_at: nextTipBecomesEligibleAt,
  };
}
