PRAGMA foreign_keys = ON;

-- Connector requests are the durable, tenant-bound handoff between seller
-- intent and a reviewed provider implementation. A request never implies
-- that a provider account, webhook or outbound capability is active.
CREATE TABLE channel_connector_requests (
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
  channel_code TEXT NOT NULL CHECK (
    length(channel_code) BETWEEN 3 AND 64
    AND substr(channel_code, 1, 1) GLOB '[a-z]'
    AND channel_code NOT GLOB '*[^a-z0-9._:-]*'
  ),
  provider_code TEXT NOT NULL CHECK (
    length(provider_code) BETWEEN 3 AND 64
    AND substr(provider_code, 1, 1) GLOB '[a-z]'
    AND provider_code NOT GLOB '*[^a-z0-9._:-]*'
  ),
  requested_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN (
    'requested', 'provider_pending', 'active', 'rejected', 'canceled'
  )),
  request_kind TEXT NOT NULL DEFAULT 'connect' CHECK (request_kind = 'connect'),
  failure_code TEXT,
  provider_reference_hash TEXT,
  reviewed_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  idempotency_key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, idempotency_key_hash),
  CHECK (status NOT IN ('rejected') OR (failure_code IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (status NOT IN ('provider_pending', 'active') OR (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (status != 'active' OR provider_reference_hash IS NOT NULL),
  -- Seller cancellation is a terminal self-service transition and does not
  -- require an internal reviewer. Provider decisions still do.
  CHECK (status IN ('requested', 'canceled') OR reviewed_by_user_id IS NOT NULL),
  CHECK (status NOT IN ('requested') OR (reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND failure_code IS NULL AND provider_reference_hash IS NULL))
) STRICT;

CREATE UNIQUE INDEX idx_channel_connector_requests_active
  ON channel_connector_requests(shop_id, provider_code)
  WHERE status IN ('requested', 'provider_pending', 'active');

CREATE INDEX idx_channel_connector_requests_shop_status
  ON channel_connector_requests(shop_id, status, created_at DESC, id);

CREATE INDEX idx_channel_connector_requests_provider_status
  ON channel_connector_requests(provider_code, status, updated_at ASC, id);

CREATE TRIGGER channel_connector_requests_identity_immutable
BEFORE UPDATE ON channel_connector_requests
WHEN NEW.id != OLD.id
  OR NEW.public_id != OLD.public_id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.channel_code != OLD.channel_code
  OR NEW.provider_code != OLD.provider_code
  OR NEW.requested_by_user_id != OLD.requested_by_user_id
  OR NEW.request_kind != OLD.request_kind
  OR NEW.idempotency_key_hash != OLD.idempotency_key_hash
  OR NEW.request_hash != OLD.request_hash
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR OLD.status IN ('active', 'rejected', 'canceled')
  OR NOT (
    (OLD.status = 'requested' AND NEW.status IN ('requested', 'provider_pending', 'rejected', 'canceled'))
    OR (OLD.status = 'provider_pending' AND NEW.status IN ('provider_pending', 'active', 'rejected', 'canceled'))
  )
BEGIN
  SELECT RAISE(ABORT, 'channel_connector_request_transition_invalid');
END;

CREATE TRIGGER channel_connector_requests_immutable_delete
BEFORE DELETE ON channel_connector_requests
BEGIN
  SELECT RAISE(ABORT, 'channel_connector_request_immutable');
END;
