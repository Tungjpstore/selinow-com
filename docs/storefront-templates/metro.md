# Metro — điện tử / tech retail (nhóm hàng vật lý)

- **Vertical:** physical · **Scheme:** light · **Gói:** Pro · **Trạng thái:** TV3
- **Khách hàng mục tiêu (VN):** shop điện thoại, laptop, phụ kiện; người mua đọc thông
  số, so giá, cần "bảo hành chính hãng", "đổi trả" rõ ràng.

## Bố cục (trang chủ)

1. Announcement vận đơn/khuyến mãi.
2. Header đậm chữ, tìm kiếm nổi bật giữa.
3. **Hero spec** — sản phẩm nổi bật: ảnh + tên + 3 thông số chính + giá khuyến mãi
   (compare_at gạch ngang) + CTA mua.
4. **Ribbon flash sale** — dải ngang các variant đang giảm giá, đếm ngược (tùy chọn,
   tắt khi hết window).
5. Catalog grid 3–4 cột thẻ compact: ảnh + tên + giá + badge "Bảo hành 12T"/"Chính hãng"
   (từ thuộc tính sản phẩm TV3).
6. Khối tin cậy: bảo hành, đổi trả, kiểm máy trước giao.
7. Footer đầy đủ.

Trang chi tiết: **bảng thông số** (spec table từ thuộc tính variant) + gallery + khối mua
sticky; section so sánh nhanh 2–3 sản phẩm cùng loại (tùy chọn, TV3 late). Checkout như
Aurora (địa chỉ + shipping).

## Token & CSS

- `src/styles/storefront/templates/metro.css`; góc vuông hơn (`--sln-radius-sm`), viền rõ,
  nền trắng sạch, accent merchant dành cho giá khuyến mãi & badge; ribbon flash-sale dùng
  `--sln-danger-text`-family đảm bảo tương phản.

## A11y

- Bảng thông số `<table>` ngữ nghĩa; badge là text có nền, không chỉ màu; đếm ngược tĩnh
  khi reduced-motion.
