PRAGMA foreign_keys = ON;

CREATE TABLE platform_admin_bootstrap_receipts (
  ceremony_key TEXT PRIMARY KEY NOT NULL CHECK (ceremony_key = 'first_platform_admin'),
  user_id TEXT NOT NULL UNIQUE REFERENCES platform_users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role = 'owner'),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 8 AND 128),
  created_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;
