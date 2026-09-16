// src/admin/stats.ts
//
// Marketing statistics for /admin/stats. Everything a campaign decision needs
// in one response: traffic with humans/uniques/bots, the signup funnel as a
// time series and as rates, results per source, per ad creative, per device
// and per in-app browser, tipper behaviour, retention cohorts, and the health
// of the server-side pixels.
//
// Conventions (kept from the lessons in the mia-links stats system):
// - Count PEOPLE, not events: uniques are COUNT(DISTINCT visitor), never rows.
// - Bots are counted separately and excluded from every rate.
// - Days are the ad account's days (Europe/Oslo), not UTC, so "yesterday"
//   here is the same "yesterday" the ad platforms bill against.
// - Group by ad creative only for paid visits.
// - Every rate carries its denominator so "no data" never renders as "0 %".
// - Real creators only (is_seed = 0).

import type { Env } from "../env";
import { promiseAllNamed } from "../util/promiseAllNamed";

const ALLOWED_DAYS = [7, 30, 90];
const LEARNING_TARGET = 50; // conversions an ad set wants inside its 7-day learning window

// ───────────────────────────── time helpers ─────────────────────────────

/** Offset of Europe/Oslo from UTC in whole hours (+1 or +2), computed now. */
function osloOffsetHours(): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Oslo",
      timeZoneName: "shortOffset",
    });
    const part = fmt.formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = part.match(/([+-])(\d{1,2})/);
    if (!m) return 1;
    return (m[1] === "-" ? -1 : 1) * parseInt(m[2], 10);
  } catch {
    return 1;
  }
}

/** SQL fragment: the Europe/Oslo calendar day of a stored UTC timestamp. */
function localDay(col: string, offset: number): string {
  const mod = `${offset >= 0 ? "+" : "-"}${Math.abs(offset)} hours`;
  return `DATE(datetime(${col}, '${mod}'))`;
}

/** 'YYYY-MM-DD HH:MM:SS' in UTC, the same shape as SQLite's datetime('now'). */
function sqlUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** The last `days` Europe/Oslo calendar days, oldest first, ending today. */
function dayList(days: number, offset: number): string[] {
  const out: string[] = [];
  const nowLocal = Date.now() + offset * 3600_000;
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(nowLocal - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function pct(num: number, den: number): number | null {
  return den > 0 ? Math.round((num / den) * 1000) / 10 : null;
}

function nok(minor: unknown): number {
  return Math.round(n(minor) / 100);
}

// ───────────────────────────── response types ─────────────────────────────

export type SeriesPoint = {
  date: string;
  visits: number;
  uniques: number;
  paidVisits: number;
  registered: number;
  connected: number;
  firstTips: number;
  tips: number;
  volumeNok: number;
  platformNok: number;
  creatorNetNok: number;
};

export type FunnelCounts = {
  registered: number;
  verified: number;
  stripeStarted: number;
  connected: number;
  firstTip: number;
};

export type SegmentRow = {
  key: string;
  visits: number;
  uniques: number;
  paidVisits: number;
  registered: number;
  verified: number;
  connected: number;
  firstTip: number;
  registeredRatePct: number | null; // registered ÷ uniques
  connectedRatePct: number | null; // connected ÷ uniques
};

export type CreativeRow = SegmentRow & {
  code: string | null;
  firstDay: string | null;
  lastDay: string | null;
};

export type AdminStats = {
  meta: {
    days: number;
    timezone: string;
    offsetHours: number;
    generatedAt: string;
    since: string;
    today: string;
  };
  traffic: {
    visits: number;
    humans: number;
    uniques: number;
    bots: number;
    paidVisits: number;
    inAppVisits: number;
    botSharePct: number | null;
  };
  series: SeriesPoint[];
  funnel: {
    window: FunnelCounts; // creators who registered inside the window
    allTime: FunnelCounts;
  };
  bySource: SegmentRow[];
  byCreative: CreativeRow[];
  byDevice: SegmentRow[];
  byOs: SegmentRow[];
  byInApp: SegmentRow[];
  byCountry: SegmentRow[];
  byReferrer: { host: string; visits: number; uniques: number }[];
  tips: {
    count: number;
    creatorsTipped: number;
    avgNok: number | null;
    medianNok: number | null;
    p90Nok: number | null;
    maxNok: number | null;
    anonymousPct: number | null;
    presetPct: number | null;
    buckets: { label: string; count: number }[];
    volumeNok: number;
    platformNok: number;
    creatorNetNok: number;
    truncated: boolean;
  };
  retention: {
    cohorts: {
      month: string;
      creators: number;
      tip30: number;
      eligible30: number;
      tip60: number;
      eligible60: number;
      tip90: number;
      eligible90: number;
      activeLast30: number;
    }[];
    connectedTotal: number;
    activeLast30Total: number;
  };
  referrals: { creatorReferrals: number; payoutsRequested: number; payoutsPaid: number; payoutsPaidNok: number };
  health: {
    testCodeActive: { meta: boolean; tiktok: boolean };
    platforms: {
      platform: "meta" | "tiktok";
      configured: boolean;
      lastOkAt: string | null;
      lastOkEvent: string | null;
      okInWindow: number;
      errorsInWindow: number;
      testSendsInWindow: number;
      lastError: { at: string; status: number | null; detail: string | null } | null;
      byEvent: { event: string; ok: number; failed: number }[];
    }[];
  };
  learning: {
    target: number;
    platforms: {
      platform: "meta" | "tiktok";
      event: string;
      conversions7d: number;
      last24h: number;
      etaDays: number | null;
      status: "learning" | "likely_out" | "no_data";
    }[];
  };
};

// ───────────────────────────── main handler ─────────────────────────────

export async function handleAdminStats(env: Env, daysRaw: unknown): Promise<AdminStats> {
  const parsed = parseInt(String(daysRaw ?? ""), 10);
  const days = ALLOWED_DAYS.includes(parsed) ? parsed : 30;
  const offset = osloOffsetHours();
  const since = sqlUtc(new Date(Date.now() - days * 86_400_000));
  const since7d = sqlUtc(new Date(Date.now() - 7 * 86_400_000));
  const since24h = sqlUtc(new Date(Date.now() - 86_400_000));
  const since30d = sqlUtc(new Date(Date.now() - 30 * 86_400_000));
  const db = env.kuntips_db;

  const dayVisits = localDay("visited_at", offset);
  const dayCreated = localDay("created_at", offset);
  const dayConnected = localDay("stripe_onboarding_completed_at", offset);
  const dayTipped = localDay("COALESCE(t.tipped_at, t.created_at)", offset);
  const dayFirstTip = localDay("first_at", offset);

  // Uniques: the browser's own id when it has one, the IP+UA hash otherwise.
  const VISITOR = "COALESCE(visitor_id, visitor_hash)";

  const q = await promiseAllNamed({
    // ── traffic totals ──
    traffic: db
      .prepare(
        `SELECT COUNT(*) AS visits,
                SUM(CASE WHEN is_bot = 0 THEN 1 ELSE 0 END) AS humans,
                COUNT(DISTINCT CASE WHEN is_bot = 0 THEN ${VISITOR} END) AS uniques,
                SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END) AS bots,
                SUM(CASE WHEN is_bot = 0 AND is_paid = 1 THEN 1 ELSE 0 END) AS paid,
                SUM(CASE WHEN is_bot = 0 AND in_app IS NOT NULL THEN 1 ELSE 0 END) AS in_app
         FROM site_visits WHERE datetime(visited_at) >= ?`,
      )
      .bind(since)
      .first<Record<string, number>>(),

    // ── series ──
    visitsByDay: db
      .prepare(
        `SELECT ${dayVisits} AS day, COUNT(*) AS visits,
                COUNT(DISTINCT ${VISITOR}) AS uniques,
                SUM(CASE WHEN is_paid = 1 THEN 1 ELSE 0 END) AS paid
         FROM site_visits WHERE is_bot = 0 AND datetime(visited_at) >= ?
         GROUP BY day`,
      )
      .bind(since)
      .all<{ day: string; visits: number; uniques: number; paid: number }>(),
    registeredByDay: db
      .prepare(
        `SELECT ${dayCreated} AS day, COUNT(*) AS cnt
         FROM creators WHERE is_seed = 0 AND datetime(created_at) >= ?
         GROUP BY day`,
      )
      .bind(since)
      .all<{ day: string; cnt: number }>(),
    connectedByDay: db
      .prepare(
        `SELECT ${dayConnected} AS day, COUNT(*) AS cnt
         FROM creators WHERE is_seed = 0 AND stripe_onboarding_completed_at IS NOT NULL
           AND datetime(stripe_onboarding_completed_at) >= ?
         GROUP BY day`,
      )
      .bind(since)
      .all<{ day: string; cnt: number }>(),
    firstTipsByDay: db
      .prepare(
        `SELECT ${dayFirstTip} AS day, COUNT(*) AS cnt FROM (
           SELECT t.creator_id, MIN(COALESCE(t.tipped_at, t.created_at)) AS first_at
           FROM tips t INNER JOIN creators c ON c.id = t.creator_id
           WHERE c.is_seed = 0 AND t.status = 'succeeded'
           GROUP BY t.creator_id
         ) WHERE datetime(first_at) >= ?
         GROUP BY day`,
      )
      .bind(since)
      .all<{ day: string; cnt: number }>(),
    tipsByDay: db
      .prepare(
        `SELECT ${dayTipped} AS day, COUNT(*) AS cnt,
                COALESCE(SUM(t.tip_amount_intended), 0) AS volume,
                COALESCE(SUM(t.platform_fee_minor), 0) AS platform,
                COALESCE(SUM(t.creator_net_minor), 0) AS net
         FROM tips t INNER JOIN creators c ON c.id = t.creator_id
         WHERE c.is_seed = 0 AND t.status = 'succeeded'
           AND datetime(COALESCE(t.tipped_at, t.created_at)) >= ?
         GROUP BY day`,
      )
      .bind(since)
      .all<{ day: string; cnt: number; volume: number; platform: number; net: number }>(),

    // ── funnel ──
    funnelWindow: db
      .prepare(funnelSql(true))
      .bind(since)
      .first<Record<string, number>>(),
    funnelAll: db.prepare(funnelSql(false)).first<Record<string, number>>(),

    // ── segments: visits side ──
    visitsBySource: segmentVisitsSql(db, "COALESCE(code, '')", since),
    visitsByDevice: segmentVisitsSql(db, "COALESCE(device, 'unknown')", since),
    visitsByOs: segmentVisitsSql(db, "COALESCE(os, 'other')", since),
    visitsByInApp: segmentVisitsSql(db, "COALESCE(in_app, 'browser')", since),
    visitsByCountry: segmentVisitsSql(db, "COALESCE(country, '??')", since),
    visitsByCreative: db
      .prepare(
        `SELECT ad_id AS key, COUNT(*) AS visits, COUNT(DISTINCT ${VISITOR}) AS uniques,
                COUNT(*) AS paid, MAX(code) AS code,
                MIN(${dayVisits}) AS first_day, MAX(${dayVisits}) AS last_day
         FROM site_visits
         WHERE is_bot = 0 AND is_paid = 1 AND ad_id IS NOT NULL AND datetime(visited_at) >= ?
         GROUP BY ad_id`,
      )
      .bind(since)
      .all<{ key: string; visits: number; uniques: number; paid: number; code: string | null; first_day: string; last_day: string }>(),
    referrers: db
      .prepare(
        `SELECT referrer_host AS host, COUNT(*) AS visits, COUNT(DISTINCT ${VISITOR}) AS uniques
         FROM site_visits
         WHERE is_bot = 0 AND referrer_host IS NOT NULL AND datetime(visited_at) >= ?
         GROUP BY referrer_host ORDER BY visits DESC LIMIT 15`,
      )
      .bind(since)
      .all<{ host: string; visits: number; uniques: number }>(),

    // ── segments: creators side (registered inside the window) ──
    creatorsBySource: segmentCreatorsSql(db, "COALESCE(UPPER(signup_code), '')", since),
    creatorsByDevice: segmentCreatorsSql(db, "COALESCE(signup_device, 'unknown')", since),
    creatorsByOs: segmentCreatorsSql(db, "COALESCE(signup_os, 'other')", since),
    creatorsByInApp: segmentCreatorsSql(db, "COALESCE(signup_in_app, 'browser')", since),
    creatorsByCountry: segmentCreatorsSql(db, "COALESCE(signup_country, '??')", since),
    creatorsByCreative: segmentCreatorsSql(db, "signup_ad_id", since, "signup_ad_id IS NOT NULL"),

    // ── tips in window (capped; enough for median/percentiles at this scale) ──
    tipRows: db
      .prepare(
        `SELECT t.tip_amount_intended AS amount, t.platform_fee_minor AS platform,
                t.creator_net_minor AS net, t.creator_id AS creator_id,
                CASE WHEN t.tipper_name IS NULL OR t.tipper_name = '' THEN 1 ELSE 0 END AS anon
         FROM tips t INNER JOIN creators c ON c.id = t.creator_id
         WHERE c.is_seed = 0 AND t.status = 'succeeded'
           AND datetime(COALESCE(t.tipped_at, t.created_at)) >= ?
         ORDER BY t.id DESC LIMIT 5001`,
      )
      .bind(since)
      .all<{ amount: number; platform: number; net: number; creator_id: number; anon: number }>(),

    // ── retention: every connected creator with first/last tip ──
    cohortRows: db
      .prepare(
        `SELECT c.id, c.stripe_onboarding_completed_at AS completed_at,
           (SELECT MIN(COALESCE(t.tipped_at, t.created_at)) FROM tips t
             WHERE t.creator_id = c.id AND t.status = 'succeeded') AS first_tip_at,
           (SELECT MAX(COALESCE(t.tipped_at, t.created_at)) FROM tips t
             WHERE t.creator_id = c.id AND t.status = 'succeeded') AS last_tip_at
         FROM creators c
         WHERE c.is_seed = 0 AND c.stripe_onboarding_completed_at IS NOT NULL
         ORDER BY c.stripe_onboarding_completed_at ASC LIMIT 2000`,
      )
      .all<{ id: number; completed_at: string; first_tip_at: string | null; last_tip_at: string | null }>(),

    // ── referrals & payouts ──
    referralsRow: db
      .prepare(`SELECT COUNT(*) AS cnt FROM creator_referrals WHERE datetime(created_at) >= ?`)
      .bind(since)
      .first<{ cnt: number }>(),
    payoutsRow: db
      .prepare(
        `SELECT
           SUM(CASE WHEN datetime(requested_at) >= ? THEN 1 ELSE 0 END) AS requested,
           SUM(CASE WHEN status = 'paid' AND paid_at IS NOT NULL AND datetime(paid_at) >= ? THEN 1 ELSE 0 END) AS paid,
           COALESCE(SUM(CASE WHEN status = 'paid' AND paid_at IS NOT NULL AND datetime(paid_at) >= ? THEN payout_amount_minor ELSE 0 END), 0) AS paid_minor
         FROM payouts`,
      )
      .bind(since, since, since)
      .first<{ requested: number; paid: number; paid_minor: number }>(),

    // ── pixel health ──
    sendsByEvent: db
      .prepare(
        `SELECT platform, event, ok, COUNT(*) AS cnt,
                SUM(CASE WHEN is_test = 1 THEN 1 ELSE 0 END) AS tests
         FROM pixel_sends WHERE datetime(created_at) >= ?
         GROUP BY platform, event, ok`,
      )
      .bind(since)
      .all<{ platform: string; event: string; ok: number; cnt: number; tests: number }>(),
    lastOkMeta: lastSendSql(db, "meta", 1),
    lastOkTiktok: lastSendSql(db, "tiktok", 1),
    lastErrMeta: lastSendSql(db, "meta", 0),
    lastErrTiktok: lastSendSql(db, "tiktok", 0),

    // ── learning phase: optimisation events sent OK (non-test) in 7d / 24h ──
    learning: db
      .prepare(
        `SELECT platform, event,
                SUM(CASE WHEN datetime(created_at) >= ? THEN 1 ELSE 0 END) AS c7,
                SUM(CASE WHEN datetime(created_at) >= ? THEN 1 ELSE 0 END) AS c24
         FROM pixel_sends
         WHERE ok = 1 AND is_test = 0 AND datetime(created_at) >= ?
           AND ((platform = 'meta' AND event = 'Lead')
             OR (platform = 'tiktok' AND event = 'CompleteRegistration'))
         GROUP BY platform, event`,
      )
      .bind(since7d, since24h, since7d)
      .all<{ platform: string; event: string; c7: number; c24: number }>(),
  });

  // ── series: dense, every day present, zeros where a series lacks the day ──
  const daysList = dayList(days, offset);
  const byDay = new Map<string, SeriesPoint>();
  for (const d of daysList) {
    byDay.set(d, {
      date: d, visits: 0, uniques: 0, paidVisits: 0, registered: 0, connected: 0,
      firstTips: 0, tips: 0, volumeNok: 0, platformNok: 0, creatorNetNok: 0,
    });
  }
  for (const r of q.visitsByDay.results ?? []) {
    const p = byDay.get(r.day); if (p) { p.visits = n(r.visits); p.uniques = n(r.uniques); p.paidVisits = n(r.paid); }
  }
  for (const r of q.registeredByDay.results ?? []) { const p = byDay.get(r.day); if (p) p.registered = n(r.cnt); }
  for (const r of q.connectedByDay.results ?? []) { const p = byDay.get(r.day); if (p) p.connected = n(r.cnt); }
  for (const r of q.firstTipsByDay.results ?? []) { const p = byDay.get(r.day); if (p) p.firstTips = n(r.cnt); }
  for (const r of q.tipsByDay.results ?? []) {
    const p = byDay.get(r.day);
    if (p) { p.tips = n(r.cnt); p.volumeNok = nok(r.volume); p.platformNok = nok(r.platform); p.creatorNetNok = nok(r.net); }
  }

  // ── segments: merge visit side and creator side by key ──
  const bySource = mergeSegments(q.visitsBySource.results ?? [], q.creatorsBySource.results ?? [], (k) =>
    k === "" ? "(direkte / organisk)" : k,
  );
  const byDevice = mergeSegments(q.visitsByDevice.results ?? [], q.creatorsByDevice.results ?? []);
  const byOs = mergeSegments(q.visitsByOs.results ?? [], q.creatorsByOs.results ?? []);
  const byInApp = mergeSegments(q.visitsByInApp.results ?? [], q.creatorsByInApp.results ?? []);
  const byCountry = mergeSegments(q.visitsByCountry.results ?? [], q.creatorsByCountry.results ?? []);

  const creativeVisits = (q.visitsByCreative.results ?? []).map((r) => ({
    key: r.key, visits: r.visits, uniques: r.uniques, paid: r.paid,
  }));
  const creativeExtra = new Map<string, { code: string | null; first_day: string; last_day: string }>();
  for (const r of q.visitsByCreative.results ?? []) {
    creativeExtra.set(r.key, { code: r.code, first_day: r.first_day, last_day: r.last_day });
  }
  const byCreative: CreativeRow[] = mergeSegments(creativeVisits, q.creatorsByCreative.results ?? []).map((row) => {
    const extra = creativeExtra.get(row.key);
    return { ...row, code: extra?.code ?? null, firstDay: extra?.first_day ?? null, lastDay: extra?.last_day ?? null };
  });

  // ── tips ──
  const tipRowsAll = q.tipRows.results ?? [];
  const truncated = tipRowsAll.length > 5000;
  const tipRows = truncated ? tipRowsAll.slice(0, 5000) : tipRowsAll;
  const amountsNok = tipRows.map((r) => n(r.amount) / 100).sort((a, b) => a - b);
  const presets = new Set([50, 100, 250, 500, 1000]);
  const bucketDefs: { label: string; test: (v: number) => boolean }[] = [
    { label: "50", test: (v) => v === 50 },
    { label: "51–99", test: (v) => v > 50 && v < 100 },
    { label: "100", test: (v) => v === 100 },
    { label: "101–249", test: (v) => v > 100 && v < 250 },
    { label: "250", test: (v) => v === 250 },
    { label: "251–499", test: (v) => v > 250 && v < 500 },
    { label: "500", test: (v) => v === 500 },
    { label: "501–999", test: (v) => v > 500 && v < 1000 },
    { label: "1000", test: (v) => v === 1000 },
    { label: "1001–2000", test: (v) => v > 1000 },
  ];
  const buckets = bucketDefs.map((b) => ({ label: b.label, count: amountsNok.filter(b.test).length }));
  const quantile = (p: number): number | null => {
    if (amountsNok.length === 0) return null;
    const idx = Math.min(amountsNok.length - 1, Math.max(0, Math.ceil(p * amountsNok.length) - 1));
    return Math.round(amountsNok[idx]);
  };
  const tips = {
    count: tipRows.length,
    creatorsTipped: new Set(tipRows.map((r) => r.creator_id)).size,
    avgNok: amountsNok.length ? Math.round(amountsNok.reduce((a, b) => a + b, 0) / amountsNok.length) : null,
    medianNok: quantile(0.5),
    p90Nok: quantile(0.9),
    maxNok: amountsNok.length ? Math.round(amountsNok[amountsNok.length - 1]) : null,
    anonymousPct: pct(tipRows.filter((r) => n(r.anon) === 1).length, tipRows.length),
    presetPct: pct(amountsNok.filter((v) => presets.has(v)).length, amountsNok.length),
    buckets,
    volumeNok: nok(tipRows.reduce((a, r) => a + n(r.amount), 0)),
    platformNok: nok(tipRows.reduce((a, r) => a + n(r.platform), 0)),
    creatorNetNok: nok(tipRows.reduce((a, r) => a + n(r.net), 0)),
    truncated,
  };

  // ── retention cohorts by Stripe-connect month (Europe/Oslo) ──
  const nowMs = Date.now();
  const cohortMap = new Map<string, AdminStats["retention"]["cohorts"][number]>();
  let activeLast30Total = 0;
  const cohortRows = q.cohortRows.results ?? [];
  for (const r of cohortRows) {
    const completedMs = Date.parse(r.completed_at);
    if (!Number.isFinite(completedMs)) continue;
    const month = new Date(completedMs + offset * 3600_000).toISOString().slice(0, 7);
    const c = cohortMap.get(month) ?? {
      month, creators: 0, tip30: 0, eligible30: 0, tip60: 0, eligible60: 0, tip90: 0, eligible90: 0, activeLast30: 0,
    };
    c.creators += 1;
    const ageDays = (nowMs - completedMs) / 86_400_000;
    const firstMs = r.first_tip_at ? Date.parse(r.first_tip_at) : NaN;
    const lastMs = r.last_tip_at ? Date.parse(r.last_tip_at) : NaN;
    const firstWithin = (d: number) => Number.isFinite(firstMs) && firstMs - completedMs <= d * 86_400_000;
    if (ageDays >= 30) { c.eligible30 += 1; if (firstWithin(30)) c.tip30 += 1; }
    if (ageDays >= 60) { c.eligible60 += 1; if (firstWithin(60)) c.tip60 += 1; }
    if (ageDays >= 90) { c.eligible90 += 1; if (firstWithin(90)) c.tip90 += 1; }
    if (Number.isFinite(lastMs) && nowMs - lastMs <= 30 * 86_400_000) { c.activeLast30 += 1; activeLast30Total += 1; }
    cohortMap.set(month, c);
  }

  // ── pixel health ──
  const platforms: AdminStats["health"]["platforms"] = (["meta", "tiktok"] as const).map((platform) => {
    const rows = (q.sendsByEvent.results ?? []).filter((r) => r.platform === platform);
    const events = new Map<string, { event: string; ok: number; failed: number }>();
    let okInWindow = 0, errorsInWindow = 0, testSends = 0;
    for (const r of rows) {
      const e = events.get(r.event) ?? { event: r.event, ok: 0, failed: 0 };
      if (n(r.ok) === 1) { e.ok += n(r.cnt); okInWindow += n(r.cnt); } else { e.failed += n(r.cnt); errorsInWindow += n(r.cnt); }
      testSends += n(r.tests);
      events.set(r.event, e);
    }
    const lastOk = platform === "meta" ? q.lastOkMeta : q.lastOkTiktok;
    const lastErr = platform === "meta" ? q.lastErrMeta : q.lastErrTiktok;
    const configured = platform === "meta"
      ? !!(env.META_PIXEL_ID && env.META_CAPI_TOKEN)
      : !!(env.TIKTOK_PIXEL_ID && env.TIKTOK_EVENTS_TOKEN);
    return {
      platform,
      configured,
      lastOkAt: lastOk?.created_at ?? null,
      lastOkEvent: lastOk?.event ?? null,
      okInWindow,
      errorsInWindow,
      testSendsInWindow: testSends,
      lastError: lastErr ? { at: lastErr.created_at, status: lastErr.status ?? null, detail: lastErr.detail ?? null } : null,
      byEvent: Array.from(events.values()).sort((a, b) => a.event.localeCompare(b.event)),
    };
  });

  // ── learning phase ──
  const learningRows = q.learning.results ?? [];
  const learningPlatforms: AdminStats["learning"]["platforms"] = (["meta", "tiktok"] as const).map((platform) => {
    const event = platform === "meta" ? "Lead" : "CompleteRegistration";
    const row = learningRows.find((r) => r.platform === platform);
    const c7 = n(row?.c7), c24 = n(row?.c24);
    const remaining = Math.max(0, LEARNING_TARGET - c7);
    const etaDays = c24 > 0 && remaining > 0 ? Math.ceil(remaining / c24) : null;
    const status: "learning" | "likely_out" | "no_data" = c7 === 0 ? "no_data" : c7 >= LEARNING_TARGET ? "likely_out" : "learning";
    return { platform, event, conversions7d: c7, last24h: c24, etaDays, status };
  });

  const t = q.traffic ?? {};
  const humans = n(t.humans);
  return {
    meta: {
      days,
      timezone: "Europe/Oslo",
      offsetHours: offset,
      generatedAt: new Date().toISOString(),
      since,
      today: daysList[daysList.length - 1],
    },
    traffic: {
      visits: n(t.visits),
      humans,
      uniques: n(t.uniques),
      bots: n(t.bots),
      paidVisits: n(t.paid),
      inAppVisits: n(t.in_app),
      botSharePct: pct(n(t.bots), n(t.visits)),
    },
    series: daysList.map((d) => byDay.get(d)!),
    funnel: {
      window: funnelFromRow(q.funnelWindow),
      allTime: funnelFromRow(q.funnelAll),
    },
    bySource: bySource.sort((a, b) => b.uniques - a.uniques || b.registered - a.registered),
    byCreative: byCreative.sort((a, b) => b.uniques - a.uniques),
    byDevice: byDevice.sort((a, b) => b.uniques - a.uniques),
    byOs: byOs.sort((a, b) => b.uniques - a.uniques),
    byInApp: byInApp.sort((a, b) => b.uniques - a.uniques),
    byCountry: byCountry.sort((a, b) => b.uniques - a.uniques).slice(0, 12),
    byReferrer: (q.referrers.results ?? []).map((r) => ({ host: r.host, visits: n(r.visits), uniques: n(r.uniques) })),
    tips,
    retention: {
      cohorts: Array.from(cohortMap.values()).sort((a, b) => a.month.localeCompare(b.month)),
      connectedTotal: cohortRows.length,
      activeLast30Total,
    },
    referrals: {
      creatorReferrals: n(q.referralsRow?.cnt),
      payoutsRequested: n(q.payoutsRow?.requested),
      payoutsPaid: n(q.payoutsRow?.paid),
      payoutsPaidNok: nok(q.payoutsRow?.paid_minor),
    },
    health: {
      testCodeActive: { meta: !!env.META_TEST_EVENT_CODE, tiktok: !!env.TIKTOK_TEST_EVENT_CODE },
      platforms,
    },
    learning: { target: LEARNING_TARGET, platforms: learningPlatforms },
  };
}

// ───────────────────────────── query builders ─────────────────────────────

function funnelSql(windowed: boolean): string {
  return `SELECT COUNT(*) AS registered,
            SUM(CASE WHEN c.email_verified = 1 THEN 1 ELSE 0 END) AS verified,
            SUM(CASE WHEN c.psp_subaccount_id IS NOT NULL AND c.psp_subaccount_id != '' THEN 1 ELSE 0 END) AS stripe_started,
            SUM(CASE WHEN c.stripe_transfers_active = 1 THEN 1 ELSE 0 END) AS connected,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM tips t WHERE t.creator_id = c.id AND t.status = 'succeeded') THEN 1 ELSE 0 END) AS first_tip
          FROM creators c
          WHERE c.is_seed = 0${windowed ? " AND datetime(c.created_at) >= ?" : ""}`;
}

function funnelFromRow(r: Record<string, number> | null | undefined): FunnelCounts {
  return {
    registered: n(r?.registered),
    verified: n(r?.verified),
    stripeStarted: n(r?.stripe_started),
    connected: n(r?.connected),
    firstTip: n(r?.first_tip),
  };
}

type VisitSeg = { key: string; visits: number; uniques: number; paid: number };
type CreatorSeg = { key: string; registered: number; verified: number; connected: number; first_tip: number };

function segmentVisitsSql(db: D1Database, keyExpr: string, since: string) {
  return db
    .prepare(
      `SELECT ${keyExpr} AS key, COUNT(*) AS visits,
              COUNT(DISTINCT COALESCE(visitor_id, visitor_hash)) AS uniques,
              SUM(CASE WHEN is_paid = 1 THEN 1 ELSE 0 END) AS paid
       FROM site_visits WHERE is_bot = 0 AND datetime(visited_at) >= ?
       GROUP BY ${keyExpr}`,
    )
    .bind(since)
    .all<VisitSeg>();
}

function segmentCreatorsSql(db: D1Database, keyExpr: string, since: string, extraWhere?: string) {
  return db
    .prepare(
      `SELECT ${keyExpr} AS key, COUNT(*) AS registered,
              SUM(CASE WHEN c.email_verified = 1 THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN c.stripe_transfers_active = 1 THEN 1 ELSE 0 END) AS connected,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM tips t WHERE t.creator_id = c.id AND t.status = 'succeeded') THEN 1 ELSE 0 END) AS first_tip
       FROM creators c
       WHERE c.is_seed = 0 AND datetime(c.created_at) >= ?${extraWhere ? ` AND ${extraWhere}` : ""}
       GROUP BY ${keyExpr}`,
    )
    .bind(since)
    .all<CreatorSeg>();
}

function lastSendSql(db: D1Database, platform: string, ok: number) {
  return db
    .prepare(
      `SELECT event, created_at, status, detail FROM pixel_sends
       WHERE platform = ? AND ok = ? ORDER BY id DESC LIMIT 1`,
    )
    .bind(platform, ok)
    .first<{ event: string; created_at: string; status: number | null; detail: string | null }>();
}

function mergeSegments(
  visits: VisitSeg[],
  creators: CreatorSeg[],
  label: (key: string) => string = (k) => k,
): SegmentRow[] {
  const map = new Map<string, SegmentRow>();
  const get = (key: string): SegmentRow => {
    const k = key ?? "";
    let row = map.get(k);
    if (!row) {
      row = {
        key: label(k), visits: 0, uniques: 0, paidVisits: 0, registered: 0, verified: 0,
        connected: 0, firstTip: 0, registeredRatePct: null, connectedRatePct: null,
      };
      map.set(k, row);
    }
    return row;
  };
  for (const v of visits) {
    const row = get(String(v.key ?? ""));
    row.visits = n(v.visits); row.uniques = n(v.uniques); row.paidVisits = n(v.paid);
  }
  for (const c of creators) {
    const row = get(String(c.key ?? ""));
    row.registered = n(c.registered); row.verified = n(c.verified);
    row.connected = n(c.connected); row.firstTip = n(c.first_tip);
  }
  for (const row of map.values()) {
    row.registeredRatePct = pct(row.registered, row.uniques);
    row.connectedRatePct = pct(row.connected, row.uniques);
  }
  return Array.from(map.values());
}
