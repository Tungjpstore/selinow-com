PRAGMA foreign_keys = ON;

-- Pre-0095 Telegram runtimes omit generation columns and rotate the active
-- credential without incrementing integration_generation. Keep those statements
-- compatible after 0095 so a rolled-back Worker cannot write an unfenced update
-- or steal an in-flight generation.

DROP TRIGGER IF EXISTS telegram_updates_generation_insert_guard;
DROP TRIGGER IF EXISTS telegram_updates_generation_claim_guard;
DROP TRIGGER IF EXISTS telegram_integrations_generation_switch_required;
DROP INDEX IF EXISTS idx_telegram_updates_shop_received;
DROP INDEX IF EXISTS idx_telegram_updates_status;
DROP INDEX IF EXISTS idx_telegram_updates_generation_processing;

ALTER TABLE telegram_updates RENAME TO telegram_updates_pre_rollback;

CREATE TABLE telegram_updates (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES telegram_integrations(id) ON DELETE CASCADE,
  credential_id TEXT REFERENCES telegram_credentials(id) ON DELETE SET NULL,
  integration_generation INTEGER NOT NULL DEFAULT 0 CHECK (integration_generation >= 0),
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

INSERT INTO telegram_updates (
  id, shop_id, integration_id, credential_id, integration_generation,
  update_id, payload_hash, update_kind, status, attempts, safe_result_code,
  received_at, processed_at, updated_at
)
SELECT id, shop_id, integration_id, credential_id, integration_generation,
  update_id, payload_hash, update_kind, status, attempts, safe_result_code,
  received_at, processed_at, updated_at
FROM telegram_updates_pre_rollback;

DROP TABLE telegram_updates_pre_rollback;

CREATE INDEX idx_telegram_updates_shop_received
  ON telegram_updates(shop_id, received_at DESC, id);

CREATE INDEX idx_telegram_updates_status
  ON telegram_updates(status, updated_at, id);

CREATE INDEX idx_telegram_updates_generation_processing
  ON telegram_updates(shop_id, integration_id, integration_generation, status, updated_at, id);

CREATE TRIGGER telegram_updates_generation_insert_guard
BEFORE INSERT ON telegram_updates
WHEN NEW.status = 'processing'
  AND NEW.integration_generation > 0
  AND NEW.credential_id IS NOT NULL
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

CREATE TRIGGER telegram_updates_legacy_generation_attribute
AFTER INSERT ON telegram_updates
WHEN NEW.integration_generation = 0 OR NEW.credential_id IS NULL
BEGIN
  UPDATE telegram_updates
  SET credential_id = COALESCE(
        telegram_updates.credential_id,
        (
          SELECT telegram_integrations.active_credential_id
          FROM telegram_integrations
          WHERE telegram_integrations.id = NEW.integration_id
            AND telegram_integrations.shop_id = NEW.shop_id
        )
      ),
      integration_generation = CASE
        WHEN telegram_updates.integration_generation > 0 THEN telegram_updates.integration_generation
        ELSE COALESCE(
          (
            SELECT telegram_integrations.integration_generation
            FROM telegram_integrations
            WHERE telegram_integrations.id = NEW.integration_id
              AND telegram_integrations.shop_id = NEW.shop_id
          ),
          0
        )
      END
  WHERE id = NEW.id;

  SELECT RAISE(ABORT, 'telegram_update_generation_stale')
  WHERE NEW.status = 'processing'
    AND NOT EXISTS (
      SELECT 1
      FROM telegram_updates AS update_row
      INNER JOIN telegram_integrations
        ON telegram_integrations.id = update_row.integration_id
        AND telegram_integrations.shop_id = update_row.shop_id
        AND telegram_integrations.active_credential_id = update_row.credential_id
        AND telegram_integrations.integration_generation = update_row.integration_generation
        AND telegram_integrations.generation_state = 'active'
        AND telegram_integrations.status IN ('active', 'degraded')
      INNER JOIN telegram_credentials
        ON telegram_credentials.id = telegram_integrations.active_credential_id
        AND telegram_credentials.integration_id = telegram_integrations.id
        AND telegram_credentials.shop_id = telegram_integrations.shop_id
        AND telegram_credentials.status = 'active'
      WHERE update_row.id = NEW.id
    );
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

CREATE TRIGGER telegram_credentials_legacy_generation_busy_guard
BEFORE UPDATE OF status ON telegram_credentials
WHEN NEW.status = 'revoked'
  AND OLD.status = 'active'
  AND EXISTS (
    SELECT 1
    FROM telegram_integrations
    WHERE telegram_integrations.id = OLD.integration_id
      AND telegram_integrations.shop_id = OLD.shop_id
      AND telegram_integrations.active_credential_id = OLD.id
  )
  AND EXISTS (
    SELECT 1
    FROM telegram_updates
    WHERE telegram_updates.integration_id = OLD.integration_id
      AND telegram_updates.shop_id = OLD.shop_id
      AND telegram_updates.credential_id = OLD.id
      AND telegram_updates.status = 'processing'
  )
BEGIN
  SELECT RAISE(ROLLBACK, 'telegram_integration_busy');
END;

CREATE TRIGGER telegram_integrations_generation_switch_required
BEFORE UPDATE OF active_credential_id ON telegram_integrations
WHEN NEW.active_credential_id IS NOT OLD.active_credential_id
  AND EXISTS (
    SELECT 1
    FROM telegram_updates
    WHERE telegram_updates.integration_id = OLD.id
      AND telegram_updates.shop_id = OLD.shop_id
      AND telegram_updates.integration_generation = OLD.integration_generation
      AND telegram_updates.status = 'processing'
  )
BEGIN
  SELECT RAISE(ROLLBACK, 'telegram_integration_busy');
END;

CREATE TRIGGER telegram_integrations_legacy_generation_fence
AFTER UPDATE OF active_credential_id ON telegram_integrations
WHEN NEW.active_credential_id IS NOT OLD.active_credential_id
  AND NEW.integration_generation = OLD.integration_generation
BEGIN
  UPDATE telegram_integrations
  SET generation_state = 'draining',
    updated_at = NEW.updated_at
  WHERE id = NEW.id
    AND shop_id = NEW.shop_id
    AND generation_state = 'active'
    AND integration_generation = NEW.integration_generation;

  UPDATE telegram_integrations
  SET integration_generation = integration_generation + 1,
    generation_state = 'active',
    updated_at = NEW.updated_at
  WHERE id = NEW.id
    AND shop_id = NEW.shop_id
    AND generation_state = 'draining'
    AND integration_generation = NEW.integration_generation;

  UPDATE telegram_recipients
  SET status = 'unavailable',
    last_safe_error_code = 'telegram_bot_generation_replaced',
    updated_at = NEW.updated_at
  WHERE integration_id = NEW.id
    AND shop_id = NEW.shop_id
    AND status = 'active';
END;
