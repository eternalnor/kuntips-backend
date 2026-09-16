// src/admin/syncStripe.ts
//
// One-time (and repeatable) backfill of Stripe capability flags.
//
// Migration 0025 defaults the new columns to 0, and `account.updated` only
// tells us about changes from now on. Without this, an already-working creator
// would read as "cannot receive tips" until they happened to open their
// dashboard — which would take their live tip page offline.
//
// Safe to re-run at any time; it only ever writes what Stripe reports.

import type { Env } from "../env";
import { syncAccountFromStripeOrThrow } from "../db/stripeAccountState";

export async function handleAdminSyncStripeAccounts(env: Env): Promise<{
  checked: number;
  updated: number;
  transfersActive: number;
  payoutsEnabled: number;
  failed: Array<{ id: number; username: string; error: string }>;
  results: Array<{
    id: number;
    username: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    transfersActive: boolean;
    detailsSubmitted: boolean;
    requirementsDue: number;
  }>;
}> {
  const rows = await env.kuntips_db
    .prepare(
      `SELECT id, username, psp_subaccount_id
       FROM creators
       WHERE psp_subaccount_id IS NOT NULL AND psp_subaccount_id != ''`,
    )
    .all<{ id: number; username: string; psp_subaccount_id: string }>();

  const creators = rows.results ?? [];
  const results: Array<{
    id: number;
    username: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    transfersActive: boolean;
    detailsSubmitted: boolean;
    requirementsDue: number;
  }> = [];
  const failed: Array<{ id: number; username: string; error: string }> = [];

  let updated = 0;
  let transfersActive = 0;
  let payoutsEnabled = 0;

  // Sequential on purpose — this runs rarely and over a small set, and it keeps
  // us well clear of Stripe's rate limits.
  for (const c of creators) {
    try {
      const state = await syncAccountFromStripeOrThrow(
        env,
        c.id,
        c.psp_subaccount_id,
      );
      updated += 1;
      if (state.transfersActive) transfersActive += 1;
      if (state.payoutsEnabled) payoutsEnabled += 1;
      results.push({
        id: c.id,
        username: c.username,
        chargesEnabled: state.chargesEnabled,
        payoutsEnabled: state.payoutsEnabled,
        transfersActive: state.transfersActive,
        detailsSubmitted: state.detailsSubmitted,
        requirementsDue: state.requirementsDue.length,
      });
    } catch (err: any) {
      // Surfaced, not swallowed: a creator left unsynced still reads as
      // "unknown" and must be visible so the run can be repeated.
      failed.push({
        id: c.id,
        username: c.username,
        error: String(err?.message ?? err).slice(0, 200),
      });
    }
  }

  return {
    checked: creators.length,
    updated,
    transfersActive,
    payoutsEnabled,
    failed,
    results,
  };
}
