PRAGMA foreign_keys = ON;

-- A provider reference is the immutable external product/price identity used
-- by signed webhook validation. Reusing it across price rows would make the
-- provider lookup ambiguous, including for events that omit amount/currency.
CREATE UNIQUE INDEX idx_plan_prices_provider_ref
  ON plan_prices(provider_code, provider_price_ref);

-- Placeholder references may be published exactly once. A later commercial
-- or provider change must use a new versioned price row instead of rebinding
-- historical checkout and subscription records.
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

-- Legacy plans remain available to grandfathered subscriptions, but cannot be
-- reintroduced into public or assignable catalog surfaces.
UPDATE plans
SET is_public = 0, is_assignable = 0, version = version + 1,
  updated_at = CURRENT_TIMESTAMP
WHERE code NOT IN ('starter', 'pro')
  AND (is_public = 1 OR is_assignable = 1);

CREATE TRIGGER plans_public_assignable_insert_guard
BEFORE INSERT ON plans
WHEN NEW.code NOT IN ('starter', 'pro')
  AND (NEW.is_public = 1 OR NEW.is_assignable = 1)
BEGIN
  SELECT RAISE(ABORT, 'legacy_plan_visibility_forbidden');
END;

CREATE TRIGGER plans_public_assignable_update_guard
BEFORE UPDATE OF code, is_public, is_assignable ON plans
WHEN NEW.code NOT IN ('starter', 'pro')
  AND (NEW.is_public = 1 OR NEW.is_assignable = 1)
BEGIN
  SELECT RAISE(ABORT, 'legacy_plan_visibility_forbidden');
END;

-- A populated subscription price snapshot must match its referenced catalog
-- row. During pending conversion the selected plan may differ from the
-- current trial plan; all monetary/provider dimensions remain authoritative.
CREATE TRIGGER shop_subscriptions_price_snapshot_presence_guard
BEFORE INSERT ON shop_subscriptions
WHEN (
  NEW.price_id IS NULL
  AND (
    NEW.market_code IS NOT NULL
    OR NEW.price_currency IS NOT NULL
    OR NEW.price_amount_minor IS NOT NULL
    OR NEW.price_interval IS NOT NULL
    OR NEW.price_version IS NOT NULL
  )
)
OR (
  NEW.price_id IS NOT NULL
  AND (
    NEW.billing_provider_code IS NULL
    OR NEW.market_code IS NULL
    OR NEW.price_currency IS NULL
    OR NEW.price_amount_minor IS NULL
    OR NEW.price_interval IS NULL
    OR NEW.price_version IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'subscription_price_snapshot_incomplete');
END;

CREATE TRIGGER shop_subscriptions_price_snapshot_presence_update_guard
BEFORE UPDATE OF billing_provider_code, market_code, price_currency,
  price_amount_minor, price_interval, price_version, price_id
ON shop_subscriptions
WHEN (
  NEW.price_id IS NULL
  AND (
    NEW.market_code IS NOT NULL
    OR NEW.price_currency IS NOT NULL
    OR NEW.price_amount_minor IS NOT NULL
    OR NEW.price_interval IS NOT NULL
    OR NEW.price_version IS NOT NULL
  )
)
OR (
  NEW.price_id IS NOT NULL
  AND (
    NEW.billing_provider_code IS NULL
    OR NEW.market_code IS NULL
    OR NEW.price_currency IS NULL
    OR NEW.price_amount_minor IS NULL
    OR NEW.price_interval IS NULL
    OR NEW.price_version IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'subscription_price_snapshot_incomplete');
END;

CREATE TRIGGER shop_subscriptions_price_snapshot_scope_guard
BEFORE INSERT ON shop_subscriptions
WHEN NEW.price_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM plan_prices AS prices
    WHERE prices.id = NEW.price_id
      AND prices.provider_code = NEW.billing_provider_code
      AND prices.market_code = NEW.market_code
      AND prices.currency = NEW.price_currency
      AND prices.amount_minor = NEW.price_amount_minor
      AND prices.interval = NEW.price_interval
      AND prices.version = NEW.price_version
      AND (NEW.state = 'pending_payment' OR prices.plan_id = NEW.plan_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'subscription_price_snapshot_scope_mismatch');
END;

CREATE TRIGGER shop_subscriptions_price_snapshot_scope_update_guard
BEFORE UPDATE OF plan_id, state, billing_provider_code, market_code,
  price_currency, price_amount_minor, price_interval, price_version, price_id
ON shop_subscriptions
WHEN NEW.price_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM plan_prices AS prices
    WHERE prices.id = NEW.price_id
      AND prices.provider_code = NEW.billing_provider_code
      AND prices.market_code = NEW.market_code
      AND prices.currency = NEW.price_currency
      AND prices.amount_minor = NEW.price_amount_minor
      AND prices.interval = NEW.price_interval
      AND prices.version = NEW.price_version
      AND (NEW.state = 'pending_payment' OR prices.plan_id = NEW.plan_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'subscription_price_snapshot_scope_mismatch');
END;
