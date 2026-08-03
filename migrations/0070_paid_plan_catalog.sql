PRAGMA foreign_keys = OFF;

-- The original subscription table has a closed state CHECK. Rebuild the two
-- tables that reference it so the state machine can accept paid-only
-- pending-payment and scheduled transition states without mutating an
-- already-applied migration.
ALTER TABLE subscription_change_requests RENAME TO subscription_change_requests_legacy_0070;
ALTER TABLE shop_subscriptions RENAME TO shop_subscriptions_legacy_0070;

-- Renaming a table preserves trigger names; remove the legacy guards before
-- recreating them on the replacement table.
DROP TRIGGER IF EXISTS subscription_change_requests_scope_insert_guard;
DROP TRIGGER IF EXISTS subscription_change_requests_transition_guard;
DROP TRIGGER IF EXISTS subscription_change_requests_no_delete;

CREATE TABLE shop_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN (
    'pending_payment', 'trialing', 'active', 'past_due', 'grace_period',
    'suspended', 'cancel_scheduled', 'upgrade_pending',
    'downgrade_scheduled', 'canceled'
  )),
  trial_ends_at TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  grace_ends_at TEXT,
  canceled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (shop_id, id)
) STRICT;

INSERT INTO shop_subscriptions (
  id, shop_id, plan_id, state, trial_ends_at, current_period_start,
  current_period_end, grace_ends_at, canceled_at, created_at, updated_at,
  version
)
SELECT
  id, shop_id, plan_id, state, trial_ends_at, current_period_start,
  current_period_end, grace_ends_at, canceled_at, created_at, updated_at,
  version
FROM shop_subscriptions_legacy_0070;

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
  CHECK ((status IN ('provider_pending', 'rejected')) =
    (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL))
) STRICT;

INSERT INTO subscription_change_requests (
  id, public_id, shop_id, subscription_id, current_plan_id, requested_plan_id,
  action, status, expected_subscription_version, reason_code,
  requested_by_user_id, reviewed_by_user_id, reviewed_at, completed_at,
  idempotency_key_hash, request_hash, version, created_at, updated_at
)
SELECT
  id, public_id, shop_id, subscription_id, current_plan_id, requested_plan_id,
  action, status, expected_subscription_version, reason_code,
  requested_by_user_id, reviewed_by_user_id, reviewed_at, completed_at,
  idempotency_key_hash, request_hash, version, created_at, updated_at
FROM subscription_change_requests_legacy_0070;

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

DROP TABLE subscription_change_requests_legacy_0070;
DROP TABLE shop_subscriptions_legacy_0070;

CREATE UNIQUE INDEX idx_shop_subscriptions_open
  ON shop_subscriptions(shop_id)
  WHERE state IN (
    'pending_payment', 'trialing', 'active', 'past_due', 'grace_period',
    'suspended', 'cancel_scheduled', 'upgrade_pending',
    'downgrade_scheduled'
  );

CREATE UNIQUE INDEX idx_shop_subscriptions_shop_id
  ON shop_subscriptions(shop_id, id);

CREATE INDEX idx_shop_subscriptions_state_period
  ON shop_subscriptions(state, current_period_end, shop_id);

CREATE UNIQUE INDEX idx_subscription_change_requests_active
  ON subscription_change_requests(shop_id)
  WHERE status IN ('requested', 'provider_pending');

CREATE INDEX idx_subscription_change_requests_shop_status
  ON subscription_change_requests(shop_id, status, created_at DESC, id);

PRAGMA foreign_keys = ON;

-- A trial entitlement always has an explicit expiry. The runtime entitlement
-- evaluator must transition an expired trial to suspended before granting
-- commerce access; this guard prevents extending an expired trial by replay.
CREATE TRIGGER shop_subscriptions_trialing_insert_guard
BEFORE INSERT ON shop_subscriptions
WHEN NEW.state = 'trialing'
  AND (NEW.trial_ends_at IS NULL OR NEW.trial_ends_at <= CURRENT_TIMESTAMP)
BEGIN
  SELECT RAISE(ABORT, 'trial_subscription_expired');
END;

CREATE TRIGGER shop_subscriptions_trialing_update_guard
BEFORE UPDATE ON shop_subscriptions
WHEN NEW.state = 'trialing'
  AND (NEW.trial_ends_at IS NULL OR NEW.trial_ends_at <= CURRENT_TIMESTAMP)
BEGIN
  SELECT RAISE(ABORT, 'trial_subscription_expired');
END;

ALTER TABLE plans ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1));
ALTER TABLE plans ADD COLUMN is_assignable INTEGER NOT NULL DEFAULT 0 CHECK (is_assignable IN (0, 1));
ALTER TABLE plans ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0);

-- Existing bot/store/business plans remain valid for grandfathered rows but
-- cannot be selected by new signup or public pricing surfaces.
UPDATE plans
SET is_public = 0, is_assignable = 0
WHERE code NOT IN ('starter', 'pro');

INSERT OR IGNORE INTO plans (
  id, code, name, feature_flags_json, limits_json, version, is_active,
  created_at, updated_at, is_public, is_assignable, schema_version
) VALUES (
  'plan_starter_v1', 'starter', 'Starter',
  '{"storefront":true,"telegram":true,"catalog":true,"inventory":true,"sellerPayments":true,"manualFulfillment":true,"payments":true,"fulfillment":true,"privateDownloads":true,"dataExport":true,"audit":true,"analytics":"basic","automation":true,"api":false,"apiRead":false,"customDomain":false}',
  '{"products":50,"products_non_archived":50,"ordersPerMonth":500,"ordersPerBillingPeriod":500,"orders_created":500,"customers":1000,"customers_total":1000,"staffSeats":1,"memberSeats":1,"active_member_seats":1,"customDomains":0,"active_custom_domains":0,"automationRules":3,"automation_rules":3,"automationRunsPerMonth":1000,"automationRunsPerBillingPeriod":1000,"automation_runs":1000,"apiReadRequestsPerMonth":0,"apiRequestsPerBillingPeriod":0,"api_requests":0,"exportsPerMonth":2,"exports_created":2,"downloadsPerMonth":500,"privateDownloadsPerBillingPeriod":500,"downloads_served":500,"storageBytes":1073741824,"auditRetentionDays":90}',
  1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 1, 1
), (
  'plan_pro_v1', 'pro', 'Pro',
  '{"storefront":true,"telegram":true,"catalog":true,"inventory":true,"sellerPayments":true,"manualFulfillment":true,"payments":true,"fulfillment":true,"privateDownloads":true,"dataExport":true,"audit":true,"analytics":"advanced","automation":true,"api":true,"apiRead":true,"customDomain":true}',
  '{"products":500,"products_non_archived":500,"ordersPerMonth":5000,"ordersPerBillingPeriod":5000,"orders_created":5000,"customers":10000,"customers_total":10000,"staffSeats":5,"memberSeats":5,"active_member_seats":5,"customDomains":1,"active_custom_domains":1,"automationRules":20,"automation_rules":20,"automationRunsPerMonth":10000,"automationRunsPerBillingPeriod":10000,"automation_runs":10000,"apiReadRequestsPerMonth":50000,"apiRequestsPerBillingPeriod":50000,"api_requests":50000,"exportsPerMonth":10,"exports_created":10,"downloadsPerMonth":10000,"privateDownloadsPerBillingPeriod":10000,"downloads_served":10000,"storageBytes":10737418240,"auditRetentionDays":365}',
  1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 1, 1
);

-- New shops receive one seven-day trial entitlement before paid conversion.
-- Existing trialing rows are deliberately preserved and are not extended.
UPDATE platform_settings
SET value_json = '{"value":7}', version = version + 1, updated_at = CURRENT_TIMESTAMP
WHERE key = 'default_trial_days';
INSERT OR IGNORE INTO platform_settings (key, value_json, version, updated_at)
VALUES ('default_trial_days', '{"value":7}', 1, CURRENT_TIMESTAMP);
UPDATE platform_settings
SET value_json = '{"value":3}', version = version + 1, updated_at = CURRENT_TIMESTAMP
WHERE key = 'subscription_grace_days';
INSERT OR IGNORE INTO platform_settings (key, value_json, version, updated_at)
VALUES ('subscription_grace_days', '{"value":3}', 1, CURRENT_TIMESTAMP);
