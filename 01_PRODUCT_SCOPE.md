# Product Scope

## 1. Product thesis

`selinow.com` là nền tảng cho thuê hạ tầng bán sản phẩm số. Người bán nhận một Telegram bot, một website, kho key, checkout PayOS và giao hàng tự động mà không cần tự deploy source hoặc vận hành server.

## Current capability overlay (2026-08-03)

The Telegram/website/PayOS scope remains the only production-admitted commerce path. The current source adds separate, truthful expansion surfaces for Telegram Mini App, Zalo Mini App, Zalo OA, WhatsApp Cloud and Discord Bot plus Starter/Pro platform billing through Dodo and privacy-safe activation milestones. These lanes expose seller intent, provider stage, capabilities and safe projections; they do not claim live provider credentials, outbound delivery or fulfillment activation. Per-product channel visibility is fail-closed and tenant-scoped. The source schema ends at migration `0077`, while staging remains on `0028` and production remains on `0052` pending external admission.

Giá trị cốt lõi:

- Setup nhanh, gần như không cần kỹ thuật.
- Một kho hàng và một hệ thống đơn cho cả Telegram lẫn website.
- Tiền đi trực tiếp vào PayOS/tài khoản của người bán.
- Custom branding và domain riêng.
- Tự động giao key, retry, đối soát và cảnh báo.

## 2. Phạm vi MVP

### Có trong MVP

- Marketing site và pricing.
- Seller authentication.
- Multi-tenant shop management.
- Trial/subscription state và feature limits.
- Product, variant, category và media.
- Import key bằng paste/CSV.
- Inventory available/reserved/sold/revoked.
- Website storefront theo subdomain.
- Telegram bot riêng theo shop.
- Cart/checkout cho website và Telegram.
- PayOS credentials riêng theo shop.
- PayOS webhook, polling reconciliation và payment exception.
- Fulfillment key retry-safe.
- Order history seller; customer order access bằng token/Telegram identity.
- Custom domain qua Cloudflare for SaaS.
- Setup wizard, readiness checks, audit và notifications cơ bản.
- Platform admin để support, suspend và quan sát integration health.

### Không có trong MVP

- Marketplace tập trung nơi nền tảng thu tiền hộ nhiều seller.
- Payout hoặc chia tiền.
- Affiliate/referral payout.
- Nhiều payment provider song song.
- Mobile app native.
- Microservices.
- Custom code/theme marketplace.
- Wildcard custom hostname cho tenant.
- Tự động tạo Telegram bot thay người dùng.
- Tự động tạo tài khoản PayOS thay người dùng.

## 3. Vai trò

### Platform owner/admin

- Quản lý plan, shop, subscription và abuse.
- Xem health, usage, payment exception và integration failure.
- Suspend/reactivate shop.
- Không được mặc định xem plaintext key hoặc tenant credential.
- Mọi hành động support nhạy cảm phải có audit.

### Seller owner

- Tạo và sở hữu shop.
- Kết nối bot, PayOS, domain.
- Quản lý thành viên, catalog, inventory, orders và branding.
- Export dữ liệu.
- Rotate/revoke integrations.

### Seller staff

Các role tối thiểu:

- `owner`: toàn quyền và billing.
- `manager`: catalog, inventory, order và integration, không chuyển ownership.
- `support`: xem order/customer và xử lý exception, không xem/nhập credential.
- `viewer`: read-only analytics/order metadata.

### Buyer

- Mua trên website hoặc Telegram.
- Không bắt buộc tạo account cho checkout MVP.
- Nhận order access token qua browser/email hoặc dùng Telegram identity.
- Chỉ xem key thuộc order đã thanh toán của mình.

## 4. Kênh bán hàng

### Website

- URL mặc định: `https://{slug}.selinow.com`.
- URL tùy chọn: custom domain của seller.
- Catalog, product detail, cart, checkout, order status và reveal key.
- SEO cơ bản cho catalog public; checkout/order luôn `noindex` và `no-store`.

### Telegram

- Bot riêng của seller.
- `/start`, `/shop`, `/products`, `/cart`, `/discount`, `/orders`, `/keys`, `/help`.
- Inline keyboard, private-chat checkout, PayOS QR/link và paid notification.
- Group chat không hiển thị dữ liệu cá nhân, đơn hoặc key.

Hai kênh bắt buộc dùng chung:

- Product/variant.
- Stock availability.
- Discount policy.
- Order/payment state.
- Fulfillment allocation.
- Audit trail.

## 5. Gói dịch vụ đề xuất

Các giá trị số phải cấu hình trong database, không hard-code vào UI.

| Capability | Bot | Store | Business |
| --- | --- | --- | --- |
| Telegram bot | Có | Có | Có |
| Website subdomain | Không hoặc landing đơn giản | Có | Có |
| Custom domain | Không | Add-on | Có |
| Sản phẩm/đơn hàng | Giới hạn plan | Giới hạn cao hơn | Cao nhất |
| Staff seats | 1 | 3 | Nhiều hơn |
| Branding | Cơ bản | Tùy chỉnh | Tùy chỉnh đầy đủ |
| Analytics/export | Cơ bản | Có | Có |
| Support | Standard | Standard | Priority |

Subscription state:

```text
trialing -> active -> past_due -> grace_period -> suspended -> canceled
```

Quy tắc:

- `trialing/active`: nhận đơn bình thường.
- `past_due`: cảnh báo, vẫn nhận đơn trong thời gian ngắn cấu hình được.
- `grace_period`: có thể chặn publish mới; vẫn cho export và xử lý đơn cũ.
- `suspended/canceled`: chặn checkout mới, giữ storefront notice an toàn, không xóa dữ liệu tự động.

## 6. Seller dashboard

Route đề xuất dưới `app.selinow.com`:

- `/login`
- `/onboarding`
- `/app`
- `/app/products`
- `/app/products/new`
- `/app/inventory`
- `/app/orders`
- `/app/customers`
- `/app/integrations/telegram`
- `/app/integrations/payos`
- `/app/domains`
- `/app/team`
- `/app/settings/branding`
- `/app/settings/store`
- `/app/billing`
- `/app/audit`

Dashboard overview phải trả lời ngay:

- Shop đã live chưa?
- Kênh nào đang active?
- PayOS/webhook có healthy không?
- Bot có nhận update không?
- Bao nhiêu sản phẩm sắp hết/hết key?
- Có payment exception hoặc delivery failure nào cần xử lý?
- Subscription còn hiệu lực không?

## 7. Onboarding UX

Wizard không dài dòng và có thể resume:

1. Tạo shop: tên, slug, locale, currency.
2. Chọn kênh: Telegram, website hoặc cả hai.
3. Tạo sản phẩm đầu tiên hoặc seed sản phẩm mẫu.
4. Import ít nhất một key test hoặc chọn manual fulfillment cho product test.
5. Kết nối Telegram nếu chọn bot.
6. Kết nối PayOS.
7. Branding và subdomain preview.
8. Custom domain tùy chọn, có thể bỏ qua.
9. Automated readiness test.
10. Publish.

Mỗi bước có trạng thái `not_started`, `in_progress`, `ready`, `warning`, `blocked`. Không bắt người dùng nhập lại dữ liệu đã hợp lệ.

## 8. Storefront UX

- Mobile-first vì traffic từ Telegram thường mở bằng điện thoại.
- Tải nhanh, không phụ thuộc JavaScript cho catalog cơ bản.
- Brand token lấy từ shop settings nhưng phải có contrast guard.
- Hiển thị stock theo mức `available`, `low_stock`, `out_of_stock`, không tiết lộ số lượng nếu seller không bật.
- Checkout cho biết chính xác số tiền, nội dung chuyển khoản và thời hạn.
- Không báo paid chỉ vì người dùng quay lại return URL.
- Reveal key cần order token hợp lệ hoặc identity đã xác minh.
- Key chỉ hiện sau paid + fulfillment; response `private, no-store`.

## 9. Product policy

Nền tảng chỉ dành cho sản phẩm số hợp pháp. Cần có:

- Acceptable Use Policy.
- Terms of Service.
- Privacy Policy.
- Quy trình report abuse/takedown.
- Seller attestation khi publish sản phẩm.
- Khả năng suspend shop hoặc product.

Không quảng bá nền tảng như đơn vị giữ tiền, trung gian thanh toán hoặc bảo chứng tính hợp pháp của key nếu chưa có cơ sở pháp lý tương ứng.

## 10. Success metrics

Theo dõi ở mức platform, không đưa PII/key vào analytics:

- Thời gian từ signup tới shop ready.
- Tỷ lệ hoàn tất kết nối Telegram.
- Tỷ lệ hoàn tất kết nối PayOS.
- Tỷ lệ custom domain active.
- Checkout success rate.
- Payment-to-fulfillment latency.
- Webhook retry/failure rate.
- Inventory stockout rate.
- Tỷ lệ onboarding cần support thủ công.

Mục tiêu automation: phần lớn seller hoàn thành từ signup tới test order mà không cần developer hoặc support can thiệp.
