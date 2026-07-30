PRAGMA foreign_keys = ON;

-- Preserve the legacy Telegram tables as the runtime source of truth while
-- projecting each integration into the generic connection model. Existing
-- generic rows win; deterministic legacy IDs make this migration rerunnable.
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
  SELECT 1
  FROM shop_channels
  WHERE shop_channels.shop_id = telegram_integrations.shop_id
    AND shop_channels.channel_code = 'telegram'
);

INSERT INTO channel_connections (
  id, public_id, shop_id, shop_channel_id, provider_code,
  external_account_id, connect_intent_key_hash, display_name_sanitized,
  status, settings_json, last_safe_error_code, last_health_at,
  connected_at, disconnected_at, version, created_at, updated_at
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
  NULL,
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
  SELECT 1
  FROM channel_connections
  WHERE channel_connections.id = telegram_integrations.id
    AND channel_connections.shop_id = telegram_integrations.shop_id
    AND channel_connections.provider_code = 'telegram'
);

-- Only fill an empty normalized reference for an order that is still
-- authoritatively identified as Telegram-owned in the same tenant.
UPDATE order_channel_attributions
SET connection_id = (
  SELECT channel_connections.id
  FROM orders
  INNER JOIN telegram_integrations
    ON telegram_integrations.shop_id = orders.shop_id
  INNER JOIN channel_connections
    ON channel_connections.id = telegram_integrations.id
    AND channel_connections.shop_id = telegram_integrations.shop_id
    AND channel_connections.provider_code = 'telegram'
  WHERE orders.shop_id = order_channel_attributions.shop_id
    AND orders.id = order_channel_attributions.order_id
    AND orders.source_channel = 'telegram'
  LIMIT 1
)
WHERE order_channel_attributions.channel_code = 'telegram'
  AND order_channel_attributions.connection_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM orders
    INNER JOIN telegram_integrations
      ON telegram_integrations.shop_id = orders.shop_id
    INNER JOIN channel_connections
      ON channel_connections.id = telegram_integrations.id
      AND channel_connections.shop_id = telegram_integrations.shop_id
      AND channel_connections.provider_code = 'telegram'
    WHERE orders.shop_id = order_channel_attributions.shop_id
      AND orders.id = order_channel_attributions.order_id
      AND orders.source_channel = 'telegram'
  );
