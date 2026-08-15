PRAGMA foreign_keys = ON;

-- Physical-goods vertical (TV3). Additive only: no parent table is rebuilt,
-- so every production invariant hash stays byte-identical. Physical products
-- keep fulfillment_type = 'manual' (seller-attested delivery) and are marked
-- by products.delivery_mode = 'shipping'; granular shipping progress lives on
-- fulfillments.shipping_state instead of widening orders.fulfillment_status.

-- Selling model driving template defaults and checkout surfaces. Existing
-- shops keep 'digital'.
ALTER TABLE shops ADD COLUMN vertical TEXT NOT NULL DEFAULT 'digital'
  CHECK (vertical IN ('digital', 'physical', 'booking'));

ALTER TABLE products ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'digital'
  CHECK (delivery_mode IN ('digital', 'shipping'));

-- Shipping snapshot copied onto the order at checkout (fee is money-relevant
-- and must survive later edits or archival of the method row).
ALTER TABLE orders ADD COLUMN shipping_method_name TEXT;
ALTER TABLE orders ADD COLUMN shipping_fee_minor INTEGER NOT NULL DEFAULT 0
  CHECK (shipping_fee_minor >= 0);

ALTER TABLE fulfillments ADD COLUMN shipping_state TEXT
  CHECK (shipping_state IS NULL OR shipping_state IN ('packing', 'shipped', 'delivered'));
ALTER TABLE fulfillments ADD COLUMN carrier TEXT
  CHECK (carrier IS NULL OR (length(carrier) BETWEEN 2 AND 80));
ALTER TABLE fulfillments ADD COLUMN tracking_code TEXT
  CHECK (tracking_code IS NULL OR (length(tracking_code) BETWEEN 4 AND 64));

-- Composite tenant FK target for variant_stock_levels (0034 pattern).
CREATE UNIQUE INDEX idx_product_variants_shop_id
  ON product_variants(shop_id, id);

-- Physical on-hand stock per variant. Availability = on_hand - reserved; the
-- canonical checkout transaction reserves atomically (token-marked like
-- inventory_keys so an exact-count guard proves the batch reserved in full)
-- and order expiry releases by order-item quantities.
CREATE TABLE variant_stock_levels (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  variant_id TEXT NOT NULL,
  on_hand INTEGER NOT NULL CHECK (on_hand >= 0 AND on_hand <= 100000000),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= on_hand),
  active_reservation_token TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, variant_id) REFERENCES product_variants(shop_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX idx_variant_stock_levels_variant
  ON variant_stock_levels(shop_id, variant_id);

CREATE TRIGGER variant_stock_levels_identity_immutable
BEFORE UPDATE ON variant_stock_levels
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.variant_id != OLD.variant_id
BEGIN
  SELECT RAISE(ABORT, 'variant_stock_levels_identity_immutable');
END;

-- Seller-configured shipping methods (flat fee + optional free-over threshold).
CREATE TABLE shop_shipping_methods (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  fee_minor INTEGER NOT NULL CHECK (fee_minor >= 0 AND fee_minor <= 1000000000),
  free_over_minor INTEGER CHECK (
    free_over_minor IS NULL OR (free_over_minor >= 0 AND free_over_minor <= 100000000000)
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0 AND sort_order <= 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id)
) STRICT;

CREATE INDEX idx_shop_shipping_methods_shop
  ON shop_shipping_methods(shop_id, status, sort_order, id);

CREATE TRIGGER shop_shipping_methods_identity_immutable
BEFORE UPDATE ON shop_shipping_methods
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'shop_shipping_methods_identity_immutable');
END;

CREATE TRIGGER shop_shipping_methods_transition_guard
BEFORE UPDATE ON shop_shipping_methods
WHEN NOT (
  (OLD.status = 'active' AND NEW.status IN ('active', 'archived'))
  OR (OLD.status = 'archived' AND NEW.status IN ('archived', 'active'))
)
BEGIN
  SELECT RAISE(ABORT, 'shop_shipping_methods_transition_invalid');
END;

-- Shipping address captured at checkout for physical orders. One address per
-- order; PII stays tenant-bound and is removed by the shop data lifecycle.
CREATE TABLE order_shipping_addresses (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 1 AND 120),
  phone TEXT NOT NULL CHECK (
    length(phone) BETWEEN 8 AND 16
    AND phone NOT GLOB '*[^0-9+]*'
    AND (substr(phone, 1, 1) = '0' OR substr(phone, 1, 1) = '+')
  ),
  address_line TEXT NOT NULL CHECK (length(address_line) BETWEEN 4 AND 300),
  ward TEXT NOT NULL CHECK (length(ward) BETWEEN 2 AND 120),
  district TEXT NOT NULL CHECK (length(district) BETWEEN 2 AND 120),
  province TEXT NOT NULL CHECK (length(province) BETWEEN 2 AND 120),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 300),
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX idx_order_shipping_addresses_order
  ON order_shipping_addresses(shop_id, order_id);

CREATE TRIGGER order_shipping_addresses_identity_immutable
BEFORE UPDATE ON order_shipping_addresses
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.order_id != OLD.order_id
  OR NEW.full_name != OLD.full_name
  OR NEW.phone != OLD.phone
  OR NEW.address_line != OLD.address_line
  OR NEW.ward != OLD.ward
  OR NEW.district != OLD.district
  OR NEW.province != OLD.province
  OR NEW.notes IS NOT OLD.notes
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'order_shipping_addresses_identity_immutable');
END;
