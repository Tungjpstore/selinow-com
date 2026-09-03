# Kế hoạch Template Mastery (TM) — nâng 9 template từ "sạch" lên "điểm nhấn riêng + shop tự tối ưu"

Ngày: 2026-08-22 · Trạng thái: **CHỜ DUYỆT OWNER** · Kế thừa: CD0–CD5 đã xong
(`TEMPLATE_COMPLETION_DESIGN_PLAN_2026-08-22.md`), EX0/EX3/EX4/EX5-core đã xong
(`FRONTEND_EXPERIENCE_UPGRADE_PLAN_2026-08-22.md`). TM **không làm lại** cái đã xong — TM
bồi thêm **chiều sâu thị giác, điểm nhấn, và quyền kiểm soát của shop**.

---

## 0. Phê bình trung thực: vì sao hôm nay "vẫn quá đơn giản"

Audit code hiện tại (sau CD):

1. **Mỗi homepage chỉ có 3–4 khối** (hero → menu/grid → phụ kiện). So với chuẩn ngành — theme
   Shopify 2026 trung bình 8–12 section, cho phép reorder/toggle/edit từng khối (mẫu
   [Shopify Theme Store](https://www.shopify.com/blog/shopify-themes),
   [hướng dẫn customize](https://www.shopify.com/blog/customizing-store-theme)) — trang chủ
   Selinow kết thúc quá sớm: không có câu chuyện, không có social proof, không có FAQ, không có
   nút bắt liên hệ thứ hai, footer nghèo.
2. **Shop gần như không được quyền tối ưu gì ngoài copy + màu**: không chọn sản phẩm nổi bật,
   không sắp thứ tự khối, không bật/tắt search/usp/faq, không đổi nhịp dày/thưa. Shop "đẹp vì
   template" chứ không "đẹp vì shop" — đúng lý do dẫn tới không hài lòng.
3. **Không có điểm nhấn chuyển đổi**: countdown chỉ ở Pulse/Bustle và chỉ 1 nơi; không quick-add
   từ grid; không stock urgency; không bundle; không recently-viewed; không sticky ATC thứ hai;
   không social proof thật (đã tránh số bịa — đúng, nhưng thay bằng… không gì).
4. **Motion gần như vắng** trên storefront (đúng cam kết tĩnh-an-toàn của CD, nhưng giờ đã có
   hệ motion token + reveal utility từ EX0 — đủ điều kiện nâng có kỷ luật).
5. **Chiều sâu thị giác phẳng**: 1 level ảnh/nền, không layer (scrim/blur/grain/outline type),
   không nhịp dày–thưa xen kẽ, typography 1 tông giọng.

Nguyên tắc giữ nguyên từ CD/EX: money-path dùng khung chung + hook contract; protected states
AA; CSP (không web font, không inline JS); `--tmpl-*` token; mobile-first 390; Vietnamese-first.

---

## 1. Mục tiêu mastery & "định nghĩa shop hài lòng"

Sau TM, một shop **không viết code** có thể:
1. **Chọn template** (9 cá tính) → **sắp xếp thứ tự khối** home (toggle/reorder) → **soạn nội dung
   từng khối** (hero copy + ảnh từ thư viện, USP, FAQ, trích dẫn, editorial, danh sách nổi bật) →
   **chọn sản phẩm/collection spotlight** → **tuning** (preset đậm/nhạt, đày/thưa, hero variant) —
   tất cả thấy ngay trong preview, publish theo draft như hiện tại.
2. Mỗi template có **2–3 "khoảnh khắc đặc trưng"** nhận diện được trong 5 giây (xem §4) — không
   còn cảm giác "9 biến thể của 1 trang".
3. Công cụ chuyển đổi thật: countdown/voucher, quick-add + size popover, stock bar, bundle nudge,
   recently viewed, cross-sell giỏ, sticky ATC mobile thứ hai, booking CTA với **slot trống kế
   tiếp thật** (slots API có sẵn).
4. Gate: LCP không suy giảm (hero text-first, ảnh lazy + aspect), contrast VR4 tiếp tục pass,
   baselines VR chụp lại, motion đều có nhánh reduced-motion.

---

## 2. Kiến trúc: SectionRegistry + `storefront_json` v2 + Builder tab "Bố cục"

### 2.1 SectionRegistry (server, code-defined)
`src/lib/storefront/sections/registry.ts` — mỗi loại section là một định nghĩa:

```
SectionType = {
  id: "collection_rail" | "editorial_split" | "usp_grid" | "faq" | "testimonials"
      | "countdown_bar" | "bento_featured" | "category_tiles" | "flash_rail"
      | "spec_grid" | "ritual_steps" | "gallery_wall" | "masters_row" | "gift_card"
      | "newsletter" | "hours_band" | "rich_footer" | "booking_cta" | "spotlight"
      | "calculator" | "marquee" | "compare_teaser" | "stock_grid" | "bundle_nudge",
  verticals: [...],           // section chỉ hợp với vertical nào
  templates: [...] | "all",   // biến thể render theo template (class modifier)
  defaults: {...},            // settings mặc định an toàn
  requiresData: "products" | "categories" | "promotions" | "resources" | null,
  fallback: "hide" | "empty_state",  // khi thiếu data (không bao giờ render khối rỗng)
  render: AstroComponent,
}
```

Render home = duyệt `sections[]` từ cấu hình shop → mỗi section tự fallback nếu thiếu data
(`fallback:"hide"` giết khối khi rỗng — trang không bao giờ lủng).

### 2.2 `storefront_json` v2 (additive trong cùng cột JSON, không migration)
```
{
  templateId, headline, description, announcement, footerText, supportText, ...
  sections: [
    { id:"hero", type:"hero", enabled:true, settings:{ variant:"split", art:"preset-2" } },
    { id:"usp",  type:"usp_grid", settings:{ items:[{icon,title,body}×3] } },
    { id:"rail", type:"collection_rail", settings:{ categoryId:"...", title:"Bộ sưu tập Thu" } },
    { id:"faq",  type:"faq", settings:{ items:[{q,a}×≤6] } },
    ...
  ],
  style: { density:"comfort"|"compact", intensity:"mild"|"bold" }
}
```
- Parse an toàn như `templateId` (bounded: ≤12 section, mảng settings chặn độ dài, unknown
  section id → bỏ qua). Draft→publish y hệt hiện tại.
- **Mặc định**: mỗi template có `defaultStack` 7–10 section (§4) — shop không chạm gì vẫn có
  trang giàu ngay.

### 2.3 Store Builder tab "Bố cục" (Sections)
- Danh sách section theo stack: **toggle bật/tắt, mũi tên lên/xuống (reorder), edit settings**
  (form đơn giản theo schema: text/list/select/media-url), nút "khôi phục bố cục mẫu".
- Preview pane hiện section đang edit + scroll-to; device toggle như hiện tại.
- Không drag-drop tự do (giữ URL-as-state + a11y, đúng triết lý console) — reorder bằng nút là
  đủ cho v1 và test được.

---

## 3. Thư viện section chuẩn (23 type, thực chất ~16 cần viết mới — phần còn nhau biến thể)

| Nhóm | Section | Data | Ghi chú chuyển đổi |
|---|---|---|---|
| Mở đầu | `hero` (biến thể: split / full-bleed / typographic / spotlight-rotator) | content + media | text-first cho LCP |
| | `marquee` (ticker chữ, loop chậm 30s, RM tắt) | content | điểm nhấn Pulse/Craft |
| | `countdown_bar` (sticky hiện lại khi scroll-up) | promotions | Bustle/Pulse |
| Trưng bày | `bento_featured` (1 to + 4 nhỏ) | products featured | Swift/Desk/Pulse |
| | `collection_rail` (scroll-snap ngang + nút) | categories/products | Aurora/Metro |
| | `spec_grid` (hover spec-peek 3 dòng đầu) | products + attributes | Metro |
| | `stock_grid` (thanh tiến trình tồn kho khi showExactStock) | products + stock | Bustle |
| | `flash_rail` (deal ngang + timer từng card) | promotions + products | Bustle/Pulse |
| | `compare_teaser` (bảng 3 sản phẩm) | products + attributes | Metro/Desk |
| | `gallery_wall` (masonry ảnh) | media | Aurora/Craft |
| Chuyện & niềm | `editorial_split` (ảnh + text so le) | content + media | Aurora |
| | `ritual_steps` (scrollytelling + progress dots) | content | Serenity |
| | `masters_row` (card người/thợ/bác sĩ) | content + media | Craft/Serenity/Clinic |
| | `testimonials` (trích dẫn shop tự nhập — **không** chế số) | content | all (opt-in) |
| | `usp_grid` | content | all |
| | `faq` (details/summary chuẩn) | content | all |
| | `hours_band` (giờ mở + chính sách) | settings thật | Clinic/Craft/Serenity |
| Chốt | `booking_cta` (nút đặt + **chip slot trống kế tiếp thật** từ slots API) | booking | Serenity/Craft/Clinic |
| | `calculator` (slider ghế → giá/ghế, client-only, chân lý bảng giá) | variants | Desk |
| | `gift_card` (thẻ quà như sản phẩm nổi bật) | products | Serenity |
| | `newsletter` (form email → abuse-safe: chỉ mailto hoặc webhook có sẵn? v1: copy email shop) | content | opt-in |
| | `rich_footer` (2–3 cột link + social + "Powered by") | content | all |
| Vô hình | `bundle_nudge`, `recently_viewed` | localStorage/products | cart/detail, không phải section config |

---

## 4. Deep-spec 9 template — stack mới + điểm nhấn

Quy ước mỗi template: **Stack** = default section (mặc định đủ giàu, mọi section có fallback
hide) · **Signature** = 2–3 khoảnh khắc đặc trưng kèm spec tương tác · **Knobs** = shop chỉnh
được · **Motion** = token + RM.

### 4.1 SWIFT — từ "Geometric Precision" → **"Operational Studio"**
- **Stack**: hero split (variant không-search tùy knob) → `bento_featured` → catalog grid →
  `usp_grid` → `faq` → `rich_footer`. (6–7 khối, nhịp dày-thưa xen)
- **Signature**: (1) **Instant-search dropdown** — gõ trong hero search hiện dropdown kết quả
  (thumb 40px + tên + giá, client-filter như store-search, Esc đóng, aria-combobox); (2)
  **bento double-border + tilt-lite** (hover: translateY(-2px) + viền kép + gradient corner);
  (3) watermark initial **parallax chuột nhẹ** (translate ≤ 8px, chỉ pointer:fine, RM tắt).
- **Knobs**: hero variant ×3, art preset gradient ×6, density comfort/compact, USP/FAQ items.
- **Motion**: reveal stagger grid 40ms; dropdown 180ms standard.

### 4.2 PULSE — từ "Arcade Neon" → **"Drop Zone"**
- **Stack**: hero full-bleed + `marquee` ticker key hot (dưới hero, loop 30s) → `countdown_bar`
  (sticky on scroll-up) → `bento_featured` (ô to = deal chính + ô "instant delivery meter") →
  grid (glow viền accent khi hover) → `flash_rail` → trust wall → `rich_footer`.
- **Signature**: (1) **Instant-delivery meter** — block mô phỏng "PayOS → key trong ~30s": thanh
  3 bước animate **một lần** khi vào viewport (pay→confirm→key), số giây thật lấy từ trung vị
  hoàn thành đơn của shop nếu có, không có thì nhãn "vài giây" (không bịa số); (2) **ticker
  marquee** mã key/game chữ mono chạy chậm; (3) countdown bar sticky reappear.
- **Knobs**: ticker items, glow preset (brand/accent/trí), badge text, bật tắt meter.
- **Motion**: marquee loop chậm (ngoại lệ có ghi rõ §7), meter once 2.4s, RM → tĩnh đầy đủ.

### 4.3 DESK — từ "The Invoice" → **"Procurement Desk"**
- **Stack**: hero + mini bảng giá inline → plan table (featured flag) → **`calculator`** →
  `compare_teaser` → steps → catalog (list-view) → `faq` → `rich_footer` dạng "chân văn bản".
- **Signature**: (1) **Máy tính chi phí** — slider "số ghế/thiết bị" × đơn giá bảng variant →
  tổng + "giá/ghế giảm theo gói" (chỉ tính từ giá bảng thật, client-only, in footnote "ước tính
  theo bảng giá hiện hành"); (2) **row-expand catalog** — click hàng mở panel chi tiết inline
  (variant + mô tả ngắn) không rời trang; (3) **CTA "Xem trước hóa đơn"** mở modal dùng đúng
  khối style order-panel (review hoá đơn trống mẫu).
- **Knobs**: featured plan, mức calculator mặc định, bật compare, ngôn ngữ chân trang formal/informal.

### 4.4 AURORA — từ "The Editorial" → **"Fashion House"**
- **Stack**: hero full-bleed **Ken Burns-lite** (scale 1→1.04 một lần 6s, RM tắt) →
  `collection_rail` scroll-snap → `editorial_split` ×2 so le → grid hover-đổi-ảnh + **quick-add
  size popover** → `gallery_wall` lookbook → `testimonials` (trích dẫn báo chí/shop tự nhập) →
  `newsletter` (dạng dòng chữ serif + nút copy email shop v1) → `rich_footer` 3 cột.
- **Signature**: (1) quick-add popover: hover card (desktop) hiện swatch size → click size =
  add-to-cart thẳng (dùng data-cart-add + variant theo options_json); mobile: chạm mở sheet;
  (2) **drop-cap editorial** (chữ cái đầu serif lớn) + pull-quote; (3) collection rail với nút
  prev/next + snap.
- **Knobs**: hero ảnh (media lib), 2 editorial blocks (ảnh+text), rail theo category, quotes.
- **Motion**: reveal 240ms rise; Ken Burns once; popover 180ms spring.

### 4.5 METRO — từ "The Spec Sheet" → **"Tech Authority"**
- **Stack**: hero + **`spotlight` rotator** (3 sản phẩm, auto 6s, pause hover, RM: tĩnh nút
  chuyển) → `compare_teaser` → `category_tiles` (icon + số lượng) → `spec_grid` (hover hiện 3
  thông số đầu từ attributes) → trust band (bảo hành/chính hãng từ attributes) → `faq` →
  `rich_footer` + hours_band gộp.
- **Signature**: (1) **spec-peek overlay** — hover card đẩy lệch giá, hiện 3 dòng thông số mono;
  (2) spotlight rotator có progress mảnh; (3) compare teaser 3 cột (reuse SpecTable).
- **Knobs**: spotlight 3 sản phẩm, tile icon set, trust band items.

### 4.6 BUSTLE — từ "The Deal Market" → **"Mega Sale Arena"**
- **Stack**: hero mega countdown + **voucher clapboard** (chip mã nghiêng -3°, bấm = copy +
  draft) → `flash_rail` (timer từng card) → `category_wall` (tile màu dopamin theo merchant
  accent, safe AA) → `stock_grid` (thanh "còn X/N" khi showExactStock) → `bundle_nudge`
  ("Mua cùng — gợi ý cùng category, nhãn rõ "gợi ý") → `faq` ngắn → `rich_footer`.
- **Signature**: (1) flash rail mỗi card countdown riêng (endsAt của discount gán sản phẩm);
  (2) **stock progress bar**; (3) **bundle nudge** ở cuối cart/detail (same-category, không áp
  giá tự động — chỉ shortcut thêm).
- **Knobs**: tone urgency mild/bold (đổi copy + độ đỏ), voucher hiển thị, tile màu.

### 4.7 SERENITY — từ "The Calm Ritual" → **"Wellness Sanctuary"**
- **Stack**: hero gradient chuyển rất chậm (20s, RM tắt) → `masters_row` (kỹ thuật viên, ẩn khi
  chưa có resource data) → services menu (tab theo category) → **`ritual_steps` scrollytelling**
  (4 bước, progress dots bên, mỗi bước reveal) → `gift_card` spotlight → `testimonials` mềm →
  `booking_cta` + chip **slot trống kế tiếp thật** → `rich_footer` + giờ mở (hours_band).
- **Signature**: (1) scrollytelling ritual; (2) **next-slot chip thật** (gọi slots API công
  khai cho service đầu tiên, hiển thị "Còn trống 14:00 hôm nay" — data thật, click → PDP slot
  picker); (3) gift card như thiệp (bo tròn lớn + ribbon CSS).
- **Knobs**: ritual steps, masters (ảnh+tên), quotes, bật gift card.

### 4.8 CRAFT — từ "The Barber Board" → **"Underground Studio"**
- **Stack**: hero typography khổng lồ (outline + đặc xen, stagger reveal từng dòng) →
  `marquee` services (mono, viền trên dưới hairline) → `masters_row` dark card khung ảnh →
  price board hover annotation (ghi chú nhỏ hiện cạnh giá) → `gallery_wall` ảnh tác phẩm →
  `booking_cta` + next-slot chip → `hours_band` → footer ticket đục lỗ.
- **Signature**: (1) hero stagger + chữ outline (text-stroke an toàn fallback màu đặc); (2)
  **gallery wall masonry** (columns CSS, hover grayscale→màu); (3) next-slot chip thật (như
  Serenity, skin vuông).
- **Knobs**: masters, gallery ảnh, preset chữ hero (outline/solid/mixed).

### 4.9 CLINIC — từ "The Medical Record" → **"Care Portal"**
- **Stack**: hero + **credentials band** (chip chứng chỉ/hội đồng từ attributes label quy ước
  `chứng chỉ`) → `category_tiles` khoa (icon y tế đơn giản SVG) → services **accordion** (mở
  hiện SpecTable chỉ định + giá + thời lượng) → `masters_row` bác sĩ → process timeline dọc →
  `faq` y tế → `booking_cta` + next-slot chip → `hours_band` giờ khám + policy → `rich_footer`
  trầm.
- **Signature**: (1) accordion services với spec thật; (2) khoa tiles; (3) timeline quy trình
  dọc có số mono.
- **Knobs**: khoa, bác sĩ, FAQ, bật/tắt accordion vs table.

---

## 5. Merchandising thông minh (data thật, không chế số)

1. **Featured**: curation bằng quy ước `attributes label "featured"` (đã dùng cho Desk plan
   table) + builder UI tick "Nổi bật" viết attributes — **không migration**.
2. **soldCount thật**: thêm vào catalog projection `soldCount` (SQL đếm order_items theo variant,
  tenant-scoped) → badge "Đã bán N" (chỉ khi N ≥ 5, tắt được), feeding `bento_featured` mặc định
   khi không có curation (bestseller tự động).
3. **Badge tự động**: `NEW` (created_at ≤ 21 ngày), `BEST` (top 3 soldCount), `HOT` (compare-at
   hiện tại) — render server, tắt từng loại trong builder.
4. **Quick-add & size popover**: từ §4.4, dùng cho Aurora (swatch) + Bustle/Metro (nút + nhanh).
5. **Recently viewed** (localStorage 8 item, section cuối home + rail trên detail, tắt được).
6. **Cart cross-sell**: dòng "Thường mua cùng" dưới summary cart (same-category, ≤3, chỉ
   shortcut).
7. **Sticky mobile ATC thứ hai**: sau khi add → thanh "Đã thêm · Xem giỏ" đáy màn hình 4s.

---

## 6. Guardrails

- **Perf**: section ảo hoá (`content-visibility:auto` + `contain-intrinsic-size`), ảnh lazy +
  width/height, hero text-first (LCP giữ), budget CSS template +≤8KB gz, JS thêm gộp 1 bundle
  mỗi trang (đã có pattern bundled script).
- **A11y**: mọi popover/accordion/dropdown là disclosure chuẩn (aria-expanded, Esc, focus);
  marquee có `prefers-reduced-motion` → dòng tĩnh; ticker dừng khi hover/focus.
- **Motion**: chỉ token `--sln-duration/ease`; mỗi signature ghi rõ once/loop + RM fallback
  (bảng nhỏ trong PR mỗi section); **loop chỉ cho phép**: marquee (Pulse/Craft) + hero gradient
  Serenity — liệt kê trong contract test.
- **Contrast/VR**: VR4 chạy lại với preset intensity bold/mild × merchant màu đại diện; baselines
  VR chụp lại 9 template × stack mặc định + 2 biến thể knob chính.
- **Render-contract**: mỗi section có test "fallback khi thiếu data = ẩn khối, không DOM rỗng";
  storefront_json v2 parse test (bounds, unknown id).

---

## 7. Roadmap TM0–TM5 (~10–14 phiên)

| Phase | Nội dung | Phiên |
|---|---|---|
| TM0 | SectionRegistry + storefront_json v2 parse/defaultStack + render theo cấu hình (đầu ra nhìn như hôm nay nhưng đi qua registry) + tests | 2 |
| TM1 | Builder tab "Bố cục" (toggle/reorder/edit-lite) + preview + i18n | 2 |
| TM2 | Content plane: hero media, USP/FAQ/testimonials/editorial/masters settings + media-url picker | 1.5 |
| TM3 | **Signature ×9** (theo §4, chia 3 đợt: digital → physical → booking) + motion + RM | 4 |
| TM4 | Merchandising (§5 toàn bộ + soldCount SQL + badges) | 1.5 |
| TM5 | Gates: VR re-baseline, contrast × intensity, perf budget đo, contract loop-allowlist | 1 |

Phối hợp: `store.astro`/`store-builder.ts` thuộc builder — chốt ownership với luồng dashboard
như EX; mọi phần storefront tự do. Migration: **0 migration mới** (toàn bộ JSON/attributes).
EX1 cockpit song song không đụng file TM.

## 8. Acceptance

- Mỗi template: checklist "5-giây nhận diện" (signature hoạt động, stack ≥6 khối, knobs sống),
  shop demo fixture chụp trước/sau.
- "Merchant bill of rights" (§1.1) test bằng E2E lite: đổi stack + hero + featured → publish →
  thấy đúng trên storefront fixture.
- Toàn bộ gate §6 xanh.

## 9. Quyết định mở

1. Ratings/reviews: **đề xuất không làm** (chưa có model, tránh giả) — thay bằng testimonials
   shop tự nhập + soldCount thật.
2. Newsletter: v1 copy-email (không backend mới) hay làm endpoint double-opt-in (việc của EX3
   sau)?
3. Marquee/hero-gradient loop: duy nhất 2 ngoại lệ loop như §6 — duyệt?
4. `masters_row` dùng content blocks (ảnh+chữ, không entity người) — đủ cho v1?
5. Drag-drop reorder (đẹp hơn nút mũi tên) — đưa vào TM1 hay để sau khi có feedback?

## 10. Nguồn
- [Shopify — 26 Best Themes 2026](https://www.shopify.com/blog/shopify-themes) · [Customizing store theme](https://www.shopify.com/blog/customizing-store-theme)
- [GemPages — Homepage Customization](https://gempages.net/blogs/shopify/shopify-homepage-customization) · [PageFly — Website Builder 2026](https://pagefly.io/blogs/shopify/shopify-website-builder)
- Xu hướng 2026 đã chiết ở CD-plan (bento/editorial/dopamine/scrollytelling/purposeful motion).
