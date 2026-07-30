PRAGMA foreign_keys = ON;

CREATE TABLE product_categories (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, slug)
) STRICT;

CREATE INDEX idx_product_categories_shop_status
  ON product_categories(shop_id, status, sort_order, id);

CREATE TABLE products (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES product_categories(id) ON DELETE SET NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'suspended', 'archived')),
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type IN ('license_key', 'manual')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, slug)
) STRICT;

CREATE INDEX idx_products_shop_status_updated
  ON products(shop_id, status, updated_at DESC, id);
CREATE INDEX idx_products_shop_category_status
  ON products(shop_id, category_id, status, id);

CREATE TABLE product_variants (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options_json)),
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  compare_at_minor INTEGER CHECK (compare_at_minor IS NULL OR compare_at_minor >= price_minor),
  currency TEXT NOT NULL,
  min_per_order INTEGER NOT NULL DEFAULT 1 CHECK (min_per_order > 0),
  max_per_order INTEGER NOT NULL DEFAULT 10 CHECK (max_per_order >= min_per_order),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, sku)
) STRICT;

CREATE INDEX idx_product_variants_shop_product_status
  ON product_variants(shop_id, product_id, status, id);

CREATE TABLE inventory_batches (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('paste', 'csv')),
  filename_sanitized TEXT,
  total_count INTEGER NOT NULL CHECK (total_count >= 0),
  accepted_count INTEGER NOT NULL CHECK (accepted_count >= 0),
  rejected_count INTEGER NOT NULL CHECK (rejected_count >= 0),
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_inventory_batches_shop_variant_created
  ON inventory_batches(shop_id, variant_id, created_at DESC, id);

CREATE TABLE inventory_keys (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  batch_id TEXT NOT NULL REFERENCES inventory_batches(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('available', 'reserved', 'sold', 'revoked')),
  ciphertext_b64 TEXT NOT NULL,
  iv_b64 TEXT NOT NULL,
  key_version TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  reservation_token TEXT,
  reserved_order_item_id TEXT,
  reserved_until TEXT,
  sold_order_item_id TEXT,
  sold_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, variant_id, key_fingerprint)
) STRICT;

CREATE INDEX idx_inventory_keys_shop_variant_status
  ON inventory_keys(shop_id, variant_id, status, id);
CREATE INDEX idx_inventory_keys_shop_reserved
  ON inventory_keys(shop_id, reserved_until, status, id);
CREATE INDEX idx_inventory_keys_reservation_token
  ON inventory_keys(reservation_token, status, id);

CREATE TABLE shop_customers (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  email_normalized TEXT,
  display_name TEXT,
  locale TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, email_normalized)
) STRICT;

CREATE TABLE carts (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram')),
  subject_hash TEXT NOT NULL,
  locale TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'converted', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_carts_active_subject
  ON carts(shop_id, channel, subject_hash) WHERE state = 'active';

CREATE TABLE cart_items (
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (cart_id, variant_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_cart_items_shop_cart ON cart_items(shop_id, cart_id);

CREATE TABLE orders (
  id TEXT PRIMARY KEY NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  customer_id TEXT REFERENCES shop_customers(id) ON DELETE SET NULL,
  order_number TEXT NOT NULL,
  source_channel TEXT NOT NULL CHECK (source_channel IN ('web', 'telegram')),
  status TEXT NOT NULL CHECK (status IN ('pending_payment', 'processing', 'completed', 'canceled', 'expired', 'exception')),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'partial', 'overpaid', 'failed', 'expired', 'refunded')),
  fulfillment_status TEXT NOT NULL CHECK (fulfillment_status IN ('unfulfilled', 'reserved', 'fulfilled', 'failed', 'manual_review')),
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  currency TEXT NOT NULL,
  locale TEXT NOT NULL,
  customer_email_masked TEXT,
  checkout_subject_hash TEXT NOT NULL,
  order_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  fulfilled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, order_number)
) STRICT;

CREATE INDEX idx_orders_shop_created ON orders(shop_id, created_at DESC, id);
CREATE INDEX idx_orders_shop_payment_created ON orders(shop_id, payment_status, created_at DESC, id);
CREATE INDEX idx_orders_expiry ON orders(status, payment_status, expires_at, id);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id TEXT NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  product_title TEXT NOT NULL,
  variant_title TEXT NOT NULL,
  sku TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type IN ('license_key', 'manual')),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_order_items_shop_order ON order_items(shop_id, order_id, id);
