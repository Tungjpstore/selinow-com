PRAGMA foreign_keys = ON;

-- Durable provider truth for scheduled plan changes. The current subscription
-- remains authoritative until the renewal/plan_changed event applies this
-- target; a provider acknowledgement alone must never discard it.
ALTER TABLE shop_subscriptions ADD COLUMN scheduled_plan_id TEXT REFERENCES plans(id) ON DELETE RESTRICT;
ALTER TABLE shop_subscriptions ADD COLUMN scheduled_price_id TEXT REFERENCES plan_prices(id) ON DELETE RESTRICT;
ALTER TABLE shop_subscriptions ADD COLUMN scheduled_effective_at TEXT;
ALTER TABLE shop_subscriptions ADD COLUMN scheduled_change_request_id TEXT;

CREATE INDEX idx_shop_subscriptions_scheduled
  ON shop_subscriptions(shop_id, scheduled_effective_at, id)
  WHERE scheduled_plan_id IS NOT NULL;

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

-- Reconciliation is a retryable operational concern, separate from provider
-- action status. References and bounded error codes are safe to persist; no
-- provider payloads, checkout URLs, credentials or secrets are stored here.
ALTER TABLE subscription_change_requests ADD COLUMN provider_acknowledged_at TEXT;
ALTER TABLE subscription_change_requests ADD COLUMN reconciliation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_attempts >= 0);
ALTER TABLE subscription_change_requests ADD COLUMN next_reconciliation_at TEXT;
ALTER TABLE subscription_change_requests ADD COLUMN last_reconciliation_at TEXT;
ALTER TABLE subscription_change_requests ADD COLUMN reconciliation_failure_code TEXT CHECK (
  reconciliation_failure_code IS NULL OR (
    length(reconciliation_failure_code) BETWEEN 3 AND 96
    AND reconciliation_failure_code NOT GLOB '*[^a-zA-Z0-9._:-]*'
  )
);

CREATE INDEX idx_subscription_change_requests_reconciliation
  ON subscription_change_requests(shop_id, status, next_reconciliation_at, id)
  WHERE status = 'provider_pending';

CREATE INDEX idx_subscription_change_requests_request_subscription
  ON subscription_change_requests(shop_id, subscription_id, status, created_at, id);

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

-- 0106 accidentally published generic references. Reopen only those four
-- exact rows so the guarded catalog reconciliation command can atomically
-- publish the correct environment-specific Dodo IDs. Any real reference that
-- was already rotated remains immutable and untouched.
DROP TRIGGER IF EXISTS plan_prices_published_reference_guard;

UPDATE plan_prices
SET provider_price_ref = CASE id
    WHEN 'price_starter_vn_v1' THEN 'pending:dodo:starter:vn:month:v1'
    WHEN 'price_pro_vn_v1' THEN 'pending:dodo:pro:vn:month:v1'
    WHEN 'price_starter_global_v1' THEN 'pending:dodo:starter:global:month:v1'
    WHEN 'price_pro_global_v1' THEN 'pending:dodo:pro:global:month:v1'
    ELSE provider_price_ref
  END,
  updated_at = CURRENT_TIMESTAMP
WHERE (id = 'price_starter_vn_v1' AND provider_price_ref = 'dodo_pri_starter_vn_v1')
   OR (id = 'price_pro_vn_v1' AND provider_price_ref = 'dodo_pri_pro_vn_v1')
   OR (id = 'price_starter_global_v1' AND provider_price_ref = 'dodo_pri_starter_global_v1')
   OR (id = 'price_pro_global_v1' AND provider_price_ref = 'dodo_pri_pro_global_v1');

CREATE TRIGGER plan_prices_published_reference_guard
BEFORE UPDATE ON plan_prices
WHEN NEW.provider_code != OLD.provider_code
  OR NEW.tax_behavior != OLD.tax_behavior
  OR NOT (
    NEW.provider_price_ref = OLD.provider_price_ref
    OR (
      OLD.provider_price_ref LIKE 'pending:%'
      AND NEW.provider_price_ref NOT LIKE 'pending:%'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'plan_price_provider_identity_immutable');
END;

INSERT OR IGNORE INTO platform_settings (key, value_json, version, updated_at)
VALUES ('dodo_catalog_reconciliation_required', '{"value":true}', 1, CURRENT_TIMESTAMP);
