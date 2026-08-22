PRAGMA foreign_keys = ON;

-- Passwords for active passwordless accounts (Google/magic-link) are staged
-- here until the email OTP is verified. This prevents registration from
-- becoming an unverified password takeover path.
ALTER TABLE platform_users ADD COLUMN pending_password_hash TEXT DEFAULT NULL;
