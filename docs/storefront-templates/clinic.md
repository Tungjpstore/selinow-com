# Clinic — y tế / thẩm mỹ sạch (nhóm dịch vụ đặt hẹn)

- **Vertical:** booking · **Scheme:** light · **Gói:** Pro · **Trạng thái:** TV4
- **Khách hàng mục tiêu (VN):** phòng khám nha, dermatology, clinic thẩm mỹ; khách cần
  cảm giác vô trùng, chuyên môn rõ, quy trình minh bạch.

## Bố cục (trang chủ)

1. Announcement giờ làm việc.
2. Header trắng xanh y tế (accent merchant hướng xanh), nav rõ.
3. **Hero chuẩn mực** — headline + bằng cấp/chứng chỉ (text + ảnh cred, TV1) + CTA "Đặt
   lịch khám".
4. **Dịch vụ khám** — danh sách nghiêm túc: tên · thời lượng · giá · nút đặt.
5. **Quy trình 4 bước** — đặt lịch → xác nhận → khám → tái khám (timeline dọc).
6. **Đội ngũ** — thẻ bác sĩ/sỹ với chức danh.
7. Khối câu hỏi thường gặp (details/summary).
8. Footer đầy đủ policy.

Trang chi tiết: mô tả y khoa + duration + slot picker; **không** dùng màu khuyến mãi
giả tạo. Checkout như Serenity; email xác nhận nhấn thời gian & địa điểm.

## Token & CSS

- `src/styles/storefront/templates/clinic.css`; trắng chủ đạo, chỉ 1 accent y tế (merchant
  brand hướng xanh), viền mảnh, iconography line đơn giản; tuyệt đối không gradient rực.

## A11y

- Timeline quy trình dùng `<ol>` ngữ nghĩa; icon kèm text; slot picker như Serenity.
- Không dùng red/green làm tín hiệu duy nhất cho trạng thái slot.
