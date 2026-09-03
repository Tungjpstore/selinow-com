# Bàn giao: Kế hoạch làm mới Dashboard Selinow — tạm dừng trước khi thực thi

Cập nhật: 2026-08-15
Trạng thái: **Chưa có dòng code nào bị thay đổi.** Toàn bộ nội dung dưới đây là kết quả khảo sát + kế hoạch đã được chủ sản phẩm duyệt hướng đi, nhưng việc triển khai (spawn 4 luồng song song) đã bị huỷ **trước khi bất kỳ agent con nào bắt đầu chạy** — tức là chưa có edit, chưa có migration, chưa có commit nào phát sinh từ kế hoạch này. Repo hiện ở trạng thái an toàn để đội tiếp theo bắt đầu từ đầu theo đúng bản kế hoạch này.

File duy nhất đã được tạo: `docs/DASHBOARD_UI_AUDIT_AND_REDESIGN_PLAN_2026-08-15.md` (báo cáo đánh giá hiện trạng + kế hoạch 5 phase D0–D4). Tài liệu này (`DASHBOARD_REDESIGN_HANDOFF_2026-08-15.md`) bổ sung: quyết định của chủ sản phẩm, kết quả điều tra kiến trúc chi tiết cho từng luồng việc, và **nguyên văn 4 bản brief giao việc** đã soạn sẵn cho 4 agent song song nhưng chưa gửi/chưa chạy.

---

## 1. Quyết định của chủ sản phẩm (đã chốt, áp dụng cho mọi bước tiếp theo)

| Câu hỏi mở trong bản kế hoạch gốc | Quyết định |
| --- | --- |
| "Automation" là log tác vụ hệ thống hay cần trở thành rule-builder thật? | **Phải là rule-builder thật** (trigger → điều kiện → hành động), không chỉ là nhật ký. |
| Phạm vi bảo mật tài khoản (2FA, quản lý API key) có nằm trong roadmap gần không? | **Có** |
| Có chấp nhận đổi route (`/app/telegram`, `/app/store/settings`, tách `/admin/operations/*`...) không? | **Có**, được phép đổi route. |
| Làm tuần tự D0→D4 hay chạy song song? | **Chạy song song cả 4 luồng việc chính** (D1, D2, D3-Bảo mật, D3-Automation), với D0 (dọn nền) và D4 (hoàn thiện thị giác) xử lý ở đầu/cuối để tránh xung đột file. |

---

## 2. Việc đã hoàn thành trong phiên làm việc này (chỉ đọc, không sửa)

1. Đọc toàn bộ cấu trúc `src/pages/app/**`, `src/pages/admin/**`, layouts, design system (`src/components/primitives`, `src/components/states`, `src/components/workspace`, `src/styles/*.css`).
2. Chạy 4 sub-agent audit song song (chỉ đọc) cho 4 nhóm màn hình — kết quả đầy đủ đã tổng hợp trong `docs/DASHBOARD_UI_AUDIT_AND_REDESIGN_PLAN_2026-08-15.md`.
3. Đối chiếu với tài liệu redesign đã có sẵn trong repo (`docs/FRONTEND_REDESIGN_BRIEF_VI.md`, `docs/frontend-prompt-os/**`, `docs/frontend-rebuild-handoff/**`, `docs/frontend-redesign/**`, `docs/IMPLEMENTATION_STATUS.md`) để tránh làm lại/đi ngược hướng đã có.
4. Xác nhận `OnboardingWizard.astro` là code chết (route `/onboarding` thực tế dùng `OnboardingShell` + các bước riêng) — chỉ còn bị đọc bởi 6 file test và tài liệu cũ.
5. Xác nhận 11/13 file trong `src/components/states/` là wrapper 1 dòng, **không được import ở bất kỳ đâu** (grep xác nhận zero match) — an toàn để dọn.
6. Khảo sát migration mới nhất: **`0098_auth_email_otp_system.sql`** — đã đặt chỗ số migration cho 2 luồng cần schema mới:
   - **`0099`** dành cho luồng Bảo mật tài khoản (D3-A).
   - **`0100`** dành cho luồng Automation rule-builder (D3-B).
   - **Đội tiếp theo phải kiểm tra lại `ls migrations | tail` trước khi dùng 2 số này**, phòng trường hợp có migration khác được thêm vào giữa lúc này và lúc bắt đầu triển khai thật.
7. Phát hiện kiến trúc quan trọng giúp giảm rủi ro/khối lượng việc cho 2 luồng D3:
   - `src/lib/auth/otp.ts` đã có sẵn `OtpPurpose` bao gồm **`"login_2fa"`** và bảng `auth_email_otps` (từ migration `0098`) đã cho phép purpose này — nghĩa là **2FA nên làm theo hướng email-OTP tái sử dụng hạ tầng có sẵn**, không cần xây TOTP/authenticator app từ đầu.
   - Migration `0072_platform_billing.sql` **đã có sẵn bảng `billing_invoices`** — tính năng "lịch sử hoá đơn" trên `/app/billing` nhiều khả năng chỉ cần thêm query đọc + UI, **không cần migration mới** cho phần này (cần đội tiếp theo xác nhận lại field cụ thể).
   - `src/lib/automation/{types,registry,orchestrator,executors,scheduler,d1-repository}.ts` là một **engine thực thi tác vụ bền vững đã có sẵn** (lease/claim/retry, idempotency, tenant-scoped, capability registry). Rule-builder mới **không nên xây một engine thực thi song song** — nên tái sử dụng `AutomationOrchestrator.start()` làm lớp thực thi hành động (đăng ký capability code mới như `rule_notify_telegram`, `rule_call_webhook`...), còn lớp mới chỉ chịu trách nhiệm định nghĩa rule + khớp trigger.
   - `migrations/0038_api_credentials.sql` đã có bảng `api_credentials` (credential cấp shop, dùng cho tích hợp server-to-server) — **khác** với 2FA/tài khoản cá nhân, nên luồng D3-A (bảo mật cá nhân) không được trùng lặp hệ thống này; nếu Security cần hiển thị API key, chỉ nên liên kết sang trang Integrations (thuộc D2) chứ không xây lại.

---

## 3. Ma trận sở hữu file (bắt buộc tuân thủ để 4 luồng không đụng nhau khi triển khai song song)

| Luồng | Sở hữu chính | Không được đụng |
| --- | --- | --- |
| **D1 — Chuẩn hoá bảng dữ liệu & danh sách** | `components/workspace/DataTable.astro`; `pages/app/{products,orders,orders/[id],inventory,customers,members}.astro`; `pages/admin/{shops,investigations,appeals}.astro`; các service `lib/**` phục vụ list/search/sort của các trang trên | `AppLayout.astro`, `integrations/automation/domains/telegram/store-settings/security/billing/data.astro`, `admin/operations.astro`, `admin/index.astro`, mọi migration, `selinow-tokens.css` |
| **D2 — Gộp IA Kênh bán & tách DomainManager** | `layouts/AppLayout.astro`; `pages/app/integrations.astro`; `pages/app/domains.astro`; `components/dashboard/{DomainManager,DomainLifecycle}.astro`; `pages/app/telegram.astro`; `pages/app/store/settings.astro`; `scripts/dashboard/domains.ts` (mới) | `products/orders/inventory/customers/members.astro`, `admin/*`, `DataTable.astro`, nội dung nghiệp vụ bên trong `automation.astro`/`AutomationLedger.astro`, `security.astro`, `billing.astro`, `data.astro`, mọi migration, `selinow-tokens.css` |
| **D3-A — Bảo mật tài khoản (2FA email-OTP) & lịch sử hoá đơn** | Migration **`0099`** (đặt tên gợi ý: `account_security_hardening`); `lib/auth/**` (file mới: two-factor, login-history, password); `lib/billing/**` (query lịch sử hoá đơn); `pages/api/app/account/**` (mới); `pages/api/auth/login.ts` (sửa tối thiểu để thêm bước 2FA); `pages/app/security.astro`; `pages/app/billing.astro` | `AppLayout.astro`, `integrations/automation/domains/telegram/store-settings/products/orders/inventory/customers/members/data.astro`, `admin/*`, `DataTable.astro`, migration khác ngoài `0099`, `selinow-tokens.css` |
| **D3-B — Automation rule-builder thật** | Migration **`0100`** (đặt tên gợi ý: `automation_rule_builder`); `lib/automation/rules/**` (mới); đăng ký capability mới trong `lib/automation/{registry,executors}.ts`; `pages/api/app/shops/[shopPublicId]/automation/**` (mới); `pages/app/automation.astro`; `components/dashboard/AutomationLedger.astro`; `components/dashboard/automation/**` (mới) | `AppLayout.astro`, `integrations/domains/telegram/store-settings/products/orders/inventory/customers/members/security/billing/data.astro`, `admin/*`, `DataTable.astro`, migration khác ngoài `0100`, `selinow-tokens.css` |

**Quy tắc chung cho cả 4 luồng:**
- Không sửa file test dùng chung ngoài phạm vi sở hữu, trừ khi thay đổi của chính mình làm assertion cụ thể đó sai — khi đó chỉ sửa đúng assertion liên quan và phải ghi rõ trong báo cáo.
- Không đụng `src/styles/selinow-tokens.css` — việc hợp nhất `--sln-*`/`--selinow-*` (Phase D0) nên làm **sau cùng**, sau khi 4 luồng xong, để tránh xung đột merge trên diện rộng.
- `OnboardingWizard.astro` và việc dọn 11 state-wrapper component (Phase D0) cũng nên làm **sau cùng** (không giao cho 4 luồng trên) vì 2 file test liên quan (`tests/unit/app-shell-foundation.test.ts`, `tests/unit/design-system-accessibility.test.ts`) đồng thời assert cả nội dung `DomainManager.astro`/`AppLayout.astro` (thuộc D2) — dọn sau khi D2 xong sẽ tránh phải sửa test 2 lần.
- Mỗi luồng phải tự chạy `npm run check`, `npm run lint`, `npm run test:unit` (và `test:integration` nếu đụng phạm vi đó), `npm run build` trước khi báo cáo hoàn thành.

---

## 4. Nguyên văn 4 bản brief đã soạn sẵn (chưa gửi cho agent nào — dùng lại nguyên văn khi triển khai)

### 4.1 Brief D1 — Chuẩn hoá bảng dữ liệu & danh sách

```
Project: Selinow.com (Astro 7 + TypeScript strict + Cloudflare Worker + D1). Read `Selinow.com/AGENTS.md` fully first and follow it strictly (tenant isolation via shop_id, CSRF on mutations, idempotency, no logging secrets/keys, forward-only numbered migrations only if you truly need one — you likely won't for this task).

## Your mission (Phase D1 of a dashboard-wide redesign)
Standardize the "list/table" experience across seller and admin dashboard pages: real server-side search/filter/sort, pagination, bulk actions where sensible, CSV export where sensible, and proper destructive-action confirmation — replacing ad hoc hand-rolled div-tables and client-only search.

## Files you OWN (only touch these; do not touch anything else in the repo)
- `src/components/workspace/DataTable.astro` (enhance into a genuinely reusable component: sortable column headers via URL query param, responsive row collapse, optional row-selection/bulk-action bar, optional pagination footer slot)
- `src/pages/app/products.astro`
- `src/pages/app/orders.astro`
- `src/pages/app/orders/[id].astro`
- `src/pages/app/inventory.astro`
- `src/pages/app/customers.astro`
- `src/pages/app/members.astro`
- `src/pages/admin/shops.astro`
- `src/pages/admin/investigations.astro`
- `src/pages/admin/appeals.astro`
- Any `src/lib/**` service/query functions that back these pages' listing endpoints (e.g. `src/lib/commerce/seller-orders.ts`, `src/lib/catalog/store.ts`, `src/lib/tenants/store.ts`, customer/member listing services, admin shop directory service — find them via grep from the pages above) — you may extend these to accept search/sort/filter params, but do not change their tenant-scoping/security invariants.
- New tests you author for your own new behavior (place under `tests/unit/` with a new filename, do not edit pre-existing shared test files unless a test's assertion is *exactly* about a line you had to change in a file you own — if so, make the minimal fix and clearly report it).

## Do NOT touch (owned by parallel workstreams)
`src/layouts/AppLayout.astro`, `src/pages/app/integrations.astro`, `src/pages/app/automation.astro`, `src/components/dashboard/AutomationLedger.astro`, `src/pages/app/domains.astro`, `src/components/dashboard/DomainManager.astro`, `src/components/dashboard/DomainLifecycle.astro`, `src/pages/app/telegram.astro`, `src/pages/app/store/settings.astro`, `src/pages/app/security.astro`, `src/pages/app/billing.astro`, `src/pages/admin/operations.astro`, `src/pages/admin/index.astro`, `src/pages/app/data.astro`, any migration files, `src/styles/selinow-tokens.css`.

## Concrete requirements
1. **Server-side search/filter/sort, URL-driven.** Current search on orders/customers only filters the currently-loaded cursor page of results, so it silently fails to find records on later pages. Fix this: search/filter/sort must query the backend and reflect in the URL (query params), so results are correct regardless of pagination depth, and are shareable/bookmarkable/back-button-safe.
2. **Adopt `DataTable.astro`** (enhance it as needed) instead of the hand-rolled `role="table"` div-grids currently duplicated across `products.astro`/`orders.astro`/admin pages. Keep the accessible `role`/`aria` semantics already present, don't regress accessibility.
3. **Add real pagination** (previous/next at minimum, ideally page-size control) — current orders/customers pagination is "Next only", inventory/products have none.
4. **Add bulk actions** where they make sense with existing backend capability (e.g., bulk archive products if an archive endpoint already exists per-item; if no bulk backend endpoint exists, you may call the existing single-item endpoint per selected row sequentially with idempotency, and clearly report if a purpose-built bulk endpoint is needed but out of scope). Add CSV export for Orders, Products, Inventory, admin Shops, admin Investigations (client-side generation from the already-fetched authorized page of data is acceptable if a full-dataset export endpoint doesn't exist — but be explicit in your report about which is which, and never export unauthorized/cross-tenant data).
5. **Add low-stock threshold editing** in `inventory.astro` (or the product/variant editor if that's cleaner) — currently no UI anywhere lets a seller change the threshold that drives "healthy/low/out" status. Check the DB schema for an existing threshold column (grep `low_stock` / `threshold` in `src/lib` and `migrations/`) before deciding whether this needs a new field — if a column already exists but has no UI, just wire the UI; if truly no column exists anywhere, add a minimal read/write through an existing product/variant update endpoint if one exists, and clearly flag if a schema change would be required (do NOT add a migration yourself — report the exact need and stop short of that specific sub-feature if a migration is genuinely required, since migrations are out of your scope for this task).
6. **Replace native browser `confirm()`** for destructive actions in your owned pages (e.g. customer anonymize, member revoke, admin appeal/shop actions if present) with `src/components/primitives/ConfirmDialog.astro` (already exists — read it first) for a proper focus-managed two-step confirmation, especially separating the customer "type ANONYMIZE to confirm" GDPR action into a clearly isolated destructive flow rather than being visually flush with routine note-adding.
7. **Fix `orders/[id].astro`** so successful mutation forms (manual fulfillment, remediation) update the DOM/state instead of calling `window.location.reload()`, where reasonably achievable without inventing new API contracts.
8. **Remove the permanently-empty, non-functional "Messages"/"Notes" stub sections** in `orders/[id].astro` OR clearly label them as not-yet-available (your call, prefer removing dead promise of functionality over faking it) — check `src/lib/commerce/order-messages.ts` first to see if this is genuinely provider-pending per `docs/frontend-redesign/GAP_REPORT.md`.
9. Reuse existing shared primitives (`Button.astro`, `StatusBadge.astro`, `Alert.astro`, `WorkspaceState.astro`) rather than re-declaring `.sln-button`/badge CSS locally — remove any local duplicate button/badge CSS you find in the files you touch.
10. Keep Vietnamese as the primary UI locale via the existing i18n translator pattern already used in these files (`createDashboardTranslator` etc.) — do not hardcode new user-facing strings without going through the i18n catalog used by the surrounding file.

## Required before you finish
- Run `npm run check`, `npm run lint`, `npm run test:unit` (or targeted vitest files touching your changed area), and `npm run build` from the `Selinow.com` project root. Fix failures caused by your changes.
- If any pre-existing test outside your listed ownership fails because of an unavoidable change you made (e.g., a copy string it asserts on), make the smallest possible fix to that one assertion and explicitly list it in your final report — do not do a broad rewrite of shared test files.
- Report: what you changed per file, what backend/schema gaps you hit and deferred (with exact file/table names), any pre-existing test files you touched and why, and full verification command results (pass/fail with error excerpts if any failed).
```

### 4.2 Brief D2 — Gộp IA Kênh bán & tách DomainManager

```
Project: Selinow.com (Astro 7 + TypeScript strict + Cloudflare Worker + D1). Read `Selinow.com/AGENTS.md` fully first and follow it strictly (tenant isolation via shop_id, CSRF on mutations, idempotency, no logging secrets/keys/tokens, no exposing Telegram/PayOS credentials in UI beyond what's already safely shown).

## Your mission (Phase D2 of a dashboard-wide redesign)
Fix the "Sales channels" navigation/IA problem and decompose the oversized `DomainManager.astro`. Route changes are explicitly approved by the product owner — you may restructure routes/nav as needed, but must keep the app functional (add redirects from old paths if you remove a route that might be bookmarked, per your judgment).

## Files you OWN (only touch these; do not touch anything else in the repo)
- `src/layouts/AppLayout.astro`
- `src/pages/app/integrations.astro`
- `src/pages/app/automation.astro` — you only own the **navigation entry / page shell wiring** for this file if your AppLayout nav changes affect it; do NOT touch its internal content/business logic (a parallel workstream is rebuilding Automation into a real rule builder). If you must adjust its route path or how it's linked from nav, keep its internal content byte-for-byte identical except for necessary import path changes.
- `src/pages/app/domains.astro`
- `src/components/dashboard/DomainManager.astro`
- `src/components/dashboard/DomainLifecycle.astro`
- `src/pages/app/telegram.astro`
- `src/pages/app/store/settings.astro`
- `src/scripts/dashboard/domains.ts` (new file — extract inline client script here) and `src/scripts/dashboard/integrations.ts` (existing, extend as needed)
- Any new sub-components you create under `src/components/dashboard/domains/` (e.g. `DomainList.astro`, `DomainConnectForm.astro`, `DomainDeleteDialog.astro`, `DomainGuide.astro`) or `src/components/dashboard/integrations/` (e.g. `ChannelsPanel.astro`, `PaymentsPanel.astro`, `ApiCredentialsPanel.astro`)
- `src/lib/dashboard/shop-navigation.ts` and any nav-config helper types you need to adjust for the new grouping
- New tests you author under `tests/unit/` for your own new behavior.
- You WILL need to update pre-existing tests that assert on `AppLayout.astro` nav structure, `DomainManager.astro` content, or the `/app/telegram` redirect — this is expected and part of your scope since you own these exact files. Specifically check and update as needed: `tests/unit/app-shell-foundation.test.ts`, `tests/unit/design-system-accessibility.test.ts`, `tests/unit/tenant-link-static-fallback.test.ts` (only the parts referencing domains/AppLayout/telegram — if this file also asserts on `orders.astro`/`OnboardingWizard.astro`, leave those specific assertions alone and only touch the parts relevant to files you own; report clearly what you left untouched and why).

## Do NOT touch (owned by parallel workstreams)
`src/pages/app/products.astro`, `orders.astro`, `orders/[id].astro`, `inventory.astro`, `customers.astro`, `members.astro`, `admin/*`, `src/components/workspace/DataTable.astro`, `src/components/dashboard/AutomationLedger.astro` (internal content), `src/pages/app/security.astro`, `src/pages/app/billing.astro`, `src/pages/app/data.astro`, any migration files, `src/styles/selinow-tokens.css`, the internal business logic of `src/pages/app/automation.astro`.

## Concrete requirements

### A. Navigation consolidation
Today `AppLayout.astro`'s "Sales channels" nav group has 8 entries (Website, Telegram, Integrations, Telegram Mini App, Zalo Mini App, Zalo OA, WhatsApp Cloud, Discord Bot), but 6 of them resolve to the same `/app/integrations` page via scroll-anchors, plus `/app/telegram` is a 307-redirect into that same page. This overstates functionality (pre-launch channels shown with equal visual weight as live ones) and requires a hash-matching hack in `AppLayout`'s `isCurrentItem` just to highlight nav correctly.

Fix: Collapse this into a clean structure, e.g.:
- One nav entry "Kênh bán / Channels" → a real `/app/integrations` (or renamed) page that internally uses tabs/sections (not sidebar items) to switch between Telegram, and the "coming soon" channel expansion cards clearly visually distinguished (e.g., a "Sắp ra mắt" / "Roadmap" section) from live/working integrations.
- One nav entry "Thanh toán / Payments" → PayOS connection, if you decide to split integrations.astro into multiple routes (recommended, since it's currently 490 lines mixing Telegram + PayOS + domain summary + full API-credential CRUD + 5 placeholder channel cards).
- One nav entry "API & Developer" → the existing API credential management UI (list/issue/revoke scoped credentials) extracted out of the mega-page.
- Remove the standalone `/app/telegram` nav entry entirely (delete or keep the file as a redirect-only safety net for old bookmarks, but it must NOT appear in the sidebar nav anymore).
- Domains stays its own top-level nav entry pointing to `/app/domains`; on `/app/integrations` only show a compact read-only summary card linking out to `/app/domains` (don't duplicate the full domain UI there).
- `/app/store/settings` nav entry: since it's a 1:1 redirect (not a fan-in like Telegram), you may simplify by pointing the nav `path` directly at `/app/store#store-settings` and removing the redirect page, OR keep the redirect if you judge it safer — your call, document the decision.

### B. Split `DomainManager.astro` (currently 989 lines)
This file today:
- Uses ONLY the legacy `--selinow-*` token namespace (not `--sln-*`) — migrate every value to `--sln-*` tokens (see `src/styles/selinow-tokens.css` for canonical names; `--selinow-*` are just aliases you should stop depending on in this component).
- Renders a marketing-landing-page-style oversized header ("07" eyebrow + `clamp(36px,5vw,56px)` heading) — replace with `PageHeader.astro` (already used consistently by sibling pages) for visual consistency.
- Hand-rolls buttons/badges/permission-notes that duplicate existing primitives — replace with `Button.astro`, `StatusBadge.astro`, and the appropriate `src/components/states/*.astro` components (`PermissionState`, `PlanLimitState`, `SuspendedState`, `ErrorState`, `EmptyState`) instead of custom `.permission-note`/`.entitlement-note`/`.suspended-note`/`.list-error` CSS.
- Duplicates DOM structure between SSR markup and a client-side `<template data-domain-template>` for re-rendering — consolidate to a single source of truth for the card markup if practical (e.g., a shared render function, or fully client-rendered after initial SSR skeleton — your call, but eliminate the duplicate-markup-drift risk).
- Has ~580 lines of inline `<script>` — extract this into `src/scripts/dashboard/domains.ts` (a new file), matching the separation pattern already used by `src/scripts/dashboard/automation` and `src/scripts/dashboard/integrations.ts`.
- Split into smaller sub-components as listed above (`DomainList`, `DomainConnectForm`, `DomainDeleteDialog`, `DomainGuide`) each under ~200 lines, composed from `domains.astro`.
- Also add `PageHeader` to `domains.astro` itself (it currently has none, unlike every sibling page).

### C. `DomainLifecycle.astro`
Migrate its tokens from `--selinow-*` to `--sln-*` and, if low-effort, replace its hand-rolled status icon/tone logic with `StatusBadge.astro`.

### D. Rename check
`src/layouts/PlatformLayout.astro` is actually the **public marketing layout** (used by index.astro, pricing.astro, legal, privacy — nothing to do with admin). This is NOT in your ownership list (don't rename it — flag it in your report as a naming clarity issue for a future pass, since renaming it would touch marketing pages outside your scope).

## Required before you finish
- Run `npm run check`, `npm run lint`, `npm run test:unit` (or targeted vitest files touching your changed area), and `npm run build` from the `Selinow.com` project root. Fix failures caused by your changes.
- Verify no broken internal links: grep the repo for `"/app/telegram"` and `/app/integrations#channel-` references you may need to update elsewhere (but do NOT edit files outside your ownership list — if you find a reference in an out-of-scope file, report it instead of editing).
- Report: final nav structure (before/after), final route list (before/after), what you split `DomainManager.astro` into and line counts, token migration confirmation (grep count of remaining `--selinow-*` usages in your owned files, should be 0 or near-0 with justification), any pre-existing tests you updated and why, and full verification command results.
```

### 4.3 Brief D3-A — Bảo mật tài khoản (2FA) & lịch sử hoá đơn

```
Project: Selinow.com (Astro 7 + TypeScript strict + Cloudflare Worker + D1). Read `Selinow.com/AGENTS.md` fully first and follow it strictly. Critical rules for this task specifically: never log or persist plaintext secrets/OTP codes, use the existing WebCrypto-based hashing patterns already in the codebase (see `src/lib/core/crypto.ts`, `src/lib/auth/otp.ts`), all mutations need CSRF + session auth, migrations are forward-only and must never edit an already-numbered file.

## Your mission (Phase D3-A of a dashboard-wide redesign)
Build real account security features (the current `/app/security` page only has a session list + "revoke all" button — no 2FA, no password change, no login history) and add invoice/payment history + usage-vs-limit visualization to `/app/billing` (currently shows only current subscription state, no historical invoices even though `billing_invoices` already exists as a DB table).

## Important existing infrastructure to reuse (do not rebuild these)
- `src/lib/auth/otp.ts` already implements `createAndSendOtp` / OTP verification with a purpose enum that **already includes `"login_2fa"`** (see `OtpPurpose` type and the `auth_email_otps` table in `migrations/0098_auth_email_otp_system.sql`). Build email-OTP-based 2FA using this existing purpose and table — do NOT build TOTP/authenticator-app 2FA from scratch; email OTP as a second factor is the right scope here given existing infra.
- `migrations/0098_auth_email_otp_system.sql` already added `password_hash`, `failed_login_count`, `locked_until`, `email_verified_at` etc. to `platform_users`, plus `password_reset_tokens` table. Reuse these column names; read this file and `src/lib/auth/*.ts` fully before writing any new migration.
- `migrations/0072_platform_billing.sql` already defines `billing_invoices` (and `billing_accounts`, `billing_checkout_sessions`, `subscription_events`). Read this migration and `src/lib/billing/service.ts` fully — the invoice history feature should primarily be a new read query + UI, not a new table, unless you find the existing schema genuinely cannot support "list invoices for shop X ordered by date with amount/status" (unlikely — verify by reading the CREATE TABLE columns before concluding a migration is needed).
- `migrations/0073_usage_metering.sql` defines `usage_counters`/`usage_events` — billing.astro's usage section should pull from here if not already; pair each usage metric with its corresponding limit (already fetched per the current file) into one visual (e.g. progress bar / "342 of 500").
- Login history: check if any existing table/log already captures login attempts (grep `login` across `src/lib/auth/`, `src/lib/security/`) before adding a new table.

## Files you OWN (only touch these; do not touch anything else in the repo)
- New migration file, exactly numbered `migrations/0099_account_security_hardening.sql` (reserved for you — do not use any other number; if you discover `0099` is already taken when you start, stop and report immediately instead of guessing a different number).
- `src/lib/auth/` — new files as needed (e.g. `src/lib/auth/two-factor.ts`, `src/lib/auth/login-history.ts`, `src/lib/auth/password.ts`), plus minimal necessary edits to existing files (`session.ts`, `otp.ts`) to wire in 2FA-required login step and login-history recording. Do not touch `src/lib/auth/admission.ts` or `src/lib/auth/email.ts` unless strictly necessary; if you must, keep the diff minimal and report it.
- `src/lib/billing/` — extend with an invoice-listing query/service function; extend `metering.ts` usage aggregation for the paired usage/limit view if needed.
- `src/pages/api/app/account/` (new directory) or an equivalent existing account-settings API path you find — new routes for: enable/disable 2FA (request+verify OTP), change password (require current password), list login history, list sessions (if not already covered elsewhere — check `src/pages/app/security.astro`'s existing session API first, reuse it, don't duplicate).
- `src/pages/api/auth/login.ts` (or wherever the login POST handler lives — find it) — minimal, careful edit to add the 2FA challenge step when a user has 2FA enabled. This is sensitive: do not weaken existing lockout/rate-limit protections, and ensure the OTP verification step happens server-side before a session is issued.
- `src/pages/app/security.astro` — rebuild as: Sessions (existing) + 2FA enrollment/management + Password change + Login history, organized as tabs or clearly separated sections (avoid making one giant flat page).
- `src/pages/app/billing.astro` — add an invoice/payment history panel (list: date, amount, status, downloadable/viewable reference if the schema has one) and merge the existing separate usage list + limits list into paired progress indicators.
- New tests under `tests/unit/` and/or `tests/integration/` for all new server logic (2FA enable/verify/disable, password change, login history recording, invoice listing) — this is required, not optional, given the security sensitivity.

## Do NOT touch (owned by parallel workstreams)
`src/layouts/AppLayout.astro`, `src/pages/app/integrations.astro`, `src/pages/app/automation.astro`, `src/components/dashboard/AutomationLedger.astro`, `src/pages/app/domains.astro`, `src/components/dashboard/DomainManager.astro`, `src/components/dashboard/DomainLifecycle.astro`, `src/pages/app/telegram.astro`, `src/pages/app/store/settings.astro`, `src/pages/app/products.astro`, `orders.astro`, `orders/[id].astro`, `inventory.astro`, `customers.astro`, `members.astro`, `admin/*`, `src/components/workspace/DataTable.astro`, `src/pages/app/data.astro`, any migration file other than your own `0099`, `src/styles/selinow-tokens.css`.

## Concrete requirements
1. **2FA (email OTP-based)**: user can enable it from `/app/security` (requires verifying one OTP to confirm enrollment), can disable it (requires re-authentication / current-password or OTP confirmation, not a bare toggle), and once enabled, login requires: password → OTP sent to email → verified → session issued. Must not break existing password-only login for users who haven't enabled 2FA. Must respect existing lockout counters and rate limits — do not let 2FA verification become a new brute-force vector (apply the same `OTP_MAX_ATTEMPTS`/cooldown pattern already in `otp.ts`).
2. **Password change**: requires current password verification (reuse the existing password-hash verification/timing-defense pattern from `otp.ts`/login logic — do not write new ad hoc hashing code, reuse `src/lib/core/crypto.ts`), then updates `password_hash`, and per the existing "Session Revocation" pattern noted in `docs/IMPLEMENTATION_STATUS.md` for password reset, revoke other active sessions on change (keep the current session alive).
3. **Login history**: record successful and failed login attempts (timestamp, coarse IP/user-agent if already captured elsewhere in the request pipeline, outcome) and list them read-only in Security — most recent first, reasonable pagination/limit (e.g. last 20-50), no PII beyond what's already logged elsewhere in the app.
4. **Billing invoice history**: list past `billing_invoices` rows for the shop (date, amount, status) with an empty state if none exist yet (many shops will have zero invoices — do not treat this as an error).
5. **Usage/limit pairing**: for each metric that has both a usage value and a limit value already available to `billing.astro`, render one combined indicator (e.g., progress bar or "X / Y" with percentage) instead of two separate flat lists.
6. Use `Button.astro`, `Input.astro`, `SecretField.astro` (for password fields), `Alert.astro`, `WorkspaceState.astro`/state components, and the i18n translator pattern already used in `security.astro`/`billing.astro` — do not hand-roll new button/input CSS.
7. All new API routes must validate CSRF, session, and tenant/user scoping exactly like neighboring routes already do (copy the pattern from an existing route in `src/pages/api/app/` — do not invent a new auth pattern).

## Required before you finish
- Run `npm run check`, `npm run lint`, `npm run test:unit` (and `npm run test:integration` if you touch anything under that suite's scope), and `npm run build` from the `Selinow.com` project root. Fix failures caused by your changes.
- Report: exact migration SQL you added (full contents), new API routes with method/path, how 2FA login flow works end-to-end, what "login history" data source you used, confirmation that `billing_invoices` schema was sufficient (or exact gap found), and full verification command results (pass/fail with error excerpts if any failed). Explicitly state you did not weaken any existing lockout/rate-limit/session-revocation guarantee.
```

### 4.4 Brief D3-B — Automation rule-builder thật

```
Project: Selinow.com (Astro 7 + TypeScript strict + Cloudflare Worker + D1). Read `Selinow.com/AGENTS.md` fully first and follow it strictly (tenant isolation via shop_id, CSRF on mutations, idempotency, no logging/exposing secrets or credentials, forward-only numbered migrations only — never edit an already-applied migration file).

## Your mission (Phase D3-B of a dashboard-wide redesign)
The product owner has confirmed: `/app/automation` must become a **real, seller-facing "if this then that" rule builder** (trigger → condition → action), not just the current read-only system-task ledger it is today. Build this as a genuine new capability while reusing the existing durable task-execution engine as the action-execution backend rather than building a second parallel execution system.

## Critical existing architecture to understand FIRST (read fully before designing anything)
- `src/lib/automation/types.ts`, `registry.ts`, `orchestrator.ts`, `executors.ts`, `scheduler.ts`, `d1-repository.ts`, `api-service.ts`, `policy.ts` — this is a durable, lease/claim/retry, capability-code-based task execution engine currently used for internal provisioning tasks (shop setup steps, domain checks, provider verification retries). It already has: idempotency keys, expected-version optimistic concurrency, tenant (`shopId`) scoping, audit log linkage, and a capability registry (`AutomationCapabilityDefinition` with `level: "automatic" | "approval_required" | "external_action" | "unsupported"`).
- **Your rule-builder should NOT duplicate this execution engine.** Instead: when a seller-defined rule's trigger fires and its conditions match, your new rule-evaluation layer should call the existing `AutomationOrchestrator.start()` to create a task, using a NEW capability code you register for each supported action type (e.g. `rule_notify_telegram`, `rule_call_webhook`, `rule_tag_customer`, `rule_create_task`). This reuses the existing retry/idempotency/audit infrastructure for actually *executing* actions, while your new layer only owns *rule definitions* and *trigger matching*.
- `src/lib/events/append.ts` and how order/payment/inventory lifecycle events are currently recorded/dispatched (grep for where order status transitions, payment confirmation, and stockout are handled in `src/lib/commerce/`, `src/lib/payments/`, `src/lib/catalog/`) — your trigger matching must hook into this existing event flow rather than polling or duplicating business logic. Find the lowest-risk integration point (e.g., after an order is marked paid, after fulfillment completes, after a variant goes out of stock) and call your rule-matching function from there, being careful not to introduce a new blocking dependency into the critical checkout/payment path — prefer a fire-and-forget or queued pattern consistent with how this codebase already handles non-critical side effects (check if a Cloudflare Queue is already used for anything similar, per `wrangler.jsonc` and `src/worker.ts`).
- `src/pages/app/automation.astro` and `src/components/dashboard/AutomationLedger.astro` are the CURRENT UI — you will extend `automation.astro` to add a "Quy tắc / Rules" tab alongside the existing ledger (keep the ledger as a "Nhật ký / History" tab, it remains useful as the execution history for rule-triggered tasks too). Apply the primitive-adoption fixes noted below to `AutomationLedger.astro` while you're in there.

## Files you OWN (only touch these; do not touch anything else in the repo)
- New migration file, exactly numbered `migrations/0100_automation_rule_builder.sql` (reserved for you — do not use any other number; if you discover `0100` is already taken when you start, stop and report immediately instead of guessing a different number). Design tables for: rule definitions (id, shop_id, name, trigger_type, conditions as structured JSON with a documented schema, enabled flag, created/updated audit fields, version for optimistic concurrency), and rule run history if not fully covered by reusing the existing `automation_tasks` table (prefer reusing `automation_tasks` for execution history — only add a new table if you need to link a task back to the rule that created it, e.g. a `rule_id` reference column or a small join table).
- `src/lib/automation/rules/` (new directory) — rule CRUD service, trigger registry (start with a focused, honest set: `order.paid`, `order.fulfilled`, `payment.failed`, `inventory.low_stock`, `customer.created` — do not invent triggers the backend can't actually detect), condition evaluator (keep condition schema simple and safe: field/operator/value comparisons against the event payload, no arbitrary code execution), and action dispatch (calls into `AutomationOrchestrator.start()` with new capability codes as described above).
- New capability registrations in `src/lib/automation/registry.ts` and new executor implementations in `src/lib/automation/executors.ts` for the action types you support (`rule_notify_telegram` reusing existing Telegram send capability if one already exists — check `src/lib/telegram/` first and delegate to it rather than reimplementing Telegram API calls; `rule_call_webhook` with SSRF-safe URL validation and no credential leakage in logs; `rule_tag_customer` writing to the existing customer record; `rule_create_task` as a generic fallback that just creates a visible manual-review task).
- `src/pages/api/app/shops/[shopPublicId]/automation/` (new subdirectory) — REST routes for rule CRUD (list/create/update/toggle-enabled/delete) with CSRF, session, tenant, and role checks matching the pattern of neighboring routes in `src/pages/api/app/shops/[shopPublicId]/`.
- `src/pages/app/automation.astro` (extend with new Rules tab; keep existing ledger behavior working)
- `src/components/dashboard/AutomationLedger.astro` (apply primitive adoption: replace hand-rolled empty-state with `EmptyState`/`StatePanel`, replace `.sln-button-primary`/`.sln-button-danger` local CSS with `Button.astro`)
- New components under `src/components/dashboard/automation/` (e.g. `RuleList.astro`, `RuleForm.astro`, `RuleBuilderDialog.astro`)
- New client script `src/scripts/dashboard/automation-rules.ts` if needed (check existing `src/scripts/dashboard/automation` for the established pattern first, follow it).
- New tests under `tests/unit/` and/or `tests/integration/` for rule CRUD, trigger matching, and condition evaluation — required given this is new business logic with tenant-isolation and idempotency implications.

## Do NOT touch (owned by parallel workstreams)
`src/layouts/AppLayout.astro`, `src/pages/app/integrations.astro`, `src/pages/app/domains.astro`, `src/components/dashboard/DomainManager.astro`, `src/components/dashboard/DomainLifecycle.astro`, `src/pages/app/telegram.astro`, `src/pages/app/store/settings.astro`, `src/pages/app/products.astro`, `orders.astro` (but you MAY need to read, not edit, wherever order-paid/fulfilled transitions happen to find your trigger hook point), `orders/[id].astro`, `inventory.astro`, `customers.astro`, `members.astro`, `admin/*`, `src/components/workspace/DataTable.astro`, `src/pages/app/security.astro`, `src/pages/app/billing.astro`, `src/pages/app/data.astro`, any migration file other than your own `0100`, `src/styles/selinow-tokens.css`.

## Concrete requirements
1. Rule model: name, one trigger type, zero-or-more conditions (AND-combined for v1, document that OR/nesting is a documented future gap, don't overbuild), one-or-more actions, enabled/disabled toggle, tenant-scoped (`shop_id`), owner/manager can create/edit, all roles can view (match existing role visibility patterns in `AppLayout.astro`/other automation-adjacent pages — check role gating conventions, e.g. `roles: ["owner", "manager"]` seen elsewhere).
2. Every rule action execution must be idempotent and auditable exactly like existing automation tasks (reuse the orchestrator's guarantees — do not weaken them).
3. Trigger matching must fail safe: if rule evaluation throws or a condition is malformed, log/record the failure without blocking or breaking the underlying business event (order payment, fulfillment, etc. must always complete regardless of automation rule health).
4. No arbitrary user-supplied code execution, no SSRF-unsafe webhook calls (validate/sanitize target URLs), no leaking Telegram bot tokens/PayOS credentials/webhook secrets into rule definitions, logs, or the UI.
5. UI: Rule list (name, trigger, enabled state, last-run summary), a rule create/edit form (trigger picker, condition builder limited to the safe operator set you define, action picker with per-action config fields), enable/disable toggle, delete with `ConfirmDialog.astro`. Use `Button.astro`, `StatusBadge.astro`, `SelectField.astro`, `Input.astro`, existing i18n translator pattern (`createDashboardTranslator` or the catalog used by `automation.astro` today) — do not hand-roll new form control CSS.
6. Keep the existing ledger/history tab functioning exactly as it does today (do not regress current automation-task cancel/resume behavior), just relocate it into a tab alongside the new Rules tab.

## Required before you finish
- Run `npm run check`, `npm run lint`, `npm run test:unit` (and `npm run test:integration` if applicable), and `npm run build` from the `Selinow.com` project root. Fix failures caused by your changes.
- Report: full migration SQL added, the trigger/condition/action model you implemented (with the exact safe schema), which existing systems you integrated with (Telegram sender, orchestrator capability codes registered), the exact event-pipeline hook point(s) you used and why they're safe/non-blocking, and full verification command results (pass/fail with error excerpts if any failed). Explicitly list any trigger type you considered but did NOT implement due to missing backend event visibility, so it can be tracked as a follow-up.
```

---

## 5. Việc còn lại sau khi 4 luồng trên hoàn thành (không giao cho 4 luồng, làm sau cùng — trước đây gọi là Phase D0/D4)

1. Xoá `OnboardingWizard.astro` + cập nhật 6 file test đang đọc nó (`tests/unit/app-shell-foundation.test.ts`, `design-system-accessibility.test.ts`, `i18n-call-site-contract.test.ts`, `onboarding-i18n-contract.test.ts`, `shop-name-frontend-contract.test.ts`, `tenant-link-static-fallback.test.ts`) để trỏ sang `OnboardingShell` + các bước hiện hành.
2. Xoá 11/13 file wrapper mỏng trong `src/components/states/` (đã xác nhận zero import).
3. Hợp nhất token: xoá tầng alias `--selinow-*` trong `src/styles/selinow-tokens.css` sau khi tìm-thay toàn bộ usage còn sót (lúc này D2 đã dọn phần domains, nên phạm vi còn lại sẽ nhỏ hơn nhiều).
4. Thêm 1 test/lint kiểu grep chặn tái diễn: cấm khai `.sln-button`/`.health-rail`/`.action-queue` cục bộ trong trang, cấm mã hex trần ngoài `selinow-tokens.css`.
5. Chạy full `npm run check && npm run lint && npm run test && npm run build && npm run deploy:dry-run` trên toàn repo sau khi gộp cả 4 luồng, xử lý xung đột tích hợp (nếu có), rồi cập nhật `docs/IMPLEMENTATION_STATUS.md`.

---

## 6. Tài liệu tham chiếu bắt buộc đọc trước khi triển khai

- `Selinow.com/AGENTS.md` — ràng buộc bắt buộc toàn dự án.
- `docs/DASHBOARD_UI_AUDIT_AND_REDESIGN_PLAN_2026-08-15.md` — báo cáo đánh giá chi tiết + bối cảnh đầy đủ (bảng tài sản có sẵn, đánh giá theo 5 nhóm vấn đề, nguyên nhân gốc rễ).
- `docs/FRONTEND_REDESIGN_BRIEF_VI.md` và `docs/frontend-prompt-os/**` — brief/spec redesign đã có từ trước (lưu ý: chỉ có 9 screen-spec cho khu WORKSPACE, thiếu Automation/Customers/Members/Billing/Security/Data/Admin — nên bổ sung spec cho các màn hình mới nếu có thời gian, nhưng không bắt buộc để bắt đầu code).
- `docs/IMPLEMENTATION_STATUS.md` — trạng thái xác thực gần nhất của toàn repo; cập nhật file này sau khi hoàn thành từng luồng theo đúng quy ước đã có.

**Không có gì trong repo bị để lại ở trạng thái dang dở về mặt code** — đội tiếp theo có thể giao nguyên văn 4 bản brief ở mục 4 cho 4 agent/kỹ sư độc lập và bắt đầu ngay.
