PRAGMA foreign_keys = ON;

-- Generic rows establish channel identity and lifecycle without replacing the
-- existing website or Telegram runtime. Provider-specific detail tables can
-- continue to enforce their stronger constraints during a staged cutover.
CREATE TABLE shop_channels (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 8 AND 96),
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  channel_code TEXT NOT NULL CHECK (
    length(channel_code) BETWEEN 1 AND 64
    AND substr(channel_code, 1, 1) GLOB '[a-z]'
    AND channel_code NOT GLOB '*[^a-z0-9._:-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'enabled', 'disabled')),
  -- Fail closed until each provider has a reviewed non-secret settings schema.
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (settings_json = '{}'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, channel_code),
  UNIQUE (shop_id, id)
) STRICT;

CREATE INDEX idx_shop_channels_shop_status
  ON shop_channels(shop_id, status, updated_at DESC, id);

CREATE TABLE channel_connections (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 8 AND 96),
  public_id TEXT NOT NULL UNIQUE CHECK (length(public_id) BETWEEN 8 AND 96),
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  shop_channel_id TEXT NOT NULL,
  provider_code TEXT NOT NULL CHECK (
    length(provider_code) BETWEEN 1 AND 64
    AND substr(provider_code, 1, 1) GLOB '[a-z]'
    AND provider_code NOT GLOB '*[^a-z0-9._:-]*'
  ),
  external_account_id TEXT CHECK (
    external_account_id IS NULL OR length(external_account_id) BETWEEN 1 AND 256
  ),
  connect_intent_key_hash TEXT CHECK (
    connect_intent_key_hash IS NULL
    OR (
      length(connect_intent_key_hash) BETWEEN 43 AND 128
      AND connect_intent_key_hash NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  display_name_sanitized TEXT CHECK (
    display_name_sanitized IS NULL OR length(display_name_sanitized) BETWEEN 1 AND 200
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'degraded', 'disconnected')),
  -- Provider credentials belong only in channel_credentials.
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (settings_json = '{}'),
  last_safe_error_code TEXT CHECK (
    last_safe_error_code IS NULL OR length(last_safe_error_code) BETWEEN 3 AND 96
  ),
  last_health_at TEXT,
  connected_at TEXT,
  disconnected_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, id, provider_code),
  FOREIGN KEY (shop_id, shop_channel_id)
    REFERENCES shop_channels(shop_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_channel_connections_shop_status
  ON channel_connections(shop_id, status, updated_at DESC, id);

CREATE INDEX idx_channel_connections_shop_channel
  ON channel_connections(shop_id, shop_channel_id, status, id);

-- One live provider account can belong to only one connection. A disconnected
-- account may be connected again after the previous lifecycle is closed.
CREATE UNIQUE INDEX idx_channel_connections_live_external_identity
  ON channel_connections(provider_code, external_account_id)
  WHERE external_account_id IS NOT NULL
    AND status IN ('pending', 'active', 'degraded');

CREATE UNIQUE INDEX idx_channel_connections_open_intent
  ON channel_connections(shop_id, shop_channel_id, provider_code, connect_intent_key_hash)
  WHERE status IN ('pending', 'active', 'degraded')
    AND external_account_id IS NULL
    AND connect_intent_key_hash IS NOT NULL;

-- Connection health cannot jump over the provider lifecycle. Reconnects use a
-- new connection row after a disconnected row is retained as evidence.
CREATE TRIGGER channel_connections_enforce_status_transition
BEFORE UPDATE OF status ON channel_connections
WHEN NOT (
  (OLD.status = 'pending' AND NEW.status IN ('pending', 'active', 'degraded', 'disconnected'))
  OR (OLD.status = 'active' AND NEW.status IN ('active', 'degraded', 'disconnected'))
  OR (OLD.status = 'degraded' AND NEW.status IN ('active', 'degraded', 'disconnected'))
  OR (OLD.status = 'disconnected' AND NEW.status = 'disconnected')
)
BEGIN
  SELECT RAISE(ABORT, 'channel_connection_status_transition_invalid');
END;

-- Capability codes remain open in SQL and are validated against the versioned
-- server registry. Expired grants are retained as evidence but fail closed in
-- the application projection.
CREATE TABLE channel_connection_grants (
  shop_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  capability_code TEXT NOT NULL CHECK (
    length(capability_code) BETWEEN 3 AND 96
    AND substr(capability_code, 1, 1) GLOB '[a-z]'
    AND capability_code NOT GLOB '*[^a-z0-9._:-]*'
  ),
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  evidence_reference TEXT CHECK (
    evidence_reference IS NULL OR length(evidence_reference) BETWEEN 3 AND 256
  ),
  PRIMARY KEY (shop_id, connection_id, capability_code),
  FOREIGN KEY (shop_id, connection_id)
    REFERENCES channel_connections(shop_id, id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_channel_connection_grants_shop_connection
  ON channel_connection_grants(shop_id, connection_id, expires_at, capability_code);

-- Credentials are an encrypted, versioned envelope. This table must never
-- contain provider tokens, refresh tokens or webhook secrets in plaintext.
CREATE TABLE channel_credentials (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 8 AND 96),
  shop_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_code TEXT NOT NULL CHECK (
    length(provider_code) BETWEEN 1 AND 64
    AND substr(provider_code, 1, 1) GLOB '[a-z]'
    AND provider_code NOT GLOB '*[^a-z0-9._:-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'grace', 'revoked', 'error')),
  version INTEGER NOT NULL CHECK (version > 0),
  key_version TEXT NOT NULL CHECK (length(key_version) BETWEEN 1 AND 64),
  credential_envelope_ciphertext_b64 TEXT NOT NULL CHECK (
    length(credential_envelope_ciphertext_b64) BETWEEN 16 AND 32768
  ),
  credential_envelope_iv_b64 TEXT NOT NULL CHECK (
    length(credential_envelope_iv_b64) BETWEEN 12 AND 128
  ),
  credential_fingerprint TEXT NOT NULL CHECK (
    length(credential_fingerprint) BETWEEN 32 AND 128
  ),
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  activated_at TEXT,
  grace_ends_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (connection_id, version),
  FOREIGN KEY (shop_id, connection_id, provider_code)
    REFERENCES channel_connections(shop_id, id, provider_code) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX idx_channel_credentials_active
  ON channel_credentials(connection_id)
  WHERE status = 'active';

CREATE INDEX idx_channel_credentials_live_fingerprint
  ON channel_credentials(provider_code, credential_fingerprint, connection_id)
  WHERE status IN ('pending', 'active', 'grace', 'error');

CREATE INDEX idx_channel_credentials_shop_status
  ON channel_credentials(shop_id, status, created_at DESC, id);

-- Membership is checked at the write boundary without preventing later member
-- removal. A credential's tenant and actor must match an active shop member.
CREATE TRIGGER channel_credentials_require_active_member_insert
BEFORE INSERT ON channel_credentials
WHEN NOT EXISTS (
  SELECT 1 FROM shop_members
  WHERE shop_id = NEW.shop_id
    AND user_id = NEW.created_by_user_id
    AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'channel_credential_actor_not_tenant_member');
END;

CREATE TRIGGER channel_credentials_require_active_member_update
BEFORE UPDATE OF shop_id, created_by_user_id ON channel_credentials
WHEN NOT EXISTS (
  SELECT 1 FROM shop_members
  WHERE shop_id = NEW.shop_id
    AND user_id = NEW.created_by_user_id
    AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'channel_credential_actor_not_tenant_member');
END;

-- Rotation may persist the same provider credential under a new key version
-- for the same connection, but a live fingerprint can never cross connection
-- or tenant boundaries.
CREATE TRIGGER channel_credentials_block_cross_connection_insert
BEFORE INSERT ON channel_credentials
WHEN NEW.status IN ('pending', 'active', 'grace', 'error')
  AND EXISTS (
    SELECT 1
    FROM channel_credentials AS existing
    WHERE existing.provider_code = NEW.provider_code
      AND existing.credential_fingerprint = NEW.credential_fingerprint
      AND existing.connection_id != NEW.connection_id
      AND existing.status IN ('pending', 'active', 'grace', 'error')
  )
BEGIN
  SELECT RAISE(ABORT, 'channel_credential_owned_by_other_connection');
END;

CREATE TRIGGER channel_credentials_block_cross_connection_update
BEFORE UPDATE OF provider_code, credential_fingerprint, connection_id, status
ON channel_credentials
WHEN NEW.status IN ('pending', 'active', 'grace', 'error')
  AND EXISTS (
    SELECT 1
    FROM channel_credentials AS existing
    WHERE existing.id != OLD.id
      AND existing.provider_code = NEW.provider_code
      AND existing.credential_fingerprint = NEW.credential_fingerprint
      AND existing.connection_id != NEW.connection_id
      AND existing.status IN ('pending', 'active', 'grace', 'error')
  )
BEGIN
  SELECT RAISE(ABORT, 'channel_credential_owned_by_other_connection');
END;
