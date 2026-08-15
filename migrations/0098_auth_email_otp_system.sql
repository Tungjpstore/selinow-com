PRAGMA foreign_keys = ON;

-- Bổ sung mật khẩu, xác thực và lockout fields cho platform_users
ALTER TABLE platform_users ADD COLUMN password_hash TEXT;
ALTER TABLE platform_users ADD COLUMN is_verified INTEGER DEFAULT 0;
ALTER TABLE platform_users ADD COLUMN verification_token TEXT;
ALTER TABLE platform_users ADD COLUMN verified_at TEXT DEFAULT NULL;
ALTER TABLE platform_users ADD COLUMN failed_login_count INTEGER DEFAULT 0;
ALTER TABLE platform_users ADD COLUMN locked_until TEXT DEFAULT NULL;
ALTER TABLE platform_users ADD COLUMN email_verified_at TEXT DEFAULT NULL;

-- Bảng password_reset_tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expiry ON password_reset_tokens(expires_at);

-- Tạo bảng auth_email_otps quản lý OTP 6 số xác thực
CREATE TABLE IF NOT EXISTS auth_email_otps (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES platform_users(id) ON DELETE CASCADE,
  email_normalized TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register_verify', 'password_reset', 'email_change', 'login_2fa')),
  otp_hash TEXT NOT NULL,
  attempts_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_auth_email_otps_lookup
  ON auth_email_otps(email_normalized, purpose, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_email_otps_expiry
  ON auth_email_otps(expires_at);
