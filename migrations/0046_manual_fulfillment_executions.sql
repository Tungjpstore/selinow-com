PRAGMA foreign_keys = ON;

-- Manual fulfillment is recorded per order item. The existing fulfillment
-- row remains the compatibility projection for older order readers.
CREATE UNIQUE INDEX idx_fulfillments_shop_id
  ON fulfillments(shop_id, id);

CREATE TABLE manual_fulfillment_executions (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  fulfillment_id TEXT NOT NULL,
  execution_type TEXT NOT NULL CHECK (execution_type = 'seller_attested_delivery'),
  state TEXT NOT NULL CHECK (state = 'completed'),
  completed_quantity INTEGER NOT NULL CHECK (completed_quantity > 0),
  actor_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 43
    AND idempotency_key_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 43
    AND request_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 8 AND 128),
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, order_item_id),
  UNIQUE (shop_id, idempotency_key_hash),
  FOREIGN KEY (shop_id, order_id)
    REFERENCES orders(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, order_item_id)
    REFERENCES order_items(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, fulfillment_id)
    REFERENCES fulfillments(shop_id, id) ON DELETE RESTRICT,
  CHECK (completed_at = created_at)
) STRICT;

CREATE INDEX idx_manual_fulfillment_executions_shop_order
  ON manual_fulfillment_executions(shop_id, order_id, completed_at DESC, id);

CREATE INDEX idx_manual_fulfillment_executions_shop_actor
  ON manual_fulfillment_executions(shop_id, actor_user_id, completed_at DESC, id);

CREATE TRIGGER manual_fulfillment_executions_scope_guard_insert
BEFORE INSERT ON manual_fulfillment_executions
WHEN NOT EXISTS (
  SELECT 1
  FROM shops
  INNER JOIN orders
    ON orders.shop_id = shops.id
  INNER JOIN order_items
    ON order_items.shop_id = orders.shop_id
    AND order_items.order_id = orders.id
  INNER JOIN fulfillments
    ON fulfillments.shop_id = orders.shop_id
    AND fulfillments.order_id = orders.id
  INNER JOIN shop_members
    ON shop_members.shop_id = shops.id
  WHERE shops.id = NEW.shop_id
    AND shops.status = 'active'
    AND orders.id = NEW.order_id
    AND orders.payment_status = 'paid'
    AND orders.paid_at IS NOT NULL
    AND orders.status IN ('processing', 'completed')
    AND order_items.id = NEW.order_item_id
    AND order_items.fulfillment_type = 'manual'
    AND order_items.quantity = NEW.completed_quantity
    AND NOT EXISTS (
      SELECT 1 FROM order_item_fulfillment_requirements AS typed_requirement
      WHERE typed_requirement.shop_id = order_items.shop_id
        AND typed_requirement.order_item_id = order_items.id
        AND typed_requirement.capability = 'private_file'
    )
    AND fulfillments.id = NEW.fulfillment_id
    AND fulfillments.fulfillment_type = 'manual'
    AND fulfillments.state IN ('pending', 'manual_review')
    AND shop_members.user_id = NEW.actor_user_id
    AND shop_members.status = 'active'
    AND shop_members.role IN ('owner', 'manager')
)
BEGIN
  SELECT RAISE(ABORT, 'manual_fulfillment_execution_scope_mismatch');
END;

CREATE TRIGGER manual_fulfillment_executions_immutable_update
BEFORE UPDATE ON manual_fulfillment_executions
BEGIN
  SELECT RAISE(ABORT, 'manual_fulfillment_execution_immutable');
END;

CREATE TRIGGER manual_fulfillment_executions_immutable_delete
BEFORE DELETE ON manual_fulfillment_executions
BEGIN
  SELECT RAISE(ABORT, 'manual_fulfillment_execution_immutable');
END;

CREATE TRIGGER order_item_requirements_manual_execution_guard_insert
BEFORE INSERT ON order_item_fulfillment_requirements
WHEN NEW.capability = 'private_file'
  AND EXISTS (
    SELECT 1 FROM manual_fulfillment_executions AS execution
    WHERE execution.shop_id = NEW.shop_id
      AND execution.order_item_id = NEW.order_item_id
  )
BEGIN
  SELECT RAISE(ABORT, 'private_file_manual_fulfillment_conflict');
END;

-- Only a keyed hash of the seller-supplied reference is durable. Raw
-- provider bodies, credentials, license material and reference plaintext are
-- never accepted by this ledger.
CREATE TABLE external_fulfillment_references (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL,
  reference_type TEXT NOT NULL CHECK (
    reference_type IN ('merchant_reference', 'delivery_reference', 'support_ticket', 'other')
  ),
  reference_hash TEXT NOT NULL CHECK (
    length(reference_hash) = 43
    AND reference_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  hash_key_version TEXT NOT NULL CHECK (hash_key_version = 'identifier-hmac-v1'),
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, execution_id),
  FOREIGN KEY (shop_id, execution_id)
    REFERENCES manual_fulfillment_executions(shop_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_external_fulfillment_references_shop_type
  ON external_fulfillment_references(shop_id, reference_type, created_at DESC, id);

CREATE TRIGGER external_fulfillment_references_immutable_update
BEFORE UPDATE ON external_fulfillment_references
BEGIN
  SELECT RAISE(ABORT, 'external_fulfillment_reference_immutable');
END;

CREATE TRIGGER external_fulfillment_references_immutable_delete
BEFORE DELETE ON external_fulfillment_references
BEGIN
  SELECT RAISE(ABORT, 'external_fulfillment_reference_immutable');
END;
