# Non-negotiables

1. Tên thương hiệu luôn là **Selinow**.
2. Lời hứa cốt lõi: **Turn conversations into sales.**
3. Telegram-first, không Telegram-only.
4. Selinow là SaaS multi-tenant cho seller, không phải marketplace tập trung.
5. Bốn surface phải tách context: marketing, workspace, storefront, admin.
6. Brand primary là `#5B5CEB`; không dùng success green như màu thương hiệu.
7. Dùng token chính thức; không tự tạo màu “gần giống”.
8. Layout rhythm 8px, micro-spacing 4px.
9. WCAG 2.2 AA.
10. Mobile acceptance chính tại 390px; minimum 320px.
11. Không horizontal overflow.
12. Payment và fulfillment luôn là hai trạng thái độc lập.
13. Không gọi return/cancel URL là bằng chứng đã thanh toán.
14. Không hiển thị Telegram token, PayOS credential, order access token hoặc plaintext inventory key.
15. Không tin `shop_id`, role, price, stock hoặc payment state từ client.
16. Không hard-code plan limit nếu dữ liệu thuộc runtime/database.
17. Không thêm buyer account vào MVP.
18. Không thêm React/Vue chỉ để dựng UI.
19. Không dùng robot mascot, cyberpunk, neon glow, glassmorphism toàn trang hoặc card wall.
20. Không dùng fake metrics, fake customer logos, fake testimonials hoặc claim không có nguồn.
21. Mọi màn hình data-driven phải có loading, empty, success, warning, blocked, waiting user, waiting provider, error/retry, forbidden, plan limited và suspended state khi liên quan.
22. Mọi action destructive cần impact message, permission/recent-auth check và confirmation phù hợp.
23. Storefront catalog phải render nội dung cốt lõi khi JavaScript chưa chạy.
24. Mọi mutation retryable phải idempotent.
25. Khi source và ảnh reference khác nhau, business/security source thắng.
