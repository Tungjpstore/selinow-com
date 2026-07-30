PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX idx_orders_shop_checkout_subject
  ON orders(shop_id, checkout_subject_hash);
