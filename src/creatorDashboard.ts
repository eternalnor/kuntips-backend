// creatorDashboard.ts
import type { Env } from "./env";
import { getCreatorByUsername } from "./db/creators";
import {
  TIER_DEFINITIONS,
  getTierForVolume,
  computeEffectiveTierForCreator,
  getGlobalEventDetails,
} from "./tier";
import { corsJson } from "./http";
import { payoutReference } from "./payouts/payoutStatement";

export async function handleGetCreatorDashboard(
  env: Env,
  username: string,
): Promise<Response> {
  const normalized = username.trim().toLowerCase();
  if (!normalized) {
    return corsJson(
      { error: "invalid_request", message: "username is required" },
      400,
    );
  }

  const creator = await getCreatorByUsername(env, normalized);
  if (!creator || creator.is_active !== 1) {
    return corsJson(
      {
        error: "creator_not_found",
        message: "No active creator found",
      },
      404,
    );
  }

  const isActive = creator.is_active === 1;
  const stripeAccountId = creator.psp_subaccount_id || null;

  // "Connected" means Stripe will actually accept charges AND pay out — not
  // merely that an account object exists. While the creator is still mid-
  // onboarding we re-sync from Stripe on load, because the account.updated
  // webhook only tells us about changes that happen from now on (and existing
  // accounts pre-date it entirely).
  let chargesEnabled = creator.stripe_charges_enabled === 1;
  let payoutsEnabled = creator.stripe_payouts_enabled === 1;
  let detailsSubmitted = creator.stripe_details_submitted === 1;
  let transfersActive = creator.stripe_transfers_active === 1;
  let requirementsDue: string[] = [];
  try {
    requirementsDue = creator.stripe_requirements_due
      ? JSON.parse(creator.stripe_requirements_due)
      : [];
  } catch {
    requirementsDue = [];
  }

  // Re-sync while onboarding is incomplete, but throttled. A permanently
  // restricted account would otherwise hit the Stripe API on every single
  // dashboard load, forever — the `account.updated` webhook is the primary
  // mechanism; this is just a safety net and a backfill for pre-webhook rows.
  const SYNC_TTL_MS = 5 * 60 * 1000;
  const lastSynced = creator.stripe_state_synced_at
    ? Date.parse(creator.stripe_state_synced_at.replace(" ", "T") + "Z")
    : NaN;
  const syncIsStale =
    Number.isNaN(lastSynced) || Date.now() - lastSynced > SYNC_TTL_MS;

  if (stripeAccountId && !transfersActive && syncIsStale) {
    const { syncAccountFromStripe } = await import("./db/stripeAccountState");
    const fresh = await syncAccountFromStripe(env, creator.id, stripeAccountId);
    if (fresh) {
      chargesEnabled = fresh.chargesEnabled;
      payoutsEnabled = fresh.payoutsEnabled;
      detailsSubmitted = fresh.detailsSubmitted;
      transfersActive = fresh.transfersActive;
      requirementsDue = fresh.requirementsDue;
    }
  }

  const stripeStarted = !!stripeAccountId;
  // Receiving tips needs `transfers`; withdrawing to a bank needs payouts.
  // They are separate states and a creator can legitimately be in the first
  // without the second.
  const stripeConnected = transfersActive;
  const canReceiveTips = isActive && transfersActive;
  const canRequestPayout = payoutsEnabled;

  const db = env.kuntips_db;

  // Lifetime stats
  const lifetimeRow = await db
    .prepare(
      `
      SELECT
        COALESCE(SUM(tip_amount_intended), 0) AS sum_intended,
        COALESCE(SUM(creator_net_minor), 0) AS sum_net,
        COUNT(*) AS tip_count
      FROM tips
      WHERE creator_id = ?
        AND status = 'succeeded'
      `,
    )
    .bind(creator.id)
    .first<{ sum_intended: number; sum_net: number; tip_count: number }>();

  const lifetimeIntendedMinor = lifetimeRow?.sum_intended ?? 0;
  const lifetimeNetMinor = lifetimeRow?.sum_net ?? 0;
  const lifetimeTipCount = lifetimeRow?.tip_count ?? 0;

  // Last 30 days
  const last30dRow = await db
    .prepare(
      `
      SELECT
        COALESCE(SUM(tip_amount_intended), 0) AS sum_intended,
        COALESCE(SUM(creator_net_minor), 0) AS sum_net,
        COUNT(*) AS tip_count
      FROM tips
      WHERE creator_id = ?
        AND status = 'succeeded'
        AND tipped_at >= datetime('now', '-30 days')
      `,
    )
    .bind(creator.id)
    .first<{ sum_intended: number; sum_net: number; tip_count: number }>();

  const last30dIntendedMinor = last30dRow?.sum_intended ?? 0;
  const last30dNetMinor = last30dRow?.sum_net ?? 0;
  const last30dTipCount = last30dRow?.tip_count ?? 0;

  // This month
  const thisMonthRow = await db
    .prepare(
      `
      SELECT
        COALESCE(SUM(tip_amount_intended), 0) AS sum_intended,
        COALESCE(SUM(tip_amount_intended - platform_fee_minor), 0) AS sum_net
      FROM tips
      WHERE creator_id = ?
        AND status = 'succeeded'
        AND strftime('%Y-%m', tipped_at) = strftime('%Y-%m', 'now')
      `,
    )
    .bind(creator.id)
    .first<{ sum_intended: number; sum_net: number }>();

  const thisMonthIntendedMinor = thisMonthRow?.sum_intended ?? 0;
  const thisMonthNetMinor = thisMonthRow?.sum_net ?? 0;

  // Compute effective tier (base + referrals + boosts)
  const effectiveTierInfo = await computeEffectiveTierForCreator(
    db,
    creator.id,
    env.kuntips_rl,
  );

  // Fetch full event details (label + expiresAt) for the frontend banner
  const globalEvent = env.kuntips_rl
    ? await getGlobalEventDetails(env.kuntips_rl)
    : null;


  // Tier info based on 30d volume (in NOK)
  const volume30dMinor = last30dIntendedMinor;
  const volume30dNok = Math.round(volume30dMinor / 100);

  // Projected tier purely from volume (used for progress to next tier)
  const tierDef = getTierForVolume(volume30dNok);

  // Actual effective tier (earnings + referrals + boosts)
  const effectiveTierDef =
    TIER_DEFINITIONS.find(
      (def) => def.tier === effectiveTierInfo.effectiveTier,
    ) ?? TIER_DEFINITIONS[0];

  const keptPercent = effectiveTierInfo.effectiveKeepPercent;


  // Find the next tier, if any
  const nextTierDef = TIER_DEFINITIONS.find(
    (def) => def.tier === tierDef.tier + 1,
  );

  let nextTier:
    | null
    | {
        tier: number;
        minVolumeNok: number;
        missingVolumeNok: number;
      } = null;

  if (nextTierDef) {
    const minVolumeNok = nextTierDef.minVolume30d;
    const missingVolumeNok = Math.max(minVolumeNok - volume30dNok, 0);

    nextTier = {
      tier: nextTierDef.tier,
      minVolumeNok,
      missingVolumeNok,
    };
  }

  // ── Daily chart: last 30 days bucketed by date ────────────────────────────
  const dailyRows = await db
    .prepare(
      `SELECT DATE(tipped_at) AS day, SUM(creator_net_minor) AS total
       FROM tips
       WHERE creator_id = ? AND status = 'succeeded'
         AND tipped_at >= datetime('now', '-30 days')
       GROUP BY DATE(tipped_at)
       ORDER BY day ASC`,
    )
    .bind(creator.id)
    .all<{ day: string; total: number }>();

  const dailyMap = new Map<string, number>();
  for (const row of dailyRows.results ?? []) dailyMap.set(row.day, row.total);

  const chartDaily: Array<{ date: string; amountNok: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    chartDaily.push({ date: dateStr, amountNok: Math.round((dailyMap.get(dateStr) ?? 0) / 100) });
  }

  // ── Previous 30-day window (for % comparison) ─────────────────────────────
  const prev30dRow = await db
    .prepare(
      `SELECT COALESCE(SUM(creator_net_minor), 0) AS total
       FROM tips
       WHERE creator_id = ? AND status = 'succeeded'
         AND tipped_at >= datetime('now', '-60 days')
         AND tipped_at < datetime('now', '-30 days')`,
    )
    .bind(creator.id)
    .first<{ total: number }>();

  const prev30dTotalNok = Math.round((prev30dRow?.total ?? 0) / 100);
  const last30dNok = Math.round(last30dNetMinor / 100);
  const changePercent =
    prev30dTotalNok > 0
      ? Math.round(((last30dNok - prev30dTotalNok) / prev30dTotalNok) * 1000) / 10
      : null;

  // ── Percentile rank: load all active creators' 30d volumes ───────────────
  const allVolumesRes = await db
    .prepare(
      `SELECT c.id,
              COALESCE(SUM(CASE WHEN t.status = 'succeeded'
                AND t.tipped_at >= datetime('now', '-30 days')
                THEN t.creator_net_minor ELSE 0 END), 0) AS vol
       FROM creators c
       LEFT JOIN tips t ON t.creator_id = c.id
       WHERE c.is_active = 1
       GROUP BY c.id`,
    )
    .all<{ id: number; vol: number }>();

  const allVols = allVolumesRes.results ?? [];
  const totalCreators = allVols.length;
  const creatorsBelow = allVols.filter(r => r.id !== creator.id && r.vol < last30dNetMinor).length;
  // Only show percentile when enough data exists (≥ 10 active creators)
  const percentileRank =
    totalCreators >= 10
      ? Math.max(1, 100 - Math.round((creatorsBelow / totalCreators) * 100))
      : null;

  // ── Streak: consecutive days with tips ending today or yesterday ──────────
  const streakRows = await db
    .prepare(
      `SELECT DISTINCT DATE(tipped_at) AS day
       FROM tips
       WHERE creator_id = ? AND status = 'succeeded'
         AND tipped_at >= datetime('now', '-365 days')
       ORDER BY day DESC`,
    )
    .bind(creator.id)
    .all<{ day: string }>();

  const streakDays = (() => {
    const days = streakRows.results?.map(r => r.day) ?? [];
    if (days.length === 0) return 0;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    if (days[0] !== today && days[0] !== yesterday) return 0;
    let streak = 1;
    for (let i = 1; i < days.length; i++) {
      const diff = Math.round(
        (new Date(days[i - 1]).getTime() - new Date(days[i]).getTime()) / 86_400_000,
      );
      if (diff === 1) streak++;
      else break;
    }
    return streak;
  })();

  // ── Personal records ──────────────────────────────────────────────────────
  const bestDayRow = await db
    .prepare(
      `SELECT MAX(daily_total) AS best
       FROM (SELECT SUM(creator_net_minor) AS daily_total
             FROM tips WHERE creator_id = ? AND status = 'succeeded'
             GROUP BY DATE(tipped_at))`,
    )
    .bind(creator.id)
    .first<{ best: number }>();

  const bestMonthRow = await db
    .prepare(
      `SELECT strftime('%Y-%m', tipped_at) AS month,
              SUM(creator_net_minor) AS total
       FROM tips WHERE creator_id = ? AND status = 'succeeded'
       GROUP BY month ORDER BY total DESC LIMIT 1`,
    )
    .bind(creator.id)
    .first<{ month: string; total: number }>();

  const bestDayNok = Math.round((bestDayRow?.best ?? 0) / 100);
  const bestMonthNok = Math.round((bestMonthRow?.total ?? 0) / 100);
  const bestMonthLabel = bestMonthRow?.month
    ? (() => {
        const [y, m] = bestMonthRow.month.split("-");
        return new Date(Number(y), Number(m) - 1, 1)
          .toLocaleString("en-US", { month: "long", year: "numeric" });
      })()
    : null;

  // ── Monthly projection ────────────────────────────────────────────────────
  const thisMonthNok = Math.round(thisMonthNetMinor / 100);
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const projectedMonthNok =
    dayOfMonth > 0 && thisMonthNok > 0
      ? Math.round((thisMonthNok / dayOfMonth) * daysInMonth)
      : null;

  // ── Milestones ────────────────────────────────────────────────────────────
  const lifetimeNok = Math.round(lifetimeNetMinor / 100);
  const milestones = {
    firstTip:  lifetimeTipCount >= 1,
    nok1k:     lifetimeNok >= 1_000,
    nok5k:     lifetimeNok >= 5_000,
    nok10k:    lifetimeNok >= 10_000,
    nok50k:    lifetimeNok >= 50_000,
    nok100k:   lifetimeNok >= 100_000,
  };

  // ── Payout history (latest 10) ───────────────────────────────────────────
  const payoutHistoryRes = await db
    .prepare(
      `
      SELECT
        id, status, currency,
        eligible_amount_minor, debt_applied_minor, payout_amount_minor,
        stripe_payout_id, requested_at, paid_at, failed_at, failure_reason
      FROM payouts
      WHERE creator_id = ?
      ORDER BY requested_at DESC
      LIMIT 10
      `,
    )
    .bind(creator.id)
    .all<{
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
      failure_reason: string | null;
    }>();

  const payoutHistory = (payoutHistoryRes.results ?? []).map((row) => ({
    id: row.id,
    reference: payoutReference(row.id, row.requested_at),
    status: row.status,
    currency: row.currency ?? "NOK",
    eligibleAmountNok: Math.round(Number(row.eligible_amount_minor ?? 0) / 100),
    debtAppliedNok: Math.round(Number(row.debt_applied_minor ?? 0) / 100),
    payoutAmountNok: Math.round(Number(row.payout_amount_minor ?? 0) / 100),
    stripePayoutId: row.stripe_payout_id ?? null,
    requestedAt: row.requested_at,
    paidAt: row.paid_at ?? null,
    failedAt: row.failed_at ?? null,
    failureReason: row.failure_reason ?? null,
  }));

  // Recent tips (latest 20)
  const recentRes = await db
    .prepare(
      `
      SELECT id,
             tip_amount_intended,
             creator_net_minor,
             currency,
             status,
             tipped_at,
             tipper_name
      FROM tips
      WHERE creator_id = ? AND status != 'created'
      ORDER BY tipped_at DESC
      LIMIT 20
      `,
    )
    .bind(creator.id)
    .all<{
      id: number;
      tip_amount_intended: number;
      creator_net_minor: number;
      currency: string;
      status: string;
      tipped_at: string;
      tipper_name: string | null;
    }>();

  const recentTips =
    recentRes.results?.map((row) => {
      const netMinor = row.creator_net_minor ?? row.tip_amount_intended;
      return {
        id: row.id,
        tipAmountMinor: row.tip_amount_intended,
        tipAmountNok: Math.round(row.tip_amount_intended / 100),
        netAmountMinor: netMinor,
        netAmountNok: Math.round(netMinor / 100),
        currency: row.currency,
        status: row.status,
        tippedAt: row.tipped_at,
        tipperName: row.tipper_name ?? null,
      };
    }) ?? [];

  const response = {
    creator: {
      id: creator.id,
      username: creator.username,
      displayName: creator.display_name ?? creator.username,
      avatarUrl: creator.avatar_url || null,
      bio: creator.bio ?? "",
      currentTier: effectiveTierInfo.effectiveTier,
      emailVerified: creator.email_verified === 1,
    },
    stats: {
      currency: "NOK" as const,
      lifetimeIntendedMinor,
      lifetimeIntendedNok: Math.round(lifetimeIntendedMinor / 100),
      lifetimeNetMinor,
      lifetimeNetNok: Math.round(lifetimeNetMinor / 100),
      last30dIntendedMinor,
      last30dIntendedNok: Math.round(last30dIntendedMinor / 100),
      last30dNetMinor,
      last30dNetNok: Math.round(last30dNetMinor / 100),
      thisMonthIntendedMinor,
      thisMonthIntendedNok: Math.round(thisMonthIntendedMinor / 100),
      thisMonthNetMinor,
      thisMonthNetNok: Math.round(thisMonthNetMinor / 100),
      lifetimeTipCount,
      last30dTipCount,
    },
    tier: {
      // Projected tier purely from 30d volume
      projectedBaseTierFromVolume: tierDef.tier,

      // Tier from the creator record (before boosts)
      baseTier: effectiveTierInfo.baseTier,
      baseKeepPercent: effectiveTierInfo.baseKeepPercent,

      // Final effective tier after all boosts (this is what matters to payouts)
      currentTier: effectiveTierInfo.effectiveTier,
      keptPercent: effectiveTierInfo.effectiveKeepPercent,
      platformFeeBps: effectiveTierDef.platformFeeBps,

      // Volume stats & progress towards next tier
      volume30dMinor,
      volume30dNok,
      nextTier,

      // Boost breakdown
      referralBoostTiers: effectiveTierInfo.referralBoostTiers,
      joinBoostTiers: effectiveTierInfo.joinBoostTiers,
      temporaryBoostTiers: effectiveTierInfo.temporaryBoostTiers,
      globalEventBoostTiers: effectiveTierInfo.globalEventBoostTiers,
      totalReferralsLast365d: effectiveTierInfo.totalReferralsLast365d,

      // Active platform event (null if no event is running)
      globalEvent: globalEvent
        ? { label: globalEvent.label, expiresAt: globalEvent.expiresAt }
        : null,
    },

    status: {
      isActive,
      stripeConnected,
      canReceiveTips,
      // Lets the dashboard distinguish "never started" from "started but
      // stalled" — the state that was previously invisible and unrecoverable.
      stripeStarted,
      stripeChargesEnabled: chargesEnabled,
      stripePayoutsEnabled: payoutsEnabled,
      stripeTransfersActive: transfersActive,
      stripeDetailsSubmitted: detailsSubmitted,
      stripeRequirementsDue: requirementsDue,
      canRequestPayout,
    },
    charts: {
      daily: chartDaily,
      prev30dTotalNok,
      changePercent,
    },
    insights: {
      streakDays,
      projectedMonthNok,
      bestDayNok,
      bestMonthNok,
      bestMonthLabel,
    },
    percentileRank,
    milestones,
    recentTips,
    payoutHistory,
  };

  return corsJson(response);
}
