PRAGMA foreign_keys = OFF;

-- Migration 0076 rebuilt the parent billing tables. On remote D1, three
-- pre-existing child tables retained foreign keys to the temporary
-- *_legacy_0076 names after those parents were dropped. Rebuild the children
-- so webhook transitions, seller subscription changes, and usage events point
-- at the canonical subscription/provider ledgers again.
DROP TRIGGER IF EXISTS subscription_change_requests_scope_insert_guard;
DROP TRIGGER IF EXISTS subscription_change_requests_transition_guard;
DROP TRIGGER IF EXISTS subscription_change_requests_reconciliation_guard;
DROP TRIGGER IF EXISTS subscription_change_requests_no_delete;
DROP TRIGGER IF EXISTS subscription_events_provider_scope_guard;
DROP TRIGGER IF EXISTS subscription_events_no_update;
DROP TRIGGER IF EXISTS subscription_events_no_delete;
DROP TRIGGER IF EXISTS usage_events_no_update;
DROP TRIGGER IF EXISTS usage_events_no_delete;
-- These triggers live on shop_subscriptions but reference the request table.
-- Drop them before the rename so SQLite cannot rewrite their SQL to the
-- temporary legacy table name.
DROP TRIGGER IF EXISTS shop_subscriptions_scheduled_target_guard;
DROP TRIGGER IF EXISTS shop_subscriptions_scheduled_target_update_guard;

CREATE TABLE subscription_change_requests_repair_0110 (
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
  provider_action_ref TEXT CHECK (
    provider_action_ref IS NULL OR (
      length(provider_action_ref) BETWEEN 3 AND 160
      AND provider_action_ref NOT GLOB '*[[:space:]]*'
    )
  ),
  provider_event_id TEXT,
  failure_code TEXT CHECK (
    failure_code IS NULL OR (
      length(failure_code) BETWEEN 3 AND 96
      AND failure_code NOT GLOB '*[^a-zA-Z0-9._:-]*'
    )
  ),
  execution_attempts INTEGER NOT NULL DEFAULT 0 CHECK (execution_attempts >= 0),
  last_attempt_at TEXT,
  provider_acknowledged_at TEXT,
  reconciliation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_attempts >= 0),
  next_reconciliation_at TEXT,
  last_reconciliation_at TEXT,
  reconciliation_failure_code TEXT CHECK (
    reconciliation_failure_code IS NULL OR (
      length(reconciliation_failure_code) BETWEEN 3 AND 96
      AND reconciliation_failure_code NOT GLOB '*[^a-zA-Z0-9._:-]*'
    )
  ),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, idempotency_key_hash),
  FOREIGN KEY (shop_id, subscription_id)
    REFERENCES shop_subscriptions(shop_id, id) ON DELETE RESTRICT,
  CHECK ((action = 'change_plan') = (requested_plan_id IS NOT NULL)),
  CHECK (action != 'change_plan' OR requested_plan_id != current_plan_id),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((status IN ('provider_pending', 'rejected')) =
    (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL))
) STRICT;

INSERT INTO subscription_change_requests_repair_0110 (
  id, public_id, shop_id, subscription_id, current_plan_id, requested_plan_id,
  action, status, expected_subscription_version, reason_code,
  requested_by_user_id, reviewed_by_user_id, reviewed_at, completed_at,
  idempotency_key_hash, request_hash, version, created_at, updated_at,
  provider_action_ref, provider_event_id, failure_code, execution_attempts,
  last_attempt_at, provider_acknowledged_at, reconciliation_attempts,
  next_reconciliation_at, last_reconciliation_at, reconciliation_failure_code
)
SELECT
  id, public_id, shop_id, subscription_id, current_plan_id, requested_plan_id,
  action, status, expected_subscription_version, reason_code,
  requested_by_user_id, reviewed_by_user_id, reviewed_at, completed_at,
  idempotency_key_hash, request_hash, version, created_at, updated_at,
  provider_action_ref, provider_event_id, failure_code, execution_attempts,
  last_attempt_at, provider_acknowledged_at, reconciliation_attempts,
  next_reconciliation_at, last_reconciliation_at, reconciliation_failure_code
FROM subscription_change_requests;

CREATE TABLE subscription_events_repair_0110 (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL,
  provider_event_id TEXT REFERENCES billing_provider_events(id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('provider', 'system', 'user', 'reconciliation')),
  event_type TEXT NOT NULL CHECK (
    length(event_type) BETWEEN 3 AND 96
    AND event_type NOT GLOB '*[^a-zA-Z0-9._:-]*'
  ),
  from_state TEXT,
  to_state TEXT NOT NULL CHECK (to_state IN (
    'pending_payment', 'trialing', 'active', 'past_due', 'grace_period',
    'suspended', 'cancel_scheduled', 'upgrade_pending',
    'downgrade_scheduled', 'canceled'
  )),
  event_hash TEXT NOT NULL CHECK (
    length(event_hash) BETWEEN 32 AND 128
    AND event_hash NOT GLOB '*[[:space:]]*'
  ),
  safe_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(safe_metadata_json)),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, subscription_id, event_hash),
  FOREIGN KEY (shop_id, subscription_id)
    REFERENCES shop_subscriptions(shop_id, id) ON DELETE RESTRICT,
  CHECK (from_state IS NULL OR from_state IN (
    'pending_payment', 'trialing', 'active', 'past_due', 'grace_period',
    'suspended', 'cancel_scheduled', 'upgrade_pending',
    'downgrade_scheduled', 'canceled'
  ))
) STRICT;

INSERT INTO subscription_events_repair_0110 (
  id, shop_id, subscription_id, provider_event_id, source_kind, event_type,
  from_state, to_state, event_hash, safe_metadata_json, occurred_at, created_at
)
SELECT
  id, shop_id, subscription_id, provider_event_id, source_kind, event_type,
  from_state, to_state, event_hash, safe_metadata_json, occurred_at, created_at
FROM subscription_events;

CREATE TABLE usage_events_repair_0110 (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  subscription_id TEXT,
  metric TEXT NOT NULL CHECK (
    length(metric) BETWEEN 3 AND 96
    AND substr(metric, 1, 1) GLOB '[a-z]'
    AND metric NOT GLOB '*[^a-z0-9._:-]*'
  ),
  period_kind TEXT NOT NULL CHECK (period_kind IN ('trial', 'billing', 'calendar', 'lifetime')),
  period_key TEXT NOT NULL CHECK (
    length(period_key) BETWEEN 3 AND 160
    AND period_key NOT GLOB '*[[:space:]]*'
  ),
  source_kind TEXT NOT NULL CHECK (
    length(source_kind) BETWEEN 3 AND 64
    AND substr(source_kind, 1, 1) GLOB '[a-z]'
    AND source_kind NOT GLOB '*[^a-z0-9._:-]*'
  ),
  source_id TEXT NOT NULL CHECK (
    length(source_id) BETWEEN 1 AND 160
    AND source_id NOT GLOB '*[[:space:]]*'
  ),
  delta INTEGER NOT NULL CHECK (delta > 0),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, metric, period_key, source_kind, source_id),
  FOREIGN KEY (shop_id, subscription_id)
    REFERENCES shop_subscriptions(shop_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO usage_events_repair_0110 (
  id, shop_id, subscription_id, metric, period_kind, period_key,
  source_kind, source_id, delta, occurred_at, created_at
)
SELECT
  id, shop_id, subscription_id, metric, period_kind, period_key,
  source_kind, source_id, delta, occurred_at, created_at
FROM usage_events;

DROP TABLE subscription_change_requests;
DROP TABLE subscription_events;
DROP TABLE usage_events;

ALTER TABLE subscription_change_requests_repair_0110 RENAME TO subscription_change_requests;
ALTER TABLE subscription_events_repair_0110 RENAME TO subscription_events;
ALTER TABLE usage_events_repair_0110 RENAME TO usage_events;

CREATE UNIQUE INDEX idx_subscription_change_requests_active
  ON subscription_change_requests(shop_id)
  WHERE status IN ('requested', 'provider_pending');
CREATE INDEX idx_subscription_change_requests_shop_status
  ON subscription_change_requests(shop_id, status, created_at DESC, id);
CREATE INDEX idx_subscription_change_requests_execution
  ON subscription_change_requests(shop_id, status, last_attempt_at, id);
CREATE INDEX idx_subscription_change_requests_reconciliation
  ON subscription_change_requests(shop_id, status, next_reconciliation_at, id)
  WHERE status = 'provider_pending';
CREATE INDEX idx_subscription_change_requests_request_subscription
  ON subscription_change_requests(shop_id, subscription_id, status, created_at, id);

CREATE INDEX idx_subscription_events_shop_created
  ON subscription_events(shop_id, created_at DESC, id);
CREATE INDEX idx_subscription_events_subscription
  ON subscription_events(shop_id, subscription_id, occurred_at, id);

CREATE INDEX idx_usage_events_shop_period
  ON usage_events(shop_id, period_kind, period_key, metric, occurred_at, id);
CREATE INDEX idx_usage_events_subscription
  ON usage_events(shop_id, subscription_id, occurred_at, id)
  WHERE subscription_id IS NOT NULL;
CREATE INDEX idx_usage_events_source
  ON usage_events(source_kind, source_id, occurred_at, id);

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
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR NEW.execution_attempts < OLD.execution_attempts
  OR NEW.execution_attempts > OLD.execution_attempts + 1
  OR (NEW.reviewed_by_user_id IS NOT OLD.reviewed_by_user_id AND NEW.status NOT IN ('requested', 'provider_pending', 'rejected', 'completed'))
  OR (NEW.reviewed_at IS NOT OLD.reviewed_at AND NEW.status NOT IN ('requested', 'provider_pending', 'rejected', 'completed'))
  OR (NEW.provider_action_ref IS NOT OLD.provider_action_ref AND NEW.status NOT IN ('requested', 'provider_pending', 'completed', 'rejected'))
  OR (NEW.provider_event_id IS NOT OLD.provider_event_id AND NEW.status != 'completed')
  OR (NEW.last_attempt_at IS NOT OLD.last_attempt_at AND NEW.status NOT IN ('requested', 'provider_pending', 'rejected'))
  OR OLD.status IN ('completed', 'canceled', 'rejected')
  OR NOT (
    (OLD.status = 'requested' AND NEW.status IN ('requested', 'provider_pending', 'rejected', 'canceled'))
    OR (OLD.status = 'provider_pending' AND NEW.status IN ('provider_pending', 'requested', 'completed', 'rejected', 'canceled'))
  )
BEGIN
  SELECT RAISE(ABORT, 'subscription_change_request_transition_invalid');
END;

CREATE TRIGGER subscription_change_requests_reconciliation_guard
BEFORE UPDATE OF provider_acknowledged_at, reconciliation_attempts,
  next_reconciliation_at, last_reconciliation_at, reconciliation_failure_code
ON subscription_change_requests
WHEN NEW.reconciliation_attempts < OLD.reconciliation_attempts
  OR NEW.reconciliation_attempts > OLD.reconciliation_attempts + 1
  OR (NEW.provider_acknowledged_at IS NOT OLD.provider_acknowledged_at
      AND NEW.status NOT IN ('provider_pending', 'completed'))
  OR (NEW.next_reconciliation_at IS NOT OLD.next_reconciliation_at
      AND NEW.status NOT IN ('provider_pending', 'completed', 'rejected'))
  OR (NEW.last_reconciliation_at IS NOT OLD.last_reconciliation_at
      AND NEW.status NOT IN ('provider_pending', 'completed', 'rejected'))
  OR (NEW.reconciliation_failure_code IS NOT OLD.reconciliation_failure_code
      AND NEW.status NOT IN ('provider_pending', 'completed', 'rejected'))
BEGIN
  SELECT RAISE(ABORT, 'subscription_reconciliation_transition_invalid');
END;

CREATE TRIGGER subscription_change_requests_no_delete
BEFORE DELETE ON subscription_change_requests
BEGIN
  SELECT RAISE(ABORT, 'subscription_change_request_immutable');
END;

CREATE TRIGGER shop_subscriptions_scheduled_target_guard
BEFORE INSERT ON shop_subscriptions
WHEN (
    (NEW.scheduled_plan_id IS NULL) != (NEW.scheduled_price_id IS NULL)
    OR (NEW.scheduled_plan_id IS NULL) != (NEW.scheduled_effective_at IS NULL)
    OR NEW.scheduled_plan_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM plan_prices AS prices
      WHERE prices.id = NEW.scheduled_price_id
        AND prices.plan_id = NEW.scheduled_plan_id
        AND prices.provider_code = NEW.billing_provider_code
        AND prices.market_code = NEW.market_code
        AND prices.currency = NEW.price_currency
        AND prices.interval = 'month'
    )
    OR NEW.scheduled_change_request_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM subscription_change_requests AS requests
      WHERE requests.id = NEW.scheduled_change_request_id
        AND requests.shop_id = NEW.shop_id
        AND requests.subscription_id = NEW.id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'subscription_scheduled_target_scope_mismatch');
END;

CREATE TRIGGER shop_subscriptions_scheduled_target_update_guard
BEFORE UPDATE OF scheduled_plan_id, scheduled_price_id, scheduled_effective_at,
  scheduled_change_request_id, billing_provider_code, market_code, price_currency
ON shop_subscriptions
WHEN (
    (NEW.scheduled_plan_id IS NULL) != (NEW.scheduled_price_id IS NULL)
    OR (NEW.scheduled_plan_id IS NULL) != (NEW.scheduled_effective_at IS NULL)
    OR NEW.scheduled_plan_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM plan_prices AS prices
      WHERE prices.id = NEW.scheduled_price_id
        AND prices.plan_id = NEW.scheduled_plan_id
        AND prices.provider_code = NEW.billing_provider_code
        AND prices.market_code = NEW.market_code
        AND prices.currency = NEW.price_currency
        AND prices.interval = 'month'
    )
    OR NEW.scheduled_change_request_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM subscription_change_requests AS requests
      WHERE requests.id = NEW.scheduled_change_request_id
        AND requests.shop_id = NEW.shop_id
        AND requests.subscription_id = NEW.id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'subscription_scheduled_target_scope_mismatch');
END;

CREATE TRIGGER subscription_events_provider_scope_guard
BEFORE INSERT ON subscription_events
WHEN NEW.source_kind = 'provider'
  AND NEW.provider_event_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM billing_provider_events AS events
    WHERE events.id = NEW.provider_event_id
      AND events.shop_id = NEW.shop_id
  )
BEGIN
  SELECT RAISE(ABORT, 'subscription_event_provider_scope_mismatch');
END;

CREATE TRIGGER subscription_events_no_update
BEFORE UPDATE ON subscription_events
BEGIN
  SELECT RAISE(ABORT, 'subscription_event_immutable');
END;

CREATE TRIGGER subscription_events_no_delete
BEFORE DELETE ON subscription_events
BEGIN
  SELECT RAISE(ABORT, 'subscription_event_immutable');
END;

CREATE TRIGGER usage_events_no_update
BEFORE UPDATE ON usage_events
BEGIN
  SELECT RAISE(ABORT, 'usage_event_immutable');
END;

CREATE TRIGGER usage_events_no_delete
BEFORE DELETE ON usage_events
BEGIN
  SELECT RAISE(ABORT, 'usage_event_immutable');
END;

-- A result-only PRAGMA does not fail a migration. Convert any remaining
-- violation count into a CHECK failure so every SQLite executor is fail-closed.
CREATE TABLE subscription_ledger_fk_guard_0110 (
  violation_count INTEGER NOT NULL CHECK (violation_count = 0)
) STRICT;
INSERT INTO subscription_ledger_fk_guard_0110 (violation_count)
SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE subscription_ledger_fk_guard_0110;
PRAGMA foreign_keys = ON;
