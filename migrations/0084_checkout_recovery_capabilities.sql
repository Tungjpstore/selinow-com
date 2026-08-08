CREATE TABLE checkout_recovery_capabilities (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  cart_id TEXT NOT NULL,
  checkout_subject_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_order_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(id),
  FOREIGN KEY (consumed_order_id) REFERENCES orders(id),
  UNIQUE (shop_id, checkout_subject_hash, request_hash)
);

CREATE INDEX idx_checkout_recovery_capabilities_shop_expiry
  ON checkout_recovery_capabilities (shop_id, expires_at, id);

CREATE INDEX idx_checkout_recovery_capabilities_shop_cart
  ON checkout_recovery_capabilities (shop_id, cart_id, id);

CREATE TRIGGER checkout_recovery_capabilities_tenant_order_guard
BEFORE UPDATE OF consumed_order_id ON checkout_recovery_capabilities
WHEN NEW.consumed_order_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM orders
    WHERE orders.id = NEW.consumed_order_id
      AND orders.shop_id = NEW.shop_id
  )
BEGIN
  SELECT RAISE(ABORT, 'checkout_recovery_order_tenant_mismatch');
END;
