PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX idx_orders_shop_id_customer
  ON orders (shop_id, id, customer_id);

CREATE TABLE order_access_recovery_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  issued_request_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  retention_expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_request_id TEXT,
  previous_order_token_hash TEXT,
  replacement_order_token_hash TEXT,
  revoked_at TEXT,
  redacted_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, token_hash),
  FOREIGN KEY (shop_id, order_id, customer_id)
    REFERENCES orders(shop_id, id, customer_id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, customer_id)
    REFERENCES shop_customers(shop_id, id) ON DELETE CASCADE,
  CHECK (length(token_hash) BETWEEN 32 AND 128),
  CHECK (length(recipient_hash) BETWEEN 32 AND 128),
  CHECK (length(issued_request_id) BETWEEN 8 AND 128),
  CHECK (expires_at > issued_at),
  CHECK (retention_expires_at > expires_at),
  CHECK (
    (
      consumed_at IS NULL
      AND consumed_request_id IS NULL
      AND previous_order_token_hash IS NULL
      AND replacement_order_token_hash IS NULL
    )
    OR (
      consumed_at IS NOT NULL
      AND consumed_request_id IS NOT NULL
      AND previous_order_token_hash IS NOT NULL
      AND replacement_order_token_hash IS NOT NULL
    )
  ),
  CHECK (consumed_request_id IS NULL OR length(consumed_request_id) BETWEEN 8 AND 128),
  CHECK (previous_order_token_hash IS NULL OR length(previous_order_token_hash) BETWEEN 32 AND 128),
  CHECK (replacement_order_token_hash IS NULL OR length(replacement_order_token_hash) BETWEEN 32 AND 128),
  CHECK (previous_order_token_hash IS NULL OR previous_order_token_hash != replacement_order_token_hash),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CHECK (redacted_at IS NULL OR redacted_at >= retention_expires_at),
  CHECK (redacted_at IS NULL OR consumed_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX idx_order_access_recovery_tokens_active_order
  ON order_access_recovery_tokens (shop_id, order_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX idx_order_access_recovery_tokens_shop_order
  ON order_access_recovery_tokens (
    shop_id, order_id, consumed_at, revoked_at, expires_at, id
  );

CREATE INDEX idx_order_access_recovery_tokens_shop_customer
  ON order_access_recovery_tokens (shop_id, customer_id, expires_at, id);

CREATE INDEX idx_order_access_recovery_tokens_retention
  ON order_access_recovery_tokens (retention_expires_at, redacted_at, id);

CREATE UNIQUE INDEX idx_order_access_recovery_tokens_replacement
  ON order_access_recovery_tokens (shop_id, replacement_order_token_hash)
  WHERE consumed_at IS NOT NULL;

CREATE INDEX idx_order_access_recovery_tokens_previous
  ON order_access_recovery_tokens (shop_id, order_id, previous_order_token_hash)
  WHERE consumed_at IS NOT NULL;

CREATE TRIGGER order_access_recovery_tokens_scope_insert_guard
BEFORE INSERT ON order_access_recovery_tokens
WHEN NOT EXISTS (
  SELECT 1
  FROM orders
  INNER JOIN shop_customers
    ON shop_customers.id = orders.customer_id
    AND shop_customers.shop_id = orders.shop_id
  WHERE orders.id = NEW.order_id
    AND orders.shop_id = NEW.shop_id
    AND shop_customers.id = NEW.customer_id
)
BEGIN
  SELECT RAISE(ABORT, 'order_access_recovery_tenant_mismatch');
END;

CREATE TRIGGER order_access_recovery_tokens_identity_immutable
BEFORE UPDATE ON order_access_recovery_tokens
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.order_id != OLD.order_id
  OR NEW.customer_id != OLD.customer_id
  OR NEW.issued_at != OLD.issued_at
  OR NEW.expires_at != OLD.expires_at
  OR NEW.retention_expires_at != OLD.retention_expires_at
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'order_access_recovery_identity_immutable');
END;

CREATE TRIGGER order_access_recovery_tokens_redaction_guard
BEFORE UPDATE ON order_access_recovery_tokens
WHEN (
    OLD.redacted_at IS NULL
    AND NEW.redacted_at IS NULL
    AND (
      NEW.token_hash != OLD.token_hash
      OR NEW.recipient_hash != OLD.recipient_hash
      OR NEW.issued_request_id != OLD.issued_request_id
    )
  )
  OR (
    OLD.redacted_at IS NULL
    AND NEW.redacted_at IS NOT NULL
    AND (
      OLD.consumed_at IS NULL
      OR NEW.redacted_at < OLD.retention_expires_at
      OR NEW.token_hash = OLD.token_hash
      OR NEW.recipient_hash = OLD.recipient_hash
      OR NEW.issued_request_id NOT LIKE 'redacted:%'
    )
  )
  OR (
    OLD.redacted_at IS NOT NULL
    AND (
      NEW.redacted_at IS NOT OLD.redacted_at
      OR NEW.token_hash != OLD.token_hash
      OR NEW.recipient_hash != OLD.recipient_hash
      OR NEW.issued_request_id != OLD.issued_request_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'order_access_recovery_redaction_invalid');
END;

CREATE TRIGGER order_access_recovery_tokens_terminal_immutable
BEFORE UPDATE ON order_access_recovery_tokens
WHEN (OLD.consumed_at IS NOT NULL AND (
    NEW.consumed_at IS NOT OLD.consumed_at
    OR NEW.consumed_request_id IS NOT OLD.consumed_request_id
    OR NEW.previous_order_token_hash IS NOT OLD.previous_order_token_hash
    OR NEW.replacement_order_token_hash IS NOT OLD.replacement_order_token_hash
  ))
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN
  SELECT RAISE(ABORT, 'order_access_recovery_terminal_immutable');
END;

CREATE TRIGGER order_access_recovery_tokens_consume_rotate_order
AFTER UPDATE OF consumed_at ON order_access_recovery_tokens
WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
BEGIN
  UPDATE orders
  SET order_token_hash = NEW.replacement_order_token_hash,
      updated_at = NEW.consumed_at
  WHERE id = NEW.order_id
    AND shop_id = NEW.shop_id
    AND customer_id = NEW.customer_id
    AND source_channel = 'web'
    AND order_token_hash = NEW.previous_order_token_hash
    AND EXISTS (
      SELECT 1 FROM shop_customers
      WHERE id = NEW.customer_id
        AND shop_id = NEW.shop_id
        AND anonymized_at IS NULL
    );

  SELECT RAISE(ABORT, 'order_access_recovery_order_rotation_failed')
  WHERE changes() != 1;
END;

CREATE TRIGGER order_access_recovery_tokens_customer_anonymize
AFTER UPDATE OF anonymized_at ON shop_customers
WHEN OLD.anonymized_at IS NULL AND NEW.anonymized_at IS NOT NULL
BEGIN
  UPDATE orders
  SET order_token_hash = lower(hex(randomblob(32))),
      updated_at = NEW.anonymized_at
  WHERE shop_id = NEW.shop_id
    AND customer_id = NEW.id
    AND source_channel = 'web';

  DELETE FROM order_access_recovery_tokens
  WHERE shop_id = NEW.shop_id AND customer_id = NEW.id;
END;
