# Bàn giao: Dashboard Redesign Takeover — hoàn tất Phase 6 (M-final)

Cập nhật: 2026-08-16
Trạng thái: **Toàn bộ 5 luồng triển khai + cleanup cuối + verification gate đã xong và commit** trên branch `dashboard-redesign-takeover`. Tài liệu này thay thế `docs/DASHBOARD_REDESIGN_HANDOFF_2026-08-15.md` làm điểm nhập cho agent tiếp quản: nó ghi trạng thái bàn giao, bằng chứng verification, việc còn lại, known limitations, hướng dẫn vận hành và ma trận sở hữu file.

Tài liệu gốc cần đọc kèm: `AGENTS.md`, `docs/DASHBOARD_REDESIGN_HANDOFF_2026-08-15.md` (kế hoạch + 4 bản brief), `docs/DASHBOARD_UI_AUDIT_AND_REDESIGN_PLAN_2026-08-15.md` (audit hiện trạng), `docs/IMPLEMENTATION_STATUS.md` (mục closeout 2026-08-16).

---

## 1. Trạng thái bàn giao — milestone và commit

Branch: `dashboard-redesign-takeover` (base review = M0 checkpoint `bcf9692`).

| Milestone | Commit | Phạm vi |
| --- | --- | --- |
| M0 checkpoint | `bcf9692` | Điểm checkpoint WIP trước takeover — dùng làm base khi diff/review. |
| M1 | `a26f0f4` | Unblock build + sửa các cụm WIP hỏng (payments page, telegram mini-app, seller helpers, session, contract registries). |
| M2-D2 | `5dff07f` | Gộp IA Kênh bán về hub `/app/integrations`; trang mới `/app/developer`; tách `DomainManager.astro` thành `components/dashboard/domains/*` (DomainList…); migrate token vùng domains sang `--sln-*`. |
| M3-D1 | `ec919a5` + follow-up `3ac8e16` | Chuẩn hoá `components/workspace/DataTable.astro`; server-side search/sort/pagination cho products/orders/inventory/customers/members + admin shops/investigations/appeals; ledger query `listSellerProductsPage` trong `lib/catalog/store.ts` (CTE tenant-scoped `shop_id`, LIMIT/OFFSET); low-stock threshold đọc từ `shop_settings`; CSV export client-side từ rows đã fetch (`lib/dashboard/csv-export.ts`). Commit `3ac8e16` là phần helper catalog store bị sót (trang + test D1 đã import nhưng chưa commit kèm). |
| M4-D3A | `421a007` + fixup `74c51fc` | Migration `0099` (account security hardening); 2FA email-OTP tái dụng hạ tầng `auth_email_otps`, đổi mật khẩu, login history, lịch sử hoá đơn (`pages/app/security.astro`, `pages/app/billing.astro`, `lib/auth/*`, `pages/api/app/account/*`); fixup bổ sung a11y gate cho security tabs. |
| M5-D3B | `d750297` | Migration `0100` (automation rule builder); `lib/automation/rules/*` với 5 trigger / 4 action, evaluator allow-list fail-closed, SSRF webhook guard, dispatch qua orchestrator có sẵn; CRUD API + builder UI trong `pages/app/automation.astro`. |
| M6-D0/D4 | `3ac8e16` (D1 follow-up) + `973a355` (cleanup) | Cleanup cuối: xoá code chết, hợp nhất token, kèm verification gate tập trung (xem mục 2). |

Chi tiết cleanup trong `973a355`:
1. **`src/lib/catalog/store.ts`** — phán quyết WIP: diff còn lại chính là phần việc D1 hợp lệ (helper search/sort/pagination/threshold cho product ledger; trang `products.astro` và test contract đã import nhưng thiếu trong commit `ec919a5`). Đã commit riêng `3ac8e16`, không commit mù quàng: có đối chiếu `git diff`, `git show ec919a5 --stat`, và chạy test contract pass.
2. **`OnboardingWizard.astro` (904 dòng) đã xoá** — route `/onboarding` dùng `OnboardingShell` + step riêng; grep xác nhận zero import trong `src/`. 6 file test đọc nó đã cập nhật: assertion nào chỉ đúng với wizard thì bỏ, assertion khác giữ nguyên, tham chiếu trỏ sang `OnboardingShell.astro` nơi có markup tương đương (`role="progressbar"`, `aria-valuenow="0"`, toast `role="status"`).
3. **7/13 wrapper trong `src/components/states/` đã xoá** (grep zero-import từng file trước khi xoá): BlockedState, ErrorState, LoadingState, SuccessState, WaitingProviderState, WaitingUserState, WarningState. Giữ 6 file còn được import: WorkspaceState, EmptyState, PermissionState, PlanLimitState, SuspendedState, StatePanel. (Handoff 2026-08-15 ước tính 11/13; các luồng D sau đó đã nối thêm state vào DomainManager/RuleList/AutomationLedger nên số xoá thực tế là 7.)
4. **Hợp nhất token CSS**: migrate 446 usage `--selinow-*` trên 22 file nguồn sang `--sln-*` (storefront.css 170, admin.css 129, primitives.css 8, selinow-a11y.css 4, app-shell.css 2, còn lại là components/pages); thêm 8 token canonical vốn chỉ tồn tại dạng alias (`--sln-success-text`, `--sln-warning-text`, `--sln-danger-text`, `--sln-info-text`, `--sln-action-primary-ink`, `--sln-disabled-ink`, `--sln-disabled-bg`, `--sln-focus`) kèm dark override; gỡ toàn bộ khối alias 70 dòng trong `selinow-tokens.css`. **Usage `--selinow-*` còn lại trong `src/` và `tests/`: 0** (có regression guard `expect(tokens).not.toContain("--selinow-")` trong `promptos-foundation.test.ts`).

---

## 2. Bằng chứng verification (chạy tập trung ở ca M-final, 2026-08-16)

Chạy lần lượt từ root repo trên branch này, sau khi toàn bộ cleanup đã áp dụng:

| Lệnh | Kết quả |
| --- | --- |
| `npm run check` | **PASS** — 855 files, 0 errors, 0 warnings (4 hints). |
| `npm run lint` | **PASS** — 0 errors. |
| `npm run test` | **PASS** — 330 test files, 2589 tests (unit + integration), không có failure. |
| `npm run build` | **PASS** — production Cloudflare Worker build complete; 1 warning `INEFFECTIVE_DYNAMIC_IMPORT` có sẵn từ trước, không đổi. |
| `npm run deploy:dry-run` | **PASS** — bundle, bindings, routes, manifest validate; thoát sạch với `--dry-run`. |

Lưu ý số lượng test: baseline trước ca này là 326 files/2577 unit + 3 files/12 integration; số hiện tại phản ánh các test mới từ D1/D3 cộng với 1 test bị bỏ (waiting-provider slot test) và các assertion wizard bị gỡ ở bước cleanup.

---

## 3. Việc CÒN LẠI cho agent tiếp quản (không làm trong ca này)

### Task 7 — Browser E2E smoke các flow dashboard chính
Chạy trên dev server local (đang chạy background, xem mục 5). Danh sách flow tối thiểu:
- Đăng nhập (password + OTP nếu có), đăng xuất.
- Điều hướng app shell: menu Channels/Developer/Domains/Security/Billing, chuyển shop.
- DataTable: search / sort / pagination / đổi pageSize trên `/app/products` và `/app/orders`; CSV export ra đúng rows của trang hiện tại.
- Automation rules: CRUD rule trong `/app/automation` (tạo rule với từng loại trigger/action hợp lệ, validate lỗi khi payload sai field).
- Security: UI bật 2FA email-OTP, đổi mật khẩu, login history.
- Billing: danh sách invoice render đúng trạng thái.
- Channels hub + `/app/developer`: liên kết sang Domains/Telegram/Store settings.
- Domains: list/add/cancel trong `DomainManager` mới (đã tách).

### Task 8 — Ultra Review 3 chiều
Spawn 3 CodeReview agent **song song**, mỗi agent CHỈ review 1 chiều:
1. completeness (đủ yêu cầu brief so với `docs/DASHBOARD_REDESIGN_HANDOFF_2026-08-15.md`),
2. correctness (logic, tenant isolation `shop_id`, idempotency, không log secret),
3. impact (ảnh hưởng ngoài ý muốn tới vùng không sở hữu, route/migration/token).

Scope review = **toàn bộ thay đổi của branch takeover so với base `bcf9692`** (`git diff bcf9692...HEAD`). Merge 3 báo cáo thành 1 báo cáo tổng theo severity (blocker/major/minor/note), không tự fix trong bước review.

---

## 4. Known limitations & rủi ro

- **DNS-rebinding TOCTOU của webhook guard**: `src/lib/automation/rules/webhook-guard.ts` chặn theo pattern (https-only, port 443, cấm IP literal/private/localhost) vì Workers không có DNS API trước fetch; hostname công khai rebinding về IP riêng là rủi ro tồn dư — đã note trong code, follow-up v2 là domain allowlist.
- **`rule_create_task` ở mức `approval_required`**: capability đăng ký trong `lib/automation/registry.ts` với executor inline trả `completed`; không có tạo task tự động — đúng chủ đích, đừng "nâng cấp" mà không có quyết định sản phẩm.
- **`inventory.low_stock` là trigger derived**: dispatcher tính từ `order.paid` bằng cách đếm inventory keys còn lại so threshold của shop (`computeLowStockEvents`); không có hook kho độc lập.
- **Caveat trong code D3-B (Felix)**: evaluator dùng allow-list payload theo trigger và fail-closed (payload field ngoài allow-list → rule không khớp, không phải lỗi 500); `webhook-guard` ném `validation_failed` với issue `webhook_url_unsafe`; action config validate chặt từng loại (`action_config_unknown_field`).
- **Phán quyết `catalog/store.ts`**: phần WIP là việc D1 hợp lệ, đã commit `3ac8e16` — reviewer nên xem nó như phần mở rộng của `ec919a5`, không phải thay đổi mới ngoài kế hoạch.
- **Token alias đã gỡ hoàn toàn**: không còn fallback `--selinow-*`; stylesheet ngoài repo (nếu có) tham chiếu tên cũ sẽ mất màu. Không cần giữ alias nữa — đã có test chặn tái diễn.
- **`src/scripts/dashboard/onboarding.ts`** giờ chỉ được import bởi wizard đã xoá; còn sống vì 5 file test contract vẫn đọc nó. Ứng viên cleanup riêng ở ca sau (kèm quyết định gỡ i18n keys không còn call-site).

---

## 5. Hướng dẫn vận hành cho agent kế tiếp

- **Dev server**: đang chạy background tại `http://localhost:4322`. Quản lý bằng `npx astro dev status`, `npx astro dev logs`, `npx astro dev stop`; khởi động lại bằng `npx astro dev --background`. Không chạy dev server ở foreground chiếm terminal.
- **Quy ước commit**: stage explicit paths (không bao giờ `git add -A`/`git add .`); mỗi commit đúng 1 luồng việc; pre-commit hooks chạy bình thường thì không bypass.
- **File phải đọc trước khi đụng code**: `AGENTS.md` (product boundary, tenant isolation `shop_id`, không log secret, migration forward-only), `docs/DASHBOARD_REDESIGN_HANDOFF_2026-08-15.md`, `docs/DASHBOARD_UI_AUDIT_AND_REDESIGN_PLAN_2026-08-15.md`, `docs/IMPLEMENTATION_STATUS.md` (mục closeout 2026-08-16).
- **Verification trước khi báo cáo hoàn thành**: `npm run check` → `npm run lint` → `npm run test` → `npm run build` → `npm run deploy:dry-run`; cập nhật `docs/IMPLEMENTATION_STATUS.md` với bằng chứng.
- **Không** trỏ dev local vào D1/R2/queue/bot/channel/custom-hostname của production; không commit secret; migration mới phải forward-only và lấy số tiếp theo sau `0100` (kiểm tra `ls migrations | tail` trước).

---

## 6. Ma trận sở hữu file (trích từ handoff 2026-08-15 — biết ai đã đụng vùng nào khi review)

| Luồng | Sở hữu chính | Không được đụng |
| --- | --- | --- |
| **D1 — Chuẩn hoá bảng dữ liệu & danh sách** | `components/workspace/DataTable.astro`; `pages/app/{products,orders,orders/[id],inventory,customers,members}.astro`; `pages/admin/{shops,investigations,appeals}.astro`; các service `lib/**` phục vụ list/search/sort của các trang trên | `AppLayout.astro`, `integrations/automation/domains/telegram/store-settings/security/billing/data.astro`, `admin/operations.astro`, `admin/index.astro`, mọi migration, `selinow-tokens.css` |
| **D2 — Gộp IA Kênh bán & tách DomainManager** | `layouts/AppLayout.astro`; `pages/app/integrations.astro`; `pages/app/domains.astro`; `components/dashboard/{DomainManager,DomainLifecycle}.astro`; `pages/app/telegram.astro`; `pages/app/store/settings.astro`; `scripts/dashboard/domains.ts` (mới) | `products/orders/inventory/customers/members.astro`, `admin/*`, `DataTable.astro`, nội dung nghiệp vụ bên trong `automation.astro`/`AutomationLedger.astro`, `security.astro`, `billing.astro`, `data.astro`, mọi migration, `selinow-tokens.css` |
| **D3-A — Bảo mật tài khoản (2FA email-OTP) & lịch sử hoá đơn** | Migration **`0099`**; `lib/auth/**` (two-factor, login-history, password); `lib/billing/**` (query lịch sử hoá đơn); `pages/api/app/account/**` (mới); `pages/api/auth/login.ts` (sửa tối thiểu); `pages/app/security.astro`; `pages/app/billing.astro` | `AppLayout.astro`, các trang app ngoài security/billing, `admin/*`, `DataTable.astro`, migration khác ngoài `0099`, `selinow-tokens.css` |
| **D3-B — Automation rule-builder thật** | Migration **`0100`**; `lib/automation/rules/**` (mới); đăng ký capability trong `lib/automation/{registry,executors}.ts`; `pages/api/app/shops/[shopPublicId]/automation/**` (mới); `pages/app/automation.astro`; `components/dashboard/AutomationLedger.astro`; `components/dashboard/automation/**` (mới) | `AppLayout.astro`, các trang app ngoài automation, `admin/*`, `DataTable.astro`, migration khác ngoài `0100`, `selinow-tokens.css` |
| **D0/D4 — Cleanup cuối (ca M-final này)** | `OnboardingWizard.astro`, `src/components/states/*` (7 file xoá), `src/styles/selinow-tokens.css` + mọi usage `--selinow-*` còn lại, các file test chỉ sửa phần tham chiếu code chết | Mọi logic nghiệp vụ của 4 luồng trên (chỉ fix tối thiểu đúng chỗ nếu verification gate lộ lỗi) |

Quy tắc chung (kế thừa từ handoff 2026-08-15, vẫn hiệu lực): không sửa test ngoài phạm vi sở hữu trừ khi thay đổi của mình làm assertion đó sai; mọi query/mutation giữ tenant isolation `shop_id`; webhook/state transition/fulfillment phải idempotent; không bao giờ log secret hoặc plaintext license key.
