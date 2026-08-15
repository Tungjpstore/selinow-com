PRAGMA foreign_keys = ON;

-- Provider verification is evidence, not activation. The ledger stores only
-- hashes, lifecycle metadata and reviewed safe fields; payloads, tokens and
-- provider credentials never enter this table.
CREATE TABLE channel_provider_verification_evidence (
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
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  credential_fingerprint TEXT NOT NULL CHECK (
    length(credential_fingerprint) = 43
    AND credential_fingerprint NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  verification_kind TEXT NOT NULL CHECK (verification_kind IN (
    'webhook', 'identity', 'capability', 'outbound_acceptance'
  )),
  evidence_reference TEXT NOT NULL CHECK (
    length(evidence_reference) = 43
    AND evidence_reference NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  provider_identity_fingerprint TEXT CHECK (
    provider_identity_fingerprint IS NULL OR (
      length(provider_identity_fingerprint) = 43
      AND provider_identity_fingerprint NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  safe_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    length(safe_metadata_json) <= 4096
    AND json_valid(safe_metadata_json)
    AND json_type(safe_metadata_json) = 'object'
  ),
  status TEXT NOT NULL CHECK (status IN ('observed', 'reviewed', 'rejected')),
  verified_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reviewed_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (shop_id, connection_id, provider_code, verification_kind, evidence_reference),
  FOREIGN KEY (shop_id, connection_id)
    REFERENCES channel_connections(shop_id, id) ON DELETE CASCADE,
  CHECK (expires_at > verified_at),
  CHECK ((status = 'observed' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
    OR (status IN ('reviewed', 'rejected') AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_channel_provider_verification_shop_status
  ON channel_provider_verification_evidence(shop_id, status, expires_at, id);

CREATE INDEX idx_channel_provider_verification_connection
  ON channel_provider_verification_evidence(shop_id, connection_id, provider_code, status, expires_at, id);

CREATE INDEX idx_channel_provider_verification_expiry
  ON channel_provider_verification_evidence(status, expires_at, shop_id, id);

-- Evidence can be collected while a connection is pending, but it must still
-- belong to the same tenant/provider and an enabled channel before insertion.
CREATE TRIGGER channel_provider_verification_scope_insert_guard
BEFORE INSERT ON channel_provider_verification_evidence
WHEN NOT EXISTS (
  SELECT 1
  FROM channel_connections AS connection
  INNER JOIN shop_channels AS channel
    ON channel.shop_id = connection.shop_id
    AND channel.id = connection.shop_channel_id
    AND channel.channel_code = NEW.provider_code
    AND channel.status = 'enabled'
  WHERE connection.shop_id = NEW.shop_id
    AND connection.id = NEW.connection_id
    AND connection.provider_code = NEW.provider_code
    AND connection.status IN ('pending', 'active', 'degraded')
)
BEGIN
  SELECT RAISE(ABORT, 'channel_provider_verification_scope_mismatch');
END;

CREATE TRIGGER channel_provider_verification_identity_immutable
BEFORE UPDATE ON channel_provider_verification_evidence
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.connection_id != OLD.connection_id
  OR NEW.provider_code != OLD.provider_code
  OR NEW.credential_version != OLD.credential_version
  OR NEW.credential_fingerprint != OLD.credential_fingerprint
  OR NEW.verification_kind != OLD.verification_kind
  OR NEW.evidence_reference != OLD.evidence_reference
  OR NEW.provider_identity_fingerprint IS NOT OLD.provider_identity_fingerprint
  OR NEW.safe_metadata_json != OLD.safe_metadata_json
  OR NEW.verified_at != OLD.verified_at
  OR NEW.expires_at != OLD.expires_at
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR OLD.status IN ('reviewed', 'rejected')
  OR NOT (OLD.status = 'observed' AND NEW.status IN ('observed', 'reviewed', 'rejected'))
BEGIN
  SELECT RAISE(ABORT, 'channel_provider_verification_identity_immutable');
END;

CREATE TRIGGER channel_provider_verification_reviewer_scope_guard
BEFORE UPDATE OF reviewed_by_user_id ON channel_provider_verification_evidence
WHEN NEW.reviewed_by_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM shop_members
    WHERE shop_members.shop_id = NEW.shop_id
      AND shop_members.user_id = NEW.reviewed_by_user_id
      AND shop_members.status = 'active'
      AND shop_members.role IN ('owner', 'manager')
  )
BEGIN
  SELECT RAISE(ABORT, 'channel_provider_verification_reviewer_scope_mismatch');
END;

CREATE TRIGGER channel_provider_verification_status_timestamp_guard
BEFORE INSERT ON channel_provider_verification_evidence
WHEN (NEW.status = 'observed' AND (NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL))
  OR (NEW.status IN ('reviewed', 'rejected') AND (NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_at IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'channel_provider_verification_status_timestamp_invalid');
END;

CREATE TRIGGER channel_provider_verification_status_timestamp_update_guard
BEFORE UPDATE OF status, reviewed_by_user_id, reviewed_at ON channel_provider_verification_evidence
WHEN (NEW.status = 'observed' AND (NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL))
  OR (NEW.status IN ('reviewed', 'rejected') AND (NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_at IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'channel_provider_verification_status_timestamp_invalid');
END;

CREATE TRIGGER channel_provider_verification_immutable_delete
BEFORE DELETE ON channel_provider_verification_evidence
BEGIN
  SELECT RAISE(ABORT, 'channel_provider_verification_immutable');
END;
