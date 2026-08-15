PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

-- The provider code is part of the immutable billing identity in several
-- tables, so SQLite cannot widen the old Paddle CHECK constraints in place.
-- Rebuild each affected table forward-only while preserving rows, indexes,
-- triggers and tenant/price references. legacy_alter_table keeps child FK and
-- trigger references pointed at the canonical table during the swap.

DROP TRIGGER IF EXISTS plan_prices_immutable_identity;
DROP TRIGGER IF EXISTS plan_prices_no_delete;
DROP INDEX IF EXISTS idx_plan_prices_active_offer;
DROP INDEX IF EXISTS idx_plan_prices_market_active;
ALTER TABLE plan_prices RENAME TO plan_prices_legacy_0076;

CREATE TABLE plan_prices (
  id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  market_code TEXT NOT NULL CHECK (market_code IN ('vn', 'global')),
  currency TEXT NOT NULL CHECK (currency IN ('VND', 'USD')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  interval TEXT NOT NULL CHECK (interval = 'month'),
  tax_behavior TEXT NOT NULL CHECK (tax_behavior IN ('inclusive', 'exclusive', 'unspecified')),
  provider_code TEXT NOT NULL CHECK (provider_code IN ('payos', 'dodo')),
  provider_price_ref TEXT NOT NULL CHECK (
    length(provider_price_ref) BETWEEN 3 AND 160
    AND provider_price_ref NOT GLOB '*[[:space:]]*'
  ),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_id, market_code, currency, interval, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK ((market_code = 'vn') = (currency = 'VND')),
  CHECK ((market_code = 'global') = (currency = 'USD'))
) STRICT;

INSERT INTO plan_prices (
  id, plan_id, market_code, currency, amount_minor, interval, tax_behavior,
  provider_code, provider_price_ref, effective_from, effective_to, version,
  is_active, created_at, updated_at
)
SELECT
  id, plan_id, market_code, currency, amount_minor, interval, tax_behavior,
  CASE provider_code WHEN 'paddle' THEN 'dodo' ELSE provider_code END,
  replace(provider_price_ref, 'pending:paddle:', 'pending:dodo:'),
  effective_from, effective_to, version, is_active, created_at, updated_at
FROM plan_prices_legacy_0076;

DROP TABLE plan_prices_legacy_0076;

CREATE UNIQUE INDEX idx_plan_prices_active_offer
  ON plan_prices(plan_id, market_code, currency, interval)
  WHERE is_active = 1 AND effective_to IS NULL;

CREATE INDEX idx_plan_prices_market_active
  ON plan_prices(market_code, currency, is_active, plan_id, effective_from DESC);

CREATE TRIGGER plan_prices_immutable_identity
BEFORE UPDATE ON plan_prices
WHEN NEW.id != OLD.id
  OR NEW.plan_id != OLD.plan_id
  OR NEW.market_code != OLD.market_code
  OR NEW.currency != OLD.currency
  OR NEW.amount_minor != OLD.amount_minor
  OR NEW.interval != OLD.interval
  OR NEW.version != OLD.version
  OR NEW.effective_from != OLD.effective_from
BEGIN
  SELECT RAISE(ABORT, 'plan_price_identity_immutable');
END;

CREATE TRIGGER plan_prices_no_delete
BEFORE DELETE ON plan_prices
BEGIN
  SELECT RAISE(ABORT, 'plan_price_immutable');
END;

DROP TRIGGER IF EXISTS shop_subscriptions_trialing_insert_guard;
DROP TRIGGER IF EXISTS shop_subscriptions_trialing_update_guard;
DROP INDEX IF EXISTS idx_shop_subscriptions_open;
DROP INDEX IF EXISTS idx_shop_subscriptions_shop_id;
DROP INDEX IF EXISTS idx_shop_subscriptions_state_period;
DROP INDEX IF EXISTS idx_shop_subscriptions_provider_ref;
ALTER TABLE shop_subscriptions RENAME TO shop_subscriptions_legacy_0076;

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
  billing_provider_code TEXT CHECK (
    billing_provider_code IS NULL OR billing_provider_code IN ('payos', 'dodo')
  ),
  market_code TEXT CHECK (
    market_code IS NULL OR market_code IN ('vn', 'global')
  ),
  price_currency TEXT CHECK (
    price_currency IS NULL OR price_currency IN ('VND', 'USD')
  ),
  price_amount_minor INTEGER CHECK (
    price_amount_minor IS NULL OR price_amount_minor > 0
  ),
  price_interval TEXT CHECK (
    price_interval IS NULL OR price_interval = 'month'
  ),
  price_version INTEGER CHECK (
    price_version IS NULL OR price_version > 0
  ),
  price_id TEXT REFERENCES plan_prices(id) ON DELETE RESTRICT,
  provider_customer_ref TEXT CHECK (
    provider_customer_ref IS NULL OR (
      length(provider_customer_ref) BETWEEN 3 AND 160
      AND provider_customer_ref NOT GLOB '*[[:space:]]*'
    )
  ),
  provider_subscription_ref TEXT CHECK (
    provider_subscription_ref IS NULL OR (
      length(provider_subscription_ref) BETWEEN 3 AND 160
      AND provider_subscription_ref NOT GLOB '*[[:space:]]*'
    )
  ),
  UNIQUE (shop_id, id)
) STRICT;

INSERT INTO shop_subscriptions (
  id, shop_id, plan_id, state, trial_ends_at, current_period_start,
  current_period_end, grace_ends_at, canceled_at, created_at, updated_at,
  version, billing_provider_code, market_code, price_currency,
  price_amount_minor, price_interval, price_version, price_id,
  provider_customer_ref, provider_subscription_ref
)
SELECT
  id, shop_id, plan_id, state, trial_ends_at, current_period_start,
  current_period_end, grace_ends_at, canceled_at, created_at, updated_at,
  version, CASE billing_provider_code WHEN 'paddle' THEN 'dodo' ELSE billing_provider_code END,
  market_code, price_currency, price_amount_minor, price_interval, price_version,
  price_id, provider_customer_ref, provider_subscription_ref
FROM shop_subscriptions_legacy_0076;

DROP TABLE shop_subscriptions_legacy_0076;

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

CREATE INDEX idx_shop_subscriptions_provider_ref
  ON shop_subscriptions(billing_provider_code, provider_subscription_ref)
  WHERE provider_subscription_ref IS NOT NULL;

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

DROP INDEX IF EXISTS idx_billing_accounts_shop_status;
ALTER TABLE billing_accounts RENAME TO billing_accounts_legacy_0076;

CREATE TABLE billing_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('payos', 'dodo')),
  market_code TEXT NOT NULL CHECK (market_code IN ('vn', 'global')),
  currency TEXT NOT NULL CHECK (currency IN ('VND', 'USD')),
  provider_customer_ref TEXT CHECK (
    provider_customer_ref IS NULL OR (
      length(provider_customer_ref) BETWEEN 3 AND 160
      AND provider_customer_ref NOT GLOB '*[[:space:]]*'
    )
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'past_due', 'closed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, provider_code),
  CHECK ((market_code = 'vn') = (currency = 'VND')),
  CHECK ((market_code = 'global') = (currency = 'USD'))
) STRICT;

INSERT INTO billing_accounts (
  id, shop_id, provider_code, market_code, currency, provider_customer_ref,
  status, version, created_at, updated_at
)
SELECT
  id, shop_id, CASE provider_code WHEN 'paddle' THEN 'dodo' ELSE provider_code END,
  market_code, currency, provider_customer_ref, status, version, created_at, updated_at
FROM billing_accounts_legacy_0076;

DROP TABLE billing_accounts_legacy_0076;

CREATE INDEX idx_billing_accounts_shop_status
  ON billing_accounts(shop_id, status, updated_at DESC, id);

DROP INDEX IF EXISTS idx_billing_checkout_sessions_shop_status;
DROP INDEX IF EXISTS idx_billing_checkout_sessions_pending;
ALTER TABLE billing_checkout_sessions RENAME TO billing_checkout_sessions_legacy_0076;

CREATE TABLE billing_checkout_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  price_id TEXT NOT NULL REFERENCES plan_prices(id) ON DELETE RESTRICT,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('payos', 'dodo')),
  provider_checkout_ref TEXT CHECK (
    provider_checkout_ref IS NULL OR (
      length(provider_checkout_ref) BETWEEN 3 AND 160
      AND provider_checkout_ref NOT GLOB '*[[:space:]]*'
    )
  ),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'open', 'completed', 'expired', 'canceled', 'failed'
  )),
  idempotency_key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expires_at TEXT,
  completed_at TEXT,
  failure_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, idempotency_key_hash),
  UNIQUE (provider_code, provider_checkout_ref),
  FOREIGN KEY (shop_id, subscription_id)
    REFERENCES shop_subscriptions(shop_id, id) ON DELETE RESTRICT,
  CHECK (status != 'completed' OR (completed_at IS NOT NULL AND provider_checkout_ref IS NOT NULL)),
  CHECK (status != 'failed' OR failure_code IS NOT NULL)
) STRICT;

INSERT INTO billing_checkout_sessions (
  id, public_id, shop_id, subscription_id, plan_id, price_id, provider_code,
  provider_checkout_ref, status, idempotency_key_hash, request_hash, expires_at,
  completed_at, failure_code, version, created_at, updated_at
)
SELECT
  id, public_id, shop_id, subscription_id, plan_id, price_id,
  CASE provider_code WHEN 'paddle' THEN 'dodo' ELSE provider_code END,
  provider_checkout_ref, status, idempotency_key_hash, request_hash, expires_at,
  completed_at, failure_code, version, created_at, updated_at
FROM billing_checkout_sessions_legacy_0076;

DROP TABLE billing_checkout_sessions_legacy_0076;

CREATE INDEX idx_billing_checkout_sessions_shop_status
  ON billing_checkout_sessions(shop_id, status, created_at DESC, id);

CREATE INDEX idx_billing_checkout_sessions_pending
  ON billing_checkout_sessions(status, expires_at, id)
  WHERE status IN ('pending', 'open');

DROP INDEX IF EXISTS idx_billing_invoices_shop_status;
ALTER TABLE billing_invoices RENAME TO billing_invoices_legacy_0076;

CREATE TABLE billing_invoices (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL,
  billing_account_id TEXT REFERENCES billing_accounts(id) ON DELETE RESTRICT,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('payos', 'dodo')),
  provider_invoice_ref TEXT CHECK (
    provider_invoice_ref IS NULL OR (
      length(provider_invoice_ref) BETWEEN 3 AND 160
      AND provider_invoice_ref NOT GLOB '*[[:space:]]*'
    )
  ),
  provider_transaction_ref TEXT CHECK (
    provider_transaction_ref IS NULL OR (
      length(provider_transaction_ref) BETWEEN 3 AND 160
      AND provider_transaction_ref NOT GLOB '*[[:space:]]*'
    )
  ),
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'open', 'paid', 'past_due', 'failed', 'void', 'refunded'
  )),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency IN ('VND', 'USD')),
  period_start TEXT,
  period_end TEXT,
  paid_at TEXT,
  failure_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  UNIQUE (provider_code, provider_invoice_ref),
  UNIQUE (provider_code, provider_transaction_ref),
  FOREIGN KEY (shop_id, subscription_id)
    REFERENCES shop_subscriptions(shop_id, id) ON DELETE RESTRICT,
  CHECK (status != 'paid' OR paid_at IS NOT NULL),
  CHECK (status != 'failed' OR failure_code IS NOT NULL),
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end > period_start)
) STRICT;

INSERT INTO billing_invoices (
  id, shop_id, subscription_id, billing_account_id, provider_code,
  provider_invoice_ref, provider_transaction_ref, status, amount_minor,
  currency, period_start, period_end, paid_at, failure_code, version,
  created_at, updated_at
)
SELECT
  id, shop_id, subscription_id, billing_account_id,
  CASE provider_code WHEN 'paddle' THEN 'dodo' ELSE provider_code END,
  provider_invoice_ref, provider_transaction_ref, status, amount_minor, currency,
  period_start, period_end, paid_at, failure_code, version, created_at, updated_at
FROM billing_invoices_legacy_0076;

DROP TABLE billing_invoices_legacy_0076;

CREATE INDEX idx_billing_invoices_shop_status
  ON billing_invoices(shop_id, status, created_at DESC, id);

DROP TRIGGER IF EXISTS billing_provider_events_identity_immutable;
DROP TRIGGER IF EXISTS billing_provider_events_transition_guard;
DROP TRIGGER IF EXISTS billing_provider_events_no_delete;
DROP INDEX IF EXISTS idx_billing_provider_events_shop_created;
DROP INDEX IF EXISTS idx_billing_provider_events_status;
ALTER TABLE billing_provider_events RENAME TO billing_provider_events_legacy_0076;

CREATE TABLE billing_provider_events (
  id TEXT PRIMARY KEY NOT NULL,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('payos', 'dodo')),
  provider_event_id TEXT NOT NULL CHECK (
    length(provider_event_id) BETWEEN 3 AND 160
    AND provider_event_id NOT GLOB '*[[:space:]]*'
  ),
  provider_object_ref TEXT CHECK (
    provider_object_ref IS NULL OR (
      length(provider_object_ref) BETWEEN 3 AND 160
      AND provider_object_ref NOT GLOB '*[[:space:]]*'
    )
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) BETWEEN 32 AND 128
    AND payload_hash NOT GLOB '*[[:space:]]*'
  ),
  shop_id TEXT REFERENCES shops(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (
    length(event_type) BETWEEN 3 AND 96
    AND event_type NOT GLOB '*[^a-zA-Z0-9._:-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('received', 'processed', 'ignored', 'conflict', 'failed')),
  safe_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(safe_metadata_json)),
  occurred_at TEXT,
  processed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (provider_code, provider_event_id),
  CHECK (status != 'processed' OR processed_at IS NOT NULL)
) STRICT;

INSERT INTO billing_provider_events (
  id, provider_code, provider_event_id, provider_object_ref, payload_hash,
  shop_id, event_type, status, safe_metadata_json, occurred_at, processed_at,
  created_at
)
SELECT
  id, CASE provider_code WHEN 'paddle' THEN 'dodo' ELSE provider_code END,
  provider_event_id, provider_object_ref, payload_hash, shop_id, event_type,
  status, safe_metadata_json, occurred_at, processed_at, created_at
FROM billing_provider_events_legacy_0076;

DROP TABLE billing_provider_events_legacy_0076;

CREATE INDEX idx_billing_provider_events_shop_created
  ON billing_provider_events(shop_id, created_at DESC, id);

CREATE INDEX idx_billing_provider_events_status
  ON billing_provider_events(status, created_at, id);

CREATE TRIGGER billing_provider_events_identity_immutable
BEFORE UPDATE ON billing_provider_events
WHEN NEW.id != OLD.id
  OR NEW.provider_code != OLD.provider_code
  OR NEW.provider_event_id != OLD.provider_event_id
  OR NEW.provider_object_ref IS NOT OLD.provider_object_ref
  OR NEW.payload_hash != OLD.payload_hash
  OR NEW.shop_id IS NOT OLD.shop_id
  OR NEW.event_type != OLD.event_type
  OR NEW.safe_metadata_json != OLD.safe_metadata_json
  OR NEW.occurred_at IS NOT OLD.occurred_at
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'billing_provider_event_identity_immutable');
END;

CREATE TRIGGER billing_provider_events_transition_guard
BEFORE UPDATE ON billing_provider_events
WHEN NOT (
  (OLD.status = 'received' AND NEW.status IN ('received', 'processed', 'ignored', 'conflict', 'failed'))
  OR (OLD.status = 'failed' AND NEW.status IN ('failed', 'received'))
  OR (OLD.status IN ('processed', 'ignored', 'conflict') AND NEW.status = OLD.status)
)
BEGIN
  SELECT RAISE(ABORT, 'billing_provider_event_transition_invalid');
END;

CREATE TRIGGER billing_provider_events_no_delete
BEFORE DELETE ON billing_provider_events
BEGIN
  SELECT RAISE(ABORT, 'billing_provider_event_immutable');
END;

PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;

-- All historical Paddle markers are migrated to Dodo while preserving the
-- original market, amount, currency, interval, version and external IDs.
