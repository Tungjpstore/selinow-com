# Checklist trước khi bàn giao

- [x] Đúng surface và tenant context.
- [x] Đúng route/API hiện tại.
- [x] Dùng token chuẩn.
- [x] Không hard-code dữ liệu runtime.
- [x] Payment/fulfillment tách riêng.
- [x] Không lộ secret/key/token.
- [x] Desktop 1440px đạt spec.
- [x] Mobile 390px đạt spec.
- [x] Không overflow ở 320px.
- [x] Keyboard complete.
- [x] Focus visible.
- [x] Reduced motion.
- [x] Loading/empty/blocked/error states.
- [x] `npm run check` pass.
- [x] `npm run lint` pass.
- [x] relevant tests pass.
- [x] `npm run build` pass.
- [x] Visual screenshots đã lưu.
- [x] Implementation report hoàn tất.

## Bằng chứng hiện tại

- Trạng thái Professional v1.0 source/local: **19/19 mục source-contract hoàn tất**;
  đây không phải full route/state/pixel-parity acceptance matrix.
- Source/local kiểm tra lại ngày 2026-07-30: `npm run check` (0 errors, 3 hints),
  `npm run lint`, 184 files / 1,371 tests, `npm run build`,
  `npm run deploy:dry-run`, PromptOS validator và authenticated browser gate
  6/6 đều pass.
- Responsive/runtime/a11y/overflow: authenticated local gate bao phủ desktop/mobile
  và 1440/768/390/320px; không dùng staging hay production resource.
- Visual: 28 authenticated current-source snapshots đã được tạo lại và duyệt thủ
  công ở exact viewport: 14 desktop ảnh 1440x1024 và 14 mobile ảnh 390x844.
  Không thấy page overflow, clipping, missing asset hoặc layout vỡ; mobile bottom
  navigation bám đúng viewport và tab ngang của store builder nằm trong scroll
  container chủ đích.
- Snapshot được tạo bằng isolated local D1. Không gọi staging, không deploy và
  không thay đổi production trong lần audit này. Staging acceptance vẫn là gate
  riêng vì Worker staging hiện chưa đồng bộ source.
