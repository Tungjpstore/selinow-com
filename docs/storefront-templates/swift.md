# Swift — mặc định nhóm sản phẩm số

- **Vertical:** digital · **Scheme:** light · **Gói:** Free · **Trạng thái:** TV0 (đang chạy)
- **Khách hàng mục tiêu (VN):** shop bán key phần mềm/copyright phổ thông; người mua cần
  cảm giác tin cậy, nhanh, "giao key ngay sau thanh toán".

## Bố cục

Chính là storefront hiện tại được chính thức hóa thành template (không thay đổi hình ảnh):

1. **Announcement bar** (nếu có) — nền `--merchant-accent`, ink tự tương phản.
2. **Header** — logo (chữ cái đầu nếu chưa có), nav Sản phẩm / Hỗ trợ / Giỏ hàng.
3. **Hero** — kicker tên shop + headline + mô tả + ô tìm kiếm + CTA cuộn xuống catalog.
4. **Catalog** — heading + đếm số sản phẩm + lọc danh mục; lưới thẻ sản phẩm 2 cột
   (1 cột mobile), placeholder chữ cái khi chưa có ảnh (TV1 sẽ bật ảnh).
5. **Support rail + footer** — liên hệ, policy links, powered by Selinow.

Trang chi tiết: variant radio + giá + nút thêm giỏ hàng (giữ nguyên). Checkout: email-only.

## Token & CSS

- Không cần sheet riêng ở TV0 — dùng trực tiếp `src/styles/storefront.css` (scope
  `[data-storefront-template="swift"]` thêm vào khi template thứ hai xuất hiện ở TV2).

## A11y

- Đã qua gate hiện tại: skip-link, focus rings, contrast 4.5:1, reduced-motion.
