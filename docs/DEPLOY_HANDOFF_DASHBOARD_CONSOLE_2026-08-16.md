# Bàn giao deploy — Dashboard Redesign + Console v2 (2026-08-16)

Người viết: ca takeover dashboard-redesign (ZCode session 2026-08-16).
Đối tượng: task deploy thực hiện release production cho nhánh
`dashboard-redesign-takeover`.

Đọc kèm bắt buộc: `AGENTS.md` (toàn bộ), `docs/IMPLEMENTATION_STATUS.md`
(các mục 2026-08-16: closeout, wave-2, addendum, P2+P3, type ramp),
`docs/marketing-redesign/DEPLOY_HANDOFF.md` (phần marketing v5, commit
`7580477`).

---

## 0. Quy tắc sống còn của đợt deploy này

1. **Deploy từ một checkout SẠCH của commit đã chọn, không phải working tree
   hiện tại.** Repo này có nhiều luồng làm việc song song; tại thời điểm viết,
   working tree còn ~14 file dở của luồng remediation (payment-reversal,
   worker.ts, appeals API…) và file `migrations/0104_remediation_completion.sql`
   là **untracked — KHÔNG thuộc bất kỳ commit nào của nhánh này**. Không deploy
   bất cứ thứ gì chưa được commit.
2. **Migrations forward-only, không rollback tự động.** Trước khi apply,
   backup/bookmark D1 production theo quy ước AGENTS.md.
3. Không đổi secrets/vars trong đợt này (xem mục 5) — không thao tác secrets
   nào ngoài quy trình chuẩn.

## 1. Commit đề xuất deploy

Tip nhánh tại thời điểm viết: `7580477` (gồm marketing v5/v5.2 đã có handoff
riêng). Nếu task deploy chỉ muốn phạm vi dashboard/console (không marketing),
dùng `6e40571`. **Không** lấy commit mới hơn nếu các luồng song song push thêm
— mọi commit mới phải qua lại verification gate ở mục 4 trước.

Nhánh chứa, theo thứ tự lịch sử:
- Takeover wave-1/2 (`9a7abc4`, `4ef2516`, `ec58410`, `02b8325`, `7625cd0`):
  security hardening (2FA/password/login-history/billing), automation
  rule-builder, DataTable server-side search/sort/pagination, CSV export,
  BotFather/Cloudflare automation jumps, e2e-found bug fixes.
- `47c2a09`: merge storefront-templates TV0–TV5 (9 template + seller
  dashboard cho physical/booking + shipping dispatch + booking APIs).
- Console v2 (`165905f`, `ad3d29e`, `92e2e47`): design language mới
  "Selinow Console" — token/console.css, icon pack, ConsoleLayout + trang
  Overview pilot, reskin toàn workspace qua shell token remap, type ramp
  ≤600, hairline 1px toàn cục, guard test.
- Marketing v5 (`c67fb2e`, `6a5fce7`, `7580477`) — xem deploy handoff riêng
  của luồng đó.

## 2. Migrations bắt buộc (theo thứ tự)

Production hiện đang ở ≤ 0098. Cần apply đúng thứ tự:

| # | File | Nội dung chính | Ghi chú |
| --- | --- | --- | --- |
| 1 | `0099_account_security_hardening.sql` | `platform_users.two_factor_enabled*`, bảng `auth_login_history` (append-only + trigger chặn UPDATE/DELETE), index tenant-leading | Đã tồn tại từ trước checkpoint; KHÔNG bị sửa trong phạm vi review (`git diff bcf9692..HEAD -- migrations/0099` = 0) |
| 2 | `0100_automation_rule_builder.sql` | Bảng `automation_rules`, `automation_rule_action_runs`, `automation_customer_tags`, cột `automation_tasks.rule_id`, index | ⚠️ Điểm chú ý đặc biệt — xem mục 3 |
| 3 | `0101_storefront_media_assets.sql` | Bảng media assets cho template pipeline (luồng TV) | — |
| 4 | `0102_physical_goods_vertical.sql` | Bảng vertical physical goods (shipping…) | — |
| 5 | `0103_appointment_booking_vertical.sql` | Bảng booking vertical | — |

**KHÔNG deploy** `0104_remediation_completion.sql` nếu thấy nó trong checkout —
nó untracked/dở của luồng khác, chưa thuộc nhánh, chưa có entry trong
`scripts/lib/release.mjs`.

Kiểm tra trạng thái remote trước khi apply (chạy từ repo, không đổi gì):
`npx wrangler d1 migrations list PLATFORM_DB --remote` — kỳ vọng 0099→0103
hiện là "unapplied". Nếu có migration nào đã applied (đặc biệt 0100), DỪNG và
đối chiếu mục 3.

## 3. ⚠️ Rủi ro đã biết riêng migration 0100 (quyết định cần xác nhận)

Trong chuỗi commit takeover, `0100` đã bị **sửa in-place một lần** (commit
`d750297` thêm cột `automation_rule_action_runs.task_id` + index vào CREATE
TABLE vốn đã có ở checkpoint trước). Điều này an toàn **chỉ khi** chưa có
environment nào áp dụng bản 0100-WIP cũ:

- Bản 0100 trong nhánh hiện tại là bản đầy đủ (có `task_id`); `wrangler d1
  migrations list --remote` chỉ track tên file, không checksum — nếu
  production từng áp bản WIP cũ (thiếu cột), việc "đã applied" sẽ khiến schema
  thiếu cột mà không báo lỗi khi deploy code mới.
- **Cách xử lý:** nếu remote cho thấy 0100 chưa từng applied → apply bình
  thường (an toàn). Nếu từng applied (bất kỳ khả năng nào) → DỪNG deploy,
  báo lại chủ sản phẩm để quyết định thêm migration bù (ALTER TABLE … ADD
  COLUMN + CREATE INDEX IF NOT EXISTS theo schema mới) thay vì sửa 0100 lần
  nữa. Local dev DB của máy này đã áp bản đầy đủ (đã verify).

Release registry (`scripts/lib/release.mjs`) đã có entry invariant cho
0099–0103 (kiểm tra tại dòng 334–446) — deploy gate sẽ tự đối chiếu.

## 4. Verification gate (bắt buộc chạy lại trên checkout sạch)

Đây là kết quả lần cuối chạy trên working tree (2026-08-16, sau commit
`92e2e47` + marketing v5):

| Lệnh | Kết quả | Ghi chú |
| --- | --- | --- |
| `npm run check` | 0 error phần dashboard/console | 3 error cũ thuộc file marketing landing của luồng song song — sẽ không tồn tại trên checkout sạch nếu thuộc commit marketing đã fix; nếu còn, đó là việc của luồng marketing |
| `npm run lint` | 0 error phần dashboard/console | như trên |
| `npm run test` | 2629/2630 pass | Lỗi duy nhất `legal-placeholder-surfaces` (footer `/legal`) thuộc working-tree dở của luồng khác — **phải pass trên checkout sạch**; nếu vẫn fail trên commit được chọn → chặn deploy, báo lại |
| `npm run build` | chưa chạy lại sau Console v2 | task deploy PHẢI chạy; kỳ vọng pass (không thay đổi build graph, chỉ CSS/components) |
| `npm run deploy:dry-run` | chưa chạy lại sau Console v2 | task deploy PHẢI chạy và PASS trước deploy thật |

Trình tự bắt buộc: `check → lint → test → build → deploy:dry-run`, tất cả
trên cùng commit sẽ deploy. Cập nhật `docs/IMPLEMENTATION_STATUS.md` với bằng
chứng sau khi xong.

## 5. Config / secrets / bindings

- **Không secret mới, không đổi vars.** Toàn bộ thay đổi dùng bindings sẵn có.
- `APP_ENV === "local"` mới trả `debugOtp` (2FA/login) — production
  (`APP_ENV=production` trong wrangler vars) không bao giờ trả; không cần
  làm gì.
- `.dev.vars` trên máy dev có override ORIGIN port 4330 — chỉ ảnh hưởng dev
  local, không liên quan deploy.
- Không route nào bị xóa: `/app/telegram`, `/app/store/settings` giữ redirect
  307; mới có `/app/developer`, `/app/payments`, `/app/bookings` + nhóm API
  `/api/app/account/*`, `/api/app/shops/[shopPublicId]/automation/rules/**`,
  `/api/app/shops/[shopPublicId]/settings/low-stock-threshold` — đều nằm trong
  worker routes chuẩn (dry-run sẽ xác nhận manifest).

## 6. Smoke test sau deploy (theo đúng kịch bản đã chạy local 2026-08-16)

Làm trên production SAU khi deploy, theo thứ tự (đăng nhập bằng tài khoản
test của bạn, không dùng tài khoản thật của khách):

1. Đăng ký tài khoản mới → OTP verify → login → logout → login lại.
2. Bật 2FA (email OTP) → logout → login (password → OTP challenge → session)
   → trang Security hiển thị login history → tắt 2FA bằng password hiện tại.
3. Tạo shop qua onboarding (chọn đa kênh + mẫu 1-click) → dashboard hiển thị
   shop context `?shop=`.
4. Console `/app`: header 1 dòng + StatusDot + ngày, metric strip 5 số,
   hàng đợi "Cần bạn xử lý" link đúng anchor onboarding, đơn gần đây.
5. Products: search server-side (`q=`), sort (`sort=`), rows-per-page, CSV
   export mở file có BOM + không có cell bắt đầu `=+-@`.
6. Automation: tạo rule (order.paid → Telegram), tạo rule webhook với URL
   `http://127.0.0.1/x` → bị chặn với thông báo lỗi; toggle + delete rule.
7. Billing: invoice empty state + usage meter; Integrations: mở config
   Telegram (nút Copy /newbot + link BotFather), dán token sai định dạng →
   lỗi client tức thì.
8. Domains: card subdomain platform; plan trial chặn custom domain
   (PlanLimitState) — đúng hành vi.
9. Kiểm thị giác nhanh: sidebar light (không còn dark), viền mảnh 1px, không
   emoji trong UI workspace, mobile 390px không cuộn ngang trên /app,
   /app/products, /app/orders, /app/billing.

## 7. Rollback

- **Worker/routes:** rollback theo quy trình deploy chuẩn của repo (phiên bản
  worker trước đó) — CSS/UI changes là thuần render, an toàn để rollback.
- **Migrations: forward-only, KHÔNG rollback tự động.** 0099–0103 thêm
  bảng/cột/index mới, không đổi dữ liệu hiện có; nếu cần hoàn tác phải có
  migration bù do chủ sản phẩm duyệt. Đây là lý do backup/bookmark DB ở mục 0
  là bắt buộc.

## 8. Known issues KHÔNG chặn deploy

- Preview drawer onboarding + prototype condition của rule builder (bug CSS
  `[hidden]`) đã fix trong `9a7abc4` — không còn trong bản deploy.
- IAB cookie-jar chỉ là hiện tượng dev local (trình duyệt nhúng), không ảnh
  hưởng production.
- CSV export: số âm/`@handle` giờ được guard `'` prefix (chống formula
  injection) — cell sẽ là text, đúng chủ đích bảo mật.
- Dashboard accent theo storefront template: mới có attribute hook
  (`data-dashboard-template`), chưa kích hoạt theme thật — không ảnh hưởng.
- Guard design-contract giờ chặn toàn workspace (viền/weight/emoji/hex) —
  nếu CI task deploy chạy test, các guard này phải pass trên commit deploy.

## 9. Checklist rút gọn cho task deploy

```
[ ] Chọn commit (7580477 hoặc 6e40571), clone/checkout SẠCH — không working tree dở
[ ] npx wrangler d1 migrations list PLATFORM_DB --remote  → 0099..0103 unapplied, KHÔNG có 0104
[ ]     ↳ nếu 0100 đã applied → DỪNG, báo chủ sản phẩm (mục 3)
[ ] Backup/bookmark D1 production
[ ] npm run check && npm run lint && npm run test   (test phải 100% pass trên commit sạch)
[ ] npm run build && npm run deploy:dry-run
[ ] Apply migrations theo thứ tự 0099 → 0103
[ ] Deploy worker
[ ] Smoke test mục 6
[ ] Cập nhật docs/IMPLEMENTATION_STATUS.md với bằng chứng
```
