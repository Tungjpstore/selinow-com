PRAGMA foreign_keys = ON;

ALTER TABLE shop_settings
  ADD COLUMN published_branding_json TEXT CHECK (
    published_branding_json IS NULL OR json_valid(published_branding_json)
  );

ALTER TABLE shop_settings
  ADD COLUMN published_storefront_json TEXT CHECK (
    published_storefront_json IS NULL OR json_valid(published_storefront_json)
  );

ALTER TABLE shop_settings
  ADD COLUMN published_version INTEGER NOT NULL DEFAULT 0 CHECK (published_version >= 0);

ALTER TABLE shop_settings
  ADD COLUMN published_at TEXT;

-- Preserve the last live presentation for shops that were already public.
-- Never promote a draft shop implicitly during migration.
UPDATE shop_settings
SET published_branding_json = branding_json,
    published_storefront_json = storefront_json,
    published_version = version,
    published_at = updated_at
WHERE EXISTS (
  SELECT 1
  FROM shops
  WHERE shops.id = shop_settings.shop_id
    AND shops.status IN ('active', 'suspended', 'archived')
);
