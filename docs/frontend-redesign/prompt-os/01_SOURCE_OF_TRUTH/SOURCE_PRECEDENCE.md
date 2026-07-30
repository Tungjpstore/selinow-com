# Source precedence

Khi có xung đột, dùng thứ tự sau:

1. Security, tenant, payment, fulfillment và authorization contract trong repository.
2. Accepted ADR và product contract trong repository.
3. `FRONTEND_REDESIGN_BRIEF_VI.md`.
4. Curated Brand OS trong thư mục này.
5. Screen specs và component contracts của Prompt OS.
6. Reference images.

## Quy tắc với ảnh reference

Ảnh reference là chỉ dẫn về:

- art direction;
- nhịp trắng;
- bố cục tương đối;
- mật độ thông tin;
- cách phối màu;
- hierarchy.

Không dùng ảnh để suy đoán:

- API;
- số liệu thật;
- trạng thái nghiệp vụ;
- role/permission;
- provider support;
- plan limits;
- copy chính thức;
- logic payment/fulfillment.

Copy canonical nằm trong `06_COPY_DECK/`.
