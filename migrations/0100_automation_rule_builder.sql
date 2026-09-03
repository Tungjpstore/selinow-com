PRAGMA foreign_keys = ON;

-- Seller-defined "if this then that" automation rules. A rule owns only its
-- definition (trigger + AND-combined conditions + one-or-more actions); every
-- action still executes through the existing automation_tasks engine, so
-- retries, idempotency, optimistic concurrency, and audit linkage are
-- inherited rather than reimplemented here.
CREATE TABLE automation_rules (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'order.paid', 'order.fulfilled', 'payment.failed',
    'inventory.low_stock', 'customer.created'
  )),
  -- Array of { field, operator, value } objects, AND-combined only. OR groups
  -- and nested condition trees are a documented future gap (see rules docs).
  conditions_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(conditions_json) AND json_type(conditions_json) = 'array'
    AND length(conditions_json) <= 8192
  ),
  -- Array of { type, config } objects; at least one action is required. Each
  -- action type maps 1:1 to a registered automation capability code.
  actions_json TEXT NOT NULL CHECK (
    json_valid(actions_json) AND json_type(actions_json) = 'array'
    AND json_array_length(actions_json) BETWEEN 1 AND 10
    AND length(actions_json) <= 16384
  ),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  create_idempotency_key_hash TEXT NOT NULL CHECK (
    length(create_idempotency_key_hash) = 64
    AND create_idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  create_request_hash TEXT NOT NULL CHECK (
    length(create_request_hash) = 64
    AND create_request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_by TEXT NOT NULL CHECK (
    length(created_by) BETWEEN 3 AND 128
    AND substr(created_by, 1, 1) GLOB '[A-Za-z0-9]'
    AND created_by NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  updated_by TEXT NOT NULL CHECK (
    length(updated_by) BETWEEN 3 AND 128
    AND substr(updated_by, 1, 1) GLOB '[A-Za-z0-9]'
    AND updated_by NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  last_triggered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, shop_id)
) STRICT;

CREATE UNIQUE INDEX idx_automation_rules_shop_create_idempotency
  ON automation_rules(shop_id, create_idempotency_key_hash);

-- Trigger matching always scans by (shop_id, trigger_type, enabled); this is
-- the sole index the fail-safe rule-matching path relies on.
CREATE INDEX idx_automation_rules_shop_trigger_enabled
  ON automation_rules(shop_id, trigger_type, enabled, id);

CREATE INDEX idx_automation_rules_shop_updated
  ON automation_rules(shop_id, updated_at DESC, id);

-- Each matched (rule, action) pair snapshots the action config and a safe
-- projection of the triggering event payload here. The automation_tasks row
-- created for that action references only this opaque record (never the raw
-- event or provider payload) as its input_reference, matching the existing
-- automation engine's reference-only contract.
CREATE TABLE automation_rule_action_runs (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  rule_version INTEGER NOT NULL CHECK (rule_version > 0),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'order.paid', 'order.fulfilled', 'payment.failed',
    'inventory.low_stock', 'customer.created'
  )),
  action_index INTEGER NOT NULL CHECK (action_index >= 0),
  action_type TEXT NOT NULL CHECK (action_type IN (
    'rule_notify_telegram', 'rule_call_webhook', 'rule_tag_customer', 'rule_create_task'
  )),
  action_config_json TEXT NOT NULL CHECK (
    json_valid(action_config_json) AND json_type(action_config_json) = 'object'
    AND length(action_config_json) <= 4096
  ),
  event_payload_json TEXT NOT NULL CHECK (
    json_valid(event_payload_json) AND json_type(event_payload_json) = 'object'
    AND length(event_payload_json) <= 4096
  ),
  aggregate_reference TEXT NOT NULL CHECK (length(aggregate_reference) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  -- R0: links the run to the automation task executing this action, so the UI
  -- can show per-action status. NULL until the dispatcher links it after
  -- orchestrator.start() succeeds.
  task_id TEXT REFERENCES automation_tasks(id) ON DELETE SET NULL
    CHECK (task_id IS NULL OR (
      length(task_id) BETWEEN 8 AND 96
      AND substr(task_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND task_id NOT GLOB '*[^A-Za-z0-9._:-]*')),
  UNIQUE (id, shop_id),
  -- The natural key a single (rule, event, action) triggers on; combined with
  -- a deterministically derived id this keeps repeated dispatch attempts
  -- (retries, replayed webhooks) from creating duplicate run rows.
  UNIQUE (shop_id, rule_id, trigger_type, aggregate_reference, action_index)
) STRICT;

CREATE INDEX idx_automation_rule_action_runs_shop_rule
  ON automation_rule_action_runs(shop_id, rule_id, created_at DESC);

CREATE INDEX idx_automation_rule_action_runs_task
  ON automation_rule_action_runs(shop_id, task_id)
  WHERE task_id IS NOT NULL;

-- Links an automation task back to the rule that created it, so the existing
-- ledger can be filtered/labelled per rule without a second execution log.
ALTER TABLE automation_tasks ADD COLUMN rule_id TEXT
  REFERENCES automation_rules(id) ON DELETE SET NULL
  CHECK (
    rule_id IS NULL OR (
      length(rule_id) BETWEEN 8 AND 96
      AND substr(rule_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND rule_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  );

CREATE INDEX idx_automation_tasks_shop_rule_created
  ON automation_tasks(shop_id, rule_id, created_at DESC)
  WHERE rule_id IS NOT NULL;

-- Minimal tag ledger for the rule_tag_customer action. Kept automation-owned
-- and separate from the shared customer schema to avoid coupling with any
-- parallel customer-tagging workstream.
CREATE TABLE automation_customer_tags (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 8 AND 96
    AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
    AND id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES shop_customers(id) ON DELETE CASCADE,
  tag TEXT NOT NULL CHECK (
    length(tag) BETWEEN 1 AND 40
    AND tag NOT GLOB '*[^A-Za-z0-9 ._-]*'
  ),
  source_rule_id TEXT REFERENCES automation_rules(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, customer_id, tag)
) STRICT;

CREATE INDEX idx_automation_customer_tags_shop_customer
  ON automation_customer_tags(shop_id, customer_id, created_at DESC);
