PRAGMA foreign_keys = ON;

-- These are immutable billing snapshots. A later price revision never rewrites
-- the amount or currency of an already-created subscription period.
ALTER TABLE shop_subscriptions ADD COLUMN billing_provider_code TEXT CHECK (
  billing_provider_code IS NULL OR billing_provider_code IN ('payos', 'paddle')
);
ALTER TABLE shop_subscriptions ADD COLUMN market_code TEXT CHECK (
  market_code IS NULL OR market_code IN ('vn', 'global')
);
ALTER TABLE shop_subscriptions ADD COLUMN price_currency TEXT CHECK (
  price_currency IS NULL OR price_currency IN ('VND', 'USD')
);
ALTER TABLE shop_subscriptions ADD COLUMN price_amount_minor INTEGER CHECK (
  price_amount_minor IS NULL OR price_amount_minor > 0
);
ALTER TABLE shop_subscriptions ADD COLUMN price_interval TEXT CHECK (
  price_interval IS NULL OR price_interval = 'month'
);
ALTER TABLE shop_subscriptions ADD COLUMN price_version INTEGER CHECK (
  price_version IS NULL OR price_version > 0
);
ALTER TABLE shop_subscriptions ADD COLUMN price_id TEXT REFERENCES plan_prices(id) ON DELETE RESTRICT;
ALTER TABLE shop_subscriptions ADD COLUMN provider_customer_ref TEXT CHECK (
  provider_customer_ref IS NULL OR (
    length(provider_customer_ref) BETWEEN 3 AND 160
    AND provider_customer_ref NOT GLOB '*[[:space:]]*'
  )
);
ALTER TABLE shop_subscriptions ADD COLUMN provider_subscription_ref TEXT CHECK (
  provider_subscription_ref IS NULL OR (
    length(provider_subscription_ref) BETWEEN 3 AND 160
    AND provider_subscription_ref NOT GLOB '*[[:space:]]*'
  )
);

CREATE INDEX idx_shop_subscriptions_provider_ref
  ON shop_subscriptions(billing_provider_code, provider_subscription_ref)
  WHERE provider_subscription_ref IS NOT NULL;

CREATE TABLE billing_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('payos', 'paddle')),
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

CREATE INDEX idx_billing_accounts_shop_status
  ON billing_accounts(shop_id, status, updated_at DESC, id);

CREATE TABLE billing_checkout_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  price_id TEXT NOT NULL REFERENCES plan_prices(id) ON DELETE RESTRICT,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('payos', 'paddle')),
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

CREATE INDEX idx_billing_checkout_sessions_shop_status
  ON billing_checkout_sessions(shop_id, status, created_at DESC, id);

CREATE INDEX idx_billing_checkout_sessions_pending
  ON billing_checkout_sessions(status, expires_at, id)
  WHERE status IN ('pending', 'open');

CREATE TABLE billing_invoices (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL,
  billing_account_id TEXT REFERENCES billing_accounts(id) ON DELETE RESTRICT,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('payos', 'paddle')),
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

CREATE INDEX idx_billing_invoices_shop_status
  ON billing_invoices(shop_id, status, created_at DESC, id);

CREATE TABLE billing_provider_events (
  id TEXT PRIMARY KEY NOT NULL,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('payos', 'paddle')),
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

CREATE INDEX idx_billing_provider_events_shop_created
  ON billing_provider_events(shop_id, created_at DESC, id);

CREATE INDEX idx_billing_provider_events_status
  ON billing_provider_events(status, created_at, id);

CREATE TABLE subscription_events (
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

CREATE INDEX idx_subscription_events_shop_created
  ON subscription_events(shop_id, created_at DESC, id);

CREATE INDEX idx_subscription_events_subscription
  ON subscription_events(shop_id, subscription_id, occurred_at, id);

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
