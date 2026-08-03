PRAGMA foreign_keys = ON;

-- Keep direct-D1 claims aligned with the seller-visible channel lifecycle.
-- This is a forward repair because 0058/0059 may already exist remotely.
DROP TRIGGER IF EXISTS channel_provider_event_receipts_scope_insert_guard;

CREATE TRIGGER channel_provider_event_receipts_scope_insert_guard
BEFORE INSERT ON channel_provider_event_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM channel_connections
  INNER JOIN shop_channels
    ON shop_channels.shop_id = channel_connections.shop_id
    AND shop_channels.id = channel_connections.shop_channel_id
    AND shop_channels.channel_code = NEW.provider_code
    AND shop_channels.status = 'enabled'
  WHERE channel_connections.shop_id = NEW.shop_id
    AND channel_connections.id = NEW.connection_id
    AND channel_connections.provider_code = NEW.provider_code
    AND channel_connections.status IN ('active', 'degraded')
)
BEGIN
  SELECT RAISE(ABORT, 'channel_provider_event_receipt_scope_mismatch');
END;

DROP TRIGGER IF EXISTS channel_customer_identities_scope_insert_guard;

CREATE TRIGGER channel_customer_identities_scope_insert_guard
BEFORE INSERT ON channel_customer_identities
WHEN NOT EXISTS (
  SELECT 1
  FROM channel_connections AS connection
  INNER JOIN shop_channels AS channel
    ON channel.shop_id = connection.shop_id
    AND channel.id = connection.shop_channel_id
    AND channel.channel_code = NEW.provider_code
    AND channel.status = 'enabled'
  WHERE connection.shop_id = NEW.shop_id
    AND connection.id = NEW.connection_id
    AND connection.provider_code = NEW.provider_code
    AND connection.status IN ('active', 'degraded')
)
BEGIN
  SELECT RAISE(ABORT, 'channel_customer_identity_scope_mismatch');
END;

DROP TRIGGER IF EXISTS channel_customer_identities_scope_update_guard;

CREATE TRIGGER channel_customer_identities_scope_update_guard
BEFORE UPDATE OF shop_id, connection_id, provider_code ON channel_customer_identities
WHEN NOT EXISTS (
  SELECT 1
  FROM channel_connections AS connection
  INNER JOIN shop_channels AS channel
    ON channel.shop_id = connection.shop_id
    AND channel.id = connection.shop_channel_id
    AND channel.channel_code = NEW.provider_code
    AND channel.status = 'enabled'
  WHERE connection.shop_id = NEW.shop_id
    AND connection.id = NEW.connection_id
    AND connection.provider_code = NEW.provider_code
    AND connection.status IN ('active', 'degraded')
)
BEGIN
  SELECT RAISE(ABORT, 'channel_customer_identity_scope_mismatch');
END;
