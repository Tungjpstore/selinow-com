PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO shops (
  id, public_id, slug, name, status, default_locale, currency, timezone,
  canonical_domain_id, readiness_version, created_at, updated_at
) VALUES
  ('shp_61000000-0000-4000-8000-000000000001', 'shop_61000000-0000-4000-8000-000000000001', 'signal', 'Signal Supply', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('shp_62000000-0000-4000-8000-000000000002', 'shop_62000000-0000-4000-8000-000000000002', 'canvas', 'Canvas Works', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('shp_63000000-0000-4000-8000-000000000003', 'shop_63000000-0000-4000-8000-000000000003', 'coming-soon', 'Coming Soon Lab', 'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('shp_64000000-0000-4000-8000-000000000004', 'shop_64000000-0000-4000-8000-000000000004', 'paused', 'Paused Store', 'suspended', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z');

INSERT OR IGNORE INTO shop_settings (
  shop_id, branding_json, storefront_json, order_expiry_minutes,
  low_stock_threshold, version, updated_at
) VALUES
  ('shp_61000000-0000-4000-8000-000000000001', '{"primaryColor":"#5B5CEB","accentColor":"#3B82F6"}', '{"headline":"Công cụ sắc gọn cho một ngày làm việc sâu.","description":"Bộ phần mềm chọn lọc cho developer và đội vận hành. Mua một lần, nhận thông tin giao hàng ngay sau khi thanh toán được xác nhận.","announcement":"Hỗ trợ kiểm tra phiên bản trước khi mua","footerText":"Signal Supply vận hành cửa hàng trên Selinow.","supportText":"Hỗ trợ trực tiếp từ Signal Supply","showExactStock":false}', 30, 3, 1, '2026-07-26T00:00:00.000Z'),
  ('shp_62000000-0000-4000-8000-000000000002', '{"primaryColor":"#7C3AED","accentColor":"#5B5CEB"}', '{"headline":"Tài nguyên sáng tạo, bớt một vòng tìm kiếm.","description":"Template và công cụ cho designer độc lập. Catalog rõ ràng, thanh toán theo đúng cửa hàng và theo dõi đơn bằng liên kết riêng.","footerText":"Canvas Works vận hành cửa hàng trên Selinow.","supportText":"Hỗ trợ trực tiếp từ Canvas Works","showExactStock":false}', 30, 5, 1, '2026-07-26T00:00:00.000Z'),
  ('shp_63000000-0000-4000-8000-000000000003', '{"primaryColor":"#3B82F6","accentColor":"#7C3AED"}', '{"footerText":"Coming Soon Lab vận hành cửa hàng trên Selinow."}', 30, 5, 1, '2026-07-26T00:00:00.000Z'),
  ('shp_64000000-0000-4000-8000-000000000004', '{"primaryColor":"#0B1020","accentColor":"#5B5CEB"}', '{"footerText":"Paused Store vận hành cửa hàng trên Selinow."}', 30, 5, 1, '2026-07-26T00:00:00.000Z');

INSERT OR IGNORE INTO shop_subscriptions (
  id, shop_id, plan_id, state, current_period_start, current_period_end, created_at, updated_at
) SELECT 'sub_61000000-0000-4000-8000-000000000001', 'shp_61000000-0000-4000-8000-000000000001', id, 'active', '2026-07-26T00:00:00.000Z', '2027-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z' FROM plans WHERE code = 'store';
INSERT OR IGNORE INTO shop_subscriptions (
  id, shop_id, plan_id, state, current_period_start, current_period_end, created_at, updated_at
) SELECT 'sub_62000000-0000-4000-8000-000000000002', 'shp_62000000-0000-4000-8000-000000000002', id, 'active', '2026-07-26T00:00:00.000Z', '2027-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z' FROM plans WHERE code = 'store';
INSERT OR IGNORE INTO shop_subscriptions (
  id, shop_id, plan_id, state, current_period_start, current_period_end, created_at, updated_at
) SELECT 'sub_63000000-0000-4000-8000-000000000003', 'shp_63000000-0000-4000-8000-000000000003', id, 'active', '2026-07-26T00:00:00.000Z', '2027-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z' FROM plans WHERE code = 'store';
INSERT OR IGNORE INTO shop_subscriptions (
  id, shop_id, plan_id, state, current_period_start, current_period_end, created_at, updated_at
) SELECT 'sub_64000000-0000-4000-8000-000000000004', 'shp_64000000-0000-4000-8000-000000000004', id, 'active', '2026-07-26T00:00:00.000Z', '2027-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z' FROM plans WHERE code = 'store';

INSERT OR IGNORE INTO shop_domains (
  id, shop_id, hostname_normalized, type, status, is_primary,
  validation_metadata_json, activated_at, created_at, updated_at
) VALUES
  ('dom_61000000-0000-4000-8000-000000000011', 'shp_61000000-0000-4000-8000-000000000001', 'signal.staging.selinow.com', 'platform_subdomain', 'active', 1, '{}', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('dom_61000000-0000-4000-8000-000000000012', 'shp_61000000-0000-4000-8000-000000000001', 'signal.localhost', 'platform_subdomain', 'active', 0, '{}', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('dom_62000000-0000-4000-8000-000000000021', 'shp_62000000-0000-4000-8000-000000000002', 'canvas.staging.selinow.com', 'platform_subdomain', 'active', 1, '{}', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('dom_62000000-0000-4000-8000-000000000022', 'shp_62000000-0000-4000-8000-000000000002', 'canvas.localhost', 'platform_subdomain', 'active', 0, '{}', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('dom_63000000-0000-4000-8000-000000000031', 'shp_63000000-0000-4000-8000-000000000003', 'coming-soon.staging.selinow.com', 'platform_subdomain', 'active', 1, '{}', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('dom_63000000-0000-4000-8000-000000000032', 'shp_63000000-0000-4000-8000-000000000003', 'coming-soon.localhost', 'platform_subdomain', 'active', 0, '{}', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('dom_64000000-0000-4000-8000-000000000041', 'shp_64000000-0000-4000-8000-000000000004', 'paused.staging.selinow.com', 'platform_subdomain', 'active', 1, '{}', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('dom_64000000-0000-4000-8000-000000000042', 'shp_64000000-0000-4000-8000-000000000004', 'paused.localhost', 'platform_subdomain', 'active', 0, '{}', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z');

INSERT OR IGNORE INTO product_categories (
  id, shop_id, slug, name, description, sort_order, status, created_at, updated_at
) VALUES
  ('cat_61000000-0000-4000-8000-000000000001', 'shp_61000000-0000-4000-8000-000000000001', 'developer-tools', 'Developer Tools', 'Công cụ cho developer và vận hành.', 0, 'active', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('cat_62000000-0000-4000-8000-000000000002', 'shp_62000000-0000-4000-8000-000000000002', 'creative-assets', 'Creative Assets', 'Tài nguyên cho designer độc lập.', 0, 'active', '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z');

INSERT OR IGNORE INTO products (
  id, shop_id, category_id, slug, title, description, status,
  fulfillment_type, version, created_at, updated_at
) VALUES
  ('prd_61000000-0000-4000-8000-000000000001', 'shp_61000000-0000-4000-8000-000000000001', 'cat_61000000-0000-4000-8000-000000000001', 'signal-editor-lifetime', 'Signal Editor Lifetime', 'Trình soạn thảo tập trung cho dự án dài hơi, kèm quyền cập nhật trong vòng đời phiên bản.', 'active', 'manual', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('prd_61000000-0000-4000-8000-000000000002', 'shp_61000000-0000-4000-8000-000000000001', 'cat_61000000-0000-4000-8000-000000000001', 'deploy-notes-pro', 'Deploy Notes Pro', 'Bộ mẫu release note và checklist triển khai dành cho nhóm sản phẩm nhỏ.', 'active', 'manual', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('prd_62000000-0000-4000-8000-000000000001', 'shp_62000000-0000-4000-8000-000000000002', 'cat_62000000-0000-4000-8000-000000000002', 'editorial-canvas-pack', 'Editorial Canvas Pack', 'Hệ template editorial giàu khoảng thở cho portfolio, proposal và social launch.', 'active', 'manual', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z');

INSERT OR IGNORE INTO product_variants (
  id, shop_id, product_id, sku, title, options_json, price_minor,
  compare_at_minor, currency, min_per_order, max_per_order, status,
  version, created_at, updated_at
) VALUES
  ('var_61000000-0000-4000-8000-000000000001', 'shp_61000000-0000-4000-8000-000000000001', 'prd_61000000-0000-4000-8000-000000000001', 'SIGNAL-LIFETIME', 'Lifetime', '{}', 249000, 329000, 'VND', 1, 3, 'active', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('var_61000000-0000-4000-8000-000000000002', 'shp_61000000-0000-4000-8000-000000000001', 'prd_61000000-0000-4000-8000-000000000002', 'DEPLOY-NOTES-PRO', 'Team', '{}', 149000, NULL, 'VND', 1, 5, 'active', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'),
  ('var_62000000-0000-4000-8000-000000000001', 'shp_62000000-0000-4000-8000-000000000002', 'prd_62000000-0000-4000-8000-000000000001', 'CANVAS-EDITORIAL', 'Commercial', '{}', 179000, 229000, 'VND', 1, 4, 'active', 1, '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z');
