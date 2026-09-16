// src/payouts/payoutStatement.ts
// Returns the itemised tip breakdown for a single payout.
// Used by both the API statement endpoint and the payout confirmation email.

import type { Env } from "../env";

export interface PayoutStatementItem {
  tipId: number;
  tippedAt: string;
  tipperName: string | null;
  tipAmountNok: number;
  platformFeeNok: number;
  creatorNetNok: number;
  stripePaymentIntentId: string;
}

export interface PayoutStatement {
  payoutId: number;
  reference: string; // e.g. "KT-2026-42"
  status: string;
  currency: string;
  eligibleAmountMinor: number;
  debtAppliedMinor: number;
  payoutAmountMinor: number;
  stripePayoutId: string | null;
  requestedAt: string;
  paidAt: string | null;
  failedAt: string | null;
  tipCount: number;
  items: PayoutStatementItem[];
}

/** Build a human-readable reference number from a payout ID */
export function payoutReference(payoutId: number, requestedAt?: string): string {
  const year = requestedAt
    ? new Date(requestedAt).getFullYear()
    : new Date().getFullYear();
  return `KT-${year}-${String(payoutId).padStart(4, "0")}`;
}

export async function getPayoutStatement(
  env: Env,
  payoutId: number,
  creatorId: number,
): Promise<PayoutStatement | null> {
  // Fetch the payout row (scoped to this creator for security)
  const payoutRow = await env.kuntips_db
    .prepare(
      `
      SELECT
        id, status, currency,
        eligible_amount_minor, debt_applied_minor, payout_amount_minor,
        stripe_payout_id, requested_at, paid_at, failed_at
      FROM payouts
      WHERE id = ? AND creator_id = ?
      LIMIT 1
      `,
    )
    .bind(payoutId, creatorId)
    .first<{
      id: number;
      status: string;
      currency: string;
      eligible_amount_minor: number;
      debt_applied_minor: number;
      payout_amount_minor: number;
      stripe_payout_id: string | null;
      requested_at: string;
      paid_at: string | null;
      failed_at: string | null;
    }>();

  if (!payoutRow) return null;

  // Fetch itemised tips for this payout
  const itemsRes = await env.kuntips_db
    .prepare(
      `
      SELECT
        pi.tip_id,
        pi.amount_minor,
        pi.tip_amount_intended_minor,
        t.tipped_at,
        t.tipper_name,
        t.platform_fee_minor,
        t.creator_net_minor,
        t.psp_tx_id
      FROM payout_items pi
      JOIN tips t ON t.id = pi.tip_id
      WHERE pi.payout_id = ? AND pi.creator_id = ?
      ORDER BY t.tipped_at ASC
      `,
    )
    .bind(payoutId, creatorId)
    .all<{
      tip_id: number;
      amount_minor: number;
      tip_amount_intended_minor: number;
      tipped_at: string;
      tipper_name: string | null;
      platform_fee_minor: number;
      creator_net_minor: number;
      psp_tx_id: string;
    }>();

  const items: PayoutStatementItem[] = (itemsRes.results ?? []).map((row) => ({
    tipId: row.tip_id,
    tippedAt: row.tipped_at,
    tipperName: row.tipper_name ?? null,
    tipAmountNok: Math.round(row.tip_amount_intended_minor / 100),
    platformFeeNok: Math.round(row.platform_fee_minor / 100),
    creatorNetNok: Math.round((row.creator_net_minor || row.amount_minor) / 100),
    stripePaymentIntentId: row.psp_tx_id,
  }));

  return {
    payoutId: payoutRow.id,
    reference: payoutReference(payoutRow.id, payoutRow.requested_at),
    status: payoutRow.status,
    currency: payoutRow.currency ?? "NOK",
    eligibleAmountMinor: Number(payoutRow.eligible_amount_minor ?? 0),
    debtAppliedMinor: Number(payoutRow.debt_applied_minor ?? 0),
    payoutAmountMinor: Number(payoutRow.payout_amount_minor ?? 0),
    stripePayoutId: payoutRow.stripe_payout_id ?? null,
    requestedAt: payoutRow.requested_at,
    paidAt: payoutRow.paid_at ?? null,
    failedAt: payoutRow.failed_at ?? null,
    tipCount: items.length,
    items,
  };
}
