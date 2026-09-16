// src/admin/overview.ts
// Aggregate stats for the admin dashboard.
// Excludes seed creators (is_seed = 1) so the admin sees real business metrics.

import type { Env } from "../env";
import { promiseAllNamed } from "../util/promiseAllNamed";

export type AdminOverview = {
  totals: {
    creators: number;
    creatorsActive: number;
    creatorsWithStripe: number;
    tips: number;
    tipsSucceeded: number;
    volumeNok: number; // tipper-paid intended amount, succeeded only
    earnedByCreatorsNok: number; // net kept by creators
    platformRevenueNok: number; // KunTips-only fee
  };
  funnel: {
    registered: number;
    emailVerified: number;
    /** Created a Stripe account but never got `transfers` active. */
    stripeStalled: number;
    stripeConnected: number;
    receivedFirstTip: number;
  };
  last7Days: {
    signups: { date: string; count: number }[];
    tips: { date: string; count: number; volume_nok: number }[];
  };
  recentActivity: {
    recentSignups: {
      id: number;
      username: string;
      email: string | null;
      created_at: string;
    }[];
    recentTips: {
      id: number;
      creator_id: number;
      creator_username: string;
      tip_amount_intended: number;
      creator_net_minor: number;
      status: string;
      tipped_at: string | null;
      created_at: string;
    }[];
  };
  platformEvent: {
    active: boolean;
    label: string | null;
    boost_tiers: number | null;
    expires_at: string | null;
  };
};

export async function handleAdminOverview(env: Env): Promise<AdminOverview> {
  // Totals (real creators only — exclude is_seed = 1)
  // Keyed by name: with eight positional entries, inserting one in the middle
  // shifts every variable after it. Nothing throws, the SQL stays valid, and
  // every figure below silently renders the wrong query's result.
  const totals = await promiseAllNamed({
    creatorsRow: env.kuntips_db
      .prepare(`SELECT COUNT(*) AS cnt FROM creators WHERE is_seed = 0`)
      .first<{ cnt: number }>(),
    creatorsActiveRow: env.kuntips_db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM creators WHERE is_seed = 0 AND is_active = 1`,
      )
      .first<{ cnt: number }>(),
    stripeRow: env.kuntips_db
      .prepare(
        // `transfers` active, not merely "has an account row" — the latter
        // counted clicks on Connect and reported abandoned onboardings as wins.
        `SELECT COUNT(*) AS cnt FROM creators WHERE is_seed = 0 AND is_active = 1 AND stripe_transfers_active = 1`,
      )
      .first<{ cnt: number }>(),
    tipsAllRow: env.kuntips_db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM tips t INNER JOIN creators c ON c.id = t.creator_id WHERE c.is_seed = 0`,
      )
      .first<{ cnt: number }>(),
    tipsSucceededRow: env.kuntips_db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM tips t INNER JOIN creators c ON c.id = t.creator_id WHERE c.is_seed = 0 AND t.status = 'succeeded'`,
      )
      .first<{ cnt: number }>(),
    volumeRow: env.kuntips_db
      .prepare(
        `SELECT COALESCE(SUM(t.tip_amount_intended), 0) AS total FROM tips t INNER JOIN creators c ON c.id = t.creator_id WHERE c.is_seed = 0 AND t.status = 'succeeded'`,
      )
      .first<{ total: number }>(),
    earnedRow: env.kuntips_db
      .prepare(
        `SELECT COALESCE(SUM(t.creator_net_minor), 0) AS total FROM tips t INNER JOIN creators c ON c.id = t.creator_id WHERE c.is_seed = 0 AND t.status = 'succeeded'`,
      )
      .first<{ total: number }>(),
    platformRow: env.kuntips_db
      .prepare(
        `SELECT COALESCE(SUM(t.platform_fee_minor), 0) AS total FROM tips t INNER JOIN creators c ON c.id = t.creator_id WHERE c.is_seed = 0 AND t.status = 'succeeded'`,
      )
      .first<{ total: number }>(),
  });

  // Funnel (real creators only)
  const funnelRows = await promiseAllNamed({
    registeredRow: env.kuntips_db
      .prepare(`SELECT COUNT(*) AS cnt FROM creators WHERE is_seed = 0`)
      .first<{ cnt: number }>(),
    verifiedRow: env.kuntips_db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM creators WHERE is_seed = 0 AND email_verified = 1`,
      )
      .first<{ cnt: number }>(),
    // The stage where creators are actually lost: they clicked Connect, Stripe
    // made an account, and they never finished. Previously invisible in this
    // view, which jumped straight from "verified" to "connected" and made the
    // drop look like it happened somewhere else.
    stalledRow: env.kuntips_db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM creators
         WHERE is_seed = 0
         AND psp_subaccount_id IS NOT NULL AND psp_subaccount_id != ''
         AND stripe_transfers_active = 0`,
      )
      .first<{ cnt: number }>(),
    firstTipRow: env.kuntips_db
      .prepare(
        `
        SELECT COUNT(DISTINCT t.creator_id) AS cnt
        FROM tips t
        INNER JOIN creators c ON c.id = t.creator_id
        WHERE c.is_seed = 0 AND t.status = 'succeeded'
      `,
      )
      .first<{ cnt: number }>(),
  });

  // Last 7 days (real creators only)
  const signupsRows = await env.kuntips_db
    .prepare(
      `
      SELECT DATE(created_at) AS date, COUNT(*) AS count
      FROM creators
      WHERE is_seed = 0
        AND DATE(created_at) >= DATE('now', '-6 days')
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) ASC
    `,
    )
    .all<{ date: string; count: number }>();

  const tipsRows = await env.kuntips_db
    .prepare(
      `
      SELECT DATE(COALESCE(t.tipped_at, t.created_at)) AS date,
             COUNT(*) AS count,
             ROUND(COALESCE(SUM(t.tip_amount_intended), 0) / 100.0) AS volume_nok
      FROM tips t
      INNER JOIN creators c ON c.id = t.creator_id
      WHERE c.is_seed = 0
        AND t.status = 'succeeded'
        AND DATE(COALESCE(t.tipped_at, t.created_at)) >= DATE('now', '-6 days')
      GROUP BY DATE(COALESCE(t.tipped_at, t.created_at))
      ORDER BY DATE(COALESCE(t.tipped_at, t.created_at)) ASC
    `,
    )
    .all<{ date: string; count: number; volume_nok: number }>();

  // Recent activity (real creators only)
  const recentSignupsRows = await env.kuntips_db
    .prepare(
      `
      SELECT id, username, email, created_at
      FROM creators
      WHERE is_seed = 0
      ORDER BY julianday(created_at) DESC
      LIMIT 10
    `,
    )
    .all<{ id: number; username: string; email: string | null; created_at: string }>();

  const recentTipsRows = await env.kuntips_db
    .prepare(
      `
      SELECT t.id, t.creator_id, c.username AS creator_username,
             t.tip_amount_intended, t.creator_net_minor, t.status,
             t.tipped_at, t.created_at
      FROM tips t
      INNER JOIN creators c ON c.id = t.creator_id
      WHERE c.is_seed = 0 AND t.status != 'created'
      ORDER BY julianday(COALESCE(t.tipped_at, t.created_at)) DESC
      LIMIT 10
    `,
    )
    .all<{
      id: number;
      creator_id: number;
      creator_username: string;
      tip_amount_intended: number;
      creator_net_minor: number;
      status: string;
      tipped_at: string | null;
      created_at: string;
    }>();

  // Active platform event (unchanged)
  const eventRaw = await env.kuntips_rl.get("event:platform");
  let platformEvent: AdminOverview["platformEvent"] = {
    active: false,
    label: null,
    boost_tiers: null,
    expires_at: null,
  };
  if (eventRaw) {
    try {
      const ev = JSON.parse(eventRaw);
      const expired = new Date(ev.expires_at) < new Date();
      platformEvent = {
        active: !expired,
        label: ev.label ?? null,
        boost_tiers: Number(ev.boost_tiers ?? 0) || null,
        expires_at: ev.expires_at ?? null,
      };
    } catch {
      /* ignore */
    }
  }

  return {
    totals: {
      creators: Number(totals.creatorsRow?.cnt ?? 0),
      creatorsActive: Number(totals.creatorsActiveRow?.cnt ?? 0),
      creatorsWithStripe: Number(totals.stripeRow?.cnt ?? 0),
      tips: Number(totals.tipsAllRow?.cnt ?? 0),
      tipsSucceeded: Number(totals.tipsSucceededRow?.cnt ?? 0),
      volumeNok: Math.round(Number(totals.volumeRow?.total ?? 0) / 100),
      earnedByCreatorsNok: Math.round(Number(totals.earnedRow?.total ?? 0) / 100),
      platformRevenueNok: Math.round(Number(totals.platformRow?.total ?? 0) / 100),
    },
    funnel: {
      registered: Number(funnelRows.registeredRow?.cnt ?? 0),
      emailVerified: Number(funnelRows.verifiedRow?.cnt ?? 0),
      stripeStalled: Number(funnelRows.stalledRow?.cnt ?? 0),
      stripeConnected: Number(totals.stripeRow?.cnt ?? 0),
      receivedFirstTip: Number(funnelRows.firstTipRow?.cnt ?? 0),
    },
    last7Days: {
      signups: (signupsRows.results ?? []).map((r) => ({
        date: r.date,
        count: Number(r.count ?? 0),
      })),
      tips: (tipsRows.results ?? []).map((r) => ({
        date: r.date,
        count: Number(r.count ?? 0),
        volume_nok: Number(r.volume_nok ?? 0),
      })),
    },
    recentActivity: {
      recentSignups: (recentSignupsRows.results ?? []).map((r) => ({
        id: Number(r.id),
        username: r.username,
        email: r.email,
        created_at: r.created_at,
      })),
      recentTips: (recentTipsRows.results ?? []).map((r) => ({
        id: Number(r.id),
        creator_id: Number(r.creator_id),
        creator_username: r.creator_username,
        tip_amount_intended: Number(r.tip_amount_intended ?? 0),
        creator_net_minor: Number(r.creator_net_minor ?? 0),
        status: r.status,
        tipped_at: r.tipped_at,
        created_at: r.created_at,
      })),
    },
    platformEvent,
  };
}
