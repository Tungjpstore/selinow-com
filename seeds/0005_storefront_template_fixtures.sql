PRAGMA foreign_keys = ON;

-- Storefront template fixtures (CD5 / VR1): one live shop per template so the
-- local visual-regression gate can capture every template's home, detail and
-- money screens. Swift stays covered by the signal demo shop. Deterministic
-- by design: no discounts with near deadlines (countdowns are excluded from
-- baselines) and no uploaded media (initial-mark visuals are stable).

-- The store plan must carry the premium-template flag for the six premium
-- fixtures to render as themselves instead of the swift fallback.
UPDATE plans
SET feature_flags_json = json_set(feature_flags_json, '$.premiumStorefrontTemplates', json('true')),
    updated_at = CURRENT_TIMESTAMP
WHERE code = 'store';

INSERT OR IGNORE INTO shops (
  id, public_id, slug, name, status, default_locale, currency, timezone,
  canonical_domain_id, readiness_version, created_at, updated_at
) VALUES
  ('shp_65000000-0000-4000-8000-000000000001', 'shop_65000000-0000-4000-8000-000000000001', 'pulse', 'Pulse Key Store', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000002', 'shop_65000000-0000-4000-8000-000000000002', 'desk', 'Desk License Hub', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000003', 'shop_65000000-0000-4000-8000-000000000003', 'aurora', 'Aurora Studio', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000004', 'shop_65000000-0000-4000-8000-000000000004', 'metro', 'Metro Tech Mart', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000005', 'shop_65000000-0000-4000-8000-000000000005', 'bustle', 'Bustle Market', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000006', 'shop_65000000-0000-4000-8000-000000000006', 'serenity', 'Serenity Spa', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000007', 'shop_65000000-0000-4000-8000-000000000007', 'craft', 'Craft Barbershop', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000008', 'shop_65000000-0000-4000-8000-000000000008', 'clinic', 'Clinic Care', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', NULL, 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z');

INSERT OR IGNORE INTO shop_settings (
  shop_id, branding_json, storefront_json, published_branding_json, published_storefront_json,
  published_version, published_at, order_expiry_minutes, low_stock_threshold, version, updated_at
) VALUES
  ('shp_65000000-0000-4000-8000-000000000001', '{"primaryColor":"#3B82F6","accentColor":"#5B5CEB"}', '{"templateId":"pulse","headline":"Key game nhập trong vài giây.","description":"Cửa hàng key bản quyền vận hành tự động: chọn game, thanh toán, nhận key ngay trên trang đơn hàng.","footerText":"Pulse Key Store vận hành trên Selinow.","supportText":"Hỗ trợ key lỗi trong 24 giờ","showExactStock":false}', '{"primaryColor":"#3B82F6","accentColor":"#5B5CEB"}', '{"templateId":"pulse","headline":"Key game nhập trong vài giây.","description":"Cửa hàng key bản quyền vận hành tự động: chọn game, thanh toán, nhận key ngay trên trang đơn hàng.","footerText":"Pulse Key Store vận hành trên Selinow.","supportText":"Hỗ trợ key lỗi trong 24 giờ","showExactStock":false}', 1, '2026-08-22T00:00:00.000Z', 30, 3, 1, '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000002', '{"primaryColor":"#5B5CEB","accentColor":"#7C3AED"}', '{"templateId":"desk","headline":"Bản quyền phần mềm, rõ ràng như một hóa đơn.","description":"Gói license cho đội nhỏ: bảng giá cố định, key gửi qua email, kích hoạt theo hướng dẫn nhà cung cấp.","footerText":"Desk License Hub vận hành trên Selinow.","supportText":"Hỗ trợ qua email trong giờ hành chính","showExactStock":false}', '{"primaryColor":"#5B5CEB","accentColor":"#7C3AED"}', '{"templateId":"desk","headline":"Bản quyền phần mềm, rõ ràng như một hóa đơn.","description":"Gói license cho đội nhỏ: bảng giá cố định, key gửi qua email, kích hoạt theo hướng dẫn nhà cung cấp.","footerText":"Desk License Hub vận hành trên Selinow.","supportText":"Hỗ trợ qua email trong giờ hành chính","showExactStock":false}', 1, '2026-08-22T00:00:00.000Z', 30, 5, 1, '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000003', '{"primaryColor":"#141414","accentColor":"#5B5CEB"}', '{"templateId":"aurora","headline":"Bộ sưu tập thu đông đã mở.","description":"Những mảnh thiết kế chọn lọc cho tủ đồ bền vững. Đặt hàng hôm nay, giao trong tuần.","footerText":"Aurora Studio vận hành trên Selinow.","supportText":"Tư vấn size qua hộp thư","showExactStock":false}', '{"primaryColor":"#141414","accentColor":"#5B5CEB"}', '{"templateId":"aurora","headline":"Bộ sưu tập thu đông đã mở.","description":"Những mảnh thiết kế chọn lọc cho tủ đồ bền vững. Đặt hàng hôm nay, giao trong tuần.","footerText":"Aurora Studio vận hành trên Selinow.","supportText":"Tư vấn size qua hộp thư","showExactStock":false}', 1, '2026-08-22T00:00:00.000Z', 30, 5, 1, '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000004', '{"primaryColor":"#0B1020","accentColor":"#047857"}', '{"templateId":"metro","headline":"Thiết bị chính hãng, thông số rõ ràng.","description":"Mỗi sản phẩm đi kèm bảng thông số và chính sách bảo hành đính kèm. Giao có theo dõi.","footerText":"Metro Tech Mart vận hành trên Selinow.","supportText":"Hỗ trợ trước và sau mua","showExactStock":true}', '{"primaryColor":"#0B1020","accentColor":"#047857"}', '{"templateId":"metro","headline":"Thiết bị chính hãng, thông số rõ ràng.","description":"Mỗi sản phẩm đi kèm bảng thông số và chính sách bảo hành đính kèm. Giao có theo dõi.","footerText":"Metro Tech Mart vận hành trên Selinow.","supportText":"Hỗ trợ trước và sau mua","showExactStock":true}', 1, '2026-08-22T00:00:00.000Z', 30, 5, 1, '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000005', '{"primaryColor":"#B91C1C","accentColor":"#5B5CEB"}', '{"templateId":"bustle","headline":"Deal hôm nay, chốt liền tay.","description":"Giá tốt mỗi ngày cho đồ dùng gia đình. Nhập mã giảm ngay tại trang thanh toán.","announcement":"Nhập mã BUSTLE10 khi thanh toán","footerText":"Bustle Market vận hành trên Selinow.","supportText":"Chat hỗ trợ nhanh","showExactStock":false}', '{"primaryColor":"#B91C1C","accentColor":"#5B5CEB"}', '{"templateId":"bustle","headline":"Deal hôm nay, chốt liền tay.","description":"Giá tốt mỗi ngày cho đồ dùng gia đình. Nhập mã giảm ngay tại trang thanh toán.","announcement":"Nhập mã BUSTLE10 khi thanh toán","footerText":"Bustle Market vận hành trên Selinow.","supportText":"Chat hỗ trợ nhanh","showExactStock":false}', 1, '2026-08-22T00:00:00.000Z', 30, 5, 1, '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000006', '{"primaryColor":"#5B5CEB","accentColor":"#7C3AED"}', '{"templateId":"serenity","headline":"Chậm lại một giờ dành cho bạn.","description":"Liệu trình chọn lọc, đặt lịch theo giờ trống thật. Xác nhận qua email ngay sau thanh toán.","footerText":"Serenity Spa vận hành trên Selinow.","supportText":"Nhắn tin để được tư vấn liệu trình","showExactStock":false}', '{"primaryColor":"#5B5CEB","accentColor":"#7C3AED"}', '{"templateId":"serenity","headline":"Chậm lại một giờ dành cho bạn.","description":"Liệu trình chọn lọc, đặt lịch theo giờ trống thật. Xác nhận qua email ngay sau thanh toán.","footerText":"Serenity Spa vận hành trên Selinow.","supportText":"Nhắn tin để được tư vấn liệu trình","showExactStock":false}', 1, '2026-08-22T00:00:00.000Z', 30, 5, 1, '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000007', '{"primaryColor":"#7C3AED","accentColor":"#5B5CEB"}', '{"templateId":"craft","headline":"Ghế của bạn, đúng giờ hẹn.","description":"Cắt tạo mẫu theo phong cách riêng. Chọn dịch vụ, chọn giờ, đến là cắt.","footerText":"Craft Barbershop vận hành trên Selinow.","supportText":"Inbox để đổi lịch","showExactStock":false}', '{"primaryColor":"#7C3AED","accentColor":"#5B5CEB"}', '{"templateId":"craft","headline":"Ghế của bạn, đúng giờ hẹn.","description":"Cắt tạo mẫu theo phong cách riêng. Chọn dịch vụ, chọn giờ, đến là cắt.","footerText":"Craft Barbershop vận hành trên Selinow.","supportText":"Inbox để đổi lịch","showExactStock":false}', 1, '2026-08-22T00:00:00.000Z', 30, 5, 1, '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000008', '{"primaryColor":"#5B5CEB","accentColor":"#1D4ED8"}', '{"templateId":"clinic","headline":"Đặt lịch khám, gọn một trang.","description":"Dịch vụ khám và xét nghiệm với bảng giá niêm yết. Mang theo mã hẹn khi đến.","footerText":"Clinic Care vận hành trên Selinow.","supportText":"Gọi tổng đài trong giờ khám","showExactStock":false}', '{"primaryColor":"#5B5CEB","accentColor":"#1D4ED8"}', '{"templateId":"clinic","headline":"Đặt lịch khám, gọn một trang.","description":"Dịch vụ khám và xét nghiệm với bảng giá niêm yết. Mang theo mã hẹn khi đến.","footerText":"Clinic Care vận hành trên Selinow.","supportText":"Gọi tổng đài trong giờ khám","showExactStock":false}', 1, '2026-08-22T00:00:00.000Z', 30, 5, 1, '2026-08-22T00:00:00.000Z');

INSERT OR IGNORE INTO shop_subscriptions (
  id, shop_id, plan_id, state, current_period_start, current_period_end, created_at, updated_at
) SELECT 'sub_65000000-0000-4000-8000-00000000000' || substr(id, -1), id, (SELECT plans.id FROM plans WHERE plans.code = 'store'), 'active', '2026-08-22T00:00:00.000Z', '2027-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z' FROM shops WHERE id LIKE 'shp_65000000-%';

INSERT OR IGNORE INTO shop_domains (
  id, shop_id, hostname_normalized, type, status, is_primary,
  validation_metadata_json, activated_at, created_at, updated_at
) VALUES
  ('dom_65000000-0000-4000-8000-000000000001', 'shp_65000000-0000-4000-8000-000000000001', 'pulse.localhost', 'platform_subdomain', 'active', 1, '{}', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('dom_65000000-0000-4000-8000-000000000002', 'shp_65000000-0000-4000-8000-000000000002', 'desk.localhost', 'platform_subdomain', 'active', 1, '{}', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('dom_65000000-0000-4000-8000-000000000003', 'shp_65000000-0000-4000-8000-000000000003', 'aurora.localhost', 'platform_subdomain', 'active', 1, '{}', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('dom_65000000-0000-4000-8000-000000000004', 'shp_65000000-0000-4000-8000-000000000004', 'metro.localhost', 'platform_subdomain', 'active', 1, '{}', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('dom_65000000-0000-4000-8000-000000000005', 'shp_65000000-0000-4000-8000-000000000005', 'bustle.localhost', 'platform_subdomain', 'active', 1, '{}', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('dom_65000000-0000-4000-8000-000000000006', 'shp_65000000-0000-4000-8000-000000000006', 'serenity.localhost', 'platform_subdomain', 'active', 1, '{}', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('dom_65000000-0000-4000-8000-000000000007', 'shp_65000000-0000-4000-8000-000000000007', 'craft.localhost', 'platform_subdomain', 'active', 1, '{}', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('dom_65000000-0000-4000-8000-000000000008', 'shp_65000000-0000-4000-8000-000000000008', 'clinic.localhost', 'platform_subdomain', 'active', 1, '{}', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z');

INSERT OR IGNORE INTO product_categories (
  id, shop_id, slug, name, description, sort_order, status, created_at, updated_at
) VALUES
  ('cat_65000000-0000-4000-8000-000000000001', 'shp_65000000-0000-4000-8000-000000000001', 'pc-games', 'Game PC', 'Key bản quyền game PC.', 0, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('cat_65000000-0000-4000-8000-000000000002', 'shp_65000000-0000-4000-8000-000000000002', 'productivity', 'Productivity', 'Bản quyền văn phòng và sản xuất.', 0, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('cat_65000000-0000-4000-8000-000000000003', 'shp_65000000-0000-4000-8000-000000000003', 'outerwear', 'Outerwear', 'Áo khoác và lớp ngoài.', 0, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('cat_65000000-0000-4000-8000-000000000004', 'shp_65000000-0000-4000-8000-000000000004', 'accessories', 'Phụ kiện', 'Phụ kiện công nghệ chính hãng.', 0, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('cat_65000000-0000-4000-8000-000000000005', 'shp_65000000-0000-4000-8000-000000000005', 'home', 'Gia đình', 'Đồ dùng gia đình.', 0, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('cat_65000000-0000-4000-8000-000000000006', 'shp_65000000-0000-4000-8000-000000000006', 'facial', 'Liệu trình', 'Liệu trình chăm sóc da.', 0, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('cat_65000000-0000-4000-8000-000000000007', 'shp_65000000-0000-4000-8000-000000000007', 'hair', 'Tóc & Beard', 'Dịch vụ tóc và râu.', 0, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('cat_65000000-0000-4000-8000-000000000008', 'shp_65000000-0000-4000-8000-000000000008', 'checkup', 'Khám tổng quát', 'Gói khám và xét nghiệm.', 0, 'active', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z');

INSERT OR IGNORE INTO products (
  id, shop_id, category_id, slug, title, description, status,
  fulfillment_type, delivery_mode, attributes_json, version, created_at, updated_at
) VALUES
  ('prd_65000000-0000-4000-8000-000000000001', 'shp_65000000-0000-4000-8000-000000000001', 'cat_65000000-0000-4000-8000-000000000001', 'neon-racer-key', 'Neon Racer Deluxe', 'Key bản quyền Neon Racer Deluxe, kích hoạt Steam, nhận ngay sau thanh toán.', 'active', 'manual', 'digital', NULL, 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('prd_65000000-0000-4000-8000-000000000002', 'shp_65000000-0000-4000-8000-000000000002', 'cat_65000000-0000-4000-8000-000000000002', 'notes-suite-license', 'Notes Suite License', 'Bản quyền Notes Suite cho tối đa 5 thiết bị, key gửi qua email sau thanh toán.', 'active', 'manual', 'digital', NULL, 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('prd_65000000-0000-4000-8000-000000000003', 'shp_65000000-0000-4000-8000-000000000003', 'cat_65000000-0000-4000-8000-000000000003', 'linen-overshirt', 'Linen Overshirt', 'Áo khoác linen màu đất, form regular, may chi tiết độc lập.', 'active', 'manual', 'shipping', NULL, 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('prd_65000000-0000-4000-8000-000000000004', 'shp_65000000-0000-4000-8000-000000000004', 'cat_65000000-0000-4000-8000-000000000004', 'usbc-hub-7in1', 'USB-C Hub 7 in 1', 'Hub 7 cổng HDMI 4K, SD, LAN; tương thích full danh sách laptop USB-C.', 'active', 'manual', 'shipping', '[{"label":"Bảo hành","value":"12 tháng chính hãng"},{"label":"Kiểu kết nối","value":"USB-C 10Gbps"},{"label":"Cổng","value":"HDMI 4K60, LAN 1Gbps, 2x USB-A, SD"}]', 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('prd_65000000-0000-4000-8000-000000000005', 'shp_65000000-0000-4000-8000-000000000005', 'cat_65000000-0000-4000-8000-000000000005', 'kitchen-organizer', 'Kitchen Organizer Set', 'Bộ 6 khay organizer bếp, chất liệu an toàn, dễ rửa.', 'active', 'manual', 'shipping', NULL, 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('prd_65000000-0000-4000-8000-000000000006', 'shp_65000000-0000-4000-8000-000000000006', 'cat_65000000-0000-4000-8000-000000000006', 'glow-facial-60', 'Glow Facial', 'Liệu trình làm sạch và cấp ẩm sâu, kết thúc bằng mặt nạ dưỡng.', 'active', 'manual', 'digital', NULL, 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('prd_65000000-0000-4000-8000-000000000007', 'shp_65000000-0000-4000-8000-000000000007', 'cat_65000000-0000-4000-8000-000000000007', 'signature-cut', 'Signature Cut', 'Cắt tạo mẫu theo tư vấn, kèm gội và dưỡng cơ bản.', 'active', 'manual', 'digital', NULL, 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('prd_65000000-0000-4000-8000-000000000008', 'shp_65000000-0000-4000-8000-000000000008', 'cat_65000000-0000-4000-8000-000000000008', 'general-checkup', 'General Checkup', 'Khám tổng quát và xét nghiệm máu cơ bản, kết quả trong 24 giờ.', 'active', 'manual', 'digital', '[{"label":"Chuẩn bị","value":"Nhịn ăn 8 giờ trước lấy mẫu"},{"label":"Kết quả","value":"Trong 24 giờ qua email"},{"label":"Bao gồm","value":"Khám lâm sàng, công thức máu, đường huyết"}]', 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z');

INSERT OR IGNORE INTO product_variants (
  id, shop_id, product_id, sku, title, options_json, price_minor,
  compare_at_minor, currency, min_per_order, max_per_order, status,
  version, duration_minutes, created_at, updated_at
) VALUES
  ('var_65000000-0000-4000-8000-000000000001', 'shp_65000000-0000-4000-8000-000000000001', 'prd_65000000-0000-4000-8000-000000000001', 'NEON-RACER-DLX', 'Global', '{}', 349000, 429000, 'VND', 1, 2, 'active', 1, NULL, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('var_65000000-0000-4000-8000-000000000002', 'shp_65000000-0000-4000-8000-000000000002', 'prd_65000000-0000-4000-8000-000000000002', 'NOTES-SUITE-5D', '5 thiết bị', '{}', 890000, NULL, 'VND', 1, 3, 'active', 1, NULL, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('var_65000000-0000-4000-8000-000000000003', 'shp_65000000-0000-4000-8000-000000000003', 'prd_65000000-0000-4000-8000-000000000003', 'LINEN-OVER-M', 'M', '{"color":"Đất nung"}', 1290000, NULL, 'VND', 1, 2, 'active', 1, NULL, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('var_65000000-0000-4000-8000-000000000004', 'shp_65000000-0000-4000-8000-000000000004', 'prd_65000000-0000-4000-8000-000000000004', 'USBC-HUB-7IN1', 'Chính hãng', '{}', 749000, 899000, 'VND', 1, 5, 'active', 1, NULL, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('var_65000000-0000-4000-8000-000000000005', 'shp_65000000-0000-4000-8000-000000000005', 'prd_65000000-0000-4000-8000-000000000005', 'KITCHEN-ORG-6', 'Bộ 6 khay', '{}', 259000, 379000, 'VND', 1, 4, 'active', 1, NULL, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('var_65000000-0000-4000-8000-000000000006', 'shp_65000000-0000-4000-8000-000000000006', 'prd_65000000-0000-4000-8000-000000000006', 'GLOW-FACIAL-60', '60 phút', '{}', 450000, NULL, 'VND', 1, 1, 'active', 1, 60, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('var_65000000-0000-4000-8000-000000000007', 'shp_65000000-0000-4000-8000-000000000007', 'prd_65000000-0000-4000-8000-000000000007', 'SIGNATURE-CUT-45', '45 phút', '{}', 250000, NULL, 'VND', 1, 1, 'active', 1, 45, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('var_65000000-0000-4000-8000-000000000008', 'shp_65000000-0000-4000-8000-000000000008', 'prd_65000000-0000-4000-8000-000000000008', 'GENERAL-CHECKUP', 'Khám + xét nghiệm', '{}', 750000, NULL, 'VND', 1, 1, 'active', 1, 90, '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z');

-- Physical fixtures need on-hand stock or the catalog reports sold-out.
INSERT OR IGNORE INTO variant_stock_levels (id, shop_id, variant_id, on_hand, reserved, updated_at) VALUES
  ('stk_65000000-0000-4000-8000-000000000003', 'shp_65000000-0000-4000-8000-000000000003', 'var_65000000-0000-4000-8000-000000000003', 18, 0, '2026-08-22T00:00:00.000Z'),
  ('stk_65000000-0000-4000-8000-000000000004', 'shp_65000000-0000-4000-8000-000000000004', 'var_65000000-0000-4000-8000-000000000004', 42, 0, '2026-08-22T00:00:00.000Z'),
  ('stk_65000000-0000-4000-8000-000000000005', 'shp_65000000-0000-4000-8000-000000000005', 'var_65000000-0000-4000-8000-000000000005', 120, 0, '2026-08-22T00:00:00.000Z');

INSERT OR IGNORE INTO catalog_channel_visibility (shop_id, product_id, channel_code, status, created_at, updated_at) VALUES
  ('shp_65000000-0000-4000-8000-000000000001', 'prd_65000000-0000-4000-8000-000000000001', 'website', 'visible', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000002', 'prd_65000000-0000-4000-8000-000000000002', 'website', 'visible', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000003', 'prd_65000000-0000-4000-8000-000000000003', 'website', 'visible', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000004', 'prd_65000000-0000-4000-8000-000000000004', 'website', 'visible', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000005', 'prd_65000000-0000-4000-8000-000000000005', 'website', 'visible', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000006', 'prd_65000000-0000-4000-8000-000000000006', 'website', 'visible', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000007', 'prd_65000000-0000-4000-8000-000000000007', 'website', 'visible', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'),
  ('shp_65000000-0000-4000-8000-000000000008', 'prd_65000000-0000-4000-8000-000000000008', 'website', 'visible', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z');
