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

- Trạng thái Professional v1.0 source/local: **19/19 mục source-contract hoàn tất**.
  Active matrix có 19 routes / 82 route-state pairs; đây không phải tuyên bố full
  pixel parity cho mọi degraded/loading/blocked variant chưa có fixture.
- Frontend source/local checkpoint ngày 2026-07-30 (trước các test production
  promotion/DNS hiện tại): `npm run check` (0 errors, 3 hints), `npm run lint`,
  `npm run test` (189 files / 1,447 tests), `npm run build`,
  `npm run deploy:dry-run`, PromptOS validator, authenticated browser gate 7/7
  và public browser gate 27/27 đều pass. Cần chạy lại full repository gate trước
  khi coi tổng test này là hiện tại.
- Responsive/runtime/a11y/overflow: authenticated local gate bao phủ desktop/mobile
  và 1440/768/390/320px; không dùng staging hay production resource.
- Visual: 42 authenticated current-source snapshots và 26 public current-source
  snapshots đã được tạo lại ở exact viewport: authenticated gồm 21 surface IDs
  trên desktop/mobile 1440x1024 và 390x844; public gồm 8 route IDs và 5 state
  fixtures trên desktop/mobile 1440x1024 và 390x844. Zoom 200% là geometry/a11y
  gate không sinh screenshot. Không thấy page overflow, clipping, missing asset
  hoặc layout vỡ; mobile bottom navigation bám đúng viewport và tab ngang của
  store builder nằm trong scroll container chủ đích.
- Snapshot được tạo bằng isolated local D1. Không gọi staging, không deploy và
  không thay đổi production trong lần audit này. Staging acceptance vẫn là gate
  riêng vì Worker staging hiện chưa đồng bộ source.
