-- Store the KunTips platform fee (creator's share deducted) per tip.
-- Allows accurate net earnings display in the dashboard.
-- DEFAULT 0: existing tips without a stored fee will show gross = net (slightly off,
-- but we have very few historical tips and this corrects itself going forward).
ALTER TABLE tips ADD COLUMN platform_fee_minor INTEGER NOT NULL DEFAULT 0;
