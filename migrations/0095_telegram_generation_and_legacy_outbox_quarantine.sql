PRAGMA foreign_keys = ON;

-- Legacy payment runtimes may still insert order_paid outbox rows during a
-- rolling deployment. Preserve INSERT compatibility while making those rows
-- permanently inert; order.paid domain delivery is the sole send authority.
UPDATE outbox_jobs
SET status = 'completed',
  lease_token = NULL,
  lease_expires_at = NULL,
  last_safe_error_code = 'telegram_legacy_notification_superseded',
  updated_at = CASE
    WHEN updated_at < '2026-08-11T00:00:00.000Z' THEN '2026-08-11T00:00:00.000Z'
    ELSE updated_at
  END
WHERE kind = 'order_paid';

CREATE TRIGGER outbox_jobs_quarantine_legacy_order_paid_insert
AFTER INSERT ON outbox_jobs
WHEN NEW.kind = 'order_paid'
BEGIN
  UPDATE outbox_jobs
  SET status = 'completed',
    lease_token = NULL,
    lease_expires_at = NULL,
    last_safe_error_code = 'telegram_legacy_notification_superseded',
    updated_at = NEW.updated_at
  WHERE id = NEW.id AND shop_id = NEW.shop_id;
END;

ALTER TABLE telegram_integrations
  ADD COLUMN integration_generation INTEGER NOT NULL DEFAULT 1
  CHECK (integration_generation > 0);

ALTER TABLE telegram_integrations
  ADD COLUMN generation_state TEXT NOT NULL DEFAULT 'active'
  CHECK (generation_state IN ('active', 'draining'));

ALTER TABLE telegram_updates RENAME TO telegram_updates_pre_generation;

CREATE TABLE telegram_updates (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES telegram_integrations(id) ON DELETE CASCADE,
  credential_id TEXT REFERENCES telegram_credentials(id) ON DELETE SET NULL,
  integration_generation INTEGER NOT NULL CHECK (integration_generation > 0),
  update_id INTEGER NOT NULL CHECK (update_id >= 0),
  payload_hash TEXT NOT NULL,
  update_kind TEXT NOT NULL CHECK (update_kind IN ('message', 'callback_query')),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'processing', 'processed', 'failed', 'rejected')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  safe_result_code TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (integration_id, integration_generation, update_id)
) STRICT;

-- Pre-generation update receipts cannot be safely attributed to a live
-- request. Preserve terminal evidence and reject every retryable row.
INSERT INTO telegram_updates (
  id, shop_id, integration_id, credential_id, integration_generation,
  update_id, payload_hash, update_kind, status, attempts, safe_result_code,
  received_at, processed_at, updated_at
)
SELECT telegram_updates_pre_generation.id,
  telegram_updates_pre_generation.shop_id,
  telegram_updates_pre_generation.integration_id,
  telegram_integrations.active_credential_id,
  telegram_integrations.integration_generation,
  telegram_updates_pre_generation.update_id,
  telegram_updates_pre_generation.payload_hash,
  telegram_updates_pre_generation.update_kind,
  CASE
    WHEN telegram_updates_pre_generation.status IN ('accepted', 'processing', 'failed') THEN 'rejected'
    ELSE telegram_updates_pre_generation.status
  END,
  telegram_updates_pre_generation.attempts,
  CASE
    WHEN telegram_updates_pre_generation.status IN ('accepted', 'processing', 'failed')
      THEN 'telegram_update_stale_generation'
    ELSE telegram_updates_pre_generation.safe_result_code
  END,
  telegram_updates_pre_generation.received_at,
  CASE
    WHEN telegram_updates_pre_generation.status IN ('accepted', 'processing', 'failed')
      THEN COALESCE(telegram_updates_pre_generation.processed_at, telegram_updates_pre_generation.updated_at)
    ELSE telegram_updates_pre_generation.processed_at
  END,
  telegram_updates_pre_generation.updated_at
FROM telegram_updates_pre_generation
INNER JOIN telegram_integrations
  ON telegram_integrations.id = telegram_updates_pre_generation.integration_id
  AND telegram_integrations.shop_id = telegram_updates_pre_generation.shop_id;

DROP TABLE telegram_updates_pre_generation;

CREATE INDEX idx_telegram_updates_shop_received
  ON telegram_updates(shop_id, received_at DESC, id);

CREATE INDEX idx_telegram_updates_status
  ON telegram_updates(status, updated_at, id);

CREATE INDEX idx_telegram_integrations_shop_generation
  ON telegram_integrations(shop_id, generation_state, integration_generation, id);

CREATE INDEX idx_telegram_updates_generation_processing
  ON telegram_updates(shop_id, integration_id, integration_generation, status, updated_at, id);

CREATE TRIGGER telegram_integrations_generation_switch_required
BEFORE UPDATE OF active_credential_id ON telegram_integrations
WHEN NEW.active_credential_id IS NOT OLD.active_credential_id
  AND NEW.integration_generation = OLD.integration_generation
BEGIN
  SELECT RAISE(ABORT, 'telegram_generation_required');
END;

CREATE TRIGGER telegram_integrations_generation_transition_guard
BEFORE UPDATE OF integration_generation ON telegram_integrations
WHEN NEW.integration_generation != OLD.integration_generation
  AND NOT (
    OLD.generation_state = 'draining'
    AND NEW.generation_state = 'active'
    AND NEW.integration_generation = OLD.integration_generation + 1
  )
BEGIN
  SELECT RAISE(ABORT, 'telegram_generation_transition_invalid');
END;

CREATE TRIGGER telegram_updates_generation_insert_guard
BEFORE INSERT ON telegram_updates
WHEN NEW.status = 'processing'
  AND NOT EXISTS (
    SELECT 1
    FROM telegram_integrations
    INNER JOIN telegram_credentials
      ON telegram_credentials.id = telegram_integrations.active_credential_id
      AND telegram_credentials.integration_id = telegram_integrations.id
      AND telegram_credentials.shop_id = telegram_integrations.shop_id
      AND telegram_credentials.status = 'active'
    WHERE telegram_integrations.id = NEW.integration_id
      AND telegram_integrations.shop_id = NEW.shop_id
      AND telegram_integrations.active_credential_id = NEW.credential_id
      AND telegram_integrations.integration_generation = NEW.integration_generation
      AND telegram_integrations.generation_state = 'active'
      AND telegram_integrations.status IN ('active', 'degraded')
  )
BEGIN
  SELECT RAISE(ABORT, 'telegram_update_generation_stale');
END;

CREATE TRIGGER telegram_updates_generation_claim_guard
BEFORE UPDATE OF status ON telegram_updates
WHEN NEW.status = 'processing'
  AND OLD.status != 'processing'
  AND NOT EXISTS (
    SELECT 1
    FROM telegram_integrations
    INNER JOIN telegram_credentials
      ON telegram_credentials.id = telegram_integrations.active_credential_id
      AND telegram_credentials.integration_id = telegram_integrations.id
      AND telegram_credentials.shop_id = telegram_integrations.shop_id
      AND telegram_credentials.status = 'active'
    WHERE telegram_integrations.id = NEW.integration_id
      AND telegram_integrations.shop_id = NEW.shop_id
      AND telegram_integrations.active_credential_id = NEW.credential_id
      AND telegram_integrations.integration_generation = NEW.integration_generation
      AND telegram_integrations.generation_state = 'active'
      AND telegram_integrations.status IN ('active', 'degraded')
  )
BEGIN
  SELECT RAISE(ABORT, 'telegram_update_generation_stale');
END;
