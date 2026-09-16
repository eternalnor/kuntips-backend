// src/admin/referralCodes.ts
// CRUD-lite handlers for admin-managed referral codes.
// Codes are always UPPERCASED. referrer_creator_id left NULL for admin-owned codes.

import type { Env } from "../env";
import type { AdminSession } from "../db/adminAuth";
import { promiseAllNamed } from "../util/promiseAllNamed";

export async function handleListReferralCodes(env: Env): Promise<{
  codes: Array<{
    id: number;
    code: string;
    description: string | null;
    referrer_creator_id: number | null;
    is_active: number;
    created_at: string;
    stats: {
      visits: number;
      unique_visits: number;
      bot_visits: number;
      signups: number;
      /** signups ÷ unique visits. Null when there are no visits yet. */
      signup_rate_pct: number | null;
      stripe_stalled: number;
      stripe_connected: number;
      first_tip: number;
      volume_nok: number;
      earned_nok: number;
    };
  }>;
}> {
  // Basic list
  const codes = await env.kuntips_db
    .prepare(
      `
      SELECT id, code, description, referrer_creator_id, is_active, created_at
      FROM referral_codes
      ORDER BY julianday(created_at) DESC
    `,
    )
    .all<{
      id: number;
      code: string;
      description: string | null;
      referrer_creator_id: number | null;
      is_active: number;
      created_at: string;
    }>();

  // For each code, compute stats (do it in parallel for speed)
  const withStats = await Promise.all(
    (codes.results ?? []).map(async (c) => {
      // Keyed by name, not position: a positional array silently shifts every
      // later variable the moment a query is inserted in the middle, and the
      // SQL still looks correct while every figure below is wrong.
      const stats = await promiseAllNamed({
        visits: env.kuntips_db
          .prepare(
            `SELECT COUNT(*) AS total,
                    COUNT(DISTINCT visitor_hash) AS uniques,
                    SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END) AS bots
             FROM referral_visits WHERE UPPER(code) = ?`,
          )
          .bind(c.code)
          .first<{ total: number; uniques: number; bots: number }>(),

        signupsRow: env.kuntips_db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM creators WHERE UPPER(signup_code) = ?`,
          )
          .bind(c.code)
          .first<{ cnt: number }>(),

        // Started Stripe but never finished — the stage where creators are
        // actually lost, and previously invisible in this view.
        stalledRow: env.kuntips_db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM creators
             WHERE UPPER(signup_code) = ?
             AND psp_subaccount_id IS NOT NULL AND psp_subaccount_id != ''
             AND stripe_transfers_active = 0`,
          )
          .bind(c.code)
          .first<{ cnt: number }>(),

        // `transfers` active, not "an account object exists". The old check
        // counted clicks on Connect and reported abandoned onboardings as wins.
        stripeRow: env.kuntips_db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM creators
             WHERE UPPER(signup_code) = ?
             AND stripe_transfers_active = 1`,
          )
          .bind(c.code)
          .first<{ cnt: number }>(),

        firstTipRow: env.kuntips_db
          .prepare(
            `
            SELECT COUNT(DISTINCT c.id) AS cnt
            FROM creators c
            INNER JOIN tips t ON t.creator_id = c.id AND t.status = 'succeeded'
            WHERE UPPER(c.signup_code) = ?
          `,
          )
          .bind(c.code)
          .first<{ cnt: number }>(),

        volumeRow: env.kuntips_db
          .prepare(
            `
            SELECT
              COALESCE(SUM(t.tip_amount_intended), 0) AS volume,
              COALESCE(SUM(t.creator_net_minor), 0) AS earned
            FROM tips t
            INNER JOIN creators c ON c.id = t.creator_id
            WHERE UPPER(c.signup_code) = ? AND t.status = 'succeeded'
          `,
          )
          .bind(c.code)
          .first<{ volume: number; earned: number }>(),
      });

      const uniqueVisits = Number(stats.visits?.uniques ?? 0);
      const signups = Number(stats.signupsRow?.cnt ?? 0);

      return {
        ...c,
        stats: {
          visits: Number(stats.visits?.total ?? 0),
          unique_visits: uniqueVisits,
          bot_visits: Number(stats.visits?.bots ?? 0),
          signups,
          // The number a campaign is actually judged on. Null rather than 0
          // when there are no visits yet, so "no data" never renders as "0 %".
          signup_rate_pct:
            uniqueVisits > 0
              ? Math.round((signups / uniqueVisits) * 1000) / 10
              : null,
          stripe_stalled: Number(stats.stalledRow?.cnt ?? 0),
          stripe_connected: Number(stats.stripeRow?.cnt ?? 0),
          first_tip: Number(stats.firstTipRow?.cnt ?? 0),
          volume_nok: Math.round(Number(stats.volumeRow?.volume ?? 0) / 100),
          earned_nok: Math.round(Number(stats.volumeRow?.earned ?? 0) / 100),
        },
      };
    }),
  );

  return { codes: withStats };
}

export async function handleCreateReferralCode(
  env: Env,
  admin: AdminSession | null,
  body: { code?: unknown; description?: unknown },
): Promise<
  | { ok: true; id: number; code: string }
  | { ok: false; error: string; status: number }
> {
  const rawCode = typeof body.code === "string" ? body.code : "";
  const code = rawCode.trim().toUpperCase();
  const description =
    typeof body.description === "string" ? body.description.trim() : null;

  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
    return {
      ok: false,
      error: "invalid_code (3-32 chars, A-Z, 0-9, _, -)",
      status: 400,
    };
  }

  try {
    const inserted = (await env.kuntips_db
      .prepare(
        `
        INSERT INTO referral_codes (code, description, referrer_creator_id, is_active, created_at, created_by_admin_id)
        VALUES (?, ?, NULL, 1, datetime('now'), ?)
        RETURNING id
      `,
      )
      .bind(code, description, admin?.adminId ?? null)
      .first<{ id: number }>()) ?? null;

    if (!inserted) {
      return { ok: false, error: "insert_failed", status: 500 };
    }

    return { ok: true, id: inserted.id, code };
  } catch (err: any) {
    const msg = String(err?.message ?? err ?? "");
    if (msg.toLowerCase().includes("unique")) {
      return { ok: false, error: "code_already_exists", status: 409 };
    }
    return { ok: false, error: "insert_failed", status: 500 };
  }
}

export async function handleToggleReferralCode(
  env: Env,
  id: number,
  isActive: boolean,
): Promise<{ ok: boolean }> {
  await env.kuntips_db
    .prepare(
      `UPDATE referral_codes SET is_active = ? WHERE id = ?`,
    )
    .bind(isActive ? 1 : 0, id)
    .run();
  return { ok: true };
}

/**
 * Look up an active referral code (used by the registration flow).
 * Returns null if not found or inactive.
 */
export async function lookupActiveReferralCode(
  env: Env,
  rawCode: string,
): Promise<{
  id: number;
  code: string;
  referrer_creator_id: number | null;
} | null> {
  const normalized = rawCode.trim().toUpperCase();
  if (!normalized) return null;

  const row = (await env.kuntips_db
    .prepare(
      `SELECT id, code, referrer_creator_id FROM referral_codes WHERE UPPER(code) = ? AND is_active = 1 LIMIT 1`,
    )
    .bind(normalized)
    .first()) as
    | { id: number; code: string; referrer_creator_id: number | null }
    | null;

  return row;
}
