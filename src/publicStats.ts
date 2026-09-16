// src/publicStats.ts
// Public platform stats — real numbers only.
//
// This previously returned a synthetic "seed floor" that inflated the figures
// (max(real, seed)). That was removed: publishing invented scale on a page we
// buy traffic to is a marketing-law problem under markedsføringsloven, and it
// also breaks trust the moment a creator signs up and finds an empty platform.
//
// The frontend renders these only when `displayable` is true — see DISPLAY_FLOORS.

import type { Env } from "./env";
import { promiseAllNamed } from "./util/promiseAllNamed";

/**
 * Public display floors. ALL THREE must be cleared before any number is shown
 * on the site — otherwise a strong figure ends up sitting next to a weak one
 * (e.g. "100 innholdsskapere · 30 tips"), which reads worse than showing
 * nothing at all.
 *
 * This only gates the PUBLIC page. /admin/overview always reads the real
 * figures regardless, so we never hide the truth from ourselves.
 */
export const DISPLAY_FLOORS = {
  creators: 100,
  tips: 1_000,
  earnedNok: 250_000,
} as const;
// Why these three, and not bigger/smaller: a visitor divides. At these floors
// the implied ratios all hold up — ~10 tips per creator, ~250 kr per tip, and
// ~2 500 kr earned per creator. Set the money floor lower (say 50 000 kr) and
// the arithmetic says 500 kr per creator, which reads as "nobody earns here"
// and is worse than showing nothing.

export async function handlePublicStats(env: Env): Promise<{
  creators: number;
  tipsSent: number;
  totalEarnedNok: number;
  displayable: boolean;
}> {
  // Real counts only, and excluding seeded demo creators.
  const rows = await promiseAllNamed({
    creatorsRow: env.kuntips_db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM creators WHERE is_active = 1 AND is_seed = 0`,
      )
      .first<{ cnt: number }>(),

    tipsRow: env.kuntips_db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM tips t
         INNER JOIN creators c ON c.id = t.creator_id
         WHERE t.status = 'succeeded' AND c.is_seed = 0`,
      )
      .first<{ cnt: number }>(),

    earnedRow: env.kuntips_db
      .prepare(
        `SELECT COALESCE(SUM(t.creator_net_minor), 0) AS total
         FROM tips t
         INNER JOIN creators c ON c.id = t.creator_id
         WHERE t.status = 'succeeded' AND c.is_seed = 0`,
      )
      .first<{ total: number }>(),
  });
  const { creatorsRow, tipsRow, earnedRow } = rows;

  const creators = Number(creatorsRow?.cnt ?? 0);
  const tipsSent = Number(tipsRow?.cnt ?? 0);
  const totalEarnedNok = Math.round(Number(earnedRow?.total ?? 0) / 100);

  return {
    creators,
    tipsSent,
    totalEarnedNok,
    // All three floors must clear — never show a strong number beside a weak one.
    displayable:
      creators >= DISPLAY_FLOORS.creators &&
      tipsSent >= DISPLAY_FLOORS.tips &&
      totalEarnedNok >= DISPLAY_FLOORS.earnedNok,
  };
}
