PRAGMA foreign_keys = ON;

-- Provider webhook routes persist only a bounded reference envelope. Payloads,
-- credentials and provider tokens never enter this table or its queues.
CREATE TABLE channel_provider_event_receipts (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  provider_code TEXT NOT NULL CHECK (
    length(provider_code) BETWEEN 3 AND 64
    AND substr(provider_code, 1, 1) GLOB '[a-z]'
    AND provider_code NOT GLOB '*[^a-z0-9._:-]*'
  ),
  provider_event_id TEXT NOT NULL CHECK (
    length(provider_event_id) BETWEEN 1 AND 256
    AND substr(provider_event_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND provider_event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  action TEXT NOT NULL CHECK (
    length(action) BETWEEN 3 AND 96
    AND substr(action, 1, 1) GLOB '[a-z]'
    AND action NOT GLOB '*[^a-z0-9._:-]*'
  ),
  payload_reference TEXT NOT NULL CHECK (
    length(payload_reference) = 43
    AND payload_reference NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  status TEXT NOT NULL CHECK (status IN (
    'accepted', 'processing', 'processed', 'retryable', 'rejected'
  )),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 1000000),
  safe_result_code TEXT CHECK (
    safe_result_code IS NULL OR (
      length(safe_result_code) BETWEEN 3 AND 96
      AND substr(safe_result_code, 1, 1) GLOB '[a-z]'
      AND safe_result_code NOT GLOB '*[^a-z0-9._:-]*'
    )
  ),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, connection_id, provider_code, provider_event_id),
  FOREIGN KEY (shop_id, connection_id)
    REFERENCES channel_connections(shop_id, id) ON DELETE CASCADE,
  CHECK ((status IN ('processed', 'rejected') AND processed_at IS NOT NULL)
    OR (status IN ('accepted', 'processing', 'retryable') AND processed_at IS NULL))
) STRICT;

CREATE INDEX idx_channel_provider_event_receipts_shop_status
  ON channel_provider_event_receipts(shop_id, status, received_at DESC, id);

CREATE INDEX idx_channel_provider_event_receipts_connection
  ON channel_provider_event_receipts(shop_id, connection_id, provider_code, received_at DESC, id);

CREATE INDEX idx_channel_provider_event_receipts_retry
  ON channel_provider_event_receipts(status, updated_at, id)
  WHERE status IN ('accepted', 'processing', 'retryable');

-- A receipt must belong to the same provider connection and an active or
-- degraded connection. Provider-pending requests cannot consume webhooks.
CREATE TRIGGER channel_provider_event_receipts_scope_insert_guard
BEFORE INSERT ON channel_provider_event_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM channel_connections
  INNER JOIN shop_channels
    ON shop_channels.shop_id = channel_connections.shop_id
    AND shop_channels.id = channel_connections.shop_channel_id
    AND shop_channels.channel_code = NEW.provider_code
  WHERE channel_connections.shop_id = NEW.shop_id
    AND channel_connections.id = NEW.connection_id
    AND channel_connections.provider_code = NEW.provider_code
    AND channel_connections.status IN ('active', 'degraded')
)
BEGIN
  SELECT RAISE(ABORT, 'channel_provider_event_receipt_scope_mismatch');
END;

CREATE TRIGGER channel_provider_event_receipts_identity_immutable
BEFORE UPDATE ON channel_provider_event_receipts
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.connection_id != OLD.connection_id
  OR NEW.provider_code != OLD.provider_code
  OR NEW.provider_event_id != OLD.provider_event_id
  OR NEW.action != OLD.action
  OR NEW.payload_reference != OLD.payload_reference
  OR NEW.received_at != OLD.received_at
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'channel_provider_event_receipt_identity_immutable');
END;

CREATE TRIGGER channel_provider_event_receipts_transition_guard
BEFORE UPDATE ON channel_provider_event_receipts
WHEN NOT (
  (OLD.status = 'accepted' AND NEW.status IN ('accepted', 'processing', 'retryable', 'processed', 'rejected'))
  OR (OLD.status = 'processing' AND NEW.status IN ('processing', 'retryable', 'processed', 'rejected'))
  OR (OLD.status = 'retryable' AND NEW.status IN ('accepted', 'processing', 'retryable', 'rejected'))
  OR (OLD.status IN ('processed', 'rejected') AND NEW.status = OLD.status)
)
BEGIN
  SELECT RAISE(ABORT, 'channel_provider_event_receipt_transition_invalid');
END;

CREATE TRIGGER channel_provider_event_receipts_immutable_delete
BEFORE DELETE ON channel_provider_event_receipts
BEGIN
  SELECT RAISE(ABORT, 'channel_provider_event_receipt_immutable');
END;
