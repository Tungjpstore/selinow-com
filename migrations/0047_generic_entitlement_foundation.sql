PRAGMA foreign_keys = ON;

-- Generic entitlement capability metadata is additive to the legacy
-- license_key/manual columns and to the private-file fulfillment graph.
CREATE UNIQUE INDEX idx_shop_customers_shop_id
  ON shop_customers(shop_id, id);

CREATE TABLE entitlement_resources (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  resource_key TEXT NOT NULL CHECK (
    length(resource_key) BETWEEN 3 AND 96
    AND resource_key GLOB '[a-z0-9]*'
    AND resource_key NOT GLOB '*[^a-z0-9._:-]*'
  ),
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'generated_license', 'membership', 'community_access',
    'seat', 'device_activation', 'provider_access'
  )),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, resource_key),
  CHECK ((status = 'retired') = (retired_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_entitlement_resources_shop_status
  ON entitlement_resources(shop_id, status, updated_at DESC, id);

CREATE TRIGGER entitlement_resources_insert_guard
BEFORE INSERT ON entitlement_resources
WHEN NOT EXISTS (
  SELECT 1 FROM shops
  WHERE shops.id = NEW.shop_id
    AND shops.status IN ('draft', 'active')
)
BEGIN
  SELECT RAISE(ABORT, 'entitlement_resource_shop_ineligible');
END;

CREATE TRIGGER entitlement_resources_identity_guard
BEFORE UPDATE ON entitlement_resources
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.resource_key != OLD.resource_key
  OR NEW.resource_type != OLD.resource_type
  OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR NOT (
    (OLD.status = 'active' AND NEW.status IN ('active', 'retired'))
    OR (OLD.status = 'retired' AND NEW.status = 'retired')
  )
BEGIN
  SELECT RAISE(ABORT, 'entitlement_resource_identity_immutable');
END;

CREATE TRIGGER entitlement_resources_delete_guard
BEFORE DELETE ON entitlement_resources
BEGIN
  SELECT RAISE(ABORT, 'entitlement_resource_immutable');
END;

CREATE TABLE product_entitlement_policies (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  activation_condition TEXT NOT NULL CHECK (activation_condition = 'order_paid'),
  grant_quantity_per_unit INTEGER NOT NULL DEFAULT 1 CHECK (grant_quantity_per_unit BETWEEN 1 AND 1000),
  entitlement_ttl_seconds INTEGER CHECK (
    entitlement_ttl_seconds IS NULL
    OR entitlement_ttl_seconds BETWEEN 300 AND 315360000
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, product_id, resource_id, policy_version),
  FOREIGN KEY (shop_id, product_id)
    REFERENCES products(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, resource_id)
    REFERENCES entitlement_resources(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'retired') = (retired_at IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX idx_product_entitlement_policies_shop_active
  ON product_entitlement_policies(shop_id, product_id, resource_id)
  WHERE status = 'active';

CREATE INDEX idx_product_entitlement_policies_shop_resource
  ON product_entitlement_policies(shop_id, resource_id, status, product_id, id);

CREATE TRIGGER product_entitlement_policies_insert_guard
BEFORE INSERT ON product_entitlement_policies
WHEN NOT EXISTS (
  SELECT 1
  FROM products
  INNER JOIN entitlement_resources
    ON entitlement_resources.id = NEW.resource_id
    AND entitlement_resources.shop_id = products.shop_id
  WHERE products.id = NEW.product_id
    AND products.shop_id = NEW.shop_id
    AND products.status IN ('draft', 'active')
    AND entitlement_resources.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'entitlement_policy_scope_mismatch');
END;

CREATE TRIGGER product_entitlement_policies_identity_guard
BEFORE UPDATE ON product_entitlement_policies
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.product_id != OLD.product_id
  OR NEW.resource_id != OLD.resource_id
  OR NEW.policy_version != OLD.policy_version
  OR NEW.activation_condition != OLD.activation_condition
  OR NEW.grant_quantity_per_unit != OLD.grant_quantity_per_unit
  OR NEW.entitlement_ttl_seconds IS NOT OLD.entitlement_ttl_seconds
  OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
  OR NEW.created_at != OLD.created_at
  OR NOT (
    (OLD.status = 'active' AND NEW.status IN ('active', 'retired'))
    OR (OLD.status = 'retired' AND NEW.status = 'retired')
  )
BEGIN
  SELECT RAISE(ABORT, 'entitlement_policy_identity_immutable');
END;

CREATE TRIGGER product_entitlement_policies_delete_guard
BEFORE DELETE ON product_entitlement_policies
BEGIN
  SELECT RAISE(ABORT, 'entitlement_policy_immutable');
END;

CREATE TABLE order_item_entitlement_requirements (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  activation_condition TEXT NOT NULL CHECK (activation_condition = 'order_paid'),
  item_quantity INTEGER NOT NULL CHECK (item_quantity > 0),
  grant_quantity INTEGER NOT NULL CHECK (grant_quantity > 0 AND grant_quantity <= 1000000),
  entitlement_ttl_seconds INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, order_item_id, resource_id),
  FOREIGN KEY (shop_id, order_id)
    REFERENCES orders(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, order_item_id)
    REFERENCES order_items(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, policy_id)
    REFERENCES product_entitlement_policies(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, resource_id)
    REFERENCES entitlement_resources(shop_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_order_item_entitlement_requirements_shop_order
  ON order_item_entitlement_requirements(shop_id, order_id, order_item_id, resource_id, id);

CREATE INDEX idx_order_item_entitlement_requirements_shop_policy
  ON order_item_entitlement_requirements(shop_id, policy_id, created_at DESC, id);

CREATE TRIGGER order_item_entitlement_requirements_scope_guard
BEFORE INSERT ON order_item_entitlement_requirements
WHEN NOT EXISTS (
  SELECT 1
  FROM order_items
  INNER JOIN product_entitlement_policies
    ON product_entitlement_policies.id = NEW.policy_id
    AND product_entitlement_policies.shop_id = order_items.shop_id
    AND product_entitlement_policies.product_id = order_items.product_id
  INNER JOIN entitlement_resources
    ON entitlement_resources.id = product_entitlement_policies.resource_id
    AND entitlement_resources.shop_id = product_entitlement_policies.shop_id
  WHERE order_items.id = NEW.order_item_id
    AND order_items.shop_id = NEW.shop_id
    AND order_items.order_id = NEW.order_id
    AND product_entitlement_policies.resource_id = NEW.resource_id
    AND product_entitlement_policies.policy_version = NEW.policy_version
    AND product_entitlement_policies.activation_condition = NEW.activation_condition
    AND product_entitlement_policies.grant_quantity_per_unit > 0
    AND product_entitlement_policies.entitlement_ttl_seconds IS NEW.entitlement_ttl_seconds
    AND product_entitlement_policies.status = 'active'
    AND entitlement_resources.status = 'active'
    AND NEW.item_quantity = order_items.quantity
    AND NEW.grant_quantity = order_items.quantity * product_entitlement_policies.grant_quantity_per_unit
)
BEGIN
  SELECT RAISE(ABORT, 'entitlement_requirement_scope_mismatch');
END;

CREATE TRIGGER order_item_entitlement_requirements_immutable
BEFORE UPDATE ON order_item_entitlement_requirements
BEGIN
  SELECT RAISE(ABORT, 'entitlement_requirement_immutable');
END;

CREATE TRIGGER order_item_entitlement_requirements_delete_guard
BEFORE DELETE ON order_item_entitlement_requirements
BEGIN
  SELECT RAISE(ABORT, 'entitlement_requirement_immutable');
END;

CREATE TRIGGER order_item_entitlement_requirements_manual_execution_guard
BEFORE INSERT ON order_item_entitlement_requirements
WHEN EXISTS (
  SELECT 1 FROM manual_fulfillment_executions AS execution
  WHERE execution.shop_id = NEW.shop_id
    AND execution.order_item_id = NEW.order_item_id
)
BEGIN
  SELECT RAISE(ABORT, 'generic_entitlement_manual_fulfillment_conflict');
END;

CREATE TRIGGER manual_fulfillment_executions_generic_entitlement_guard
BEFORE INSERT ON manual_fulfillment_executions
WHEN EXISTS (
  SELECT 1 FROM order_item_entitlement_requirements AS requirement
  WHERE requirement.shop_id = NEW.shop_id
    AND requirement.order_item_id = NEW.order_item_id
)
BEGIN
  SELECT RAISE(ABORT, 'generic_entitlement_manual_fulfillment_conflict');
END;

CREATE TABLE entitlements (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  customer_id TEXT,
  buyer_binding_hash TEXT NOT NULL CHECK (
    length(buyer_binding_hash) = 43
    AND buyer_binding_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'expired', 'revoked')),
  grant_quantity INTEGER NOT NULL CHECK (grant_quantity > 0 AND grant_quantity <= 1000000),
  entitlement_ttl_seconds INTEGER,
  access_expires_at TEXT,
  activated_at TEXT,
  suspended_at TEXT,
  expired_at TEXT,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, requirement_id),
  FOREIGN KEY (shop_id, order_id)
    REFERENCES orders(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, order_item_id)
    REFERENCES order_items(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, requirement_id)
    REFERENCES order_item_entitlement_requirements(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, resource_id)
    REFERENCES entitlement_resources(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, customer_id)
    REFERENCES shop_customers(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'suspended') = (suspended_at IS NOT NULL)),
  CHECK ((status = 'expired') = (expired_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (
    (status = 'pending' AND activated_at IS NULL)
    OR (status IN ('active', 'suspended', 'expired') AND activated_at IS NOT NULL)
    OR status = 'revoked'
  ),
  CHECK (
    status = 'pending'
    OR entitlement_ttl_seconds IS NULL
    OR access_expires_at IS NOT NULL
  ),
  CHECK (access_expires_at IS NULL OR (activated_at IS NOT NULL AND access_expires_at > activated_at))
) STRICT;

CREATE INDEX idx_entitlements_shop_order
  ON entitlements(shop_id, order_id, status, order_item_id, id);

CREATE INDEX idx_entitlements_shop_resource_status
  ON entitlements(shop_id, resource_id, status, access_expires_at, id);

CREATE INDEX idx_entitlements_shop_expiry
  ON entitlements(shop_id, status, access_expires_at, id)
  WHERE status IN ('active', 'suspended') AND access_expires_at IS NOT NULL;

CREATE TRIGGER entitlements_scope_guard_insert
BEFORE INSERT ON entitlements
WHEN NOT EXISTS (
  SELECT 1
  FROM order_item_entitlement_requirements AS requirement
  INNER JOIN orders
    ON orders.id = requirement.order_id
    AND orders.shop_id = requirement.shop_id
  LEFT JOIN shop_customers AS customer
    ON customer.id = orders.customer_id
    AND customer.shop_id = orders.shop_id
  WHERE requirement.id = NEW.requirement_id
    AND requirement.shop_id = NEW.shop_id
    AND requirement.order_id = NEW.order_id
    AND requirement.order_item_id = NEW.order_item_id
    AND requirement.resource_id = NEW.resource_id
    AND requirement.grant_quantity = NEW.grant_quantity
    AND requirement.entitlement_ttl_seconds IS NEW.entitlement_ttl_seconds
    AND orders.order_token_hash = NEW.buyer_binding_hash
    AND orders.customer_id IS NEW.customer_id
    AND NEW.version = 1
    AND (NEW.customer_id IS NULL OR customer.id IS NOT NULL)
    AND (
      (orders.total_minor > 0
        AND orders.payment_status IN ('unpaid', 'pending')
        AND orders.status = 'pending_payment'
        AND NEW.status = 'pending'
        AND NEW.activated_at IS NULL
        AND NEW.access_expires_at IS NULL)
      OR (orders.total_minor = 0
        AND orders.payment_status = 'paid'
        AND orders.status IN ('processing', 'completed')
        AND NEW.status = 'active'
        AND NEW.activated_at = NEW.created_at
        AND (
          (requirement.entitlement_ttl_seconds IS NULL AND NEW.access_expires_at IS NULL)
          OR (
            requirement.entitlement_ttl_seconds IS NOT NULL
            AND unixepoch(NEW.access_expires_at) =
              unixepoch(NEW.activated_at) + requirement.entitlement_ttl_seconds
          )
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'entitlement_activation_scope_mismatch');
END;

CREATE TRIGGER entitlements_identity_guard
BEFORE UPDATE ON entitlements
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.order_id != OLD.order_id
  OR NEW.order_item_id != OLD.order_item_id
  OR NEW.requirement_id != OLD.requirement_id
  OR NEW.resource_id != OLD.resource_id
  OR NEW.customer_id IS NOT OLD.customer_id
  OR NEW.buyer_binding_hash != OLD.buyer_binding_hash
  OR NEW.grant_quantity != OLD.grant_quantity
  OR NEW.entitlement_ttl_seconds IS NOT OLD.entitlement_ttl_seconds
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR (OLD.status != 'pending' AND NEW.access_expires_at IS NOT OLD.access_expires_at)
  OR (OLD.status != 'pending' AND NEW.activated_at IS NOT OLD.activated_at)
  OR (OLD.status = 'pending' AND NEW.status = 'active' AND (
    NEW.activated_at IS NULL
    OR NEW.updated_at != NEW.activated_at
    OR (
      OLD.entitlement_ttl_seconds IS NULL
      AND NEW.access_expires_at IS NOT NULL
    )
    OR (
      OLD.entitlement_ttl_seconds IS NOT NULL
      AND unixepoch(NEW.access_expires_at) !=
        unixepoch(NEW.activated_at) + OLD.entitlement_ttl_seconds
    )
  ))
  OR NOT (
    (OLD.status = 'pending' AND NEW.status IN ('pending', 'active', 'revoked'))
    OR (OLD.status = 'active' AND NEW.status IN ('active', 'suspended', 'expired', 'revoked'))
    OR (OLD.status = 'suspended' AND NEW.status IN ('active', 'suspended', 'expired', 'revoked'))
    OR (OLD.status = 'expired' AND NEW.status = 'expired')
    OR (OLD.status = 'revoked' AND NEW.status = 'revoked')
  )
BEGIN
  SELECT RAISE(ABORT, 'entitlement_identity_or_transition_invalid');
END;

CREATE TRIGGER entitlements_delete_guard
BEFORE DELETE ON entitlements
BEGIN
  SELECT RAISE(ABORT, 'entitlement_immutable');
END;

CREATE TABLE entitlement_grants (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  entitlement_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('free_checkout', 'payment_exact')),
  source_payment_event_id TEXT,
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 43
    AND idempotency_key_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 43
    AND request_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 8 AND 160),
  granted_quantity INTEGER NOT NULL CHECK (granted_quantity > 0 AND granted_quantity <= 1000000),
  reference_hash TEXT CHECK (
    reference_hash IS NULL OR (
      length(reference_hash) = 43
      AND reference_hash NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  reference_hash_key_version TEXT CHECK (
    (reference_hash IS NULL AND reference_hash_key_version IS NULL)
    OR (reference_hash IS NOT NULL AND reference_hash_key_version = 'identifier-hmac-v1')
  ),
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, entitlement_id),
  UNIQUE (shop_id, idempotency_key_hash),
  FOREIGN KEY (shop_id, entitlement_id)
    REFERENCES entitlements(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, requirement_id)
    REFERENCES order_item_entitlement_requirements(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, order_id)
    REFERENCES orders(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, resource_id)
    REFERENCES entitlement_resources(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, source_payment_event_id)
    REFERENCES payment_events(shop_id, id) ON DELETE RESTRICT,
  CHECK (
    (source_kind = 'free_checkout' AND source_payment_event_id IS NULL)
    OR (source_kind = 'payment_exact' AND source_payment_event_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_entitlement_grants_shop_entitlement
  ON entitlement_grants(shop_id, entitlement_id, created_at DESC, id);

CREATE INDEX idx_entitlement_grants_shop_source
  ON entitlement_grants(shop_id, source_kind, created_at DESC, id);

CREATE TRIGGER entitlement_grants_scope_guard_insert
BEFORE INSERT ON entitlement_grants
WHEN NOT EXISTS (
  SELECT 1
  FROM entitlements
  INNER JOIN order_item_entitlement_requirements AS requirement
    ON requirement.id = entitlements.requirement_id
    AND requirement.shop_id = entitlements.shop_id
  INNER JOIN orders
    ON orders.id = entitlements.order_id
    AND orders.shop_id = entitlements.shop_id
  WHERE entitlements.id = NEW.entitlement_id
    AND entitlements.shop_id = NEW.shop_id
    AND entitlements.requirement_id = NEW.requirement_id
    AND entitlements.order_id = NEW.order_id
    AND entitlements.resource_id = NEW.resource_id
    AND entitlements.status = 'active'
    AND entitlements.grant_quantity = NEW.granted_quantity
    AND entitlements.activated_at = NEW.created_at
    AND requirement.grant_quantity = NEW.granted_quantity
    AND (
      (NEW.source_kind = 'free_checkout'
        AND NEW.source_payment_event_id IS NULL
        AND orders.total_minor = 0
        AND orders.payment_status = 'paid'
        AND orders.paid_at IS NOT NULL)
      OR (NEW.source_kind = 'payment_exact'
        AND NEW.source_payment_event_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM payment_events AS event
          INNER JOIN payment_attempts AS attempt
            ON attempt.id = event.payment_attempt_id
            AND attempt.shop_id = event.shop_id
          WHERE event.id = NEW.source_payment_event_id
            AND event.shop_id = NEW.shop_id
            AND event.signature_verified = 1
            AND event.processed_at IS NULL
            AND event.processing_token IS NOT NULL
            AND attempt.order_id = NEW.order_id
            AND attempt.state = 'paid_exact'
            AND attempt.paid_event_id = event.id
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'entitlement_grant_scope_mismatch');
END;

CREATE TRIGGER entitlement_grants_immutable_update
BEFORE UPDATE ON entitlement_grants
BEGIN
  SELECT RAISE(ABORT, 'entitlement_grant_immutable');
END;

CREATE TRIGGER entitlement_grants_delete_guard
BEFORE DELETE ON entitlement_grants
BEGIN
  SELECT RAISE(ABORT, 'entitlement_grant_immutable');
END;

CREATE TABLE entitlement_transitions (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  entitlement_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  entitlement_version INTEGER NOT NULL CHECK (entitlement_version > 0),
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('pending', 'active', 'suspended', 'expired', 'revoked')),
  to_status TEXT NOT NULL CHECK (to_status IN ('pending', 'active', 'suspended', 'expired', 'revoked')),
  source_grant_id TEXT,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 3 AND 64),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 43
    AND idempotency_key_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 43
    AND request_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system', 'seller', 'provider', 'buyer')),
  actor_user_id TEXT REFERENCES platform_users(id) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, entitlement_id, entitlement_version),
  UNIQUE (shop_id, entitlement_id, idempotency_key_hash),
  FOREIGN KEY (shop_id, entitlement_id)
    REFERENCES entitlements(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, requirement_id)
    REFERENCES order_item_entitlement_requirements(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, resource_id)
    REFERENCES entitlement_resources(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, source_grant_id)
    REFERENCES entitlement_grants(shop_id, id) ON DELETE RESTRICT,
  CHECK ((actor_kind = 'system') = (actor_user_id IS NULL)),
  CHECK (
    (to_status = 'active' AND from_status IN ('pending') AND source_grant_id IS NOT NULL)
    OR (entitlement_version = 1 AND to_status = 'active' AND from_status IS NULL AND source_grant_id IS NOT NULL)
    OR (to_status != 'active' AND source_grant_id IS NULL)
    OR (to_status = 'active' AND from_status = 'suspended' AND source_grant_id IS NULL)
  ),
  CHECK (created_at = occurred_at)
) STRICT;

CREATE INDEX idx_entitlement_transitions_shop_entitlement
  ON entitlement_transitions(shop_id, entitlement_id, entitlement_version, created_at DESC, id);

CREATE INDEX idx_entitlement_transitions_shop_reason
  ON entitlement_transitions(shop_id, reason_code, created_at DESC, id);

CREATE TRIGGER entitlement_transitions_scope_guard_insert
BEFORE INSERT ON entitlement_transitions
WHEN NOT EXISTS (
  SELECT 1
  FROM entitlements
  WHERE entitlements.id = NEW.entitlement_id
    AND entitlements.shop_id = NEW.shop_id
    AND entitlements.requirement_id = NEW.requirement_id
    AND entitlements.resource_id = NEW.resource_id
    AND entitlements.version = NEW.entitlement_version
    AND entitlements.status = NEW.to_status
    AND (
      (NEW.entitlement_version = 1 AND NEW.from_status IS NULL AND NEW.to_status IN ('pending', 'active'))
      OR (
        NEW.entitlement_version > 1
        AND NEW.from_status IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM entitlement_transitions AS previous
          WHERE previous.shop_id = NEW.shop_id
            AND previous.entitlement_id = NEW.entitlement_id
            AND previous.entitlement_version = NEW.entitlement_version - 1
            AND previous.to_status = NEW.from_status
        )
      )
    )
    AND (
      (NEW.source_grant_id IS NULL AND NEW.to_status != 'active')
      OR (NEW.source_grant_id IS NULL AND NEW.from_status = 'suspended' AND NEW.to_status = 'active')
      OR EXISTS (
        SELECT 1 FROM entitlement_grants AS grant_row
        WHERE grant_row.id = NEW.source_grant_id
          AND grant_row.shop_id = NEW.shop_id
          AND grant_row.entitlement_id = NEW.entitlement_id
          AND grant_row.requirement_id = NEW.requirement_id
          AND grant_row.resource_id = NEW.resource_id
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'entitlement_transition_scope_mismatch');
END;

CREATE TRIGGER entitlement_transitions_immutable_update
BEFORE UPDATE ON entitlement_transitions
BEGIN
  SELECT RAISE(ABORT, 'entitlement_transition_immutable');
END;

CREATE TRIGGER entitlement_transitions_immutable_delete
BEFORE DELETE ON entitlement_transitions
BEGIN
  SELECT RAISE(ABORT, 'entitlement_transition_immutable');
END;
