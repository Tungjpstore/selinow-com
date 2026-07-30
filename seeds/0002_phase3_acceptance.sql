PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO platform_users (
  id, email_normalized, display_name, status, created_at, updated_at
) VALUES (
  'usr_31111111-1111-4111-8111-111111111111',
  'phase3-acceptance@example.invalid',
  'Phase 3 Acceptance',
  'active',
  '2026-07-25T00:00:00.000Z',
  '2026-07-25T00:00:00.000Z'
);

INSERT OR IGNORE INTO shops (
  id, public_id, slug, name, status, default_locale, currency, timezone,
  canonical_domain_id, readiness_version, created_at, updated_at
) VALUES (
  'shp_32222222-2222-4222-8222-222222222222',
  'shop_32333333-3333-4333-8333-333333333333',
  'phase3-acceptance',
  'Phase 3 Acceptance',
  'active',
  'vi',
  'VND',
  'Asia/Ho_Chi_Minh',
  'dom_32444444-4444-4444-8444-444444444444',
  1,
  '2026-07-25T00:00:00.000Z',
  '2026-07-25T00:00:00.000Z'
);

INSERT OR IGNORE INTO shop_settings (
  shop_id, branding_json, storefront_json, order_expiry_minutes,
  low_stock_threshold, version, updated_at
) VALUES (
  'shp_32222222-2222-4222-8222-222222222222',
  '{"primaryColor":"#5B5CEB","accentColor":"#3B82F6"}',
  '{"footerText":"Phase 3 Acceptance vận hành cửa hàng trên Selinow."}',
  5, 1, 1,
  '2026-07-25T00:00:00.000Z'
);

INSERT OR IGNORE INTO shop_subscriptions (
  id, shop_id, plan_id, state, current_period_start, current_period_end,
  created_at, updated_at
) SELECT
  'sub_32555555-5555-4555-8555-555555555555',
  'shp_32222222-2222-4222-8222-222222222222',
  id,
  'active',
  '2026-07-25T00:00:00.000Z',
  '2027-07-25T00:00:00.000Z',
  '2026-07-25T00:00:00.000Z',
  '2026-07-25T00:00:00.000Z'
FROM plans WHERE code = 'store';

INSERT OR IGNORE INTO shop_domains (
  id, shop_id, hostname_normalized, type, status, is_primary,
  validation_metadata_json, activated_at, created_at, updated_at
) VALUES (
  'dom_32444444-4444-4444-8444-444444444444',
  'shp_32222222-2222-4222-8222-222222222222',
  'phase3-acceptance.localhost',
  'platform_subdomain',
  'active',
  1,
  '{}',
  '2026-07-25T00:00:00.000Z',
  '2026-07-25T00:00:00.000Z',
  '2026-07-25T00:00:00.000Z'
);

INSERT OR IGNORE INTO product_categories (
  id, shop_id, slug, name, description, sort_order, status, created_at, updated_at
) VALUES (
  'cat_32666666-6666-4666-8666-666666666666',
  'shp_32222222-2222-4222-8222-222222222222',
  'software', 'Software', '', 0, 'active',
  '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z'
);

INSERT OR IGNORE INTO products (
  id, shop_id, category_id, slug, title, description, status,
  fulfillment_type, version, created_at, updated_at
) VALUES (
  'prd_32777777-7777-4777-8777-777777777777',
  'shp_32222222-2222-4222-8222-222222222222',
  'cat_32666666-6666-4666-8666-666666666666',
  'one-last-key', 'One Last Key', '', 'active', 'license_key', 1,
  '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z'
);

INSERT OR IGNORE INTO product_variants (
  id, shop_id, product_id, sku, title, options_json, price_minor,
  compare_at_minor, currency, min_per_order, max_per_order, status,
  version, created_at, updated_at
) VALUES (
  'var_32888888-8888-4888-8888-888888888888',
  'shp_32222222-2222-4222-8222-222222222222',
  'prd_32777777-7777-4777-8777-777777777777',
  'PHASE3-ONE', 'Default', '{}', 100000, NULL, 'VND', 1, 1, 'active', 1,
  '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z'
);

INSERT OR IGNORE INTO inventory_batches (
  id, shop_id, variant_id, source, total_count, accepted_count,
  rejected_count, created_by_user_id, created_at
) VALUES (
  'bat_32999999-9999-4999-8999-999999999999',
  'shp_32222222-2222-4222-8222-222222222222',
  'var_32888888-8888-4888-8888-888888888888',
  'paste', 1, 1, 0,
  'usr_31111111-1111-4111-8111-111111111111',
  '2026-07-25T00:00:00.000Z'
);

INSERT OR IGNORE INTO inventory_keys (
  id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
  key_version, key_fingerprint, created_at
) VALUES (
  'key_32aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'shp_32222222-2222-4222-8222-222222222222',
  'var_32888888-8888-4888-8888-888888888888',
  'bat_32999999-9999-4999-8999-999999999999',
  'available', 'AA', 'AAAAAAAAAAAAAAAA', 'v1', 'phase3-acceptance-fingerprint',
  '2026-07-25T00:00:00.000Z'
);
