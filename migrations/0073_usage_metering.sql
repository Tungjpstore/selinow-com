PRAGMA foreign_keys = ON;

-- Keep trial and paid periods distinguishable even when a tenant reuses the
-- same calendar dates. Existing counters represent paid/billing periods; new
-- events carry an explicit period kind and a subscription-scoped period key.
ALTER TABLE usage_counters ADD COLUMN period_kind TEXT NOT NULL DEFAULT 'billing' CHECK (
  period_kind IN ('trial', 'billing', 'calendar', 'lifetime')
);

CREATE INDEX idx_usage_counters_shop_kind_metric
  ON usage_counters(shop_id, period_kind, metric, period_key);

CREATE TABLE usage_events (
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

CREATE INDEX idx_usage_events_shop_period
  ON usage_events(shop_id, period_kind, period_key, metric, occurred_at, id);

CREATE INDEX idx_usage_events_subscription
  ON usage_events(shop_id, subscription_id, occurred_at, id)
  WHERE subscription_id IS NOT NULL;

CREATE INDEX idx_usage_events_source
  ON usage_events(source_kind, source_id, occurred_at, id);

-- Usage events are the deduplicated ledger. The application increments the
-- corresponding usage_counters row in the same D1 transaction as this insert.
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
