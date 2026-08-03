PRAGMA foreign_keys = ON;

-- Generic channel identities keep provider subjects pseudonymous and tenant
-- bound. Telegram's legacy customer_identities table remains unchanged.
CREATE TABLE channel_customer_identities (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_code TEXT NOT NULL CHECK (
    length(provider_code) BETWEEN 3 AND 64
    AND substr(provider_code, 1, 1) GLOB '[a-z]'
    AND provider_code NOT GLOB '*[^a-z0-9._:-]*'
  ),
  external_subject_hash TEXT NOT NULL CHECK (
    length(external_subject_hash) = 43
    AND external_subject_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  display_name_sanitized TEXT CHECK (
    display_name_sanitized IS NULL OR (
      length(display_name_sanitized) BETWEEN 1 AND 200
    )
  ),
  display_handle_sanitized TEXT CHECK (
    display_handle_sanitized IS NULL OR (
      length(display_handle_sanitized) BETWEEN 1 AND 128
    )
  ),
  language_code TEXT CHECK (
    language_code IS NULL OR (
      length(language_code) BETWEEN 2 AND 35
      AND language_code NOT GLOB '*[^A-Za-z0-9-]*'
    )
  ),
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, connection_id, provider_code, external_subject_hash),
  FOREIGN KEY (shop_id, customer_id)
    REFERENCES shop_customers(shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, connection_id)
    REFERENCES channel_connections(shop_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_channel_customer_identities_shop_customer
  ON channel_customer_identities(shop_id, customer_id, updated_at DESC, id);

CREATE INDEX idx_channel_customer_identities_connection
  ON channel_customer_identities(shop_id, connection_id, provider_code, updated_at DESC, id);

-- An identity may only be claimed for the exact provider connection and its
-- channel. Provider-pending or disconnected connections cannot mint claims.
CREATE TRIGGER channel_customer_identities_scope_insert_guard
BEFORE INSERT ON channel_customer_identities
WHEN NOT EXISTS (
  SELECT 1
  FROM channel_connections AS connection
  INNER JOIN shop_channels AS channel
    ON channel.shop_id = connection.shop_id
    AND channel.id = connection.shop_channel_id
    AND channel.channel_code = NEW.provider_code
  WHERE connection.shop_id = NEW.shop_id
    AND connection.id = NEW.connection_id
    AND connection.provider_code = NEW.provider_code
    AND connection.status IN ('active', 'degraded')
)
BEGIN
  SELECT RAISE(ABORT, 'channel_customer_identity_scope_mismatch');
END;

CREATE TRIGGER channel_customer_identities_scope_update_guard
BEFORE UPDATE OF shop_id, connection_id, provider_code ON channel_customer_identities
WHEN NOT EXISTS (
  SELECT 1
  FROM channel_connections AS connection
  INNER JOIN shop_channels AS channel
    ON channel.shop_id = connection.shop_id
    AND channel.id = connection.shop_channel_id
    AND channel.channel_code = NEW.provider_code
  WHERE connection.shop_id = NEW.shop_id
    AND connection.id = NEW.connection_id
    AND connection.provider_code = NEW.provider_code
    AND connection.status IN ('active', 'degraded')
)
BEGIN
  SELECT RAISE(ABORT, 'channel_customer_identity_scope_mismatch');
END;

CREATE TRIGGER channel_customer_identities_identity_immutable
BEFORE UPDATE ON channel_customer_identities
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.customer_id != OLD.customer_id
  OR NEW.connection_id != OLD.connection_id
  OR NEW.provider_code != OLD.provider_code
  OR NEW.external_subject_hash != OLD.external_subject_hash
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'channel_customer_identity_immutable');
END;
