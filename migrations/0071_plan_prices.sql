PRAGMA foreign_keys = ON;

CREATE TABLE plan_prices (
  id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  market_code TEXT NOT NULL CHECK (market_code IN ('vn', 'global')),
  currency TEXT NOT NULL CHECK (currency IN ('VND', 'USD')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  interval TEXT NOT NULL CHECK (interval = 'month'),
  tax_behavior TEXT NOT NULL CHECK (tax_behavior IN ('inclusive', 'exclusive', 'unspecified')),
  provider_code TEXT NOT NULL CHECK (provider_code IN ('payos', 'paddle')),
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

CREATE UNIQUE INDEX idx_plan_prices_active_offer
  ON plan_prices(plan_id, market_code, currency, interval)
  WHERE is_active = 1 AND effective_to IS NULL;

CREATE INDEX idx_plan_prices_market_active
  ON plan_prices(market_code, currency, is_active, plan_id, effective_from DESC);

-- Provider references are intentionally pending placeholders until the
-- environment-specific merchant accounts publish their external price IDs.
-- A checkout adapter must reject pending references as provider_not_ready.
INSERT OR IGNORE INTO plan_prices (
  id, plan_id, market_code, currency, amount_minor, interval, tax_behavior,
  provider_code, provider_price_ref, effective_from, version, is_active,
  created_at, updated_at
)
SELECT
  'price_starter_vn_v1', id, 'vn', 'VND', 99000, 'month', 'inclusive',
  'payos', 'pending:payos:starter:vn:month:v1', CURRENT_TIMESTAMP, 1, 1,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM plans WHERE code = 'starter'
UNION ALL
SELECT
  'price_pro_vn_v1', id, 'vn', 'VND', 299000, 'month', 'inclusive',
  'payos', 'pending:payos:pro:vn:month:v1', CURRENT_TIMESTAMP, 1, 1,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM plans WHERE code = 'pro'
UNION ALL
SELECT
  'price_starter_global_v1', id, 'global', 'USD', 500, 'month', 'inclusive',
  'paddle', 'pending:paddle:starter:global:month:v1', CURRENT_TIMESTAMP, 1, 1,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM plans WHERE code = 'starter'
UNION ALL
SELECT
  'price_pro_global_v1', id, 'global', 'USD', 1500, 'month', 'inclusive',
  'paddle', 'pending:paddle:pro:global:month:v1', CURRENT_TIMESTAMP, 1, 1,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM plans WHERE code = 'pro';

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
