-- Persist the exact cart snapshot used to create an order so idempotent
-- replays can validate the original request after a buyer starts a new cart.
ALTER TABLE orders ADD COLUMN checkout_cart_id TEXT;

CREATE INDEX idx_orders_shop_checkout_cart
  ON orders(shop_id, checkout_cart_id, id)
  WHERE checkout_cart_id IS NOT NULL;
