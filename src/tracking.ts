// src/tracking.ts
// Server-side conversion tracking for Meta (Conversions API) and TikTok
// (Events API). Consent-gated by the caller. Shaped like email.ts's sendEmail:
// no-op + warn if secrets are unset, never throws, logs non-2xx, returns boolean.

import type { Env } from "./env";

const META_API_VERSION = "v21.0";

/** SHA-256 hex — required by Meta/TikTok for hashed PII (email). */
async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input.trim().toLowerCase());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Record every send attempt so /admin/stats can show tracker health: the last
 * successful send per platform, error counts, and whether events are going out
 * under a test-event code. Best-effort — a logging failure must never turn
 * into a tracking failure.
 */
async function logSend(
  env: Env,
  platform: "meta" | "tiktok",
  event: string,
  ok: boolean,
  status: number | null,
  detail: string | null,
  isTest: boolean,
): Promise<void> {
  try {
    await env.kuntips_db
      .prepare(
        `INSERT INTO pixel_sends (platform, event, ok, status, detail, is_test)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(platform, event, ok ? 1 : 0, status, detail ? detail.slice(0, 300) : null, isTest ? 1 : 0)
      .run();
  } catch (err) {
    console.error("[tracking] logSend failed:", err);
  }
}

type CommonParams = {
  eventId: string;
  email?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
};

// ─────────────────────────────── Meta CAPI ───────────────────────────────

async function fireMeta(
  env: Env,
  eventName: "Lead" | "CompleteRegistration" | "Purchase",
  params: CommonParams & { value?: number; currency?: string },
): Promise<boolean> {
  if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) {
    console.warn("[tracking] Meta secrets not set — skipping Meta event.");
    return false;
  }

  try {
    const userData: Record<string, unknown> = {};
    if (params.email) userData.em = [await sha256hex(params.email)];
    if (params.clientIp) userData.client_ip_address = params.clientIp;
    if (params.userAgent) userData.client_user_agent = params.userAgent;

    const customData: Record<string, unknown> = {};
    if (typeof params.value === "number") customData.value = params.value;
    if (params.currency) customData.currency = params.currency;

    const body: Record<string, unknown> = {
      data: [
        {
          event_name: eventName,
          event_time: nowUnix(),
          action_source: "website",
          event_id: params.eventId,
          user_data: userData,
          custom_data: customData,
        },
      ],
    };

    // When set, Meta routes the event to the Test Events view instead of the
    // live dataset. Without this, verifying that Lead fires means firing a real
    // conversion — and at low volume one fake Lead is a large share of the
    // signal the algorithm trains on. Unset in production; the field is simply
    // absent, so behaviour is unchanged.
    if (env.META_TEST_EVENT_CODE) {
      body.test_event_code = env.META_TEST_EVENT_CODE;
    }

    const url = `https://graph.facebook.com/${META_API_VERSION}/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(
      env.META_CAPI_TOKEN,
    )}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const isTest = !!env.META_TEST_EVENT_CODE;
    if (!res.ok) {
      const t = await res.text().catch(() => "(no body)");
      console.error(`[tracking] Meta CAPI error ${res.status}: ${t}`);
      await logSend(env, "meta", eventName, false, res.status, t, isTest);
      return false;
    }
    await logSend(env, "meta", eventName, true, res.status, null, isTest);
    return true;
  } catch (err) {
    console.error("[tracking] Meta CAPI failed:", err);
    await logSend(env, "meta", eventName, false, null, String(err), !!env.META_TEST_EVENT_CODE);
    return false;
  }
}

// ────────────────────────────── TikTok Events ─────────────────────────────

async function fireTikTok(
  env: Env,
  eventName: "CompleteRegistration" | "Subscribe" | "CompletePayment",
  params: CommonParams & { value?: number; currency?: string },
): Promise<boolean> {
  if (!env.TIKTOK_PIXEL_ID || !env.TIKTOK_EVENTS_TOKEN) {
    console.warn("[tracking] TikTok secrets not set — skipping TikTok event.");
    return false;
  }

  try {
    const user: Record<string, unknown> = {};
    if (params.email) user.email = await sha256hex(params.email);
    if (params.clientIp) user.ip = params.clientIp;
    if (params.userAgent) user.user_agent = params.userAgent;

    const properties: Record<string, unknown> = {};
    if (typeof params.value === "number") properties.value = params.value;
    if (params.currency) properties.currency = params.currency;

    const body: Record<string, unknown> = {
      event_source: "web",
      event_source_id: env.TIKTOK_PIXEL_ID,
      data: [
        {
          event: eventName,
          event_time: nowUnix(),
          event_id: params.eventId,
          user,
          properties,
        },
      ],
    };

    // Same purpose as the Meta test code: routes the event to TikTok's Test
    // Events view instead of live data, so verifying the path works does not
    // inject a fake conversion into what the algorithm optimises against.
    if (env.TIKTOK_TEST_EVENT_CODE) {
      body.test_event_code = env.TIKTOK_TEST_EVENT_CODE;
    }

    const res = await fetch(
      "https://business-api.tiktok.com/open_api/v1.3/event/track/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Access-Token": env.TIKTOK_EVENTS_TOKEN,
        },
        body: JSON.stringify(body),
      },
    );

    // TikTok answers HTTP 200 on failure too and reports the real result in a
    // body `code` field; only code 0 is a success.
    const isTest = !!env.TIKTOK_TEST_EVENT_CODE;
    const text = await res.text().catch(() => "");
    let bodyCode: number | null = null;
    try {
      const parsed = JSON.parse(text) as { code?: unknown };
      if (typeof parsed?.code === "number") bodyCode = parsed.code;
    } catch {
      // non-JSON body — judged on HTTP status alone
    }
    const accepted = res.ok && (bodyCode === null || bodyCode === 0);
    if (!accepted) {
      console.error(`[tracking] TikTok Events error ${res.status}: ${text}`);
      await logSend(env, "tiktok", eventName, false, res.status, text || "(no body)", isTest);
      return false;
    }
    await logSend(env, "tiktok", eventName, true, res.status, null, isTest);
    return true;
  } catch (err) {
    console.error("[tracking] TikTok Events failed:", err);
    await logSend(env, "tiktok", eventName, false, null, String(err), !!env.TIKTOK_TEST_EVENT_CODE);
    return false;
  }
}

// ─────────────────────────────── public API ───────────────────────────────

/** Fire a "Lead" (signup) conversion to both Meta and TikTok. */
export async function fireLead(
  env: Env,
  params: CommonParams,
): Promise<void> {
  await Promise.allSettled([
    fireMeta(env, "Lead", params),
    fireTikTok(env, "CompleteRegistration", params),
  ]);
}

/**
 * Fire the "creator is actually live" conversion — the creator finished Stripe
 * onboarding and the `transfers` capability went active, so they can genuinely
 * receive money.
 *
 * This is deliberately a *different* event from `fireLead`. Lead fires when the
 * signup form is submitted, which is a filled-in form, not a creator; optimising
 * ad delivery on it teaches the network to find people who start and abandon.
 * This one is the quality signal to optimise on once volume allows.
 *
 * Note the TikTok mapping: `fireLead` already sends TikTok's
 * `CompleteRegistration` for signup, so the deeper event uses `Subscribe` to
 * stay distinguishable in TikTok's reporting.
 */
export async function fireCreatorLive(
  env: Env,
  params: CommonParams,
): Promise<void> {
  await Promise.allSettled([
    fireMeta(env, "CompleteRegistration", params),
    fireTikTok(env, "Subscribe", params),
  ]);
}

/** Fire a "Purchase" (tip) conversion to both Meta and TikTok. */
export async function firePurchase(
  env: Env,
  params: CommonParams & { valueNok: number; currency?: string },
): Promise<void> {
  const value = Number(params.valueNok) || undefined;
  const currency = params.currency || "NOK";
  await Promise.allSettled([
    fireMeta(env, "Purchase", { ...params, value, currency }),
    fireTikTok(env, "CompletePayment", { ...params, value, currency }),
  ]);
}
