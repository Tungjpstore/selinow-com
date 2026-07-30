# Selinow — Frontend Redesign Brief

> Tài liệu bàn giao cho frontend designer/developer. Nội dung được lập trực tiếp từ source, route, product contract và design-system contract trong repository `Selinow.com`.

## 1. Product boundary

Selinow là SaaS multi-tenant cho người bán sản phẩm số. Mỗi seller có thể tạo shop, nhận website theo subdomain, kết nối Telegram bot, PayOS, nhập kho license key và tự động xử lý đơn/giao hàng.

Selinow **không phải marketplace tập trung**. Không thiết kế trang tổng hợp sản phẩm hoặc seller của toàn nền tảng. Mỗi storefront thuộc một shop riêng và được xác định bằng hostname.

### Ba frontend surface hiện có

| Surface | Host/context | Người dùng | Layout hiện tại |
| --- | --- | --- | --- |
| Marketing platform | `selinow.com` | Khách hàng tiềm năng | `PlatformLayout.astro` |
| Seller workspace | `app.selinow.com` | Owner/manager/support/viewer | `AppLayout.astro` |
| Tenant storefront | `{slug}.selinow.com` hoặc custom domain | Buyer | `StorefrontLayout.astro` |
| Platform operations | Admin route được bảo vệ | Platform owner/risk/support | Trang admin riêng |

Frontend dev phải giữ ranh giới giữa platform, seller workspace và storefront. Không dùng chung navigation, session assumption hoặc tenant context một cách tùy tiện.

## 2. Stack và giới hạn triển khai

- Astro 7, TypeScript strict, Cloudflare adapter.
- SSR/static-first; catalog cơ bản không được phụ thuộc JavaScript để render nội dung chính.
- JavaScript phía client hiện dùng TypeScript/DOM script, không có React/Vue runtime.
- D1 là source of truth; frontend không giữ business state quan trọng chỉ trong local state.
- Storefront lấy tenant từ hostname; buyer không được truyền `shop_id` để quyết định authority.
- Dashboard mutation phải giữ session, CSRF, role, plan và tenant guard hiện có.
- Checkout, order, key, credential và admin page phải `noindex`, `no-store` theo contract hiện tại.
- Không thêm UI hiển thị lại Telegram token, PayOS credential hoặc toàn bộ plaintext inventory key.

Nếu đề xuất thêm framework UI/client runtime, frontend dev phải chứng minh nhu cầu và tác động bundle/hydration trước khi triển khai. Mặc định tiếp tục Astro component + TypeScript DOM module.

## 3. Mục tiêu redesign

1. Làm rõ Selinow là công cụ vận hành commerce đa kênh, không chỉ là landing page Telegram bot.
2. Giúp seller nhìn thấy ngay shop có live không, bước nào bị chặn và hành động tiếp theo là gì.
3. Rút ngắn onboarding từ tạo shop đến preview/readiness/publish mà không làm mất khả năng resume.
4. Chuẩn hóa dashboard để mở rộng các module catalog, inventory, orders, integrations, customers, billing và audit.
5. Tạo storefront mobile-first nhanh, dễ tùy biến theo tenant nhưng không phá accessibility.
6. Thống nhất trạng thái loading, empty, warning, blocked, retry, success và destructive confirmation.

## 4. Cấu trúc source cần bám theo

```text
src/
  layouts/
    PlatformLayout.astro       # Marketing/platform shell
    AppLayout.astro            # Seller workspace shell
    StorefrontLayout.astro     # Tenant storefront shell
  components/
    dashboard/
      OnboardingWizard.astro
      DomainManager.astro
    storefront/
      ProductCard.astro
      CatalogData.astro
  pages/
    index.astro                # Marketing hoặc tenant storefront theo hostname
    pricing.astro
    login.astro
    onboarding.astro
    app/index.astro
    app/domains.astro
    products/[slug].astro
    cart.astro
    checkout.astro
    orders/[orderPublicId].astro
    admin/index.astro
    admin/operations.astro
  scripts/
    dashboard/
    storefront/
  styles/
    selinow-tokens.css
    selinow-a11y.css
    platform.css
    app-shell.css
    storefront.css
```

### Quy tắc refactor

- Giữ ba layout theo đúng surface; có thể tách nhỏ component nhưng không trộn context.
- Chuyển CSS lặp lại trong page sang shared primitives/tokens theo từng surface.
- Không thay đổi API URL, payload hoặc business state chỉ để thuận tiện cho visual.
- Giữ progressive enhancement: HTML phải có cấu trúc, heading, form label và nội dung cơ bản trước khi script chạy.
- Mọi component tương tác phải có trạng thái server/client rõ ràng và không tạo mutation lặp khi retry.

## 5. Định hướng visual

### Concept đề xuất: “Commerce control room”

Selinow cần tạo cảm giác hệ thống vận hành tin cậy, chính xác và có nhịp. Visual nên giống một control room thân thiện cho người bán: trạng thái rõ, bước tiếp theo rõ, ít yếu tố trang trí không phục vụ quyết định.

### Giữ lại từ hệ thống hiện tại

- Brand indigo/blue/teal và bộ logo trong `public/brand`.
- Semantic tokens: canvas, surface, text, border, action, focus, success, warning, danger.
- Heading lớn, typography có tính biên tập trên marketing.
- Seller workspace nền sáng, sidebar tối.
- Admin operations có thể giữ dark surface để phân biệt vùng rủi ro cao.

### Cần cải thiện

- Không dùng gradient làm giải pháp mặc định cho mọi CTA/card/visual.
- Giảm số lượng card bo tròn; ưu tiên row, rail, timeline và status ledger cho dữ liệu vận hành.
- Tách rõ action color và decorative brand color.
- Dùng typography có hỗ trợ tiếng Việt đầy đủ; không phụ thuộc `Inter` làm toàn bộ cá tính thương hiệu.
- Hạn chế blur/backdrop và shadow lớn trong dashboard để giữ cảm giác chính xác.
- Giữ tenant storefront có cá tính riêng nhưng không cho theme override success, warning, danger, payment hoặc focus color.

### Token contract

File nguồn: `src/styles/selinow-tokens.css`.

Frontend dev được điều chỉnh raw palette, font, radius và shadow nhưng phải giữ semantic token names hoặc cung cấp migration rõ ràng. Tenant theme chỉ được chiếu vào các token merchant như brand/accent; contrast phải được clamp ở server theo logic hiện tại.

## 6. Information architecture mục tiêu

### Marketing platform

- `/` — positioning, workflow, feature, trust/payment ownership, use cases, pricing preview, FAQ, CTA.
- `/pricing` — plan comparison lấy từ database; không hard-code limits.
- `/login` — passwordless magic-link flow.
- Trang pháp lý/hỗ trợ có thể bổ sung khi product cung cấp nội dung.

### Seller workspace

Navigation mục tiêu theo product contract:

1. Tổng quan.
2. Thiết lập/readiness.
3. Sản phẩm.
4. Kho mã.
5. Đơn hàng.
6. Khách hàng.
7. Kênh bán/Integrations.
8. Tên miền.
9. Thành viên.
10. Cài đặt cửa hàng/branding.
11. Gói dịch vụ.
12. Audit/export/data controls.

Không đưa toàn bộ 12 mục lên một navigation phẳng. Nhóm đề xuất: `Vận hành`, `Kênh bán`, `Cấu hình`, `Quản trị` và dùng progressive disclosure.

### Tenant storefront

- `/` — shop identity, headline, catalog.
- `/products/:slug` — product + variants + stock state.
- `/cart` — cart review.
- `/checkout` — quote/contact/Turnstile/confirm.
- `/orders/:orderPublicId` — payment, fulfillment và reveal state.

Không bổ sung tài khoản buyer trong MVP. Order access dựa trên opaque access token hoặc verified identity theo backend contract.

## 7. Màn hình hiện có và yêu cầu redesign

### 7.1 Marketing home

Nguồn: `src/pages/index.astro`, `src/styles/platform.css`.

- Giữ message chính: storefront/Telegram, PayOS riêng của seller, fulfillment tự động.
- Không mô tả Selinow là đơn vị giữ tiền hoặc bảo chứng thanh toán.
- Hero phải dẫn đến `Bắt đầu` và `Xem quy trình`, không tạo quá nhiều CTA cạnh tranh.
- Feature section cần thể hiện một commerce core dùng chung cho website và Telegram.
- Pricing preview lấy dữ liệu runtime từ `getMarketingPlans`.
- Mobile navigation cần phương án rõ; hiện tại nav ngang cần được thiết kế lại cho viewport hẹp.

### 7.2 Login

Nguồn: `src/pages/login.astro`.

- Flow chỉ gồm email, display name tùy chọn và magic link.
- Thiết kế đủ các state: idle, submitting, sent, local debug link, rate-limited, invalid email, provider unavailable.
- Không thêm password field.
- Sau login chuyển về `/app`.

### 7.3 Seller overview

Nguồn: `src/pages/app/index.astro`, `src/layouts/AppLayout.astro`.

Overview phải trả lời ngay:

- Shop nào đang live?
- Shop nào còn thiết lập?
- Channel/PayOS/domain/readiness nào đang lỗi hoặc degraded?
- Có stockout, payment exception hoặc delivery failure cần xử lý không?
- Subscription có hạn chế hành động nào không?

Thay metric trang trí bằng action-oriented summary. Mỗi cảnh báo phải dẫn đến đúng remediation route.

### 7.4 Onboarding wizard

Nguồn: `src/components/dashboard/OnboardingWizard.astro`, `src/scripts/dashboard/onboarding.ts`.

Các bước hiện tại phải được giữ về mặt nghiệp vụ:

1. Tạo/chọn shop.
2. Chọn website, Telegram hoặc cả hai.
3. Tạo sản phẩm và variant đầu tiên.
4. Preview, xác nhận và mã hóa inventory key.
5. Kết nối/health-check Telegram.
6. Kết nối/health-check PayOS.
7. Thông tin hỗ trợ và policy URL.
8. Readiness/test/publish.

Yêu cầu UX:

- Tiến độ lấy từ server, không chỉ localStorage.
- Cho phép rời trang, quay lại, retry và skip bước tùy chọn.
- Phân biệt `waiting_user`, `waiting_provider`, `blocked`, `warning`, `ready`.
- Website-only shop không bị ép hoàn thành Telegram.
- Không gọi bước cần BotFather, PayOS hoặc DNS là “lỗi kỹ thuật”; hiển thị một hành động ngoài hệ thống rõ ràng.
- Secret field không được prefill hoặc hiển thị lại sau khi lưu.
- Inventory preview chỉ hiển thị count, không echo key.
- Publish luôn re-run readiness từ server.

### 7.5 Domain manager

Nguồn: `src/components/dashboard/DomainManager.astro`, `src/pages/app/domains.astro`.

- Hiển thị platform subdomain là địa chỉ tự động, không cần DNS.
- Custom domain lifecycle cần tách rõ ownership, hostname, DNS, SSL và primary state.
- Ưu tiên custom subdomain như `shop.example.com`; apex có warning nếu chưa hỗ trợ.
- DNS instruction phải có type/name/value, copy feedback và `Kiểm tra lại`.
- Delete/primary action cần impact message, recent auth/permission state và confirmation phù hợp.
- Không hứa “one click” nếu seller vẫn phải chỉnh DNS.

### 7.6 Storefront home và product detail

Nguồn: `StorefrontLayout.astro`, `ProductCard.astro`, `src/pages/products/[slug].astro`.

- Mobile-first vì traffic thường mở từ Telegram.
- Shop branding gồm logo, brand/accent, headline, description, announcement và support.
- Product card phải hiển thị title, description ngắn, variant/stock và giá.
- Stock chỉ dùng `available`, `low_stock`, `out_of_stock`; không lộ số lượng nếu setting không cho phép.
- Product detail giữ variant selection, quantity, stock state và add-to-cart.
- Draft/suspended/unknown tenant phải có safe state riêng, không lộ sản phẩm nháp hoặc dashboard data.
- Public catalog phải dùng semantic HTML và render được khi JS chưa chạy.

### 7.7 Cart, checkout và order

Nguồn: `cart.astro`, `checkout.astro`, `orders/[orderPublicId].astro` và script storefront tương ứng.

- Cart client state có thể dùng localStorage, nhưng quote/price/stock luôn được server xác nhận lại.
- Checkout hiển thị exact amount, contact optional, Turnstile khi cấu hình và trạng thái quote.
- Return/cancel URL chỉ đưa buyer về order page; không được biểu diễn như bằng chứng `paid`.
- Order page tách ít nhất hai trục: `Thanh toán` và `Giao hàng`.
- Chỉ hiển thị key sau paid + fulfilled + valid order access.
- Thiết kế state: pending payment, paid/processing, fulfilled, expired, canceled, exception, access denied và retry.
- Key card cần copy feedback nhưng không tự gửi plaintext vào analytics/log.

### 7.8 Admin operations

Nguồn: `src/pages/admin/index.astro`, `src/pages/admin/operations.astro`.

- Đây là vùng rủi ro cao, không áp dụng UI consumer-friendly quá mức.
- Giữ role visibility, recent-auth, CSRF, idempotency và explicit confirmation.
- Ưu tiên queue/ledger, severity, scope, evidence reference và safe error code.
- Không hiển thị secret, plaintext key, reporter contact hoặc raw provider payload.
- Destructive action phải khác biệt rõ, có impact và không đặt sát action thông thường.

## 8. Shared component backlog

Ưu tiên tạo shared Astro primitives trước khi mở rộng page:

- `PageHeader`, `SectionHeader`, `ActionBar`.
- `Button`, `IconButton`, `LinkButton` với variants semantic.
- `StatusBadge`, `HealthIndicator`, `ReadinessCheck`.
- `Alert`, `InlineFeedback`, `ToastRegion`.
- `Field`, `SecretField`, `SelectField`, `FormActions`.
- `EmptyState`, `LoadingState`, `ErrorState`, `BlockedState`.
- `DataTable`/responsive record list, `Pagination` hoặc cursor controls.
- `ConfirmDialog` với focus management.
- `ShopSwitcher`, `WorkspaceNav`, mobile navigation.
- `ProductCard`, `VariantSelector`, `StockLabel`, `Money`.
- `OrderTimeline`, `PaymentState`, `FulfillmentState`, `KeyRevealCard`.

Không tạo abstraction chỉ vì hai đoạn CSS trông giống nhau. Component shared phải có cùng semantic và interaction contract.

## 9. Responsive requirements

- Minimum supported viewport: 320px; acceptance chính ở 390px mobile và desktop.
- Touch target tối thiểu 44×44px.
- Seller sidebar chuyển thành mobile header/drawer hoặc bottom navigation có nhãn rõ; không chỉ xếp sidebar thành hàng ngang dài.
- Wizard step rail cần phiên bản mobile: progress summary + step selector, không ép người dùng scroll ngang.
- Dashboard table phải chuyển thành record list hoặc scroll container có label; không cắt action quan trọng.
- Checkout, order status và domain instruction dùng một cột trên mobile.
- Không có horizontal overflow ở marketing, dashboard, onboarding, storefront và admin representative states.

## 10. Accessibility contract

Theo ADR `0011-accessible-design-system-and-tenant-theming.md`:

- WCAG 2.2 AA: 4.5:1 cho normal text; 3:1 cho large text, meaningful icon, focus và UI boundary áp dụng.
- Visible `:focus-visible`, logical tab order, skip link và semantic landmarks.
- Form luôn có label, description/error liên kết bằng `aria-describedby` khi cần.
- Status async dùng live region có chủ đích, không spam screen reader.
- Dialog trap focus, trả focus về trigger và đóng bằng Escape khi an toàn.
- Không dùng màu làm tín hiệu duy nhất.
- Tôn trọng `prefers-reduced-motion`.
- Seller theme không được làm mất contrast hoặc che focus/payment/error state.

## 11. State matrix bắt buộc

Mỗi page/component có data loading phải thiết kế tối thiểu:

| State | Yêu cầu |
| --- | --- |
| Loading | Skeleton hoặc trạng thái đọc được, không blank screen |
| Empty | Giải thích vì sao trống và action tiếp theo |
| Success | Xác nhận kết quả, không chỉ đổi màu |
| Warning | Nêu tác động và deadline nếu có |
| Blocked | Nêu blocking code bằng copy dễ hiểu và remediation |
| Waiting user | Một hành động cần seller thực hiện |
| Waiting provider | Cho biết đang chờ, lần kiểm tra gần nhất và retry |
| Error/retry | Safe message, request ID khi cần support |
| Forbidden | Giải thích role hiện tại không đủ quyền |
| Plan limited | Nêu capability bị giới hạn, không giả thành lỗi kỹ thuật |
| Suspended | Chặn mutation mới nhưng giữ lịch sử/export phù hợp |

## 12. Copywriting rules

- Tiếng Việt là locale chính; cấu trúc phải sẵn sàng cho English.
- Dùng từ nhất quán: `cửa hàng`, `kênh bán`, `kho mã`, `đơn hàng`, `thanh toán`, `giao hàng`, `kiểm tra sẵn sàng`.
- Không gọi seller là vendor/merchant trong UI tiếng Việt nếu không có lý do.
- Không hứa “tự động hoàn toàn” cho BotFather, PayOS consent hoặc DNS ownership.
- Không hiển thị raw machine error làm message chính; có thể đặt safe code/request ID ở phần chi tiết.
- Không dùng copy khiến Selinow bị hiểu là đơn vị giữ tiền hoặc trung gian payout.

## 13. Performance và SEO

- Marketing/storefront ưu tiên HTML/CSS trước; hydrate chỉ phần cần tương tác.
- Không thêm thư viện animation/chart/icon nặng cho tác vụ đơn giản.
- Product image/media dùng kích thước phù hợp, lazy-load ngoài viewport và tránh layout shift.
- Marketing và public storefront có metadata/canonical đúng hostname.
- Checkout/order/key/login/dashboard/admin luôn noindex; sensitive response no-store.
- Public catalog cache key phải gồm tenant hostname và locale; frontend không tự cache cross-tenant.

## 14. API và security integration

Frontend dev không được thay đổi các invariant sau:

- Checkout/idempotent mutation dùng idempotency key theo API hiện tại.
- Dashboard mutation gửi CSRF và không tin role/shop ID từ client.
- Price, stock, payment, fulfillment và readiness luôn được server xác nhận.
- Provider credential field chỉ gửi qua authenticated HTTPS endpoint và xóa khỏi UI state sau success.
- Không log request body chứa credential/key, payment identity hoặc order access token.
- Error UI chỉ dùng stable safe code; không render raw provider/database error.

## 15. Phạm vi triển khai đề xuất

### Phase FE-1 — Foundation

- Audit token hiện tại và chốt typography/palette/radius.
- Tạo shared primitives và state components.
- Redesign `AppLayout` mobile navigation.
- Chuẩn hóa form, feedback, dialog và responsive behavior.

### Phase FE-2 — Seller critical path

- Overview.
- Onboarding wizard.
- Domain manager.
- Bổ sung shell/routes cho product, inventory, order và integrations theo API đã có.

### Phase FE-3 — Buyer critical path

- Storefront home.
- Product detail.
- Cart/checkout.
- Order/payment/fulfillment/key reveal.

### Phase FE-4 — Marketing và operations

- Marketing/pricing/login.
- Admin abuse/operations surfaces.
- Visual regression, keyboard, contrast và mobile QA.

## 16. Deliverables yêu cầu từ frontend team

- Sitemap và role-aware navigation.
- User flow cho onboarding, publish, buyer checkout và key reveal.
- Desktop/mobile design cho các critical pages.
- Design tokens và component state matrix.
- Astro component implementation; không chỉ Figma.
- Test/evidence cho accessibility, keyboard, reduced motion và 390px mobile.
- Screenshot baseline hoặc deterministic visual regression cho representative states.
- Ghi chú các API/data field còn thiếu; không mock thành behavior production.

## 17. Definition of done

- UI đúng product boundary SaaS multi-tenant, không biến thành marketplace.
- Ba surface platform/app/storefront giữ context và branding phù hợp.
- Seller biết hành động tiếp theo mà không cần hiểu webhook, Worker hoặc database.
- Onboarding resume/retry/skip đúng server state và không lộ credential/key.
- Buyer hoàn thành storefront → cart → checkout → order status trên mobile.
- Payment và fulfillment luôn được hiển thị là hai trạng thái riêng.
- Mọi critical page có loading, empty, blocked, error và permission state.
- Keyboard navigation, focus, contrast và reduced-motion đạt contract.
- Không horizontal overflow ở 320/390px.
- `npm run check`, `npm run lint`, test liên quan và `npm run build` đều pass.

## 18. Tài liệu nguồn bắt buộc đọc trước khi code

- `01_PRODUCT_SCOPE.md`
- `03_AUTOMATION_AND_ONBOARDING.md`
- `07_SECURITY_AND_OPERATIONS.md`
- `08_DELIVERY_PLAN_AND_ACCEPTANCE.md`
- `docs/adr/0011-accessible-design-system-and-tenant-theming.md`
- `docs/IMPLEMENTATION_STATUS.md`
- Các file layout/page/component/style được liệt kê trong mục 4.

Khi brief này và source khác nhau, business/security contract trong repository là nguồn sự thật; frontend team phải nêu chênh lệch trước khi tự thay đổi flow.
