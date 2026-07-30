PRAGMA foreign_keys = ON;

CREATE TABLE platform_users (
  id TEXT PRIMARY KEY NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
) STRICT;

CREATE TABLE magic_link_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose = 'seller_login'),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_magic_link_tokens_user_created
  ON magic_link_tokens(user_id, created_at DESC);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  authenticated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_auth_sessions_user_status
  ON auth_sessions(user_id, status, expires_at);

CREATE TABLE shops (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'suspended', 'archived')),
  default_locale TEXT NOT NULL,
  currency TEXT NOT NULL,
  timezone TEXT NOT NULL,
  canonical_domain_id TEXT,
  readiness_version INTEGER NOT NULL DEFAULT 1 CHECK (readiness_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_shops_status_updated
  ON shops(status, updated_at DESC, id);

CREATE TABLE shop_members (
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'support', 'viewer')),
  status TEXT NOT NULL CHECK (status IN ('active', 'invited', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, user_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_shop_members_user_status
  ON shop_members(user_id, status, shop_id);

CREATE TABLE shop_settings (
  shop_id TEXT PRIMARY KEY NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  branding_json TEXT NOT NULL CHECK (json_valid(branding_json)),
  storefront_json TEXT NOT NULL CHECK (json_valid(storefront_json)),
  order_expiry_minutes INTEGER NOT NULL DEFAULT 30 CHECK (order_expiry_minutes BETWEEN 5 AND 1440),
  low_stock_threshold INTEGER NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;

CREATE TABLE shop_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('trialing', 'active', 'past_due', 'grace_period', 'suspended', 'canceled')),
  trial_ends_at TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  grace_ends_at TEXT,
  canceled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_shop_subscriptions_open
  ON shop_subscriptions(shop_id)
  WHERE state IN ('trialing', 'active', 'past_due', 'grace_period', 'suspended');

CREATE INDEX idx_shop_subscriptions_state_period
  ON shop_subscriptions(state, current_period_end, shop_id);

CREATE TABLE usage_counters (
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  period_key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, metric, period_key)
) WITHOUT ROWID, STRICT;

CREATE TABLE shop_domains (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  hostname_normalized TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('platform_subdomain', 'custom')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'validating', 'active', 'failed', 'suspended', 'deleted')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  cloudflare_hostname_id TEXT,
  hostname_status TEXT,
  ssl_status TEXT,
  validation_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(validation_metadata_json)),
  last_checked_at TEXT,
  activated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_shop_domains_shop_status
  ON shop_domains(shop_id, status, updated_at DESC);

CREATE TABLE platform_admins (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'support', 'risk')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID, STRICT;

CREATE TABLE idempotency_records (
  actor_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (actor_user_id, namespace, key_hash)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_idempotency_records_expiry
  ON idempotency_records(expires_at);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'platform_admin', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  safe_metadata_json TEXT NOT NULL CHECK (json_valid(safe_metadata_json)),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_audit_logs_shop_created
  ON audit_logs(shop_id, created_at DESC, id);

CREATE INDEX idx_audit_logs_action_created
  ON audit_logs(action, created_at DESC, id);
