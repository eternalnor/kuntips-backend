// src/admin/creators.ts
// Read-only admin views over the creators table and per-creator detail.

import type { Env } from "../env";

const PAGE_SIZE = 25;

export async function handleAdminCreatorsList(
  env: Env,
  url: URL,
): Promise<{
  page: number;
  pageSize: number;
  total: number;
  creators: Array<{
    id: number;
    username: string;
    display_name: string;
    email: string | null;
    current_tier: number;
    platform_fee_bps: number;
    is_active: number;
    is_seed: number;
    has_stripe: boolean;
    email_verified: number;
    signup_code: string | null;
    referred_by_creator_id: number | null;
    created_at: string;
  }>;
}> {
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const hasStripe = url.searchParams.get("hasStripe"); // "1" | "0" | ""
  const active = url.searchParams.get("active"); // "1" | "0" | ""
  const includeSeeds = url.searchParams.get("includeSeeds") === "1";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const where: string[] = [];
  const params: (string | number)[] = [];

  // Hide seeds by default (admin can toggle them back on)
  if (!includeSeeds) {
    where.push("is_seed = 0");
  }

  if (search) {
    where.push("(LOWER(username) LIKE ? OR LOWER(COALESCE(email, '')) LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  // "1" = payouts genuinely enabled, "0" = never started onboarding,
  // "stalled" = created a Stripe account but never finished — the group worth
  // chasing, and the one that was previously indistinguishable from "1".
  if (hasStripe === "1") {
    where.push("stripe_transfers_active = 1");
  } else if (hasStripe === "0") {
    where.push("(psp_subaccount_id IS NULL OR psp_subaccount_id = '')");
  } else if (hasStripe === "stalled") {
    where.push(
      "psp_subaccount_id IS NOT NULL AND psp_subaccount_id != '' AND stripe_transfers_active = 0",
    );
  }
  if (active === "1") {
    where.push("is_active = 1");
  } else if (active === "0") {
    where.push("is_active = 0");
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRow = await env.kuntips_db
    .prepare(`SELECT COUNT(*) AS cnt FROM creators ${whereClause}`)
    .bind(...params)
    .first<{ cnt: number }>();

  const rows = await env.kuntips_db
    .prepare(
      `
      SELECT id, username, display_name, email, current_tier, platform_fee_bps,
             is_active, is_seed,
             stripe_transfers_active AS has_stripe,
             CASE WHEN psp_subaccount_id IS NOT NULL AND psp_subaccount_id != '' THEN 1 ELSE 0 END AS stripe_started,
             email_verified, signup_code, referred_by_creator_id, created_at
      FROM creators
      ${whereClause}
      ORDER BY julianday(created_at) DESC
      LIMIT ? OFFSET ?
    `,
    )
    .bind(...params, PAGE_SIZE, offset)
    .all<{
      id: number;
      username: string;
      display_name: string;
      email: string | null;
      current_tier: number;
      platform_fee_bps: number;
      is_active: number;
      is_seed: number;
      has_stripe: number;
      email_verified: number;
      signup_code: string | null;
      referred_by_creator_id: number | null;
      created_at: string;
    }>();

  return {
    page,
    pageSize: PAGE_SIZE,
    total: Number(countRow?.cnt ?? 0),
    creators: (rows.results ?? []).map((r) => ({
      ...r,
      has_stripe: Boolean(r.has_stripe),
    })),
  };
}

export async function handleAdminCreatorDetail(
  env: Env,
  id: number,
): Promise<{
  creator: {
    id: number;
    username: string;
    display_name: string;
    bio: string | null;
    email: string | null;
    current_tier: number;
    platform_fee_bps: number;
    is_active: number;
    is_seed: number;
    has_stripe: boolean;
    email_verified: number;
    signup_code: string | null;
    referred_by_creator_id: number | null;
    referred_by_username: string | null;
    creator_debt_minor: number;
    created_at: string;
    tier_last_promotion_at: string | null;
  } | null;
  totals: {
    tips_all: number;
    tips_succeeded: number;
    lifetime_intended_nok: number;
    lifetime_net_nok: number;
  };
  recentTips: Array<{
    id: number;
    tip_amount_intended: number;
    creator_net_minor: number;
    status: string;
    tipper_name: string | null;
    tipped_at: string | null;
    created_at: string;
  }>;
  payouts: Array<{
    id: number;
    status: string;
    payout_amount_minor: number | null;
    stripe_payout_id: string | null;
    requested_at: string | null;
    paid_at: string | null;
    failed_at: string | null;
  }>;
  referralsCount: number;
}> {
  const creator = (await env.kuntips_db
    .prepare(
      `
      SELECT c.id, c.username, c.display_name, c.bio, c.email,
             c.current_tier, c.platform_fee_bps, c.is_active, c.is_seed,
             CASE WHEN c.psp_subaccount_id IS NOT NULL AND c.psp_subaccount_id != '' THEN 1 ELSE 0 END AS has_stripe,
             c.email_verified, c.signup_code, c.referred_by_creator_id,
             c.creator_debt_minor, c.created_at, c.tier_last_promotion_at,
             ref.username AS referred_by_username
      FROM creators c
      LEFT JOIN creators ref ON ref.id = c.referred_by_creator_id
      WHERE c.id = ?
      LIMIT 1
    `,
    )
    .bind(id)
    .first()) as
    | {
        id: number;
        username: string;
        display_name: string;
        bio: string | null;
        email: string | null;
        current_tier: number;
        platform_fee_bps: number;
        is_active: number;
        is_seed: number;
        has_stripe: number;
        email_verified: number;
        signup_code: string | null;
        referred_by_creator_id: number | null;
        referred_by_username: string | null;
        creator_debt_minor: number;
        created_at: string;
        tier_last_promotion_at: string | null;
      }
    | null;

  if (!creator) {
    return {
      creator: null,
      totals: {
        tips_all: 0,
        tips_succeeded: 0,
        lifetime_intended_nok: 0,
        lifetime_net_nok: 0,
      },
      recentTips: [],
      payouts: [],
      referralsCount: 0,
    };
  }

  const [totalsRow, recentTipsRows, payoutsRows, referralsRow] =
    await Promise.all([
      env.kuntips_db
        .prepare(
          `
          SELECT
            COUNT(*) AS tips_all,
            SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS tips_succeeded,
            COALESCE(SUM(CASE WHEN status = 'succeeded' THEN tip_amount_intended ELSE 0 END), 0) AS lifetime_intended,
            COALESCE(SUM(CASE WHEN status = 'succeeded' THEN creator_net_minor ELSE 0 END), 0) AS lifetime_net
          FROM tips
          WHERE creator_id = ?
        `,
        )
        .bind(id)
        .first<{
          tips_all: number;
          tips_succeeded: number;
          lifetime_intended: number;
          lifetime_net: number;
        }>(),

      env.kuntips_db
        .prepare(
          `
          SELECT id, tip_amount_intended, creator_net_minor, status,
                 tipper_name, tipped_at, created_at
          FROM tips
          WHERE creator_id = ?
            AND status != 'created'
          ORDER BY julianday(COALESCE(tipped_at, created_at)) DESC
          LIMIT 20
        `,
        )
        .bind(id)
        .all<{
          id: number;
          tip_amount_intended: number;
          creator_net_minor: number;
          status: string;
          tipper_name: string | null;
          tipped_at: string | null;
          created_at: string;
        }>(),

      env.kuntips_db
        .prepare(
          `
          SELECT id, status, payout_amount_minor, stripe_payout_id,
                 requested_at, paid_at, failed_at
          FROM payouts
          WHERE creator_id = ?
          ORDER BY julianday(COALESCE(requested_at, created_at)) DESC
          LIMIT 10
        `,
        )
        .bind(id)
        .all<{
          id: number;
          status: string;
          payout_amount_minor: number | null;
          stripe_payout_id: string | null;
          requested_at: string | null;
          paid_at: string | null;
          failed_at: string | null;
        }>(),

      env.kuntips_db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM creator_referrals WHERE referrer_creator_id = ?`,
        )
        .bind(id)
        .first<{ cnt: number }>(),
    ]);

  return {
    creator: {
      ...creator,
      has_stripe: Boolean(creator.has_stripe),
    },
    totals: {
      tips_all: Number(totalsRow?.tips_all ?? 0),
      tips_succeeded: Number(totalsRow?.tips_succeeded ?? 0),
      lifetime_intended_nok: Math.round(
        Number(totalsRow?.lifetime_intended ?? 0) / 100,
      ),
      lifetime_net_nok: Math.round(Number(totalsRow?.lifetime_net ?? 0) / 100),
    },
    recentTips: recentTipsRows.results ?? [],
    payouts: payoutsRows.results ?? [],
    referralsCount: Number(referralsRow?.cnt ?? 0),
  };
}
