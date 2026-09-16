// =============================================
// KunTips Tier System (Local version)
// Instant upgrade on tip, daily downgrade (60d)
// =============================================

export type TierDefinition = {
  tier: number;
  minVolume30d: number;      // NOK in last 30 days
  platformFeeBps: number;    // e.g. 500 = 5.00%
};

// Your current tier model
export const TIER_DEFINITIONS: TierDefinition[] = [
  { tier: 1, minVolume30d: 0,           platformFeeBps: 500 }, // 5%   → creator keeps 95%
  { tier: 2, minVolume30d: 5_000,       platformFeeBps: 400 }, // 4%   → creator keeps 96%
  { tier: 3, minVolume30d: 20_000,      platformFeeBps: 300 }, // 3%   → creator keeps 97%
  { tier: 4, minVolume30d: 50_000,      platformFeeBps: 200 }, // 2%   → creator keeps 98%
  { tier: 5, minVolume30d: 100_000,     platformFeeBps: 100 }, // 1%   → creator keeps 99%
  { tier: 6, minVolume30d: 999_999_999, platformFeeBps: 0   }, // 0%   → admin/event only
];


// Given a 30-day volume, find the correct tier
export function getTierForVolume(volume30d: number): TierDefinition {
  let best = TIER_DEFINITIONS[0];
  for (const def of TIER_DEFINITIONS) {
    if (volume30d >= def.minVolume30d && def.tier >= best.tier) {
      best = def;
    }
  }
  return best;
}

// =============================================
// Volume helpers
// =============================================

export async function getLastNDaysVolume(
  db: D1Database,
  creatorId: number,
  days: number
): Promise<number> {
  const stmt = db
    .prepare(
      `
      SELECT COALESCE(SUM(tip_amount_intended), 0) AS volume
      FROM tips
      WHERE creator_id = ?
        AND status = 'succeeded'
        AND tipped_at >= datetime('now', ?)
      `
    )
    .bind(creatorId, `-${days} days`);

  const res = await stmt.first<{ volume: number }>();
  return res?.volume ?? 0;
}

export function getLast30dVolume(db: D1Database, creatorId: number) {
  return getLastNDaysVolume(db, creatorId, 30);
}

export function getLast60dVolume(db: D1Database, creatorId: number) {
  return getLastNDaysVolume(db, creatorId, 60);
}

// =============================================
// Instant UPGRADES
// Called every time a tip is approved
// =============================================

export async function applyInstantTierUpgrade(
  db: D1Database,
  creatorId: number
): Promise<void> {
  const volume30dMinor = await getLast30dVolume(db, creatorId);
  const volume30dNok = Math.round(volume30dMinor / 100);

  const targetTier = getTierForVolume(volume30dNok);

  const current = await db
    .prepare(
      `
      SELECT current_tier, platform_fee_bps
      FROM creators
      WHERE id = ?
      `
    )
    .bind(creatorId)
    .first<{ current_tier: number; platform_fee_bps: number }>();

  if (!current) return;

  if (targetTier.tier > current.current_tier) {
    await db
      .prepare(
        `
        UPDATE creators
        SET current_tier = ?,
            platform_fee_bps = ?,
            tier_last_promotion_at = datetime('now')
        WHERE id = ?
        `
      )
      .bind(targetTier.tier, targetTier.platformFeeBps, creatorId)
      .run();
  }
}

// =============================================
// Daily DOWNGRADES (separate step)
// Do NOT call this per tip. Only call once/day.
// =============================================

export async function applyDailyTierDowngrade(
  db: D1Database,
  creatorId: number
): Promise<void> {
  const last60dMinor = await getLast60dVolume(db, creatorId);
  const last60dNok = Math.round(last60dMinor / 100);

  const c = await db
    .prepare(
      `
      SELECT current_tier, tier_last_promotion_at
      FROM creators
      WHERE id = ?
      `
    )
    .bind(creatorId)
    .first<{ current_tier: number; tier_last_promotion_at: string | null }>();

  if (!c) return;

  const currentTier = c.current_tier;

  // Has it been 60 days since last promotion?
  if (c.tier_last_promotion_at) {
    const lastPromotion = new Date(c.tier_last_promotion_at).getTime();
    const now = Date.now();
    const daysSincePromotion = (now - lastPromotion) / (1000 * 60 * 60 * 24);

    if (daysSincePromotion < 60) {
      // Still within grace window
      return;
    }
  }

  // Determine best tier based on last 60d
  const candidates = TIER_DEFINITIONS.filter(
    (def) => last60dNok >= def.minVolume30d
  );
  const bestEligible =
    candidates.length > 0 ? candidates[candidates.length - 1] : TIER_DEFINITIONS[0];

  // Only downgrade if best eligible is LOWER than current
  if (bestEligible.tier < currentTier) {
    await db
      .prepare(
        `
        UPDATE creators
        SET current_tier = ?,
            platform_fee_bps = ?,
            tier_last_promotion_at = datetime('now')
        WHERE id = ?
        `
      )
      .bind(bestEligible.tier, bestEligible.platformFeeBps, creatorId)
      .run();
  }
}

export type EffectiveTierInfo = {
  baseTier: number;
  baseKeepPercent: number;
  referralBoostTiers: number;
  joinBoostTiers: number;
  temporaryBoostTiers: number;
  globalEventBoostTiers: number;
  effectiveTier: number;
  effectiveKeepPercent: number;
  totalReferralsLast365d: number;
};

// Map total referrals (last 365 days) → extra tiers
function getReferralBoostTierFromCount(referralCount: number): number {
  if (referralCount >= 100) return 3;
  if (referralCount >= 35)  return 2;
  if (referralCount >= 10)  return 1;
  return 0;
}

export type GlobalEventDetails = {
  boostTiers: number;
  expiresAt: string;
  label: string;
};

// Read active global platform event from KV (key: "event:platform")
// Returns full details, or null if no active event.
export async function getGlobalEventDetails(kv: KVNamespace): Promise<GlobalEventDetails | null> {
  try {
    const raw = await kv.get("event:platform");
    if (!raw) return null;
    const event = JSON.parse(raw) as { boost_tiers: number; expires_at: string; label?: string };
    if (!event.expires_at || new Date(event.expires_at) < new Date()) return null;
    return {
      boostTiers: Number(event.boost_tiers) || 0,
      expiresAt: event.expires_at,
      label: event.label ?? "",
    };
  } catch {
    return null;
  }
}

export async function getGlobalEventBoostTiers(kv: KVNamespace): Promise<number> {
  const details = await getGlobalEventDetails(kv);
  return details?.boostTiers ?? 0;
}

/**
 * Compute the "effective" tier and kept percent for a creator, combining:
 * - base earnings tier (current_tier / platform_fee_bps)
 * - referral tier boosts (last 365 days)
 * - referral join boost (+1 tier for 30 days)
 * - temporary tier boosts (e.g. December Boost)
 *
 * This does NOT update the database – it only reads state and returns a summary.
 * Stripe payout logic and the dashboard can call this to show/use the effective tier.
 */
export async function computeEffectiveTierForCreator(
  db: D1Database,
  creatorId: number,
  kv?: KVNamespace,
): Promise<EffectiveTierInfo> {
  const creatorRow = await db
    .prepare(
      `
      SELECT
        current_tier,
        platform_fee_bps,
        referral_join_boost_expires_at,
        temporary_tier_boost,
        temporary_tier_boost_expires_at
      FROM creators
      WHERE id = ?
      `
    )
    .bind(creatorId)
    .first<{
      current_tier: number | null;
      platform_fee_bps: number | null;
      referral_join_boost_expires_at: string | null;
      temporary_tier_boost: number | null;
      temporary_tier_boost_expires_at: string | null;
    }>();

  // Fallback: treat unknown creator as Tier 1 with default platform fee
  if (!creatorRow) {
    const baseTier = 1;
    const basePlatformFeeBps = TIER_DEFINITIONS[0].platformFeeBps;
    const baseKeepPercent = 100 - basePlatformFeeBps / 100;

    return {
      baseTier,
      baseKeepPercent,
      referralBoostTiers: 0,
      joinBoostTiers: 0,
      temporaryBoostTiers: 0,
      globalEventBoostTiers: 0,
      effectiveTier: baseTier,
      effectiveKeepPercent: baseKeepPercent,
      totalReferralsLast365d: 0,
    };
  }

  const baseTier = creatorRow.current_tier ?? 1;
  const basePlatformFeeBps =
    creatorRow.platform_fee_bps ?? TIER_DEFINITIONS[0].platformFeeBps;
  const baseKeepPercent = 100 - basePlatformFeeBps / 100;

  // Use ISO strings for comparison – DB stores TEXT timestamps
  const nowIso = new Date().toISOString();

  // 1) Referral join boost (+1 tier for 30 days after signup via referral)
  let joinBoostTiers = 0;
  if (
    creatorRow.referral_join_boost_expires_at &&
    creatorRow.referral_join_boost_expires_at > nowIso
  ) {
    joinBoostTiers = 1;
  }

  // 2) Temporary tier boost (e.g. December Boost)
  let temporaryBoostTiers = 0;
  if (
    creatorRow.temporary_tier_boost &&
    creatorRow.temporary_tier_boost > 0 &&
    creatorRow.temporary_tier_boost_expires_at &&
    creatorRow.temporary_tier_boost_expires_at > nowIso
  ) {
    temporaryBoostTiers = creatorRow.temporary_tier_boost;
  }

  // 3) Referral-based tier boosts (last 365 days)
  const referralCountRow = await db
    .prepare(
      `
      SELECT COUNT(*) AS cnt
      FROM creator_referrals
      WHERE referrer_creator_id = ?
        AND created_at >= datetime('now', '-365 days')
      `
    )
    .bind(creatorId)
    .first<{ cnt: number }>();

  const totalReferralsLast365d = referralCountRow?.cnt ?? 0;
  const referralBoostTiers = getReferralBoostTierFromCount(
    totalReferralsLast365d
  );

  // 4) Global platform event boost (e.g. Christmas special)
  const globalEventBoostTiers = kv ? await getGlobalEventBoostTiers(kv) : 0;

  // 5) Combine — capped at Tier 6 (0% fee, admin/event only)
  const combinedTier =
    baseTier + referralBoostTiers + joinBoostTiers + temporaryBoostTiers + globalEventBoostTiers;
  const effectiveTier = Math.min(6, combinedTier);

  const effectiveTierDef =
    TIER_DEFINITIONS.find((def) => def.tier === effectiveTier) ??
    TIER_DEFINITIONS[0];

  const effectiveKeepPercent =
    100 - effectiveTierDef.platformFeeBps / 100;

  return {
    baseTier,
    baseKeepPercent,
    referralBoostTiers,
    joinBoostTiers,
    temporaryBoostTiers,
    globalEventBoostTiers,
    effectiveTier,
    effectiveKeepPercent,
    totalReferralsLast365d,
  };
}
