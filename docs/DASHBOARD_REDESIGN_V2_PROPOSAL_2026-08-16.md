# Đề xuất làm mới hoàn toàn Dashboard — "Selinow Console" (v2)

Ngày: 2026-08-16
Trạng thái: **Đề xuất chờ duyệt** — chưa có dòng code nào thay đổi từ tài liệu này.
Phạm vi: toàn bộ khu workspace người bán (`/app/**`, `/onboarding`) và admin (`/admin/**`).
Tác giả: ca takeover dashboard (dựa trên phân tích code thực tế + E2E trong phiên 2026-08-16).

Đọc kèm: `docs/DASHBOARD_UI_AUDIT_AND_REDESIGN_PLAN_2026-08-15.md` (audit vòng 1),
`docs/storefront-templates/README.md` (hệ 9 template — ràng buộc mở rộng),
ADR 0011 (brand không phá semantic states).

---

## 0. Tóm tắt điều hành

Phàn nàn của chủ sản phẩm: *"bố cục lởm khởm, quá nhiều nội dung bố trí chưa khoa
học, phong cách thiết kế lỗi thời quá trẻ con, viền quá dày"*. Phân tích code xác
nhận cả 4 nhận định, và chỉ ra gốc rễ **hệ thống** chứ không phải từng trang lẻ:

1. Cảm giác "viền dày" không đến từ độ dày (phân nửa viền đã là 1px) mà từ
   **số lượng viền**: 129 chỗ khai `border: 1px` + 48 `border-top` chỉ riêng khu
   dashboard — mọi metric là một card có viền + shadow + bo góc riêng, card nằm
   trong panel có viền, panel nằm trong section có viền.
2. Phong cách "trẻ con" đến từ: emoji trong UI (8 file: 🚀✨📦🔑🪟🎨🎵🎮), font
   weight hiển thị tới **720–750** (đậm hơn cả marketing landing), bo góc lớn
   (12–24px), eyebrow uppercase in đậm khắp nơi ("BƯỚC 01/05", "SECURITY
   POSTURE", "HIGH-IMPACT ACTION"), tint màu trải trên mọi khối.
3. "Nhồi nhét" đến từ cấu trúc trang: mỗi trang chất 5–7 section song song
   (products: 4 metric + channel visibility + categories + bảng + 3 dialog;
   billing: hero + 4 ô事实 + entitlements + invoices + usage + request form).
4. "Lởm khởm" đến từ 3 ngôn ngữ thị giác sống chung: phong cách marketing
   onboarding (gradient, step emoji) ≠ phong cách "panel + eyebrow" dashboard ≠
   các trang chưa chuẩn hoá (inventory/members/appeals vẫn hand-rolled table).

Đề xuất: thay **toàn bộ design language** (token + primitives + app shell + page
template) bằng ngôn ngữ **"Selinow Console"** — gọn, viền hairline duy nhất, bảng
màu trung tính, typography chuẩn làm việc, mật độ-thông-tin cao nhưng trầm;
**giữ kiến trúc Astro SSR** (giải trình ở mục 9);**bám hệ 9 storefront template**
để dashboard sau này nhận theme accent theo template shop đang dùng (mục 8).

---

## 1. Phân tích hiện trạng từng cụm màn hình

### 1.1 App shell — `src/layouts/AppLayout.astro` + `app-shell.css`

**Hiện trạng.** Sidebar trái cố định với 4 nhóm nav (Operations / Sales channels /
Configuration / Administration); mỗi link có icon SVG + label; topbar có "Sales
workspace — <tên>" + menu user; mobile chuyển qua `app-mobile-menu` (dialog) qua 2
trigger riêng ("shop", "more") — thực chất là **hamburger 2 nút**, không phải
pattern điều hướng mobile hiện đại.

**Vấn đề.**
- Nav nhóm theo cấu trúc **kỹ thuật của hệ thống** (integrations/domains/
  developer tách 3 mục) thay theo **nhiệm vụ người bán** (Bán hàng / Hàng hoá /
  Tiền & đối soát / Cấu hình). Người bán mới phải học từ vựng kiến trúc.
- Không có trạng thái collapse; sidebar luôn chiếm ngang cố định → trên laptop
  13" vùng làm việc bị ăn ~15%.
- Badge số ("3") trên nhóm Sales channels là cảnh báo cấu hình nhưng không dẫn
  đi đâu khi bấm vào chính nhóm đó.
- Topbar + context store + menu user + mobile triggers = 4 lớp nhận diện chồng
  nhau trong 1 dải ngang hẹp.

### 1.2 Overview `/app`

**Hiện trạng.** PageHeader marketing (eyebrow + h1 lớn + mô tả dài), state
"No store yet" khi chưa có shop, khi có shop là dashboard tổng hợp.

**Vấn đề.** Trang chủ của workspace không trả lời 3 câu hỏi kinh doanh trong 5
giây đầu: *hôm nay bán được bao nhiêu / có đơn nào cần xử lý / kênh nào đang
hỏng*. Thiếu khối "cần hành động" (action queue) tổng hợp; mọi metric rải rác
trong card viền riêng.

### 1.3 Catalog — `/app/products`, `/app/inventory`

**Hiện trạng.** products đã có DataTable + search/sort/pagination (luồng D1);
nhưng phía trên bảng là 4 metric card (Products/Variants/On sale/Low stock) +
region "Catalog visibility by channel" + region "Categories" — cùng lúc trên 1
màn. inventory vẫn là grid hand-rolled `.inventory-row` với filter client-side
(all/low/out), không DataTable, không search server-side.

**Vấn đề.** Ba khối đầu trang chiếm ~40% viewport trước khi thấy bảng — điều
người bán đến trang này để làm. Channel visibility là cấu hình hiếm dùng nhưng
đứng ngang hàng bảng sản phẩm. Inventory lệch chuẩn hoàn toàn với products.

### 1.4 Orders — `/app/orders`, `/app/orders/[id]`

**Hiện trạng.** Summary 4 metric + ledger DataTable + CSV export; trang chi tiết
2 cột (timeline trái, remediation/notes phải), toast status.

**Vấn đề.** Trang detail dồn cả payment track + fulfillment track + notes +
remediation + customer vào scrollbar dài không có anchor; hai "track" độc lập
(tốt về khái niệm) nhưng không có thị giác phân tách rõ (cùng style card).

### 1.5 Security & Billing — `/app/security`, `/app/billing`

**Hiện trạng (điểm sáng).** Security đã có 4 tab đúng chuẩn (Sessions/2FA/
Password/History) — cấu trúc tốt, chỉ cần làm lại da. Billing: plan hero gradient
indigo + 4 ô thực tế + entitlements ledger + invoices + usage meters + request
form.

**Vấn đề.** Billing là ví dụ điển hình của "nhồi": 6 section, trong đó
"entitlements ledger" (danh sách limit thô dạng key–value) là dữ liệu kỹ thuật
không dành cho người bán; usage meter thì lại bị chôn dưới invoices. Plan hero
gradient là phong cách landing page, không phải workspace.

### 1.6 Integrations / Domains / Developer / Automation

**Hiện trạng.** Integrations hub (luồng D2) đã gom đúng; nhưng mỗi channel card
có "provider-mark" ô vuông chữ 2–3 ký tự (DNS/TG/ZL) + border-top 3px màu accent
— đây là nguồn cảm giác "trẻ con" lớn nhất khu này. Domains: 2 cột lệch,
domain card dùng h5 clamp 22–30px (chữ to hơn cả tên trang). Automation: Rules +
Ledger tab tốt; RuleList card có status chip + last-run chips nhiều màu.

**Vấn đề.** Quá nhiều màu accent mỗi card một kiểu; typography cấp sai (hostname
đẹp bằng display font); provider-mark nên là icon thực.

### 1.7 Onboarding `/onboarding`

**Hiện trạng.** Wizard 5 bước phong cách landing: "BƯỚC 01/05", sản phẩm mẫu có
emoji lớn (🪟🎨🎵🎮), preview drawer mô phỏng Telegram, celebration cuối.
Có bug CSS `[hidden]` đã sửa trong ca trước (drawer che form).

**Vấn đề.** Đây là lần đầu người bán thấy sản phẩm — mà phong cách hoàn toàn khác
dashboard họ sẽ dùng hằng ngày. Wizard dài 5 bước nhồi cả product + key + connect
+ publish; các bước trung gian (kho key, kết nối PayOS) thực chất là cấu hình có
thể để sau ("Set up later") thay vì bắt buộc tuyến tính.

### 1.8 Admin `/admin/**`

**Hiện trạng.** shops/investigations/appeals đã có search/filter/pagination
(D1) nhưng cùng "da" cũ; operations/index là trang dày đặc đặc thù.

**Vấn đề.** Nhẹ hơn khu seller (dùng ít emoji), chủ yếu thừa hưởng lỗi viền +
card của shell chung.

---

## 2. Chẩn đoán gốc rễ (5 nguyên nhân hệ thống)

1. **Không có page template chuẩn** — mỗi trang tự quyết định cấu trúc section
   → mỗi trang một bố cục (R1 cho "lởm khởm").
2. **Card là đơn vị duy nhất** — không có khái niệm "metric row" hay "section
   divider" nên mọi thứ đều phải thành hộp viền (R1 cho "viền dày").
3. **Token thiếu lớp trung tính** — token hiện thiên về tint màu + weight đậm
   (720–750) dùng chung cho marketing lẫn workspace (R1 cho "trẻ con").
4. **Density thấp, trình bày dọc** — mọi danh sách đều stack section dài, không
   khai thác chiều ngang màn hình lớn; mobile thì lại nhồi (R1 cho "nhồi nhét").
5. **Icon system không tồn tại** — emoji + chữ viết tắt 2 ký tự thay icon chuyên
   nghiệp (R1 cho "trẻ con").

---

## 3. Benchmark xu hướng 2025–2026

Nguồn tổng hợp ở mục 10. Điểm chung của các sản phẩm được coi là chuẩn
(Linear, Vercel, Stripe Dashboard, Notion settings, shadcn/ui blocks):

- **Hairline border duy nhất**: 1 token `--border` màu rất nhạt (xám 5–8% độ
  tương phản), dùng cho cả divider lẫn viền; **không shadow** trên phần tử tĩnh;
  tách section bằng divider 1px hoặc khoảng trắng, không bằng hộp.
- **Neutral-first palette (60-30-10)**: nền/ chữ/ muted đều trong 1 thang xám
  trung tính; màu chỉ xuất hiện ở (a) hành động chính, (b) trạng thái语 nghĩa
  (thanh toán/tồn kho/bảo mật — trùng triết lý protected states của ADR 0011).
- **Typography làm việc**: regular 400 cho thân, 500–600 cho nhấn, 600 chữ số
  lớn metric; *không* weight >600 trong workspace; cỡ chữ thân 13–14px desktop.
- **Density cao nhưng trầm**: bảng nhiều dòng với row height 40–44px, số liệu
  thẳng cột, màu chữ phụ thay màu nền phụ.
- **Sidebar chuyên nghiệp desktop** (240px, collapse về icon 56px, group label
  là chữ muted nhỏ không eyebrow) + **bottom tab bar 5 mục mobile** (đã thành
  chuẩn iOS/Android/web app nhờ các block như shadcn sidebar + mobile navbar).
- **Accessible theo mặc định**: keyboard nav, focus ring rõ, contrast AA — trùng
  gate phát hành template hiện có.

---

## 4. Triết lý thiết kế mới — "Selinow Console"

8 nguyên tắc, mỗi nguyên tắc kèm quy tắc quyết định khi tranh luận:

1. **Nội dung là giao diện** — nền + chữ + khoảng trắng là chủ; viền và màu là
   ngoại lệ. Quy tắc: muốn thêm viền cho một khối →先用 khoảng trắng/divider; chỉ
   dùng viền khi khối thực sự là hộp tương tác (input, dialog, popover).
2. **Một loại viền** — đúng 1 token `--border` (1px, xám nhạt); cấm border 1.5px,
   cấm border-top 3px accent, cấm viền + shadow cùng lúc.
3. **Màu = nghĩa** — màu chỉ cho: hành động chính, trạng thái nghiệp vụ (paid/
   low-stock/suspended…), và focus. Không màu trang trí. Tint nền chỉ dành cho
   trạng thái, tối đa 1 khối tint mỗi màn.
4. **Chữ số to, chữ mô tả nhỏ** — metric là "số lớn 24–28px/600 + nhãn 12px
   muted" đặt **trên nền phẳng liền nhau**, cách nhau bằng divider dọc mảnh,
   không card. Mô tả dài chỉ xuất hiện ở empty state / help, không lặp ở header.
5. **Một nhiệm vụ mỗi màn** — mỗi trang trả lời đúng 1 câu hỏi chính; cấu hình
   phụ đi vào tab/drawer/"Advanced". Quy tắc: >3 section khác chủ đề → tách trang
   hoặc gộp vào tab.
6. **Icon SVG stroke 1.5px một bộ** (lucide-style, đã có sẵn pattern SVG inline
   trong shell); cấm hoàn toàn emoji trong UI workspace; provider-mark 2 ký tự
   thay bằng icon.
7. **Mobile là граждан hạng nhất** — mọi bảng có chế độ danh sách thẻ di động,
   điều hướng chính bằng bottom tab 5 mục (Overview / Đơn / Sản phẩm /
   Tự động hoá /Thêm), hành động chính sticky dưới; desktop ≥1024px mới có
   sidebar, 768–1023 dùng danh mục rút gọn.
8. **Console kế thừa storefront** — dashboard là "bàn làm việc của chủ shop";
   mặc định trung tính, nhưng **accent + vài tín hiệu vertical** ăn theo template
   storefront shop đang chọn (mục 8) — một hệ sinh thái một ngôn ngữ.

---

## 5. Design tokens mới (thay thế, không cộng thêm)

Triết lý đặt tên giữ nguyên pattern `--sln-*` + thêm lớp semantic để không phá
ADR 0011; bảng dưới là **giá trị đổi chính** (không phải toàn bộ bảng):

| Nhóm | Hiện tại | Console v2 |
| --- | --- | --- |
| Border | `#e2e8f0` + strong `#cbd5e1`, 1px/1.5px/3px lẫn lộn | 1 token `--sln-line: oklch(x 0.01 264)` ≈ #e8eaed, 1px everywhere; dark: #26282d; xoá `border-strong` |
| Shadow | nhiều level (xs…) trên card tĩnh | chỉ 2: dropdown/dialog; card tĩnh **không shadow** |
| Radius | 8/12/16/24/pill | 6px control, 10px hộp (dialog/dropdown), pill chỉ cho chip trạng thái; xoá 16/24 |
| Display font | 720–750 weight, 48–72px | workspace h1 = 20px/600; 48–72px chỉ còn ở marketing storefront |
| Body | 16px/26px | 14px/22px desktop (mobile 15px), label 12px/500, metric 26px/600 tabular-nums |
| Palette | tint indigo/success/warning/danger/info nền + chữ nhiều nơi | thang neutral 9 bậc cho nền/chữ/muted; màu语 nghĩa giữ 5 states nhưng chỉ dùng ở chữ/badge/icon, nền tint giới hạn 6% opacity |
| Eyebrow | uppercase 700 mọi section | xoá trong workspace; group label nav = 11px/500 muted |
| Spacing | 4→128 full scale | giữ scale, nhưng section gap chuẩn 24px (32 chỉ giữa page-block), control gap 8px |

Kèm 3 guard test mới (mở rộng `promptos-foundation.test.ts`): cấm khai báo
`border[^:]*:\s*(1\.5|2|3)px` trong `src/{layouts,pages/app,pages/admin,
components/dashboard}`; cấm `font-weight:\s*(6[5-9]\d|7\d\d)`; cấm emoji range
trong markup astro khu workspace.

---

## 6. Hệ thống layout mới

### 6.1 App shell

```
Desktop ≥1024                     Mobile <768
┌────────┬───────────────┐        ┌──────────────┐
│ 240px  │  topbar 48px  │        │  topbar 48   │
│ sidebar│───────────────│        │   content    │
│ (colo- │  content      │        │  (đủ loại)   │
│ psable │  max 1200px   │        ├──────────────┤
│ →56px) │  pad 24       │        │ bottom tab 5 │
└────────┴───────────────┘        └──────────────┘
```

- Sidebar: nhóm theo nhiệm vụ — **Bán hàng** (Overview, Đơn hàng, Khách hàng),
  **Hàng hoá** (Sản phẩm, Kho key, Danh mục), **Tự động hoá** (Quy tắc, Nhật ký),
  **Kênh & thanh toán** (Website, Telegram, PayOS, Tên miền), **Cài đặt**
  (Thành viên, Bảo mật, Hoá đơn, API). Item = icon 16 + label 13; active =
  nền muted + chữ 600 (không viền trái đậm).
- Topbar 48px: breadcrumbs 1 dòng (Shop / Trang) + shop switcher + search toàn
  cục (⌘K, phase sau) + user menu. Mọi thứ còn lại đi hết.
- Mobile: bottom tab 5 mục cố định + mục "Thêm" mở sheet danh mục đầy đủ; header
  chỉ còn shop name + avatar.

### 6.2 Page template chuẩn (mọi trang workspace)

1. **Header 1 dòng**: title 20px + đúng tối đa 2 action chính bên phải (đã cả
   primary/secondary). Không eyebrow, không mô tả >1 dòng (mô tả dài → icon ⓘ).
2. **Metric strip** (tuỳ chọn): 2–4 số trên nền phẳng, divider dọc 1px giữa các
   số, đếm được thì thêm delta so chiều trước.
3. **Một vùng nội dung chính** (bảng/danh sách/luồng) chiếm phần còn lại của
   viewport đầu tiên; filter là 1 hàng mỏng ngay trên bảng (search + select +
   nút More filters), không tách thành panel.
4. **Phụ trợ xuống dưới hoặc tab** — không cùng lúc ngang hàng.
5. **Empty state** đúng 1 lần: 1 icon 24px + 1 câu + 1 nút — không lặp lại ở
   từng sub-section.

Áp cho từng cụm (ví dụ quyết định cụ thể):
- products: metric strip 4 số + bảng; channel visibility & categories chuyển
  thành 2 tab "Phân phối" / "Danh mục" phía trên bảng hoặc drawer; 3 dialog giữ.
- billing: tab **Hoá đơn & gói** (plan + invoices + checkout) / **Sử dụng**
  (usage meters) / **Yêu cầu** (request form); xoá entitlements ledger thô (gộp
  chú thích vào từng usage meter).
- security: giữ 4 tab; posture region gộp thành 1 dòng footnote.
- integrations: mỗi provider 1 dòng kiểu "list row" (icon + tên + trạng thái +
  nút) thay card grid; khối "sắp ra mắt" thành 1 hàng ngang mỏng cuối danh sách.
- domains: 1 cột danh sách; DNS instructions thành drawer khi bấm "Cấu hình".
- orders/[id]: header = số đơn + trạng thái + 2 nút; thân 2 cột
  40/60 (timeline trái sticky, chi tiết phải) có anchor tabs (Thanh toán /
  Giao hàng / Khách hàng / Ghi chú).
- onboarding: giữ 5 bước nhưng (a) da Console flat, (b) bước 3–4 mặc định
  "Để sau" cho phép finish 2 bước, (c) emoji → icon SVG, (d) preview drawer giữ
  (tính năng tốt) nhưng nút mở rõ ràng hơn.

### 6.3 Bảng (DataTable v2)

Row 44px, header 36px muted không nền, số dùng `tabular-nums`, trạng thái =
chip pill chữ 11px/600 + dot màu (không nền đặc), hover = nền muted 50%,
bulk select = checkbox 16px + toolbar nổi khi có chọn. Mobile: mỗi row thành
thẻ 2 dòng (tiêu đề + meta), sort/filter vào sheet "Tuỳ chọn".

---

## 7. Component system

- **Primitives thay mới trong chỗ cũ** (giữ tên file/props để giảm ảnh hưởng):
  `Button` (cao 32/36, weight 500, primary = nền đen chữ trắng — không gradient),
  `Input/SelectField` (viền hairline, focus ring 2px accent), `StatusBadge` (dot
  + chữ), `ConfirmDialog`, `StatePanel/EmptyState` (gọn còn icon + 1 câu + nút),
  `PageHeader` (1 dòng), `DataTable`, `Tabs`, `MetricStrip` (mới), `ListRow`
  (mới cho integrations/domains), `KeyHint` (⌘K…).
- **Icon pack**: 1 bộ SVG stroke 1.5px inline (Copy pattern `icons` map sẵn
  trong AppLayout), ~40 icon cần thiết; build script nhỏ gộp file
  `src/components/icons/` (không thêm dependency).
- **CSS**: giữ scoped-style Astro + tokens (repo hiện không Tailwind); không
  thêm framework CSS — "cleaner CSS, fewer overrides" đúng hướng 2026 mà không
  мигation rủi ro.

---

## 8. Tích hợp hệ 9 storefront template (yêu cầu bám)

Hệ template (TV0–TV4: swift/pulse/desk/aurora/metro/bustle/serenity/craft/
clinic) đã có: registry code-defined, `--merchant-*` brand tokens, scope
`[data-storefront-template]`, protected semantic states (ADR 0011), WCAG AA
gate. Console thiết kế để **mở rộng theo**:

1. `AppLayout` gắn `data-dashboard-template={shop.templateId}` +
   `data-template-scheme` — tương tự StorefrontLayout hôm nay (0 thay đổi logic,
   chỉ attribute).
2. Token map: `--merchant-accent` (nếu shop đã cấu hình brand) → biến thể accent
   duy nhất Console tiêu thụ (`--sln-console-accent`) dùng cho: nút chính, active
   nav, focus ring, metric delta dương. **Mọi trạng thái语 nghĩa vẫn ăn token
   `--sln-*` bảo vệ** — brand không phá states (đúng ADR 0011, không cần ADR mới).
3. Vertical hint: template vertical (digital/physical/booking) chọn bộ icon
   module + thứ tự nav ưu tiên (vd physical: Kho/Giao hàng lên trước; booking:
   Lịch/Đặt chỗ) — chỉ là config map, không phải 9 bộ UI.
4. Roadmap mở rộng (ngoài phạm vi v2): dashboard "theme theo template" đầy đủ
   (seller nhìn dashboard mang chất template mình bán) — nhờ 1+2 đã sẵn khung.

---

## 9. Quyết định công nghệ: giữ Astro, thay design language

Ý muốn "dùng ngôn ngữ thiết kế khác thay vì astro" được phân tích thẳng:

- **Astro không phải phong cách** — nó là lớp render (SSR per-request, session
  server-side, i18n, API routes). Mọi "look" nằm trong tokens + scoped CSS +
  components, tất cả sẽ bị thay toàn bộ trong v2. Cảm giác "Astro cũ kỹ" thực
  chất là da CSS hiện tại, không phải framework.
- Đổi sang React/Next SPA sẽ: viết lại toàn bộ pages + auth flow (cookie/CSRF/
  recent-auth đang gắn SSR) + i18n + 300+ test contract đọc markup, thêm build
  step client hydrate, tăng bundle, mất prerender marketing hiện có — rủi ro rất
  lớn, lợi ích thị giác = 0 (vì thị giác nằm ở CSS đã thay).
- Cònogonal đã cân nhắc: (a) Tailwind v4 làm utility engine — khả thi sau này
  nhưng thêm dependency + migrate toàn bộ style hiện có; v2 không cần; (b) Web
  Components/headless lib (shadcn-style port) — lấy pattern, không lấy code
  (shadcn gắn React).
- **Khuyến nghị**: giữ Astro + CSS scoped + token mới. "Loại bỏ hoàn toàn phong
  cách hiện tại" đạt được bằng thay 100% token/primitives/shell — đã kiểm tra:
  không ràng buộc kiến trúc nào giữ chân phong cách cũ.

---

## 10. Nguồn nghiên cứu

- [Contemporary & Minimalist Dashboard UI (Medium)](https://medium.com/@theymakedesign/dashboard-ui-designs-contemporary-minimalist-vol-239-6b38bfb3b3dd)
- [Dashboard Design in 2026: Do's and Don'ts](https://think.design/blog/dashboard-design-in-2026-dos-and-donts/)
- [9 Dashboard Design Principles](https://www.designrush.com/agency/ui-ux-design/trends/dashboard-design-principles)
- [shadcn/ui Sidebar](https://ui.shadcn.com/docs/components/base/sidebar) · [Sidebar Blocks](https://ui.shadcn.com/blocks/sidebar)
- [Mobile bottom tab bar pattern](https://www.shadcn.io/blocks/navbar-mobile-bottom)
- [shadcn theming — semantic tokens](https://ui.shadcn.com/docs/theming) · [Organizing color tokens](https://www.designsystemscollective.com/how-i-organize-colors-in-shadcn-ui-806965608479) · [60-30-10 mapping](https://www.sixtythirtyten.co/blog/shadcn-ui-color-system-60-30-10)
- [Vercel — globals.css token architecture](https://vercel.com/academy/shadcn-ui/exploring-globals-css)
- [UI trends 2026](https://tubikstudio.com/blog/ui-design-trends-2026/) · [Figma web trends](https://www.figma.com/resource-library/web-design-trends/)

---

## 11. Lộ trình đề xuất (4 phase, mỗi phase verify độc lập)

| Phase | Việc | Phạm vi file chính | Verify |
| --- | --- | --- | --- |
| P0 Foundation | token v2 + guard tests + icon pack + primitives mới (chạy song song da cũ qua class version `v2-` hoặc branch) | `selinow-tokens.css` (tạo `console.css` mới), `components/primitives/*`, `components/icons/*` | check/lint/test + visual spot 1 trang thí điểm |
| P1 Shell & nav | AppLayout mới (sidebar collapse + bottom tab mobile + topbar 48) + PageHeader/MetricStrip/ListRow + áp 2 trang thí điểm: Overview + Products | `AppLayout.astro`, `app-shell.css`, `shop-navigation.ts` | E2E nav + a11y (focus/keyboard) + snapshot 390px/1440px |
| P2 Toàn bộ seller pages | orders(+detail)/inventory(chuẩn hoá DataTable)/customers/members/security/billing(tabs)/integrations(list rows)/domains/automation/developer/onboarding(Console da + bước "Để sau") | `pages/app/**`, `components/dashboard/**`, `scripts/dashboard/**` (logic giữ nguyên, chỉ DOM/class) | full E2E smoke lại (kịch bản ca 2026-08-16 tái sử dụng) |
| P3 Admin + polish | admin shops/investigations/appeals/operations + dark mode audit + performance (bundle CSS) | `pages/admin/**` | verification gate đầy đủ |

Rủi ro & giảm nhẹ: (1) test contract đọc markup sẽ vỡ hàng loạt → cho phép sửa
theo P1–P2 từng đợt, không一并; (2) song song với luồng storefront-templates →
không đụng `src/components/storefront/**`, `src/styles/storefront/**`, chỉ chia
sẻ token semantic; (3) 30 chỗ `.sln-button` cục bộ + 19 file hex trần (đo từ ca
trước) sẽ bị guard chặn → dọn trong P2 trước khi bật guard.

Success metrics: thời gian tới hành động chính mỗi trang (click depth ≤2);
viewport đầu tiên = danh sách/nhiệm vụ chính (không metric card chiếm >20%);
số viền mỗi màn ≤ 6; LCP dashboard < 1.5s local; 0 emoji trong workspace;
a11y AA giữ nguyên 100% (axe + focus trap dialog hiện có).

---

## 12. Việc cần quyết định của chủ sản phẩm

1. Duyệt triết lý Console (mục 4) + hướng giữ Astro (mục 9)?
2. Cấu trúc nav theo nhiệm vụ (mục 6.1) — chấp nhận gộp/đổi tên mục?
3. Onboarding cho phép "Để sau" ở bước 3–4?
4. Dashboard accent theo template shop (mục 8.2) bật ngay P1 hay để phase sau?
5. Thời điểm bắt đầu P0 (đề xuất: sau khi luồng storefront-templates merge để
   tránh xung đột `dashboard.ts` catalog).
