// =============================================
// KunTips Tier System (Local version)
// Instant upgrade on tip, daily downgrade (60d)
// =============================================

export type TierDefinition = {
  tier: number;
  minVolume30d: number;      // USD in last 30 days
  platformFeeBps: number;    // e.g. 1000 = 10.00%
};

// Your current tier model
export const TIER_DEFINITIONS: TierDefinition[] = [
  { tier: 1, minVolume30d: 0,     platformFeeBps: 1000 }, // 10%
  { tier: 2, minVolume30d: 500,   platformFeeBps: 800 },  //  8%
  { tier: 3, minVolume30d: 2000,  platformFeeBps: 700 },  //  7%
  { tier: 4, minVolume30d: 5000,  platformFeeBps: 600 },  //  6%
  { tier: 5, minVolume30d: 10000, platformFeeBps: 500 }   //  5%
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
        AND status = 'APPROVED'
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
  const volume30d = await getLast30dVolume(db, creatorId);
  const targetTier = getTierForVolume(volume30d);

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
  const last60d = await getLast60dVolume(db, creatorId);

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
    (def) => last60d >= def.minVolume30d
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
