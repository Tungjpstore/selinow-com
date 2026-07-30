PRAGMA foreign_keys = ON;

-- Composite tenant foreign keys need an explicit unique parent key. Existing
-- global ids remain unchanged and legacy rows require no backfill.
CREATE UNIQUE INDEX idx_products_shop_id
  ON products(shop_id, id);

CREATE UNIQUE INDEX idx_order_items_shop_id
  ON order_items(shop_id, id);

CREATE TABLE digital_assets (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind = 'private_file'),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'deleted')),
  created_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (shop_id, id),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_digital_assets_shop_status
  ON digital_assets(shop_id, status, updated_at DESC, id);

CREATE TRIGGER digital_assets_identity_immutable
BEFORE UPDATE ON digital_assets
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.kind != OLD.kind
  OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'digital_asset_identity_immutable');
END;

CREATE TRIGGER digital_assets_transition_guard
BEFORE UPDATE ON digital_assets
WHEN NOT (
  (OLD.status = 'active' AND NEW.status IN ('active', 'revoked', 'deleted'))
  OR (OLD.status = 'revoked' AND NEW.status IN ('revoked', 'deleted'))
  OR (OLD.status = 'deleted' AND NEW.status = 'deleted')
)
BEGIN
  SELECT RAISE(ABORT, 'digital_asset_transition_invalid');
END;

CREATE TABLE digital_asset_versions (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  object_key TEXT NOT NULL CHECK (
    length(object_key) BETWEEN 24 AND 512
    AND object_key GLOB 'private-digital-assets/*'
    AND object_key NOT GLOB '*[[:space:]]*'
  ),
  filename_sanitized TEXT NOT NULL CHECK (length(filename_sanitized) BETWEEN 1 AND 160),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 3 AND 96),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 52428800),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 43
    AND content_sha256 NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  object_etag TEXT NOT NULL CHECK (length(object_etag) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'deleted')),
  created_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, asset_id, version),
  UNIQUE (shop_id, object_key),
  FOREIGN KEY (shop_id, asset_id)
    REFERENCES digital_assets(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_digital_asset_versions_shop_asset
  ON digital_asset_versions(shop_id, asset_id, version DESC, id);

CREATE INDEX idx_digital_asset_versions_shop_status
  ON digital_asset_versions(shop_id, status, updated_at DESC, id);

CREATE TRIGGER digital_asset_versions_identity_immutable
BEFORE UPDATE ON digital_asset_versions
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.asset_id != OLD.asset_id
  OR NEW.version != OLD.version
  OR NEW.object_key != OLD.object_key
  OR NEW.filename_sanitized != OLD.filename_sanitized
  OR NEW.content_type != OLD.content_type
  OR NEW.byte_size != OLD.byte_size
  OR NEW.content_sha256 != OLD.content_sha256
  OR NEW.object_etag != OLD.object_etag
  OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'digital_asset_version_identity_immutable');
END;

CREATE TRIGGER digital_asset_versions_transition_guard
BEFORE UPDATE ON digital_asset_versions
WHEN NOT (
  (OLD.status = 'active' AND NEW.status IN ('active', 'revoked', 'deleted'))
  OR (OLD.status = 'revoked' AND NEW.status IN ('revoked', 'deleted'))
  OR (OLD.status = 'deleted' AND NEW.status = 'deleted')
)
BEGIN
  SELECT RAISE(ABORT, 'digital_asset_version_transition_invalid');
END;

CREATE TABLE product_fulfillment_policies (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability = 'private_file'),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  asset_version_id TEXT NOT NULL,
  max_downloads INTEGER NOT NULL CHECK (max_downloads BETWEEN 1 AND 100),
  grant_ttl_seconds INTEGER NOT NULL CHECK (grant_ttl_seconds BETWEEN 60 AND 86400),
  entitlement_ttl_seconds INTEGER CHECK (
    entitlement_ttl_seconds IS NULL
    OR entitlement_ttl_seconds BETWEEN 300 AND 31536000
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, product_id, capability, policy_version),
  FOREIGN KEY (shop_id, product_id)
    REFERENCES products(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, asset_version_id)
    REFERENCES digital_asset_versions(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'retired') = (retired_at IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX idx_product_fulfillment_policies_shop_active
  ON product_fulfillment_policies(shop_id, product_id, capability)
  WHERE status = 'active';

CREATE INDEX idx_product_fulfillment_policies_shop_asset
  ON product_fulfillment_policies(shop_id, asset_version_id, status, product_id, id);

CREATE TRIGGER product_fulfillment_policies_product_guard_insert
BEFORE INSERT ON product_fulfillment_policies
WHEN NOT EXISTS (
  SELECT 1 FROM products
  WHERE products.id = NEW.product_id
    AND products.shop_id = NEW.shop_id
    AND products.fulfillment_type = 'manual'
)
BEGIN
  SELECT RAISE(ABORT, 'private_file_product_ineligible');
END;

CREATE TRIGGER product_fulfillment_policies_asset_guard_insert
BEFORE INSERT ON product_fulfillment_policies
WHEN NOT EXISTS (
  SELECT 1
  FROM digital_asset_versions
  INNER JOIN digital_assets
    ON digital_assets.id = digital_asset_versions.asset_id
    AND digital_assets.shop_id = digital_asset_versions.shop_id
  WHERE digital_asset_versions.id = NEW.asset_version_id
    AND digital_asset_versions.shop_id = NEW.shop_id
    AND digital_asset_versions.status = 'active'
    AND digital_assets.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'private_file_asset_ineligible');
END;

CREATE TRIGGER product_fulfillment_policies_identity_immutable
BEFORE UPDATE ON product_fulfillment_policies
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.product_id != OLD.product_id
  OR NEW.capability != OLD.capability
  OR NEW.policy_version != OLD.policy_version
  OR NEW.asset_version_id != OLD.asset_version_id
  OR NEW.max_downloads != OLD.max_downloads
  OR NEW.grant_ttl_seconds != OLD.grant_ttl_seconds
  OR NEW.entitlement_ttl_seconds IS NOT OLD.entitlement_ttl_seconds
  OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'private_file_policy_identity_immutable');
END;

CREATE TRIGGER product_fulfillment_policies_transition_guard
BEFORE UPDATE ON product_fulfillment_policies
WHEN NOT (
  (OLD.status = 'active' AND NEW.status IN ('active', 'retired'))
  OR (OLD.status = 'retired' AND NEW.status = 'retired')
)
BEGIN
  SELECT RAISE(ABORT, 'private_file_policy_transition_invalid');
END;

CREATE TABLE order_item_fulfillment_requirements (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability = 'private_file'),
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  asset_version_id TEXT NOT NULL,
  max_downloads INTEGER NOT NULL CHECK (max_downloads BETWEEN 1 AND 100),
  grant_ttl_seconds INTEGER NOT NULL CHECK (grant_ttl_seconds BETWEEN 60 AND 86400),
  entitlement_ttl_seconds INTEGER CHECK (
    entitlement_ttl_seconds IS NULL
    OR entitlement_ttl_seconds BETWEEN 300 AND 31536000
  ),
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, order_item_id, capability),
  FOREIGN KEY (shop_id, order_id)
    REFERENCES orders(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, order_item_id)
    REFERENCES order_items(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, policy_id)
    REFERENCES product_fulfillment_policies(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, asset_version_id)
    REFERENCES digital_asset_versions(shop_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_order_item_requirements_shop_order
  ON order_item_fulfillment_requirements(shop_id, order_id, capability, order_item_id, id);

CREATE INDEX idx_order_item_requirements_shop_asset
  ON order_item_fulfillment_requirements(shop_id, asset_version_id, order_id, id);

CREATE TRIGGER order_item_requirements_scope_guard_insert
BEFORE INSERT ON order_item_fulfillment_requirements
WHEN NOT EXISTS (
  SELECT 1
  FROM order_items
  INNER JOIN product_fulfillment_policies
    ON product_fulfillment_policies.id = NEW.policy_id
    AND product_fulfillment_policies.shop_id = order_items.shop_id
    AND product_fulfillment_policies.product_id = order_items.product_id
  WHERE order_items.id = NEW.order_item_id
    AND order_items.shop_id = NEW.shop_id
    AND order_items.order_id = NEW.order_id
    AND order_items.fulfillment_type = 'manual'
    AND product_fulfillment_policies.capability = NEW.capability
    AND product_fulfillment_policies.policy_version = NEW.policy_version
    AND product_fulfillment_policies.asset_version_id = NEW.asset_version_id
    AND product_fulfillment_policies.max_downloads = NEW.max_downloads
    AND product_fulfillment_policies.grant_ttl_seconds = NEW.grant_ttl_seconds
    AND product_fulfillment_policies.entitlement_ttl_seconds IS NEW.entitlement_ttl_seconds
)
BEGIN
  SELECT RAISE(ABORT, 'private_file_requirement_scope_mismatch');
END;

CREATE TRIGGER order_item_requirements_immutable
BEFORE UPDATE ON order_item_fulfillment_requirements
BEGIN
  SELECT RAISE(ABORT, 'private_file_requirement_immutable');
END;

CREATE TRIGGER order_item_requirements_delete_guard
BEFORE DELETE ON order_item_fulfillment_requirements
BEGIN
  SELECT RAISE(ABORT, 'private_file_requirement_immutable');
END;

CREATE TABLE digital_entitlements (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  asset_version_id TEXT NOT NULL,
  buyer_binding_hash TEXT NOT NULL CHECK (
    length(buyer_binding_hash) = 43
    AND buyer_binding_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'expired', 'revoked', 'exhausted')),
  max_downloads INTEGER NOT NULL CHECK (max_downloads BETWEEN 1 AND 100),
  download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0 AND download_count <= max_downloads),
  access_expires_at TEXT,
  revoked_at TEXT,
  exhausted_at TEXT,
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
    REFERENCES order_item_fulfillment_requirements(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, asset_version_id)
    REFERENCES digital_asset_versions(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK ((status = 'exhausted') = (exhausted_at IS NOT NULL)),
  CHECK (status != 'active' OR download_count < max_downloads),
  CHECK (status != 'exhausted' OR download_count = max_downloads)
) STRICT;

CREATE INDEX idx_digital_entitlements_shop_order
  ON digital_entitlements(shop_id, order_id, status, order_item_id, id);

CREATE INDEX idx_digital_entitlements_shop_access
  ON digital_entitlements(shop_id, status, access_expires_at, id);

CREATE TRIGGER digital_entitlements_scope_guard_insert
BEFORE INSERT ON digital_entitlements
WHEN NOT EXISTS (
  SELECT 1
  FROM order_item_fulfillment_requirements
  INNER JOIN orders
    ON orders.id = order_item_fulfillment_requirements.order_id
    AND orders.shop_id = order_item_fulfillment_requirements.shop_id
  WHERE order_item_fulfillment_requirements.id = NEW.requirement_id
    AND order_item_fulfillment_requirements.shop_id = NEW.shop_id
    AND order_item_fulfillment_requirements.order_id = NEW.order_id
    AND order_item_fulfillment_requirements.order_item_id = NEW.order_item_id
    AND order_item_fulfillment_requirements.asset_version_id = NEW.asset_version_id
    AND order_item_fulfillment_requirements.max_downloads = NEW.max_downloads
    AND orders.order_token_hash = NEW.buyer_binding_hash
    AND orders.payment_status = 'paid'
    AND orders.status IN ('processing', 'completed')
    AND NEW.status = 'active'
    AND NEW.download_count = 0
    AND NEW.version = 1
    AND (
      (
        order_item_fulfillment_requirements.entitlement_ttl_seconds IS NULL
        AND NEW.access_expires_at IS NULL
      )
      OR (
        order_item_fulfillment_requirements.entitlement_ttl_seconds IS NOT NULL
        AND unixepoch(NEW.created_at) IS NOT NULL
        AND unixepoch(NEW.access_expires_at) =
          unixepoch(NEW.created_at) + order_item_fulfillment_requirements.entitlement_ttl_seconds
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'private_file_entitlement_scope_mismatch');
END;

CREATE TRIGGER digital_entitlements_identity_immutable
BEFORE UPDATE ON digital_entitlements
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.order_id != OLD.order_id
  OR NEW.order_item_id != OLD.order_item_id
  OR NEW.requirement_id != OLD.requirement_id
  OR NEW.asset_version_id != OLD.asset_version_id
  OR NEW.buyer_binding_hash != OLD.buyer_binding_hash
  OR NEW.max_downloads != OLD.max_downloads
  OR NEW.access_expires_at IS NOT OLD.access_expires_at
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'private_file_entitlement_identity_immutable');
END;

CREATE TRIGGER digital_entitlements_transition_guard
BEFORE UPDATE ON digital_entitlements
WHEN
  NEW.version != OLD.version + 1
  OR NEW.download_count < OLD.download_count
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
  OR (OLD.exhausted_at IS NOT NULL AND NEW.exhausted_at IS NOT OLD.exhausted_at)
  OR NOT (
    (OLD.status = 'active' AND NEW.status IN ('active', 'suspended', 'expired', 'revoked', 'exhausted'))
    OR (OLD.status = 'suspended' AND NEW.status IN ('active', 'expired', 'revoked'))
    OR (OLD.status = 'expired' AND NEW.status = 'expired')
    OR (OLD.status = 'revoked' AND NEW.status = 'revoked')
    OR (OLD.status = 'exhausted' AND NEW.status = 'exhausted')
  )
BEGIN
  SELECT RAISE(ABORT, 'private_file_entitlement_transition_invalid');
END;

CREATE TABLE delivery_grants (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  entitlement_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  asset_version_id TEXT NOT NULL,
  buyer_binding_hash TEXT NOT NULL CHECK (
    length(buyer_binding_hash) = 43
    AND buyer_binding_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  token_nonce TEXT NOT NULL CHECK (
    length(token_nonce) = 43
    AND token_nonce NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  token_hash TEXT NOT NULL CHECK (
    length(token_hash) = 43
    AND token_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  token_key_version TEXT NOT NULL CHECK (token_key_version = 'identifier-hmac-v1'),
  issuance_key_hash TEXT NOT NULL CHECK (
    length(issuance_key_hash) = 43
    AND issuance_key_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 43
    AND request_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, entitlement_id, issuance_key_hash),
  FOREIGN KEY (shop_id, entitlement_id)
    REFERENCES digital_entitlements(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, order_id)
    REFERENCES orders(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, order_item_id)
    REFERENCES order_items(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, asset_version_id)
    REFERENCES digital_asset_versions(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (expires_at > created_at)
) STRICT;

CREATE UNIQUE INDEX idx_delivery_grants_shop_active_entitlement
  ON delivery_grants(shop_id, entitlement_id)
  WHERE status = 'active';

CREATE INDEX idx_delivery_grants_shop_order
  ON delivery_grants(shop_id, order_id, status, expires_at, id);

CREATE INDEX idx_delivery_grants_shop_expiry
  ON delivery_grants(shop_id, status, expires_at, id)
  WHERE status = 'active';

CREATE TRIGGER delivery_grants_scope_guard_insert
BEFORE INSERT ON delivery_grants
WHEN NOT EXISTS (
  SELECT 1
  FROM digital_entitlements
  INNER JOIN order_item_fulfillment_requirements
    ON order_item_fulfillment_requirements.id = digital_entitlements.requirement_id
    AND order_item_fulfillment_requirements.shop_id = digital_entitlements.shop_id
  WHERE digital_entitlements.id = NEW.entitlement_id
    AND digital_entitlements.shop_id = NEW.shop_id
    AND digital_entitlements.order_id = NEW.order_id
    AND digital_entitlements.order_item_id = NEW.order_item_id
    AND digital_entitlements.asset_version_id = NEW.asset_version_id
    AND digital_entitlements.buyer_binding_hash = NEW.buyer_binding_hash
    AND digital_entitlements.status = 'active'
    AND digital_entitlements.download_count < digital_entitlements.max_downloads
    AND NEW.status = 'active'
    AND NEW.version = 1
    AND unixepoch(NEW.created_at) IS NOT NULL
    AND unixepoch(NEW.expires_at) IS NOT NULL
    AND unixepoch(NEW.expires_at) <=
      unixepoch(NEW.created_at) + order_item_fulfillment_requirements.grant_ttl_seconds
    AND (
      digital_entitlements.access_expires_at IS NULL
      OR digital_entitlements.access_expires_at > NEW.created_at
    )
    AND (
      digital_entitlements.access_expires_at IS NULL
      OR NEW.expires_at <= digital_entitlements.access_expires_at
    )
)
BEGIN
  SELECT RAISE(ABORT, 'private_file_grant_scope_mismatch');
END;

CREATE TRIGGER delivery_grants_identity_immutable
BEFORE UPDATE ON delivery_grants
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.entitlement_id != OLD.entitlement_id
  OR NEW.order_id != OLD.order_id
  OR NEW.order_item_id != OLD.order_item_id
  OR NEW.asset_version_id != OLD.asset_version_id
  OR NEW.buyer_binding_hash != OLD.buyer_binding_hash
  OR NEW.token_nonce != OLD.token_nonce
  OR NEW.token_hash != OLD.token_hash
  OR NEW.token_key_version != OLD.token_key_version
  OR NEW.issuance_key_hash != OLD.issuance_key_hash
  OR NEW.request_hash != OLD.request_hash
  OR NEW.expires_at != OLD.expires_at
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'private_file_grant_identity_immutable');
END;

CREATE TRIGGER delivery_grants_transition_guard
BEFORE UPDATE ON delivery_grants
WHEN
  NEW.version != OLD.version + 1
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
  OR NOT (
    (OLD.status = 'active' AND NEW.status IN ('consumed', 'expired', 'revoked'))
    OR (OLD.status = 'consumed' AND NEW.status = 'consumed')
    OR (OLD.status = 'expired' AND NEW.status = 'expired')
    OR (OLD.status = 'revoked' AND NEW.status = 'revoked')
  )
BEGIN
  SELECT RAISE(ABORT, 'private_file_grant_transition_invalid');
END;

CREATE TABLE delivery_grant_consumptions (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  entitlement_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  asset_version_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 160),
  outcome TEXT NOT NULL CHECK (outcome = 'served'),
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, grant_id),
  FOREIGN KEY (shop_id, entitlement_id)
    REFERENCES digital_entitlements(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, grant_id)
    REFERENCES delivery_grants(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, order_id)
    REFERENCES orders(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, asset_version_id)
    REFERENCES digital_asset_versions(shop_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_delivery_grant_consumptions_shop_entitlement
  ON delivery_grant_consumptions(shop_id, entitlement_id, created_at DESC, id);

CREATE INDEX idx_delivery_grant_consumptions_shop_order
  ON delivery_grant_consumptions(shop_id, order_id, created_at DESC, id);

CREATE TRIGGER delivery_grant_consumptions_scope_guard_insert
BEFORE INSERT ON delivery_grant_consumptions
WHEN NOT EXISTS (
  SELECT 1
  FROM delivery_grants
  INNER JOIN digital_entitlements
    ON digital_entitlements.id = delivery_grants.entitlement_id
    AND digital_entitlements.shop_id = delivery_grants.shop_id
  WHERE delivery_grants.id = NEW.grant_id
    AND delivery_grants.shop_id = NEW.shop_id
    AND delivery_grants.entitlement_id = NEW.entitlement_id
    AND delivery_grants.order_id = NEW.order_id
    AND delivery_grants.asset_version_id = NEW.asset_version_id
    AND delivery_grants.status = 'active'
    AND delivery_grants.expires_at > NEW.created_at
    AND digital_entitlements.status = 'active'
    AND digital_entitlements.download_count < digital_entitlements.max_downloads
    AND (
      digital_entitlements.access_expires_at IS NULL
      OR digital_entitlements.access_expires_at > NEW.created_at
    )
)
BEGIN
  SELECT RAISE(ABORT, 'private_file_consumption_scope_mismatch');
END;

CREATE TRIGGER delivery_grant_consumptions_immutable_update
BEFORE UPDATE ON delivery_grant_consumptions
BEGIN
  SELECT RAISE(ABORT, 'private_file_consumption_immutable');
END;

CREATE TRIGGER delivery_grant_consumptions_immutable_delete
BEFORE DELETE ON delivery_grant_consumptions
BEGIN
  SELECT RAISE(ABORT, 'private_file_consumption_immutable');
END;
