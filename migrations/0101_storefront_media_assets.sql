PRAGMA foreign_keys = ON;

-- Storefront media assets (product images, shop logos, hero banners).
-- Objects live in the MEDIA R2 bucket under storefront-media/<shop_id>/<id>;
-- D1 is the authoritative registry, and upload-time quota is enforced against
-- plans.limits_json.storageBytes (see src/lib/media/assets.ts).
CREATE TABLE media_assets (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  public_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('product_image', 'shop_logo', 'hero_banner')),
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (
    content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/avif')
  ),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  content_sha256 TEXT NOT NULL,
  object_etag TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (shop_id, id),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_media_assets_shop_status
  ON media_assets(shop_id, status, created_at DESC, id);

CREATE TRIGGER media_assets_identity_immutable
BEFORE UPDATE ON media_assets
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.public_id != OLD.public_id
  OR NEW.kind != OLD.kind
  OR NEW.object_key != OLD.object_key
  OR NEW.content_type != OLD.content_type
  OR NEW.byte_size != OLD.byte_size
  OR NEW.content_sha256 != OLD.content_sha256
  OR NEW.object_etag != OLD.object_etag
  OR NEW.created_by_user_id != OLD.created_by_user_id
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'media_asset_identity_immutable');
END;

CREATE TRIGGER media_assets_transition_guard
BEFORE UPDATE ON media_assets
WHEN NOT (
  (OLD.status = 'active' AND NEW.status IN ('active', 'deleted'))
  OR (OLD.status = 'deleted' AND NEW.status = 'deleted')
)
BEGIN
  SELECT RAISE(ABORT, 'media_asset_transition_invalid');
END;

-- Product image assignments. Composite tenant keys keep the image, product,
-- and media asset inside one shop; sort_order drives storefront ordering.
CREATE TABLE product_images (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL,
  media_asset_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0 AND sort_order <= 10000),
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES products(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, media_asset_id) REFERENCES media_assets(shop_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_product_images_product
  ON product_images(shop_id, product_id, status, sort_order, id);

CREATE TRIGGER product_images_identity_immutable
BEFORE UPDATE ON product_images
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.product_id != OLD.product_id
  OR NEW.media_asset_id != OLD.media_asset_id
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'product_image_identity_immutable');
END;

CREATE TRIGGER product_images_transition_guard
BEFORE UPDATE ON product_images
WHEN NOT (
  (OLD.status = 'active' AND NEW.status IN ('active', 'deleted'))
  OR (OLD.status = 'deleted' AND NEW.status = 'deleted')
)
BEGIN
  SELECT RAISE(ABORT, 'product_image_transition_invalid');
END;
