PRAGMA foreign_keys = ON;

-- Accepted anonymous auth attempts are bounded by both requester and platform
-- budgets before any platform user or magic-link token is created.
CREATE TABLE auth_request_admissions (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('magic_link_request')),
  requester_hash TEXT NOT NULL CHECK (length(requester_hash) BETWEEN 16 AND 128),
  window_started_at TEXT NOT NULL,
  window_ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (window_ends_at > window_started_at)
) STRICT;

CREATE INDEX idx_auth_request_admissions_window
  ON auth_request_admissions(action, window_started_at, id);

CREATE INDEX idx_auth_request_admissions_requester_window
  ON auth_request_admissions(action, requester_hash, window_started_at, id);

CREATE INDEX idx_auth_request_admissions_expiry
  ON auth_request_admissions(window_ends_at, id);
