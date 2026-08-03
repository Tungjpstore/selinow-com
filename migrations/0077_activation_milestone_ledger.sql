-- Activation milestones are a small, tenant-scoped ledger for server-side
-- product analytics. The projection is deliberately opaque to clients and
-- must contain only the allowlisted fields validated by the application.
CREATE TABLE activation_milestones (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  milestone_code TEXT NOT NULL CHECK (milestone_code IN (
    'setup_started', 'shop_created', 'product_created', 'inventory_ready',
    'payos_connected', 'telegram_connected', 'readiness_passed',
    'safe_test_passed', 'storefront_published', 'first_order_created',
    'first_paid_fulfilled', 'trial_converted'
  )),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'onboarding', 'shop', 'catalog', 'inventory', 'payment', 'telegram',
    'readiness', 'safe_test', 'storefront', 'commerce', 'billing'
  )),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'started', 'created', 'ready', 'connected', 'passed', 'published',
    'ordered', 'fulfilled', 'converted', 'manual'
  )),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) BETWEEN 40 AND 128),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) BETWEEN 40 AND 128),
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, idempotency_key_hash)
) STRICT;

CREATE INDEX idx_activation_milestones_shop_time
  ON activation_milestones(shop_id, occurred_at, id);

CREATE INDEX idx_activation_milestones_shop_code_time
  ON activation_milestones(shop_id, milestone_code, occurred_at, id);
