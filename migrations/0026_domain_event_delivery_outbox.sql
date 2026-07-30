PRAGMA foreign_keys = ON;

-- Generic domain events contain stable references only. Their identity and
-- business meaning are immutable; only the bounded dispatch lifecycle changes.
CREATE TABLE domain_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (
    length(event_type) BETWEEN 3 AND 96
    AND substr(event_type, 1, 1) GLOB '[a-z]'
    AND event_type NOT GLOB '*[^a-z0-9._:-]*'
  ),
  aggregate_type TEXT NOT NULL CHECK (
    length(aggregate_type) BETWEEN 3 AND 64
    AND substr(aggregate_type, 1, 1) GLOB '[a-z]'
    AND aggregate_type NOT GLOB '*[^a-z0-9._:-]*'
  ),
  aggregate_id TEXT NOT NULL CHECK (
    length(aggregate_id) BETWEEN 3 AND 128
    AND substr(aggregate_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND aggregate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  source_connection_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'processing', 'retryable', 'published', 'failed')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000000),
  next_attempt_at TEXT,
  lease_token TEXT CHECK (
    lease_token IS NULL OR (
      length(lease_token) BETWEEN 16 AND 128
      AND lease_token NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  lease_expires_at TEXT,
  last_safe_error_code TEXT CHECK (
    last_safe_error_code IS NULL OR (
      length(last_safe_error_code) BETWEEN 3 AND 96
      AND substr(last_safe_error_code, 1, 1) GLOB '[a-z]'
      AND last_safe_error_code NOT GLOB '*[^a-z0-9._:-]*'
    )
  ),
  published_at TEXT,
  occurred_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, event_type, idempotency_key_hash),
  FOREIGN KEY (shop_id, source_connection_id)
    REFERENCES channel_connections(shop_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status != 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status IN ('pending', 'retryable') AND next_attempt_at IS NOT NULL)
    OR (status NOT IN ('pending', 'retryable') AND next_attempt_at IS NULL)
  ),
  CHECK (
    (status = 'published' AND published_at IS NOT NULL)
    OR (status != 'published' AND published_at IS NULL)
  )
) STRICT;

CREATE INDEX idx_domain_events_shop_created
  ON domain_events(shop_id, created_at DESC, id);

CREATE INDEX idx_domain_events_shop_aggregate
  ON domain_events(shop_id, aggregate_type, aggregate_id, event_type, occurred_at DESC, id);

CREATE INDEX idx_domain_events_shop_due
  ON domain_events(shop_id, status, next_attempt_at, lease_expires_at, id)
  WHERE status IN ('pending', 'processing', 'retryable');

CREATE INDEX idx_domain_events_system_due
  ON domain_events(status, next_attempt_at, lease_expires_at, id, shop_id)
  WHERE status IN ('pending', 'processing', 'retryable');

CREATE TRIGGER domain_events_identity_immutable
BEFORE UPDATE ON domain_events
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.event_type != OLD.event_type
  OR NEW.aggregate_type != OLD.aggregate_type
  OR NEW.aggregate_id != OLD.aggregate_id
  OR NEW.schema_version != OLD.schema_version
  OR NEW.idempotency_key_hash != OLD.idempotency_key_hash
  OR NEW.source_connection_id IS NOT OLD.source_connection_id
  OR NEW.occurred_at != OLD.occurred_at
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'domain_event_identity_immutable');
END;

CREATE TRIGGER domain_events_transition_guard
BEFORE UPDATE ON domain_events
WHEN
  NEW.version != OLD.version + 1
  OR NEW.attempts < OLD.attempts
  OR NOT (
    (OLD.status = 'pending' AND NEW.status = 'processing')
    OR (OLD.status = 'retryable' AND NEW.status = 'processing')
    OR (OLD.status = 'processing' AND NEW.status IN (
      'processing', 'retryable', 'published', 'failed'
    ))
  )
BEGIN
  SELECT RAISE(ABORT, 'domain_event_transition_invalid');
END;

CREATE TRIGGER domain_events_immutable_delete
BEFORE DELETE ON domain_events
BEGIN
  SELECT RAISE(ABORT, 'domain_event_immutable');
END;

-- One immutable event can fan out to independent connection deliveries. Jobs
-- keep only event/connection references and bounded operational state.
CREATE TABLE delivery_jobs (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (
    length(purpose) BETWEEN 3 AND 96
    AND substr(purpose, 1, 1) GLOB '[a-z]'
    AND purpose NOT GLOB '*[^a-z0-9._:-]*'
  ),
  queue_kind TEXT NOT NULL CHECK (queue_kind IN ('integration', 'notification')),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'pending', 'processing', 'retryable', 'delivered',
      'failed', 'dead_letter', 'canceled'
    )
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000000),
  next_attempt_at TEXT,
  lease_token TEXT CHECK (
    lease_token IS NULL OR (
      length(lease_token) BETWEEN 16 AND 128
      AND lease_token NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  lease_expires_at TEXT,
  last_safe_error_code TEXT CHECK (
    last_safe_error_code IS NULL OR (
      length(last_safe_error_code) BETWEEN 3 AND 96
      AND substr(last_safe_error_code, 1, 1) GLOB '[a-z]'
      AND last_safe_error_code NOT GLOB '*[^a-z0-9._:-]*'
    )
  ),
  delivered_at TEXT,
  dead_lettered_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, event_id, connection_id, purpose),
  UNIQUE (shop_id, connection_id, purpose, idempotency_key_hash),
  FOREIGN KEY (shop_id, event_id)
    REFERENCES domain_events(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, connection_id)
    REFERENCES channel_connections(shop_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status != 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status IN ('pending', 'retryable') AND next_attempt_at IS NOT NULL)
    OR (status NOT IN ('pending', 'retryable') AND next_attempt_at IS NULL)
  ),
  CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL)
    OR (status != 'delivered' AND delivered_at IS NULL)
  ),
  CHECK (
    (status = 'dead_letter' AND dead_lettered_at IS NOT NULL)
    OR (status != 'dead_letter' AND dead_lettered_at IS NULL)
  )
) STRICT;

CREATE INDEX idx_delivery_jobs_shop_due
  ON delivery_jobs(shop_id, status, next_attempt_at, lease_expires_at, id)
  WHERE status IN ('pending', 'processing', 'retryable');

CREATE INDEX idx_delivery_jobs_system_due
  ON delivery_jobs(status, next_attempt_at, lease_expires_at, id, shop_id)
  WHERE status IN ('pending', 'processing', 'retryable');

CREATE INDEX idx_delivery_jobs_shop_event
  ON delivery_jobs(shop_id, event_id, status, connection_id, purpose, id);

CREATE INDEX idx_delivery_jobs_shop_connection
  ON delivery_jobs(shop_id, connection_id, status, next_attempt_at, id);

CREATE INDEX idx_delivery_jobs_shop_failed
  ON delivery_jobs(shop_id, status, updated_at DESC, id)
  WHERE status IN ('failed', 'dead_letter');

CREATE TRIGGER delivery_jobs_connection_guard
BEFORE INSERT ON delivery_jobs
WHEN NOT EXISTS (
  SELECT 1
  FROM channel_connections
  WHERE shop_id = NEW.shop_id
    AND id = NEW.connection_id
    AND status IN ('active', 'degraded')
)
BEGIN
  SELECT RAISE(ABORT, 'delivery_job_connection_unavailable');
END;

CREATE TRIGGER delivery_jobs_identity_immutable
BEFORE UPDATE ON delivery_jobs
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.event_id != OLD.event_id
  OR NEW.connection_id != OLD.connection_id
  OR NEW.purpose != OLD.purpose
  OR NEW.queue_kind != OLD.queue_kind
  OR NEW.idempotency_key_hash != OLD.idempotency_key_hash
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'delivery_job_identity_immutable');
END;

CREATE TRIGGER delivery_jobs_transition_guard
BEFORE UPDATE ON delivery_jobs
WHEN
  NEW.version != OLD.version + 1
  OR NEW.attempts < OLD.attempts
  OR NOT (
    (OLD.status = 'pending' AND NEW.status IN ('processing', 'canceled'))
    OR (OLD.status = 'retryable' AND NEW.status IN ('processing', 'canceled'))
    OR (OLD.status = 'processing' AND NEW.status IN (
      'processing', 'retryable', 'delivered', 'failed', 'dead_letter'
    ))
  )
BEGIN
  SELECT RAISE(ABORT, 'delivery_job_transition_invalid');
END;

CREATE TRIGGER delivery_jobs_immutable_delete
BEFORE DELETE ON delivery_jobs
BEGIN
  SELECT RAISE(ABORT, 'delivery_job_immutable');
END;
