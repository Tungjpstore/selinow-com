# Selinow Frontend Prompt OS — Professional v1.0

Bộ kit này là **nguồn hướng dẫn triển khai frontend có tính quyết định** cho Selinow. Mục tiêu là để một coding agent có thể đọc kit, đối chiếu repository hiện tại, rồi dựng lại toàn bộ frontend với mức nhất quán cao nhất về:

- product boundary;
- nhận diện thương hiệu;
- layout và responsive behavior;
- component contracts;
- trạng thái nghiệp vụ;
- copy tiếng Việt;
- accessibility;
- security và data authority;
- visual regression.

## Sự thật quan trọng

Không một prompt đơn lẻ nào có thể bảo đảm “100% pixel-perfect” trên mọi agent và mọi repository. Kit này chuyển mục tiêu đó thành một quy trình có thể kiểm chứng bằng:

1. token chính xác;
2. screen specification chi tiết;
3. copy deck cố định;
4. reference images;
5. route/state acceptance matrix;
6. Playwright visual regression;
7. sai số bố cục và màu được giới hạn rõ ràng.

## Cách dùng nhanh

Gửi toàn bộ thư mục này cho agent, sau đó dùng nguyên prompt trong:

`00_START_HERE/ONE_SHOT_AGENT_PROMPT.md`

Agent bắt buộc phải đọc `AGENTS.md` và `PROMPT_OS_MANIFEST.yaml` trước khi code.

## Nguồn sự thật theo thứ tự

1. Business/security contract trong repository đang triển khai.
2. `01_SOURCE_OF_TRUTH/FRONTEND_REDESIGN_BRIEF_VI.md`.
3. `01_SOURCE_OF_TRUTH/BRAND_OS_CURATED/`.
4. Screen specs, component specs và copy deck trong kit này.
5. Reference images — chỉ dùng cho art direction/composition, không dùng để suy đoán business logic.

## Output mong đợi

- Astro 7 + TypeScript strict + Cloudflare adapter.
- HTML/CSS-first và progressive enhancement.
- Không tự ý thêm React/Vue runtime.
- Hoàn chỉnh cả desktop 1440px và mobile 390px.
- Đạt WCAG 2.2 AA.
- Có loading, empty, warning, blocked, waiting, error, forbidden, plan-limited và suspended state.
- Có screenshot baseline và visual regression.
