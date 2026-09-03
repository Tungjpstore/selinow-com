# Kế hoạch thiết kế hoàn thiện toàn màn hình cho 9 template storefront (CD)

Ngày: 2026-08-22 · Trạng thái: **TOÀN BỘ CD0–CD5 ĐÃ TRIỂN KHAI (2026-08-22, hai đợt code — xem
`docs/IMPLEMENTATION_STATUS.md` mục "Storefront Template Completion — CD program", gồm cả CD4
preview theo template và CD5 visual regression 44 baselines + contrast gate VR4)** · Migration
tương ứng là **0107** (không phải 0104 như plan cũ PD — chuỗi migration đã tiến tới 0106).

Quan hệ với tài liệu cũ: kế hoạch này **mở rộng** `DETAIL_UPGRADE_PLAN_2026-08-16.md` (chỉ phủ
trang chi tiết sản phẩm PD/SS/LP/VR) thành **thiết kế đầy đủ hành trình mua cho cả 9 template**:
home · product detail · cart · checkout · payment/order status · order history · safe states.
Mọi quyết định PD0–PD9 trong plan cũ được giữ nguyên và đưa vào pha CD1; tài liệu này không
phục hồi lại các quyết định đã chốt ở đó.

---

## 1. Mục tiêu & phạm vi

**Mục tiêu:** mỗi template không chỉ là "trang chủ đẹp" mà là **một ngôn ngữ thị giác nhất quán
trọn hành trình** từ lúc khách nhìn thấy cửa hàng đến lúc nhận key/nhận hàng/hoàn tất lịch hẹn —
mỗi template một cá tính riêng biệt, đúng chuẩn thiết kế (không phải "hoàn thành thô").

**Phạm vi:**
- Thiết kế chi tiết 9 template × 7 nhóm màn hình (§5.1) + 3 màn hình mới/định hình lại
  (order history, payment-return states, safe states theo template).
- Kiến trúc kỹ thuật đưa template-aware từ 1 màn hình (home) lên toàn hành trình, **không phá
  hợp đồng script của luồng tiền** (cart/quote/checkout/order).
- Roadmap triển khai CD0–CD5 kèm acceptance và verification gate.

**Ngoài phạm vi:** Telegram channel (không bán physical/booking — theo ADR 0023), COD, zone-based
shipping, đổi state machine thanh toán/kho, thêm web font mới (CSP chặn — §4.5).

---

## 2. Hiện trạng (audit 2026-08-22)

### 2.1 Ma trận độ phủ template theo màn hình

| Màn hình | Route | Template-aware? | Ghi chú |
|---|---|---|---|
| Store home | `/` | ✅ Component riêng/9 | Hoàn thiện nhất; vẫn còn placeholder (§2.2) |
| Product detail | `/products/[slug]` | ❌ Markup chung, chưa skin CSS | "Điểm yếu chuyển đổi lớn nhất" — plan PD |
| Cart | `/cart` | ❌ Markup chung, CSS zero coverage | 8 sheet template không có 1 rule nào cho `.cart-*` |
| Checkout | `/checkout` | ❌ Markup chung, CSS zero coverage | Có fieldset shipping/booking ẩn-theo-vertical |
| Payment + Order status | `/orders/[id]` | ❌ Markup chung, CSS zero coverage | Doubles as payment-return landing |
| Order history | *(chưa tồn tại)* | — | Chỉ có URL trực tiếp + email recovery từng đơn |
| 404 / coming-soon / suspended | `/`, fallback | ❌ Shared `.safe-state` | |
| Shell (header/footer/rail) | mọi trang | ⚠️ Chỉ pulse + craft skin nền tối | 6 template còn lại không đụng shell |

### 2.2 Lỗ hổng cấu trúc lớn nhất (xếp theo ảnh hưởng chuyển đổi)

1. **Template tối bị "lai"**: Pulse/Craft đặt `body` tối nhưng card/panel của cart, checkout,
   order, detail vẫn nền sáng cứng (`rgb(255 255 255 / 90%)`, biến `--sln-*` sáng) → khách đi
   từ home tối sang checkout "trắng toát", đứt cảm xúc và gây nghi ngờ tại đúng điểm nhạy cảm
   nhất của luồng tiền.
2. **Zero CSS coverage cho money screens**: greping `checkout|cart-|order-|product-detail|booking|shipping`
   trên 8 sheet template trả về 0 kết quả — cart/checkout/order nhìn y hệt nhau trên 9 template.
3. **Aurora hero không bao giờ render ảnh**: `data-image` được set, CSS chỉ định `background-size`,
   không có gì áp `background-image` → lookbook luôn rơi về gradient fallback.
4. **Bustle `data-deal-count`** được tính và phát ra nhưng không CSS/script nào tiêu thụ.
5. **Category chips trang trí**: `data-store-category-jump` (aurora) và các chip serenity/craft/clinic
   đều trỏ `#products`/`#services`, không lọc thật.
6. **Booking templates mượn i18n key của nhau** (craft/clinic steps = desk steps) — chưa có voice riêng.
7. **Sold-out booking vẫn focusable** (`.is-disabled` + `aria-disabled` nhưng giữ `href`).
8. **Desk plan table** dựa heuristic "sản phẩm đa biến thể đầu tiên" thay vì flag curated.

Danh sách trên là **công việc sửa thật** (không phải style mới) — gom vào pha CD0.

### 2.3 Cơ chế hiện có phải tôn trọng

- Multi-tenant theo **hostname** (`resolveStorefrontShop`), template resolve tại
  `src/lib/storefront/store.ts:256` → `data-storefront-template` trên `<html>`.
- Toàn bộ 9 sheet CSS load chung mọi trang (scoped bằng `html[data-storefront-template=…]`) —
  đây chính là mảnh đỡ để skin money screens mà **không đụng markup**.
- Cart = localStorage `selinow-cart:v1:{host}` + server quote authoritatively
  (`/api/store/cart` → `/api/store/quote`, states `loading/ready/price_changed/item_changed/
  out_of_stock/quote_failed` + expiry countdown).
- Checkout = 1 trang: intent → checkout (`Idempotency-Key`, `quoteEvidence`, Turnstile,
  shipping/booking fieldset) → redirect `/orders/{id}#access=…` (token trong sessionStorage).
- Payment = PayOS redirect qua `/api/store/orders/{id}/payment-link`; `returnUrl/cancelUrl`
  quay về `/orders/{id}?payment=return|cancel` — order page **là** màn hình trạng thái thanh toán.
- Booking: slot picker nằm trong checkout; API `/api/store/booking/slots` có sẵn (tái dùng cho PDP).

---

## 3. Nghiến cứu xu hướng 2026 → định hướng từng template

Tổng hợp từ nghiên cứu 8/2026 (nguồn cuối tài liệu), chiết thành 7 xu hướng dùng được:

| Xu hướng 2026 | Nội dung | Template ứng dụng |
|---|---|---|
| **Premium dark + bento** | Dark mode chuẩn mực cho brand công nghệ; grid bento dày thông tin, dễ scan (aesthetic Vercel/Linear) | **Pulse**, Craft |
| **Editorial / magazine layout** | Hệ typographic cực đại, ảnh lớn kể chuyện, nhịp magazine thay grid vô hồn | **Aurora** |
| **Bold typography làm nhân vật chính** | Chữ là hình ảnh; contrast weight/tracking mạnh, không cần ảnh | Craft, Desk |
| **Minimal + high contrast + speed** | Vẫn là nền tảng conversion; sạch, nhanh, không ma sát | **Swift**, **Clinic** |
| **Dopamine color / urgency engineered** | Màu năng lượng, ribbon deal, countdown, voucher hiển thị trước | **Bustle**, Pulse |
| **Nature distilled / calm wellness** | Thanh lịch tĩnh tại, độ sáng dịu, bo tròn mềm, whitespace hào phóng | **Serenity** |
| **Retro revival / tactile maximalism** | Hairline, serif/mono trộn, bảng giá "vintage", góc vuông, chất liệu cảm tính | **Craft**, Metro (bảng thông số) |

Nghiên cứu checkout (Baymard/LogRocket/Stripe tổng hợp): **one-page checkout giảm ~20% abandonment**
cho cửa hàng SKU ít, mobile-first, người mua lại — đúng profile shop đơn của Selinow →
**giữ kiến trúc 1 trang** (không chuyển multi-step); mỗi template chỉ khác cách *trình bày* cùng
form đó. Order-status page được xem là "post-purchase conversion surface" — thiết kế như màn
hoàn tất cảm xúc + next-action, không phải biên lai khô (§7–15 phần Payment/Order từng template).

---

## 4. Hiến pháp thiết kế (bắt buộc với mọi template)

1. **Protected states bất biến về ngữ nghĩa**: mọi khối trạng thái tiền hàng — giá, tồn kho,
   trạng thái thanh toán/giao hàng/key — luôn đạt **4.5:1**, dùng palette trạng thái chuẩn
   (`--sln-success/-warning/-danger/-info` + tint) trên nền chip sáng, **kể cả trên template tối**
   (tiền lệ Pulse đã làm đúng với stock chips). Template được khác nhau ở *vỏ*, không được khác
   nhau ở *độ an toàn đọc* của thông tin tiền.
2. **Chỉ dùng token `--sln-*` và `--merchant-*`** (ADR 0011/0023). Màu thương hiệu luôn là
   `--merchant-brand/--merchant-accent` (merchant chỉnh được, ink đã clamp contrast); mỗi template
   chỉ được quyết định *cách pha* (nền, độ phủ, gradient trang trí) và **bảng màu fixture**
   (canvas tint, hairline, surface tối…) tự định nghĩa trong sheet của mình nhưng phải qua
   contrast gate VR4.
3. **Hợp đồng hook là bất biến** (§5.3): per-template layout không được đặt lại/missing bất kỳ
   ID/class/data-attr nào script cart/quote/checkout/order/order-access tìm; chỉ được thêm
   wrapper/class trang trí quanh chúng.
4. **Mobile-first 390px, Vietnamese-first**: mọi spec breakpoint gốc 390 → 768 → 1184
   (`--store-page-width`). Copy tiếng Việt là chuẩn; không copy dài > 2 dòng trên mobile.
5. **Không web font mới**: CSP `font-src 'self'`, repo không phân phối font. Khác biệt typography
   đạt bằng: weight (300–800, Inter variable cài sẵn mới render; fallback system an toàn),
   tracking, uppercase, cỡ, và **system-serif/mono stack** (`Georgia/"Times New Roman"/"Noto Serif", serif`
   cho display Aurora; `"JetBrains Mono", ui-monospace…` đã có cho label/ID). Mọi tổ hợp phải giữ
   dấu tiếng Việt rõ (test "Ươưữự ỮỬỰ").
6. **Motion nhẹ 120–240ms** `cubic-bezier(.2,.8,.2,1)`; mọi animation phải có nhánh
   `prefers-reduced-motion` (tiền lệ: countdown tĩnh). Không parallax, không auto-carousel.
7. **Mỗi template đúng 1–2 "khoảnh khắc đặc trưng"** (signature) ở home + 1 ở post-purchase —
   phần còn lại của hành trình là biến tấu tiết chế của cùng ngôn ngữ. Tránh "9 trang chủ,
   1 hành trình mua".
8. **Không phá multi-tenant shell**: header/footer/rail giữ cấu trúc DOM hiện có; template
   skin qua CSS + class modifier (VD `.store-header` nhận thêm biến thể bo góc/giấy/kính).

---

## 5. Hệ màn hình chuẩn & kiến trúc template-aware

### 5.1 Danh mục màn hình (mỗi template phải phủ đủ)

| # | Màn hình | Route | Kiểu aware (§5.2) |
|---|---|---|---|
| S1 | Store home | `/` | Tier A — component dispatch (đã có) |
| S2 | Product/Service detail | `/products/[slug]` | Tier A — component dispatch (PD0–PD9) |
| S3 | Cart / Appointment draft | `/cart` | Tier B — layout wrapper + skin pack |
| S4 | Checkout (pay) | `/checkout` | Tier B — layout wrapper + skin pack |
| S5 | Payment + Order status | `/orders/[id]` | Tier C — skin pack + confirmation module |
| S6 | Order history | `/orders` *(mới)* | Tier C — screen mới + skin pack |
| S7 | Safe states (404/coming-soon/suspended) + empty states | nhiều | Tier C — skin pack |

### 5.2 Kiến trúc 3 tầng

- **Tier A — Component dispatch** (S1, S2): mỗi template có `templates/<id>/StoreHome.astro` và
  `templates/<id>/ProductDetail.astro`; dispatcher `StoreHome.astro` / `Detail.astro` map theo
  `shop.template.id`, fallback swift. Tự do cấu trúc hoàn toàn trong lúc vẫn giữ hook thêm-giỏ-hàng.
- **Tier B — Layout wrapper + skin pack** (S3, S4): giữ nguyên các trang `cart.astro`/`checkout.astro`
  làm **khung dữ liệu**; mỗi template được:
  1. **Skin pack CSS** phủ toàn bộ class hiện hữu (`.checkout-page, .cart-*, .quote-status,
     .shipping-*, .booking-*, .form-status…`) — đây là bắt buộc tối thiểu, giải quyết lỗi "lai"
     dark/light;
  2. **Chrome module** per-template (Astro partial, tùy chọn): dải trust/urgency/editorial note
     đặt trên/dưới form, chỉ trang trí, không chứa input — render theo `shop.template.id`.
  Không tách script, không đổi thứ tự field bắt buộc (email → shipping/booking → summary → pay).
- **Tier C — Skin pack + confirmation module** (S5–S7): markup cấu trúc giữ nguyên; mỗi template
  CSS hóa toàn bộ (`.order-*, .key-card, .download-*, .safe-state, .empty-cart`) + thêm
  **confirmation moment** (thanh trạng thái đầu trang khác nhau về hình thức, cùng nội dung ngữ nghĩa).

**Lý do không Tier A cho S3–S6:** money path có 5 script client với hợp đồng selector chặt
(quote states, idempotency, recovery token, key reveal). Nhân bản layout ×9 = nhân bản rủi ro
lệch hành vi thanh toán. Tier B/C đạt ~90% khác biệt thị giác với 0% rủi ro hành vi. Khi nào có
measured need (research), nâng cấp chọn lọc per template.

### 5.3 Hợp đồng hook (script contract) — kiểm thử tự động sẽ khoanh vùng này

Script hiện tìm: `#catalog-data`, `[data-cart-add]`, `#cart-items` (cart/checkout), `.cart-item*`,
`#quote-status`, `#cart-checkout-link`, `#checkout-form`, `#checkout-email`, `#shipping-fields`,
`#booking-fields`, `.booking-slot*`, `#shipping-methods`, `.cf-turnstile`, `#checkout-submit`,
`#order-view` + các node con `.order-line/.order-timeline/.key-card/.download-card`,
`#product-refresh-status`, `#product-variant-list`, `[data-variant-id]`, slot grid, idempotency
storage keys. → Thêm **render-contract test** kiểu hiện có cho S3–S6: mỗi template × mỗi màn hình
phải chứa đủ danh sách selector trên (grep snapshot SSR) — fail sớm khi một skin pack quên render
hook vì "đẹp hơn".

### 5.4 Ma trận trạng thái chuẩn (thiết kế chung, hóa thân khác nhau per template)

| Trạng thái | Áp dụng | Yêu cầu |
|---|---|---|
| Empty (giỏ rỗng / chưa có đơn / catalog trống) | S3, S6, S1 | 1 minh họa typographic + 1 CTA về home/dịch vụ; cấm dead-end |
| Loading / quote `loading` | S3, S4 | Skeleton shimmer nhẹ hoặc pulse dot; không block UI |
| `price_changed` / `item_changed` / `out_of_stock` | S3, S4 | Chip warning/danger chuẩn (protected), nút hành động rõ (cập nhật/gỡ) |
| Quote expiry countdown | S3, S4 | Mono tabular; hết hạn → cảnh báo + nút làm mới |
| Payment `return` (pending) | S5 | "Đang xác nhận" + auto-refresh; không bao giờ hiển thị "thành công" khi chưa event PayOS hợp lệ |
| Payment `cancel` | S5 | Tạo lại link thanh toán 1 chạm; giữ đơn pending |
| Fulfilled digital: key reveal + downloads | S5 | Khối bảo mật: nút hiện key từng cái một, copy 1 chạm, countdown tự ẩn (nếu giữ hành vi hiện có) |
| Booking confirmed | S5 | Thẻ lịch hẹn: mã hẹn, ngày giờ, dịch vụ, nơi hủy/đổi (hiện chỉ xem — không thêm tính năng mới ngoài plan) |
| Shipping in progress | S5 | Timeline packed→shipped→delivered + địa chỉ + vận đơn |
| Recovery (không có token) | S5, S6 | Form email + Turnstile; trạng thái gửi/xử lý/thành công |
| 404 / coming-soon / suspended | mọi | Safe-state theo cá tính template nhưng giữ nguyên văn + link hỗ trợ |

---

## 6. Hệ token theo template (token layer — việc đầu tiên của CD0)

Mỗi sheet template mở đầu bằng **kho token riêng**, đặt biến cục bộ (prefix `--tmpl-*`) chỉ có
hiệu lực trong scope `html[data-storefront-template="<id>"]`, sau đó mọi rule sau đó chỉ dùng
biến — giúp VR4 quét contrast theo bảng thay vì mò từng declaration:

```css
html[data-storefront-template="pulse"] {
  --tmpl-canvas: #0b1020;        /* nền trang */
  --tmpl-surface: #111830;       /* panel nổi */
  --tmpl-surface-2: #151b2e;     /* input / panel lồng */
  --tmpl-border: #252c43;
  --tmpl-border-strong: #303a58;
  --tmpl-text: #f1f5f9;  --tmpl-text-muted: #cbd5e1;  --tmpl-text-faint: #94a3b8;
  --tmpl-radius-s: 10px; --tmpl-radius-m: 14px; --tmpl-radius-l: 20px;
  --tmpl-shadow: none;           /* dark không đổ bóng, dùng border + glow */
  --tmpl-glow-brand: 0 0 48px rgb(91 92 235 / 26%);
  --tmpl-heading-weight: 750; --tmpl-heading-tracking: -0.045em;
  --tmpl-font-display: var(--sln-font-sans);
  --tmpl-motion: 160ms;
}
```

Nguyên tắc: `--tmpl-*` **không thay** token `--sln-*`/**--merchant-***; nó chỉ là lớp dịch nghĩa
"cảm quan template" áp lên từng phần. Protected states vẫn quy về token chuẩn. Các bảng dưới
đây cho mỗi template là **giá trị mặc định đề xuất**, chốt sau khi chạy VR4 với 6 màu merchant
đại diện.

---

## 7. SWIFT — "Geometric Precision" (digital · light · free · fallback toàn hệ)

**Cảm quan & xu hướng:** minimal + high contrast + speed (xu hướng nền tảng conversion 2026).
Swift là template an toàn mặc định → mọi thử nghiệm thị giác phải hồi về đây được. Người tham
chiếu: Linear app, Stripe docs store, Clerk marketing.

| Token | Giá trị |
|---|---|
| Canvas / Surface | `#f8fafc` / `#fff` + panel gradient `145deg rgba(255,255,255,.78)→rgba(241,245,249,.88)` |
| Ink | `#0b1020` / `#475569` / `#64748b` · hairline `#e2e8f0` |
| Brand | thuần `--merchant-brand` (mặc định `#5b5ceb`); watermark dùng `--sln-brand-gradient` |
| Type | Inter; kicker mono `.75rem/750/.1em` uppercase; h1 `clamp(3rem,6.8vw,6.25rem)` w750 `-.058em`; giá tabular w700 |
| Radius | sm 8 → xl 24 + pill (giữ nguyên thang chuẩn) |
| Shadow | xs–lg thang chuẩn (điểm mốc duy nhất dùng shadow đầy đủ) |
| Motion | 120ms, hover `translateY(-1px)` + shadow-sm (giữ nguyên) |

**Thiết kế từng màn hình:**
- **S1 Home (delta):** giữ hero split + watermark initial; bổ sung: hàng "bento nhẹ" 3 ô
  (instant delivery / bảo hành key / hỗ trợ) dưới catalog khi chưa có discount — tái dùng
  `.pulse-trust-strip` markup dạng trung tính. Category select giữ nguyên.
- **S2 Detail:** PD1 — cấu trúc hiện tại + `Gallery.astro` thay placeholder chữ cái; sticky
  buy block phải (desktop), bottom bar (mobile đã có). Đây là "detail chuẩn" mọi template đo vào.
- **S3 Cart:** thẻ item ngang chuẩn, visual 72px radius-md, tiền mono tabular; summary là panel
  gradient với đường kẻ `summary-row`; quote-status chip inline cạnh tổng.
- **S4 Checkout:** 2 cột desktop (form trái 1.2fr / summary phải .8fr), mobile stack — summary
  thu thành accordion-head (tổng + số item). Trust note dưới nút pay.
- **S5 Order:** panel trắng + timeline dọc chuẩn; key-card kiểu "credential" (nền `--sln-bg-subtle`,
  viền trái brand 3px). Payment-return: banner info ngắn + auto-refresh spinner.
- **S6 History:** danh sách thẻ đơn 2 dòng: mã (mono) + dịch vụ / ngày / tổng / chip trạng thái;
  filter trạng thái dạng segmented control.
- **S7 Safe/empty:** watermark initial lớn mờ đúng ngôn ngữ hero.

**Signature:** gradient watermark initial xuyên suốt (hero → empty cart → safe-state).

---

## 8. PULSE — "Arcade Neon" (digital · dark · premium)

**Cảm quan & xu hướng:** premium dark + bento (aesthetic Vercel/Linear) + dopamine urgency cho
game keys. Người tham chiếu: Razer store, Epic Games store, Vercel/Linear dashboard.

| Token | Giá trị |
|---|---|
| Canvas / Surface / Input | `#0b1020` / `#111830` / `#151b2e` |
| Border | `#252c43`, strong `#303a58` |
| Ink | `#f1f5f9` / `#cbd5e1` / `#94a3b8` |
| Brand | `--merchant-brand/--merchant-accent` dưới dạng **glow radial** (38%/46%) + viền chạy;
  nút chính nền brand đặc (không glow trên chữ) |
| Type | h1 w750 `-.045em`; badge/pill `.8125rem` w650; **giá key w800 tabular** — số là nhân vật |
| Radius | pill cho badge/chip; 14px panel (không xl — dark sạch góc) |
| Shadow | none → glow thay thế: `--tmpl-glow-brand` chỉ trên CTA chính + card hover |
| Protected | stock/payment chips **giữ nền trắng chuẩn** như hiện nay (đúng ADR, giữ nguyên) |

**Thiết kế từng màn hình:**
- **S1 Home (delta):** giữ hero + trust strip; thêm hàng **bento 3 ô** (flash-sale countdown khi
  có promo active — SS; instant delivery progress mini "Pay → Key trong ~30s"; top-up hot list
  4 key từ `products` bán chạy — fallback ẩn). Card hover: viền `--merchant-accent` + glow nhẹ.
- **S2 Detail (PD2):** gallery nền `#0f1526`; khối mua = **"key vault" panel**: giá w800, nút
  "Mua ngay — nhận key tức thì" glow; countdown promo nằm ngay dưới giá (tĩnh reduced-motion);
  nhóm "Phù hợp với: Steam/Epic…" từ attributes nếu có.
- **S3 Cart:** panel `#111830`, item có viền trái brand; summary tiêu đề "Hàng chờ gửi key";
  quote countdown = "Giá khóa còn mm:ss" (vẫn là quote expiry — chỉ đổi label, không đổi logic).
- **S4 Checkout:** form input nền `#151b2e` viền `#252c43`, focus ring `--merchant-accent`;
  Turnstile + nút pay glow; dưới nút: 3 chip trust (PayOS / key mã hóa / hỗ trợ key lỗi) —
  **chip protected nền trắng** nổi trên nền tối đúng quy tắc.
- **S5 Order:** header "Chiến lợi phẩm của bạn"; key-card = vault slot (nền tối, viền
  `--merchant-accent`, nút "Hiện key" → mono w700 chọn-được); timeline giữ chip sáng chuẩn.
  Payment-return pending: vòng pulse quanh icon "đang xác nhận" + auto refresh.
- **S6 History:** bảng thành tích nhẹ — mỗi đơn 1 hàng "match": game (avatar initial) + mã đơn +
  chip trạng thái; fulfilled có nút "Xem key".
- **S7 Safe/empty:** dark + glow; empty cart: "Kho đồ trống trơn" + CTA "Tìm key hot".

**Signature:** key-vault panel (S2/S5) + glow CTA; quote countdown tái đóng khung thành ngôn ngữ game.

---

## 9. DESK — "The Invoice" (digital · light · premium · SaaS/license)

**Cảm quan & xu hướng:** quiet SaaS minimalism, bold-typology tiết chế, bảng số tabular. Người
tham chiếu: Stripe invoicing, Linear pricing, Vercel dashboard billing.

| Token | Giá trị |
|---|---|
| Canvas / Surface | `#f8fafc` / `#fff`; hover row `#f1f5f9` |
| Ink / Border | chuẩn `#0b1020/#475569/#64748b` · `#e2e8f0` (hairline là nhân vật chính) |
| Brand | chỉ chấm chấm: nút + link + số nổi; không gradient, không tint |
| Type | h1 `clamp(2.1rem,4vw,3.4rem)` w740 `-.03em`; **thead uppercase `.75rem/.08em`**;
  mọi số tiền/số lượng `tabular-nums` w700; kicker mono |
| Radius | lg 16 khung lớn, md 12 nút/hàng — không pill (trừ badge bắt buộc) |
| Shadow | chỉ xs; tách bậc bằng hairline |
| Motion | 120ms, không translate |

**Thiết kế từng màn hình:**
- **S1 Home (delta):** giữ hero + plan table (SS: thay heuristic bằng flag "featured" — dùng
  `attributes` label `featured` làm curatorial flag tạm, không migration); steps giữ.
- **S2 Detail (PD3):** 2 cột — trái mô tả + SpecTable (nếu có attributes: số máy, hạn dùng…),
  phải **sticky bảng mua**: mỗi variant 1 dòng (tên plan · slot · giá · nút "Chọn"), dòng chọn
  highlight viền brand; dưới: ghi chú kích hoạt 3 bước (tái dùng steps).
- **S3 Cart:** trình bày **hóa đơn nháp**: item là dòng bảng có số thứ tự mono, cột số lượng
  stepper nhỏ; summary = "Tạm tính" với đường kẻ chấm dẫn (dotted leaders) hairline, tổng có đường kẻ đôi trên.
- **S4 Checkout:** form như "hoàn tất hóa đơn": label trên input nhỏ uppercase; summary phải
  trông như invoice thật (cột Mô tả/SL/Thành tiền); nút pay hình chữ nhật md "Thanh toán &
  phát hành key".
- **S5 Order:** nhìn như **hóa đơn đã phát hành**: header có mã đơn mono lớn + trạng thái stamp
  (chip protected); key-card dạng bảng dòng (key mono + nút copy); timeline = audit log mono
  timestamp. Payment-return: "Chờ đối soát" + auto refresh, giọng văn kế toán.
- **S6 History:** bảng chuẩn: Ngày · Mã đơn · Gói · Tổng · Trạng thái — đúng chất "sổ".
- **S7 Safe/empty:** invoice trống với dòng kẻ + "Chưa có dòng nào"; CTA "Khám phá gói".

**Signature:** ước lệ hóa đơn (dotted leaders, tabular, stamp trạng thái) xuyên S3–S6.

---

## 10. AURORA — "The Editorial" (physical · light · free · thời trang)

**Cảm quan & xu hướng:** editorial/magazine layout 2026 — typographic hierarchy cực đại, ảnh
kể chuyện, nhịp magazine; "exaggerated hierarchy" + museumcore nhẹ. Người tham chiếu: Aesop,
COS, Zara editorial, awwwards fashion collection.

| Token | Giá trị |
|---|---|
| Canvas / Surface | `#fafafa` ấm hơn 1 nấc / `#fff`; ảnh = surface chính |
| Ink / Border | `#141414` gần-đen / `#4a4a4a` / `#8a8a8a` · hairline `#e6e4e0` (ấm) |
| Brand | chỉ ở link/hover/swatch-chọn; CTA chính **đen trắng** (pill trắng nền đen hoặc ngược) |
| Type | **display serif stack**: `Georgia, "Times New Roman", "Noto Serif", serif` cho h1/h2
  (w400–500, tracking `-.01em`, `text-wrap: balance`); body Inter; kicker `.6875rem/.14em`
  uppercase sans; giá w650 |
| Radius | xl 24+ (stage 28) · pill CTA; **border gần như vô hình** (đã đúng spec gốc) |
| Shadow | chỉ md trên sticky-buy; khác biệt bằng khoảng trắng + scrim ảnh |
| Motion | 200ms ease-out; hover ảnh: zoom `scale(1.03)` + fade ảnh thứ hai (SS) |

**Thiết kế từng màn hình:**
- **S1 Home (CD0 bug + delta):** sửa bug `data-image` (script 3 dòng nội bộ set
  `background-image` khi tải — không phụ thuộc markup mới); category pills lọc thật (wire
  `data-store-category-jump` vào `store-search.ts` hiện có); thêm dải "Editor's note" (1 dòng
  mô tả shop + chữ ký chủ shop) giữa lookbook và grid.
- **S2 Detail (PD4):** gallery lớn trái (aspect 4:5, thumbnail dọc) + sticky buy phải: tên serif,
  giá, swatch màu (đổi ảnh theo `product_images.variant_id` khi có — SS) + size chip, tồn kho
  từng biến thể dạng text nhẹ, nút "Thêm vào túi" đen; dưới: mô tả editorial cột hẹp
  (`--store-copy-width`) + bảng size guide từ attributes nếu có.
- **S3 Cart:** tên "Túi đồ"; item = ảnh dọc nhỏ + tên serif + variant text; summary tối giản
  không panel (chỉ hairline); CTA "Thanh toán" đen pill.
- **S4 Checkout:** form 1 cột hẹp giữa trang như thư đặt hàng; summary "Đơn đặt hàng" với ảnh
  thumb dọc; shipping fieldset trình bày như label giao hàng của brand (vẫn là form chuẩn).
- **S5 Order:** "Cảm ơn — đơn của bạn đang được chuẩn bị"; ảnh sản phẩm đầu tiên làm banner mờ
  trên cùng; timeline dọc nhẹ nhàng; shipping card như thẻ vận chuyển typography (địa chỉ +
  mã vận đơn mono).
- **S6 History:** lookbook của các đơn — mỗi đơn 1 khối ảnh/thumbnail + dòng trạng thái.
- **S7 Safe/empty:** chữ serif lớn giữa trang ("Túi của bạn đang trống"); không minh họaEmoji.

**Signature:** serif editorial + tote-flow ("Túi đồ" → thư đặt hàng); hover-đổi-ảnh grid.

---

## 11. METRO — "The Spec Sheet" (physical · light · premium · điện tử)

**Cảm quan & xu hướng:** bento grid dày, high-density scannable, trust-forward; retro bảng thông
số (spec sheet) làm cấu trúc cảm xúc. Người tham chiếu: Apple compare sheet, Anker, BestBuy
listing, bento UI 2026.

| Token | Giá trị |
|---|---|
| Canvas / Surface | `#f8fafc` / `#fff`; hover card `#f8fafc` |
| Ink / Border | chuẩn slate · border `#e2e8f0` **đậm nội dung** (border-forward, không shadow) |
| Brand | nút + tag trạng thái; **success-tint là màu phụ thương hiệu** (✓ `#ecfdf5/#047857`) |
| Type | h1 `clamp(1.9rem,4vw,3rem)` w760; tiêu đề card `.9375rem` w650; **label spec mono `.75rem`**;
  giá w700 tabular `1.0625rem`; micro-label `.6875rem` |
| Radius | sm 8 thẻ / md 12 visual — **nhỏ nhất hệ** (cảm giác máy móc) |
| Shadow | none (border thay thế) |
| Motion | 100ms; chỉ đổi màu viền khi hover |

**Thiết kế từng màn hình:**
- **S1 Home (delta):** trust strip giữ; thêm **bento "Trung tâm thông số"**: 1 ô to (sản phẩm
  có đánh giá/ảnh đẹp nhất) + 4 ô nhỏ (bán chạy, mới về, giảm giá, bảo hành) — mọi ô là ProductCard
  biến thể kích thước, click vào vẫn goto detail; badge "Chính hãng/Bảo hành X tháng" từ
  attributes (SS) hiện trên card.
- **S2 Detail (PD5):** cấu trúc 3 khối ngang: Gallery chuẩn → SpecTable (thead mono uppercase,
  hairline zebra `#f8fafc`) → sticky buy (giá + biến thể + tồn kho + nút); badges hàng đầu;
  "So sánh nhanh 2–3 máy" (bảng cột, chỉ render khi cùng category ≥2 — PD late, tách phase).
- **S3 Cart:** **bảng dòng công nghiệp**: cột Ảnh / Tên+SKU mono / SL stepper / Thành tiền;
  header cột uppercase mono; summary panel viền đậm 2px trên.
- **S4 Checkout:** tách khối rõ: "1. Người nhận → 2. Vận chuyển → 3. Thanh toán" bằng divider
  numbered (vẫn 1 trang, chỉ visual sectioning); shipping method card: tên + mô tả + phí +
  ETA chip; Turnstile + pay.
- **S5 Order:** "Phiếu xuất kho + trạng thái vận chuyển": timeline packed→shipped→delivered với
  icon hộp; địa chỉ + carrier/tracking = bảng phiếu; thất bại hoàn tiền giữ chip protected.
- **S6 History:** bảng dày đúng chất: Mã · Ngày · Sản phẩm · Tổng · Vận đơn · Trạng thái.
- **S7 Safe/empty:** khung viền + icon dây điện minimal; "Không tìm thấy thiết bị nào".

**Signature:** SpecTable + phiếu xuất kho (S5) — bảng mono là nhạc nền của cả template.

---

## 12. BUSTLE — "The Deal Market" (physical · light · premium · chợ online)

**Cảm quan & xu hướng:** dopamine color + urgency engineered + voucher hiển thị trước (2026 ecommerce
trend); năng lượng chợ VN hiện đại. Người tham chiếu: Shopee flash-sale (được tinh chỉnh),
Temu category wall (tinh giản), TikTok Shop vibe (không nhộn nhạo quá).

| Token | Giá trị |
|---|---|
| Canvas / Surface | `#f8fafc` / `#fff` |
| Ink / Border | chuẩn slate · `#e2e8f0` |
| Brand | hero dùng `--sln-brand-gradient` + glow (giữ); accent second = **warning-tint strip**;
  giá deal = danger `#b91c1c` (đã 4.5:1) |
| Type | h1 `clamp(2rem,4.6vw,3.4rem)` w800 `-.04em`; giá so sánh `<del>` luôn đi kèm giá deal;
  micro tabular w700 |
| Radius | xl hero / md card / pill CTA & chip |
| Shadow | sm hover card; ribbon deal không shadow |
| Motion | 160ms; countdown flip nhẹ (tĩnh reduced-motion) |

**Thiết kế từng màn hình:**
- **S1 Home (CD0 + delta):** wire `data-deal-count` — N card đầu tiên nhận class `.is-deal`
  (viền dashed danger + ribbon "GIẢM"); voucher strip (SS) hiển thị ≤3 mã active: chip mã
  (mono) + giá trị + nút copy; khi không có discount → ẩn (không giả).
- **S2 Detail (PD6):** khối giá to nhất hệ (deal w800 `1.375rem` + `<del>` + chip "-X%");
  voucher áp dụng liệt kê dưới giá; spec thu gọn thành details/summary "Thông số"; nút "Chốt đơn".
- **S3 Cart:** mỗi item có dòng "Tiết kiệm" (danger-text) nếu compare-at; summary có **"Tổng
  tiết kiệm"** nổi bật warning-tint; voucher box "Nhập mã" (input mô phỏng — note: hiện chưa có
  promo-code apply ở checkout; v1 chỉ hiển thị discount tự động, input mã đề xuất phase sau —
  flag `CD2-note`).
- **S4 Checkout:** giữ 1 trang; thêm urgency nhẹ trên expiry quote ("Giữ giá thêm mm:ss");
  shipping method card có chip "Nhanh"; tổng + tiết kiệm cùng khối.
- **S5 Order:** "Chốt đơn thành công!"; tracking đơn như theo dõi đơn chợ (timeline to, icon
  rõ); nút "Mua lại" (add-to-cart lại từ order line — tái dùng data-cart-add, không API mới).
- **S6 History:** thẻ đơn dạng "đơn chợ": tổng tiền to + chip tiết kiệm + trạng thái.
- **S7 Safe/empty:** "Chưa chốt đơn nào hôm nay" + CTA "Vào xem deal".

**Signature:** deal ribbon + tổng-tiết-kiệm; countdown giữ-giá ở quote expiry.

---

## 13. SERENITY — "The Calm Ritual" (booking · light · free · spa/làm đẹp)

**Cảm quan & xu hướng:** "Nature distilled"/calm wellness 2026 — sáng dịu, bo tròn mềm,
whitespace hào phóng; cảm giác rituale. Người tham chiếu: Aesop appointment, Soho House
booking, spa listings trên Pinterest wellness 2026.

| Token | Giá trị |
|---|---|
| Canvas / Surface | `#f8fafc` pha ấm `#faf9f7` / `#fff` |
| Ink / Border | `#0b1020`/`#475569`/`#64748b` · `#e8e6e1` (hairline ấm) |
| Brand | accent radial cực nhẹ (22–26%) như hiện có; mọi CTA pill brand |
| Type | h1 w680 `-.025em` (giữ — nhẹ nhất nhì hệ); kicker `.6875rem/.16em`; giá w750;
  **thời lượng dịch vụ là typography chính** (`60 phút` hiển thị như tiêu đề phụ) |
| Radius | **pill toàn tập** — CTA, menu row, chip, input đều bo trọn; card 20px |
| Shadow | none (nền + viền + khoảng cách) |
| Motion | 240ms ease-in-out (chậm nhất hệ); transition màu dịu |

**Thiết kế từng màn hình:**
- **S1 Home (delta):** services menu giữ; thêm "Chuỗi trải nghiệm" 4 bước imagery-text (check-in
  → ritual → care → aftercare); technician card (nếu shop có ảnh đội ngũ — v1 dùng initial avatar
  từ seller name nếu không có ảnh, chỉ hiển thị khi booking theo nhân viên có data — hiện chưa
  có resource-level booking nên **v1 ẩn**, flag phase sau). Categories wire lọc thật theo category.
- **S2 Detail (PD7):** **SlotPickerInline ngay trang dịch vụ**: mô tả + thời lượng + giá ở trên;
  picker ngày (7 ngày cuộn ngang) + giờ theo buổi (Sáng/Chiều/Tối) nhóm radiogroup (a11y: tên
  đầy đủ "Thứ Ba 25/8 · 14:00"); chọn slot → nút "Đặt lịch ngay" mang slot sang checkout
  (prefill `#booking-fields`); sold-out chỉ hiển thị mờ không focusable (sửa lỗi §2.2.7).
- **S3 Cart:** đổi tên "Lịch hẹn của bạn" — 1 thẻ dịch vụ duy nhất (booking cart đơn dịch vụ):
  ảnh/nhạc nền dịu + tên dịch vụ + thời lượng + giá; không qty stepper (ẩn khi đơn dịch vụ);
  CTA "Tiếp tục đặt lịch".
- **S4 Checkout:** 3 nhịp dịu: Lịch (ngày/giõ đã chọn, đổi được qua slot grid) → Email nhận
  xác nhận → Thanh toán; Turnstile + nút pill "Xác nhận & thanh toán".
- **S5 Order:** **thẻ lịch hẹn cảm xúc**: mã hẹn mono, dịch vụ, ngày giờ lớn dịu, trạng thái
  chip; dòng "Hủy/đổi lịch vui lòng liên hệ shop" (đúng giới hạn hiện tại — chưa có self-cancel);
  nút "Thêm vào lịch" xuất file .ics tĩnh từ dữ liệu đơn (client-side, không API mới — đề xuất,
  flag `CD3-ics` quyết định trong pha).
- **S6 History:** "Lịch sử liệu trình": mỗi phiên 1 thẻ mềm, sắp theo ngày, phân nhóm
  Sắp tới / Đã hoàn tất.
- **S7 Safe/empty:** "Hãy bắt đầu ritual đầu tiên của bạn" — chỉ typography + 1 CTA.

**Signature:** SlotPickerInline theo buổi + thẻ lịch hẹn cảm xúc (S5) + .ics (nếu duyệt).

---

## 14. CRAFT — "The Barber Board" (booking · dark · premium · barber/tattoo)

**Cảm quan & xu hướng:** retro revival + tactile maximalism + neubrutalism tiết chế; bảng giá
"biển barbershop" số lượng lớn. Người tham chiếu: barbershop vintage posters, brutalist
portfolio sites, Blind Barber, Fellow Barber.

| Token | Giá trị |
|---|---|
| Canvas / Surface | `#12100d` (near-black ấm) / `#1a1713`; input `#221e18` |
| Border | `#2e2a24` (hairline ấm) — **border là cấu trúc chính, zero radius** |
| Ink | `#f5f1ea` / `#d6d0c4` / `#a39c8d` (cream scale — phải qua VR4) |
| Brand | `--merchant-accent` cho kicker/number/outline button (mặc định `#7c3aed`); CTA chính
  nền brand đặc chữ uppercase |
| Type | h1 **UPPERCASE** w800 `-.04em` (giữ); tiêu đề dịch vụ uppercase w650 `.06em`; giá w750
  tabular; **số bước + năm "EST." mono**; label đỏ vintage chỉ dùng cho danger-state chuẩn
  (không dùng trang trí) |
| Radius | **0 toàn tập** — thẻ, nút, chip, input (pill chỉ cấp phép cho stock-chip protected
  nếu cầnBo tròn bảo vệ hợp đồng — chấp nhận vênh 1 điểm) |
| Shadow | none; phân bậc bằng border 1px + khoảng trắng |
| Motion | 120ms snap (nhanh, khô) |

**Thiết kế từng màn hình:**
- **S1 Home (delta):** hero giữ; services menu giữ hàng hairline; sửa: i18n key riêng
  (`craft.steps.*`, `craft.menu.*` — CD0); mobile giữ cột giá (hiện bị ẩn ≤720px — sửa bằng
  grid 2 hàng thay vì ẩn); thêm footer "EST. {năm tạo shop} · {tên shop}" mono từ data shop
  (không hardcode).
- **S2 Detail (PD8):** gallery ảnh tác phẩm (nền `#1a1713`, ảnh không bo); menu dịch vụ liên
  quan (related cùng category) dạng bảng giá dưới; **booking 1 chạm**: nút "ĐẶT NGAY" cuộn tới
  SlotPickerInline (dùng chung section của serenity nhưng skin vuông vintage); thời lượng +
  giá ở board đầu trang.
- **S3 Cart:** "GHẾ CỦA BẠN" — 1 dịch vụ, khung border đậm, giá dưới cùng như tổng biển quầy;
  không màu Pastel nào.
- **S4 Checkout:** form vuông, label uppercase nhỏ; slot picker ô vuông ký hiệu giờ mono
  (chọn = invert nền brand); nút "XÁC NHẬN" uppercase đặc.
- **S5 Order:** **vé cắt** (ticket): khối border kép 1px, mã hẹn mono đục lỗ (dashed cut-line),
  barber/dịch vụ/giờ; trạng thái chip sáng protected giữ nguyên; feeling "cầm vé chờ tới lượt".
- **S6 History:** sổ ghi khách: hàng mono, ngày + dịch vụ + giá + trạng thái.
- **S7 Safe/empty:** biển "CLOSED"-style typography cho 404/coming-soon; empty lịch: "Ghế trống
  — đặt một chỗ đi".

**Signature:** vé cắt (S5) + bảng giá hairline uppercase + zero-radius hệ thống.

---

## 15. CLINIC — "The Medical Record" (booking · light · premium · y tế/thẩm mỹ)

**Cảm quan & xu hướng:** minimal + high contrast chuẩn y tế, museumcore sạch; "one-accent";
bảng ngữ nghĩa. Người tham chiếu: Mayo Clinic scheduling UI, One Medical, Zocdoc cleanliness,
Notion-like documentation.

| Token | Giá trị |
|---|---|
| Canvas / Surface | `#f8fafc` / `#fff` |
| Ink / Border | chuẩn slate · `#e2e8f0` |
| Brand | **một và chỉ một accent** `--merchant-brand`; không gradient, không promo color,
  không dopamine — warning/danger chỉ xuất hiện trong protected states ngữ nghĩa |
| Type | h1 `clamp(1.9rem,4vw,2.9rem)` w740; thead uppercase mono `.75rem/.08em`; nhãn form
  uppercase nhỏ; mọi số liệu (giá, thời lượng, mã) mono tabular |
| Radius | sm 8 / md 12 / lg 16 — chữ nhật nghề nghiệp (không pill) |
| Shadow | none → phân bậc bằng border |
| Motion | 100ms; chỉ feedback màu, không di chuyển |

**Thiết kế từng màn hình:**
- **S1 Home (delta):** giữ hero + services table + process; thêm khối "Thông tin phòng khám"
  (giờ mở của từ shipping/policy? chưa có data giờ mở — **v1 dùng policy panel hiện có**,
  giờ mở flag phase sau `CD2-clinic-hours`); i18n riêng `clinic.process` (CD0).
- **S2 Detail (PD9):** layout "hồ sơ dịch vụ": tiêu đề + khoa (category) + thời lượng + giá
  trên cùng; SpecTable từ attributes (chỉ định/chống chỉ định/dụng cụ…) — chỉ render khi có
  data; process 3 bước; SlotPickerInline **lịch sự**: ngày dạng dải lịch monospace, giờ ô
  chữ nhật, không gam khuyến mãi; nút "Đặt lịch khám".
- **S3 Cart:** "Phiếu hẹn" — khung 1 trang giống phiếu khám: dịch vụ, thời lượng, giá; CTA
  chữ nhật "Tiếp tục".
- **S4 Checkout:** form nhãn rõ từng phần (THÔNG TIN LIÊN HỆ / THỜI GIAN HẸN / THANH TOÁN),
  divider hairline; Turnstile; nút "Xác nhận & thanh toán".
- **S5 Order:** **phiếu khám**: mã hẹn mono lớn, dịch vụ + ngày giờ trong khung bảng 2 cột
  (Nhãn/Giá trị); trạng thái chip chuẩn; ghi chú "Mang theo mã hẹn khi đến"; timeline y tế
  tiết chế.
- **S6 History:** "Sổ theo dõi": bảng chronological mono, mỗi phiên một hàng có nút xem phiếu.
- **S7 Safe/empty:** "Chưa có lịch hẹn nào được ghi nhận" + CTA; icon âm thanh im lặng (không
  emoji màu mè).

**Signature:** phiếu khám 2 cột Nhãn/Giá trị + mono-tabular toàn hệ số liệu.

---

## 16. Màn hình mới & định hình lại

### 16.1 Order history `/orders` (mới — S6)

- **Trang:** `/orders.astro` — form email + Turnstile → POST lookup → danh sách đơn của email
  đó trên shop này (masked: mã đơn, ngày, dịch vụ/sản phẩm rút gọn, tổng, chip trạng thái);
  click một đơn → chuyển `/orders/{id}` và kích hoạt luồng recovery có sẵn (gửi access token
  qua email) — **không** trả token ngay tại trang danh sách.
- **API mới:** `GET/POST /api/store/orders/lookup` (email + turnstile + rate-limit theo IP×email,
  trả tối đa 20 đơn gần nhất, chỉ summary không chứa key/link tải). Ràng buộc an toàn: không
  xác nhận email tồn tại (response đồng nhất), audit log giống recovery hiện có. **Cần review
  bảo mật trước khi làm** (nằm trong checklist release-guard: API mới phải cập nhật bảng
  allow-list nếu ảnh hưởng invariant).
- **Header:** thêm link "Đơn của tôi" cạnh giỏ (icon receipt) — mọi template, label i18n.
- Per-template presentation đã_spec §7–15 (S6 từng template).
- **Phân phối:** phase CD3, sau khi skin pack các màn hình hiện có ổn định.

### 16.2 Payment-return states (định hình lại S5)

`?payment=return` → state "Đang xác minh thanh toán" (auto-refresh polling, tối đa 60s, sau đó
hiển thị nút làm mới thủ công + lời khuyên kiểm tra); `?payment=cancel` → state "Thanh toán chưa
hoàn tất" + nút "Thử lại thanh toán" (tạo link mới). Về hình thức mỗi template hóa thân theo
spec §7–15; về logic 100% tái dùng order.ts + payment-link API (chỉ thêm param handling đã có
sẵn trong URL).

### 16.3 Safe states theo template (S7)

`.safe-state` nhận skin pack từng template (hiện chỉ nền trắng chung): Pulse/Craft nền tối +
glow/biên; Aurora serif; Metro khung viền; Serenity pill; Clinic hồ sơ; Bustle chữ deal;
Swift watermark. Coming-soon giữ nguyên copy ngữ nghĩa + countdown nếu có (không thêm data mới).

---

## 17. Roadmap triển khai (CD0 → CD5)

Nguyên tắc: **CD0 sửa lỗi thật trước khi tô vẽ**; CD1 kế thừa nguyên PD plan cũ; mỗi phase
chốt bằng gate `check → lint → test → build → deploy:dry-run` + visual (khi có baseline).

| Phase | Nội dung | Ước lượng | Phụ thuộc |
|---|---|---|---|
| **CD0 — Nền & sửa lỗi** | Token layer `--tmpl-*`/9 sheet; dark-flow completion Pulse/Craft (body→panel/input/quote/turnstile đủ tối, protected chip giữ sáng); sửa Aurora `data-image`; wire `data-deal-count` + `data-store-category-jump`; sold-out booking bỏ focus; i18n key riêng craft/clinic; render-contract test cho hook §5.3 | ~1 phiên | ownership template từ luồng dashboard |
| **CD1 — Detail theo template** | PD0 (dispatcher `Detail.astro`, data enrichment, migration 0104 `attributes_json`, 6 sections dùng chung) → PD1–PD9 đúng bảng plan cũ; SS rải vào (countdown, voucher chip, swatches, spec table, badges, related) | ~3–4 phiên | CD0 |
| **CD2 — Skin money screens** | Skin pack S3/S4/S5 cho 9 template theo spec §7–15; chrome module tùy chọn (trust strip checkout Pulse, dotted leaders Desk…); ma trận trạng thái §5.4 áp đủ | ~2–3 phiên | CD0 (CD1 chạy song song khác file) |
| **CD3 — History & payment UX** | `/orders` + lookup API (review bảo mật trước); payment-return states; header "Đơn của tôi"; `.ics` Serenity (quyết định trong pha); `CD2-note` voucher input & clinic-hours quyết định | ~1–2 phiên | CD2 |
| **CD4 — Builder preview** | LP1–LP3 plan cũ + mở rộng preview sang cart/detail mini-render (server trả đủ render một lần) | ~1 phiên | CD1/CD2 xong đủ template |
| **CD5 — Visual regression & gate** | VR1–VR4 plan cũ + mở rộng routes chụp thêm cart/checkout/order/history đại diện 3 vertical × 3 scheme; contrast gate quét `--tmpl-*`; cập nhật `docs/IMPLEMENTATION_STATUS.md` | ~1 phiên | CD1–CD3 |

**Điều kiện khởi động** (giống plan cũ): owner xác nhận luồng dashboard đã trả ownership file
template; checkout trên `storefront-templates` đã được hoàn trả và cây thư mục sạch sau khi luồng khác mượn;
chốt ownership `store.astro/store-builder.ts` (chỉ chạm preview pane ở CD4).

**Rủi ro & kế hoạch:** (a) baseline visual nhạy font máy → chốt 1 máy capture, ghi README
baselines; (b) lookup API là bề mặt rủi ro spam → rate-limit + Turnstile + response đồng nhất,
review bảo mật bắt buộc; (c) nhân bản skin pack dễ lệch trạng thái → render-contract test +
matrix trạng thái làDefinition of Done từng template; (d) serif system stack trên Windows
(Times New Roman) kém đẹp hơn Georgia → chấp nhận degradation grace, VR chụp trên 2 stack.

---

## 18. Acceptance — "thiết kế chuẩn chỉnh" đo bằng gì

Mỗi template được gọi là **hoàn thiện** khi và chỉ khi:

1. 7 nhóm màn hình S1–S7 đều mang đúng ngôn ngữ template (đối chiếu checklist spec §7–15) —
   xác nhận bằng bộ chụp screenshot 9 shop fixture (VR1) tại 390/768/1440.
2. Render-contract test §5.3 xanh cho mọi template × S3–S6 (đủ hook, đủ trạng thái §5.4).
3. Contrast gate VR4 qua với 6 màu merchant đại diện (4.5:1 body, 3:1 large/UI).
4. Luồng tiền hành vi đồng nhất: quote states, idempotency, recovery, key reveal hoạt động
   như trước trên cả 9 template (test unit hiện có không đổi kết quả).
5. Dark templates (Pulse/Craft): không còn panel sáng "lạc quẻ" ngoài protected chips.
6. Không còn mục §2.2 nào tồn tại (mỗi mục có ticket trong phase tương ứng).
7. Mobile 390px: không tràn ngang, CTA chính luôn trong thumb zone, số tiền không xuống dòng.

---

## 19. Quyết định mở (chờ owner)

1. `.ics` cho Serenity/Clinic booking (client-side) — làm ở CD3 hay để sau?
2. Voucher input "Nhập mã" ở checkout Bustle — chỉ hiển thị (v1) hay xây promo-code apply
   (cần backend mới, đề xuất để sau CD5)?
3. Serenity technician cards — ẩn đến khi có resource-level booking (đồng ý ẩn v1?).
4. Aurora serif stack chấp nhận degradation Windows (Times New Roman) hay giữ toàn Inter?
5. Thứ tự ưu tiên CD2 nếu thiếu ресурс: đề nghị pulse/aurora/metro trước (premium + free
   flagship physical), desk/bustle sau, booking skins cuối (vì checkout booking đã ổn).

---

## Nguồn nghiên cứu xu hướng (tra cứu 2026-08-22)

- [Figma — Top Web Design Trends 2026](https://www.figma.com/resource-library/web-design-trends/)
- [Wix — 11 Biggest Web Design Trends of 2026](https://www.wix.com/blog/web-design-trends)
- [Design Studio UI/UX — Ecommerce Web Design Trends 2026](https://designstudiouiux.com/blog/ecommerce-web-design-trends/)
- [PapaThemes — Ecommerce Design Trends 2026](https://papathemes.com/blog/ecommerce-design-trends-2026-bigcommerce-store/)
- [HaloThemes — 8 eCommerce Design Trends](https://halothemes.net/blogs/shopify/)
- [Awwwards — Best Fashion Websites](https://www.awwwards.com/websites/fashion/)
- [We Make Websites — Luxury fashion ecommerce case studies](https://www.wemakewebsites.com/blog/18-luxury-fashion-brands-with-beautifully-designed-websites)
- [Checkout Page — One page checkout 2026](https://checkoutpage.com/blog/one-page-checkout)
- [Digital Applied — eCommerce Checkout Optimization UX 2026](https://www.digitalapplied.com/blog/ecommerce-checkout-optimization-2026-ux-guide)
- [Stripe — One-page vs multi-step checkout](https://stripe.com/in/resources/more/one-page-checkout-vs-multistep-checkout)
- [LogRocket — Designing a seamless checkout flow](https://blog.logrocket.com/ux-design/designing-seamless-checkout-flow/)
- [PageFlows — E-Commerce post-purchase best practices](https://pageflows.com/resources/e-commerce-checkout-best-practices/)
- [BigCommerce — Checkout Optimization 2026](https://www.bigcommerce.com/articles/ecommerce/checkout-optimization/)
