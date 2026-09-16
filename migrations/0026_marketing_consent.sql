-- 0026_marketing_consent.sql
--
-- Persist the visitor's marketing-consent choice against the creator.
--
-- Consent currently lives only in the visitor's browser (localStorage
-- `kuntips_cookie_consent`) and is passed along with the register request. That
-- works for the signup Lead, which fires while the browser is still there.
--
-- It does NOT work for anything fired later. `account.updated` arrives from
-- Stripe's servers, possibly days after signup, with no browser involved — so
-- there is nothing to read the consent from at that moment. Under GDPR we may
-- not share personal data with an ad network without being able to show consent
-- was given, so the answer has to already be on the row.

-- 0 = no consent (also the safe default for every existing creator, who was
-- never asked in a way we recorded).
ALTER TABLE creators ADD COLUMN marketing_consent INTEGER NOT NULL DEFAULT 0;

-- When consent was captured. Kept separately so we can demonstrate *when*, which
-- is part of what "demonstrable consent" means.
ALTER TABLE creators ADD COLUMN marketing_consent_at TEXT;
