-- Terminal remediation completion support.
--
-- Migration 0054 enforced the biconditional CHECK
--   (status IN ('provider_pending', 'rejected'))
--     = (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
-- which, combined with the transition guard forbidding reviewed-field changes
-- outside provider_pending/rejected, made 'completed' and 'failed'
-- unreachable from provider_pending: approved requests were stranded forever.
-- SQLite cannot drop CHECK constraints in place, so rebuild the table with
-- review invariants that keep the approval trail intact on terminal
-- transitions: reviewed fields stay required at approval time and may be
-- retained by terminal states, while pre-review states must not carry them.

CREATE TABLE payment_remediation_requests_new (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  payment_exception_id TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('refund', 'partial_refund', 'manual_review')),
  status TEXT NOT NULL CHECK (status IN (
    'requested', 'provider_pending', 'completed', 'rejected', 'canceled', 'failed'
  )),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  reason_code TEXT NOT NULL CHECK (
    length(reason_code) BETWEEN 3 AND 64
    AND substr(reason_code, 1, 1) GLOB '[a-z]'
    AND reason_code NOT GLOB '*[^a-z0-9._:-]*'
  ),
  provider_reference_hash TEXT,
  failure_code TEXT,
  reviewed_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  completed_at TEXT,
  idempotency_key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, idempotency_key_hash),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, payment_exception_id) REFERENCES payment_exceptions(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK (status NOT IN ('provider_pending', 'rejected')
    OR (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (status IN ('provider_pending', 'rejected', 'completed', 'failed')
    OR (reviewed_by_user_id IS NULL AND reviewed_at IS NULL)),
  CHECK (status != 'completed' OR provider_reference_hash IS NOT NULL),
  CHECK (status != 'failed' OR failure_code IS NOT NULL)
) STRICT;

INSERT INTO payment_remediation_requests_new (
  id, public_id, shop_id, order_id, payment_exception_id, requested_by_user_id,
  kind, status, amount_minor, currency, reason_code, provider_reference_hash,
  failure_code, reviewed_by_user_id, reviewed_at, completed_at,
  idempotency_key_hash, request_hash, version, created_at, updated_at
)
SELECT
  id, public_id, shop_id, order_id, payment_exception_id, requested_by_user_id,
  kind, status, amount_minor, currency, reason_code, provider_reference_hash,
  failure_code, reviewed_by_user_id, reviewed_at, completed_at,
  idempotency_key_hash, request_hash, version, created_at, updated_at
FROM payment_remediation_requests;

DROP TABLE payment_remediation_requests;

ALTER TABLE payment_remediation_requests_new RENAME TO payment_remediation_requests;

CREATE UNIQUE INDEX idx_payment_remediation_requests_active_exception
  ON payment_remediation_requests(shop_id, payment_exception_id)
  WHERE status IN ('requested', 'provider_pending');

CREATE INDEX idx_payment_remediation_requests_shop_status
  ON payment_remediation_requests(shop_id, status, created_at DESC, id);

CREATE INDEX idx_payment_remediation_requests_admin_status
  ON payment_remediation_requests(status, created_at DESC, id);

CREATE TRIGGER payment_remediation_requests_scope_insert_guard
BEFORE INSERT ON payment_remediation_requests
WHEN NOT EXISTS (
  SELECT 1 FROM payment_exceptions AS exceptions
  WHERE exceptions.id = NEW.payment_exception_id
    AND exceptions.shop_id = NEW.shop_id
    AND exceptions.order_id = NEW.order_id
    AND exceptions.status = 'open'
)
OR NOT EXISTS (
  SELECT 1 FROM shop_members AS members
  WHERE members.shop_id = NEW.shop_id
    AND members.user_id = NEW.requested_by_user_id
    AND members.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'payment_remediation_request_scope_mismatch');
END;

CREATE TRIGGER payment_remediation_requests_transition_guard
BEFORE UPDATE ON payment_remediation_requests
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.order_id != OLD.order_id
  OR NEW.payment_exception_id != OLD.payment_exception_id
  OR NEW.requested_by_user_id != OLD.requested_by_user_id
  OR NEW.kind != OLD.kind
  OR NEW.amount_minor != OLD.amount_minor
  OR NEW.currency != OLD.currency
  OR NEW.reason_code != OLD.reason_code
  OR NEW.idempotency_key_hash != OLD.idempotency_key_hash
  OR NEW.request_hash != OLD.request_hash
  OR (NEW.provider_reference_hash IS NOT OLD.provider_reference_hash AND NEW.status != 'completed')
  OR (NEW.reviewed_by_user_id IS NOT OLD.reviewed_by_user_id
    AND NEW.status NOT IN ('provider_pending', 'rejected')
    AND NOT (OLD.status = 'failed' AND NEW.status = 'requested'))
  OR (NEW.reviewed_at IS NOT OLD.reviewed_at
    AND NEW.status NOT IN ('provider_pending', 'rejected')
    AND NOT (OLD.status = 'failed' AND NEW.status = 'requested'))
  OR (NEW.completed_at IS NOT OLD.completed_at AND NEW.status != 'completed')
  OR (NEW.failure_code IS NOT OLD.failure_code AND NEW.status != 'failed')
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR OLD.status IN ('completed', 'canceled', 'rejected')
  OR NOT (
    (OLD.status = 'requested' AND NEW.status IN ('requested', 'provider_pending', 'rejected', 'canceled', 'failed'))
    OR (OLD.status = 'provider_pending' AND NEW.status IN ('provider_pending', 'completed', 'rejected', 'canceled', 'failed'))
    OR (OLD.status = 'failed' AND NEW.status IN ('failed', 'requested', 'canceled'))
  )
BEGIN
  SELECT RAISE(ABORT, 'payment_remediation_request_transition_invalid');
END;

CREATE TRIGGER payment_remediation_requests_no_delete
BEFORE DELETE ON payment_remediation_requests
BEGIN
  SELECT RAISE(ABORT, 'payment_remediation_request_immutable');
END;
