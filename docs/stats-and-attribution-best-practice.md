# Marketing statistics, attribution and server-side pixels — best-practice playbook

A transferable description of how to build a decision-grade statistics backend for a small web product: who came, from which campaign and which ad creative, in which browser, how far they got, what it earned — plus the health of the ad-platform tracking that the campaigns depend on.

It is distilled from two working systems:

- **KunTips** (`kuntips-backend` / `kuntips-frontend`) — a JavaScript SPA with accounts, a multi-step signup funnel and payments. Browser pixels *and* server-side events, consent-gated.
- **mia-links** — a no-JavaScript link-in-bio page that gates, then redirects visitors out to a destination platform. Server-side events only. Its own full description lives in `mia-links/docs/stats-and-pixels-system-description.md`; this playbook folds in its lessons.

Written for a reader with no prior context. No secrets appear anywhere; platform ids are placeholders.

---

## 1. Pick the architecture first

| | **A. App with JavaScript** (KunTips pattern) | **B. No-JS redirect page** (mia-links pattern) |
|---|---|---|
| Use when | The site is an SPA/app, runs JS anyway, has accounts or a multi-step funnel | The page's only job is to route visitors out; CSP `default-src 'none'`; must survive ad blockers and locked-down in-app browsers |
| Visit capture | Frontend fires one landing ping per browser session to the API | The server sees every request itself; session cookie set by the server |
| Identity | Random visitor id in `localStorage` (first-party, functional) | `HttpOnly` server-set cookie (escapes Safari's 7-day cap on script-written cookies) |
| Pixels | Browser pixel **and** server event, deduplicated by a shared `event_id` | Server events only; dedup per visitor per platform via cookies |
| Conversion | A real account state (registered → verified → payment-ready → first revenue) | The outbound redirect to a real browser ("arrival") |
| Hard part | Joining a signup back to the visit; consent gating | In-app browsers that block the destination (escape flow + hand-off token) |

Everything from §2 onward applies to both unless marked **[A]** or **[B]**.

---

## 2. The rules (each one exists because of a real failure)

**Counting**
1. **Count people, not events.** Uniques are `COUNT(DISTINCT visitor)`, never rows. One person who taps twice is one person. (mia-links once sent 3.12 conversion events per person and trained the ad algorithm to find people who get *stuck*.)
2. **Bots are counted separately and excluded from every rate.** A missing User-Agent is the strongest single bot signal; pattern-match the rest. Flag, don't drop — the scanner load should stay visible. On a gated page, the *real* human filter is the form submission: scanners fetch pages but never submit forms (scanners outnumbered humans ~12:1 on mia-links).
3. **Every rate carries its denominator, and "no data" renders as "—", never "0 %".**
4. **Days are the ad account's days**, not UTC. Store UTC, bucket in the ad account's timezone at query time, and show the offset on the page.
5. **Say which population a chart plots, and say when it truncates.** A capped list or a capped row fetch gets a visible note.
6. **A chart counts a person on the day the event happened; a cohort table counts them on the day they arrived.** Totals differ slightly — state it on the page rather than let someone "find a bug".
7. **Immature cohorts get no rate.** A cohort that is 12 days old has no 30-day retention yet; show "too young", not a low percentage.

**Attribution**
8. **Source is first-touch; the ad creative is last-touch.** "What introduced this person to us" is the first thing they clicked. But clicking a second ad is a second paid click — the creative that gets credit is the last one clicked.
9. **Paid is only ever explicit.** Never infer "paid" from `fbclid`/`ttclid`: Meta appends `fbclid` to *organic* bio links too, which credited organic visitors to campaigns that were not running. Paid = an explicit paid tag or a **real ad id** on the URL.
10. **Reject unexpanded macros.** Platforms substitute `{{ad.id}}` (Meta) or `__CID__` (TikTok; `__AID__` is the ad *group*, not the creative). Every real id contains a digit; no macro does. So: strip to `[A-Za-z0-9_-]`, max 32 chars, **reject if it contains no digit**. Otherwise `{{ad.id}}` becomes a phantom creative in your tables.
11. **An unknown source is logged verbatim, never silently turned into "direct".** A typo in a campaign tag should be visible as a typo.
12. **Group by ad id only for paid visits**, or an organic return by someone who once clicked an ad gets filed under that ad.
13. **Typed links need vanity paths.** Caption and bio links are often typed, not clicked; nobody types `?ref=TIKTOK1`. Give each channel a two-letter path (`/tt`, `/ig`) that redirects to the coded URL. Make sure the paths cannot collide with user-generated slugs (KunTips usernames are ≥3 chars, so 2-letter paths are safe).
14. **The cookie must outrank the user agent [B].** Ranking the in-app UA above the first-touch cookie downgraded paid visitors to organic mid-session.
15. **Keep paid and organic on separate codes for the same platform.** TikTok ads and the TikTok bio sharing one code means you cannot tell which one worked.

**Pixels**
16. **Optimise on the deepest event you can measure**, deduplicated per person per platform. The shallow event recruits exactly the people who abandon.
17. **Event names must be the platform's standard names**, per platform. A custom name cannot be optimised on. On Meta, stay within the objective's family (`InitiateCheckout` is ecommerce-family and is greyed out under a Leads objective).
18. **A test-event code must be opt-in, absent by default, and the dashboard must shout when one is set.** A leftover code routes every real conversion to the Test Events view, where it counts for nothing, while everything else looks healthy.
19. **TikTok answers HTTP 200 on failure.** The real result is a `code` field in the body; only `code: 0` is success.
20. **Log every send attempt.** Last successful send, error count, and per-event send counters are what distinguish "token revoked", "a regression stopped the call", and "the bot filter started matching real people" — three failures that otherwise all look like "the ads stopped working".
21. **Never make the visitor wait on a platform.** Sends are fire-and-forget (`ctx.waitUntil` or awaited inside a non-blocking path) and wrapped so they can never throw into the user flow.
22. **The platform's number and your log are different numbers.** The platform counts only what it can attribute, plus modelled conversions, inside its attribution window — typically ~⅔ of yours. Read platform figures a day late; they revise upward, and same-day comparison always favours the older creative.
23. **Consent gates tracking, not functionality [A].** Marketing pixels and server events fire only after opt-in. The visitor id and the campaign code are first-party functional storage and are *not* gated — gating them would make conversion rates lie for everyone who declines cookies, and no third party ever sees them.

**Engineering**
24. **Key parallel queries by name, never by position.** `const [a,b,c] = await Promise.all([...])` silently shifts every variable when a query is inserted in the middle; nothing throws and every cell renders the wrong number.
25. **Analytics must never break a page load.** Every insert is wrapped; failure logs and returns OK.
26. **No raw IP and no raw user-agent are stored.** Store coarse categories (device, OS, in-app app, country) and a truncated hash for uniqueness.
27. **Hold one variable constant before reading another.** Hour-of-day once looked like a time effect and was a source-mix effect.

---

## 3. Data model (SQLite / Cloudflare D1 — copy and adapt)

```sql
-- One row per landing, once per browser session, for EVERY visitor.
CREATE TABLE IF NOT EXISTS site_visits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  visited_at     TEXT    NOT NULL DEFAULT (datetime('now')),  -- UTC
  visitor_id     TEXT,        -- browser-generated random id
  visitor_hash   TEXT,        -- truncated hash(IP + UA): uniqueness fallback only
  code           TEXT,        -- campaign/source code on THIS landing, uppercased
  ad_id          TEXT,        -- ad creative id on THIS landing (digit rule applied)
  is_paid        INTEGER NOT NULL DEFAULT 0,   -- 1 when a real ad id was present
  path           TEXT,
  referrer_host  TEXT,
  device         TEXT,        -- mobile | tablet | desktop
  os             TEXT,        -- ios | android | windows | mac | linux | other
  in_app         TEXT,        -- instagram | tiktok | facebook | ... | NULL
  country        TEXT,        -- ISO-2 from the edge
  is_bot         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_site_visits_date    ON site_visits (visited_at);
CREATE INDEX IF NOT EXISTS idx_site_visits_visitor ON site_visits (visitor_id);
CREATE INDEX IF NOT EXISTS idx_site_visits_code    ON site_visits (code, visited_at);
CREATE INDEX IF NOT EXISTS idx_site_visits_ad      ON site_visits (ad_id, visited_at);

-- On the conversion entity (users/creators/orders): the attribution facts of
-- the visit that became the conversion, written at conversion time.
ALTER TABLE creators ADD COLUMN visitor_id     TEXT;
ALTER TABLE creators ADD COLUMN signup_code    TEXT;   -- first-touch source
ALTER TABLE creators ADD COLUMN signup_ad_id   TEXT;   -- last-touch creative
ALTER TABLE creators ADD COLUMN signup_device  TEXT;
ALTER TABLE creators ADD COLUMN signup_os      TEXT;
ALTER TABLE creators ADD COLUMN signup_in_app  TEXT;
ALTER TABLE creators ADD COLUMN signup_country TEXT;

-- One row per server-side conversion attempt → tracker health.
CREATE TABLE IF NOT EXISTS pixel_sends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  platform    TEXT    NOT NULL,   -- meta | tiktok
  event       TEXT    NOT NULL,
  ok          INTEGER NOT NULL,   -- 1 = the platform accepted it
  status      INTEGER,            -- HTTP status
  detail      TEXT,               -- truncated response body on failure
  is_test     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pixel_sends_platform_date ON pixel_sends (platform, created_at);

-- Admin-managed campaign codes (so codes are created deliberately, can be
-- deactivated, and carry a description of where they are posted).
CREATE TABLE IF NOT EXISTS referral_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL, description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Pattern B (no-JS page)** uses `sessions` (one row per visitor, first-touch facts, written once with `COALESCE(existing, new)`) plus an append-only `events` log (`view`, `gate_pass`, `click`, `out`, `escape`, `escape_return`, pixel errors) and a small `settings` key/value table for heartbeats and learned ad→code mappings. See the mia-links description for the full schema.

**Timestamps:** some columns end up as SQLite `YYYY-MM-DD HH:MM:SS`, others as JS ISO strings with `T`/`Z`. Always compare through `datetime(col) >= ?` so both shapes normalise.

---

## 4. Capture layer

### 4.1 The landing ping [A]

Fire once per browser session from the app shell, for every visitor. Three details matter:

```js
export function pingLanding() {
  // Read the LIVE url, not the router's location for the render that fired the
  // effect: a redirect during render leaves the router's search stale.
  const pathname = window.location.pathname;
  if (VANITY_PATHS[pathname.replace(/^\/+|\/+$/g, "").toLowerCase()]) return; // the redirected render pings instead
  try {
    if (sessionStorage.getItem("visit_pinged") === "1") return;
    sessionStorage.setItem("visit_pinged", "1");
  } catch { /* storage unavailable — ping anyway rather than lose the visit */ }
  const params = new URLSearchParams(window.location.search);
  fetch(`${API}/visit`, {
    method: "POST", keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      visitorId: getVisitorId(),
      code: params.get("ref"), ad: params.get("ad"),
      path: pathname, referrer: document.referrer || null,
    }),
  }).catch(() => {});
}
```

- **The bug this shape prevents:** with a vanity redirect (`/tt → /?ref=TIKTOK1`), the effect fired with the router's stale, empty query string, set the once-per-session lock, and the redirected render could no longer ping — so every vanity visit lost its code. Read `window.location`, and never ping from the redirecting path.
- The client sends `document.referrer` because the API only ever sees the page URL as its `Referer`.
- First-touch is **decided at query time** (earliest visit per visitor), not trusted from the browser.

### 4.2 Server-side classification

The API derives device / OS / in-app browser from the User-Agent, country from the edge (`request.cf.country` / `CF-IPCountry`), and the bot flag. In-app detection order matters: Instagram's webview also contains `FBAN`/`FBAV`, so check Instagram before Facebook. TikTok appears as `tiktok`, `musical_ly` or `BytedanceWebview`.

```ts
export function sanitizeAdId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return cleaned && /\d/.test(cleaned) ? cleaned : null;   // no digit = unexpanded macro
}
```

### 4.3 Joining the conversion to the visit

At conversion time (registration, order, …) the client sends `visitorId` and the stored last-touch `adId`; the server re-classifies the request and writes the attribution columns. From then on, every segment table is a merge of two grouped queries — visits by key, conversions by the same key — never a fragile per-row join.

### 4.4 Campaign link formats

```
TikTok ad:   https://example.com/?ref=TIKTOK1P&ad=__CID__
Meta ad:     https://example.com/?ref=IG1P&ad={{ad.id}}
Bio/caption: https://example.com/tt        (vanity → /?ref=TIKTOK1)
```

### 4.5 In-app browsers [B, and worth measuring in A]

Some apps block the destination inside their embedded browser. mia-links never offers money links there; it shows an "open in your real browser" page and hands the session across with a signed token (`base64url(sid.expiry) + "." + HMAC-SHA256`, 30 min), counting a return **only when redeemed outside an app browser** — the webview itself follows the redirect and would otherwise redeem its own token (32 of the first 45 "returns" were fake). Store click ids (`fbc`, `ttclid`) on the session row server-side, because the escape lands in a fresh browser with no cookies; without that, the strongest match signal was dropped on ~70 % of paid conversions.

For an app-type site, at minimum **segment conversion by `in_app` vs real browser** — a signup + email verification + identity check is fragile inside a webview, and the table tells you whether an escape flow is worth building.

---

## 5. Server-side pixels

**Funnel → event names.** Map each funnel step to each platform's *standard* event, and keep the mapping in one table:

| Step | Meta | TikTok |
|---|---|---|
| Landing / view | `PageView` | `Pageview` |
| Intent (tap / form submitted) | `Lead` | `ClickButton` or `CompleteRegistration` |
| Deepest reliable outcome | `CompleteRegistration` | `CompleteRegistration` / `Subscribe` |
| Revenue | `Purchase` | `CompletePayment` |

**Dedup.** [A] the browser pixel and the server event share one `event_id` generated client-side and posted with the conversion; the platform marks one of them "Deduplicated". [B] one conversion per visitor **per platform**, tracked by separate cookies — a single shared cookie let the first platform consume the visitor's only conversion.

**Match keys.** Hashed email when you have it; IP + user agent; click ids (`fbc`, `ttclid`); and an `external_id` (SHA-256 of your own visitor/session id) on **every** event — the only key that covers all traffic, and the one that lets the platform join a visitor's events.

**Payload skeletons**

```json
// Meta  POST https://graph.facebook.com/v21.0/<PIXEL_ID>/events?access_token=<TOKEN>
{"data":[{"event_name":"Lead","event_time":1690000000,"event_id":"<uuid>",
  "action_source":"website",
  "user_data":{"em":["<sha256>"],"client_ip_address":"…","client_user_agent":"…"},
  "custom_data":{}}],
 "test_event_code":"<ONLY WHILE TESTING>"}

// TikTok  POST https://business-api.tiktok.com/open_api/v1.3/event/track/   header Access-Token
{"event_source":"web","event_source_id":"<PIXEL_ID>",
 "data":[{"event":"CompleteRegistration","event_time":1690000000,"event_id":"<uuid>",
   "user":{"email":"<sha256>","ip":"…","user_agent":"…"},"properties":{}}],
 "test_event_code":"<ONLY WHILE TESTING>"}
```

**The send wrapper** (no-op + warn if secrets are unset, never throws, judges TikTok by body `code`, logs every attempt):

```ts
const text = await res.text().catch(() => "");
let bodyCode: number | null = null;
try { const p = JSON.parse(text); if (typeof p?.code === "number") bodyCode = p.code; } catch {}
const accepted = res.ok && (bodyCode === null || bodyCode === 0);
await logSend(env, "tiktok", eventName, accepted, res.status, accepted ? null : text, !!env.TIKTOK_TEST_EVENT_CODE);
```

Never put the destination or anything sensitive in an event payload; `event_source_url` is always your own origin.

---

## 6. The stats endpoint

One authenticated `GET /admin/stats?days=7|30|90`. Building blocks:

```ts
// Offset of the ad account's timezone, computed at request time
function tzOffsetHours(tz = "Europe/Oslo"): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
    .formatToParts(new Date()).find(p => p.type === "timeZoneName")?.value ?? "";
  const m = part.match(/([+-])(\d{1,2})/);
  return m ? (m[1] === "-" ? -1 : 1) * parseInt(m[2], 10) : 0;
}
// SQL fragment: the local calendar day of a stored UTC timestamp
const localDay = (col: string, off: number) =>
  `DATE(datetime(${col}, '${off >= 0 ? "+" : "-"}${Math.abs(off)} hours'))`;

// Promise.all keyed by name
export async function promiseAllNamed<T extends Record<string, Promise<any>>>(tasks: T) {
  const keys = Object.keys(tasks) as (keyof T)[];
  const settled = await Promise.all(keys.map(k => tasks[k]));
  const out = {} as { [K in keyof T]: Awaited<T[K]> };
  keys.forEach((k, i) => { out[k] = settled[i]; });
  return out;
}
```

- **Dense series:** generate the list of local days for the window in code, then merge each grouped query into it, so every series has every day with explicit zeros.
- **Segments:** one query groups visits by key (`visits`, `uniques`, `paid`); another groups conversions by the same key (`registered`, `verified`, `connected`, `first revenue`); merge in code; compute `rate = conversions ÷ uniques` with `null` when uniques = 0.
- **Uniques:** `COUNT(DISTINCT COALESCE(visitor_id, visitor_hash))`.
- **Medians/percentiles:** SQLite has none; fetch the window's amounts (cap at N, note if truncated) and compute in code.
- **Exclude seed/demo/test accounts** from every business metric (`is_seed = 0`).
- **Learning-phase numbers** are counted over a rolling 7 days *regardless of the page window* — that is the platform's window, not yours.

---

## 7. Dashboard panels (top to bottom)

1. **Header** — window links, timezone + offset, population note.
2. **Tracker health** per platform — configured?, last successful send (age + event), OK/error counts in window, per-event counters, last error text, **red banner if a test-event code is set**, with the exact command to remove it.
3. **Learning phase** — conversions in the last 7 days vs ~50, rate over the last 24 h, ETA; "leave the ad set alone — every edit restarts the count"; labelled a *ceiling* (the platform attributes ~⅔).
4. **Traffic** — human visits, uniques, bots + share, paid visits, in-app visits.
5. **Funnel over time** — toggled line series (uniques, registered, payment-ready, first revenue).
6. **Money over time** — volume, paid to users, platform revenue.
7. **Funnel as rates** — window cohort vs all-time, % of total and % of previous step.
8. **By source** and 9. **By ad creative** — with the Verdict column.
10. **Device / OS / in-app vs browser / country**, 11. **Referrers**.
12. **Behaviour** (amount avg/median/p90, distribution, anonymous share) — and state plainly what *cannot* be measured (KunTips cannot see repeat tippers: receipt emails go straight to the payment processor).
13. **Retention cohorts** by activation month — 30/60/90-day outcome only for cohorts old enough, plus "active in the last 30 days".
14. **CSV export on every table** — semicolon-separated with a UTF-8 BOM, which is what Norwegian Excel opens cleanly.
15. **Routing reference generated from config** [B], so documentation cannot drift from behaviour.

### The Verdict algorithm (which creative is actually best)

Ranking by raw rate lets a 1-of-2 fluke (50 %) outrank a 30-of-100 (30 %) — exactly how a working ad gets retired.

```js
function wilsonLower(hits, total, z = 1.96) {          // 95 % lower bound
  if (!total) return 0;
  const p = hits / total, d = 1 + z*z/total;
  const centre = p + z*z/(2*total);
  const margin = z * Math.sqrt((p*(1-p) + z*z/(4*total)) / total);
  return Math.max(0, (centre - margin) / d);
}
```

- Fewer than **25 unique visitors** → `too early`, not judged.
- Rank qualifying creatives by lower bound.
- Exactly one qualifies → `best so far — nothing to compare`.
- Two or more → the leader gets `★ best` **only if its lower bound beats the runner-up's observed rate**; otherwise `too close to call` with no star. (Ranking by confidence means the leader can show a *lower* percentage than the row beneath it; say so under the table.)
- Let the operator choose the outcome being judged: the fast one (registered) or the true one (payment-ready).

---

## 8. Verification and operations runbook

**Conversion test (before any ad spend)**
1. Set the test-event-code secrets for both platforms. **Wait a minute** — a secret change is a mini-deploy; a test fired immediately can hit an instance that has not picked it up, and the event then goes out *unstamped* (delivered as real data, invisible in the test view).
2. Keep both platforms' Test Events pages open (they are live feeds).
3. Fresh private window → coded landing URL → **accept marketing cookies** (everything is consent-gated; declining looks exactly like broken tracking) → complete the conversion.
4. Expect: server event on both platforms, and on Meta the browser event marked "Deduplicated" against the server event with the same id.
5. **Delete both test-code secrets in the same sitting.** Deactivate the throwaway accounts.
   Test codes are per *channel* in Meta's UI ("Website" is the right one for a web Conversions API event, even though the event is sent by a server).

**Smoke-testing a new capture endpoint**
- `curl` it with a body that includes an unexpanded macro (`"ad":"{{ad.id}}"`) and confirm the row stores `ad_id = NULL`, `is_paid = 0`.
- Then load the real site in a browser and check the row: code, device, OS, country, `is_bot = 0`.
- Test the vanity path specifically — it is the case that breaks.
- **Delete your own test rows** (both the visit table and any legacy visit table) so production stats start clean. Inspect with `SELECT` before every `DELETE`.

**Migrations (Cloudflare D1)**
- Apply order for a release: **migration → backend deploy → frontend deploy.**
- If `migrations apply` lists files you know are live and fails with `duplicate column name`, the *ledger* is behind, not the database (files were once run via `d1 execute --file`). Fix: confirm each file's fingerprint (`sqlite_master` for tables, `pragma_table_info` for columns), `INSERT` the missing names into `d1_migrations`, re-run — only the genuinely new file applies. Never re-run the old SQL.
- `CREATE TABLE IF NOT EXISTS` does not add columns to an existing local table; rebuild local D1 from the full migration set when testing schema changes.

**Hygiene**
- Backend source must be committed. (KunTips's Worker ran in production for months with only an "Initial commit" in git; a disk failure would have taken the source with it.) Before the first commit: confirm `.dev.vars`/`.env` are ignored and grep for secret patterns.
- Remove scaffold tests that can only fail; a permanently red test run hides real failures.
- Never paste tokens into a chat, a commit or a log line; rotate anything that leaks.

---

## 9. Porting checklist for a new project

1. Decide architecture A or B (§1).
2. Create `site_visits` (or `sessions` + `events`), attribution columns on the conversion entity, `pixel_sends`, `referral_codes` (§3).
3. Implement request classification + `sanitizeAdId` + bot detection (§4.2).
4. Implement the capture: landing ping with the three safeguards **[A]**, or server-side session/event logging **[B]** (§4.1).
5. Pass `visitorId` + last-touch `adId` with the conversion; write attribution columns (§4.3).
6. Add vanity paths that cannot collide with user slugs (§2 rule 13).
7. Wrap platform sends: standard event names, shared `event_id`, body-`code` check for TikTok, `logSend` on every attempt, opt-in test codes (§5).
8. Build `/admin/stats` with named queries, local-day bucketing, dense series, merged segments (§6).
9. Build the page: tracker health first, Verdict on creatives, denominators everywhere, CSV export (§7).
10. Run the conversion test, clean up, and only then spend money (§8).
11. Put the landing-URL formats with macros in front of whoever builds the ads (§4.4), and the reading rules (§2 rules 16–22) in front of whoever reads the numbers.

---

## 10. Reference implementation (KunTips)

| Concern | File |
|---|---|
| Schema | `kuntips-backend/migrations/0027_referral_visits.sql`, `0028_site_visits_and_pixel_sends.sql` |
| Request classification, ad-id rule, bot patterns | `kuntips-backend/src/visitMeta.ts` |
| Landing ping endpoint | `kuntips-backend/src/siteVisit.ts` |
| Pixel sends + health logging | `kuntips-backend/src/tracking.ts` |
| Attribution at signup | `kuntips-backend/src/auth.ts` (`handleRegister`, step 3a) |
| Stats queries | `kuntips-backend/src/admin/stats.ts` |
| Named `Promise.all` | `kuntips-backend/src/util/promiseAllNamed.ts` |
| Campaign-code CRUD + per-code funnel | `kuntips-backend/src/admin/referralCodes.ts` |
| Visitor id, last-touch ad, landing ping | `kuntips-frontend/src/visit.js` |
| First-touch campaign code | `kuntips-frontend/src/referral.js` |
| Vanity paths | `kuntips-frontend/src/vanity.js` + routes in `src/App.jsx` |
| Consent gate + pixel loader | `kuntips-frontend/src/consent.js`, `src/components/TrackingScripts.jsx` |
| Dashboard page (Verdict, CSV, charts) | `kuntips-frontend/src/pages/admin/AdminStats.jsx` |
