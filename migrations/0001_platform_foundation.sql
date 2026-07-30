PRAGMA foreign_keys = ON;

CREATE TABLE plans (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  feature_flags_json TEXT NOT NULL CHECK (json_valid(feature_flags_json)),
  limits_json TEXT NOT NULL CHECK (json_valid(limits_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE reserved_slugs (
  slug TEXT PRIMARY KEY NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE infrastructure_events (
  id TEXT PRIMARY KEY NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('local', 'staging', 'production')),
  event_type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  safe_metadata_json TEXT NOT NULL CHECK (json_valid(safe_metadata_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_infrastructure_events_environment_created
  ON infrastructure_events(environment, created_at, id);
