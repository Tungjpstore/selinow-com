# Craft — barber vintage-industrial (nhóm dịch vụ đặt hẹn)

- **Vertical:** booking · **Scheme:** dark · **Gói:** Pro · **Trạng thái:** TV4
- **Khách hàng mục tiêu (VN):** barbershop, studio tóc nam; khách nam thích chất mạnh,
  đặt nhanh, xem ảnh tác phẩm.

## Bố cục (trang chủ)

1. Announcement giờ cao điểm.
2. Header tối, logo khắc kiểu (font đậm tracking rộng).
3. **Hero 1-chạm** — headline lớn + CTA "Đặt cắt ngay" mở thẳng slot picker; gallery
   ngang ảnh tác phẩm (TV1 media).
4. **Bảng giá barber** — dòng dịch vụ: cắt · gội | xả · uốn … thời lượng + giá, style
   "menu đen chữ trắng".
5. **Thợ barber** — thẻ nhân sự với chuyên môn.
6. Khối quy trình 3 bước.
7. Footer tối.

Trang chi tiết: mô tả + duration + giá + slot picker (như Serenity, skin dark). Checkout
dùng chung form booking; shell dark nhưng trạng thái thanh toán giữ block sáng chuẩn.

## Token & CSS

- `src/styles/storefront/templates/craft.css`; nền ink token như Pulse; điểm khác biệt =
  typography display đậm (weight 800, uppercase, letter-spacing rộng) + viền kẻ đôi mảnh
  (hairline `--sln-border-default` trên nền ink-800); accent merchant cho CTA đặt lịch.

## A11y

- Dark giữ 4.5:1 cho mọi text (ink-100 trên ink-900); gallery ảnh có alt; CTA "đặt ngay"
  là button thật (không chỉ ảnh).
