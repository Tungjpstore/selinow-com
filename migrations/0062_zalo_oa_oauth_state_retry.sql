PRAGMA foreign_keys = ON;

-- A connector may need another OAuth attempt after a state has been consumed or
-- revoked. Rebuild the table to replace the original unconditional connector
-- uniqueness constraint with a pending-only index; request IDs and state hashes
-- remain unique for audit and replay isolation.
DROP TRIGGER IF EXISTS channel_oauth_states_scope_insert_guard;
DROP TRIGGER IF EXISTS channel_oauth_states_identity_immutable;
DROP TRIGGER IF EXISTS channel_oauth_states_status_timestamp_guard;
DROP TRIGGER IF EXISTS channel_oauth_states_status_timestamp_update_guard;
DROP TRIGGER IF EXISTS channel_oauth_states_immutable_delete;
DROP INDEX IF EXISTS idx_channel_oauth_states_shop_status;
DROP INDEX IF EXISTS idx_channel_oauth_states_expiry;

ALTER TABLE channel_oauth_states RENAME TO channel_oauth_states_legacy_0062;

CREATE TABLE channel_oauth_states (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  connector_request_id TEXT NOT NULL REFERENCES channel_connector_requests(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL CHECK (
    length(request_id) BETWEEN 8 AND 96
    AND substr(request_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND request_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  provider_code TEXT NOT NULL CHECK (provider_code = 'zalo.oa'),
  app_id TEXT NOT NULL CHECK (
    length(app_id) BETWEEN 3 AND 128
    AND substr(app_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND app_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 12 AND 2048),
  state_hash TEXT NOT NULL CHECK (
    length(state_hash) = 43
    AND state_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  code_verifier_ciphertext_b64 TEXT NOT NULL CHECK (
    length(code_verifier_ciphertext_b64) BETWEEN 16 AND 512
    AND code_verifier_ciphertext_b64 NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  code_verifier_iv_b64 TEXT NOT NULL CHECK (
    length(code_verifier_iv_b64) BETWEEN 16 AND 64
    AND code_verifier_iv_b64 NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  key_version TEXT NOT NULL CHECK (length(key_version) BETWEEN 2 AND 16),
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'revoked')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (shop_id, request_id, provider_code),
  UNIQUE (shop_id, state_hash)
) STRICT;

INSERT INTO channel_oauth_states (
  id, shop_id, connector_request_id, request_id, provider_code, app_id,
  redirect_uri, state_hash, code_verifier_ciphertext_b64,
  code_verifier_iv_b64, key_version, status, expires_at, consumed_at,
  revoked_at, created_at, updated_at, version
)
SELECT
  id, shop_id, connector_request_id, request_id, provider_code, app_id,
  redirect_uri, state_hash, code_verifier_ciphertext_b64,
  code_verifier_iv_b64, key_version, status, expires_at, consumed_at,
  revoked_at, created_at, updated_at, version
FROM channel_oauth_states_legacy_0062;

DROP TABLE channel_oauth_states_legacy_0062;

CREATE UNIQUE INDEX idx_channel_oauth_states_pending_connector
  ON channel_oauth_states(shop_id, connector_request_id, provider_code)
  WHERE status = 'pending';

CREATE INDEX idx_channel_oauth_states_shop_status
  ON channel_oauth_states(shop_id, provider_code, status, expires_at, id);

CREATE INDEX idx_channel_oauth_states_expiry
  ON channel_oauth_states(status, expires_at, shop_id, id);

CREATE TRIGGER channel_oauth_states_scope_insert_guard
BEFORE INSERT ON channel_oauth_states
WHEN NOT EXISTS (
  SELECT 1
  FROM shops
  INNER JOIN shop_subscriptions
    ON shop_subscriptions.shop_id = shops.id
    AND shop_subscriptions.state IN ('trialing', 'active', 'past_due')
  WHERE shops.id = NEW.shop_id
    AND shops.status = 'active'
)
  OR NOT EXISTS (
    SELECT 1
    FROM channel_connector_requests
    WHERE channel_connector_requests.id = NEW.connector_request_id
      AND channel_connector_requests.shop_id = NEW.shop_id
      AND channel_connector_requests.channel_code = 'zalo.oa'
      AND channel_connector_requests.provider_code = 'zalo.oa'
      AND channel_connector_requests.status IN ('requested', 'provider_pending', 'active')
)
BEGIN
  SELECT RAISE(ABORT, 'channel_oauth_state_scope_mismatch');
END;

CREATE TRIGGER channel_oauth_states_identity_immutable
BEFORE UPDATE ON channel_oauth_states
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.connector_request_id != OLD.connector_request_id
  OR NEW.request_id != OLD.request_id
  OR NEW.provider_code != OLD.provider_code
  OR NEW.app_id != OLD.app_id
  OR NEW.redirect_uri != OLD.redirect_uri
  OR NEW.state_hash != OLD.state_hash
  OR NEW.code_verifier_ciphertext_b64 != OLD.code_verifier_ciphertext_b64
  OR NEW.code_verifier_iv_b64 != OLD.code_verifier_iv_b64
  OR NEW.key_version != OLD.key_version
  OR NEW.expires_at != OLD.expires_at
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR OLD.status IN ('consumed', 'revoked')
  OR NOT (
    OLD.status = 'pending' AND NEW.status IN ('pending', 'consumed', 'revoked')
  )
BEGIN
  SELECT RAISE(ABORT, 'channel_oauth_state_transition_invalid');
END;

CREATE TRIGGER channel_oauth_states_status_timestamp_guard
BEFORE INSERT ON channel_oauth_states
WHEN (NEW.status = 'pending' AND (NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL))
  OR (NEW.status = 'consumed' AND (NEW.consumed_at IS NULL OR NEW.revoked_at IS NOT NULL))
  OR (NEW.status = 'revoked' AND (NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'channel_oauth_state_timestamp_invalid');
END;

CREATE TRIGGER channel_oauth_states_status_timestamp_update_guard
BEFORE UPDATE OF status, consumed_at, revoked_at ON channel_oauth_states
WHEN (NEW.status = 'pending' AND (NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL))
  OR (NEW.status = 'consumed' AND (NEW.consumed_at IS NULL OR NEW.revoked_at IS NOT NULL))
  OR (NEW.status = 'revoked' AND (NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'channel_oauth_state_timestamp_invalid');
END;

CREATE TRIGGER channel_oauth_states_immutable_delete
BEFORE DELETE ON channel_oauth_states
BEGIN
  SELECT RAISE(ABORT, 'channel_oauth_state_immutable');
END;
