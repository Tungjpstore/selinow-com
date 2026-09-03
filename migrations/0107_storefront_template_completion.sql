PRAGMA foreign_keys = ON;

-- Storefront template completion program (CD): per-template product detail
-- (SpecTable attributes, Metro warranty badges) and the buyer order-history
-- email lookup. Additive only: no table rebuild, invariant hashes unchanged.

-- Seller-authored spec rows rendered by Metro/Clinic detail spec tables and
-- reusable warranty badges. NULL keeps the pre-CD behavior (no spec block).
ALTER TABLE products ADD COLUMN attributes_json TEXT
  CHECK (attributes_json IS NULL OR json_valid(attributes_json));

-- Privacy-preserving buyer order lookup: HMAC-SHA256 base64url (43 chars) of
-- the normalized checkout email under a shop-scoped purpose key. Matched,
-- never reversed; written once inside the guarded checkout INSERT. Orders from
-- other channels (no website email) stay NULL and are invisible to lookup.
ALTER TABLE orders ADD COLUMN customer_email_lookup_hash TEXT
  CHECK (customer_email_lookup_hash IS NULL OR length(customer_email_lookup_hash) = 43);

-- Tenant-leading composite for the storefront /orders lookup list path.
CREATE INDEX idx_orders_shop_email_created
  ON orders(shop_id, customer_email_lookup_hash, created_at DESC, id);
