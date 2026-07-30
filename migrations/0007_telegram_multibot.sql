PRAGMA foreign_keys = ON;

CREATE TABLE telegram_integrations (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  webhook_public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'degraded', 'disabled', 'error')),
  webhook_status TEXT NOT NULL CHECK (webhook_status IN ('pending', 'verified', 'mismatch', 'disabled', 'error')),
  active_credential_id TEXT,
  bot_id TEXT,
  bot_username_sanitized TEXT,
  bot_display_name_sanitized TEXT,
  pending_update_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_update_count >= 0),
  last_safe_error_code TEXT,
  last_checked_at TEXT,
  last_update_at TEXT,
  last_outbound_at TEXT,
  connected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id)
) STRICT;

CREATE UNIQUE INDEX idx_telegram_integrations_active_bot
  ON telegram_integrations(bot_id)
  WHERE bot_id IS NOT NULL AND status IN ('pending', 'active', 'degraded');
CREATE INDEX idx_telegram_integrations_shop_status
  ON telegram_integrations(shop_id, status, id);

CREATE TABLE telegram_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES telegram_integrations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked', 'error')),
  version INTEGER NOT NULL CHECK (version > 0),
  key_version TEXT NOT NULL,
  bot_token_ciphertext_b64 TEXT NOT NULL,
  bot_token_iv_b64 TEXT NOT NULL,
  webhook_secret_ciphertext_b64 TEXT NOT NULL,
  webhook_secret_iv_b64 TEXT NOT NULL,
  token_fingerprint TEXT NOT NULL,
  webhook_secret_digest TEXT NOT NULL,
  activated_at TEXT,
  revoked_at TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (integration_id, version)
) STRICT;

CREATE UNIQUE INDEX idx_telegram_credentials_active
  ON telegram_credentials(integration_id) WHERE status = 'active';
CREATE UNIQUE INDEX idx_telegram_credentials_live_fingerprint
  ON telegram_credentials(token_fingerprint) WHERE status IN ('pending', 'active');
CREATE INDEX idx_telegram_credentials_shop_status
  ON telegram_credentials(shop_id, status, created_at DESC, id);

CREATE TABLE customer_identities (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES shop_customers(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'telegram'),
  external_subject TEXT NOT NULL,
  display_handle_sanitized TEXT,
  language_code TEXT,
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, provider, external_subject)
) STRICT;

CREATE INDEX idx_customer_identities_customer
  ON customer_identities(shop_id, customer_id, provider, id);

CREATE TABLE telegram_recipients (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES telegram_integrations(id) ON DELETE CASCADE,
  customer_identity_id TEXT NOT NULL REFERENCES customer_identities(id) ON DELETE CASCADE,
  key_version TEXT NOT NULL,
  chat_id_ciphertext_b64 TEXT NOT NULL,
  chat_id_iv_b64 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'blocked', 'unavailable')),
  last_safe_error_code TEXT,
  last_seen_at TEXT NOT NULL,
  last_outbound_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (integration_id, customer_identity_id)
) STRICT;

CREATE INDEX idx_telegram_recipients_shop_status
  ON telegram_recipients(shop_id, status, updated_at DESC, id);

CREATE TABLE telegram_updates (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES telegram_integrations(id) ON DELETE CASCADE,
  update_id INTEGER NOT NULL CHECK (update_id >= 0),
  payload_hash TEXT NOT NULL,
  update_kind TEXT NOT NULL CHECK (update_kind IN ('message', 'callback_query')),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'processing', 'processed', 'failed', 'rejected')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  safe_result_code TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (integration_id, update_id)
) STRICT;

CREATE INDEX idx_telegram_updates_shop_received
  ON telegram_updates(shop_id, received_at DESC, id);
CREATE INDEX idx_telegram_updates_status
  ON telegram_updates(status, updated_at, id);

CREATE TABLE telegram_actions (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES telegram_integrations(id) ON DELETE CASCADE,
  update_id INTEGER NOT NULL CHECK (update_id >= 0),
  action_kind TEXT NOT NULL,
  result_reference TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (integration_id, update_id, action_kind)
) STRICT;

CREATE INDEX idx_telegram_actions_shop_created
  ON telegram_actions(shop_id, created_at DESC, id);

CREATE TABLE discounts (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  code_normalized TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('percentage', 'fixed')),
  value INTEGER NOT NULL CHECK (value > 0),
  currency TEXT,
  minimum_minor INTEGER NOT NULL DEFAULT 0 CHECK (minimum_minor >= 0),
  starts_at TEXT,
  ends_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, code_normalized)
) STRICT;

CREATE INDEX idx_discounts_shop_status
  ON discounts(shop_id, status, code_normalized);

ALTER TABLE carts ADD COLUMN discount_code_normalized TEXT;
