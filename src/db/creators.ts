// db/creators.ts
import type { Env } from "../env";

export type Creator = {
  id: number;
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  is_active: number;
  psp_subaccount_id: string | null;
  platform_fee_bps: number | null;
  current_tier: number | null;
  creator_debt_minor: number;
  referred_by_creator_id: number | null;
  created_at: string;
  updated_at: string | null;
  email: string | null;
  email_verified: number;
  email_verification_token: string | null;
  email_verification_sent_at: string | null;
  password_reset_token: string | null;
  password_reset_token_expires_at: string | null;

  // Real Stripe capability state (migration 0025). `psp_subaccount_id` only
  // means an account object exists — these say whether it actually works.
  stripe_charges_enabled: number;
  stripe_payouts_enabled: number;
  stripe_details_submitted: number;
  /** The `transfers` capability — this is what gates RECEIVING tips. */
  stripe_transfers_active: number;
  stripe_onboarding_started_at: string | null;
  stripe_onboarding_completed_at: string | null;
  stripe_requirements_due: string | null; // JSON array
  /** NULL = never asked Stripe. Distinct from "Stripe said no". */
  stripe_state_synced_at: string | null;

  // Marketing consent (migration 0026). Captured at signup, because anything
  // fired server-to-server later has no browser to read localStorage from.
  marketing_consent: number;
  marketing_consent_at: string | null;
};

export async function getCreatorByUsername(env: Env, username: string) {
  const stmt = env.kuntips_db
    .prepare(
      "SELECT * FROM creators WHERE username = ? COLLATE NOCASE LIMIT 1",
    )
    .bind(username);

  return (await stmt.first()) as Creator | null;
}

export async function createCreator(
  env: Env,
  username: string,
  displayName: string,
) {
  // Minimal insert – extend later with bio/avatar/etc.
  await env.kuntips_db
    .prepare(
      `INSERT INTO creators (username, display_name, is_active)
       VALUES (?, ?, 1)`,
    )
    .bind(username, displayName)
    .run();

  const stmt = env.kuntips_db
    .prepare("SELECT * FROM creators WHERE username = ? LIMIT 1")
    .bind(username);

  return (await stmt.first()) as Creator;
}

export async function updateCreatorStripeAccount(
  env: Env,
  creatorId: number,
  stripeAccountId: string,
) {
  await env.kuntips_db
    .prepare(
      `UPDATE creators
       SET psp_subaccount_id = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(stripeAccountId, creatorId)
    .run();
}

export async function updateCreatorProfile(
  db: D1Database,
  username: string,
  displayName: string,
  bio: string,
) {
  const now = new Date().toISOString();

  const result = await db
    .prepare(
      `
      UPDATE creators
      SET display_name = ?, bio = ?, updated_at = ?
      WHERE username = ?
    `,
    )
    .bind(displayName, bio, now, username)
    .run();

  if (result.error) {
    throw new Error(`Failed to update creator profile: ${result.error}`);
  }

  return { success: true };
}
