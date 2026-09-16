// src/visitMeta.ts
//
// Coarse request classification shared by the landing ping (/visit) and
// registration: device / OS / in-app browser from the user-agent, country from
// Cloudflare, bot detection, and sanitising of the ad-creative id.
//
// Everything here is a category, never an identifier. No raw UA or IP leaves
// this module except as a truncated hash used to count uniques.

const BOT_PATTERNS =
  /bot|crawl|spider|slurp|curl|wget|python-requests|python\/|scrapy|httpclient|java\/|go-http-client|okhttp|libwww|headless|phantom|puppeteer|playwright|facebookexternalhit|facebot|bytespider|petalbot|semrush|ahrefs|mj12|dotbot|yandex|baidu|duckduck|applebot|bingpreview|linkedinbot|twitterbot|pinterestbot|whatsapp|telegrambot|discordbot|slackbot|embedly|quora|lighthouse|pagespeed|gtmetrix|monitor|uptime/i;

export type VisitMeta = {
  device: "mobile" | "tablet" | "desktop";
  os: "ios" | "android" | "windows" | "mac" | "linux" | "other";
  inApp: string | null;
  country: string | null;
  isBot: boolean;
};

/** Which app's embedded browser this is, if any. Order matters: Instagram's
 *  webview also contains "FBAN"/"FBAV", so it is checked before Facebook. */
export function detectInApp(ua: string): string | null {
  const u = ua.toLowerCase();
  if (!u) return null;
  if (u.includes("instagram")) return "instagram";
  if (u.includes("tiktok") || u.includes("musical_ly") || u.includes("bytedancewebview")) return "tiktok";
  if (u.includes("fban") || u.includes("fbav") || u.includes("fb_iab") || u.includes("messenger")) return "facebook";
  if (u.includes("snapchat")) return "snapchat";
  if (u.includes("pinterest")) return "pinterest";
  if (u.includes("telegram")) return "telegram";
  if (u.includes("twitter") || u.includes("twitterandroid")) return "x";
  if (u.includes("reddit")) return "reddit";
  if (u.includes("discord")) return "discord";
  if (u.includes("linkedinapp")) return "linkedin";
  return null;
}

export function detectOs(ua: string): VisitMeta["os"] {
  const u = ua.toLowerCase();
  if (/iphone|ipad|ipod/.test(u)) return "ios";
  if (u.includes("android")) return "android";
  if (u.includes("windows")) return "windows";
  if (u.includes("mac os") || u.includes("macintosh")) return "mac";
  if (u.includes("linux") || u.includes("cros")) return "linux";
  return "other";
}

export function detectDevice(ua: string): VisitMeta["device"] {
  const u = ua.toLowerCase();
  if (/ipad|tablet|(android(?!.*mobile))/.test(u)) return "tablet";
  if (/mobi|iphone|ipod|android|phone/.test(u)) return "mobile";
  return "desktop";
}

/** A real browser always sends a User-Agent; a missing one is the strongest
 *  single bot signal. Pattern matches cover the scanners that do send one. */
export function isBotUa(ua: string): boolean {
  const trimmed = ua.trim();
  if (trimmed === "") return true;
  return BOT_PATTERNS.test(trimmed);
}

export function classifyRequest(request: Request): VisitMeta {
  const ua = request.headers.get("User-Agent") ?? "";
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const country =
    (cf && typeof cf.country === "string" && cf.country) ||
    request.headers.get("CF-IPCountry") ||
    null;
  return {
    device: detectDevice(ua),
    os: detectOs(ua),
    inApp: detectInApp(ua),
    country: country && country !== "XX" && country !== "T1" ? country.toUpperCase() : null,
    isBot: isBotUa(ua),
  };
}

/**
 * Sanitise an ad-creative id from the landing URL (?ad=). Platforms substitute
 * a macro — {{ad.id}} on Meta, __CID__ on TikTok — and every real id is
 * numeric, while no macro contains a digit. So a value without a digit is an
 * unexpanded macro and is rejected, which keeps phantom creatives such as
 * "{{ad.id}}" out of the dashboard.
 */
export function sanitizeAdId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  if (!cleaned || !/\d/.test(cleaned)) return null;
  return cleaned;
}

/** Browser-generated visitor id: opaque, random, ours. */
export function sanitizeVisitorId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}

/** Host of the page that linked here, or null (direct / stripped referrer). */
export function referrerHost(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
    return host ? host.slice(0, 100) : null;
  } catch {
    return null;
  }
}

/** Truncated hash of IP + UA: counts uniques, identifies nobody. */
export async function visitorHash(request: Request): Promise<string> {
  const ua = request.headers.get("User-Agent") ?? "";
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  const data = new TextEncoder().encode(`${ip}|${ua}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
