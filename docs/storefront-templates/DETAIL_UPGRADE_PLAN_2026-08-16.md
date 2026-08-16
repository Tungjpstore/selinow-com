# Kế hoạch đợt nâng cấp chi tiết template (PD/SS/LP/VR)

Ngày: 2026-08-16 · Branch đích: `storefront-templates` · Trạng thái: **CHỜ TRIỂN KHAI**
(đợi luồng dashboard nhận chuyển giao template xong — có signal từ owner mới bắt đầu).

Phạm vi: trang chi tiết sản phẩm theo template · các section đặc thù còn thiếu ·
live preview theo template trong Store Builder · visual regression cho 9 template.

## 0. Hiện trạng (khảo sát 2026-08-16)

- `src/pages/products/[slug].astro` (107 dòng): **1 layout dùng chung cho mọi template** —
  placeholder chữ cái (chưa render ảnh dù TV1 đã có ảnh), radio variant, số lượng, trust list,
  policy panel. Đây là điểm yếu chuyển đổi lớn nhất hiện tại.
- Data sẵn có dùng được ngay, KHÔNG cần migration:
  - `discounts` (0007): `type` percentage/fixed, `value`, `starts_at`/`ends_at`, `status`
    → Pulse countdown + Bustle voucher chips bind data thật.
  - `product_variants.options_json` → swatch màu/size (Aurora).
  - `product_images` (0101) → gallery + hover-đổi-ảnh (cần mở projection từ "ảnh đầu"
    sang **danh sách ảnh**).
- Cần thêm mới (1 migration duy nhất, dự kiến `0104`):
  - `products.attributes_json TEXT` (mảng `{label, value}`) → bảng thông số Metro/Clinic.
  - (Tùy chọn) `product_images.variant_id` đã có sẵn cột — chỉ cần dùng cho ảnh theo màu.

## 1. PD — Trang chi tiết sản phẩm theo template

### PD0 — Nền detail (làm trước, mọi template hưởng)
1. **Dispatcher detail**: `src/components/storefront/templates/Detail.astro` — map
   `shop.template.id → templates/<id>/ProductDetail.astro` (mirror pattern StoreHome),
   fallback swift.
2. **Data enrichment** trong `getStorefrontProduct`:
   - `images: string[]` (tất cả ảnh active theo sort_order, thay vì chỉ `imageUrl` đầu).
   - `attributes: {label, value}[]` từ `attributes_json`.
   - `promo: { code, type, value, endsAt } | null` — discount active có `ends_at` gần nhất.
   - `related: StorefrontProduct[]` — cùng category, tối đa 4, loại chính nó.
3. **Migration 0104** (additive): `ALTER TABLE products ADD COLUMN attributes_json TEXT`
   + CHECK `json_valid` + seller API PATCH product nhận `attributes` (parse mảng ≤ 20 dòng,
   mỗi dòng label ≤ 40 / value ≤ 120 ký tự) + editor UI nhập cặp label–value.
4. **Sections dùng chung** (tái dùng giữa template, đặt ở
   `src/components/storefront/sections/`): `Gallery.astro` (ảnh chính + thumbnail +
   keyboard nav), `Swatches.astro` (options_json → dot màu/chip size, accessible label
   đầy đủ), `SpecTable.astro` (`<table>` ngữ nghĩa), `PromoCountdown.astro` (tĩnh khi
   `prefers-reduced-motion`), `RelatedGrid.astro`, `SlotPickerInline.astro` (wrap slot
   picker cho service, dùng API slots có sẵn).

### PD1–PD9 — Layout detail từng template (theo spec đã duyệt)

| # | Template | Layout detail chính |
|---|---|---|
| 1 | swift | Hiện tại + Gallery thay placeholder, giữ cấu trúc chuẩn |
| 2 | pulse | Dark shell, Gallery tối, **khối key-reveal/mua nổi bật**, countdown nếu có promo |
| 3 | desk | 2 cột: mô tả trái + **sticky khối mua phải** (bảng variant dòng, giá tabular) |
| 4 | aurora | **Gallery lớn + thumbnail, swatch màu/size**, sticky mua phải, mô tả editorial mở rộng |
| 5 | metro | **SpecTable từ attributes**, badge "Bảo hành/Chính hãng" (từ attributes có label đặc thù), Gallery chuẩn |
| 6 | bustle | Compact, giá + giảm giá to (danger-tint), spec thu gọn, voucher chip áp dụng |
| 7 | serenity | **SlotPickerInline ngay trang dịch vụ** (chọn giờ → thẳng checkout), thời lượng + giá nổi |
| 8 | craft | Dark, gallery ảnh tác phẩm, menu dịch vụ related, booking 1 chạm |
| 9 | clinic | Bảng dịch vụ ngữ nghĩa + quy trình + slot picker lịch sự, không màu khuyến mãi |

Nguyên tắc: mọi trạng thái mua/thanh toán giữ block sáng chuẩn (protected states);
không duplicate logic cart — các section chỉ trình bày, dữ liệu & guards đi qua
API/storefront hiện có.

## 2. SS — Sections đặc thù còn nợ (rải vào PD, tổng hợp ở đây)

| Section | Data nguồn | Ghi chú |
|---|---|---|
| Countdown flash-sale (Pulse) | `discounts.ends_at` active | Tĩnh khi reduced-motion; hết window → ẩn, không render số 0 |
| Voucher chips (Bustle) | `discounts` active (≤3) | Hiển thị mã + giá trị; claim flow = copy mã (không có state mới) |
| Swatch màu/size (Aurora) | `options_json` | Chọn swatch ↔ chọn variant (map key `color`/`size` nếu có) |
| Hover-đổi-ảnh (Aurora) | `images[1]` | Ảnh đầu vẫn hiển thị khi không hover / thiết bị cảm ứng |
| Spec table (Metro/Clinic) | `attributes_json` (PD0.3) | Seller nhập qua editor; chỉ render khi có dữ liệu |
| Badge bảo hành (Metro) | `attributes_json` label đặc thù | Ví dụ label `Bảo hành` → render badge |
| Related products (Aurora/Metro/Craft) | cùng category | Tối đa 4, dùng ProductCard của chính template đó |

## 3. LP — Live preview theo template trong Store Builder

1. **LP1 — Preview surface theo template**: preview pane (`/app/store`) render qua
   component preview theo `templateId` draft: server SSR mini-render
   (`StorefrontPreviewCard` mở rộng thành `TemplatePreview.astro` per template —
   hero + 2–3 thẻ sản phẩm theo đúng ngôn ngữ thị giác template). Đổi lựa chọn template
   → client đặt `data-preview-template` + swap DOM từ JSON payload các mini-render
   (server trả đủ 9 render một lần, client chỉ toggle hidden — không round-trip).
2. **LP2 — Thumbnail gallery thật**: wireframe CSS hiện tại → dùng chính mini-render
   thu nhỏ (thuần CSS scale, không iframe) cho 9 thẻ trong tab Template.
3. **LP3 — Device breakpoints**: giữ nút desktop/tablet/mobile hiện có, áp lên
   mini-render; kiểm tra 390px không tràn ngang.
4. Phối hợp luồng dashboard: họ đang nhận template stream — **họ sở hữu**
   `store.astro`/`store-builder.ts` nếu đang sửa; điểm chạm duy nhất của ta là thêm
   component `TemplatePreview.astro` + dataset. Chốt ownership trước khi bắt đầu.

## 4. VR — Visual regression cho 9 template

1. **VR1 — Fixture**: mở rộng seed local hiện có: **9 shop fixture, mỗi shop 1 template**
   (seed SQL đặt `storefront_json.templateId` + catalog mẫu: 1 sản phẩm có ảnh, 1 service
   có duration, 1 discount active có ends_at). Route spec thêm dimension template.
2. **VR2 — Routes chụp**: mỗi template × {home, product detail} + 1 bộ checkout
   physical (address form) + 1 bộ checkout booking (slot picker) trên template đại diện
   (aurora/serenity). Viewport chuẩn đang có (1440/768/390/200%).
3. **VR3 — Baselines**: capture lần đầu trên máy dev (playwright), lưu
   `tests/visual/*-snapshots`; CI/staging gate so sánh; fail khi diff > ngưỡng hiện có.
4. **VR4 — Contrast gate (tăng cường ADR 0011)**: script chạy quét cặp màu
   text/background thực dụng qua 9 sheet template với 6 màu merchant đại diện
   (trắng/đen/trung tính/brand sáng/tối) — fail khi < 4.5:1 ngoài vùng protected-states
   đã định nghĩa.

## 5. Thứ tự &_DEPENDENCIES

```
PD0 (dispatcher + data + migration 0104 + sections dùng chung)
 └→ PD1–PD9 (chi tiết 9 template; swift/pulse/desk trước — verify kiến trúc,
     sau đó aurora/metro/bustle, cuối serenity/craft/clinic cần SlotPickerInline)
SS rải vào PD (mỗi section hoàn thành trong template dùng nó)
LP1–LP3 song song với PD (khác file, chỉ chạm Store Builder preview pane)
VR1 sau PD0 (fixture cần data mới), VR2–VR4 chạy sau khi PD xong từng template
```

Gate mỗi mốc con: `npm run check` → `lint` → `test` → `build` → `deploy:dry-run`;
VR bổ sung `test:visual:*` khi có baseline.

## 6. Ước lượng & rủi ro

- PD0: ~1 phiên làm việc (dispatcher + migration + API attributes + 6 sections).
- PD1–PD9: mỗi template ~⅓–½ phiên (swift/desk nhanh, aurora/metro nặng gallery+spec).
- LP: ~1 phiên. VR: ~1 phiên (chủ yếu fixture + baseline + dò ổn định).
- Rủi ro chính: (a) checkout/orders pages vẫn shell dùng chung — chỉ tinh chỉnh CSS
  theo template, không đổi cấu trúc form; (b) đổi `getStorefrontProduct` projection
  ảnh-danh-sách phải giữ tương thích `imageUrl` cho card; (c) baseline visual nhạy
  font/máy — chốt trên 1 máy capture và ghi trong README baselines.

## 7. Điều kiện khởi động

1. Owner báo luồng dashboard đã xong phần nhận template.
2. `git checkout storefront-templates` + rebase nếu dashboard stream merge về nhánh gốc.
3. Chốt ownership file với luồng dashboard (Store Builder pane vs template components).
