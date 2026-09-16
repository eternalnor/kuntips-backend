// src/siteVisit.ts
//
// POST /visit — the landing ping. Fired by the frontend once per browser
// session for EVERY visitor (referral_visits only ever saw ?ref= arrivals).
//
// Gives /admin/stats its denominators: organic and direct traffic next to
// campaigns, conversion by device and by in-app browser, and per-ad-creative
// results. First-touch is not decided here — the dashboard takes the earliest
// visit per visitor_id, which is more honest than trusting the browser.

import type { Env } from "./env";
import {
  classifyRequest,
  referrerHost,
  sanitizeAdId,
  sanitizeVisitorId,
  visitorHash,
} from "./visitMeta";

const VALID_CODE = /^[A-Za-z0-9_-]{1,64}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleSiteVisit(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: Record<string, unknown> | null = null;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const code =
    typeof body?.code === "string" && VALID_CODE.test(body.code.trim())
      ? body.code.trim().toUpperCase()
      : null;
  const adId = sanitizeAdId(body?.ad);
  const visitorId = sanitizeVisitorId(body?.visitorId);
  const path = typeof body?.path === "string" ? body.path.slice(0, 200) : null;
  const refHost = referrerHost(body?.referrer);

  const meta = classifyRequest(request);

  try {
    const hash = await visitorHash(request);
    await env.kuntips_db
      .prepare(
        `INSERT INTO site_visits
           (visitor_id, visitor_hash, code, ad_id, is_paid, path, referrer_host,
            device, os, in_app, country, is_bot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        visitorId,
        hash,
        code,
        adId,
        adId ? 1 : 0,
        path,
        refHost,
        meta.device,
        meta.os,
        meta.inApp,
        meta.country,
        meta.isBot ? 1 : 0,
      )
      .run();
  } catch (err) {
    // Analytics must never break a page load.
    console.error("[siteVisit] insert failed:", err);
  }

  return json({ ok: true });
}
