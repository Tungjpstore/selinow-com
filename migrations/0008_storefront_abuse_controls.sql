PRAGMA foreign_keys = ON;

CREATE TABLE anonymous_request_limits (
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('cart', 'checkout')),
  subject_hash TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, action, subject_hash, window_started_at)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_anonymous_request_limits_shop_window
  ON anonymous_request_limits(shop_id, action, window_started_at);
