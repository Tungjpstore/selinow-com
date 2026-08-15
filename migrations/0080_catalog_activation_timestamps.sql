PRAGMA foreign_keys = ON;

ALTER TABLE products ADD COLUMN activated_at TEXT;
ALTER TABLE product_variants ADD COLUMN activated_at TEXT;

-- Existing rows have no transition ledger, so use their latest authoritative
-- write as the conservative activation boundary instead of backdating creation.
UPDATE products
SET activated_at = updated_at
WHERE status = 'active' AND activated_at IS NULL;

UPDATE product_variants
SET activated_at = updated_at
WHERE status = 'active' AND activated_at IS NULL;

CREATE TRIGGER products_activation_timestamp_insert
AFTER INSERT ON products
WHEN NEW.status = 'active' AND NEW.activated_at IS NULL
BEGIN
  UPDATE products
  SET activated_at = NEW.created_at
  WHERE id = NEW.id AND shop_id = NEW.shop_id AND activated_at IS NULL;
END;

CREATE TRIGGER products_activation_timestamp_update
AFTER UPDATE OF status ON products
WHEN NEW.status = 'active' AND OLD.status != 'active' AND NEW.activated_at IS NULL
BEGIN
  UPDATE products
  SET activated_at = NEW.updated_at
  WHERE id = NEW.id AND shop_id = NEW.shop_id AND activated_at IS NULL;
END;

CREATE TRIGGER products_activation_timestamp_immutable
BEFORE UPDATE OF activated_at ON products
WHEN OLD.activated_at IS NOT NULL AND NEW.activated_at IS NOT OLD.activated_at
BEGIN
  SELECT RAISE(ABORT, 'products_activated_at_immutable');
END;

CREATE TRIGGER product_variants_activation_timestamp_insert
AFTER INSERT ON product_variants
WHEN NEW.status = 'active' AND NEW.activated_at IS NULL
BEGIN
  UPDATE product_variants
  SET activated_at = NEW.created_at
  WHERE id = NEW.id AND shop_id = NEW.shop_id AND activated_at IS NULL;
END;

CREATE TRIGGER product_variants_activation_timestamp_update
AFTER UPDATE OF status ON product_variants
WHEN NEW.status = 'active' AND OLD.status != 'active' AND NEW.activated_at IS NULL
BEGIN
  UPDATE product_variants
  SET activated_at = NEW.updated_at
  WHERE id = NEW.id AND shop_id = NEW.shop_id AND activated_at IS NULL;
END;

CREATE TRIGGER product_variants_activation_timestamp_immutable
BEFORE UPDATE OF activated_at ON product_variants
WHEN OLD.activated_at IS NOT NULL AND NEW.activated_at IS NOT OLD.activated_at
BEGIN
  SELECT RAISE(ABORT, 'product_variants_activated_at_immutable');
END;
