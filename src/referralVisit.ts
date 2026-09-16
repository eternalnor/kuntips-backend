// src/referralVisit.ts
//
// Handles the top of the marketing funnel. Called once when a visitor arrives
// with ?ref=CODE on any page.
//
// Logs the visit, giving campaign stats a denominator. "3 signups" means
// nothing without knowing whether it took 10 visits or 1000.
//
// No cookie is set. This Worker is a different origin from kuntips.no, so any
// cookie from here would be third-party and blocked outright by Safari. The
// referral code itself lives in localStorage on the frontend; see referral.js
// for why a first-party cookie was considered and rejected.

import type { Env } from "./env";

const VALID_CODE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Coarse visitor fingerprint for counting uniques. Truncated hard on purpose:
 * enough to tell two visitors apart, not enough to identify either. No raw IP
 * or user-agent is ever stored.
 */
async function visitorHash(ip: string, ua: string): Promise<string> {
  const data = new TextEncoder().encode(`${ip}|${ua}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function handleReferralVisit(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: { code?: unknown; path?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const code =
    typeof body?.code === "string" && VALID_CODE.test(body.code.trim())
      ? body.code.trim().toUpperCase()
      : null;

  if (!code) {
    return new Response(JSON.stringify({ error: "invalid_code" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const path =
    typeof body?.path === "string" ? body.path.slice(0, 200) : null;

  const ua = request.headers.get("User-Agent") ?? "";
  const ip = request.headers.get("CF-Connecting-IP") ?? "";

  // A real browser always sends a User-Agent, so a request without one is not a
  // visitor. Flagged rather than dropped, and shown separately in the admin
  // table, so it cannot quietly inflate the denominator that conversion rate
  // divides by.
  const isBot = ua.trim() === "" ? 1 : 0;

  try {
    const hash = await visitorHash(ip, ua);
    await env.kuntips_db
      .prepare(
        `INSERT INTO referral_visits (code, visitor_hash, path, is_bot)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(code, hash, path, isBot)
      .run();
  } catch (err) {
    // Never fail the visitor's page load over analytics. The caller still sets
    // the cookie, so attribution survives even if logging breaks.
    console.error("[referralVisit] insert failed:", err);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
