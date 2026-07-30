-- Disposable local-browser fixture only. The gate runs against a fresh local D1 state.
INSERT OR IGNORE INTO platform_users (
  id, email_normalized, display_name, status, created_at, updated_at
) VALUES
  ('usr_browser_desktop', 'browser-gate-desktop@selinow.invalid', 'Browser Gate', 'pending', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('usr_browser_mobile', 'browser-gate-mobile@selinow.invalid', 'Browser Gate', 'pending', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO platform_admins (user_id, role, status, created_at, updated_at) VALUES
  ('usr_browser_desktop', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('usr_browser_mobile', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO shops (
  id, public_id, slug, name, status, default_locale, currency, timezone,
  canonical_domain_id, readiness_version, created_at, updated_at
) VALUES
  ('shp_browser_desktop', 'shop_00000000-0000-4000-8000-000000000001', 'browser-gate-desktop', 'Browser Gate Desktop', 'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 'shop_00000000-0000-4000-8000-000000000002', 'browser-gate-mobile', 'Browser Gate Mobile', 'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES
  ('shp_browser_desktop', 'usr_browser_desktop', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 'usr_browser_mobile', 'owner', 'active', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO shop_settings (
  shop_id, branding_json, storefront_json, order_expiry_minutes,
  low_stock_threshold, version, updated_at
) VALUES
  ('shp_browser_desktop', '{}', '{}', 30, 5, 1, '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', '{}', '{}', 30, 5, 1, '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO shop_subscriptions (
  id, shop_id, plan_id, state, trial_ends_at, created_at, updated_at
) VALUES
  ('sub_browser_desktop', 'shp_browser_desktop', 'plan_business_v1', 'trialing', '2030-01-01T00:00:00.000Z', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('sub_browser_mobile', 'shp_browser_mobile', 'plan_business_v1', 'trialing', '2030-01-01T00:00:00.000Z', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

INSERT OR IGNORE INTO shop_domains (
  id, shop_id, hostname_normalized, type, status, is_primary,
  validation_metadata_json, activated_at, created_at, updated_at,
  dns_status, check_attempts, version
) VALUES
  ('dom_browser_desktop', 'shp_browser_desktop', 'browser-gate-desktop.localhost', 'platform_subdomain', 'active', 1, '{}', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z', 'active', 0, 1),
  ('dom_browser_mobile', 'shp_browser_mobile', 'browser-gate-mobile.localhost', 'platform_subdomain', 'active', 1, '{}', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z', 'active', 0, 1);

UPDATE shops SET canonical_domain_id = 'dom_browser_desktop' WHERE id = 'shp_browser_desktop';
UPDATE shops SET canonical_domain_id = 'dom_browser_mobile' WHERE id = 'shp_browser_mobile';

INSERT OR IGNORE INTO shop_onboarding_profiles (
  shop_id, website_enabled, telegram_enabled, custom_domain_preference,
  current_step, version, created_at, updated_at
) VALUES
  ('shp_browser_desktop', 0, 1, 'later', 'channel_selected', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'),
  ('shp_browser_mobile', 0, 1, 'later', 'channel_selected', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');

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
  ('shp_browser_mobile', 'published', 'pending', 1, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z');
