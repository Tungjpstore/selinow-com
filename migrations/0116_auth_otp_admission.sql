PRAGMA foreign_keys = ON;

-- Durable requester and email budgets for public OTP issuance.
CREATE TABLE auth_otp_admissions (
  id TEXT PRIMARY KEY NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register_verify', 'password_reset')),
  requester_hash TEXT NOT NULL CHECK (length(requester_hash) BETWEEN 16 AND 128),
  subject_hash TEXT NOT NULL CHECK (length(subject_hash) BETWEEN 16 AND 128),
  window_started_at TEXT NOT NULL,
  window_ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (window_ends_at > window_started_at)
) STRICT;

CREATE INDEX idx_auth_otp_admissions_window
  ON auth_otp_admissions(purpose, window_started_at, id);

CREATE INDEX idx_auth_otp_admissions_requester_window
  ON auth_otp_admissions(purpose, requester_hash, window_started_at, id);

CREATE INDEX idx_auth_otp_admissions_subject_window
  ON auth_otp_admissions(purpose, subject_hash, window_started_at, id);

CREATE INDEX idx_auth_otp_admissions_expiry
  ON auth_otp_admissions(window_ends_at, id);
