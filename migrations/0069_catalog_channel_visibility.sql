PRAGMA foreign_keys = ON;

-- Catalog availability is channel-specific.  A missing row is deliberately
-- fail-closed so a newly introduced channel cannot publish products before an
-- explicit seller decision or a reviewed backfill.
CREATE TABLE catalog_channel_visibility (
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  channel_code TEXT NOT NULL CHECK (channel_code IN (
    'website',
    'telegram',
    'telegram.mini_app',
    'zalo.mini_app',
    'zalo.oa',
    'whatsapp.cloud',
    'discord.bot'
  )),
  status TEXT NOT NULL CHECK (status IN ('visible', 'hidden')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, product_id, channel_code)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_catalog_channel_visibility_shop_channel_status
  ON catalog_channel_visibility(shop_id, channel_code, status, product_id);

CREATE INDEX idx_catalog_channel_visibility_shop_product
  ON catalog_channel_visibility(shop_id, product_id, channel_code);

-- The product id is globally unique today, but the explicit tenant guard keeps
-- this invariant true if the key strategy changes in a later migration.
CREATE TRIGGER catalog_channel_visibility_scope_insert_guard
BEFORE INSERT ON catalog_channel_visibility
WHEN NOT EXISTS (
  SELECT 1 FROM products
  WHERE products.id = NEW.product_id
    AND products.shop_id = NEW.shop_id
)
BEGIN
  SELECT RAISE(ABORT, 'catalog_channel_visibility_scope_mismatch');
END;

CREATE TRIGGER catalog_channel_visibility_scope_update_guard
BEFORE UPDATE ON catalog_channel_visibility
WHEN NEW.shop_id != OLD.shop_id
  OR NEW.product_id != OLD.product_id
  OR NOT EXISTS (
    SELECT 1 FROM products
    WHERE products.id = NEW.product_id
      AND products.shop_id = NEW.shop_id
  )
BEGIN
  SELECT RAISE(ABORT, 'catalog_channel_visibility_scope_mismatch');
END;

CREATE TRIGGER catalog_channel_visibility_lifecycle_guard
BEFORE UPDATE ON catalog_channel_visibility
WHEN NEW.channel_code != OLD.channel_code
  OR NEW.created_at != OLD.created_at
  OR NEW.version != OLD.version + 1
  OR NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'catalog_channel_visibility_transition_invalid');
END;

CREATE TRIGGER catalog_channel_visibility_no_delete
BEFORE DELETE ON catalog_channel_visibility
BEGIN
  SELECT RAISE(ABORT, 'catalog_channel_visibility_immutable');
END;

-- Existing products remain visible on the established website and any channel
-- that is already enabled.  New expansion channels remain hidden by absence
-- until a connection is enabled or a seller explicitly enables them.
INSERT OR IGNORE INTO catalog_channel_visibility (
  shop_id, product_id, channel_code, status, version, updated_by_user_id,
  created_at, updated_at
)
SELECT products.shop_id, products.id, 'website', 'visible', 1, NULL,
  products.created_at, products.updated_at
FROM products;

INSERT OR IGNORE INTO catalog_channel_visibility (
  shop_id, product_id, channel_code, status, version, updated_by_user_id,
  created_at, updated_at
)
SELECT DISTINCT products.shop_id, products.id, shop_channels.channel_code,
  'visible', 1, NULL, products.created_at, products.updated_at
FROM products
INNER JOIN shop_channels
  ON shop_channels.shop_id = products.shop_id
  AND shop_channels.status = 'enabled'
  AND shop_channels.channel_code IN (
    'telegram',
    'telegram.mini_app',
    'zalo.mini_app',
    'zalo.oa',
    'whatsapp.cloud',
    'discord.bot'
  );

-- Legacy Telegram integrations predate generic shop_channels.  Preserve the
-- old live projection without making a disabled integration public.
INSERT OR IGNORE INTO catalog_channel_visibility (
  shop_id, product_id, channel_code, status, version, updated_by_user_id,
  created_at, updated_at
)
SELECT products.shop_id, products.id, 'telegram', 'visible', 1, NULL,
  products.created_at, products.updated_at
FROM products
INNER JOIN telegram_integrations
  ON telegram_integrations.shop_id = products.shop_id
  AND telegram_integrations.status IN ('active', 'degraded');

CREATE TRIGGER catalog_channel_visibility_product_insert_defaults
AFTER INSERT ON products
BEGIN
  INSERT OR IGNORE INTO catalog_channel_visibility (
    shop_id, product_id, channel_code, status, version, updated_by_user_id,
    created_at, updated_at
  ) VALUES (
    NEW.shop_id, NEW.id, 'website', 'visible', 1, NULL,
    NEW.created_at, NEW.updated_at
  );

  INSERT OR IGNORE INTO catalog_channel_visibility (
    shop_id, product_id, channel_code, status, version, updated_by_user_id,
    created_at, updated_at
  )
  SELECT NEW.shop_id, NEW.id, shop_channels.channel_code, 'visible', 1, NULL,
    NEW.created_at, NEW.updated_at
  FROM shop_channels
  WHERE shop_channels.shop_id = NEW.shop_id
    AND shop_channels.status = 'enabled'
    AND shop_channels.channel_code IN (
      'telegram',
      'telegram.mini_app',
      'zalo.mini_app',
      'zalo.oa',
      'whatsapp.cloud',
      'discord.bot'
    );
END;

CREATE TRIGGER catalog_channel_visibility_channel_insert_defaults
AFTER INSERT ON shop_channels
WHEN NEW.status = 'enabled'
  AND NEW.channel_code IN (
    'telegram',
    'telegram.mini_app',
    'zalo.mini_app',
    'zalo.oa',
    'whatsapp.cloud',
    'discord.bot'
  )
BEGIN
  INSERT OR IGNORE INTO catalog_channel_visibility (
    shop_id, product_id, channel_code, status, version, updated_by_user_id,
    created_at, updated_at
  )
  SELECT products.shop_id, products.id, NEW.channel_code, 'visible', 1, NULL,
    products.created_at, products.updated_at
  FROM products
  WHERE products.shop_id = NEW.shop_id;
END;

CREATE TRIGGER catalog_channel_visibility_channel_enable_defaults
AFTER UPDATE OF status ON shop_channels
WHEN NEW.status = 'enabled'
  AND OLD.status != 'enabled'
  AND NEW.channel_code IN (
    'telegram',
    'telegram.mini_app',
    'zalo.mini_app',
    'zalo.oa',
    'whatsapp.cloud',
    'discord.bot'
  )
BEGIN
  INSERT OR IGNORE INTO catalog_channel_visibility (
    shop_id, product_id, channel_code, status, version, updated_by_user_id,
    created_at, updated_at
  )
  SELECT products.shop_id, products.id, NEW.channel_code, 'visible', 1, NULL,
    products.created_at, products.updated_at
  FROM products
  WHERE products.shop_id = NEW.shop_id;
END;
