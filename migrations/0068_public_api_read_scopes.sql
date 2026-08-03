PRAGMA foreign_keys = ON;

-- Extend the public API grant allowlist without editing the applied 0040 table.
-- Credential identity and lifecycle guards remain unchanged; only the
-- immutable scope CHECK is widened for the two read-only projections.
CREATE TABLE api_credentials_v0068 (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  public_id TEXT NOT NULL UNIQUE CHECK (
    length(public_id) BETWEEN 8 AND 96
    AND substr(public_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND public_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  scope_json TEXT NOT NULL CHECK (
    json_valid(scope_json)
    AND json_type(scope_json) = 'array'
    AND scope_json IN (
      '["catalog:read"]',
      '["inventory:read"]',
      '["orders:read"]',
      '["shop:read"]',
      '["catalog:read","inventory:read"]',
      '["catalog:read","orders:read"]',
      '["catalog:read","shop:read"]',
      '["inventory:read","orders:read"]',
      '["inventory:read","shop:read"]',
      '["orders:read","shop:read"]',
      '["catalog:read","inventory:read","orders:read"]',
      '["catalog:read","inventory:read","shop:read"]',
      '["catalog:read","orders:read","shop:read"]',
      '["inventory:read","orders:read","shop:read"]',
      '["catalog:read","inventory:read","orders:read","shop:read"]'
    )
    AND length(scope_json) BETWEEN 2 AND 512
  ),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) BETWEEN 43 AND 128
    AND token_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  expires_at TEXT CHECK (expires_at IS NULL OR expires_at > created_at),
  last_used_at TEXT,
  revoked_at TEXT,
  revocation_request_hash TEXT CHECK (
    revocation_request_hash IS NULL OR (
      length(revocation_request_hash) BETWEEN 43 AND 128
      AND revocation_request_hash NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  revoke_reason TEXT CHECK (
    revoke_reason IS NULL OR (
      length(revoke_reason) BETWEEN 3 AND 96
      AND substr(revoke_reason, 1, 1) GLOB '[a-z]'
      AND revoke_reason NOT GLOB '*[^a-z0-9._:-]*'
    )
  ),
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revocation_request_hash IS NULL AND revoke_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revocation_request_hash IS NOT NULL AND revoke_reason IS NOT NULL)
  ),
  CHECK (status = 'active' OR last_used_at IS NULL OR last_used_at <= updated_at)
) STRICT;

INSERT INTO api_credentials_v0068 (
  id, public_id, shop_id, name, scope_json, token_hash, status,
  expires_at, last_used_at, revoked_at, revocation_request_hash,
  revoke_reason, created_by_user_id, version, created_at, updated_at
)
SELECT
  id, public_id, shop_id, name, scope_json, token_hash, status,
  expires_at, last_used_at, revoked_at, revocation_request_hash,
  revoke_reason, created_by_user_id, version, created_at, updated_at
FROM api_credentials;

DROP TRIGGER api_credentials_require_active_member_insert;
DROP TRIGGER api_credentials_active_limit_insert;
DROP TRIGGER api_credentials_identity_immutable;
DROP TRIGGER api_credentials_transition_guard;
DROP TRIGGER api_credentials_no_delete;
DROP TABLE api_credentials;
ALTER TABLE api_credentials_v0068 RENAME TO api_credentials;

CREATE INDEX idx_api_credentials_shop_status
  ON api_credentials(shop_id, status, updated_at DESC, id);

CREATE INDEX idx_api_credentials_shop_expires
  ON api_credentials(shop_id, status, expires_at, id)
  WHERE status = 'active' AND expires_at IS NOT NULL;

CREATE TRIGGER api_credentials_require_active_member_insert
BEFORE INSERT ON api_credentials
WHEN NOT EXISTS (
  SELECT 1 FROM shop_members
  WHERE shop_id = NEW.shop_id
    AND user_id = NEW.created_by_user_id
    AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'api_credential_actor_not_tenant_member');
END;
CREATE TRIGGER api_credentials_active_limit_insert
BEFORE INSERT ON api_credentials
WHEN NEW.status = 'active' AND (
  SELECT COUNT(*) FROM api_credentials
  WHERE shop_id = NEW.shop_id AND status = 'active'
    AND (expires_at IS NULL OR expires_at > NEW.created_at)
) >= 10
BEGIN
  SELECT RAISE(ABORT, 'api_credential_active_limit_reached');
END;

CREATE TRIGGER api_credentials_identity_immutable
BEFORE UPDATE ON api_credentials
WHEN
  NEW.id != OLD.id
  OR NEW.public_id != OLD.public_id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.name != OLD.name
  OR NEW.scope_json != OLD.scope_json
  OR NEW.token_hash != OLD.token_hash
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_by_user_id != OLD.created_by_user_id
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'api_credential_identity_immutable');
END;

CREATE TRIGGER api_credentials_transition_guard
BEFORE UPDATE ON api_credentials
WHEN NOT (
  (
    OLD.status = 'active'
    AND NEW.status = 'active'
    AND NEW.version = OLD.version
    AND NEW.revoked_at IS OLD.revoked_at
    AND NEW.revocation_request_hash IS OLD.revocation_request_hash
    AND NEW.revoke_reason IS OLD.revoke_reason
  )
  OR (
    OLD.status = 'active'
    AND NEW.status = 'revoked'
    AND NEW.version = OLD.version + 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'api_credential_transition_invalid');
END;

CREATE TRIGGER api_credentials_no_delete
BEFORE DELETE ON api_credentials
BEGIN
  SELECT RAISE(ABORT, 'api_credential_immutable');
END;
