PRAGMA foreign_keys = ON;

-- Email-OTP based two-factor authentication. The existing auth_email_otps
-- table already supports the 'login_2fa' purpose (see 0098); this migration
-- only adds the per-account enrollment flag. Enrollment is only ever set by
-- application code after a successful OTP confirmation, never by a bare
-- toggle, so no additional confirmation table is required here.
ALTER TABLE platform_users ADD COLUMN two_factor_enabled INTEGER NOT NULL DEFAULT 0 CHECK (
  two_factor_enabled IN (0, 1)
);
ALTER TABLE platform_users ADD COLUMN two_factor_enabled_at TEXT DEFAULT NULL;

-- Append-only login history for the account-security dashboard. Every row is
-- tied to a resolved platform_users.id: unresolved-email attempts are never
-- recorded here, so this table never becomes an email-enumeration oracle.
-- IP addresses are never stored in plaintext; only an HMAC digest (same
-- pattern as auth_request_admissions.requester_hash) is kept.
CREATE TABLE auth_login_history (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'success', 'invalid_credentials', 'account_locked', 'account_suspended',
    'email_unverified', 'two_factor_required', 'two_factor_failed'
  )),
  requester_hash TEXT NOT NULL CHECK (
    length(requester_hash) BETWEEN 16 AND 128
    AND requester_hash NOT GLOB '*[[:space:]]*'
  ),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_auth_login_history_user_created
  ON auth_login_history(user_id, created_at DESC, id);

-- Login history is a security ledger: once written, a row's outcome and
-- timestamp can never be altered or removed by application code.
CREATE TRIGGER auth_login_history_no_update
BEFORE UPDATE ON auth_login_history
BEGIN
  SELECT RAISE(ABORT, 'auth_login_history_immutable');
END;

CREATE TRIGGER auth_login_history_no_delete
BEFORE DELETE ON auth_login_history
BEGIN
  SELECT RAISE(ABORT, 'auth_login_history_immutable');
END;
