-- Disposable local-browser fixture only. The gate runs against a fresh local D1 state.
INSERT OR IGNORE INTO platform_users (
  id, email_normalized, display_name, status, created_at, updated_at
) VALUES
  ('usr_browser_desktop', 'browser-gate-desktop@selinow.invalid', 'Browser Gate', 'pending', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('usr_browser_mobile', 'browser-gate-mobile@selinow.invalid', 'Browser Gate', 'pending', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO platform_users (
  id, email_normalized, display_name, status, created_at, updated_at
) VALUES
  ('usr_browser_kit_desktop', 'browser-gate-kit-auth-desktop-1440@selinow.invalid', 'Browser Gate', 'pending', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('usr_browser_kit_tablet', 'browser-gate-kit-auth-tablet-768@selinow.invalid', 'Browser Gate', 'pending', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('usr_browser_kit_mobile', 'browser-gate-kit-auth-mobile-390@selinow.invalid', 'Browser Gate', 'pending', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('usr_browser_kit_minimum', 'browser-gate-kit-auth-minimum-320@selinow.invalid', 'Browser Gate', 'pending', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('usr_browser_kit_zoom', 'browser-gate-kit-auth-zoom-200@selinow.invalid', 'Browser Gate', 'pending', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO platform_admins (user_id, role, status, created_at, updated_at) VALUES
  ('usr_browser_desktop', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('usr_browser_mobile', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('usr_browser_kit_desktop', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('usr_browser_kit_tablet', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('usr_browser_kit_mobile', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('usr_browser_kit_minimum', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('usr_browser_kit_zoom', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO shops (
  id, public_id, slug, name, status, default_locale, currency, timezone,
  canonical_domain_id, readiness_version, created_at, updated_at
) VALUES
  ('shp_browser_desktop', 'shop_00000000-0000-4000-8000-000000000001', 'browser-gate-desktop', 'Browser Gate Desktop', 'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 'shop_00000000-0000-4000-8000-000000000002', 'browser-gate-mobile', 'Browser Gate Mobile', 'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'shop_00000000-0000-4000-8000-000000000003', 'browser-gate-matrix', 'Browser Gate Matrix', 'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES
  ('shp_browser_desktop', 'usr_browser_desktop', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 'usr_browser_mobile', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'usr_browser_kit_desktop', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'usr_browser_kit_tablet', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'usr_browser_kit_mobile', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'usr_browser_kit_minimum', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'usr_browser_kit_zoom', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO shop_settings (
  shop_id, branding_json, storefront_json, order_expiry_minutes,
  low_stock_threshold, version, updated_at
) VALUES
  ('shp_browser_desktop', '{}', '{}', 30, 5, 1, '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', '{}', '{}', 30, 5, 1, '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', '{}', '{}', 30, 5, 1, '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO shop_subscriptions (
  id, shop_id, plan_id, state, trial_ends_at, created_at, updated_at
) VALUES
  ('sub_browser_desktop', 'shp_browser_desktop', 'plan_business_v1', 'trialing', '2030-01-01T00:00:00.000Z', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('sub_browser_mobile', 'shp_browser_mobile', 'plan_business_v1', 'trialing', '2030-01-01T00:00:00.000Z', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('sub_browser_matrix', 'shp_browser_matrix', 'plan_business_v1', 'trialing', '2030-01-01T00:00:00.000Z', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO shop_domains (
  id, shop_id, hostname_normalized, type, status, is_primary,
  validation_metadata_json, activated_at, created_at, updated_at,
  dns_status, check_attempts, version
) VALUES
  ('dom_browser_desktop', 'shp_browser_desktop', 'browser-gate-desktop.localhost', 'platform_subdomain', 'active', 1, '{}', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z', 'active', 0, 1),
  ('dom_browser_mobile', 'shp_browser_mobile', 'browser-gate-mobile.localhost', 'platform_subdomain', 'active', 1, '{}', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z', 'active', 0, 1),
  ('dom_browser_matrix', 'shp_browser_matrix', 'browser-gate-matrix.localhost', 'platform_subdomain', 'active', 1, '{}', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z', 'active', 0, 1);

UPDATE shops SET canonical_domain_id = 'dom_browser_desktop' WHERE id = 'shp_browser_desktop';
UPDATE shops SET canonical_domain_id = 'dom_browser_mobile' WHERE id = 'shp_browser_mobile';
UPDATE shops SET canonical_domain_id = 'dom_browser_matrix' WHERE id = 'shp_browser_matrix';

INSERT OR IGNORE INTO shop_onboarding_profiles (
  shop_id, website_enabled, telegram_enabled, custom_domain_preference,
  current_step, version, created_at, updated_at
) VALUES
  ('shp_browser_desktop', 0, 1, 'later', 'channel_selected', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 0, 1, 'later', 'channel_selected', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 0, 1, 'later', 'channel_selected', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO shop_onboarding_steps (
  shop_id, step_code, status, version, created_at, updated_at
) VALUES
  ('shp_browser_desktop', 'account_ready', 'complete', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_desktop', 'shop_created', 'complete', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_desktop', 'channel_selected', 'in_progress', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_desktop', 'catalog_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_desktop', 'inventory_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_desktop', 'telegram_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_desktop', 'payos_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_desktop', 'domain_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_desktop', 'readiness_passed', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_desktop', 'published', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 'account_ready', 'complete', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 'shop_created', 'complete', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 'channel_selected', 'in_progress', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 'catalog_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 'inventory_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 'telegram_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 'payos_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 'domain_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 'readiness_passed', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 'published', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'account_ready', 'complete', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'shop_created', 'complete', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'channel_selected', 'in_progress', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'catalog_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'inventory_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'telegram_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'payos_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'domain_ready', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'readiness_passed', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_matrix', 'published', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO products (
  id, shop_id, category_id, slug, title, description, status,
  fulfillment_type, version, created_at, updated_at
) VALUES
  ('prd_browser_desktop', 'shp_browser_desktop', NULL, 'browser-gate-license', 'Browser Gate License', 'Deterministic local order fixture.', 'active', 'manual', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('prd_browser_mobile', 'shp_browser_mobile', NULL, 'browser-gate-license', 'Browser Gate License', 'Deterministic local order fixture.', 'active', 'manual', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO product_variants (
  id, shop_id, product_id, sku, title, options_json, price_minor,
  compare_at_minor, currency, min_per_order, max_per_order, status,
  version, created_at, updated_at
) VALUES
  ('var_browser_desktop', 'shp_browser_desktop', 'prd_browser_desktop', 'BROWSER-DESKTOP', 'Lifetime', '{}', 249000, NULL, 'VND', 1, 1, 'active', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('var_browser_mobile', 'shp_browser_mobile', 'prd_browser_mobile', 'BROWSER-MOBILE', 'Lifetime', '{}', 249000, NULL, 'VND', 1, 1, 'active', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

-- Checkout guards require an active shop at order creation time. The fixture
-- restores the original draft state after inserting immutable order snapshots.
UPDATE shops SET status = 'active' WHERE id IN ('shp_browser_desktop', 'shp_browser_mobile');

INSERT OR IGNORE INTO orders (
  id, public_id, shop_id, customer_id, order_number, source_channel,
  status, payment_status, fulfillment_status, subtotal_minor,
  discount_minor, total_minor, currency, locale, customer_email_masked,
  checkout_subject_hash, order_token_hash, expires_at, paid_at,
  fulfilled_at, created_at, updated_at
) VALUES
  ('ord_browser_d_pending', 'order_00000000-0000-4000-8000-000000000101', 'shp_browser_desktop', NULL, 'BR-D-101', 'web', 'pending_payment', 'unpaid', 'unfulfilled', 249000, 0, 249000, 'VND', 'vi', 'bu***@example.test', 'subject-browser-d-101', 'token-browser-d-101', '2030-01-01T00:30:00.000Z', NULL, NULL, '2026-07-27T01:01:00.000Z', '2026-07-27T01:01:00.000Z'),
  ('ord_browser_d_processing', 'order_00000000-0000-4000-8000-000000000102', 'shp_browser_desktop', NULL, 'BR-D-102', 'web', 'processing', 'paid', 'reserved', 249000, 0, 249000, 'VND', 'vi', 'bu***@example.test', 'subject-browser-d-102', 'token-browser-d-102', '2030-01-01T00:30:00.000Z', '2026-07-27T01:12:00.000Z', NULL, '2026-07-27T01:02:00.000Z', '2026-07-27T01:12:00.000Z'),
  ('ord_browser_d_fulfilled', 'order_00000000-0000-4000-8000-000000000103', 'shp_browser_desktop', NULL, 'BR-D-103', 'web', 'completed', 'paid', 'fulfilled', 249000, 0, 249000, 'VND', 'vi', 'bu***@example.test', 'subject-browser-d-103', 'token-browser-d-103', '2030-01-01T00:30:00.000Z', '2026-07-27T01:13:00.000Z', '2026-07-27T01:14:00.000Z', '2026-07-27T01:03:00.000Z', '2026-07-27T01:14:00.000Z'),
  ('ord_browser_d_failed', 'order_00000000-0000-4000-8000-000000000104', 'shp_browser_desktop', NULL, 'BR-D-104', 'web', 'exception', 'failed', 'failed', 249000, 0, 249000, 'VND', 'vi', 'bu***@example.test', 'subject-browser-d-104', 'token-browser-d-104', '2030-01-01T00:30:00.000Z', NULL, NULL, '2026-07-27T01:04:00.000Z', '2026-07-27T01:15:00.000Z'),
  ('ord_browser_m_pending', 'order_00000000-0000-4000-8000-000000000201', 'shp_browser_mobile', NULL, 'BR-M-201', 'web', 'pending_payment', 'unpaid', 'unfulfilled', 249000, 0, 249000, 'VND', 'vi', 'bu***@example.test', 'subject-browser-m-201', 'token-browser-m-201', '2030-01-01T00:30:00.000Z', NULL, NULL, '2026-07-27T02:01:00.000Z', '2026-07-27T02:01:00.000Z'),
  ('ord_browser_m_processing', 'order_00000000-0000-4000-8000-000000000202', 'shp_browser_mobile', NULL, 'BR-M-202', 'web', 'processing', 'paid', 'reserved', 249000, 0, 249000, 'VND', 'vi', 'bu***@example.test', 'subject-browser-m-202', 'token-browser-m-202', '2030-01-01T00:30:00.000Z', '2026-07-27T02:12:00.000Z', NULL, '2026-07-27T02:02:00.000Z', '2026-07-27T02:12:00.000Z'),
  ('ord_browser_m_fulfilled', 'order_00000000-0000-4000-8000-000000000203', 'shp_browser_mobile', NULL, 'BR-M-203', 'web', 'completed', 'paid', 'fulfilled', 249000, 0, 249000, 'VND', 'vi', 'bu***@example.test', 'subject-browser-m-203', 'token-browser-m-203', '2030-01-01T00:30:00.000Z', '2026-07-27T02:13:00.000Z', '2026-07-27T02:14:00.000Z', '2026-07-27T02:03:00.000Z', '2026-07-27T02:14:00.000Z'),
  ('ord_browser_m_failed', 'order_00000000-0000-4000-8000-000000000204', 'shp_browser_mobile', NULL, 'BR-M-204', 'web', 'exception', 'failed', 'failed', 249000, 0, 249000, 'VND', 'vi', 'bu***@example.test', 'subject-browser-m-204', 'token-browser-m-204', '2030-01-01T00:30:00.000Z', NULL, NULL, '2026-07-27T02:04:00.000Z', '2026-07-27T02:15:00.000Z');

INSERT OR IGNORE INTO order_items (
  id, shop_id, order_id, product_id, variant_id, product_title,
  variant_title, sku, unit_price_minor, quantity, line_total_minor,
  fulfillment_type, created_at
) VALUES
  ('oit_browser_d_101', 'shp_browser_desktop', 'ord_browser_d_pending', 'prd_browser_desktop', 'var_browser_desktop', 'Browser Gate License', 'Lifetime', 'BROWSER-DESKTOP', 249000, 1, 249000, 'manual', '2026-07-27T01:01:00.000Z'),
  ('oit_browser_d_102', 'shp_browser_desktop', 'ord_browser_d_processing', 'prd_browser_desktop', 'var_browser_desktop', 'Browser Gate License', 'Lifetime', 'BROWSER-DESKTOP', 249000, 1, 249000, 'manual', '2026-07-27T01:02:00.000Z'),
  ('oit_browser_d_103', 'shp_browser_desktop', 'ord_browser_d_fulfilled', 'prd_browser_desktop', 'var_browser_desktop', 'Browser Gate License', 'Lifetime', 'BROWSER-DESKTOP', 249000, 1, 249000, 'manual', '2026-07-27T01:03:00.000Z'),
  ('oit_browser_d_104', 'shp_browser_desktop', 'ord_browser_d_failed', 'prd_browser_desktop', 'var_browser_desktop', 'Browser Gate License', 'Lifetime', 'BROWSER-DESKTOP', 249000, 1, 249000, 'manual', '2026-07-27T01:04:00.000Z'),
  ('oit_browser_m_201', 'shp_browser_mobile', 'ord_browser_m_pending', 'prd_browser_mobile', 'var_browser_mobile', 'Browser Gate License', 'Lifetime', 'BROWSER-MOBILE', 249000, 1, 249000, 'manual', '2026-07-27T02:01:00.000Z'),
  ('oit_browser_m_202', 'shp_browser_mobile', 'ord_browser_m_processing', 'prd_browser_mobile', 'var_browser_mobile', 'Browser Gate License', 'Lifetime', 'BROWSER-MOBILE', 249000, 1, 249000, 'manual', '2026-07-27T02:02:00.000Z'),
  ('oit_browser_m_203', 'shp_browser_mobile', 'ord_browser_m_fulfilled', 'prd_browser_mobile', 'var_browser_mobile', 'Browser Gate License', 'Lifetime', 'BROWSER-MOBILE', 249000, 1, 249000, 'manual', '2026-07-27T02:03:00.000Z'),
  ('oit_browser_m_204', 'shp_browser_mobile', 'ord_browser_m_failed', 'prd_browser_mobile', 'var_browser_mobile', 'Browser Gate License', 'Lifetime', 'BROWSER-MOBILE', 249000, 1, 249000, 'manual', '2026-07-27T02:04:00.000Z');

INSERT OR IGNORE INTO fulfillments (
  id, shop_id, order_id, fulfillment_type, state, idempotency_key,
  created_at, fulfilled_at, failed_at
) VALUES
  ('ful_browser_d_102', 'shp_browser_desktop', 'ord_browser_d_processing', 'manual', 'pending', 'browser-fulfillment-d-102', '2026-07-27T01:12:00.000Z', NULL, NULL),
  ('ful_browser_d_103', 'shp_browser_desktop', 'ord_browser_d_fulfilled', 'manual', 'fulfilled', 'browser-fulfillment-d-103', '2026-07-27T01:13:00.000Z', '2026-07-27T01:14:00.000Z', NULL),
  ('ful_browser_d_104', 'shp_browser_desktop', 'ord_browser_d_failed', 'manual', 'failed', 'browser-fulfillment-d-104', '2026-07-27T01:14:00.000Z', NULL, '2026-07-27T01:15:00.000Z'),
  ('ful_browser_m_202', 'shp_browser_mobile', 'ord_browser_m_processing', 'manual', 'pending', 'browser-fulfillment-m-202', '2026-07-27T02:12:00.000Z', NULL, NULL),
  ('ful_browser_m_203', 'shp_browser_mobile', 'ord_browser_m_fulfilled', 'manual', 'fulfilled', 'browser-fulfillment-m-203', '2026-07-27T02:13:00.000Z', '2026-07-27T02:14:00.000Z', NULL),
  ('ful_browser_m_204', 'shp_browser_mobile', 'ord_browser_m_failed', 'manual', 'failed', 'browser-fulfillment-m-204', '2026-07-27T02:14:00.000Z', NULL, '2026-07-27T02:15:00.000Z');

INSERT OR IGNORE INTO audit_logs (
  id, shop_id, actor_type, actor_id, action, resource_type,
  resource_id, safe_metadata_json, request_id, created_at
) VALUES
  ('aud_browser_d_101', 'shp_browser_desktop', 'system', NULL, 'order.created', 'order', 'ord_browser_d_pending', '{}', 'browser-request-d-101', '2026-07-27T01:01:00.000Z'),
  ('aud_browser_d_102', 'shp_browser_desktop', 'system', NULL, 'order.payment_confirmed', 'order', 'ord_browser_d_processing', '{}', 'browser-request-d-102', '2026-07-27T01:12:00.000Z'),
  ('aud_browser_d_103', 'shp_browser_desktop', 'system', NULL, 'order.fulfilled', 'order', 'ord_browser_d_fulfilled', '{}', 'browser-request-d-103', '2026-07-27T01:14:00.000Z'),
  ('aud_browser_d_104', 'shp_browser_desktop', 'system', NULL, 'order.failed', 'order', 'ord_browser_d_failed', '{}', 'browser-request-d-104', '2026-07-27T01:15:00.000Z'),
  ('aud_browser_m_201', 'shp_browser_mobile', 'system', NULL, 'order.created', 'order', 'ord_browser_m_pending', '{}', 'browser-request-m-201', '2026-07-27T02:01:00.000Z'),
  ('aud_browser_m_202', 'shp_browser_mobile', 'system', NULL, 'order.payment_confirmed', 'order', 'ord_browser_m_processing', '{}', 'browser-request-m-202', '2026-07-27T02:12:00.000Z'),
  ('aud_browser_m_203', 'shp_browser_mobile', 'system', NULL, 'order.fulfilled', 'order', 'ord_browser_m_fulfilled', '{}', 'browser-request-m-203', '2026-07-27T02:14:00.000Z'),
  ('aud_browser_m_204', 'shp_browser_mobile', 'system', NULL, 'order.failed', 'order', 'ord_browser_m_failed', '{}', 'browser-request-m-204', '2026-07-27T02:15:00.000Z');

UPDATE shops SET status = 'draft' WHERE id IN ('shp_browser_desktop', 'shp_browser_mobile');
