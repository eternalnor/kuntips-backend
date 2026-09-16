// env.ts
export interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_CLIENT_ID: string;
  FRONTEND_BASE_URL: string;
  PLATFORM_FEE_BPS: string; // e.g. "500" for 5%

  // Webhook signing secret from Stripe Dashboard (platform events)
  STRIPE_WEBHOOK_SECRET: string;

  // Webhook signing secret for connect-account events (e.g. payout.paid)
  STRIPE_WEBHOOK_CONNECT_SECRET?: string;

  // D1 binding from wrangler config
  kuntips_db: D1Database;

  // KV binding for rate limiting + platform events
  kuntips_rl: KVNamespace;

  // Admin secret for protected admin endpoints
  ADMIN_SECRET: string;

  // Resend API key for outbound transactional email
  // Set via: wrangler secret put RESEND_API_KEY
  RESEND_API_KEY?: string;

  // Server-side conversion tracking (consent-gated). All optional — tracking
  // no-ops gracefully if unset. Set via `wrangler secret put`.
  META_PIXEL_ID?: string;       // Meta (Facebook) pixel / dataset id
  META_CAPI_TOKEN?: string;     // Meta Conversions API access token
  TIKTOK_PIXEL_ID?: string;     // TikTok pixel id
  TIKTOK_EVENTS_TOKEN?: string; // TikTok Events API access token

  // Set ONLY while testing. Routes Meta events to the Test Events view instead
  // of the live dataset, so verifying a conversion fires does not inject a fake
  // one into the data the algorithm optimises against. Remove when done:
  //   wrangler secret delete META_TEST_EVENT_CODE
  //   wrangler secret delete TIKTOK_TEST_EVENT_CODE
  //
  // Left set, every real conversion routes to the test view and the campaign
  // trains on nothing — which looks identical to "the ads aren't working".
  META_TEST_EVENT_CODE?: string;
  TIKTOK_TEST_EVENT_CODE?: string;
}
