// src/payouts/payoutEligibility.ts
import type { Env } from "../env";

export async function getCreatorPayoutEligibility(
  env: Env,
  creatorId: number,
): Promise<{
  eligible: boolean;
  next_eligible_at: string;
  reason?: string;
}> {
  // 1) If ANY qualifying tip is already >= 7 days old, we are eligible now.
  const eligibleRow = await env.kuntips_db
    .prepare(
      `
      SELECT id
      FROM tips
      WHERE creator_id = ?
        AND status IN ('succeeded', 'dispute_won')
        AND (refund_status IS NULL OR refund_status != 'succeeded')
        AND datetime(created_at) <= datetime('now', '-7 days')
      LIMIT 1
      `,
    )
    .bind(creatorId)
    .first<{ id: number }>();

  if (eligibleRow?.id) {
    return {
      eligible: true,
      next_eligible_at: new Date().toISOString(),
    };
  }

  // 2) Otherwise, find the most recent qualifying tip (within last 7 days)
  // and compute when it becomes eligible.
  const newestPending = await env.kuntips_db
    .prepare(
      `
      SELECT created_at
      FROM tips
      WHERE creator_id = ?
        AND status IN ('succeeded', 'dispute_won')
        AND (refund_status IS NULL OR refund_status != 'succeeded')
      ORDER BY datetime(created_at) DESC
      LIMIT 1
      `,
    )
    .bind(creatorId)
    .first<{ created_at: string }>();

  if (!newestPending?.created_at) {
    return {
      eligible: false,
      next_eligible_at: new Date().toISOString(),
      reason: "no_eligible_tips",
    };
  }

  const newestMs = new Date(newestPending.created_at).getTime();
  const nextEligibleMs = newestMs + 7 * 24 * 60 * 60 * 1000;

  return {
    eligible: false,
    next_eligible_at: new Date(nextEligibleMs).toISOString(),
    reason: "payout_hold_period",
  };
}
