PRAGMA foreign_keys = ON;

-- Action receipts are part of the inbound authority boundary. A Telegram
-- update ID is only unique within a credential generation, so preserve prior
-- receipts as history and make new/replayed actions generation-scoped.
DROP INDEX IF EXISTS idx_telegram_actions_shop_created;
ALTER TABLE telegram_actions RENAME TO telegram_actions_pre_generation;

CREATE TABLE telegram_actions (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES telegram_integrations(id) ON DELETE CASCADE,
  integration_generation INTEGER NOT NULL DEFAULT 0 CHECK (integration_generation >= 0),
  update_id INTEGER NOT NULL CHECK (update_id >= 0),
  action_kind TEXT NOT NULL,
  result_reference TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (integration_id, integration_generation, update_id, action_kind)
) STRICT;

-- Keep historical idempotency evidence out of the active table. Older
-- Workers query telegram_actions without a generation predicate, so retaining
-- old receipts there could replay a previous bot's cart/quote after rotation.
CREATE TABLE telegram_action_history (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES telegram_integrations(id) ON DELETE CASCADE,
  integration_generation INTEGER NOT NULL CHECK (integration_generation > 0),
  update_id INTEGER NOT NULL CHECK (update_id >= 0),
  action_kind TEXT NOT NULL,
  result_reference TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  UNIQUE (integration_id, integration_generation, update_id, action_kind)
) STRICT;

CREATE INDEX idx_telegram_action_history_generation
  ON telegram_action_history(shop_id, integration_id, integration_generation, update_id, action_kind);

INSERT INTO telegram_actions (
  id, shop_id, integration_id, integration_generation, update_id,
  action_kind, result_reference, created_at
)
SELECT action.id,
  action.shop_id,
  action.integration_id,
  integration.integration_generation,
  action.update_id,
  action.action_kind,
  action.result_reference,
  action.created_at
FROM telegram_actions_pre_generation AS action
INNER JOIN telegram_integrations AS integration
  ON integration.id = action.integration_id
  AND integration.shop_id = action.shop_id;

DROP TABLE telegram_actions_pre_generation;

CREATE INDEX idx_telegram_actions_shop_created
  ON telegram_actions(shop_id, created_at DESC, id);
CREATE INDEX idx_telegram_actions_generation
  ON telegram_actions(shop_id, integration_id, integration_generation, update_id, action_kind);

-- An old Worker omits integration_generation. Attribute its write to the
-- current active authority, then suppress the original legacy-shaped insert.
-- This preserves INSERT/INSERT OR IGNORE replay behavior without retaining a
-- generation-zero receipt that could be claimed after a bot replacement.
CREATE TRIGGER telegram_actions_legacy_generation_attribute
AFTER INSERT ON telegram_actions
WHEN NEW.integration_generation = 0
BEGIN
  UPDATE telegram_actions
  SET integration_generation = COALESCE((
    SELECT integration_generation
    FROM telegram_integrations
    WHERE id = NEW.integration_id
      AND shop_id = NEW.shop_id
      AND generation_state = 'active'
      AND status IN ('active', 'degraded')
  ), 0)
  WHERE id = NEW.id;

  SELECT RAISE(ABORT, 'telegram_action_generation_stale')
  WHERE EXISTS (
    SELECT 1 FROM telegram_actions
    WHERE id = NEW.id AND integration_generation = 0
  );
END;

CREATE TRIGGER telegram_actions_generation_insert_guard
BEFORE INSERT ON telegram_actions
WHEN NEW.integration_generation > 0
  AND NOT EXISTS (
    SELECT 1
    FROM telegram_integrations
    WHERE id = NEW.integration_id
      AND shop_id = NEW.shop_id
      AND integration_generation = NEW.integration_generation
      AND generation_state = 'active'
      AND status IN ('active', 'degraded')
  )
BEGIN
  SELECT RAISE(ABORT, 'telegram_action_generation_stale');
END;

-- Provider-attempt ownership is persisted before sendMessage. Do not permit a
-- credential/generation transition while that send is in flight: a rotation
-- that wins first makes the pre-send authority claim fail, and a claim that
-- wins first makes the rotation retry after settlement.
CREATE TRIGGER telegram_integrations_delivery_generation_busy_guard
BEFORE UPDATE OF active_credential_id, integration_generation, generation_state
ON telegram_integrations
WHEN (
  NEW.active_credential_id IS NOT OLD.active_credential_id
  OR NEW.integration_generation != OLD.integration_generation
  OR NEW.generation_state != OLD.generation_state
)
  AND OLD.channel_connection_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM delivery_jobs
    WHERE delivery_jobs.shop_id = OLD.shop_id
      AND delivery_jobs.connection_id = OLD.channel_connection_id
      AND delivery_jobs.queue_kind = 'notification'
      AND delivery_jobs.purpose = 'order.paid'
      AND delivery_jobs.status = 'processing'
      AND delivery_jobs.last_safe_error_code = 'delivery_provider_attempt_claimed'
  )
BEGIN
  SELECT RAISE(ROLLBACK, 'telegram_integration_busy');
END;

CREATE TRIGGER telegram_integrations_archive_actions_on_generation_change
AFTER UPDATE OF active_credential_id, integration_generation ON telegram_integrations
WHEN NEW.active_credential_id IS NOT OLD.active_credential_id
  OR NEW.integration_generation != OLD.integration_generation
BEGIN
  INSERT OR IGNORE INTO telegram_action_history (
    id, shop_id, integration_id, integration_generation, update_id,
    action_kind, result_reference, created_at, archived_at
  )
  SELECT id, shop_id, integration_id, integration_generation, update_id,
    action_kind, result_reference, created_at, NEW.updated_at
  FROM telegram_actions
  WHERE shop_id = NEW.shop_id
    AND integration_id = NEW.id
    AND integration_generation <= OLD.integration_generation;

  DELETE FROM telegram_actions
  WHERE shop_id = NEW.shop_id
    AND integration_id = NEW.id
    AND integration_generation <= OLD.integration_generation;
END;
