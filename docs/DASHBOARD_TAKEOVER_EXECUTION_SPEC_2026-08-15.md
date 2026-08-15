# Dashboard Takeover Execution Spec — 2026-08-15

Spec gốc (original design spec): `docs/DASHBOARD_REDESIGN_HANDOFF_2026-08-15.md`.
Tài liệu này là bản thực thi (execution spec) của Task #1 trên branch
`dashboard-redesign-takeover`, chốt phạm vi xử lý 5 luồng WIP tại mốc
`HEAD 7386d16` (17 modified + 12 untracked) và tiêu chí hoàn thành.

Mốc bảo vệ: commit `M0 chore: checkpoint pre-takeover WIP` (branch
`dashboard-redesign-takeover`) giữ nguyên trạng mọi file WIP trước khi sửa.
`shasum src/pages/app/payments.astro` tại M0: `159e004d31e080c1b8b131011cb8aaa8c2844dc9`
(file này được phép hoàn thiện theo quyết định của user, hash chỉ dùng để đối chiếu nội bộ).

## 1. Hiện trạng 5 luồng WIP

1. **Dashboard redesign & IA mới** — `src/layouts/AppLayout.astro` (nav 4 nhóm:
   Operations / Sales channels / Configuration / Administration, thêm
   `/app/payments`, `/app/developer`, `/app/security`), `src/components/workspace/DataTable.astro`,
   `src/lib/commerce/seller-orders.ts`, `src/lib/i18n/catalogs/dashboard.ts`,
   `src/pages/app/payments.astro` (bị cắt cụt giữa dòng 64 — lỗi parse).
2. **Onboarding v2** — `src/components/dashboard/onboarding/*` (kể cả 2 file mới
   `OnboardingPreviewDrawer.astro`, `OnboardingStepLaunch.astro`) và
   `src/scripts/dashboard/onboarding-quickstart.ts`. **Đã verify xong — KHÔNG đụng.**
3. **Account security & 2FA** — `src/lib/auth/session.ts`, `src/pages/api/auth/login.ts`,
   `src/pages/api/auth/login-2fa.ts` (route mới), `src/lib/auth/two-factor.ts`,
   `src/lib/auth/password.ts`, `src/lib/auth/login-history.ts`,
   `migrations/0099_account_security_hardening.sql` (well-formed, không sửa).
4. **Telegram commerce / mini-app** — `src/lib/telegram/commerce.ts` (WIP phá vỡ
   contract: tham chiếu `window` trong Worker, mất guard số `buy:`, đổi result code,
   rò license-key plaintext qua `keyRevealInline`, 47 lỗi lint `any`),
   `src/lib/telegram/outbox.ts` (unused `retryDelayMs`), `src/lib/telegram/webhooks.ts`
   (retry sendMessage WIP). Tính năng mini-app chuẩn nằm ở surface HTTP riêng
   (`src/lib/channels/telegram-mini-app-commerce.ts`, routes
   `/api/channels/telegram-mini-app/*`, session contract `migrations/0057`) — giữ nguyên.
5. **Customer data & automation operations** — `src/lib/dashboard/csv-export.ts`,
   `src/lib/tenants/seller-management.ts` (helpers sort/search chết, chưa wire),
   `migrations/0100_automation_rule_builder.sql` (well-formed, không sửa).

## 2. Bốn quyết định của user (đã chốt)

1. **GIỮ** tính năng Telegram mini-app và **sửa đúng cách** (không revert).
2. **Hoàn thiện** `src/pages/app/payments.astro` (frontmatter 62 dòng giữ nguyên).
3. Commit mốc WIP trên **branch mới `dashboard-redesign-takeover`** (M0), sau đó
   commit M1 khi verify xanh.
4. **Giữ nguyên WIP onboarding v2** (các file onboarding + `IMPLEMENTATION_STATUS.md`
   đã verify — không đụng; vì vậy báo cáo task này không ghi đè IMPLEMENTATION_STATUS.md).

## 3. Mapping file lỗi → cách xử lý

| File / lỗi | Cách xử lý |
| --- | --- |
| `src/pages/app/payments.astro` (13 check + 1 lint parse) | Viết tiếp từ dòng 64 theo đúng contract props của `AppLayout` đang dùng bởi `integrations.astro`/`domains.astro`; render panel PayOS từ `payosView`/`unavailablePayos`/`payosConnected`/`integrationClientCopy`; client JS module mới `src/scripts/dashboard/payments.ts` theo pattern `integrations.ts`; mọi string qua `t`. |
| `src/lib/telegram/commerce.ts` (`window` tại ~516/591, `formatOrderStatus` thiếu, 47 lỗi `any`, mất guard `buy:`, đổi result code, rò key) | Loại mọi tham chiếu `window`; detection mini-app là hàm server-side thuần đọc cờ tường minh từ payload update (surface mini-app thật là HTTP API theo migration 0057, không bao giờ dùng global browser); khôi phục guard `/^(0|[1-9][0-9]*)$/u` cho `buy:`; giữ nguyên result code legacy `checkout_completed`/`order_rendered`/`keys_rendered`; xóa `keyRevealInline` (chỉ path `keyReply` có gating + `protectContent`); thêm `formatOrderStatus` theo pattern `telegramText`/`telegramStatus`; gọi `getOrder`/`revealFulfillment` đúng signature `CommerceContext` + order reference principal. |
| `src/lib/telegram/outbox.ts:30` (unused `retryDelayMs`) | Xóa biến chết; giữ nguyên hành vi claim/quarantine đã có. |
| `src/lib/telegram/webhooks.ts` | Sửa tối thiểu nếu lint/check báo; không đổi hành vi webhook đã verify ngoài khối retry WIP đang có. |
| `src/lib/tenants/seller-management.ts:29,40` (helpers chết) | `customers.astro` committed chỉ gửi `cursor`, không gửi sort/search → **xóa** `parseSellerCustomerSort`/`normalizeSellerCustomerSearch`/`sellerCustomerSortSql` + type liên quan (noUnusedLocals). |
| `src/lib/auth/session.ts:580` (`exactOptionalPropertyTypes`) | Omit `rememberMe` khi `undefined` tại điểm gọi `issueSessionForUser`; không đổi logic session. |
| `scripts/lib/release.mjs` registry thiếu 0099/0100 | Thêm entry `PRODUCTION_DATABASE_INVARIANT_REGISTRY` cho `0099_account_security_hardening.sql` và `0100_automation_rule_builder.sql` đúng format lân cận (columns + index digests); không sửa logic gate. |
| `tests/unit/app-shell-foundation.test.ts` | Cập nhật assertion nav theo IA mới (Channels/Payments/Developer) đúng như `AppLayout.astro` hiện tại; chỉ sửa phần nav. |
| `tests/unit/provider-surface-audit.test.ts` + `API_ENDPOINT_INDEX.csv` | Bổ sung route `/api/auth/login-2fa` vào inventory CSV (cấu trúc `/api/admin/operations/*` đã có sẵn trong inventory); cập nhật row-count assertion tương ứng. |
| `tests/unit/telegram-commerce-tenant-boundary.test.ts` | **KHÔNG sửa** — đây là contract khóa. |

## 4. Tiêu chí hoàn thành (gate AGENTS.md)

- `npm run check` → 0 error.
- `npm run lint` → 0 error.
- `npx vitest run tests/unit/telegram-commerce-tenant-boundary.test.ts tests/unit/production-deploy-continuation-guard.test.ts tests/unit/app-shell-foundation.test.ts tests/unit/provider-surface-audit.test.ts tests/unit/seller-surface-contracts.test.ts` → pass toàn bộ.
- `npm run build` → pass.
- Commit **M1** chỉ sau khi mọi verify xanh; không dùng `--no-verify`.
- `docs/IMPLEMENTATION_STATUS.md`: không ghi đè (đã chốt ở quyết định 4); kết quả
  verify của task được ghi trong báo cáo cuối và tài liệu này.

### Kết quả verify (M1, commit `178562a`)

- `npm run check` → 0 error (baseline 18).
- `npm run lint` → 0 error (baseline 52).
- `npx vitest run` 5 file contract → 5 file / 59 tests passed
  (telegram-commerce-tenant-boundary 23, production-deploy-continuation-guard 10,
  app-shell-foundation 9, provider-surface-audit 4, seller-surface-contracts 13).
- `npm run build` → Complete.
- `npm run deploy:dry-run` → pass (`--dry-run: exiting now`).
- Lưu ý: commit M1 chỉ chứa 11 file của task này; 3 file WIP xuất hiện thêm trong
  working tree sau M0 (`src/lib/i18n/catalogs/dashboard.ts`,
  `src/pages/api/app/account/*`, `src/scripts/dashboard/domains.ts`) thuộc luồng
  D2 của agent khác đang chạy song song nên KHÔNG được gộp vào M1.

## 5. Ràng buộc bất biến

- Tenant isolation `shop_id` cho mọi query/mutation; CSRF cho mutation dashboard;
  idempotency cho checkout/payment; không log secrets/license-key plaintext;
  không tạo/sửa migration (0099/0100 giữ nguyên, forward-only).
- Không `git reset --hard` / `git checkout .`; chỉ thao tác file cụ thể.
- Không sửa file test ngoài 2 file được phép (app-shell-foundation, provider-surface-audit).
