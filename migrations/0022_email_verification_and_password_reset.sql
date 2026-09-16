-- 0022_email_verification_and_password_reset.sql
PRAGMA foreign_keys = ON;

-- Email verification
ALTER TABLE creators ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE creators ADD COLUMN email_verification_token TEXT;
ALTER TABLE creators ADD COLUMN email_verification_sent_at TEXT;

-- Password reset
ALTER TABLE creators ADD COLUMN password_reset_token TEXT;
ALTER TABLE creators ADD COLUMN password_reset_token_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_creators_email_verification_token
  ON creators (email_verification_token);

CREATE INDEX IF NOT EXISTS idx_creators_password_reset_token
  ON creators (password_reset_token);
