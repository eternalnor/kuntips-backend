-- 0027_referral_visits.sql
--
-- Top of the marketing funnel.
--
-- Until now the earliest thing we could count was a signup, so a referral code
-- could tell us "3 people registered" but never whether that took 10 visits or
-- 1000. Without the denominator you cannot compare two campaigns, and you cannot
-- tell whether a bad result means "nobody clicked" or "everybody clicked and the
-- page failed them". Those need opposite fixes.
--
-- Privacy: no raw IP and no raw user-agent is stored. `visitor_hash` is a
-- truncated hash of IP + user-agent, which is enough to count unique visitors
-- and nothing else. This is first-party aggregate analytics for our own
-- campaigns — it identifies no one and is never shared.

CREATE TABLE IF NOT EXISTS referral_visits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL,
  visited_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Truncated hash of IP + UA. Counts uniques; cannot be reversed to a person.
  visitor_hash  TEXT,
  -- Landing path, so we can see whether a campaign pointed at the right page.
  path          TEXT,
  -- Lesson from a prior campaign: a request with no User-Agent at all is the
  -- strongest bot signal there is. Flagged rather than dropped, so the real
  -- click-quality ratio stays visible instead of being silently hidden.
  is_bot        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_referral_visits_code ON referral_visits(code);
CREATE INDEX IF NOT EXISTS idx_referral_visits_date ON referral_visits(visited_at);
CREATE INDEX IF NOT EXISTS idx_referral_visits_code_hash ON referral_visits(code, visitor_hash);
