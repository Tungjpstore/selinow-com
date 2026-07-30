PRAGMA foreign_keys = ON;

-- A create idempotency key belongs to the shop, not to one capability. Keep
-- the previous capability-scoped index so the currently deployed Worker stays
-- compatible if code is rolled back after this forward-only migration.
CREATE UNIQUE INDEX idx_automation_tasks_shop_create_idempotency
  ON automation_tasks(shop_id, idempotency_key_hash);
