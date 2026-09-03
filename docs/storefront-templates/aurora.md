# Aurora — thời trang editorial (nhóm hàng vật lý)

- **Vertical:** physical · **Scheme:** light · **Gói:** Free · **Trạng thái:** TV3
- **Khách hàng mục tiêu (VN):** shop quần áo/giày/túi hướng premium, Gen Z–millennial;
  người mua quyết định bằng hình ảnh, không thích cảm giác "chợ".

## Bố cục (trang chủ)

1. Announcement tối giản (text nhỏ, không nền màu mạnh).
2. Header trong suốt khớp hero, chữ logo to.
3. **Lookbook hero** — ảnh lớn (banner ảnh shop, TV1 media) full-bleed + headline
   editorial mỏng + 1 CTA duy nhất.
4. **Catalog grid ảnh** — 2–3 cột, thẻ sản phẩm ảnh-to-chữ-nhỏ, hover đổi ảnh thứ 2
   (nếu có), swatch màu/size hiển thị dạng chấm (từ options variant).
5. Bộ sưu tập/danh mục dạng dải chip cuộn ngang.
6. Khối "chính sách mua sắm" (đổi trả 7 ngày, freeship ngưỡng — từ shipping methods TV3).
7. Footer tối giản.

Trang chi tiết: gallery ảnh trái + sticky mua bên phải (chọn màu/size bằng swatch, input
số lượng, tồn kho theo variant), section mô tả mở rộng. Checkout: + form địa chỉ VN +
chọn phương thức shipping (TV3).

## Token & CSS

- `src/styles/storefront/templates/aurora.css`; bo góc lớn hơn (`--sln-radius-xl`), typo
  heading mỏng/capatallize nhẹ; khoảng trắng nhiều; viền thẻ gần như vô hình
  (`--sln-border-subtle`).

## A11y

- Swatch màu có tên màu trong `aria-label` + text; ảnh đều có alt mô tả (seller nhập).
- Hover-đổi-ảnh có fallback không-hover (ảnh đầu vẫn hiển thị).
