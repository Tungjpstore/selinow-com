PRAGMA foreign_keys = ON;

-- EX3.1 (Experience Platform program): tenant-leading index backing the
-- seller metrics range aggregate (paid orders grouped by day). Additive only.
CREATE INDEX idx_orders_shop_paid_at
  ON orders(shop_id, paid_at);
