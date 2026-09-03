# Storefront template system — đặc tả 9 template theo 3 vertical

Hệ thống template storefront (chương trình TV, TV0 = nền tảng). Mỗi shop chọn một template
trong Store Builder (`/app/store` → tab "Mẫu giao diện"); selection persist trong
`shop_settings.storefront_json.templateId` theo luồng draft→publish sẵn có (migration 0029),
cache Cloudflare tự invalidating qua `published_version`.

## Kiến trúc

- **Registry:** `src/lib/storefront/templates.ts` (code-defined, không DB). Unknown /
  not-yet-available / premium-missing-entitlement → fallback an toàn về `swift` khi render.
- **Gating premium:** `plans.feature_flags_json.premiumStorefrontTemplates` (Pro = true).
  Validate cả ở PATCH settings lẫn render-time fallback.
- **Render:** `StorefrontLayout.astro` gắn `data-storefront-template` / `data-template-scheme`
  / `data-storefront-vertical` trên `<html>`; trang chủ dispatch qua
  `src/components/storefront/templates/StoreHome.astro` (map id → component).
- **CSS:** mỗi template một sheet `src/styles/storefront/templates/<id>.css`, scope
  `[data-storefront-template="<id>"]`, chỉ tiêu thụ token `--sln-*` + `--merchant-*`
  (ADR 0011 — brand không được phá semantic states; WCAG AA 4.5:1 là gate phát hành).

## Danh sách template

| Template | Vertical | Scheme | Gói | Trạng thái | Đặc tả |
|---|---|---|---|---|---|
| Swift | digital | light | Free | TV0 (mặc định hiện tại) | [swift.md](./swift.md) |
| Pulse | digital | dark | Pro | TV2 | [pulse.md](./pulse.md) |
| Desk | digital | light | Pro | TV2 | [desk.md](./desk.md) |
| Aurora | physical | light | Free | TV3 | [aurora.md](./aurora.md) |
| Metro | physical | light | Pro | TV3 | [metro.md](./metro.md) |
| Bustle | physical | light | Pro | TV3 | [bustle.md](./bustle.md) |
| Serenity | booking | light | Free | TV4 | [serenity.md](./serenity.md) |
| Craft | booking | dark | Pro | TV4 | [craft.md](./craft.md) |
| Clinic | booking | light | Pro | TV4 | [clinic.md](./clinic.md) |

## Nguyên tắc chung (every template)

- Giữ "Soft Precision Commerce": dark không làm chủ đạo toàn hệ (chỉ Pulse/Craft);
  không neon AI generic; không hiệu ứng canh tranh với trạng thái thanh toán/đơn.
- Protected semantic states (thanh toán, tồn kho, key reveal) luôn đạt 4.5:1 kể cả trên
  scheme dark; announcement dùng `--merchant-accent-ink` tự tính tương phản.
- Trang cart / checkout / orders dùng chung khung + form theo vertical; template chỉ
  khác shell + trang chủ + trang chi tiết sản phẩm/dịch vụ.
- Mobile-first 390px không cuộn ngang; mọi template tái dùng section dùng chung trong
  `src/components/storefront/sections/` (search, policy, abuse dialog, support rail).
- Copy tiếng Việt trước (copy deck `vi-VN.json`), key i18n prefix `storefront.template.*`.
