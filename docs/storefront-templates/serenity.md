# Serenity — spa & làm đẹp (nhóm dịch vụ đặt hẹn)

- **Vertical:** booking · **Scheme:** light · **Gói:** Free · **Trạng thái:** TV4
- **Khách hàng mục tiêu (VN):** spa, tiệm nail, thẩm mỹ viện nhỏ; khách đặt hẹn quan tâm
  không gian yên tĩnh, giá rõ theo thời lượng, chọn kỹ thuật viên.

## Bố cục (trang chủ)

1. Announcement giờ mở cửa / khuyến mãi nhẹ.
2. Header mềm, bo tròn.
3. **Hero booking-first** — headline + mô tả + CTA to "Đặt lịch ngay" cuộn tới menu dịch
   vụ; ảnh không gian (TV1 media).
4. **Menu dịch vụ** — danh sách dịch vụ dạng bảng giá: tên · thời lượng (variant
   duration_minutes) · giá · nút "Đặt".
5. **Chọn kỹ thuật viên** — dải thẻ nhân sự (booking_resources) với vai trò.
6. Khối quy trình đặt: chọn dịch vụ → chọn giờ → thanh toán → xác nhận.
7. Footer pastel + policy.

Trang chi tiết dịch vụ: mô tả + thời lượng + giá + **slot picker** (ngày/hierarchical giờ
theo kỹ thuật viên, API booking slots TV4). Checkout: chọn slot + email + PayOS; sau
thanh toán trang đơn hiển thị booking xác nhận + mã hẹn.

## Token & CSS

- `src/styles/storefront/templates/serenity.css`; bo tròn tối đa (`--sln-radius-pill` cho
  chip), nền `--sln-bg-subtle` pha accent merchant nhạt (tint), shadow rất mềm; heading
  tròn trịa (font-weight 600–700, không uppercase).

## A11y

- Slot picker là radiogroup ngữ nghĩa với label giờ đầy đủ (không chỉ "9:00" cô lập —
  kèm ngày trong accessible name); trạng thái slot hết/chọn có text + màu.
