PRAGMA foreign_keys = ON;

-- Reversal evidence is provider-authenticated before it reaches this table.
-- Store only normalized metadata and one-way fingerprints; raw provider
-- payloads, references, credentials and secrets remain outside D1 ledgers.
CREATE TABLE payment_reversal_events (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  payment_attempt_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  original_payment_event_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (
    length(provider) BETWEEN 2 AND 64
    AND substr(provider, 1, 1) GLOB '[a-z]'
    AND provider NOT GLOB '*[^a-z0-9._-]*'
  ),
  reversal_kind TEXT NOT NULL CHECK (reversal_kind IN ('refund', 'chargeback')),
  decision TEXT NOT NULL CHECK (decision IN (
    'full_refund', 'chargeback', 'partial', 'mismatch', 'manual_review'
  )),
  verification_method TEXT NOT NULL CHECK (
    verification_method IN ('signed_webhook', 'direct_reconciliation')
  ),
  evidence_verified INTEGER NOT NULL CHECK (evidence_verified = 1),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  expected_amount_minor INTEGER NOT NULL CHECK (expected_amount_minor > 0),
  currency TEXT NOT NULL CHECK (
    length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'
  ),
  expected_currency TEXT NOT NULL CHECK (
    length(expected_currency) = 3 AND expected_currency NOT GLOB '*[^A-Z]*'
  ),
  provider_reference_hash TEXT NOT NULL CHECK (
    length(provider_reference_hash) = 43
    AND provider_reference_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  provider_reference_hash_key_version TEXT NOT NULL CHECK (
    provider_reference_hash_key_version = 'identifier-hmac-v1'
  ),
  evidence_hash TEXT NOT NULL CHECK (
    length(evidence_hash) = 43
    AND evidence_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 43
    AND idempotency_key_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 43
    AND request_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  reason_code TEXT NOT NULL CHECK (
    length(reason_code) BETWEEN 3 AND 64
    AND substr(reason_code, 1, 1) GLOB '[a-z]'
    AND reason_code NOT GLOB '*[^a-z0-9._:-]*'
  ),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, idempotency_key_hash),
  UNIQUE (shop_id, integration_id, provider, provider_reference_hash),
  FOREIGN KEY (shop_id, order_id)
    REFERENCES orders(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, payment_attempt_id)
    REFERENCES payment_attempts(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, integration_id)
    REFERENCES payment_integrations(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, credential_id)
    REFERENCES payment_credentials(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, original_payment_event_id)
    REFERENCES payment_events(shop_id, id) ON DELETE RESTRICT,
  CHECK (
    (reversal_kind = 'refund' AND decision IN (
      'full_refund', 'partial', 'mismatch', 'manual_review'
    ))
    OR (reversal_kind = 'chargeback' AND decision IN (
      'chargeback', 'partial', 'mismatch', 'manual_review'
    ))
  ),
  CHECK (
    decision NOT IN ('full_refund', 'chargeback')
    OR (
      amount_minor = expected_amount_minor
      AND currency = expected_currency
      AND reason_code IN ('payment_full_refund', 'payment_chargeback')
    )
  ),
  CHECK (
    (decision = 'full_refund' AND reason_code = 'payment_full_refund')
    OR (decision = 'chargeback' AND reason_code = 'payment_chargeback')
    OR (decision = 'partial' AND reason_code = 'payment_reversal_partial')
    OR (decision = 'mismatch' AND reason_code = 'payment_reversal_mismatch')
    OR (decision = 'manual_review' AND reason_code = 'payment_reversal_manual_review')
  )
) STRICT;

CREATE INDEX idx_payment_reversal_events_shop_order
  ON payment_reversal_events(shop_id, order_id, created_at DESC, id);

CREATE INDEX idx_payment_reversal_events_shop_attempt
  ON payment_reversal_events(shop_id, payment_attempt_id, created_at DESC, id);

CREATE INDEX idx_payment_reversal_events_shop_decision
  ON payment_reversal_events(shop_id, decision, created_at DESC, id);

-- The copied expectation must agree with both the original exact-payment
-- attempt and the order. A revoking decision additionally requires the order
-- to still be paid when the atomic application transaction starts.
CREATE TRIGGER payment_reversal_events_scope_guard_insert
BEFORE INSERT ON payment_reversal_events
WHEN NOT EXISTS (
  SELECT 1
  FROM payment_attempts AS attempt
  INNER JOIN orders
    ON orders.id = attempt.order_id
    AND orders.shop_id = attempt.shop_id
  INNER JOIN payment_integrations AS integration
    ON integration.id = attempt.integration_id
    AND integration.shop_id = attempt.shop_id
    AND integration.provider = attempt.provider
  INNER JOIN payment_credentials AS credential
    ON credential.id = attempt.credential_id
    AND credential.shop_id = attempt.shop_id
    AND credential.integration_id = attempt.integration_id
    AND credential.provider = attempt.provider
  INNER JOIN payment_events AS paid_event
    ON paid_event.id = attempt.paid_event_id
    AND paid_event.payment_attempt_id = attempt.id
    AND paid_event.shop_id = attempt.shop_id
    AND paid_event.integration_id = attempt.integration_id
    AND paid_event.provider = attempt.provider
  WHERE attempt.id = NEW.payment_attempt_id
    AND attempt.shop_id = NEW.shop_id
    AND attempt.order_id = NEW.order_id
    AND attempt.integration_id = NEW.integration_id
    AND attempt.credential_id = NEW.credential_id
    AND attempt.provider = NEW.provider
    AND attempt.state = 'paid_exact'
    AND credential.version = NEW.credential_version
    AND paid_event.id = NEW.original_payment_event_id
    AND paid_event.signature_verified = 1
    AND paid_event.normalized_state = 'paid_exact'
    AND paid_event.process_result = 'fulfilled'
    AND paid_event.processed_at IS NOT NULL
    AND attempt.expected_amount_minor = NEW.expected_amount_minor
    AND orders.total_minor = NEW.expected_amount_minor
    AND attempt.currency = NEW.expected_currency
    AND orders.currency = NEW.expected_currency
    AND orders.payment_status IN ('paid', 'refunded')
    AND orders.status IN ('processing', 'completed')
    AND (
      NEW.decision NOT IN ('full_refund', 'chargeback')
      OR orders.payment_status = 'paid'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'payment_reversal_scope_mismatch');
END;

CREATE TRIGGER payment_reversal_events_immutable_update
BEFORE UPDATE ON payment_reversal_events
BEGIN
  SELECT RAISE(ABORT, 'payment_reversal_event_immutable');
END;

CREATE TRIGGER payment_reversal_events_immutable_delete
BEFORE DELETE ON payment_reversal_events
BEGIN
  SELECT RAISE(ABORT, 'payment_reversal_event_immutable');
END;
