# Đánh giá UI Dashboard hiện tại & Kế hoạch làm mới toàn diện

Cập nhật: 2026-08-15
Phạm vi: `src/pages/app/**`, `src/pages/admin/**`, `src/layouts/AppLayout.astro`, `src/layouts/AdminLayout.astro`, `src/components/dashboard/**`, `src/components/workspace/**`, `src/components/primitives/**`, `src/components/states/**`.
Không thuộc phạm vi: marketing (`index.astro`, `pricing.astro`...), auth (`login/register/forgot-password`), onboarding wizard mới, storefront buyer-facing — các mảng này vừa được làm lại ngày 2026-08-15 theo `docs/IMPLEMENTATION_STATUS.md` và không phải trọng tâm phản ánh của bạn.

Đây là tài liệu phân tích/lập kế hoạch. **Chưa có dòng code nào bị thay đổi.**

---

## 0. Bối cảnh quan trọng cần biết trước khi làm gì tiếp

Repo đã có **rất nhiều hạ tầng redesign được chuẩn bị sẵn** nhưng phần lớn chưa "ngấm" vào dashboard thật:

| Tài sản đã có | Vị trí | Tình trạng thực tế |
| --- | --- | --- |
| Design token hệ `--sln-*` (màu, spacing, radius, shadow, typography) | `src/styles/selinow-tokens.css` | Tồn tại, khá đầy đủ, nhưng **song song với hệ token cũ `--selinow-*`** — hai bộ token cùng sống, gây trôi màu/spacing. |
| Bộ primitive UI (`Button`, `Alert`, `Input`, `SelectField`, `SecretField`, `Drawer`, `ConfirmDialog`, `Skeleton`, `StatusBadge`, `ToastRegion`) | `src/components/primitives/` | Được xây khá tốt nhưng **nhiều trang không dùng**, tự viết `<button class="sln-button">` riêng. |
| Bộ "workspace" component cấp cao (`DataTable`, `HealthRail`, `ReadinessRail`, `ActionQueue`, `ActivityLedger`, `PageHeader`) | `src/components/workspace/` | `PageHeader` được dùng phổ biến, nhưng **`DataTable`, `HealthRail`, `ReadinessRail`, `ActionQueue`, `ActivityLedger` không được import ở bất kỳ trang nào** — code chết. Mỗi trang tự dựng lại y hệt khái niệm này bằng markup + CSS riêng. |
| Bộ 13 "state" component (`EmptyState`, `ErrorState`, `BlockedState`...) | `src/components/states/` | 11/13 file chỉ là wrapper 1 dòng quanh `StatePanel`; toàn bộ dashboard vẫn dùng `WorkspaceState` (chú thích ngay trong code là "legacy compatibility shim"). |
| `OnboardingWizard.astro` (904 dòng) | `src/components/dashboard/` | **Code chết hoàn toàn** — không route nào render nó nữa (route `/onboarding` đã chuyển sang `OnboardingShell` + các bước riêng), chỉ còn bị đọc bởi test và tài liệu cũ. |
| Bộ tài liệu redesign khổng lồ đã soạn trước | `docs/FRONTEND_REDESIGN_BRIEF_VI.md`, `docs/frontend-prompt-os/**`, `docs/frontend-rebuild-handoff/**`, `docs/frontend-redesign/**` | Có brief, design system, screen spec, copy deck, QA matrix... **nhưng chỉ có 9 screen spec cho khu vực "WORKSPACE"** (Overview, Products, Orders, Order Detail, Inventory, Integrations, Domain Manager, Store Builder, Onboarding Readiness) — **thiếu hẳn spec cho Automation, Customers, Members, Billing, Security, Data/Audit và toàn bộ khu Admin**. |
| `docs/IMPLEMENTATION_STATUS.md` | gốc docs | Ghi nhận đợt redesign lớn nhất gần nhất (2026-08-15) chỉ đụng tới **marketing landing page + onboarding + auth** — không đả động gì tới các trang `app/products`, `app/orders`, `app/customers`, `app/billing`, `app/security`, `admin/*`. |

**Kết luận quan trọng:** Đây *không* phải tình trạng "chưa có design system". Đây là tình trạng **design system được xây hai lần, không lần nào được toàn bộ dashboard áp dụng nhất quán**, cộng với việc đợt redesign gần nhất tập trung vào trang chủ/onboarding chứ chưa chạm vào phần lõi vận hành (dashboard nghiệp vụ) — đúng phần bạn đang phàn nàn.

---

## 1. Đánh giá hiện trạng theo đúng 5 vấn đề bạn nêu

### 1.1 "UI lôi thôi" — thiếu nhất quán thị giác

- **Nút bấm bị cài lại ít nhất 6 lần** (`app/index.astro`, `automation.astro`, `billing.astro`, `customers.astro`, `members.astro`, `AutomationLedger.astro`) với chiều cao khác nhau: 40px / 42px / 44px, dù `Button.astro` đã có sẵn API `data-variant`.
- **`customers.astro` khai `.sln-button` hai lần trong cùng một `<style>`**, quy tắc sau đè quy tắc trước — dấu vết copy-paste không kiểm soát.
- **Hai hệ token màu cùng tồn tại**: `--sln-*` (mới) và `--selinow-*` (cũ, alias). `domains.astro`, `DomainManager.astro`, `DomainLifecycle.astro` dùng toàn bộ token cũ trong khi các trang khác dùng token mới → hai "vùng màu" khác nhau trong cùng một nhóm điều hướng "Kênh bán".
- **Hằng số màu hex rải rác ngoài token**: `#9a5004` lặp lại độc lập ở 3 file khác nhau, cộng thêm `#7c3e02, #b91c1c, #3730a3, #58b4f0, #3f84ef...` — mỗi nơi tự quyết một sắc độ "warning nâu" khác nhau.
- **`DomainManager.astro` (989 dòng)** trình bày như một trang landing page marketing (tiêu đề "07" khổng lồ, font `clamp(36px,5vw,56px)`) — hoàn toàn lạc tông so với phong cách dashboard cô đọng ở các trang khác.
- **Ít nhất 3 cách hiện thực khác nhau cho cùng một khái niệm "tab/segmented control"** (bộ lọc đơn hàng, bộ lọc kho, tab của store builder) — không có component `Tabs` dùng chung.
- **Badge trạng thái có 3 hệ song song ở khu admin**: `admin-badge[data-tone]`, `status-badge.status-*` (domains), `appeal-status-*` (appeals) — cùng ý nghĩa, 3 cách tô màu khác nhau.
- **`AdminLayout` ép dark theme cứng**, `AppLayout` mặc định sáng — nhân sự nội bộ vừa quản shop vừa trực vận hành sẽ bị "giật" giao diện liên tục.

### 1.2 "Thiếu tính năng" — khoảng trống so với chuẩn SaaS dashboard

Những khoảng trống lặp lại ở **hầu hết** các trang danh sách (Products, Orders, Inventory, Customers, admin Shops...):

- Không có **tìm kiếm/lọc phía server** — search hiện tại chỉ lọc trên dữ liệu đã tải của trang hiện tại (cursor pagination), tức là **không tìm được đơn hàng/khách hàng nằm ở trang sau**. Đây là lỗi chức năng, không chỉ là thiếu polish.
- Không có **sắp xếp cột, chọn hàng loạt (bulk action), export CSV, saved view** ở bất kỳ trang danh sách nào.
- **Ngưỡng tồn kho thấp ("low stock") không có nơi nào để chỉnh** — toàn bộ khái niệm "healthy/low/out" hiển thị nhưng seller không thể cấu hình ngưỡng.
- **Billing thiếu lịch sử hoá đơn/thanh toán đã thu, không có hoá đơn tải về**, usage và limit được hiển thị tách rời thay vì ghép thành thanh tiến trình "342/500".
- **Security chỉ có danh sách phiên đăng nhập + nút "revoke all"** — thiếu 2FA, đổi mật khẩu, lịch sử đăng nhập, quản lý API key — với một SaaS xử lý thanh toán + license key, đây là thiếu sót nghiêm trọng.
- **"Automation" thực chất là nhật ký tác vụ hệ thống (provisioning log)**, không phải trình tạo automation rule như tên gọi khiến người dùng kỳ vọng.
- **Admin không có quản lý vai trò/phân quyền qua UI**, không bulk action, không export phục vụ compliance, dùng `confirm()` của trình duyệt cho các hành động phá huỷ (xoá shop, xoay khoá mã hoá) thay vì dialog xác nhận 2 bước dù `ConfirmDialog.astro` đã có sẵn.
- Trang Order detail có **mục "Tin nhắn" và "Ghi chú" luôn trống, không có cách nào để dùng** — UI hứa hẹn tính năng chưa tồn tại.

### 1.3 "Chưa bao quát dự án" — thiếu IA / thiếu route thực

- **Nhóm điều hướng "Kênh bán hàng" có 8 mục nhưng chỉ dẫn tới 2 trang thật.** Telegram, Telegram Mini App, Zalo Mini App, Zalo OA, WhatsApp Cloud, Discord Bot — 6/8 mục đều trỏ về cùng `/app/integrations` bằng anchor `#channel-*`, kể cả `/app/telegram` (route riêng) cũng chỉ 307-redirect vào đó. Điều hướng "hứa" nhiều hơn thực tế có, đồng thời các kênh "coming soon" (`provider_pending`) lại hiển thị với sức nặng thị giác y hệt kênh đang chạy thật (Telegram) — gây hiểu nhầm cái gì dùng được, cái gì chưa.
- **`integrations.astro` (490 dòng) gộp 4-5 mảng không liên quan**: Telegram, PayOS, tóm tắt domain (trùng với `/app/domains`), quản lý API credential đầy đủ, và các thẻ kênh "sắp ra mắt" — đáng lẽ phải là các trang riêng.
- **`admin/operations.astro` (614 dòng) là kitchen-sink 6 trong 1**: dead-letter queue, GDPR/legal hold, xoay khoá mã hoá, công cụ debug PayOS chỉ dành cho staging (rò rỉ vào bundle production), "investigation bridge", quản lý sự cố — tất cả trong một route.
- **`app/data.astro` (467 dòng) cũng là kitchen-sink phía tenant**: export dữ liệu (kể cả export plaintext license key rủi ro cao), duyệt báo cáo lạm dụng, xoá shop, nhật ký audit — 4 mảng pháp lý/compliance khác nhau bị nhét vào một trang tên "data", nút export key thô nằm sát nút export thường.
- Layout tên `PlatformLayout.astro` thực chất là **layout marketing công khai**, không liên quan "platform admin" — dễ gây nhầm lẫn với `AdminLayout.astro` thực sự phục vụ vận hành nội bộ.
- Toàn bộ backlog 9 screen-spec sẵn có trong `docs/frontend-prompt-os/05_SCREEN_SPECS/WORKSPACE/` **không có** Automation, Customers, Members, Billing, Security, Data — nghĩa là kế hoạch redesign trước đây cũng chưa "bao quát" các màn hình này ngay từ khâu viết spec.

### 1.4 "Chưa tối ưu trải nghiệm người dùng"

- Nhiều hành động submit xong **reload cả trang** (`orders/[id].astro`) thay vì cập nhật tại chỗ — mất vị trí cuộn, giật trải nghiệm.
- Bảng dữ liệu giả lập bằng `div[role="table"]` tự viết ở nhiều nơi thay vì dùng `DataTable.astro` có sẵn — không đồng nhất hành vi responsive giữa các trang (một số trang sụp cột hợp lý, một số không).
- Toggle hiển thị kênh trong `products.astro` **disable hoàn toàn kèm chữ "loading" cho tới khi JS chạy xong** — cảm giác trang bị lỗi trong giây đầu.
- Action huỷ diệt (xoá shop, ẩn danh hoá GDPR khách hàng) được đặt ngang hàng thị giác với thao tác thường ngày, chỉ khác nhau bằng ô nhập "gõ chữ xác nhận" — rủi ro thao tác nhầm cao.
- Trang tổng quan (`app/index.astro`, 666 dòng) tốt về mặt nội dung nhưng **tự viết lại đúng những gì `HealthRail`/`ActionQueue`/`ActivityLedger` đã làm sẵn**, nghĩa là cùng một sản phẩm nhưng hai cách hiển thị hơi khác nhau nếu áp dụng các trang khác — không đồng bộ được trải nghiệm giữa các phần của dashboard.

### 1.5 "Nội dung thừa thãi"

- Bản thân trang Overview vừa hiển thị trạng thái publish 2 lần (`store.astro`), vừa lặp banner tĩnh mang tính marketing ("Catalog/Checkout/Responsive") chiếm chỗ trong một công cụ thao tác thực tế.
- `orders/[id].astro` có 2 khối "safe-callout" tĩnh gần như trùng nội dung, không có hành động, hoàn toàn có thể gộp thành 1 link trợ giúp.
- 6 trang admin/tenant tự tạo **cùng một cơ chế "bơm chuỗi dịch sang script client qua `data-copy={JSON.stringify(...)}`"** một cách độc lập — không sai nhưng là thừa thãi kỹ thuật, tăng chi phí bảo trì mỗi khi đổi câu chữ.
- Trên 10 "ledger list" khác nhau (`export-ledger`, `abuse-ledger`, `audit-ledger`, `member-ledger`, `invitation-ledger`, `session-ledger`, `billing-request-ledger`, `admin-records`, `appeals-list`...) — tất cả trông giống nhau về mặt hình ảnh nhưng được viết tay riêng biệt từng cái.

---

## 2. Vấn đề cấu trúc gốc rễ (top nguyên nhân, xử lý cái này trước sẽ giải quyết được 70% triệu chứng)

1. **Component đã xây nhưng không bắt buộc dùng.** Không có lint/CI rule nào chặn việc một trang tự khai `.sln-button` hay tự dựng bảng bằng div — nên mỗi trang trôi dần theo hướng riêng.
2. **Hai hệ token song song (`--sln-*` / `--selinow-*`) chưa migrate dứt điểm.**
3. **Điều hướng (nav) phản ánh roadmap thay vì hiện trạng thật** — 6/8 mục "Kênh bán" trỏ chung 1 trang, một số kênh chưa launch nhưng hiển thị ngang hàng kênh đã chạy.
4. **Ít nhất 2 trang là "kitchen sink"** (`admin/operations.astro`, `app/data.astro`) gộp nhiều domain nghiệp vụ không liên quan vào 1 route — vi phạm trực tiếp nguyên tắc tenant/compliance tách bạch trong `AGENTS.md`.
5. **Tìm kiếm/lọc/sắp xếp/export là tính năng nền tảng còn thiếu toàn diện**, không phải lỗi từng trang riêng lẻ — cần một pattern chung (server-side, URL-driven) áp cho tất cả bảng dữ liệu.
6. **Không có cơ chế chống tái diễn** — nếu không thêm rào chắn (lint rule / component bắt buộc), mọi công sức redesign sẽ trôi lại y như đợt cũ.

---

## 3. Kế hoạch làm mới toàn diện (đề xuất)

Nguyên tắc xuyên suốt: **không phá vỡ business/security invariant trong `AGENTS.md`** (tenant isolation, CSRF, idempotency, không lộ plaintext key/credential), **tận dụng token + primitive đã có** thay vì làm lại từ đầu, và mỗi phase phải qua `npm run check`, `npm run lint`, `npm run test`, `npm run build` trước khi coi là xong.

### Phase D0 — Dọn nền (1 đợt ngắn, rủi ro thấp, giá trị cao)
- Xoá `OnboardingWizard.astro` (xác nhận zero runtime reference) và viết lại các test đang assert vào file này để trỏ sang `OnboardingShell`/bước hiện hành.
- Chốt `--sln-*` là token duy nhất; xoá lớp alias `--selinow-*` sau khi tìm-thay toàn repo.
- Gộp 11 file `states/*State.astro` chỉ là wrapper 1 dòng vào thẳng `StatePanel`; giữ lại các bản có copy mặc định thật sự hữu ích.
- Thêm 1 CI/lint check (grep-based, dùng cách đã có trong `tests/unit/*.test.ts`) chặn: khai `.sln-button` / `.health-rail` / `.action-queue` cục bộ trong trang, và chặn mã hex trần ngoài `selinow-tokens.css`.

### Phase D1 — Chuẩn hoá bảng dữ liệu & hành động (nền tảng cho mọi trang danh sách)
- Đưa `DataTable.astro` từ "code chết" thành component bắt buộc cho: Products, Orders, Inventory, Customers, Members, admin Shops, admin Investigations, admin Appeals.
- Thiết kế lại tìm kiếm/lọc/sắp xếp/phân trang theo hướng **server-side, phản ánh qua URL** (query param), thay cho lọc client-side chỉ trong trang hiện có.
- Thêm bulk action + export CSV cho các bảng có khối lượng dữ liệu lớn (Orders, Products, Inventory, admin Shops, admin Investigations).
- Thay toàn bộ `confirm()` trình duyệt bằng `ConfirmDialog.astro` cho hành động huỷ diệt (xoá shop, ẩn danh khách hàng, xoay khoá, resolve incident).

### Phase D2 — Tái cấu trúc IA khu "Kênh bán & Tự động hoá"
- Gộp điều hướng: 1 mục "Kênh bán/Channels" duy nhất thay cho 6 mục trỏ chung 1 trang; điều hướng kênh chuyển vào trong trang (tab/segment) thay vì sidebar toàn cục.
- Tách `/app/integrations` thành: Channels (Telegram + kênh tương lai, có health/webhook log riêng), Payments (PayOS), API & Developer credentials — Domains chỉ giữ vai trò tóm tắt liên kết ra `/app/domains`.
- Tách `DomainManager.astro` (989 dòng) thành các component nhỏ (`DomainList`, `DomainConnectForm`, `DomainDeleteDialog`, `DomainGuide`), đưa script ra `src/scripts/dashboard/domains.ts` theo đúng pattern các module khác đang dùng, thay heading kiểu landing page bằng `PageHeader`.
- Đổi tên hoặc bổ sung tính năng cho "Automation" cho khớp với thực tế (nhật ký tác vụ hệ thống) hoặc lên kế hoạch xây rule-builder thật nếu đó là ý định sản phẩm.

### Phase D3 — Tách các trang "kitchen sink" & vá lỗ hổng tính năng nền tảng
- `admin/operations.astro` → tách thành `/admin/operations/incidents`, `/deletions`, `/key-rotation`, `/dead-letters`, trang gốc chỉ còn là landing tổng hợp số liệu; bỏ công cụ debug PayOS staging ra khỏi bundle chung.
- `app/data.astro` → tách `/app/data/exports`, `/app/data/deletion`, `/app/data/audit`; chuyển duyệt báo cáo lạm dụng ra khỏi "data" (gắn theo sản phẩm bị gắn cờ hoặc trang riêng), tách vùng "xuất plaintext key" khỏi luồng export thường bằng UI cảnh báo rõ rệt hơn.
- Bổ sung: 2FA, đổi mật khẩu, lịch sử đăng nhập cho `security.astro`; lịch sử hoá đơn + gộp usage/limit cho `billing.astro`; ô chỉnh ngưỡng tồn kho cho `inventory.astro`.

### Phase D4 — Thị giác & trải nghiệm hoàn thiện
- Áp thống nhất `Button`, `StatusBadge`, `Alert`, `EmptyState` cho toàn bộ trang còn sót (thay mọi `.sln-button` cục bộ).
- Chuẩn hoá một component `Tabs`/`SegmentedControl` dùng chung, thay 3 cách tự chế hiện có.
- Xử lý hành động submit không reload cả trang (áp dụng optimistic/partial update như đã làm tốt ở vài nơi) cho `orders/[id].astro` và các form còn dùng `window.location.reload()`.
- Rà soát & bổ sung screen-spec còn thiếu trong `docs/frontend-prompt-os/05_SCREEN_SPECS/WORKSPACE/` cho Automation, Customers, Members, Billing, Security, Data, và toàn bộ Admin (`ADMIN/`) để lần redesign này có tài liệu tham chiếu đầy đủ, tránh lặp lại tình trạng spec thiếu như đợt trước.

### Sau mỗi phase
- Chạy `npm run check`, `npm run lint`, `npm run test`, `npm run build`, `npm run deploy:dry-run` theo đúng yêu cầu `AGENTS.md`.
- Cập nhật `docs/IMPLEMENTATION_STATUS.md` với artifact, kết quả kiểm thử, giới hạn còn tồn tại.

---

## 4. Ưu tiên đề xuất nếu phải chọn làm trước

| Ưu tiên | Hạng mục | Lý do |
| --- | --- | --- |
| 1 | Phase D0 (dọn nền + rào chắn CI) | Rẻ, rủi ro thấp, ngăn tái diễn ngay lập tức |
| 2 | Phase D1 (DataTable + search/filter/sort server-side + ConfirmDialog) | Đánh trúng "thiếu tính năng" — ảnh hưởng mọi trang danh sách cùng lúc |
| 3 | Phase D2 (gộp IA Kênh bán, tách DomainManager) | Sửa trực tiếp cảm giác "lôi thôi, chưa bao quát" mà bạn thấy rõ nhất khi dùng nav |
| 4 | Phase D3 (tách kitchen-sink, vá tính năng an ninh/billing) | Giá trị cao nhưng phạm vi rộng hơn, cần nhiều quyết định sản phẩm (vd: phạm vi 2FA) |
| 5 | Phase D4 (hoàn thiện thị giác toàn diện) | Làm sau khi nền tảng ổn định để tránh phải sửa lại 2 lần |

---

## 5. Việc cần bạn quyết định trước khi bắt tay

1. **"Automation" là log tác vụ hệ thống hay cần trở thành rule-builder thật?** — ảnh hưởng lớn tới phạm vi Phase D2.
2. **Phạm vi bảo mật tài khoản (2FA, API key management) có nằm trong roadmap gần không?** — ảnh hưởng Phase D3.
3. **Có chấp nhận đổi route** (`/app/telegram` bỏ, `/app/store/settings` trỏ thẳng bằng anchor, tách `/admin/operations/*`) hay bắt buộc giữ nguyên URL vì đã có người dùng/bookmark/tài liệu bên ngoài?
4. **Ngân sách thời gian**: làm tuần tự D0→D4 (an toàn, chắc) hay chạy song song một số phase bằng nhiều luồng làm việc độc lập (nhanh hơn nhưng cần chia rõ phạm vi file để tránh xung đột)?

Trả lời 4 điểm trên, tôi có thể bắt đầu triển khai Phase D0 ngay (rủi ro thấp nhất, không cần quyết định sản phẩm) trong khi chờ quyết định cho các phase còn lại.
