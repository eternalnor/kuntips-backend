-- 0028_site_visits_and_pixel_sends.sql
--
-- Marketing statistics foundation for /admin/stats.
--
-- 1) site_visits: one row per landing (once per browser session), for EVERY
--    visitor — not only ?ref= arrivals, which is all referral_visits sees. This
--    is what lets the dashboard show organic/direct traffic next to campaigns,
--    conversion by device and by in-app browser, and per-ad-creative results.
--
--    Privacy: no raw IP, no raw user-agent. `visitor_id` is a random id the
--    browser generated for itself (first-party functional storage, same as the
--    referral code); `visitor_hash` is a truncated IP+UA hash used only as a
--    uniqueness fallback. Device/OS/in-app/country are coarse categories.
--
-- 2) creators.*: the attribution facts of the visit that became a signup, so
--    visit → registered → verified → Stripe-connected can be joined per source,
--    per ad creative, per device and per in-app browser.
--
-- 3) pixel_sends: one row per server-side conversion attempt to Meta / TikTok.
--    Powers the tracker-health panel — last successful send, error counts, and
--    a loud warning when a test-event code is still set — so "the ads stopped
--    working" can be told apart from "the token died" and "we stopped sending".

CREATE TABLE IF NOT EXISTS site_visits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  visited_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  visitor_id     TEXT,                 -- browser-generated random id
  visitor_hash   TEXT,                 -- truncated hash(IP + UA), uniqueness fallback
  code           TEXT,                 -- ?ref= on THIS landing, uppercased, or NULL
  ad_id          TEXT,                 -- ?ad= creative id on THIS landing, or NULL
  is_paid        INTEGER NOT NULL DEFAULT 0, -- 1 when a real ad id was present
  path           TEXT,
  referrer_host  TEXT,                 -- host of document.referrer, or NULL
  device         TEXT,                 -- mobile | tablet | desktop
  os             TEXT,                 -- ios | android | windows | mac | linux | other
  in_app         TEXT,                 -- instagram | tiktok | facebook | ... | NULL
  country        TEXT,                 -- ISO-2 from Cloudflare
  is_bot         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_site_visits_date     ON site_visits (visited_at);
CREATE INDEX IF NOT EXISTS idx_site_visits_visitor  ON site_visits (visitor_id);
CREATE INDEX IF NOT EXISTS idx_site_visits_code     ON site_visits (code, visited_at);
CREATE INDEX IF NOT EXISTS idx_site_visits_ad       ON site_visits (ad_id, visited_at);

ALTER TABLE creators ADD COLUMN visitor_id     TEXT;
ALTER TABLE creators ADD COLUMN signup_ad_id   TEXT;
ALTER TABLE creators ADD COLUMN signup_device  TEXT;
ALTER TABLE creators ADD COLUMN signup_os      TEXT;
ALTER TABLE creators ADD COLUMN signup_in_app  TEXT;
ALTER TABLE creators ADD COLUMN signup_country TEXT;

CREATE INDEX IF NOT EXISTS idx_creators_visitor_id   ON creators (visitor_id);
CREATE INDEX IF NOT EXISTS idx_creators_signup_ad_id ON creators (signup_ad_id);

CREATE TABLE IF NOT EXISTS pixel_sends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  platform    TEXT    NOT NULL,        -- meta | tiktok
  event       TEXT    NOT NULL,        -- Lead, CompleteRegistration, Purchase, ...
  ok          INTEGER NOT NULL,        -- 1 = platform accepted it
  status      INTEGER,                 -- HTTP status
  detail      TEXT,                    -- truncated response body on failure
  is_test     INTEGER NOT NULL DEFAULT 0 -- sent with a test-event code
);

CREATE INDEX IF NOT EXISTS idx_pixel_sends_platform_date ON pixel_sends (platform, created_at);
CREATE INDEX IF NOT EXISTS idx_pixel_sends_ok_date       ON pixel_sends (ok, created_at);
