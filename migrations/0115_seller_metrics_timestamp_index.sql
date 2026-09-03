PRAGMA foreign_keys = ON;

-- Seller analytics accepts provider timestamps with explicit UTC offsets.
-- Match the julianday range/keyset query while preserving tenant-leading
-- lookup and excluding rows that can never contribute to paid metrics.
CREATE INDEX idx_orders_shop_paid_julianday_id
  ON orders(shop_id, julianday(paid_at) DESC, id DESC)
  WHERE payment_status = 'paid' AND paid_at IS NOT NULL;
