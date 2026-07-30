PRAGMA foreign_keys = ON;

-- Orders are immutable money snapshots. Refuse to install the guards when
-- persisted rows use an unsupported currency or disagree with their shop.
CREATE TABLE IF NOT EXISTS migration_0044_order_currency_validation (
  invalid_count INTEGER NOT NULL,
  CONSTRAINT migration_0044_order_currency_valid
    CHECK (invalid_count = 0)
) STRICT;

DELETE FROM migration_0044_order_currency_validation;

INSERT INTO migration_0044_order_currency_validation (invalid_count)
SELECT COUNT(*)
FROM orders
WHERE NOT EXISTS (
    SELECT 1
    FROM iso_4217_currency_codes
    WHERE iso_4217_currency_codes.code = orders.currency
  )
  OR NOT EXISTS (
    SELECT 1
    FROM shops
    WHERE shops.id = orders.shop_id
      AND shops.currency = orders.currency
  );

DROP TABLE migration_0044_order_currency_validation;

CREATE TRIGGER IF NOT EXISTS orders_currency_insert_shop_guard
BEFORE INSERT ON orders
WHEN NOT EXISTS (
  SELECT 1
  FROM shops
  WHERE shops.id = NEW.shop_id
    AND shops.currency = NEW.currency
)
BEGIN
  SELECT RAISE(ABORT, 'order_currency_shop_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS orders_currency_update_shop_guard
BEFORE UPDATE OF currency, shop_id ON orders
WHEN NOT EXISTS (
  SELECT 1
  FROM shops
  WHERE shops.id = NEW.shop_id
    AND shops.currency = NEW.currency
)
BEGIN
  SELECT RAISE(ABORT, 'order_currency_shop_mismatch');
END;

-- Install unsupported-currency guards last so they take precedence over the
-- broader shop-match guards when both predicates reject the same write.
CREATE TRIGGER IF NOT EXISTS orders_currency_insert_unsupported_guard
BEFORE INSERT ON orders
WHEN NOT EXISTS (
  SELECT 1
  FROM iso_4217_currency_codes
  WHERE iso_4217_currency_codes.code = NEW.currency
)
BEGIN
  SELECT RAISE(ABORT, 'order_currency_unsupported');
END;

CREATE TRIGGER IF NOT EXISTS orders_currency_update_unsupported_guard
BEFORE UPDATE OF currency, shop_id ON orders
WHEN NOT EXISTS (
  SELECT 1
  FROM iso_4217_currency_codes
  WHERE iso_4217_currency_codes.code = NEW.currency
)
BEGIN
  SELECT RAISE(ABORT, 'order_currency_unsupported');
END;
