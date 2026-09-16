-- 0021_tipper_name.sql
-- Optional display name left by the fan when tipping
ALTER TABLE tips ADD COLUMN tipper_name TEXT DEFAULT NULL;
