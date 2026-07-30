-- Durable replay protection for anonymous website cart mutations.
-- Telegram keeps its provider-specific action ledger, while both channels
-- execute the same mutation/pricing core.
CREATE TABLE cart_mutations (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  subject_hash TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (shop_id, subject_hash, idempotency_key_hash)
) STRICT;

CREATE INDEX idx_cart_mutations_shop_created
  ON cart_mutations(shop_id, created_at DESC, id);

CREATE INDEX idx_cart_mutations_expiry
  ON cart_mutations(expires_at);

-- The independent foreign keys above prove both records exist, but only these
-- guards prove that the replay belongs to the same Website cart and tenant.
CREATE TRIGGER cart_mutations_cart_insert_guard
BEFORE INSERT ON cart_mutations
WHEN NOT EXISTS (
  SELECT 1
  FROM carts
  WHERE carts.id = NEW.cart_id
    AND carts.shop_id = NEW.shop_id
    AND carts.channel = 'web'
    AND carts.subject_hash = NEW.subject_hash
    AND carts.expires_at = NEW.expires_at
    AND NEW.created_at < NEW.expires_at
)
BEGIN
  SELECT RAISE(ABORT, 'cart_mutation_cart_mismatch');
END;

CREATE TRIGGER cart_mutations_cart_update_guard
BEFORE UPDATE OF shop_id, cart_id, subject_hash, created_at, expires_at ON cart_mutations
WHEN NOT EXISTS (
  SELECT 1
  FROM carts
  WHERE carts.id = NEW.cart_id
    AND carts.shop_id = NEW.shop_id
    AND carts.channel = 'web'
    AND carts.subject_hash = NEW.subject_hash
    AND carts.expires_at = NEW.expires_at
    AND NEW.created_at < NEW.expires_at
)
BEGIN
  SELECT RAISE(ABORT, 'cart_mutation_cart_mismatch');
END;

CREATE TRIGGER carts_cart_mutations_update_guard
BEFORE UPDATE OF shop_id, channel, subject_hash, expires_at ON carts
WHEN EXISTS (
  SELECT 1
  FROM cart_mutations
  WHERE cart_mutations.cart_id = OLD.id
    AND (
      NEW.shop_id != cart_mutations.shop_id
      OR NEW.channel != 'web'
      OR NEW.subject_hash != cart_mutations.subject_hash
      OR NEW.expires_at != cart_mutations.expires_at
    )
)
BEGIN
  SELECT RAISE(ABORT, 'cart_mutation_cart_mismatch');
END;
