PRAGMA foreign_keys = ON;

-- Legacy PayOS tables use independent foreign keys. Before protecting future
-- writes, fail closed if any existing row crosses a tenant or provider scope.
-- IF NOT EXISTS plus DELETE makes an operator retry safe after fixing a failed
-- migration whose runner did not roll back the validation-table creation.
CREATE TABLE IF NOT EXISTS migration_0037_payos_relationship_validation (
  integration_invalid_count INTEGER NOT NULL,
  credential_invalid_count INTEGER NOT NULL,
  attempt_invalid_count INTEGER NOT NULL,
  event_invalid_count INTEGER NOT NULL,
  exception_invalid_count INTEGER NOT NULL,
  paid_event_invalid_count INTEGER NOT NULL,
  CONSTRAINT migration_0037_integrations_valid
    CHECK (integration_invalid_count = 0),
  CONSTRAINT migration_0037_credentials_valid
    CHECK (credential_invalid_count = 0),
  CONSTRAINT migration_0037_attempts_valid
    CHECK (attempt_invalid_count = 0),
  CONSTRAINT migration_0037_events_valid
    CHECK (event_invalid_count = 0),
  CONSTRAINT migration_0037_exceptions_valid
    CHECK (exception_invalid_count = 0),
  CONSTRAINT migration_0037_paid_events_valid
    CHECK (paid_event_invalid_count = 0)
) STRICT;

DELETE FROM migration_0037_payos_relationship_validation;

INSERT INTO migration_0037_payos_relationship_validation (
  integration_invalid_count,
  credential_invalid_count,
  attempt_invalid_count,
  event_invalid_count,
  exception_invalid_count,
  paid_event_invalid_count
)
SELECT
  (
    SELECT COUNT(*)
    FROM payment_integrations AS integration
    WHERE integration.active_credential_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM payment_credentials AS credential
        WHERE credential.id = integration.active_credential_id
          AND credential.shop_id = integration.shop_id
          AND credential.integration_id = integration.id
          AND credential.provider = integration.provider
          AND credential.status = 'active'
      )
  ),
  (
    SELECT COUNT(*)
    FROM payment_credentials AS credential
    WHERE NOT EXISTS (
      SELECT 1
      FROM payment_integrations AS integration
      WHERE integration.id = credential.integration_id
        AND integration.shop_id = credential.shop_id
        AND integration.provider = credential.provider
    )
  ),
  (
    SELECT COUNT(*)
    FROM payment_attempts AS attempt
    WHERE NOT EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = attempt.order_id
        AND orders.shop_id = attempt.shop_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM payment_integrations AS integration
      WHERE integration.id = attempt.integration_id
        AND integration.shop_id = attempt.shop_id
        AND integration.provider = attempt.provider
    )
    OR NOT EXISTS (
      SELECT 1 FROM payment_credentials AS credential
      WHERE credential.id = attempt.credential_id
        AND credential.shop_id = attempt.shop_id
        AND credential.integration_id = attempt.integration_id
        AND credential.provider = attempt.provider
    )
  ),
  (
    SELECT COUNT(*)
    FROM payment_events AS event
    WHERE NOT EXISTS (
      SELECT 1 FROM payment_integrations AS integration
      WHERE integration.id = event.integration_id
        AND integration.shop_id = event.shop_id
        AND integration.provider = event.provider
    )
    OR (
      event.payment_attempt_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM payment_attempts AS attempt
        WHERE attempt.id = event.payment_attempt_id
          AND attempt.shop_id = event.shop_id
          AND attempt.integration_id = event.integration_id
          AND attempt.provider = event.provider
      )
    )
  ),
  (
    SELECT COUNT(*)
    FROM payment_exceptions AS exception
    WHERE NOT EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = exception.order_id
        AND orders.shop_id = exception.shop_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM payment_attempts AS attempt
      WHERE attempt.id = exception.payment_attempt_id
        AND attempt.shop_id = exception.shop_id
        AND attempt.order_id = exception.order_id
    )
  ),
  (
    SELECT COUNT(*)
    FROM payment_attempts AS attempt
    WHERE attempt.paid_event_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM payment_events AS event
        WHERE event.id = attempt.paid_event_id
          AND event.payment_attempt_id = attempt.id
          AND event.shop_id = attempt.shop_id
          AND event.integration_id = attempt.integration_id
          AND event.provider = attempt.provider
      )
  );

DROP TABLE migration_0037_payos_relationship_validation;

-- Tenant-leading indexes cover both runtime joins and reverse parent guards.
CREATE UNIQUE INDEX idx_payment_credentials_shop_id
  ON payment_credentials(shop_id, id);

CREATE INDEX idx_payment_credentials_shop_integration_scope
  ON payment_credentials(shop_id, integration_id, provider, status, id);

CREATE UNIQUE INDEX idx_payment_attempts_shop_id
  ON payment_attempts(shop_id, id);

CREATE INDEX idx_payment_attempts_shop_integration_scope
  ON payment_attempts(shop_id, integration_id, provider, credential_id, order_id, id);

CREATE INDEX idx_payment_attempts_shop_credential_scope
  ON payment_attempts(shop_id, credential_id, integration_id, provider, order_id, id);

CREATE UNIQUE INDEX idx_payment_events_shop_id
  ON payment_events(shop_id, id);

CREATE INDEX idx_payment_events_shop_integration_scope
  ON payment_events(shop_id, integration_id, provider, payment_attempt_id, id);

CREATE INDEX idx_payment_events_shop_attempt_scope
  ON payment_events(shop_id, payment_attempt_id, integration_id, provider, id)
  WHERE payment_attempt_id IS NOT NULL;

CREATE UNIQUE INDEX idx_payment_exceptions_shop_id
  ON payment_exceptions(shop_id, id);

CREATE INDEX idx_payment_exceptions_shop_attempt_scope
  ON payment_exceptions(shop_id, payment_attempt_id, order_id, id);

CREATE INDEX idx_payment_exceptions_shop_order_scope
  ON payment_exceptions(shop_id, order_id, payment_attempt_id, id);

CREATE TRIGGER payment_integrations_active_credential_update_guard
BEFORE UPDATE OF id, shop_id, provider, active_credential_id
ON payment_integrations
WHEN NEW.active_credential_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM payment_credentials AS credential
    WHERE credential.id = NEW.active_credential_id
      AND credential.shop_id = NEW.shop_id
      AND credential.integration_id = NEW.id
      AND credential.provider = NEW.provider
      AND credential.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_integration_active_credential_mismatch');
END;

-- Rotation demotes the old credential before switching the pointer. Clearing
-- the old pointer keeps every statement fail closed without changing runtime
-- ordering; the later integration update can bind the newly active credential.
CREATE TRIGGER payment_credentials_clear_inactive_integration_pointer
AFTER UPDATE OF status ON payment_credentials
WHEN OLD.status = 'active' AND NEW.status != 'active'
BEGIN
  UPDATE payment_integrations
  SET active_credential_id = NULL
  WHERE id = OLD.integration_id
    AND shop_id = OLD.shop_id
    AND provider = OLD.provider
    AND active_credential_id = OLD.id;
END;

CREATE TRIGGER payment_credentials_active_pointer_delete_guard
BEFORE DELETE ON payment_credentials
WHEN EXISTS (
  SELECT 1 FROM payment_integrations AS integration
  WHERE integration.id = OLD.integration_id
    AND integration.shop_id = OLD.shop_id
    AND integration.provider = OLD.provider
    AND integration.active_credential_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'payment_integration_active_credential_mismatch');
END;

CREATE TRIGGER payment_credentials_integration_insert_guard
BEFORE INSERT ON payment_credentials
WHEN NOT EXISTS (
  SELECT 1 FROM payment_integrations AS integration
  WHERE integration.id = NEW.integration_id
    AND integration.shop_id = NEW.shop_id
    AND integration.provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'payment_credential_integration_scope_mismatch');
END;

CREATE TRIGGER payment_credentials_integration_update_guard
BEFORE UPDATE OF shop_id, integration_id, provider ON payment_credentials
WHEN NOT EXISTS (
  SELECT 1 FROM payment_integrations AS integration
  WHERE integration.id = NEW.integration_id
    AND integration.shop_id = NEW.shop_id
    AND integration.provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'payment_credential_integration_scope_mismatch');
END;

CREATE TRIGGER payment_integrations_credentials_scope_update_guard
BEFORE UPDATE OF id, shop_id, provider ON payment_integrations
WHEN EXISTS (
  SELECT 1 FROM payment_credentials AS credential
  WHERE credential.shop_id = OLD.shop_id
    AND credential.integration_id = OLD.id
    AND (
      credential.integration_id != NEW.id
      OR credential.shop_id != NEW.shop_id
      OR credential.provider != NEW.provider
    )
)
BEGIN
  SELECT RAISE(ABORT, 'payment_credential_integration_scope_mismatch');
END;

CREATE TRIGGER payment_credentials_active_pointer_scope_update_guard
BEFORE UPDATE OF id, shop_id, integration_id, provider ON payment_credentials
WHEN EXISTS (
  SELECT 1 FROM payment_integrations AS integration
  WHERE integration.active_credential_id = OLD.id
    AND (
      NEW.id != OLD.id
      OR integration.id != NEW.integration_id
      OR integration.shop_id != NEW.shop_id
      OR integration.provider != NEW.provider
    )
)
BEGIN
  SELECT RAISE(ABORT, 'payment_integration_active_credential_mismatch');
END;

CREATE TRIGGER payment_attempts_order_insert_guard
BEFORE INSERT ON payment_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM orders
  WHERE orders.id = NEW.order_id
    AND orders.shop_id = NEW.shop_id
)
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_order_scope_mismatch');
END;

CREATE TRIGGER payment_attempts_order_update_guard
BEFORE UPDATE OF shop_id, order_id ON payment_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM orders
  WHERE orders.id = NEW.order_id
    AND orders.shop_id = NEW.shop_id
)
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_order_scope_mismatch');
END;

CREATE TRIGGER payment_attempts_integration_insert_guard
BEFORE INSERT ON payment_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM payment_integrations AS integration
  WHERE integration.id = NEW.integration_id
    AND integration.shop_id = NEW.shop_id
    AND integration.provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_integration_scope_mismatch');
END;

CREATE TRIGGER payment_attempts_integration_update_guard
BEFORE UPDATE OF shop_id, integration_id, provider ON payment_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM payment_integrations AS integration
  WHERE integration.id = NEW.integration_id
    AND integration.shop_id = NEW.shop_id
    AND integration.provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_integration_scope_mismatch');
END;

CREATE TRIGGER payment_attempts_credential_insert_guard
BEFORE INSERT ON payment_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM payment_credentials AS credential
  WHERE credential.id = NEW.credential_id
    AND credential.shop_id = NEW.shop_id
    AND credential.integration_id = NEW.integration_id
    AND credential.provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_credential_scope_mismatch');
END;

CREATE TRIGGER payment_attempts_credential_update_guard
BEFORE UPDATE OF shop_id, integration_id, credential_id, provider ON payment_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM payment_credentials AS credential
  WHERE credential.id = NEW.credential_id
    AND credential.shop_id = NEW.shop_id
    AND credential.integration_id = NEW.integration_id
    AND credential.provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_credential_scope_mismatch');
END;

CREATE TRIGGER payment_attempts_paid_event_insert_guard
BEFORE INSERT ON payment_attempts
WHEN NEW.paid_event_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM payment_events AS event
    WHERE event.id = NEW.paid_event_id
      AND event.payment_attempt_id = NEW.id
      AND event.shop_id = NEW.shop_id
      AND event.integration_id = NEW.integration_id
      AND event.provider = NEW.provider
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_paid_event_scope_mismatch');
END;

CREATE TRIGGER payment_attempts_paid_event_update_guard
BEFORE UPDATE OF id, shop_id, integration_id, provider, paid_event_id
ON payment_attempts
WHEN NEW.paid_event_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM payment_events AS event
    WHERE event.id = NEW.paid_event_id
      AND event.payment_attempt_id = NEW.id
      AND event.shop_id = NEW.shop_id
      AND event.integration_id = NEW.integration_id
      AND event.provider = NEW.provider
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_paid_event_scope_mismatch');
END;

CREATE TRIGGER orders_payment_attempts_scope_update_guard
BEFORE UPDATE OF id, shop_id ON orders
WHEN EXISTS (
  SELECT 1 FROM payment_attempts AS attempt
  WHERE attempt.shop_id = OLD.shop_id
    AND attempt.order_id = OLD.id
    AND (attempt.order_id != NEW.id OR attempt.shop_id != NEW.shop_id)
)
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_order_scope_mismatch');
END;

CREATE TRIGGER payment_integrations_attempts_scope_update_guard
BEFORE UPDATE OF id, shop_id, provider ON payment_integrations
WHEN EXISTS (
  SELECT 1 FROM payment_attempts AS attempt
  WHERE attempt.shop_id = OLD.shop_id
    AND attempt.integration_id = OLD.id
    AND (
      attempt.integration_id != NEW.id
      OR attempt.shop_id != NEW.shop_id
      OR attempt.provider != NEW.provider
    )
)
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_integration_scope_mismatch');
END;

CREATE TRIGGER payment_credentials_attempts_scope_update_guard
BEFORE UPDATE OF id, shop_id, integration_id, provider ON payment_credentials
WHEN EXISTS (
  SELECT 1 FROM payment_attempts AS attempt
  WHERE attempt.shop_id = OLD.shop_id
    AND attempt.credential_id = OLD.id
    AND (
      attempt.credential_id != NEW.id
      OR attempt.shop_id != NEW.shop_id
      OR attempt.integration_id != NEW.integration_id
      OR attempt.provider != NEW.provider
    )
)
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_credential_scope_mismatch');
END;

CREATE TRIGGER payment_events_integration_insert_guard
BEFORE INSERT ON payment_events
WHEN NOT EXISTS (
  SELECT 1 FROM payment_integrations AS integration
  WHERE integration.id = NEW.integration_id
    AND integration.shop_id = NEW.shop_id
    AND integration.provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'payment_event_integration_scope_mismatch');
END;

CREATE TRIGGER payment_events_integration_update_guard
BEFORE UPDATE OF shop_id, integration_id, provider ON payment_events
WHEN NOT EXISTS (
  SELECT 1 FROM payment_integrations AS integration
  WHERE integration.id = NEW.integration_id
    AND integration.shop_id = NEW.shop_id
    AND integration.provider = NEW.provider
)
BEGIN
  SELECT RAISE(ABORT, 'payment_event_integration_scope_mismatch');
END;

CREATE TRIGGER payment_events_attempt_insert_guard
BEFORE INSERT ON payment_events
WHEN NEW.payment_attempt_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM payment_attempts AS attempt
    WHERE attempt.id = NEW.payment_attempt_id
      AND attempt.shop_id = NEW.shop_id
      AND attempt.integration_id = NEW.integration_id
      AND attempt.provider = NEW.provider
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_event_attempt_scope_mismatch');
END;

CREATE TRIGGER payment_events_attempt_update_guard
BEFORE UPDATE OF shop_id, payment_attempt_id, integration_id, provider
ON payment_events
WHEN NEW.payment_attempt_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM payment_attempts AS attempt
    WHERE attempt.id = NEW.payment_attempt_id
      AND attempt.shop_id = NEW.shop_id
      AND attempt.integration_id = NEW.integration_id
      AND attempt.provider = NEW.provider
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_event_attempt_scope_mismatch');
END;

CREATE TRIGGER payment_integrations_events_scope_update_guard
BEFORE UPDATE OF id, shop_id, provider ON payment_integrations
WHEN EXISTS (
  SELECT 1 FROM payment_events AS event
  WHERE event.shop_id = OLD.shop_id
    AND event.integration_id = OLD.id
    AND (
      event.integration_id != NEW.id
      OR event.shop_id != NEW.shop_id
      OR event.provider != NEW.provider
    )
)
BEGIN
  SELECT RAISE(ABORT, 'payment_event_integration_scope_mismatch');
END;

CREATE TRIGGER payment_attempts_events_scope_update_guard
BEFORE UPDATE OF id, shop_id, integration_id, provider ON payment_attempts
WHEN EXISTS (
  SELECT 1 FROM payment_events AS event
  WHERE event.shop_id = OLD.shop_id
    AND event.payment_attempt_id = OLD.id
    AND (
      event.payment_attempt_id != NEW.id
      OR event.shop_id != NEW.shop_id
      OR event.integration_id != NEW.integration_id
      OR event.provider != NEW.provider
    )
)
BEGIN
  SELECT RAISE(ABORT, 'payment_event_attempt_scope_mismatch');
END;

CREATE TRIGGER payment_events_paid_attempt_scope_update_guard
BEFORE UPDATE OF id, shop_id, payment_attempt_id, integration_id, provider
ON payment_events
WHEN EXISTS (
  SELECT 1 FROM payment_attempts AS attempt
  WHERE attempt.paid_event_id = OLD.id
    AND (
      NEW.id != OLD.id
      OR NEW.payment_attempt_id IS NOT attempt.id
      OR NEW.shop_id != attempt.shop_id
      OR NEW.integration_id != attempt.integration_id
      OR NEW.provider != attempt.provider
    )
)
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_paid_event_scope_mismatch');
END;

CREATE TRIGGER payment_exceptions_order_insert_guard
BEFORE INSERT ON payment_exceptions
WHEN NOT EXISTS (
  SELECT 1 FROM orders
  WHERE orders.id = NEW.order_id
    AND orders.shop_id = NEW.shop_id
)
BEGIN
  SELECT RAISE(ABORT, 'payment_exception_order_scope_mismatch');
END;

CREATE TRIGGER payment_exceptions_order_update_guard
BEFORE UPDATE OF shop_id, order_id ON payment_exceptions
WHEN NOT EXISTS (
  SELECT 1 FROM orders
  WHERE orders.id = NEW.order_id
    AND orders.shop_id = NEW.shop_id
)
BEGIN
  SELECT RAISE(ABORT, 'payment_exception_order_scope_mismatch');
END;

CREATE TRIGGER payment_exceptions_attempt_insert_guard
BEFORE INSERT ON payment_exceptions
WHEN NOT EXISTS (
  SELECT 1 FROM payment_attempts AS attempt
  WHERE attempt.id = NEW.payment_attempt_id
    AND attempt.shop_id = NEW.shop_id
    AND attempt.order_id = NEW.order_id
)
BEGIN
  SELECT RAISE(ABORT, 'payment_exception_attempt_scope_mismatch');
END;

CREATE TRIGGER payment_exceptions_attempt_update_guard
BEFORE UPDATE OF shop_id, order_id, payment_attempt_id ON payment_exceptions
WHEN NOT EXISTS (
  SELECT 1 FROM payment_attempts AS attempt
  WHERE attempt.id = NEW.payment_attempt_id
    AND attempt.shop_id = NEW.shop_id
    AND attempt.order_id = NEW.order_id
)
BEGIN
  SELECT RAISE(ABORT, 'payment_exception_attempt_scope_mismatch');
END;

CREATE TRIGGER orders_payment_exceptions_scope_update_guard
BEFORE UPDATE OF id, shop_id ON orders
WHEN EXISTS (
  SELECT 1 FROM payment_exceptions AS exception
  WHERE exception.shop_id = OLD.shop_id
    AND exception.order_id = OLD.id
    AND (exception.order_id != NEW.id OR exception.shop_id != NEW.shop_id)
)
BEGIN
  SELECT RAISE(ABORT, 'payment_exception_order_scope_mismatch');
END;

CREATE TRIGGER payment_attempts_exceptions_scope_update_guard
BEFORE UPDATE OF id, shop_id, order_id ON payment_attempts
WHEN EXISTS (
  SELECT 1 FROM payment_exceptions AS exception
  WHERE exception.shop_id = OLD.shop_id
    AND exception.payment_attempt_id = OLD.id
    AND (
      exception.payment_attempt_id != NEW.id
      OR exception.shop_id != NEW.shop_id
      OR exception.order_id != NEW.order_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'payment_exception_attempt_scope_mismatch');
END;
