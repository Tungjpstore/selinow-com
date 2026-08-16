# Bustle — chợ online rực rỡ (nhóm hàng vật lý)

- **Vertical:** physical · **Scheme:** light · **Gói:** Pro · **Trạng thái:** TV3
- **Khách hàng mục tiêu (VN):** shop đại chúng giá cạnh tranh (chợ online vibe Shopee/
  TikTok Shop); người mua thích voucher, flash sale, lưới dày, giá to đỏ.

## Bố cục (trang chủ)

1. Announcement voucher ("Nhập mã FREESHIP…").
2. Header gọn + ô tìm kiếm to + giỏ hàng nổi bật.
3. **Hero banner kép** — 2 banner khuyến mãi cạnh nhau (ảnh shop hoặc gradient token).
4. **Dải voucher** — chip voucher claim-styled (hiển thị, claim flow là TV late).
5. **Flash sale + đếm ngược** — hàng ngang sản phẩm giảm giá, giá to màu khuyến mãi.
6. **Catalog dày** — 4–5 cột desktop, thẻ nhỏ, giá VND đậm, tag "-xx%".
7. Footer gọn.

Trang chi tiết: compact, giá + khuyến mãi nổi đầu, spec thu gọn, đánh giá 5 sao
(placeholder hiển thị khi chưa có dữ liệu review — chỉ UI, không fake số liệu: hiển thị
"Chưa có đánh giá"). Checkout như Aurora.

## Token & CSS

- `src/styles/storefront/templates/bustle.css`; màu sắc rực nhưng **từ token**: giá khuyến
  mãi dùng nhóm danger/tint-red đảm bảo 4.5:1, voucher chip nền `--sln-tint-warning` +
  ink đậm; density cao nhưng giữ hit-target ≥ 44px mobile.

## A11y

- Mật độ cao không làm giảm hit-target; badge khuyến mãi kèm text; không animate liên
  tục (chỉ đếm ngược tĩnh reduced-motion).
