PRAGMA foreign_keys = ON;

-- Generated-license fulfillment is a typed projection of the generic
-- entitlement graph. Provider state never becomes commerce authority.
CREATE TABLE generated_license_provider_connections (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  provider_code TEXT NOT NULL CHECK (
    length(provider_code) BETWEEN 2 AND 64
    AND substr(provider_code, 1, 1) GLOB '[a-z]'
    AND provider_code NOT GLOB '*[^a-z0-9._-]*'
  ),
  provider_environment TEXT NOT NULL CHECK (provider_environment IN ('sandbox', 'live')),
  descriptor_version INTEGER NOT NULL DEFAULT 1 CHECK (descriptor_version = 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'degraded', 'disabled', 'retired')),
  external_account_fingerprint TEXT CHECK (
    external_account_fingerprint IS NULL
    OR length(external_account_fingerprint) = 43
  ),
  last_health_at TEXT,
  last_safe_error_code TEXT,
  created_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE (shop_id, id),
  CHECK ((status = 'retired') = (retired_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_generated_license_connections_shop_provider
  ON generated_license_provider_connections(
    shop_id, provider_code, provider_environment, status, updated_at DESC, id
  );

CREATE INDEX idx_generated_license_connections_shop_status
  ON generated_license_provider_connections(shop_id, status, updated_at DESC, id);

CREATE TRIGGER generated_license_connections_insert_guard
BEFORE INSERT ON generated_license_provider_connections
WHEN NOT EXISTS (
  SELECT 1 FROM shops
  WHERE shops.id = NEW.shop_id AND shops.status IN ('draft', 'active')
)
BEGIN
  SELECT RAISE(ABORT, 'generated_license_connection_shop_ineligible');
END;

CREATE TRIGGER generated_license_connections_identity_guard
BEFORE UPDATE ON generated_license_provider_connections
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.provider_code != OLD.provider_code
  OR NEW.provider_environment != OLD.provider_environment
  OR NEW.descriptor_version != OLD.descriptor_version
  OR NEW.external_account_fingerprint IS NOT OLD.external_account_fingerprint
  OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR NOT (
    (OLD.status IN ('active', 'degraded', 'disabled') AND NEW.status IN ('active', 'degraded', 'disabled', 'retired'))
    OR (OLD.status = 'retired' AND NEW.status = 'retired')
  )
BEGIN
  SELECT RAISE(ABORT, 'generated_license_connection_identity_immutable');
END;

CREATE TRIGGER generated_license_connections_delete_guard
BEFORE DELETE ON generated_license_provider_connections
BEGIN
  SELECT RAISE(ABORT, 'generated_license_connection_immutable');
END;

CREATE TABLE generated_license_provider_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  connection_id TEXT NOT NULL,
  provider_code TEXT NOT NULL,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'grace', 'revoked', 'destroyed')),
  key_version TEXT NOT NULL CHECK (key_version = 'destroyed' OR key_version GLOB 'v[1-9]*'),
  endpoint_ciphertext_b64 TEXT NOT NULL CHECK (length(endpoint_ciphertext_b64) > 0),
  endpoint_iv_b64 TEXT NOT NULL CHECK (length(endpoint_iv_b64) > 0),
  credential_ciphertext_b64 TEXT NOT NULL CHECK (length(credential_ciphertext_b64) > 0),
  credential_iv_b64 TEXT NOT NULL CHECK (length(credential_iv_b64) > 0),
  endpoint_fingerprint TEXT NOT NULL CHECK (length(endpoint_fingerprint) = 43 OR endpoint_fingerprint = 'destroyed'),
  credential_fingerprint TEXT NOT NULL CHECK (length(credential_fingerprint) = 43 OR credential_fingerprint = 'destroyed'),
  created_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  activated_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, connection_id, credential_version),
  FOREIGN KEY (shop_id, connection_id)
    REFERENCES generated_license_provider_connections(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status IN ('active', 'grace')) = (activated_at IS NOT NULL AND revoked_at IS NULL)),
  CHECK ((status IN ('revoked', 'destroyed')) = (revoked_at IS NOT NULL)),
  CHECK ((status = 'destroyed') = (key_version = 'destroyed'))
) STRICT;

CREATE UNIQUE INDEX idx_generated_license_credentials_active
  ON generated_license_provider_credentials(shop_id, connection_id)
  WHERE status = 'active';

CREATE INDEX idx_generated_license_credentials_shop_status
  ON generated_license_provider_credentials(shop_id, status, updated_at DESC, id);

CREATE TRIGGER generated_license_credentials_scope_guard
BEFORE INSERT ON generated_license_provider_credentials
WHEN NOT EXISTS (
  SELECT 1 FROM generated_license_provider_connections AS connection
  WHERE connection.id = NEW.connection_id
    AND connection.shop_id = NEW.shop_id
    AND connection.provider_code = NEW.provider_code
    AND connection.status IN ('active', 'degraded')
)
BEGIN
  SELECT RAISE(ABORT, 'generated_license_credential_scope_mismatch');
END;

CREATE TRIGGER generated_license_credentials_identity_guard
BEFORE UPDATE ON generated_license_provider_credentials
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.connection_id != OLD.connection_id
  OR NEW.provider_code != OLD.provider_code
  OR NEW.credential_version != OLD.credential_version
  OR (
    NEW.status != 'destroyed'
    AND (
      NEW.key_version != OLD.key_version
      OR NEW.endpoint_ciphertext_b64 != OLD.endpoint_ciphertext_b64
      OR NEW.endpoint_iv_b64 != OLD.endpoint_iv_b64
      OR NEW.credential_ciphertext_b64 != OLD.credential_ciphertext_b64
      OR NEW.credential_iv_b64 != OLD.credential_iv_b64
      OR NEW.endpoint_fingerprint != OLD.endpoint_fingerprint
      OR NEW.credential_fingerprint != OLD.credential_fingerprint
    )
  )
  OR (
    NEW.status = 'destroyed'
    AND (
      NEW.key_version != 'destroyed'
      OR NEW.endpoint_ciphertext_b64 != 'destroyed'
      OR NEW.endpoint_iv_b64 != 'destroyed'
      OR NEW.credential_ciphertext_b64 != 'destroyed'
      OR NEW.credential_iv_b64 != 'destroyed'
      OR NEW.endpoint_fingerprint != 'destroyed'
      OR NEW.credential_fingerprint != 'destroyed'
    )
  )
  OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR NOT (
    (OLD.status IN ('active', 'grace') AND NEW.status IN ('active', 'grace', 'revoked', 'destroyed'))
    OR (OLD.status IN ('revoked', 'destroyed') AND NEW.status IN ('revoked', 'destroyed'))
  )
BEGIN
  SELECT RAISE(ABORT, 'generated_license_credential_identity_immutable');
END;

CREATE TRIGGER generated_license_credentials_delete_guard
BEFORE DELETE ON generated_license_provider_credentials
BEGIN
  SELECT RAISE(ABORT, 'generated_license_credential_immutable');
END;

-- A resource binding is the only mutable seller configuration captured by a
-- checkout. Later provider credential rotation cannot reinterpret old orders.
CREATE TABLE generated_license_resource_bindings (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  resource_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_code TEXT NOT NULL,
  generation_template_version INTEGER NOT NULL DEFAULT 1 CHECK (generation_template_version = 1),
  request_shape_hash TEXT NOT NULL CHECK (length(request_shape_hash) = 43),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, resource_id)
    REFERENCES entitlement_resources(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, connection_id)
    REFERENCES generated_license_provider_connections(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'retired') = (retired_at IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX idx_generated_license_bindings_shop_active
  ON generated_license_resource_bindings(shop_id, resource_id)
  WHERE status = 'active';

CREATE INDEX idx_generated_license_bindings_shop_connection
  ON generated_license_resource_bindings(shop_id, connection_id, status, updated_at DESC, id);

CREATE TRIGGER generated_license_bindings_scope_guard
BEFORE INSERT ON generated_license_resource_bindings
WHEN NOT EXISTS (
  SELECT 1
  FROM entitlement_resources AS resource
  INNER JOIN generated_license_provider_connections AS connection
    ON connection.id = NEW.connection_id AND connection.shop_id = NEW.shop_id
  WHERE resource.id = NEW.resource_id
    AND resource.shop_id = NEW.shop_id
    AND resource.resource_type = 'generated_license'
    AND resource.status = 'active'
    AND connection.provider_code = NEW.provider_code
    AND connection.status IN ('active', 'degraded')
)
BEGIN
  SELECT RAISE(ABORT, 'generated_license_binding_scope_mismatch');
END;

CREATE TRIGGER generated_license_bindings_identity_guard
BEFORE UPDATE ON generated_license_resource_bindings
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.resource_id != OLD.resource_id
  OR NEW.connection_id != OLD.connection_id
  OR NEW.provider_code != OLD.provider_code
  OR NEW.generation_template_version != OLD.generation_template_version
  OR NEW.request_shape_hash != OLD.request_shape_hash
  OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR NOT (
    (OLD.status = 'active' AND NEW.status IN ('active', 'retired'))
    OR (OLD.status = 'retired' AND NEW.status = 'retired')
  )
BEGIN
  SELECT RAISE(ABORT, 'generated_license_binding_identity_immutable');
END;

CREATE TRIGGER generated_license_bindings_delete_guard
BEFORE DELETE ON generated_license_resource_bindings
BEGIN
  SELECT RAISE(ABORT, 'generated_license_binding_immutable');
END;

-- A generated-license entitlement cannot be materialized without one exact
-- executable binding. Bounded v1 supports one artifact per entitlement.
CREATE TRIGGER entitlements_generated_license_binding_guard
BEFORE INSERT ON entitlements
WHEN EXISTS (
  SELECT 1 FROM entitlement_resources AS resource
  WHERE resource.id = NEW.resource_id
    AND resource.shop_id = NEW.shop_id
    AND resource.resource_type = 'generated_license'
)
AND NOT EXISTS (
  SELECT 1
  FROM generated_license_resource_bindings AS binding
  INNER JOIN generated_license_provider_connections AS connection
    ON connection.id = binding.connection_id
    AND connection.shop_id = binding.shop_id
  INNER JOIN generated_license_provider_credentials AS credential
    ON credential.connection_id = connection.id
    AND credential.shop_id = connection.shop_id
    AND credential.provider_code = connection.provider_code
  WHERE binding.resource_id = NEW.resource_id
    AND binding.shop_id = NEW.shop_id
    AND binding.status = 'active'
    AND connection.status IN ('active', 'degraded')
    AND credential.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'generated_license_binding_unavailable');
END;

CREATE TRIGGER entitlements_generated_license_quantity_guard
BEFORE INSERT ON entitlements
WHEN NEW.grant_quantity != 1
  AND EXISTS (
    SELECT 1 FROM entitlement_resources AS resource
    WHERE resource.id = NEW.resource_id
      AND resource.shop_id = NEW.shop_id
      AND resource.resource_type = 'generated_license'
  )
BEGIN
  SELECT RAISE(ABORT, 'generated_license_quantity_unsupported');
END;

CREATE TABLE generated_license_requirement_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  entitlement_requirement_id TEXT NOT NULL,
  entitlement_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_code TEXT NOT NULL,
  generation_template_version INTEGER NOT NULL CHECK (generation_template_version = 1),
  request_shape_hash TEXT NOT NULL CHECK (length(request_shape_hash) = 43),
  requested_quantity INTEGER NOT NULL CHECK (requested_quantity = 1),
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, entitlement_requirement_id),
  UNIQUE (shop_id, entitlement_id),
  FOREIGN KEY (shop_id, entitlement_requirement_id)
    REFERENCES order_item_entitlement_requirements(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, entitlement_id)
    REFERENCES entitlements(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, order_id)
    REFERENCES orders(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, order_item_id)
    REFERENCES order_items(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, resource_id)
    REFERENCES entitlement_resources(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, binding_id)
    REFERENCES generated_license_resource_bindings(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, connection_id)
    REFERENCES generated_license_provider_connections(shop_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_generated_license_requirements_shop_order
  ON generated_license_requirement_snapshots(shop_id, order_id, created_at DESC, id);

CREATE TRIGGER generated_license_requirements_scope_guard
BEFORE INSERT ON generated_license_requirement_snapshots
WHEN NOT EXISTS (
  SELECT 1
  FROM order_item_entitlement_requirements AS requirement
  INNER JOIN entitlements AS entitlement
    ON entitlement.id = NEW.entitlement_id AND entitlement.shop_id = NEW.shop_id
  INNER JOIN generated_license_resource_bindings AS binding
    ON binding.id = NEW.binding_id AND binding.shop_id = NEW.shop_id
  INNER JOIN generated_license_provider_connections AS connection
    ON connection.id = NEW.connection_id AND connection.shop_id = NEW.shop_id
  WHERE requirement.id = NEW.entitlement_requirement_id
    AND requirement.shop_id = NEW.shop_id
    AND requirement.order_id = NEW.order_id
    AND requirement.order_item_id = NEW.order_item_id
    AND requirement.resource_id = NEW.resource_id
    AND requirement.grant_quantity = 1
    AND entitlement.requirement_id = requirement.id
    AND entitlement.order_id = requirement.order_id
    AND entitlement.order_item_id = requirement.order_item_id
    AND entitlement.resource_id = requirement.resource_id
    AND entitlement.status IN ('pending', 'active')
    AND binding.resource_id = requirement.resource_id
    AND binding.status = 'active'
    AND binding.connection_id = connection.id
    AND binding.provider_code = NEW.provider_code
    AND connection.provider_code = NEW.provider_code
    AND connection.status IN ('active', 'degraded')
    AND binding.generation_template_version = NEW.generation_template_version
    AND binding.request_shape_hash = NEW.request_shape_hash
)
BEGIN
  SELECT RAISE(ABORT, 'generated_license_requirement_scope_mismatch');
END;

CREATE TRIGGER generated_license_requirements_immutable_update
BEFORE UPDATE ON generated_license_requirement_snapshots
BEGIN
  SELECT RAISE(ABORT, 'generated_license_requirement_immutable');
END;

CREATE TRIGGER generated_license_requirements_immutable_delete
BEFORE DELETE ON generated_license_requirement_snapshots
BEGIN
  SELECT RAISE(ABORT, 'generated_license_requirement_immutable');
END;

CREATE TABLE generated_license_requests (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  requirement_snapshot_id TEXT NOT NULL,
  entitlement_id TEXT NOT NULL,
  entitlement_grant_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_code TEXT NOT NULL,
  unit_ordinal INTEGER NOT NULL CHECK (unit_ordinal = 1),
  provider_idempotency_key_hash TEXT NOT NULL CHECK (length(provider_idempotency_key_hash) = 43),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 43),
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'retryable', 'reconcile_pending', 'succeeded', 'failed', 'manual_review', 'canceled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_safe_error_code TEXT,
  provider_reference_hash TEXT CHECK (provider_reference_hash IS NULL OR length(provider_reference_hash) = 43),
  evidence_hash TEXT CHECK (evidence_hash IS NULL OR length(evidence_hash) = 43),
  succeeded_at TEXT,
  canceled_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, requirement_snapshot_id, unit_ordinal),
  UNIQUE (shop_id, provider_idempotency_key_hash),
  FOREIGN KEY (shop_id, requirement_snapshot_id)
    REFERENCES generated_license_requirement_snapshots(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, entitlement_id)
    REFERENCES entitlements(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, entitlement_grant_id)
    REFERENCES entitlement_grants(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, order_id)
    REFERENCES orders(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, resource_id)
    REFERENCES entitlement_resources(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, connection_id)
    REFERENCES generated_license_provider_connections(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'processing') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'succeeded') = (succeeded_at IS NOT NULL)),
  CHECK ((status = 'canceled') = (canceled_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_generated_license_requests_shop_due
  ON generated_license_requests(shop_id, status, next_attempt_at, id)
  WHERE status IN ('pending', 'retryable', 'reconcile_pending');

CREATE INDEX idx_generated_license_requests_shop_entitlement
  ON generated_license_requests(shop_id, entitlement_id, status, id);

CREATE TRIGGER generated_license_requests_scope_guard
BEFORE INSERT ON generated_license_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM generated_license_requirement_snapshots AS snapshot
  INNER JOIN entitlements AS entitlement
    ON entitlement.id = snapshot.entitlement_id AND entitlement.shop_id = snapshot.shop_id
  INNER JOIN entitlement_grants AS grant_row
    ON grant_row.id = NEW.entitlement_grant_id AND grant_row.shop_id = NEW.shop_id
  INNER JOIN generated_license_provider_connections AS connection
    ON connection.id = snapshot.connection_id AND connection.shop_id = snapshot.shop_id
  INNER JOIN generated_license_provider_credentials AS credential
    ON credential.connection_id = snapshot.connection_id
    AND credential.shop_id = snapshot.shop_id
    AND credential.provider_code = snapshot.provider_code
  WHERE snapshot.id = NEW.requirement_snapshot_id
    AND snapshot.shop_id = NEW.shop_id
    AND snapshot.entitlement_id = NEW.entitlement_id
    AND snapshot.order_id = NEW.order_id
    AND snapshot.resource_id = NEW.resource_id
    AND snapshot.connection_id = NEW.connection_id
    AND snapshot.provider_code = NEW.provider_code
    AND entitlement.status = 'active'
    AND entitlement.grant_quantity = 1
    AND grant_row.entitlement_id = entitlement.id
    AND grant_row.requirement_id = entitlement.requirement_id
    AND grant_row.order_id = entitlement.order_id
    AND grant_row.resource_id = entitlement.resource_id
    AND grant_row.granted_quantity = 1
    AND connection.provider_code = NEW.provider_code
    AND connection.status IN ('active', 'degraded')
    AND credential.credential_version = NEW.credential_version
    AND credential.status IN ('active', 'grace')
    AND NEW.unit_ordinal = 1
)
BEGIN
  SELECT RAISE(ABORT, 'generated_license_request_scope_mismatch');
END;

CREATE TRIGGER generated_license_requests_transition_guard
BEFORE UPDATE ON generated_license_requests
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.requirement_snapshot_id != OLD.requirement_snapshot_id
  OR NEW.entitlement_id != OLD.entitlement_id
  OR NEW.entitlement_grant_id != OLD.entitlement_grant_id
  OR NEW.order_id != OLD.order_id
  OR NEW.resource_id != OLD.resource_id
  OR NEW.connection_id != OLD.connection_id
  OR NEW.provider_code != OLD.provider_code
  OR NEW.unit_ordinal != OLD.unit_ordinal
  OR NEW.provider_idempotency_key_hash != OLD.provider_idempotency_key_hash
  OR NEW.request_hash != OLD.request_hash
  OR NEW.credential_version != OLD.credential_version
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'generated_license_request_identity_immutable');
END;

CREATE TABLE generated_license_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('generate', 'reconcile', 'revoke')),
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 43),
  provider_reference_hash TEXT,
  evidence_hash TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'retryable', 'rejected', 'ambiguous', 'manual_review')),
  safe_error_code TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, request_id, attempt_no),
  FOREIGN KEY (shop_id, request_id)
    REFERENCES generated_license_requests(shop_id, id) ON DELETE RESTRICT,
  CHECK (provider_reference_hash IS NULL OR length(provider_reference_hash) = 43),
  CHECK (evidence_hash IS NULL OR length(evidence_hash) = 43)
) STRICT;

CREATE INDEX idx_generated_license_attempts_shop_request
  ON generated_license_attempts(shop_id, request_id, attempt_no DESC, id);

CREATE TRIGGER generated_license_attempts_scope_guard
BEFORE INSERT ON generated_license_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM generated_license_requests AS request
  WHERE request.id = NEW.request_id
    AND request.shop_id = NEW.shop_id
    AND request.request_hash = NEW.request_hash
    AND request.credential_version = NEW.credential_version
    AND NEW.attempt_no = request.attempt_count
)
BEGIN
  SELECT RAISE(ABORT, 'generated_license_attempt_scope_mismatch');
END;

CREATE TRIGGER generated_license_attempts_immutable_update
BEFORE UPDATE ON generated_license_attempts
BEGIN
  SELECT RAISE(ABORT, 'generated_license_attempt_immutable');
END;

CREATE TRIGGER generated_license_attempts_immutable_delete
BEFORE DELETE ON generated_license_attempts
BEGIN
  SELECT RAISE(ABORT, 'generated_license_attempt_immutable');
END;

CREATE TABLE generated_license_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  entitlement_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal = 1),
  ciphertext_b64 TEXT NOT NULL CHECK (length(ciphertext_b64) > 0),
  iv_b64 TEXT NOT NULL CHECK (length(iv_b64) > 0),
  key_version TEXT NOT NULL CHECK (key_version = 'destroyed' OR key_version GLOB 'v[1-9]*'),
  artifact_fingerprint TEXT NOT NULL CHECK (length(artifact_fingerprint) = 43 OR artifact_fingerprint = 'destroyed'),
  format TEXT NOT NULL CHECK (format IN ('text', 'json')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'destroyed')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, request_id, ordinal),
  FOREIGN KEY (shop_id, request_id)
    REFERENCES generated_license_requests(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, entitlement_id)
    REFERENCES entitlements(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'active') = (revoked_at IS NULL)),
  CHECK ((status IN ('revoked', 'destroyed')) = (revoked_at IS NOT NULL)),
  CHECK ((status = 'destroyed') = (key_version = 'destroyed'))
) STRICT;

CREATE INDEX idx_generated_license_artifacts_shop_entitlement
  ON generated_license_artifacts(shop_id, entitlement_id, status, id);

CREATE TRIGGER generated_license_artifacts_scope_guard
BEFORE INSERT ON generated_license_artifacts
WHEN NOT EXISTS (
  SELECT 1 FROM generated_license_requests AS request
  INNER JOIN entitlements AS entitlement
    ON entitlement.id = request.entitlement_id AND entitlement.shop_id = request.shop_id
  WHERE request.id = NEW.request_id
    AND request.shop_id = NEW.shop_id
    AND request.entitlement_id = NEW.entitlement_id
    AND request.status = 'succeeded'
    AND entitlement.status = 'active'
    AND NEW.ordinal = 1
)
BEGIN
  SELECT RAISE(ABORT, 'generated_license_artifact_scope_mismatch');
END;

CREATE TRIGGER generated_license_artifacts_transition_guard
BEFORE UPDATE ON generated_license_artifacts
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.request_id != OLD.request_id
  OR NEW.entitlement_id != OLD.entitlement_id
  OR NEW.ordinal != OLD.ordinal
  OR (
    NEW.status != 'destroyed'
    AND (
      NEW.ciphertext_b64 != OLD.ciphertext_b64
      OR NEW.iv_b64 != OLD.iv_b64
      OR NEW.key_version != OLD.key_version
      OR NEW.artifact_fingerprint != OLD.artifact_fingerprint
    )
  )
  OR (
    NEW.status = 'destroyed'
    AND (
      NEW.ciphertext_b64 != 'destroyed'
      OR NEW.iv_b64 != 'destroyed'
      OR NEW.key_version != 'destroyed'
      OR NEW.artifact_fingerprint != 'destroyed'
    )
  )
  OR NEW.format != OLD.format
  OR NEW.created_at != OLD.created_at
  OR NOT (
    (OLD.status = 'active' AND NEW.status IN ('active', 'revoked', 'destroyed'))
    OR (OLD.status IN ('revoked', 'destroyed') AND NEW.status = OLD.status)
  )
BEGIN
  SELECT RAISE(ABORT, 'generated_license_artifact_identity_immutable');
END;

CREATE TRIGGER generated_license_artifacts_delete_guard
BEFORE DELETE ON generated_license_artifacts
BEGIN
  SELECT RAISE(ABORT, 'generated_license_artifact_immutable');
END;

-- This ledger is intentionally separate from the channel/DLQ tables. It is
-- the operator remediation anchor for generated-license requests.
CREATE TABLE generated_license_dead_letters (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  failure_code TEXT NOT NULL,
  safe_context_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(safe_context_json) AND json_type(safe_context_json) = 'object'
  ),
  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'retry_requested', 'resolved')),
  provider_attempts INTEGER NOT NULL DEFAULT 0 CHECK (provider_attempts >= 0),
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  resolution_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, request_id),
  FOREIGN KEY (shop_id, request_id)
    REFERENCES generated_license_requests(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK (status != 'resolved' OR resolution_code IS NOT NULL)
) STRICT;

CREATE INDEX idx_generated_license_dead_letters_shop_status
  ON generated_license_dead_letters(shop_id, status, updated_at DESC, id);
