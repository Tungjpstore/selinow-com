PRAGMA foreign_keys = OFF;

-- Rebuild the admission ledger to add authenticated shop provisioning while
-- preserving the existing magic-link rows and keyed identity columns.
DROP INDEX IF EXISTS idx_auth_request_admissions_window;
DROP INDEX IF EXISTS idx_auth_request_admissions_requester_window;
DROP INDEX IF EXISTS idx_auth_request_admissions_expiry;
DROP INDEX IF EXISTS idx_auth_request_admissions_subject_window;
ALTER TABLE auth_request_admissions RENAME TO auth_request_admissions_legacy_0094;

CREATE TABLE auth_request_admissions (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('magic_link_request', 'shop_create')),
  requester_hash TEXT NOT NULL CHECK (length(requester_hash) BETWEEN 16 AND 128),
  window_started_at TEXT NOT NULL,
  window_ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  subject_hash TEXT CHECK (subject_hash IS NULL OR length(subject_hash) BETWEEN 16 AND 128),
  delivery_permitted INTEGER NOT NULL DEFAULT 1 CHECK (delivery_permitted IN (0, 1)),
  CHECK (window_ends_at > window_started_at)
) STRICT;

INSERT INTO auth_request_admissions (
  id, action, requester_hash, window_started_at, window_ends_at, created_at,
  subject_hash, delivery_permitted
)
SELECT
  id, action, requester_hash, window_started_at, window_ends_at, created_at,
  subject_hash, delivery_permitted
FROM auth_request_admissions_legacy_0094;

DROP TABLE auth_request_admissions_legacy_0094;

CREATE INDEX idx_auth_request_admissions_window
  ON auth_request_admissions(action, window_started_at, id);

CREATE INDEX idx_auth_request_admissions_requester_window
  ON auth_request_admissions(action, requester_hash, window_started_at, id);

CREATE INDEX idx_auth_request_admissions_expiry
  ON auth_request_admissions(window_ends_at, id);

CREATE INDEX idx_auth_request_admissions_subject_window
  ON auth_request_admissions(action, subject_hash, window_started_at, id)
  WHERE subject_hash IS NOT NULL;

PRAGMA foreign_keys = ON;
