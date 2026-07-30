PRAGMA foreign_keys = ON;

-- Staged cutover for order origin. Existing orders.source_channel remains the
-- compatibility field while this tenant-scoped projection gives future
-- adapters a normalized channel/adapter version without changing responses.
CREATE UNIQUE INDEX idx_orders_shop_id
  ON orders(shop_id, id);

CREATE TABLE order_channel_attributions (
  shop_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  channel_code TEXT NOT NULL CHECK (
    length(channel_code) BETWEEN 1 AND 64
    AND substr(channel_code, 1, 1) GLOB '[a-z]'
    AND channel_code NOT GLOB '*[^a-z0-9._:-]*'
  ),
  adapter_version INTEGER NOT NULL CHECK (adapter_version > 0),
  connection_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, order_id),
  FOREIGN KEY (shop_id, order_id)
    REFERENCES orders(shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, connection_id)
    REFERENCES channel_connections(shop_id, id) ON DELETE RESTRICT
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_order_channel_attributions_shop_channel
  ON order_channel_attributions(shop_id, channel_code, created_at DESC, order_id);

CREATE INDEX idx_order_channel_attributions_connection
  ON order_channel_attributions(shop_id, connection_id, created_at DESC, order_id)
  WHERE connection_id IS NOT NULL;
