PRAGMA foreign_keys = ON;

-- Link the legacy Telegram runtime to the generic connection lifecycle. The
-- legacy tables remain authoritative during dual-write; reconnects can move
-- this pointer to a new connection while retaining disconnected evidence.
ALTER TABLE telegram_integrations
  ADD COLUMN channel_connection_id TEXT
    REFERENCES channel_connections(id) ON DELETE SET NULL;

-- Cover integrations created after the 0025 backfill but before this Worker
-- version is deployed. Existing same-tenant generic rows always win.
INSERT INTO shop_channels (
  id, shop_id, channel_code, status, settings_json, version, created_at, updated_at
)
SELECT
  telegram_integrations.id,
  telegram_integrations.shop_id,
  'telegram',
  CASE telegram_integrations.status
    WHEN 'active' THEN 'enabled'
    WHEN 'degraded' THEN 'enabled'
    WHEN 'disabled' THEN 'disabled'
    ELSE 'pending'
  END,
  '{}',
  1,
  telegram_integrations.created_at,
  telegram_integrations.updated_at
FROM telegram_integrations
WHERE NOT EXISTS (
  SELECT 1 FROM shop_channels
  WHERE shop_channels.shop_id = telegram_integrations.shop_id
    AND shop_channels.channel_code = 'telegram'
);

INSERT INTO channel_connections (
  id, public_id, shop_id, shop_channel_id, provider_code,
  external_account_id, display_name_sanitized, status, settings_json,
  last_safe_error_code, last_health_at, connected_at, disconnected_at,
  version, created_at, updated_at
)
SELECT
  telegram_integrations.id,
  telegram_integrations.public_id,
  telegram_integrations.shop_id,
  shop_channels.id,
  'telegram',
  CASE
    WHEN telegram_integrations.status = 'error' THEN NULL
    ELSE NULLIF(substr(trim(telegram_integrations.bot_id), 1, 256), '')
  END,
  COALESCE(
    NULLIF(substr(trim(telegram_integrations.bot_display_name_sanitized), 1, 200), ''),
    NULLIF(substr(trim(telegram_integrations.bot_username_sanitized), 1, 200), '')
  ),
  CASE telegram_integrations.status
    WHEN 'active' THEN 'active'
    WHEN 'degraded' THEN 'degraded'
    WHEN 'disabled' THEN 'disconnected'
    ELSE 'pending'
  END,
  '{}',
  CASE
    WHEN telegram_integrations.last_safe_error_code IS NULL THEN NULL
    WHEN length(trim(telegram_integrations.last_safe_error_code)) BETWEEN 3 AND 96
      THEN trim(telegram_integrations.last_safe_error_code)
    ELSE 'telegram_legacy_error'
  END,
  COALESCE(
    telegram_integrations.last_health_update_at,
    telegram_integrations.last_checked_at
  ),
  telegram_integrations.connected_at,
  CASE
    WHEN telegram_integrations.status = 'disabled'
      THEN telegram_integrations.updated_at
    ELSE NULL
  END,
  1,
  telegram_integrations.created_at,
  telegram_integrations.updated_at
FROM telegram_integrations
INNER JOIN shop_channels
  ON shop_channels.shop_id = telegram_integrations.shop_id
  AND shop_channels.channel_code = 'telegram'
WHERE NOT EXISTS (
  SELECT 1 FROM channel_connections
  WHERE channel_connections.id = telegram_integrations.id
);

UPDATE telegram_integrations
SET channel_connection_id = (
  SELECT channel_connections.id
  FROM channel_connections
  WHERE channel_connections.id = telegram_integrations.id
    AND channel_connections.shop_id = telegram_integrations.shop_id
    AND channel_connections.provider_code = 'telegram'
  LIMIT 1
)
WHERE channel_connection_id IS NULL
  AND EXISTS (
    SELECT 1 FROM channel_connections
    WHERE channel_connections.id = telegram_integrations.id
      AND channel_connections.shop_id = telegram_integrations.shop_id
      AND channel_connections.provider_code = 'telegram'
  );

CREATE UNIQUE INDEX idx_telegram_integrations_channel_connection
  ON telegram_integrations(channel_connection_id)
  WHERE channel_connection_id IS NOT NULL;

CREATE INDEX idx_telegram_integrations_shop_connection
  ON telegram_integrations(shop_id, channel_connection_id, status, id);

CREATE TRIGGER telegram_integrations_require_connection_insert
BEFORE INSERT ON telegram_integrations
WHEN NEW.channel_connection_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM channel_connections
    WHERE id = NEW.channel_connection_id
      AND shop_id = NEW.shop_id
      AND provider_code = 'telegram'
  )
BEGIN
  SELECT RAISE(ABORT, 'telegram_connection_tenant_mismatch');
END;

CREATE TRIGGER telegram_integrations_require_connection_update
BEFORE UPDATE OF channel_connection_id, shop_id ON telegram_integrations
WHEN NEW.channel_connection_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM channel_connections
    WHERE id = NEW.channel_connection_id
      AND shop_id = NEW.shop_id
      AND provider_code = 'telegram'
  )
BEGIN
  SELECT RAISE(ABORT, 'telegram_connection_tenant_mismatch');
END;

CREATE TRIGGER channel_connections_protect_telegram_link_update
BEFORE UPDATE OF shop_id, provider_code ON channel_connections
WHEN EXISTS (
  SELECT 1 FROM telegram_integrations
  WHERE channel_connection_id = OLD.id
    AND (
      shop_id != NEW.shop_id
      OR NEW.provider_code != 'telegram'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'telegram_connection_identity_mismatch');
END;

-- Telegram's provider consent grants the capabilities already exercised by
-- the legacy adapter. The generic registry still intersects these grants with
-- plan entitlement, connection health and policy at read/send time.
INSERT OR IGNORE INTO channel_connection_grants (
  shop_id, connection_id, capability_code, granted_at
)
SELECT
  telegram_integrations.shop_id,
  telegram_integrations.channel_connection_id,
  capabilities.capability_code,
  COALESCE(telegram_integrations.connected_at, telegram_integrations.created_at)
FROM telegram_integrations
INNER JOIN channel_connections
  ON channel_connections.id = telegram_integrations.channel_connection_id
  AND channel_connections.shop_id = telegram_integrations.shop_id
  AND channel_connections.provider_code = 'telegram'
CROSS JOIN (
  SELECT 'conversation.inbound' AS capability_code
  UNION ALL SELECT 'conversation.outbound'
  UNION ALL SELECT 'message.rich_ui'
  UNION ALL SELECT 'catalog.read'
) AS capabilities
WHERE telegram_integrations.channel_connection_id IS NOT NULL;

INSERT OR IGNORE INTO channel_connection_grants (
  shop_id, connection_id, capability_code, granted_at
)
SELECT
  telegram_integrations.shop_id,
  telegram_integrations.channel_connection_id,
  capabilities.capability_code,
  COALESCE(telegram_integrations.connected_at, telegram_integrations.created_at)
FROM telegram_integrations
INNER JOIN channel_connections
  ON channel_connections.id = telegram_integrations.channel_connection_id
  AND channel_connections.shop_id = telegram_integrations.shop_id
  AND channel_connections.provider_code = 'telegram'
CROSS JOIN (
  SELECT 'cart.interactive' AS capability_code
  UNION ALL SELECT 'checkout.external_link'
  UNION ALL SELECT 'fulfillment.inline_secret'
  UNION ALL SELECT 'identity.private'
) AS capabilities
WHERE telegram_integrations.channel_connection_id IS NOT NULL;

-- Keep legacy lifecycle writes visible to the generic projection. The generic
-- status guard deliberately ignores a disconnected row: reconnect code first
-- links a fresh connection, while an older Worker can still roll back safely.
CREATE TRIGGER telegram_integrations_generic_projection_insert
AFTER INSERT ON telegram_integrations
WHEN NEW.channel_connection_id IS NULL
BEGIN
  INSERT OR IGNORE INTO shop_channels (
    id, shop_id, channel_code, status, settings_json, version, created_at, updated_at
  ) VALUES (
    NEW.id, NEW.shop_id, 'telegram',
    CASE NEW.status
      WHEN 'active' THEN 'enabled'
      WHEN 'degraded' THEN 'enabled'
      WHEN 'disabled' THEN 'disabled'
      ELSE 'pending'
    END,
    '{}', 1, NEW.created_at, NEW.updated_at
  );
  INSERT OR IGNORE INTO channel_connections (
    id, public_id, shop_id, shop_channel_id, provider_code, status,
    settings_json, version, created_at, updated_at
  ) SELECT NEW.id, NEW.public_id, NEW.shop_id, shop_channels.id, 'telegram',
    CASE NEW.status
      WHEN 'active' THEN 'active'
      WHEN 'degraded' THEN 'degraded'
      WHEN 'disabled' THEN 'disconnected'
      ELSE 'pending'
    END,
    '{}', 1, NEW.created_at, NEW.updated_at
  FROM shop_channels
  WHERE shop_channels.shop_id = NEW.shop_id
    AND shop_channels.channel_code = 'telegram';
  INSERT OR IGNORE INTO channel_connection_grants (
    shop_id, connection_id, capability_code, granted_at
  ) SELECT NEW.shop_id, NEW.id, capabilities.capability_code, NEW.created_at
  FROM (
    SELECT 'conversation.inbound' AS capability_code
    UNION ALL SELECT 'conversation.outbound'
    UNION ALL SELECT 'message.rich_ui'
    UNION ALL SELECT 'catalog.read'
  ) AS capabilities;
  INSERT OR IGNORE INTO channel_connection_grants (
    shop_id, connection_id, capability_code, granted_at
  ) SELECT NEW.shop_id, NEW.id, capabilities.capability_code, NEW.created_at
  FROM (
    SELECT 'cart.interactive' AS capability_code
    UNION ALL SELECT 'checkout.external_link'
    UNION ALL SELECT 'fulfillment.inline_secret'
    UNION ALL SELECT 'identity.private'
  ) AS capabilities;
  UPDATE telegram_integrations
  SET channel_connection_id = NEW.id
  WHERE id = NEW.id AND shop_id = NEW.shop_id;
END;

CREATE TRIGGER telegram_integrations_generic_projection_update
AFTER UPDATE OF status, webhook_status, last_safe_error_code, last_checked_at,
  last_health_update_at, connected_at ON telegram_integrations
WHEN NEW.channel_connection_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM channel_connections
    WHERE id = NEW.channel_connection_id
      AND shop_id = NEW.shop_id
      AND provider_code = 'telegram'
      AND status != 'disconnected'
  )
BEGIN
  UPDATE channel_connections
  SET status = CASE NEW.status
      WHEN 'active' THEN 'active'
      WHEN 'degraded' THEN 'degraded'
      WHEN 'disabled' THEN 'disconnected'
      ELSE 'pending'
    END,
    last_safe_error_code = CASE
      WHEN NEW.last_safe_error_code IS NULL THEN NULL
      WHEN length(trim(NEW.last_safe_error_code)) BETWEEN 3 AND 96 THEN trim(NEW.last_safe_error_code)
      ELSE 'telegram_legacy_error'
    END,
    external_account_id = CASE
      WHEN NEW.status IN ('active', 'degraded')
        THEN COALESCE(NULLIF(substr(trim(NEW.bot_id), 1, 256), ''), external_account_id)
      ELSE external_account_id
    END,
    display_name_sanitized = CASE
      WHEN NEW.status IN ('active', 'degraded') THEN COALESCE(
        NULLIF(substr(trim(NEW.bot_display_name_sanitized), 1, 200), ''),
        NULLIF(substr(trim(NEW.bot_username_sanitized), 1, 200), ''),
        display_name_sanitized
      )
      ELSE display_name_sanitized
    END,
    last_health_at = COALESCE(NEW.last_health_update_at, NEW.last_checked_at),
    connected_at = NEW.connected_at,
    disconnected_at = CASE WHEN NEW.status = 'disabled' THEN COALESCE(disconnected_at, NEW.updated_at) ELSE NULL END,
    version = version + 1,
    updated_at = NEW.updated_at
  WHERE id = NEW.channel_connection_id AND shop_id = NEW.shop_id AND provider_code = 'telegram';
  UPDATE shop_channels
  SET status = CASE WHEN NEW.status = 'disabled' THEN 'disabled'
                    WHEN NEW.status IN ('active', 'degraded') THEN 'enabled'
                    ELSE 'pending' END,
      version = version + 1,
      updated_at = NEW.updated_at
  WHERE id = (
    SELECT shop_channel_id FROM channel_connections
    WHERE id = NEW.channel_connection_id AND shop_id = NEW.shop_id
  ) AND shop_id = NEW.shop_id;
END;
