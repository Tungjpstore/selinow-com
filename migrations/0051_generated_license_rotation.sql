PRAGMA foreign_keys = ON;

-- Extend the existing resumable rotation control plane without coupling
-- generated-license rows to the PayOS or inventory resource selectors.
CREATE TABLE encryption_rotation_runs_v0051 (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  scope_key TEXT NOT NULL,
  key_family TEXT NOT NULL CHECK (key_family IN (
    'inventory', 'payment_credentials', 'telegram_credentials',
    'telegram_recipient_ids', 'generated_license_credentials',
    'generated_license_artifacts'
  )),
  source_key_version TEXT NOT NULL,
  target_key_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'planned', 'running', 'paused', 'completed', 'failed', 'canceled'
  )),
  dry_run INTEGER NOT NULL DEFAULT 1 CHECK (dry_run IN (0, 1)),
  total_items INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  processed_items INTEGER NOT NULL DEFAULT 0 CHECK (processed_items >= 0),
  failed_items INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  last_safe_error_code TEXT,
  requested_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_key_version <> target_key_version),
  CHECK (processed_items + failed_items <= total_items)
) STRICT;

INSERT INTO encryption_rotation_runs_v0051
SELECT * FROM encryption_rotation_runs;

CREATE TABLE encryption_rotation_items_v0051 (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES encryption_rotation_runs_v0051(id) ON DELETE RESTRICT,
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'inventory_key', 'payment_credential', 'telegram_credential',
    'telegram_recipient', 'generated_license_credential',
    'generated_license_artifact'
  )),
  resource_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'processing', 'completed', 'failed', 'skipped', 'manual_review')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  source_key_version TEXT NOT NULL,
  target_key_version TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_safe_error_code TEXT,
  processed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, resource_type, resource_id),
  CHECK (source_key_version <> target_key_version)
) STRICT;

INSERT INTO encryption_rotation_items_v0051
SELECT * FROM encryption_rotation_items;

DROP TABLE encryption_rotation_items;
DROP TABLE encryption_rotation_runs;

ALTER TABLE encryption_rotation_runs_v0051 RENAME TO encryption_rotation_runs;
ALTER TABLE encryption_rotation_items_v0051 RENAME TO encryption_rotation_items;

CREATE UNIQUE INDEX idx_encryption_rotation_runs_active
  ON encryption_rotation_runs(scope_key, key_family, target_key_version)
  WHERE status IN ('planned', 'running', 'paused');

CREATE INDEX idx_encryption_rotation_runs_shop_status
  ON encryption_rotation_runs(shop_id, status, updated_at DESC, id);

CREATE INDEX idx_encryption_rotation_items_shop_status
  ON encryption_rotation_items(shop_id, status, updated_at, id);

CREATE INDEX idx_encryption_rotation_items_run_status
  ON encryption_rotation_items(run_id, status, updated_at, id);

-- Rotation may rewrite only the encrypted envelope. Fingerprints and all
-- tenant/provider identity fields remain immutable, while deletion can still
-- crypto-shred revoked rows by moving them to destroyed.
DROP TRIGGER generated_license_credentials_identity_guard;

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
      (
        NEW.key_version = OLD.key_version
        AND (
          NEW.endpoint_ciphertext_b64 != OLD.endpoint_ciphertext_b64
          OR NEW.endpoint_iv_b64 != OLD.endpoint_iv_b64
          OR NEW.credential_ciphertext_b64 != OLD.credential_ciphertext_b64
          OR NEW.credential_iv_b64 != OLD.credential_iv_b64
          OR NEW.endpoint_fingerprint != OLD.endpoint_fingerprint
          OR NEW.credential_fingerprint != OLD.credential_fingerprint
        )
      )
      OR (
        NEW.key_version != OLD.key_version
        AND (
          NEW.endpoint_ciphertext_b64 = OLD.endpoint_ciphertext_b64
          OR NEW.endpoint_iv_b64 = OLD.endpoint_iv_b64
          OR NEW.credential_ciphertext_b64 = OLD.credential_ciphertext_b64
          OR NEW.credential_iv_b64 = OLD.credential_iv_b64
          OR NEW.endpoint_fingerprint != OLD.endpoint_fingerprint
          OR NEW.credential_fingerprint != OLD.credential_fingerprint
        )
      )
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
    OR (OLD.status = 'revoked' AND NEW.status IN ('revoked', 'destroyed'))
    OR (OLD.status = 'destroyed' AND NEW.status = 'destroyed')
  )
BEGIN
  SELECT RAISE(ABORT, 'generated_license_credential_identity_immutable');
END;

DROP TRIGGER generated_license_artifacts_transition_guard;

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
      (
        NEW.key_version = OLD.key_version
        AND (
          NEW.ciphertext_b64 != OLD.ciphertext_b64
          OR NEW.iv_b64 != OLD.iv_b64
          OR NEW.artifact_fingerprint != OLD.artifact_fingerprint
        )
      )
      OR (
        NEW.key_version != OLD.key_version
        AND (
          NEW.ciphertext_b64 = OLD.ciphertext_b64
          OR NEW.iv_b64 = OLD.iv_b64
          OR NEW.artifact_fingerprint != OLD.artifact_fingerprint
        )
      )
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
    OR (OLD.status = 'revoked' AND NEW.status IN ('revoked', 'destroyed'))
    OR (OLD.status = 'destroyed' AND NEW.status = 'destroyed')
  )
BEGIN
  SELECT RAISE(ABORT, 'generated_license_artifact_identity_immutable');
END;
