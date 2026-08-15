PRAGMA foreign_keys = ON;

-- Billing changes are intentionally requested, not applied, until a verified
-- subscription provider confirms the resulting entitlement state.
ALTER TABLE shop_subscriptions
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE UNIQUE INDEX idx_shop_subscriptions_shop_id
  ON shop_subscriptions(shop_id, id);

CREATE TABLE subscription_change_requests (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL,
  current_plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  requested_plan_id TEXT REFERENCES plans(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('change_plan', 'cancel', 'resume')),
  status TEXT NOT NULL CHECK (status IN (
    'requested', 'provider_pending', 'completed', 'rejected', 'canceled'
  )),
  expected_subscription_version INTEGER NOT NULL CHECK (expected_subscription_version > 0),
  reason_code TEXT NOT NULL CHECK (
    length(reason_code) BETWEEN 3 AND 64
    AND substr(reason_code, 1, 1) GLOB '[a-z]'
    AND reason_code NOT GLOB '*[^a-z0-9._:-]*'
  ),
  requested_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
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
  FOREIGN KEY (shop_id, subscription_id)
    REFERENCES shop_subscriptions(shop_id, id) ON DELETE RESTRICT,
  CHECK ((action = 'change_plan') = (requested_plan_id IS NOT NULL)),
  CHECK (action != 'change_plan' OR requested_plan_id != current_plan_id),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((status IN ('provider_pending', 'rejected')) = (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX idx_subscription_change_requests_active
  ON subscription_change_requests(shop_id)
  WHERE status IN ('requested', 'provider_pending');

CREATE INDEX idx_subscription_change_requests_shop_status
  ON subscription_change_requests(shop_id, status, created_at DESC, id);

CREATE TABLE order_messages (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  channel_code TEXT NOT NULL CHECK (channel_code IN ('web', 'telegram')),
  direction TEXT NOT NULL CHECK (direction = 'seller_to_buyer'),
  status TEXT NOT NULL CHECK (status IN (
    'provider_pending', 'sent', 'failed', 'canceled', 'redacted'
  )),
  body TEXT NOT NULL CHECK (
    (status = 'redacted' AND body = '')
    OR (length(body) BETWEEN 1 AND 4000)
  ),
  provider_capability TEXT NOT NULL DEFAULT 'message.rich_ui' CHECK (
    provider_capability = 'message.rich_ui'
  ),
  provider_reference_hash TEXT,
  failure_code TEXT,
  redacted_at TEXT,
  sent_at TEXT,
  canceled_at TEXT,
  idempotency_key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, idempotency_key_hash),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id) ON DELETE RESTRICT,
  CHECK (status != 'sent' OR (sent_at IS NOT NULL AND provider_reference_hash IS NOT NULL)),
  CHECK (status != 'failed' OR failure_code IS NOT NULL),
  CHECK (status != 'canceled' OR canceled_at IS NOT NULL),
  CHECK (status != 'redacted' OR redacted_at IS NOT NULL)
) STRICT;

CREATE INDEX idx_order_messages_shop_order
  ON order_messages(shop_id, order_id, created_at ASC, id);

CREATE INDEX idx_order_messages_provider_pending
  ON order_messages(status, updated_at ASC, id)
  WHERE status = 'provider_pending';

CREATE TABLE payment_remediation_requests (
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
  CHECK ((status IN ('provider_pending', 'rejected')) = (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (status != 'completed' OR provider_reference_hash IS NOT NULL),
  CHECK (status != 'failed' OR failure_code IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX idx_payment_remediation_requests_active_exception
  ON payment_remediation_requests(shop_id, payment_exception_id)
  WHERE status IN ('requested', 'provider_pending');

CREATE INDEX idx_payment_remediation_requests_shop_status
  ON payment_remediation_requests(shop_id, status, created_at DESC, id);

CREATE INDEX idx_payment_remediation_requests_admin_status
  ON payment_remediation_requests(status, created_at DESC, id);

-- Keep denormalized tenant and aggregate references bound at the database
-- boundary as well as in the application services.
CREATE TRIGGER subscription_change_requests_scope_insert_guard
BEFORE INSERT ON subscription_change_requests
WHEN NOT EXISTS (
  SELECT 1 FROM shop_subscriptions AS subscriptions
  WHERE subscriptions.id = NEW.subscription_id
    AND subscriptions.shop_id = NEW.shop_id
    AND subscriptions.plan_id = NEW.current_plan_id
    AND subscriptions.version = NEW.expected_subscription_version
)
OR NOT EXISTS (
  SELECT 1 FROM shop_members AS members
  WHERE members.shop_id = NEW.shop_id
    AND members.user_id = NEW.requested_by_user_id
    AND members.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'subscription_change_request_scope_mismatch');
END;

CREATE TRIGGER order_messages_author_scope_insert_guard
BEFORE INSERT ON order_messages
WHEN NOT EXISTS (
  SELECT 1 FROM shop_members AS members
  WHERE members.shop_id = NEW.shop_id
    AND members.user_id = NEW.author_user_id
    AND members.status = 'active'
)
OR NOT EXISTS (
  SELECT 1 FROM orders
  WHERE orders.id = NEW.order_id
    AND orders.shop_id = NEW.shop_id
    AND orders.status NOT IN ('expired', 'canceled')
)
BEGIN
  SELECT RAISE(ABORT, 'order_message_author_scope_mismatch');
END;

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

CREATE TRIGGER subscription_change_requests_transition_guard
BEFORE UPDATE ON subscription_change_requests
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.subscription_id != OLD.subscription_id
  OR NEW.current_plan_id != OLD.current_plan_id
  OR NEW.requested_plan_id IS NOT OLD.requested_plan_id
  OR NEW.action != OLD.action
  OR NEW.expected_subscription_version != OLD.expected_subscription_version
  OR NEW.reason_code != OLD.reason_code
  OR NEW.requested_by_user_id != OLD.requested_by_user_id
  OR NEW.idempotency_key_hash != OLD.idempotency_key_hash
  OR NEW.request_hash != OLD.request_hash
  OR (NEW.reviewed_by_user_id IS NOT OLD.reviewed_by_user_id AND NEW.status NOT IN ('provider_pending', 'rejected'))
  OR (NEW.reviewed_at IS NOT OLD.reviewed_at AND NEW.status NOT IN ('provider_pending', 'rejected'))
  OR (NEW.completed_at IS NOT OLD.completed_at AND NEW.status != 'completed')
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR OLD.status IN ('completed', 'canceled', 'rejected')
  OR NOT (
    (OLD.status = 'requested' AND NEW.status IN ('requested', 'provider_pending', 'rejected', 'canceled'))
    OR (OLD.status = 'provider_pending' AND NEW.status IN ('provider_pending', 'completed', 'rejected', 'canceled'))
  )
BEGIN
  SELECT RAISE(ABORT, 'subscription_change_request_transition_invalid');
END;

CREATE TRIGGER subscription_change_requests_no_delete
BEFORE DELETE ON subscription_change_requests
BEGIN
  SELECT RAISE(ABORT, 'subscription_change_request_immutable');
END;

CREATE TRIGGER order_messages_transition_guard
BEFORE UPDATE ON order_messages
WHEN NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.order_id != OLD.order_id
  OR NEW.author_user_id != OLD.author_user_id
  OR NEW.channel_code != OLD.channel_code
  OR NEW.direction != OLD.direction
  OR NEW.body != OLD.body AND NEW.status != 'redacted'
  OR NEW.provider_capability != OLD.provider_capability
  OR (NEW.provider_reference_hash IS NOT OLD.provider_reference_hash AND NEW.status != 'sent')
  OR (NEW.failure_code IS NOT OLD.failure_code AND NEW.status != 'failed')
  OR (NEW.sent_at IS NOT OLD.sent_at AND NEW.status != 'sent')
  OR (NEW.canceled_at IS NOT OLD.canceled_at AND NEW.status != 'canceled')
  OR (NEW.redacted_at IS NOT OLD.redacted_at AND NEW.status != 'redacted')
  OR NEW.idempotency_key_hash != OLD.idempotency_key_hash
  OR NEW.request_hash != OLD.request_hash
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR OLD.status IN ('sent', 'canceled', 'redacted')
  OR NOT (
    (OLD.status = 'provider_pending' AND NEW.status IN ('provider_pending', 'sent', 'failed', 'canceled', 'redacted'))
    OR (OLD.status = 'failed' AND NEW.status IN ('failed', 'provider_pending', 'canceled', 'redacted'))
  )
BEGIN
  SELECT RAISE(ABORT, 'order_message_transition_invalid');
END;

CREATE TRIGGER order_messages_no_delete
BEFORE DELETE ON order_messages
BEGIN
  SELECT RAISE(ABORT, 'order_message_immutable');
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
