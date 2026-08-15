PRAGMA foreign_keys = ON;

-- A verified Telegram Web App launch is exchanged for a short-lived,
-- tenant-bound session. Raw initData and session tokens are never persisted.
CREATE TABLE telegram_mini_app_sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES telegram_integrations(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES telegram_credentials(id) ON DELETE CASCADE,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  connector_request_id TEXT NOT NULL REFERENCES channel_connector_requests(id) ON DELETE RESTRICT,
  subject_hash TEXT NOT NULL CHECK (
    length(subject_hash) BETWEEN 16 AND 128
    AND subject_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  launch_hash TEXT NOT NULL CHECK (
    length(launch_hash) BETWEEN 16 AND 128
    AND launch_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) BETWEEN 16 AND 128
    AND token_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (integration_id, launch_hash),
  CHECK (expires_at > issued_at),
  CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_telegram_mini_app_sessions_shop_status
  ON telegram_mini_app_sessions(shop_id, status, expires_at, id);

CREATE INDEX idx_telegram_mini_app_sessions_integration_launch
  ON telegram_mini_app_sessions(integration_id, launch_hash, status);

CREATE INDEX idx_telegram_mini_app_sessions_expiry
  ON telegram_mini_app_sessions(expires_at, shop_id, id);

-- Direct D1 writes must prove the same tenant, active Telegram credential,
-- subscription, and connector intent before a session can be created.
CREATE TRIGGER telegram_mini_app_sessions_scope_insert_guard
BEFORE INSERT ON telegram_mini_app_sessions
WHEN NOT EXISTS (
  SELECT 1
  FROM shops
  INNER JOIN shop_subscriptions
    ON shop_subscriptions.shop_id = shops.id
    AND shop_subscriptions.state IN ('trialing', 'active', 'past_due')
  INNER JOIN telegram_integrations
    ON telegram_integrations.shop_id = shops.id
    AND telegram_integrations.id = NEW.integration_id
    AND telegram_integrations.status IN ('active', 'degraded')
    AND telegram_integrations.webhook_status = 'verified'
    AND telegram_integrations.active_credential_id = NEW.credential_id
  INNER JOIN telegram_credentials
    ON telegram_credentials.id = NEW.credential_id
    AND telegram_credentials.integration_id = telegram_integrations.id
    AND telegram_credentials.shop_id = shops.id
    AND telegram_credentials.status = 'active'
  INNER JOIN channel_connector_requests
    ON channel_connector_requests.id = NEW.connector_request_id
    AND channel_connector_requests.shop_id = shops.id
    AND channel_connector_requests.channel_code = 'telegram.mini_app'
    AND channel_connector_requests.provider_code = 'telegram.mini_app'
    AND channel_connector_requests.status = 'active'
    AND telegram_credentials.version = NEW.credential_version
  WHERE shops.id = NEW.shop_id
    AND shops.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'telegram_mini_app_session_scope_mismatch');
END;

CREATE TRIGGER telegram_mini_app_sessions_identity_immutable
BEFORE UPDATE ON telegram_mini_app_sessions
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.integration_id != OLD.integration_id
  OR NEW.credential_id != OLD.credential_id
  OR NEW.credential_version != OLD.credential_version
  OR NEW.connector_request_id != OLD.connector_request_id
  OR NEW.subject_hash != OLD.subject_hash
  OR NEW.launch_hash != OLD.launch_hash
  OR NEW.token_hash != OLD.token_hash
  OR NEW.issued_at != OLD.issued_at
  OR NEW.expires_at != OLD.expires_at
  OR OLD.status = 'revoked'
  OR NEW.status NOT IN ('active', 'revoked')
  OR (OLD.status = 'active' AND NEW.status NOT IN ('active', 'revoked'))
  OR (NEW.status = 'revoked' AND NEW.revoked_at IS NULL)
  OR (NEW.status = 'active' AND NEW.revoked_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'telegram_mini_app_session_transition_invalid');
END;
