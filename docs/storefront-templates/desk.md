# Desk — phần mềm văn phòng / B2B (nhóm sản phẩm số)

- **Vertical:** digital · **Scheme:** light · **Gói:** Pro · **Trạng thái:** TV2
- **Khách hàng mục tiêu (VN):** shop bán license Office/Windows/Canva/antivirus cho
  doanh nghiệp nhỏ & freelancer; người mua so sánh gói, cần hóa đơn và hướng dẫn kích hoạt.

## Bố cục (trang chủ)

1. Header sáng gọn, logo + nav rõ.
2. **Hero sản phẩm** — headline giá trị ("License chính hãng, kích hoạt ngay") + CTA
   "Xem bảng gói".
3. **Bảng so sánh gói** — section đặc thù: nhóm variant của sản phẩm nổi bật thành bảng
   (tên gói / thời hạn / giá / nút chọn). Dữ liệu: variants hiện có, không model mới.
4. Catalog dạng danh sách (list rows thay vì grid) — tiêu đề + mô tả ngắn + giá + nút.
5. **Hướng dẫn kích hoạt** — 3 bước cố định (mua → nhận key qua email/trang đơn → kích
   hoạt theo hướng dẫn của nhà cung cấp), copy i18n.
6. Khối tin cậy B2B: hóa đơn, hỗ trợ đổi key lỗi, bảo hành thời hạn.

Trang chi tiết: layout 2 cột — mô tả bên trái, "mua ngay" sticky bên phải với bảng
variant dạng dòng. Checkout/orders dùng chung.

## Token & CSS

- `src/styles/storefront/templates/desk.css`; typo nghiêm túc hơn Swift (heading nhỏ hơn,
   khoảng cách dòng chặt), bảng dùng `--sln-border-default`, số hàng highlight khi hover.

## A11y

- Bảng so sánh là `<table>` ngữ nghĩa với `<th scope>`, không dùng div grid giả bảng.
