PRAGMA foreign_keys = ON;

-- Poll-specific indexes keep ready work and expired leases as separate ranges.
CREATE INDEX idx_domain_events_ready_claim
  ON domain_events(next_attempt_at, id, shop_id)
  WHERE status IN ('pending', 'retryable');
CREATE INDEX idx_domain_events_expired_lease
  ON domain_events(lease_expires_at, id, shop_id)
  WHERE status = 'processing';
CREATE INDEX idx_domain_events_shop_ready_claim
  ON domain_events(shop_id, next_attempt_at, id)
  WHERE status IN ('pending', 'retryable');
CREATE INDEX idx_domain_events_shop_expired_lease
  ON domain_events(shop_id, lease_expires_at, id)
  WHERE status = 'processing';
CREATE INDEX idx_domain_events_source_connection_fk
  ON domain_events(shop_id, source_connection_id, id)
  WHERE source_connection_id IS NOT NULL;

CREATE INDEX idx_delivery_jobs_ready_claim
  ON delivery_jobs(next_attempt_at, id, shop_id)
  WHERE status IN ('pending', 'retryable');
CREATE INDEX idx_delivery_jobs_expired_lease
  ON delivery_jobs(lease_expires_at, id, shop_id)
  WHERE status = 'processing';
CREATE INDEX idx_delivery_jobs_shop_ready_claim
  ON delivery_jobs(shop_id, next_attempt_at, id)
  WHERE status IN ('pending', 'retryable');
CREATE INDEX idx_delivery_jobs_shop_expired_lease
  ON delivery_jobs(shop_id, lease_expires_at, id)
  WHERE status = 'processing';

-- Preserve queue_dead_letters.reference_type='outbox_job' for old Workers and
-- attach the precise generic work-item identity in an additive extension.
CREATE TABLE queue_dead_letter_outbox_links (
  dead_letter_id TEXT PRIMARY KEY NOT NULL
    REFERENCES queue_dead_letters(id) ON DELETE CASCADE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('domain_event', 'delivery_job')),
  domain_event_id TEXT,
  delivery_job_id TEXT,
  replay_status TEXT NOT NULL DEFAULT 'idle' CHECK (
    replay_status IN ('idle', 'requested', 'enqueued', 'completed', 'failed')
  ),
  replay_request_id TEXT CHECK (
    replay_request_id IS NULL OR (
      length(replay_request_id) BETWEEN 8 AND 96
      AND substr(replay_request_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND replay_request_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  replay_requested_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  replay_requested_at TEXT,
  replay_enqueued_at TEXT,
  replay_finished_at TEXT,
  replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count BETWEEN 0 AND 1000000),
  last_safe_error_code TEXT CHECK (
    last_safe_error_code IS NULL OR (
      length(last_safe_error_code) BETWEEN 3 AND 96
      AND substr(last_safe_error_code, 1, 1) GLOB '[a-z]'
      AND last_safe_error_code NOT GLOB '*[^a-z0-9._:-]*'
    )
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (shop_id, domain_event_id)
    REFERENCES domain_events(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, delivery_job_id)
    REFERENCES delivery_jobs(shop_id, id) ON DELETE RESTRICT,
  CHECK (
    (target_kind = 'domain_event' AND domain_event_id IS NOT NULL AND delivery_job_id IS NULL)
    OR (target_kind = 'delivery_job' AND domain_event_id IS NULL AND delivery_job_id IS NOT NULL)
  ),
  CHECK (
    (replay_status = 'idle' AND replay_count = 0 AND replay_request_id IS NULL
      AND replay_requested_at IS NULL AND replay_enqueued_at IS NULL
      AND replay_finished_at IS NULL AND last_safe_error_code IS NULL)
    OR (replay_status = 'requested' AND replay_count > 0 AND replay_request_id IS NOT NULL
      AND replay_requested_at IS NOT NULL AND replay_enqueued_at IS NULL
      AND replay_finished_at IS NULL)
    OR (replay_status = 'enqueued' AND replay_count > 0 AND replay_request_id IS NOT NULL
      AND replay_requested_at IS NOT NULL AND replay_enqueued_at IS NOT NULL
      AND replay_finished_at IS NULL)
    OR (replay_status = 'completed' AND replay_count > 0 AND replay_request_id IS NOT NULL
      AND replay_requested_at IS NOT NULL AND replay_enqueued_at IS NOT NULL
      AND replay_finished_at IS NOT NULL)
    OR (replay_status = 'failed' AND replay_count > 0 AND replay_request_id IS NOT NULL
      AND replay_requested_at IS NOT NULL AND replay_finished_at IS NOT NULL
      AND last_safe_error_code IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_queue_dead_letter_outbox_links_shop_status
  ON queue_dead_letter_outbox_links(shop_id, replay_status, updated_at DESC, dead_letter_id);
CREATE INDEX idx_queue_dead_letter_outbox_links_domain_event
  ON queue_dead_letter_outbox_links(shop_id, domain_event_id, replay_status, dead_letter_id)
  WHERE target_kind = 'domain_event';
CREATE INDEX idx_queue_dead_letter_outbox_links_delivery_job
  ON queue_dead_letter_outbox_links(shop_id, delivery_job_id, replay_status, dead_letter_id)
  WHERE target_kind = 'delivery_job';
CREATE UNIQUE INDEX idx_queue_dead_letter_outbox_links_live_target
  ON queue_dead_letter_outbox_links(
    shop_id, target_kind, COALESCE(domain_event_id, delivery_job_id)
  )
  WHERE replay_status IN ('requested', 'enqueued');

CREATE TRIGGER queue_dead_letter_outbox_links_scope_guard
BEFORE INSERT ON queue_dead_letter_outbox_links
WHEN NOT EXISTS (
  SELECT 1 FROM queue_dead_letters
  WHERE id = NEW.dead_letter_id
    AND shop_id = NEW.shop_id
    AND reference_type = 'outbox_job'
    AND reference_id = CASE NEW.target_kind
      WHEN 'domain_event' THEN NEW.domain_event_id ELSE NEW.delivery_job_id END
)
BEGIN
  SELECT RAISE(ABORT, 'outbox_dead_letter_scope_invalid');
END;

CREATE TRIGGER queue_dead_letter_outbox_links_identity_immutable
BEFORE UPDATE ON queue_dead_letter_outbox_links
WHEN NEW.dead_letter_id != OLD.dead_letter_id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.target_kind != OLD.target_kind
  OR NEW.domain_event_id IS NOT OLD.domain_event_id
  OR NEW.delivery_job_id IS NOT OLD.delivery_job_id
BEGIN
  SELECT RAISE(ABORT, 'outbox_dead_letter_identity_immutable');
END;

CREATE TRIGGER queue_dead_letter_outbox_links_transition_guard
BEFORE UPDATE ON queue_dead_letter_outbox_links
WHEN NEW.version != OLD.version + 1
  OR NEW.replay_count < OLD.replay_count
  OR NOT (
    (OLD.replay_status IN ('idle', 'completed', 'failed')
      AND NEW.replay_status = 'requested'
      AND NEW.replay_count = OLD.replay_count + 1)
    OR (OLD.replay_status = 'requested'
      AND NEW.replay_status IN ('enqueued', 'failed')
      AND NEW.replay_count = OLD.replay_count)
    OR (OLD.replay_status = 'enqueued'
      AND NEW.replay_status IN ('completed', 'failed')
      AND NEW.replay_count = OLD.replay_count)
  )
BEGIN
  SELECT RAISE(ABORT, 'outbox_dead_letter_replay_transition_invalid');
END;

DROP TRIGGER domain_events_transition_guard;
CREATE TRIGGER domain_events_transition_guard
BEFORE UPDATE ON domain_events
WHEN NEW.version != OLD.version + 1
  OR NEW.attempts < OLD.attempts
  OR NOT (
    (OLD.status = 'pending' AND NEW.status = 'processing')
    OR (OLD.status = 'retryable' AND NEW.status = 'processing')
    OR (OLD.status = 'processing' AND NEW.status IN (
      'processing', 'retryable', 'published', 'failed'
    ))
    OR (OLD.status IN ('pending', 'retryable') AND NEW.status = 'failed'
      AND NEW.last_safe_error_code = 'shop_deleted'
      AND EXISTS (
        SELECT 1 FROM shops
        WHERE shops.id = NEW.shop_id AND shops.status != 'active'
      ))
    OR (OLD.status = 'failed' AND NEW.status = 'retryable'
      AND EXISTS (
        SELECT 1
        FROM queue_dead_letter_outbox_links AS link
        INNER JOIN queue_dead_letters AS dead_letter
          ON dead_letter.id = link.dead_letter_id
        WHERE link.shop_id = NEW.shop_id
          AND link.target_kind = 'domain_event'
          AND link.domain_event_id = NEW.id
          AND link.replay_status = 'requested'
          AND dead_letter.shop_id = NEW.shop_id
          AND dead_letter.status = 'retry_requested'
      ))
  )
BEGIN
  SELECT RAISE(ABORT, 'domain_event_transition_invalid');
END;

DROP TRIGGER delivery_jobs_transition_guard;
CREATE TRIGGER delivery_jobs_transition_guard
BEFORE UPDATE ON delivery_jobs
WHEN NEW.version != OLD.version + 1
  OR NEW.attempts < OLD.attempts
  OR NOT (
    (OLD.status = 'pending' AND NEW.status IN ('processing', 'canceled'))
    OR (OLD.status = 'retryable' AND NEW.status IN ('processing', 'canceled'))
    OR (OLD.status = 'processing' AND NEW.status IN (
      'processing', 'retryable', 'delivered', 'failed', 'dead_letter'
    ))
    OR (OLD.status = 'processing' AND NEW.status = 'canceled'
      AND NEW.last_safe_error_code = 'shop_deleted'
      AND EXISTS (
        SELECT 1 FROM shops
        WHERE shops.id = NEW.shop_id AND shops.status != 'active'
      ))
    OR (OLD.status IN ('failed', 'dead_letter') AND NEW.status = 'retryable'
      AND EXISTS (
        SELECT 1
        FROM queue_dead_letter_outbox_links AS link
        INNER JOIN queue_dead_letters AS dead_letter
          ON dead_letter.id = link.dead_letter_id
        WHERE link.shop_id = NEW.shop_id
          AND link.target_kind = 'delivery_job'
          AND link.delivery_job_id = NEW.id
          AND link.replay_status = 'requested'
          AND dead_letter.shop_id = NEW.shop_id
          AND dead_letter.status = 'retry_requested'
      ))
  )
BEGIN
  SELECT RAISE(ABORT, 'delivery_job_transition_invalid');
END;
