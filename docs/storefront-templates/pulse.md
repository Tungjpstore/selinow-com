# Pulse — gaming / tech dark (nhóm sản phẩm số)

- **Vertical:** digital · **Scheme:** dark · **Gói:** Pro · **Trạng thái:** TV2
- **Khách hàng mục tiêu (VN):** shop game key, tài khoản, giftcode, acc premium;
  người mua trẻ, quen nền tối, thích cảm giác "khuyến mãi đang chạy, chớp nhoáng".

## Bố cục (trang chủ)

1. Announcement kiểu "deal ticker".
2. Header tối, logo glow nhẹ bằng accent merchant (không neon AI).
3. **Hero flash** — headline lớn + đếm ngược khuyến mãi (flash-sale window) + badge
   "Giao key tự động ≤ 60s" (deliveryText).
4. **Grid catalog dày hơn Swift** (3 cột desktop) — thẻ sản phẩm đậm giá Việt,
   tag -% khi có compare_at.
5. Khối tin cậy: thanh toán PayOS, key mã hóa, đổi/key lỗi hỗ trợ ngay.
6. Footer tối + support rail.

Trang chi tiết: hero sản phẩm tối, key-reveal nổi bật (thành phần KeyRevealCard dùng chung),
section FAQ ngắn. Checkout/orders dùng shell dark nhưng form giữ nguyên trạng thái chuẩn.

## Token & CSS

- `src/styles/storefront/templates/pulse.css`, scope `[data-storefront-template="pulse"]`.
- Nền dùng khoảng ink của token (`--sln-ink-900/800`) — không tạo palette đen mới;
  accent merchant giữ vai highlight; **mọi trạng thái payment/stock vẫn nền sáng cục bộ**
  (chip trắng trên nền tối) để giữ 4.5:1 tuyệt đối.
- `data-template-scheme="dark"` cho `<meta name="theme-color">` tương ứng.

## A11y

- Không dùng màu làm tín hiệu duy nhất cho đếm ngược/khuyến mãi (kèm text).
- Motion: đếm ngược tĩnh khi `prefers-reduced-motion`.
