# Báo Cáo Comprehensive E2E Audit — Seller Platform

**Ngày audit:** 2026-08-23 (Asia/Tokyo)<br>
**Branch/commit:** `chore/post-release-status-20260822` / `22bfd88`<br>
**Môi trường:** production read-only probes, repository/source audit, local quality gates, staging visual artifacts<br>
**Trạng thái tổng thể:** **🟠 NOT READY**

### Provenance Và Release Candidate Boundary

- **Production deployed state:** chỉ các quan sát Chrome/HTTP tại `selinow.com`, `app.selinow.com`, `api.selinow.com` và `a-tung.selinow.com`; không giả định production đang chạy đúng HEAD hoặc dirty source.
- **Clean committed candidate:** HEAD `22bfd88e4eb1215a3ec336f839c0c15d6e127a79`, có 114 tracked migrations và thiếu `0113`; đây là nguồn của BUG-032.
- **Dirty worktree snapshot:** 29 changed/untracked paths tại thời điểm release probe; chứa checkout/billing/auth work đang làm song song. `migrations/0113_dodo_checkout_reconciliation.sql` SHA-256 `7a645a9b4a3c56e5bfb02c3838565c2ba02f29316578ed53fb413e8c2319672a`.
- **Không có candidate nào được deploy:** mọi finding source trên dirty tree là pre-deploy risk; production-only finding được ghi rõ Environment. Không dùng dirty tree làm release artifact.

## Executive Summary

Seller Platform có phạm vi chức năng rộng, cấu trúc tương đối rõ, nhiều API path đã kiểm tra giữ tenant scope tốt, và các gate static/build/deploy-dry-run trên dirty worktree đều xanh. Tuy nhiên hệ thống chưa sẵn sàng production vì payment/subscription có nhiều failure mode P1, toàn platform còn phục vụ plaintext HTTP mà không redirect/HSTS, rollback target hiện tại không tương thích với checkout-session state machine mới, clean commit hiện thiếu migration `0113`, onboarding có false-success và có thể đưa mã demo vào kho bán thật. Actual Chrome E2E còn xác nhận lỗi runtime ở required-field validation, automation rule creation, team loading, subscription-locked product UX, account-security session loading, invalid deep-link fallback và horizontal overflow trên Seller/public mobile; browser regression toàn diện vẫn chưa hoàn tất.

Tài khoản Seller production quan sát được trong actual Chrome walkthrough:

- Role: `Chủ shop` (Seller owner).
- Shop: `A Tùng`; public shop ID `shop_401025f6-8d6f-4757-8f51-3b3dcf4ddea0`.
- Subscription: `Pro / suspended`.
- Snapshot: 1 product, inventory 5 available tại threshold 5, **0 orders**, 0 customers.
- Telegram active; PayOS chưa connected; default domain ready; một custom domain expired/error.
- Website/Telegram visibility đang ẩn; Store Builder báo published/live trong khi Dashboard báo chưa publish.
- Public storefront fail-closed (`This store is being prepared`, ordering paused); catalog API trả `409 tenant_not_ready`, quote/checkout trả `402 subscription_required`.
- Onboarding completion, currency, timezone, tax, provider credential details, payment method/invoice và authenticated customer/other roles: **unknown/not inspected live**; production mutation và secret inspection không được phép.

Không xóa hoặc sửa dữ liệu production. Không thực hiện charge thật, đổi/hủy/khôi phục plan, domain mutation, webhook replay hoặc destructive action.

## Phạm Vi Và Coverage

| Khu vực | Đã discover | Đã thực thi/xác minh | Kết quả |
|---|---:|---:|---|
| Astro pages | 40 | 40 source-inventoried | 19 Seller workspace screens; public, auth, admin and legal routes also mapped |
| API routes | 166 | 166 source-inventoried | 101 Seller API routes; public store, auth, channel, admin and webhook routes included |
| Test files | 366 | 2939 Vitest tests invoked | 2934 pass, 5 fail (4 test-double defects, 1 concurrency timeout) |
| Migrations | 115 worktree / 114 tracked in HEAD | 0113-0115 reviewed | `0113` untracked làm clean HEAD sai migration ledger; no production migration run |
| Seller UI | 19 route files | 17/17 functional screens opened read-only; 5 routes + onboarding exercised sâu; 2/2 aliases tested | Deeper modal/form/state matrix remains incomplete; both aliases redirect but miss intended focus |
| Public storefront | Home/product/cart/checkout/orders | Production GETs + validation POSTs dừng trước mutation | Safe fail-closed state verified; no customer purchase possible for this shop |
| Responsive/a11y | 1440/768/390/320 artifacts and contracts | Staging suite + static contracts + actual Chrome at 320/390 px + limited keyboard checks | 8 pass / 12 fail; 41/41 contracts pass; actual horizontal overflow at 320/390 px; Tab/skip-link/focus/Escape pass in bounded checks |
| Billing/checkout | Dodo source and focused tests | 153/153 focused tests | Multiple confirmed state-machine/recovery risks |
| Roles | Seller/guest/admin boundary | Owner session + guest/401 probes + direct `/admin` access | Seller owner denied admin console; Seller routes redirect unauthenticated; Seller APIs return 401 |
| Integrations | Payment, Telegram, Zalo, API credentials, webhooks, shipping, automation | Source/API inventory + live read-only provider states + automation create attempt | Telegram active, PayOS disconnected; automation create failed; no external connect/disconnect mutation |

### Exact Execution Counts

| Asset | Discovered | Executed/verified | Blocked or source-only |
|---|---:|---:|---:|
| Seller screens | 19 route files (17 + 2 aliases) | 17 functional routes opened read-only; deeper live actions on Products, Billing, Automation, Members, Security + onboarding; both aliases exercised | All modals/actions/states were not live-clicked; risky mutations remain blocked |
| Features/modules | 28 audit groups: 17 functional Seller screens + 11 cross-cutting journeys/integration groups | All 17 Seller screens opened live; 9 surfaces received deeper action/state checks; aliases/public routes also exercised | Full action completion count không claim do groups overlap; xem journey/addendum tables |
| Critical user flows | 11 mapped | 11 received at least a read-only, negative or fail-closed live observation; none is claimed fully covered | Financial/destructive success paths, domain mutation and external provider lifecycle remain blocked |
| API flows | 166 route files | 164 focused **test cases** across API/tenant suite + production probes | 164 không đồng nghĩa 164 distinct endpoints; external/mutating flows remain blocked |
| Roles | Seller owner, unauthenticated guest/admin boundary | Owner session + guest/401/redirect probes + Seller owner denied `/admin` | Second tenant, manager, support, viewer, authenticated admin/customer sessions |
| Responsive states | 4 widths (1440/768/390/320) | 20 staging cases + 41 static contracts + production Products/storefront at 320 px and Seller at 390 px | Actual document/internal overflow found; full route/tablet/landscape/zoom matrix remains blocked |
| Integrations | 9 integration surfaces | Inventory/source contracts | Connect/auth/disconnect/retry against real providers |

### Verification Command Log

Detailed command outputs and probes are preserved in `qa-artifacts/seller-audit-2026-08-23/verification-command-log.txt`. Summary: `npm run check` PASS; `npm run lint` PASS; `npm run build` PASS; `npm run deploy:dry-run` PASS but only local Wrangler dry-run; `npm audit --audit-level=high` 0 vulnerabilities; full Vitest 2934/2939 pass; focused billing/security 153/153 pass; focused API/tenant 164/164 pass; onboarding focused 91/91 pass; static UI contracts 41/41 pass; staging visual/a11y 8 pass / 12 fail; security scanner is heuristic and reports test-fixture false positives that require triage.

### Evidence Index

| Finding / coverage | Evidence |
|---|---|
| BUG-001 | `qa-artifacts/seller-audit-2026-08-23/http-transport-security-probes.txt` |
| BUG-013 + production subscription snapshot | `qa-artifacts/seller-audit-2026-08-23/production-billing-phantom-operation.jpg`, `production-state-api-probes.txt` |
| BUG-032 | `qa-artifacts/seller-audit-2026-08-23/release-migration-ledger-probes.txt` |
| BUG-040 | `qa-artifacts/seller-audit-2026-08-23/live-onboarding-empty-name-advanced.jpg` + bounded Chrome observation before/after refresh |
| BUG-041 | `qa-artifacts/seller-audit-2026-08-23/live-automation-rule-invalid-contract.jpg` + bounded Chrome create attempt |
| BUG-042 | `qa-artifacts/seller-audit-2026-08-23/live-members-load-failure.jpg` |
| BUG-043 | `qa-artifacts/seller-audit-2026-08-23/live-product-create-blocked.jpg`, `live-product-editor-save-blocked.jpg` |
| BUG-044 | `qa-artifacts/seller-audit-2026-08-23/live-security-token-invalid.jpg` |
| BUG-045 | `qa-artifacts/seller-audit-2026-08-23/live-products-authenticated-320.jpg`, `live-products-mobile-320.jpg`, `live-storefront-mobile-320.jpg`; live execution ledger |
| BUG-046 | `qa-artifacts/seller-audit-2026-08-23/live-browser-e2e-execution.txt` (fake product/shop direct-link observations) |
| BUG-002–009, 014–039 | Source line references in each entry + focused test names; no production financial/destructive mutation performed |
| Actual Chrome execution ledger | `qa-artifacts/seller-audit-2026-08-23/live-browser-e2e-execution.txt` — 17 Seller screens, 2 aliases, public routes, negative, responsive, accessibility and authorization observations |
| Production responsive evidence | `qa-artifacts/seller-audit-2026-08-23/live-products-authenticated-320.jpg`, `live-storefront-mobile-320.jpg`; companion captures in `live-products-mobile-320.jpg`, `live-storefront-blocked-journey.jpg`; overflow documented in execution ledger |
| Responsive/a11y | Staging visual/a11y run (8/12), static contract suite (41/41), actual production 320/390 px và bounded keyboard evidence; không claim những route/state chưa được thực thi |
| Heuristic security scan triage | `qa-artifacts/seller-audit-2026-08-23/security-scan-triage.txt` |

## Inventory Màn Hình Seller

Seller workspace có 19 route file: 17 màn hình chức năng và 2 alias. Các route chức năng gồm `/app`, `/app/products`, `/app/inventory`, `/app/orders`, `/app/orders/:id`, `/app/customers`, `/app/store`, `/app/billing`, `/app/payments`, `/app/domains`, `/app/integrations`, `/app/bookings`, `/app/automation`, `/app/members`, `/app/security`, `/app/data`, `/app/developer`. `/app/store/settings` redirect về Store Builder và `/app/telegram` redirect về Integrations.

Các dependency/action đã discover gồm catalog/product/variant/image/inventory lifecycle, category/visibility, server-side search/sort/pagination/CSV export, order/fulfillment/message/note/shipping, customer/privacy, storefront draft/publish/template settings, billing plan/preview/checkout/portal/operation, PayOS health/remediation, domain/DNS/SSL/primary, Telegram/Zalo/channel credentials, booking, automation rule/task, team invitation, 2FA/password/login history, export/deletion và API credential issue/revoke.

Các state empty/error/loading được triển khai qua `WorkspaceState`, table primitives, dialog và toast region. Actual Chrome walkthrough đã kích hoạt một số error state thật, nhưng production-safety scope không cho phép kích hoạt mọi modal/action/state.

### Inventory Chi Tiết Theo Màn Hình

Ký hiệu: **R** = xác minh từ route/source/API contract; **L** = đã mở/quan sát live (độ sâu khác nhau theo execution ledger). Tất cả 17 route chức năng đã được mở read-only bằng Seller owner session; không suy ra rằng mọi action/modal/state trên route đó đã PASS.

| Route / title | Access & mục đích | Actions / form / modal | Data controls & states | Dependency/API chính | Related |
|---|---|---|---|---|---|
| `/app` — Overview (L/R) | Shop member; health, revenue, action queue | Open onboarding, orders, billing, catalog | Metrics/cards; no-shop, unavailable, partial dependency states; không pagination | Catalog, orders, readiness, subscription/dashboard services | Products, Orders, Store, Billing |
| `/app/products` — Products (L/R) | Owner/manager hiện được manage; catalog lifecycle | Create draft, edit, category, image/private-file upload, archive confirmation | Search, status, sort, page size, pagination; ledger/table; empty/forbidden/unavailable/success feedback | Catalog product/category/variant/media/stock APIs | Inventory, Storefront, Orders |
| `/app/inventory` — Inventory (L/R) | Owner/manager; digital key & stock operations | Low-stock threshold form; import dialog preview/confirm | Variant ledger; empty/forbidden/unavailable/import validation/success; no server pagination | Catalog projection, inventory preview/confirm, low-stock settings | Products, Checkout, Fulfillment |
| `/app/orders` — Orders (L/R) | `orders` visibility + optional `payments:read`; triage/order list | Export/open detail; inspect payment exceptions | Search, status, sort, page size, pagination; empty/forbidden/unavailable | Seller orders page, payment reconciliation exceptions | Order detail, Customers, Payments |
| `/app/orders/:id` — Order Detail (L/R) | Role-masked order read; owner/manager mutate fulfillment/payment | Shipping actions, manual fulfillment form, payment remediation form | Item ledger + payment/fulfillment/audit timelines; not-found/forbidden/error/empty | Order detail, shipping, manual fulfillment, remediation | Orders, Customers, Inventory |
| `/app/customers` — Customers (L/R) | Customer read policy; privacy operations capability-dependent | Edit detail, note, anonymize, redact-confirm dialog, export | Search/sort/page size/pagination; drawer; empty/forbidden/unavailable | Customer list/detail/notes/privacy APIs | Orders, Data & Privacy |
| `/app/store` — Store Builder (L/R) | Member read; owner/manager edit, owner publish | Save content/brand/template/sections/shipping/layout/SEO/support; publish/preview | Tabs/panels, live preview; no-store/forbidden/unavailable/catalog-empty/error/saved | Storefront settings, catalog preview, publish/readiness | Public Storefront, Products, Domains |
| `/app/billing` — Subscription & Billing (L/R) | `billing:manage`, effectively owner for financial mutation | Market/currency form, plan dialog, checkout/portal, cancel dialog | Plan/usage/invoice/operation ledgers; no-store/forbidden/unavailable/pending/error | Billing projection, plans, checkout status, portal, operations | Payments, Dashboard, Entitlements |
| `/app/payments` — Payment Provider (L/R) | `payments:read`; owner connect/update/disconnect | PayOS credential form/config panel, disconnect | Provider status/health; no-store/read-only/error/configured | Payment integration APIs, secret encryption/health | Billing, Checkout, Integrations |
| `/app/domains` — Domains (L/R) | Owner-only mutation | Add/verify/primary/remove domain; confirmation/status controls in `DomainManager` | Domain ledger; not-configured/pending/verified/SSL/DNS/error; no pagination | Domain/DNS/custom-hostname APIs | Store Builder, Public Storefront |
| `/app/integrations` — Integrations (L/R) | Owner provider/domain management; owner/manager channel requests; read varies by capability | Telegram config/disconnect, channel expansion, links to payments/domains/developer | Provider cards/config panel; no-store/read-only/error/connected | Telegram/Zalo/channel catalog/request, provider health | Payments, Domains, Developer, Automation |
| `/app/bookings` — Bookings (L/R) | Any shop member read; owner/manager complete/cancel/no-show | Inline lifecycle actions | Async list; loading/empty/error; no pagination; mobile single-column actions | Booking list/status APIs | Products, Orders, Customers |
| `/app/automation` — Automation (L/R) | Role-based task read/rule manage | Create/edit/toggle/delete rules; retry/cancel tasks where permitted | URL-backed Rules/History tabs; ledgers; no-store/forbidden/unavailable/empty | Automation rule/task services and APIs | Integrations, Orders, Inventory |
| `/app/members` — Team & Permissions (L/R) | Member list; owner manages team | Invite form, change role, suspend confirm, resend/revoke invite | Member/invitation ledgers; empty/forbidden/unavailable/pending/success | Member/invitation APIs with versioning | Security, Data, all RBAC screens |
| `/app/security` — Account Security (L/R) | Authenticated account; account-scoped, selected shop only for shell | Link Google, revoke sessions, 2FA enable/disable/recovery, password change | Session/login-history lists; empty/error/success; no pagination | Auth session, OAuth, 2FA, password, login-history APIs | Login/Register, Members |
| `/app/data` — Data & Privacy (L/R) | Owner-only destructive/export workspace; sub-capability states | Request export, deletion form/confirmation, inspect abuse/audit | Export/deletion/abuse/audit ledgers; owner-only/empty/forbidden/unavailable | Export, deletion, abuse, seller-audit services/APIs | Customers, Security, Developer |
| `/app/developer` — Developer/API Credentials (L/R) | Member read; owner issues/revokes credentials | Credential create form, one-time secret reveal, revoke | Credential ledger; no-store/read-only/empty/error/success | API credential issue/list/revoke APIs | Integrations, Webhooks/Public API |

Hai alias không phải screen độc lập: `/app/store/settings` → `/app/store?focus=settings#store-settings`, `/app/telegram` → `/app/integrations?focus=telegram#telegram`; BUG-017 mô tả focus target không được honor. Inventory modal/drawer/popover/action được source-map, nhưng không tuyên bố đã click live toàn bộ.

## Critical User Journeys

| Journey | Trạng thái | Evidence/ghi chú |
|---|---|---|
| Existing Seller authentication | Partial pass | Existing session was preserved; direct unauthenticated Seller routes return `302 /login`; Seller APIs return `401 authentication_required`. |
| Onboarding/resume/persistence | **Partial fail** | Existing Seller advances to Step 2 with required shop name empty; refresh restores Step 1 and authoritative name `A Tùng` (BUG-040). Full New Seller signup/OTP/onboarding remains blocked. |
| Store setup → publish | **Inconsistent** | Store Builder showed “published/live”; Dashboard showed “not published”; public catalog was unavailable and shop was not sellable. |
| Product create/edit/publish lifecycle | Partial fail-safe | Create draft and edit save were attempted for suspended Seller; backend rejected both with `subscription_payment_required`, but enabled controls and raw errors mislead the Seller (BUG-043). No mutation succeeded. |
| Product → public storefront | Fail-closed | Public pages deliberately hide draft catalog and explain ordering is paused. This is safe but terminology conflicts with Seller UI. |
| Guest → cart → checkout → order | Blocked for current shop | Public UI returns paused state; API quote/checkout fail with `402 subscription_required`. No payment attempt made. |
| Orders/fulfillment | Read-only only | Orders UI reported 0 orders; fake order deep link returned a clear 404. No real order/fulfilment mutation was possible. |
| Subscription upgrade/downgrade/cancel/reactivate | **Not safe to execute in production** | Dodo provider is `provider_pending`; billing source has P1 recovery/expiry/rollback risks. |
| Domain/DNS/custom domain | Read-only only | Default domain ready and one custom domain expired/error were observed; no DNS/domain mutation or propagation verification. |
| Integrations | Partial fail | Automation rule creation was attempted with Telegram action and failed with an invalid-response contract; no rule was created (BUG-041). External provider authentication remains untested. |
| Permission/tenant isolation | Partial pass | 164/164 focused API tests pass; cross-tenant isolation nhìn chung tốt, nhưng intra-tenant RBAC và hierarchy defects đã xác nhận. |

## Actual Chrome E2E Addendum

Phần này chỉ ghi nhận hành vi quan sát trực tiếp bằng Chrome production với session Seller hiện có. Source references được dùng để khoanh vùng khả năng nguyên nhân, không được nâng thành bằng chứng production nếu browser/network chưa xác nhận.

| Surface/flow | Thao tác production an toàn | Kết quả runtime thực tế | State sau thao tác |
|---|---|---|---|
| Existing Seller onboarding | Xóa shop name đang hiển thị, bấm Continue, sau đó refresh | UI tiến sang Step 2 dù field required rỗng; refresh quay về Step 1 và server projection phục hồi `A Tùng` | Không quan sát thấy empty name persist hoặc duplicate shop; BUG-040 |
| Automation rule | Nhập tên `QA E2E Rule 202608221914`, chọn paid-order trigger, Telegram action và message, rồi Save | Form vẫn giữ hidden required `actionUrl`; submit báo “Server trả dữ liệu không đúng định dạng” | Không có rule mới được tạo; BUG-041 |
| Team/Members | Mở `/app/members` bằng Seller owner session | Workspace hiển thị “Chưa thể tải thành viên” thay vì membership ledger | Không có stale member data được render; root cause cần network/server trace; BUG-042 |
| Product create/edit entitlement | Mở create draft và edit product, submit với subscription `Pro / suspended` | Cả hai control vẫn enabled; submit mới bị backend từ chối bằng `subscription_payment_required` | Backend fail-closed, không có product mutation thành công; UX/contract defect là BUG-043 |
| Account Security | Direct reload `/app/security`, sau đó bấm “Làm mới phiên” và đổi tab | `token_invalid` vẫn còn với request ID mới; history/password giữ error và session list không thoát loading | Không đọc hoặc expose token/cookie; BUG-044 |
| Billing suspended state | Mở `/app/billing` | Phantom “Đang cập nhật gói” vẫn hiển thị dù không có operation/invoice tương ứng | Runtime reconfirm của BUG-013, không tạo bug trùng |
| Responsive 320/390 px | Capture authenticated Products/Seller workspace and public storefront | Document-level horizontal overflow occurs at 320 px on Products and storefront; internal workspace overflow occurs at 390 px; Products labels truncate | BUG-045; full viewport matrix remains blocked |
| Keyboard accessibility | Start Tab navigation; open a dialog and press Escape | Skip link is the first focus target with visible focus; Escape closes the tested dialog | Limited PASS only; full tab order/trap/screen-reader/axe still blocked |
| Authorization/deep links | Open `/admin`, fake order ID, fake product deep link and fake shop selector | Seller owner is denied admin; fake order is clear 404; fake product silently falls back to list and fake shop silently falls back to real shop | Security boundary positive checks + confusing fallback BUG-046 |

## Danh Sách Bug Đã Xác Nhận

**Bug-report convention:** First observed cho toàn bộ findings là `2026-08-23` trong audit này; `Reproducible: Yes` cho source-deterministic findings, `Partial/Blocked` khi cần live provider/browser state; các field không áp dụng được ghi `N/A` thay vì suy đoán. Source-only findings không được coi là production incident đã xảy ra.

| Severity | Count | IDs |
|---|---:|---|
| P0 Blocker | 0 | — |
| P1 Critical | 10 | 001, 002, 003, 004, 014, 018, 019, 026, 032, 033 |
| P2 Major | 28 | 005–009, 015–016, 020–023, 025, 027–031, 034–036, 038–045 |
| P3 Minor/Cosmetic/QA | 8 | 010–013, 017, 024, 037, 046 |
| P4 Cosmetic | 0 | — |

Để giữ phần chính đọc được, matrix `qa-artifacts/seller-audit-2026-08-23/bug-field-completion.tsv` hoàn thiện field cho BUG-001–039; BUG-040–046 được ghi đầy đủ mọi field bắt buộc ngay dưới đây. Tổng cộng **46 bugs**; source-only findings không được trình bày như actual Chrome E2E.

### BUG-040 — Existing-shop onboarding advances with an empty required store name

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Existing Seller onboarding / validation and persistence<br>
**Environment:** Production Chrome, existing authenticated session<br>
**Role:** Seller owner (`Chủ shop`)<br>
**URL:** `/onboarding`<br>
**Precondition:** Existing shop `A Tùng` is loaded at onboarding Step 1.

**Steps to reproduce:**
1. Clear the visible shop-name field.
2. Click Continue.
3. Observe that the flow advances to Step 2.
4. Refresh the browser and inspect the resumed step/value.

**Expected result:** Required-field validation blocks navigation, keeps Step 1 visible and explains that shop name is required.<br>
**Actual result:** UI advances to Step 2 with an empty visible required field. Refresh returns to Step 1 and restores authoritative value `A Tùng`, so the invalid value was not observed persisted.<br>
**Frequency:** 1/1 bounded production attempt.<br>
**First observed:** 2026-08-23<br>
**Reproducible:** Observed once; repeat was intentionally limited to avoid unnecessary production mutation.<br>
**Frontend impact:** Step state communicates success despite invalid input and conflicts with refresh state.<br>
**Backend impact:** No empty-name persistence observed; server projection appears to retain the previous name.<br>
**Business impact:** Seller can proceed under a false assumption that required store identity changes were accepted.<br>
**Security impact:** None identified.<br>
**Evidence:** `qa-artifacts/seller-audit-2026-08-23/live-onboarding-empty-name-advanced.jpg`; before/after refresh observation.<br>
**Suspected root cause:** The source contains an empty-name guard, so a visible-control/controller mismatch, duplicate controller, or state/event race is more likely than a simple missing check; requires browser event and request trace.<br>
**Recommended fix:** Bind validation to the submitted visible control, prevent step transition until a successful authoritative projection is returned, and add empty/whitespace/refresh E2E coverage.<br>
**Regression risk:** Tightening validation may affect existing-shop resume and localized input; cover new shop, existing shop, Unicode, whitespace and back/refresh navigation.

### BUG-041 — Automation rule creation fails with invalid-response error and retains a hidden required webhook URL

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Automation rule editor / client-server contract<br>
**Environment:** Production Chrome, existing authenticated session<br>
**Role:** Seller owner (`Chủ shop`)<br>
**URL:** `/app/automation`<br>
**Precondition:** Automation workspace is accessible; Telegram action is selectable.

**Steps to reproduce:**
1. Create a rule named `QA E2E Rule 202608221914`.
2. Select paid-order trigger and Telegram action.
3. Enter the Telegram message and submit.
4. Observe the error and reload/list rules.

**Expected result:** Fields irrelevant to Telegram are not required, and a successful response projects the created rule; otherwise the UI shows a precise actionable server error.<br>
**Actual result:** The DOM retains a hidden required `actionUrl`, while submit returns “Server trả dữ liệu không đúng định dạng”. No rule is created.<br>
**Frequency:** 1/1 bounded production create attempt.<br>
**First observed:** 2026-08-23<br>
**Reproducible:** Yes in the observed configuration; no repeated rule creation was attempted.<br>
**Frontend impact:** Applicable fields and validation contract are ambiguous; generic response error prevents recovery.<br>
**Backend impact:** No rule record was observed created; exact response/status was not captured durably.<br>
**Business impact:** Seller cannot automate the paid-order Telegram workflow.<br>
**Security impact:** None identified.<br>
**Evidence:** `qa-artifacts/seller-audit-2026-08-23/live-automation-rule-invalid-contract.jpg`; `src/components/dashboard/automation/RuleForm.astro:100-114`; `src/scripts/dashboard/automation-rules.ts:98-114`; `src/scripts/dashboard/automation-rules.ts:353-390`; `src/scripts/dashboard/automation-rules.ts:535-569`.<br>
**Suspected root cause:** At least two contracts require investigation: form-field applicability leaves a hidden URL required, and the client rejects the returned rule projection. Runtime evidence does not prove one caused the other.<br>
**Recommended fix:** Remove/disable `required` for inactive action fields, validate a discriminated action schema server-side, normalize create response shape, and surface status/error code with retry guidance.<br>
**Regression risk:** Changes affect webhook and Telegram action variants; regression-test every trigger/action combination, edit/reload persistence, double-submit and 4xx/5xx responses.

### BUG-042 — Production Members workspace cannot load the membership ledger

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Team / Members<br>
**Environment:** Production Chrome, existing authenticated session<br>
**Role:** Seller owner (`Chủ shop`)<br>
**URL:** `/app/members`<br>
**Precondition:** Existing owner session has selected shop `A Tùng`.

**Steps to reproduce:**
1. Navigate directly to `/app/members`.
2. Wait for the membership workspace to finish loading.
3. Observe the rendered state, then activate the available retry action.
4. Wait for the second load attempt to finish.

**Expected result:** Owner sees the membership/invitation ledger or a truthful empty state.<br>
**Actual result:** Workspace renders “Chưa thể tải thành viên”; no membership ledger appears.<br>
**Frequency:** 2/2 initial and retry attempts in the bounded production session.<br>
**First observed:** 2026-08-23<br>
**Reproducible:** Yes; the in-page retry reproduced the same membership-query failure.<br>
**Frontend impact:** Team management is unavailable; UI correctly avoids rendering stale member data.<br>
**Backend impact:** Membership query or its projection failed; response/status was not captured, so root cause remains unknown.<br>
**Business impact:** Owner cannot inspect or manage staff permissions, invitations or account access.<br>
**Security impact:** Operational access review is impaired; no authorization bypass was demonstrated.<br>
**Evidence:** `qa-artifacts/seller-audit-2026-08-23/live-members-load-failure.jpg`.<br>
**Suspected root cause:** Unknown without request/response and server logs; possible membership API, selected-shop binding or projection failure.<br>
**Recommended fix:** Trace the request ID/status in production logs, restore the membership query, and provide a bounded retry action with diagnostic code.<br>
**Regression risk:** Team roles and tenant isolation are sensitive; cover owner/manager/support/viewer, no-shop, suspended member, invitation states and cross-shop IDs.

### BUG-043 — Suspended subscription leaves product mutations enabled and only rejects after submit

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Product management / subscription entitlement UX<br>
**Environment:** Production Chrome, existing authenticated session<br>
**Role:** Seller owner (`Chủ shop`), subscription `Pro / suspended`<br>
**URL:** `/app/products` and product editor<br>
**Precondition:** Seller is authenticated and product mutation entitlement is blocked by suspended subscription.

**Steps to reproduce:**
1. Open Products and start Create draft.
2. Submit the create form.
3. Open the existing product editor and submit Save.
4. Observe both results.

**Expected result:** If suspended Sellers are not entitled to mutate products, controls are disabled or intercepted before data entry with a clear billing-recovery CTA; backend remains fail-closed.<br>
**Actual result:** Create/edit controls remain enabled and accept input. Both submit operations then fail with raw `subscription_payment_required`.<br>
**Frequency:** 2/2 mutation attempts (create and edit).<br>
**First observed:** 2026-08-23<br>
**Reproducible:** Yes for both observed product mutation paths.<br>
**Frontend impact:** Seller spends effort in forms that cannot succeed and receives an implementation-style error instead of recovery guidance.<br>
**Backend impact:** Backend rejected both requests; no successful mutation or entitlement bypass was observed.<br>
**Business impact:** Suspended Seller cannot maintain catalog and lacks a direct path to resolve billing.<br>
**Security impact:** Positive fail-closed behavior; no unauthorized mutation found.<br>
**Evidence:** `qa-artifacts/seller-audit-2026-08-23/live-product-create-blocked.jpg`, `qa-artifacts/seller-audit-2026-08-23/live-product-editor-save-blocked.jpg`; `src/pages/app/products.astro:160`; `src/scripts/dashboard/products.ts:51-120`; `src/scripts/dashboard/products.ts:143-155`; `src/lib/tenants/store.ts:723-735`.<br>
**Suspected root cause:** Product UI gates actions by role/capability but not the authoritative subscription entitlement enforced by backend.<br>
**Recommended fix:** Project mutation entitlement into the page, disable/intercept create/edit/save consistently, preserve unsaved input where possible, and show a localized billing recovery CTA while retaining backend enforcement.<br>
**Regression risk:** Entitlement UI can become stale after plan changes; test active/trial/suspended/expired/canceled states, tab refresh, direct API requests and plan transition in a second tab.

### BUG-044 — Account Security remains token-invalid after refresh and session list never resolves

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Account Security / session lifecycle<br>
**Environment:** Production Chrome, existing authenticated session<br>
**Role:** Seller owner (`Chủ shop`)<br>
**URL:** `/app/security`<br>
**Precondition:** Current Seller session can access the authenticated workspace.

**Steps to reproduce:**
1. Directly reload `/app/security`.
2. Observe `token_invalid` and the session-list loading state.
3. Click “Làm mới phiên”.
4. Switch between security history/password tabs and observe state.

**Expected result:** Refresh obtains a usable account-security token/session projection or exits to a clear re-authentication flow; loading and stale errors resolve per tab.<br>
**Actual result:** `token_invalid` remains after refresh with a new request ID; history/password tabs retain the error and the session list remains indefinitely loading.<br>
**Frequency:** 2/2 initial/refresh attempts in the bounded session.<br>
**First observed:** 2026-08-23<br>
**Reproducible:** Yes within the observed session.<br>
**Frontend impact:** Session, login-history and password/security management are effectively unavailable.<br>
**Backend impact:** Refresh path returns another invalid-token result or fails to update the client credential; exact response was not captured.<br>
**Business impact:** Account owner cannot review or revoke sessions or confidently manage account security.<br>
**Security impact:** Security controls are unavailable, increasing exposure time if a session must be revoked; no token value or bypass was exposed.<br>
**Evidence:** `qa-artifacts/seller-audit-2026-08-23/live-security-token-invalid.jpg` including distinct request ID after refresh.<br>
**Suspected root cause:** Refresh/session credential propagation or tab-level error/loading state reset is broken; requires auth request and server-log correlation.<br>
**Recommended fix:** Make refresh rotate/propagate the credential atomically, terminate loading on every error, scope errors per tab, and fall back to explicit re-authentication when refresh cannot recover.<br>
**Regression risk:** Session rotation is security-critical; cover concurrent tabs, expired/revoked sessions, refresh replay, 401/403/500, logout-all and stale-tab behavior without logging secrets.

### BUG-045 — Seller and public storefront overflow horizontally at supported mobile widths

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Responsive layout / Seller Products / public storefront<br>
**Environment:** Production Chrome responsive viewport<br>
**Role:** Seller owner and public Guest<br>
**URL:** `/app/products`, Seller workspace at 390 px, `https://a-tung.selinow.com/`<br>
**Precondition:** Render the production pages at 320 px and 390 px viewport widths.

**Steps to reproduce:**
1. Set Chrome viewport to 320 px and open authenticated Products.
2. Inspect document width and Seller header/bottom-navigation labels.
3. Open the public storefront at 320 px and inspect document width.
4. Render the authenticated Seller workspace at 390 px and inspect the main content width.

**Expected result:** Layout remains within the viewport without document/internal horizontal scrolling; navigation labels remain understandable.<br>
**Actual result:** Products and public storefront have document-level horizontal overflow at 320 px; Seller workspace has internal horizontal overflow at 390 px. Shop/account and bottom-navigation labels truncate at 320 px.<br>
**Frequency:** 3/3 tested responsive surfaces/states.<br>
**First observed:** 2026-08-23<br>
**Reproducible:** Yes in captured production viewports.<br>
**Frontend impact:** Content and navigation require unintended horizontal movement; labels lose meaning at minimum width.<br>
**Backend impact:** None.<br>
**Business impact:** Mobile Sellers and shoppers may miss controls/content or abandon the journey.<br>
**Security impact:** None identified.<br>
**Evidence:** `qa-artifacts/seller-audit-2026-08-23/live-products-authenticated-320.jpg`, `qa-artifacts/seller-audit-2026-08-23/live-products-mobile-320.jpg`, `qa-artifacts/seller-audit-2026-08-23/live-storefront-mobile-320.jpg`, `qa-artifacts/seller-audit-2026-08-23/live-browser-e2e-execution.txt`.<br>
**Suspected root cause:** One or more shell/content children impose fixed or intrinsic minimum widths; truncated navigation also lacks a mobile label strategy. Exact element requires DOM width tracing.<br>
**Recommended fix:** Identify the widest overflowing element with `scrollWidth/clientWidth`, remove fixed/min-content constraints, constrain media/tables/forms, and design non-ambiguous compact labels.<br>
**Regression risk:** Overflow fixes can hide table actions or clip popovers; cover 320/360/390/768 px, zoom, long shop names, dialogs, tables and storefront sections.

### BUG-046 — Invalid product/shop deep links silently fall back to unrelated valid state

**Severity:** P3 Minor UX/diagnostic defect<br>
**Priority:** Medium-term<br>
**Module:** Seller routing / selected-shop and product deep links<br>
**Environment:** Production Chrome, existing authenticated session<br>
**Role:** Seller owner (`Chủ shop`)<br>
**URL:** Fake/nonexistent product deep link and Seller URL with fake shop selector<br>
**Precondition:** Seller is authenticated with real selected shop `A Tùng`.

**Steps to reproduce:**
1. Open a product deep link with a nonexistent product ID.
2. Observe that the product list appears without a not-found explanation.
3. Open a Seller route with a nonexistent/fake shop identifier.
4. Observe that the shell silently selects the real shop.

**Expected result:** Invalid resources/selectors produce a clear 404, invalid-selection notice or explicit redirect explaining the fallback.<br>
**Actual result:** Fake product silently becomes the product list; fake shop silently falls back to the real selected shop. By contrast, a fake order ID correctly produces 404.<br>
**Frequency:** 2/2 invalid deep-link variants observed.<br>
**First observed:** 2026-08-23<br>
**Reproducible:** Yes in the bounded session.<br>
**Frontend impact:** URL and visible context disagree, making bookmarks, support diagnosis and back/forward navigation confusing.<br>
**Backend impact:** No cross-shop data was exposed; fallback uses the legitimate selected shop.<br>
**Business impact:** Seller may believe they inspected the linked resource/shop and act on the wrong context.<br>
**Security impact:** No authorization bypass observed; ambiguity can obscure attempted invalid-ID access in support flows.<br>
**Evidence:** `qa-artifacts/seller-audit-2026-08-23/live-browser-e2e-execution.txt`; fake-order 404 provides the expected contrast.<br>
**Suspected root cause:** Router/loaders treat invalid optional identifiers as absent and apply default selected-shop/list behavior without surfacing the normalization.<br>
**Recommended fix:** Distinguish missing from invalid identifiers, return resource-specific 404/invalid-shop feedback, and only use fallback after an explicit user-visible redirect.<br>
**Regression risk:** Deep-link normalization touches saved shop selection and aliases; test valid/invalid/cross-shop IDs, back/forward, reload and authorized multi-shop switching.

### BUG-001 — Platform and storefront serve plaintext HTTP without universal HTTPS redirect/HSTS

**Severity:** P1 Critical<br>
**Priority:** Immediate<br>
**Module:** Platform edge, API and public storefront / transport security<br>
**Environment:** Production<br>
**Role:** Guest/customer<br>
**URL:** `http://selinow.com/`, `http://api.selinow.com/api/health`, `http://api.selinow.com/api/v1/shop`, `http://app.selinow.com/api/auth/session`, and tenant storefront routes

**Precondition:** Public tenant hostname resolves through the production Worker.<br>
**Steps:**
1. Send `GET http://selinow.com/` and `GET http://api.selinow.com/api/health`.
2. Repeat for `http://a-tung.selinow.com/`, `/cart`, `/checkout`, `/orders`, and the app session API.
3. Inspect response headers.

**Expected:** 301/308 redirect to the equivalent HTTPS URL and HSTS on HTTPS responses.<br>
**Actual:** Marketing, health/API and tenant storefront endpoints return content or API responses over HTTP (`200`/`401`) instead of an HTTPS redirect. Tenant storefront home/cart/checkout/orders all return `200 OK`. No inspected HTTPS response emits `Strict-Transport-Security`. Some HTML login paths redirect to HTTPS, but enforcement is route-dependent rather than universal.<br>
**Frequency:** 100% observed.<br>
**Reproducible:** Yes.<br>
**Frontend impact:** Users can remain on an insecure origin during marketing/storefront navigation.<br>
**Backend impact:** Public and unauthenticated API traffic, cart/order recovery tokens and any future storefront-authenticated state may be exposed to downgrade/interception.<br>
**Business impact:** Security/compliance release blocker.<br>
**Security impact:** Plaintext transport permits network interception and downgrade.<br>
**Evidence:** `qa-artifacts/seller-audit-2026-08-23/http-transport-security-probes.txt`; `curl -D - http://a-tung.selinow.com/` → `HTTP/1.1 200 OK`; `http://api.selinow.com/api/health` → `200`; `http://app.selinow.com/api/auth/session` → `401` over plaintext; absence of HSTS.<br>
**Suspected root cause:** Storefront route/domain configuration does not enforce scheme canonicalization; security headers only add CSP `upgrade-insecure-requests`, which does not redirect top-level navigation.<br>
**Recommended fix:** Add an edge/Worker HTTP→HTTPS redirect for every storefront/custom hostname and emit HSTS only after confirming all tenant domains are HTTPS-safe. Add route tests for every public path.<br>
**Regression risk:** Custom-domain onboarding and local HTTP development; gate HSTS by environment and verified TLS state.

### BUG-002 — Billing checkout recovery is unusable after redirect/cancel/reload

**Severity:** P1 Critical<br>
**Priority:** Immediate<br>
**Module:** Dodo billing checkout<br>
**Environment:** Source changes on branch; production provider is pending<br>
**Role:** Seller owner<br>
**URL:** `/app/billing`

**Precondition:** A checkout session has been created and remains `pending`/`open`; hosted checkout is cancelled, browser is reloaded, or return is interrupted.<br>
**Steps:**
1. Start a plan checkout.
2. Leave the hosted payment page before completion or reload the billing page.
3. Start/continue payment using the visible CTA.

**Expected:** Existing session/link is replayed or a safe replacement session is created.<br>
**Actual:** Client clears the original idempotency attempt after receiving the URL (`src/scripts/dashboard/billing.ts:204-214`). A new key cannot replay the old row (`src/lib/billing/service.ts:370-386`) and the active `pending/open` guard rejects replacement (`src/lib/billing/service.ts:535-562`) with `billing_subscription_version_conflict`.<br>
**Frequency:** Deterministic from source; focused tests pass because they do not cover the user return sequence.<br>
**Frontend impact:** Paid conversion CTA dead-ends.<br>
**Backend impact:** Subscription remains pending and checkout row remains locked.<br>
**Business impact:** Lost upgrades/recovery for suspended sellers.<br>
**Security impact:** No direct bypass found.<br>
**Evidence:** Source line refs above; no production charge was attempted.<br>
**Recommended fix:** Persist checkout session ID/idempotency key through the hosted-link TTL; make return/cancel/reload explicitly query that session; allow a guarded replacement only after the prior session is expired/failed/canceled. Add browser-level cancel/reload/retry tests.

### BUG-003 — Provider-backed open checkout can lock a subscription indefinitely

**Severity:** P1 Critical<br>
**Priority:** Immediate<br>
**Module:** Billing expiry/reconciliation<br>
**Environment:** Source changes on branch<br>
**Role:** Seller owner

**Steps:**
1. Create a Dodo checkout and receive a provider reference.
2. Provider returns `payment_status = null` or remains processing after hosted-link lifetime.
3. Run reconciliation and attempt a new checkout.

**Expected:** Expire/quarantine the stale session after provider TTL, release subscription lock, and expose a retry path.<br>
**Actual:** Expiration only selects `status='pending' AND provider_checkout_ref IS NULL` (`src/lib/billing/service.ts:623-670`). `payment_status=null` remains pending (`:795-819`); exhausted reconciliation clears the next retry but keeps the row `open`, and polling excludes it (`:762-783`, `:878-896`). Existing tests explicitly lock this dead-end at `tests/unit/dodo-billing.test.ts:945-970,1012`.<br>
**Business impact:** Seller cannot recover or change plan; support/manual database intervention required.<br>
**Recommended fix:** Define a terminal stale-provider state with release/quarantine semantics, reconcile against provider expiry, and add tests for null/processing/timeout/exhaustion plus retry after release.

### BUG-004 — Rollback target is not compatible with provider-backed checkout state

**Severity:** P1 Critical<br>
**Priority:** Immediate before deployment/rollback<br>
**Module:** Release/worker scheduling/billing migration<br>
**Environment:** Dirty branch with migration `0113` and billing changes; current committed rollback target<br>
**Precondition:** New code creates `open` provider-backed sessions, then deployment is rolled back.<br>
**Actual risk:** Current rollback Worker expires both `pending` and `open`, while the new state machine intentionally leaves provider-backed `open` sessions for reconciliation. A rollback after provider sessions exist can falsely expire/suspend active payment attempts; a missed webhook may have no compatible recovery path.<br>
**Evidence:** Billing agent source review; migration `0113_dodo_checkout_reconciliation.sql`; release rollback path.<br>
**Recommended fix:** Make rollback target state-compatible, or block rollback until active provider sessions are reconciled/quarantined. Rehearse forward/backward Worker behavior against a staging Dodo sandbox.

### BUG-032 — Clean commit thiếu migration `0113`, release admission không thể chạy

**Severity:** P1 Critical release blocker<br>
**Priority:** Immediate before merge/deploy<br>
**Module:** Migration ledger / release tooling<br>
**Environment:** Clean checkout của HEAD `22bfd88`<br>
**Role:** Release operator

**Precondition:** Build/release từ commit hiện tại thay vì dirty worktree của developer.<br>
**Steps:**
1. Liệt kê SQL migration được track trong HEAD.
2. Sort theo filename như `validateSourceMigrationNames`.
3. Validate numeric prefix bằng rule `Number(prefix) === index + 1`.

**Expected:** Committed source chứa chuỗi liên tục `0112`, `0113`, `0114`, `0115`; release admission có thể tạo artifact từ clean checkout.<br>
**Actual:** `migrations/0113_dodo_checkout_reconciliation.sql` đang untracked, trong khi `0114` và `0115` đã nằm trong HEAD. Clean HEAD có 114 migration; entry đầu tiên sai ledger là `0114_auth_otp_admission.sql`, dẫn tới `source_migration_ledger_invalid` tại `scripts/lib/release.mjs:870-880`.<br>
**Frequency:** 100% trên clean HEAD.<br>
**Reproducible:** Yes.<br>
**Frontend impact:** Không trực tiếp.<br>
**Backend impact:** Billing source phụ thuộc schema checkout mới nhưng release pipeline không thể xác nhận/apply chuỗi migration hợp lệ.<br>
**Business impact:** Không thể promote artifact tái lập từ commit; deploy dirty tree sẽ phá tính auditability và rollback provenance.<br>
**Security impact:** Supply-chain/integrity risk nếu bypass release gate hoặc deploy file uncommitted.<br>
**Evidence:** `qa-artifacts/seller-audit-2026-08-23/release-migration-ledger-probes.txt`; `git status` hiển thị `?? migrations/0113_dodo_checkout_reconciliation.sql`.<br>
**Suspected root cause:** Billing migration được tạo local nhưng chưa được commit cùng code/migration auth kế tiếp.<br>
**Recommended fix:** Commit/review `0113` và code phụ thuộc trong cùng release unit, chạy toàn bộ release admission từ clean checkout, rồi rehearsal forward/rollback với session `pending/open`. Tuyệt đối không deploy dirty worktree.<br>
**Regression risk:** Nếu renumber migration đã apply sẽ làm lệch ledger; giữ forward-only numbering và không sửa migration đã phát hành.

### BUG-038 — OTP admission ledger không có retention purge

**Severity:** P2 Major operational risk<br>
**Priority:** Short-term before sustained public traffic<br>
**Module:** Auth OTP admission / scheduled maintenance<br>
**Environment:** Current source with migration `0114`<br>
**Role:** Guest/attacker

**Precondition:** Public OTP issue endpoint nhận traffic hợp lệ hoặc bị abuse trong giới hạn rate cap.<br>
**Expected:** Expired admission rows được purge theo bounded batch, có metric/alert và retention được test.<br>
**Actual:** `0114_auth_otp_admission.sql` tạo `auth_otp_admissions` và expiry index, nhưng không có DELETE/purge path cho table. Worker chỉ gọi `purgeAuthRequestAdmissions` (`src/worker.ts:681`), không purge OTP admission ledger. Với public issuance cap 200/global/15 phút, upper-bound tăng trưởng khoảng 19.200 rows/ngày.<br>
**Impact:** D1/backup tăng không giới hạn, làm nặng maintenance và các scan/operational recovery theo thời gian; abuse kéo dài có thể nâng thành availability incident.<br>
**Evidence:** Migration/source search; release/migration sub-audit.<br>
**Recommended fix:** Thêm scheduled bounded expiry purge, retention metric/alert và test bảo đảm chỉ xóa record hết hạn theo tenant-independent admission policy.

### BUG-039 — Auth migrations `0114/0115` thiếu real-D1 integration regression

**Severity:** P2 Major verification gap<br>
**Priority:** Short-term before production migration<br>
**Module:** Auth migration/concurrency/credential promotion<br>
**Environment:** Clean candidate + SQLite/D1-compatible test harness<br>
**Role:** Guest/New Seller/Existing account

**Precondition:** Apply `0114_auth_otp_admission.sql` và `0115_auth_pending_password.sql`, sau đó registration/password flow gặp concurrency hoặc transient failure.<br>
**Expected:** Real schema tests chứng minh admission cap atomic, suspended-account race fail-closed, OTP failure giữ credential cũ, OTP success promote pending hash + activate account + create session atomically.<br>
**Actual:** Không có test trực tiếp reference `auth_otp_admissions` hoặc `pending_password_hash`. Route tests mock `claimOtpAdmission`/`completeRegistrationWithOtp`; OTP lifecycle dùng JavaScript Map thay vì D1.<br>
**Impact:** Migration additive nhưng critical auth invariants chưa được chứng minh trên schema thật; race/failure có thể chỉ xuất hiện sau deploy.<br>
**Evidence:** Source/test search; release sub-audit focused run 55/55 pass nhưng không cover real-D1 chain.<br>
**Recommended fix:** Thêm SQLite/D1 integration tests apply migrations thật và exercise concurrent caps, suspended race, failure rollback và atomic success; gate migration admission bằng suite này.

### BUG-014 — Onboarding reports “store opened successfully” even when publish fails

**Severity:** P1 Critical<br>
**Priority:** Immediate<br>
**Module:** Onboarding launch/publish<br>
**Environment:** Current source branch<br>
**Role:** New Seller<br>
**URL:** `/onboarding`

**Precondition:** Seller reaches the final launch step; `/storefront/publish` returns non-2xx or throws.<br>
**Steps:**
1. Complete onboarding review.
2. Trigger publish while the publish API returns an error or network exception.
3. Observe the final state.

**Expected:** Keep the review state visible, show an actionable failure, and allow safe retry; do not claim the store is live.<br>
**Actual:** The click handler calls `completeAndCelebrate()` in `finally` regardless of response (`src/scripts/dashboard/onboarding-quickstart.ts:1354-1374`). It hides review, triggers confetti, and shows “KÍCH HOẠT THÀNH CÔNG / Cửa Hàng Của Bạn Đã Mở Bán Trực Tuyến!” (`src/components/dashboard/onboarding/OnboardingStepLaunch.astro:133-141`).<br>
**Frequency:** Deterministic from source.<br>
**Frontend impact:** False success; retry path is hidden.<br>
**Backend impact:** Store can remain unpublished/not sellable while UI claims success.<br>
**Business impact:** New seller launch is a critical activation journey; false-live status can cause lost sales and support load.<br>
**Security impact:** None identified.<br>
**Evidence:** Source line refs; production already demonstrates a related published/live versus not-sellable state mismatch.<br>
**Recommended fix:** Call celebration only after `res.ok` and a verified backend readiness/publication projection; retain review and retry controls on failure. Add API 400/409/500/network/double-click/refresh regression tests.

### BUG-026 — Active onboarding client gọi sai method/path cho integration/settings APIs

**Severity:** P1 Critical<br>
**Priority:** Immediate<br>
**Module:** Onboarding store/settings/channels/PayOS/Telegram<br>
**Environment:** Current source branch<br>
**Role:** New Seller hoặc existing Seller resume<br>
**URL:** `/onboarding`

**Precondition:** Seller submit channel, template/settings, PayOS hoặc Telegram step.<br>
**Expected:** Request phải khớp server route và trả state đã lưu.<br>
**Actual:** Active `onboarding-quickstart.ts` gọi `POST /onboarding/channels` (`:871-878`) trong khi server chỉ expose `PUT` (`src/pages/api/app/shops/[shopPublicId]/onboarding/channels.ts:13`); gọi `PATCH /settings` (`:883-886`) trong khi server chỉ expose `PUT` (`.../onboarding/settings.ts:13`); gọi `POST /integrations/payos` (`:1157-1160`) trong khi server expose `PUT /payments/payos` (`.../payments/payos.ts:20`); gọi `POST /integrations/telegram` (`:1197-1203`) trong khi server expose `PUT` (`.../integrations/telegram.ts:20`).<br>
**Frequency:** Deterministic 404/405 for affected paths. Legacy/static onboarding contract subset vẫn 45/45 pass; toàn bộ onboarding-focused files là 91/91, nhưng không mount active quickstart HTTP flow.<br>
**Business impact:** Fresh Seller không thể hoàn tất integration/readiness; activation funnel bị chặn.<br>
**Recommended fix:** Chọn một canonical route contract, sửa client/server đồng bộ, thêm contract test kiểm tra method/path thực tế và browser test cho mỗi integration.

### BUG-027 — Existing-shop onboarding báo lưu thành công dù name/slug/template chưa persist

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Onboarding existing-shop edit<br>
**Actual:** Existing-shop branch chỉ gọi channels/template endpoint; không PATCH shop name/slug. Sau đó client gán `activeShopSlug/name` local và toast success (`src/scripts/dashboard/onboarding-quickstart.ts:869-894`). Template request lỗi bị swallow (`:883-886`), nên refresh sẽ mất thay đổi nhưng Seller đã thấy “Đã lưu thành công”. API profile update thật nằm ở `src/pages/api/app/shops/[shopPublicId].ts:37-45`.<br>
**Recommended fix:** Gọi profile update canonical API, không swallow non-2xx, reload/read server projection trước khi advance step, và test refresh/navigation-away persistence.

### BUG-028 — Plan intent từ pricing bị mất; Pro CTA tạo shop Starter

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Pricing → login → onboarding conversion<br>
**Actual:** Pricing gửi `/login?redirect=/onboarding?plan=pro` (`src/pages/pricing.astro:48-51`), nhưng active quickstart hardcode `planCode: "starter"` (`src/scripts/dashboard/onboarding-quickstart.ts:839-843`) và không có plan selector. Legacy `onboarding.ts` có parse plan nhưng không được mount bởi `OnboardingShell`.<br>
**Impact:** Seller chọn Pro nhưng shop/entitlement bắt đầu bằng Starter; doanh thu và feature entitlement sai.<br>
**Recommended fix:** Parse allow-listed `plan` từ URL/server state, bind vào shop creation idempotency request, và thêm test pricing CTA → login → onboarding.

### BUG-029 — Onboarding create/import retry dùng key mới, có thể tạo duplicate

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Onboarding idempotency/retry<br>
**Actual:** Browser tạo fresh timestamp idempotency key cho shop (`:848-850`), custom product (`:976-979`) và inventory import (`:1091-1094`). Network timeout, double-click sau state reset hoặc refresh-and-resubmit tạo intent mới; seed-preset server cũng sinh random suffix/key (`src/pages/api/app/shops/[shopPublicId]/onboarding/seed-preset.ts:61-90,107-118`).<br>
**Impact:** Duplicate product/variant/sample inventory và inconsistent resume state.<br>
**Recommended fix:** Persist intent key per logical onboarding step until terminal response, bind request hash to canonical step input, and add double-submit/multi-tab/retry tests.

### BUG-030 — Onboarding policy attestation không thể đạt readiness trong state hiện tại

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Onboarding policy/readiness<br>
**Actual:** Launch form luôn gửi `attestationAccepted:false, attestationVersion:null` (`src/scripts/dashboard/onboarding-quickstart.ts:1300-1311`), trong khi `policiesReady` yêu cầu policy attestation và non-null platform policy version (`src/lib/tenants/readiness.ts:139-145,222-228`). `CURRENT_POLICY_ATTESTATION_VERSION` hiện là `null` (`src/lib/onboarding/policy.ts:16`).<br>
**Impact:** Seller có thể lưu policy URLs nhưng không bao giờ đạt `policies_ready`; launch flow dead-end cho tới khi policy rollout/config thay đổi.<br>
**Recommended fix:** Quyết định rõ policy attestation rollout; expose checkbox/version khi platform policy đã published, hoặc đánh dấu prerequisite disabled thay vì cho Seller đi tới success.

### BUG-031 — OTP bị consume trước khi activation/session batch commit

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Registration/OTP recovery<br>
**Actual:** `completeRegistrationWithOtp` verify/consume OTP trước activation/session batch (`src/lib/auth/session.ts:730-737,749-779`; consume tại `src/lib/auth/otp.ts:170-178`). Nếu batch fail transiently, user nhận 500 nhưng OTP đã burned và account có thể vẫn pending; retry không thể resume.<br>
**Recommended fix:** Gộp consume + activation/session trong transaction/outbox-compatible flow, hoặc cấp retry-safe activation token; thêm injected batch-failure test.

### BUG-033 — Preset onboarding đưa mã demo vào inventory có thể bán và fulfill thật

**Severity:** P1 Critical<br>
**Priority:** Immediate<br>
**Module:** Onboarding preset / catalog / digital fulfillment<br>
**Environment:** Current source branch<br>
**Role:** New Seller<br>
**URL:** `/onboarding` → `POST /api/app/shops/:shop/onboarding/seed-preset`

**Precondition:** Seller chọn một preset digital có `fulfillmentType="license_key"`, sau đó shop đạt publish/readiness.<br>
**Steps:**
1. Chọn Windows, Canva, Spotify hoặc Steam preset.
2. Quan sát product/variant được tạo `active` và `sampleKeys` được import.
3. Publish shop và đặt order cho sản phẩm preset.

**Expected:** Preset chỉ tạo draft/sample không thể bán; demo code phải được đánh dấu synthetic/non-fulfillable hoặc không bao giờ đi vào authoritative inventory.<br>
**Actual:** `ONBOARDING_PRODUCT_PRESETS` chứa mã mẫu/public generic tại `src/lib/onboarding/presets.ts:22-93`. Seed endpoint tạo product và variant `active` (`src/pages/api/app/shops/[shopPublicId]/onboarding/seed-preset.ts:64-86`), rồi import các mã đó qua inventory flow (`:94-118`). Authoritative readiness coi active product/variant có `inventory_keys.status='available'` là fulfillment-ready (`src/lib/tenants/readiness.ts:329-355`).<br>
**Frequency:** Deterministic cho mọi license-key preset có `sampleKeys`.<br>
**Reproducible:** Yes from source; không tạo order production để tránh giao mã giả.<br>
**Frontend impact:** UI còn khẳng định “nạp ... key mẫu” nhưng đưa Seller thẳng sang bước kết nối.<br>
**Backend impact:** Demo values nằm trong cùng kho authoritative với key thương mại và có thể được allocation/fulfillment chọn.<br>
**Business impact:** Có thể giao mã giả/public generic cho khách, gây refund, chargeback, vi phạm trust và legal/licensing.<br>
**Security impact:** Data-integrity/content provenance risk; demo secret-like data bị trộn với sellable inventory.<br>
**Evidence:** Source refs nêu trên; audit không mutate production.<br>
**Suspected root cause:** Express onboarding tái sử dụng production import service mà không có inventory class/state riêng cho sample data.<br>
**Recommended fix:** Không import sample keys vào authoritative inventory. Tạo preset dưới dạng draft/non-sellable, dùng explicit demo flag không thể allocate, buộc Seller thay inventory và xác nhận trước publish; quarantine dữ liệu preset đã seed.<br>
**Regression risk:** Existing shops có thể đang chứa sample keys; cần safe audit/backfill theo source marker thay vì xóa mù.

### BUG-034 — Resume/checklist projection lệch authoritative readiness và fail-open về “chưa làm”

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Onboarding resume/overview<br>
**Role:** Existing Seller hoặc returning Seller<br>
**URL:** `/onboarding`, `/api/app/shops/:shop/onboarding/overview`

**Precondition:** Shop có draft/inactive product, stale/error integration, hoặc catalog/integration read gặp lỗi transient.<br>
**Expected:** Wizard resume từ cùng authoritative state machine dùng để publish; lỗi read phải hiện degraded/error và không cho resubmit mù.<br>
**Actual:** `getOnboardingResume` coi bất kỳ product/manual product/stock nào là ready mà không check active status, và chỉ check `webhookStatus==='verified'` cho integration (`src/lib/onboarding/resume.ts:73-105`). Readiness thật yêu cầu active product/variant, active integration và timestamp health còn fresh (`src/lib/tenants/readiness.ts:130-138,329-355`). Các read error còn bị `.catch(() => null)`, nên wizard có thể quay về Product/Connect và tạo trùng. Overview API lặp lại projection đơn giản này (`src/pages/api/app/shops/[shopPublicId]/onboarding/overview.ts:30-53`).<br>
**Impact:** Skip qua bước chưa ready rồi fail launch, hoặc lùi bước và duplicate product/inventory khi backend chỉ lỗi tạm thời.<br>
**Recommended fix:** Dùng trực tiếp readiness checks/codes cho resume và overview; surface degraded read state, disable mutation cho tới khi refresh/retry có chủ đích, và test draft/stale/timeout/multi-tab.

### BUG-035 — Signup OTP không resume sau refresh và làm mất pricing redirect

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Registration/OTP/navigation recovery<br>
**Role:** New Seller<br>
**URL:** `/register`, `/login?redirect=...`

**Precondition:** User đã submit registration và đang ở OTP step, hoặc đi từ pricing qua login/register.<br>
**Expected:** Refresh/close-reopen resume pending OTP an toàn; successful verification giữ allow-listed destination/plan intent.<br>
**Actual:** Registration step và email chỉ nằm trong JS memory (`src/scripts/marketing/auth.ts:413-455`); refresh quay lại Step 1 dù pending user/OTP đã tồn tại. Login link sang register bỏ `redirect` (`src/pages/login.astro:244-248`), và OTP success hardcode `window.location.href='/onboarding'` (`src/scripts/marketing/auth.ts:557-558`).<br>
**Impact:** Activation funnel bị reset, resend/confusion tăng, và Pro conversion intent bị mất trước BUG-028.<br>
**Recommended fix:** Tạo server-backed pending-registration resume token không chứa secret, preserve allow-listed redirect qua login/register/OTP, và test refresh/back/new-tab/session expiry.

### BUG-036 — Manager thấy full onboarding nhưng owner-only steps fail giữa flow

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Onboarding role/permission UX<br>
**Role:** Manager/non-owner shop member<br>
**URL:** `/onboarding?shop=:shop`

**Precondition:** Authenticated member có `shop:update` nhưng role không phải owner.<br>
**Expected:** Chỉ owner được vào owner-only onboarding, hoặc UI hiển thị read-only/handoff rõ ràng trước khi mutate.<br>
**Actual:** Page chọn mọi member shop và resume chỉ gate `shop:update` (`src/pages/onboarding.astro:19-34`, `src/lib/onboarding/resume.ts:64-70`). Server channels/settings fail-closed bằng owner check (`src/lib/onboarding/store.ts:71-87,194-201`), nhưng manager vẫn thấy full wizard và có thể mutate catalog trước khi gặp 403/false-success ở bước owner-only.<br>
**Impact:** Partial onboarding state, confusing dead-end và support burden; backend owner boundary vẫn fail-closed.<br>
**Recommended fix:** Gate route/shell theo role ngay từ đầu, hoặc thiết kế explicit collaborative permission matrix; add owner/manager/support/viewer browser/API tests.

### BUG-037 — Preset summary luôn coi product là license-key

**Severity:** P3 Minor<br>
**Priority:** Medium-term<br>
**Module:** Onboarding launch summary<br>
**Actual:** Sau mọi preset, client hardcode `productIsManual=false` (`src/scripts/dashboard/onboarding-quickstart.ts:936-945`). Physical/booking/manual preset vì vậy hiện `0 mã` và inventory incomplete dù readiness coi manual fulfillment là ready.<br>
**Impact:** Summary sai, làm Seller tưởng còn thiếu inventory hoặc hiểu nhầm mô hình fulfillment.<br>
**Recommended fix:** Trả/derive fulfillment type từ seed response và render copy theo vertical; test digital/manual/physical/booking presets.

### BUG-018 — Shipping API cho phép nhảy/bẻ ngược state và complete order không có CAS/idempotency

**Severity:** P1 Critical<br>
**Priority:** Immediate<br>
**Module:** Order shipping/fulfillment<br>
**Environment:** Current source branch<br>
**Role:** Owner/manager có `fulfillment:manage`<br>
**URL:** `POST /api/app/shops/:shop/orders/:order/shipping`

**Precondition:** Physical order đã paid.<br>
**Steps:**
1. POST trực tiếp `shippingState="delivered"` khi order chưa qua `packing`/`shipped`, không gửi carrier/tracking.
2. Quan sát fulfillment/order state.
3. Từ hai tab, gửi các state khác nhau gần đồng thời hoặc gửi `shipped` rồi `packing`.

**Expected:** Enforce FSM `packing → shipped → delivered`, yêu cầu carrier/tracking phù hợp, dùng idempotency + expectedVersion/CAS; stale/backward transition phải bị reject.<br>
**Actual:** Route nhận state trực tiếp, không `Idempotency-Key`/`expectedVersion` (`src/pages/api/app/shops/[shopPublicId]/orders/[orderId]/shipping.ts:10-24`). Service chỉ whitelist ba string, cho direct `delivered`, lập tức set fulfillment `fulfilled` và order `completed`, đồng thời cho phép `shipped → packing` trước fulfilled (`src/lib/commerce/shipping.ts:278-351`). Update không CAS; UI render cả ba action cùng lúc và fetch không version/idempotency (`src/pages/app/orders/[id].astro:212-220,547-563`).<br>
**Frequency:** Deterministic from source; concurrency outcome là last-write-wins/unique-conflict.<br>
**Frontend impact:** UI cho phép action không hợp lệ và có thể hiển thị stale state giữa nhiều tab.<br>
**Backend impact:** Order/fulfillment state có thể bị complete sớm hoặc đi lùi; first-insert concurrency có thể gặp unique conflict.<br>
**Business impact:** Sai trạng thái giao hàng, SLA/support/reporting và automation downstream.<br>
**Security impact:** Không phải cross-tenant bypass; là business-logic integrity issue bởi authorized actor/stale client.<br>
**Evidence:** Source refs; focused API/tenant suites 164/164 pass nhưng không cover skip/backward/double-submit/multi-tab.<br>
**Recommended fix:** Explicit FSM, carrier/tracking requirement, expectedVersion/CAS, request idempotency và transaction guard; UI chỉ render transition hợp lệ.<br>
**Regression risk:** Existing orders có state legacy; cần migration/read compatibility và tests cho retry/concurrency.

### BUG-019 — Viewer/support có thể đọc full order-message body trái RBAC

**Severity:** P1 Critical<br>
**Priority:** Immediate<br>
**Module:** Order messages / authorization<br>
**Environment:** Current source branch<br>
**Role:** Viewer hoặc support<br>
**URL:** `GET /api/app/shops/:shop/orders/:order/messages`

**Precondition:** User là member của shop và biết order public ID.<br>
**Steps:**
1. Đăng nhập bằng role viewer/support.
2. Gọi trực tiếp order messages endpoint với order public ID hợp lệ.
3. Quan sát response body.

**Expected:** Viewer bị 403; support chỉ nhận masked projection đúng policy.<br>
**Actual:** `listOrderMessages` chỉ yêu cầu `shop:read` và trả body/author/channel/failure đầy đủ (`src/lib/commerce/order-messages.ts:115-137`); GET route expose trực tiếp (`src/pages/api/app/shops/[shopPublicId]/orders/[orderId]/messages/index.ts:11-21`). Policy chỉ cấp viewer `orders:read:summary` và support `orders:read:masked` (`src/lib/tenants/policy.ts:45-51`); order detail chính lại enforce đúng visibility riêng.<br>
**Frequency:** Deterministic from authorization path.<br>
**Frontend impact:** Có thể khai thác qua direct URL/API dù UI không hiển thị.<br>
**Backend impact:** Intra-tenant RBAC bypass, lộ nội dung message và metadata.<br>
**Business impact:** Vi phạm phân quyền nhân sự và privacy của customer/order.<br>
**Security impact:** Authorization bypass; message có thể chứa PII hoặc thông tin support nhạy cảm.<br>
**Recommended fix:** Dùng dedicated order visibility guard; viewer 403, support masked projection, owner/manager full. Thêm role matrix và deep-link test.<br>
**Regression risk:** Support workflows đang dựa vào full body cần product decision rõ ràng.

### BUG-005 — Reconciliation accepts captured payment with weak checkout metadata binding

**Severity:** P2 Major<br>
**Priority:** Immediate short-term<br>
**Module:** Dodo reconciliation/webhook convergence<br>
**Actual:** `hasCompatibleCheckoutMetadata` performs a subset comparison (`src/lib/billing/service.ts:735-737`), and `checkoutSessionId` is optional in the payment response check (`:826-833`). Empty metadata can pass the current test at `tests/unit/dodo-billing.test.ts:903-942`.<br>
**Impact:** A provider payment with incomplete metadata may be attributed to the local checkout using only amount/currency/price/ subscription signals.<br>
**Recommended fix:** Require exact immutable provider checkout-session ID, tenant/shop ID, plan/price reference and amount/currency; reject missing metadata and add negative cross-tenant fixtures.

### BUG-006 — Dodo 401/403 are misclassified as customer request rejection

**Severity:** P2 Major<br>
**Priority:** Immediate short-term<br>
**Module:** Dodo adapter/error handling<br>
**Actual:** All non-retryable 4xx map to `billing_provider_request_rejected` (`src/lib/billing/dodo.ts:191-195`), then checkout is failed/unlocked (`src/lib/billing/service.ts:598-602`).<br>
**Impact:** Invalid/expired provider credentials or permission outages look like customer errors, hide platform incidents, and permit futile retries.<br>
**Recommended fix:** Map 401/403 to provider configuration/unavailable, preserve the checkout for reconciliation where safe, alert operators, and add explicit 401/403 tests.

### BUG-007 — Seller product ledger reports inventory-key count as variant count

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Product management projection<br>
**Environment:** Production Seller snapshot + source<br>
**URL:** `/app/products`

**Precondition:** A variant has multiple inventory keys.<br>
**Steps:**
1. Open Product Management for a product with one variant and five available keys.
2. Compare the summary/detail variant count with the ledger row.

**Expected:** Variant count equals distinct `product_variants` rows.<br>
**Actual:** Summary/detail show one variant, while ledger displays five. The CTE joins `inventory_keys` and uses `COUNT(product_variants.id)` without `DISTINCT` (`src/lib/catalog/store.ts:247-252` region; query around `listSellerProductsPage`).<br>
**Business impact:** Seller makes incorrect catalog/inventory decisions and exports contain misleading counts.<br>
**Recommended fix:** Use `COUNT(DISTINCT product_variants.id)` or pre-aggregate inventory by variant before joining; add a regression fixture with one variant and N keys.

### BUG-008 — Seller publish/readiness terminology is inconsistent with public state

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Store Builder, Dashboard readiness, public storefront<br>
**Actual:** Store Builder displayed “Đã publish/Đang live”, Dashboard displayed “Chưa publish”, while public storefront stated “store is being prepared” and APIs returned `tenant_not_ready`/`subscription_required`.<br>
**Impact:** Seller cannot tell whether the store is live, paused, subscription-blocked, or merely has an unpublished catalog.<br>
**Recommended fix:** Derive one canonical readiness state from the backend and expose separate badges for `draft`, `published`, `sellable`, `subscription_blocked`, and `provider_pending`.

### BUG-009 — Public ProductCard hides a focusable subtree with `aria-hidden`

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Storefront accessibility<br>
**Environment:** Staging visual/a11y suite<br>
**Actual:** `<a aria-hidden="true" tabindex="-1">` wraps a button and another link (`src/components/storefront/ProductCard.astro:31-52`). Axe reports `aria-hidden-focus` on desktop/mobile.<br>
**Impact:** Keyboard and screen-reader users encounter hidden focusable controls; add-to-cart and product navigation semantics are ambiguous.<br>
**Recommended fix:** Make the visual media a non-interactive element, or remove nested controls and expose one accessible card link plus a sibling add-to-cart button.

### BUG-015 — Onboarding v2 ignores locale and hardcodes Vietnamese

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Onboarding/i18n<br>
**Actual:** The shell carries locale/default-locale state, but the v2 step components hardcode Vietnamese copy instead of using catalogs (`src/components/dashboard/onboarding/OnboardingShell.astro:49-55`, `OnboardingStepStore.astro:68-120`, `OnboardingStepConnect.astro:9-118`, with the same pattern in Product/Inventory/Launch).<br>
**Impact:** English-locale new sellers receive a mixed/incorrect-language activation flow.<br>
**Recommended fix:** Move all copy into the onboarding catalog, pass translator/locale consistently, and run both English and Vietnamese browser matrices.

### BUG-016 — Authenticated onboarding E2E checks the obsolete UI contract

**Severity:** P2 Major (coverage gap)<br>
**Priority:** Short-term<br>
**Module:** Browser regression suite<br>
**Actual:** The authenticated test expects old heading/progress/rail selectors at `tests/authenticated/local-authenticated.spec.ts:35-40,394-403`, while the current v2 shell uses different markup and lacks those selectors. Current onboarding behavior, including BUG-014, is therefore not meaningfully protected by the intended browser gate.<br>
**Impact:** Critical onboarding regressions can merge while the test inventory appears comprehensive.<br>
**Recommended fix:** Replace selector-only legacy checks with current user journeys: validation, save/resume, refresh, back, duplicate submit, publish fail/success and public-readiness verification.

### BUG-017 — Seller route aliases do not honor their focus target

**Severity:** P3 Minor<br>
**Priority:** Medium-term<br>
**Module:** Navigation/deep links<br>
**Actual:** `/app/telegram` redirects with `?focus=telegram#telegram` and `/app/store/settings` with `?focus=settings#store-settings`, but no relevant client code reads `focus`. Telegram does not open configuration, and Store Builder keeps the Content tab active instead of opening Brand/settings.<br>
**Recommended fix:** Parse an allow-listed focus value on initial load, activate the intended panel/dialog, move focus to its heading, and regression-test back/forward/deep-link behavior.

### BUG-020 — Catalog read path yêu cầu nhầm `catalog:manage`

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Catalog RBAC<br>
**Actual:** `requireCatalogActor` luôn gọi `catalog:manage` dù `subscriptionAction="read"` (`src/lib/catalog/store.ts:25-31`); `listSellerCatalog` và `listSellerProductsPage` vì vậy từ chối support/viewer dù policy cấp `catalog:read`.<br>
**Impact:** Read-only role nhận 403 sai contract, gây false-deny và làm role matrix không nhất quán.<br>
**Recommended fix:** Chọn capability theo action và thêm owner/manager/support/viewer contract tests.

### BUG-021 — Nested product stock route bỏ qua `productId` trong path

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Physical inventory hierarchy<br>
**Actual:** POST `/products/:productId/stock` chỉ truyền `body.variantId` vào service (`src/pages/api/app/shops/[shopPublicId]/products/[productId]/stock.ts:39-54`); service bind shop+variant nhưng không kiểm tra `variant.product_id` khớp path product (`src/lib/commerce/shipping.ts:100-157`).<br>
**Impact:** `/products/A/stock` có thể mutate variant của product B trong cùng shop; audit URL/resource hierarchy trở nên sai và client bug khó phát hiện. Cross-tenant vẫn bị chặn.<br>
**Recommended fix:** Truyền product ID vào service và require exact hierarchy; mismatch trả 404/409, kèm negative test.

### BUG-025 — Seller inventory/product projections bỏ qua authoritative physical stock

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Product/inventory state consistency<br>
**Actual:** `listSellerCatalog` và product ledger chỉ aggregate `inventory_keys` (`src/lib/catalog/store.ts:123-149,233-244`), trong khi physical stock authoritative nằm ở `variant_stock_levels` (`migrations/0102_physical_goods_vertical.sql:34-48`). `/app/inventory` và `/app/products` dùng raw projection này nên shipping variant có `on_hand > 0` vẫn hiện 0/out-of-stock. Storefront/checkout lại đọc đúng `variant_stock_levels.on_hand - reserved` (`src/lib/storefront/store.ts:455-460`, `src/lib/commerce/store.ts:29-41`).<br>
**Impact:** Seller UI mâu thuẫn với backend/storefront; merchant có thể ngừng bán hoặc chỉnh stock sai vì nhìn thấy out-of-stock giả.<br>
**Recommended fix:** Aggregate theo `delivery_mode`: key inventory cho digital/license, `variant_stock_levels` cho shipping; thêm regression `on_hand=10, reserved=3` và assert Seller/storefront/checkout cùng báo 7 available.

### BUG-022 — Viewer bypass boundary đọc integrations/channel request metadata

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Integrations RBAC<br>
**Actual:** `listChannelConnectorRequests` và channel catalog chỉ gate `shop:read` (`src/lib/channels/connector-requests.ts:88-103`, `src/pages/api/app/shops/[shopPublicId]/channels/catalog.ts:10-15`). Viewer không có `integrations:read` nhưng vẫn đọc provider/status/failure/version/request ID.<br>
**Recommended fix:** Require `integrations:read`, deny viewer, và thêm role matrix tests.

### BUG-023 — Set physical stock dưới reserved trả 500 thay vì validation conflict

**Severity:** P2 Major<br>
**Priority:** Short-term<br>
**Module:** Physical stock validation/concurrency<br>
**Actual:** Update guard kiểm tra old `on_hand >= reserved` nhưng không kiểm tra input mới `onHand >= reserved` (`src/lib/commerce/shipping.ts:118-131`). DB CHECK `reserved <= on_hand` chặn mutation, nhưng exception bị map thành generic `internal_error` 500.<br>
**Impact:** Seller/automation thấy server error và có thể retry loop; conflict hợp lệ bị mất semantics.<br>
**Recommended fix:** Preflight/CAS với current reserved, trả `409 variant_stock_below_reserved`, và test concurrent reservation.

### BUG-024 — Shipping audit event không xuất hiện trong order timeline

**Severity:** P3 Minor<br>
**Priority:** Medium-term<br>
**Module:** Audit timeline<br>
**Actual:** Shipping ghi `resource_id` bằng public order ID (`src/lib/commerce/shipping.ts:345-348`) nhưng order detail query audit bằng internal order ID (`src/lib/commerce/seller-orders.ts:436-442`).<br>
**Impact:** Timeline thiếu shipping transitions, làm support/audit khó reconstruct state.<br>
**Recommended fix:** Ghi internal order ID (và public ID trong safe metadata nếu cần), thêm regression test.

### BUG-010 — Local dev server returns 500 due stale Vite SSR optimized dependencies

**Severity:** P3 Verification blocker (environment; release-gate priority Immediate)<br>
**Priority:** Immediate for verification pipeline<br>
**Module:** Astro/Vite local E2E harness<br>
**Actual:** `localhost:4321/` and `/api/health` return 500; logs report missing `node_modules/.vite/deps_ssr/astro_compiler-runtime.js?v=1731fc49` and `astro_virtual-modules_middleware__js.js`. Browser gates abort when a background server is detected.<br>
**Impact:** Live local Seller/public Playwright, responsive and a11y execution cannot complete. This is not evidence of the deployed production Worker failing.<br>
**Recommended fix:** Make optimizer cache lifecycle deterministic (or add required SSR deps to `optimizeDeps.exclude`), then rerun the browser gates in a clean isolated process. Do not update visual baselines until the deployed contract is confirmed.

### BUG-011 — Full Vitest gate has 5 failures despite focused suites passing

**Severity:** P3 Minor (quality gate)<br>
**Priority:** Medium-term<br>
**Actual:** `npm run test`: 2934/2939 pass. Four 2FA failures come from the test mock ignoring `id != ?` and expiring the newly inserted OTP (`tests/unit/account-two-factor-service.test.ts:147-154`); the Dodo hardening test times out only under full concurrency and passes isolated (21/21).<br>
**Impact:** CI signal is red and can mask real regressions.<br>
**Recommended fix:** Correct the mock SQL argument handling and isolate/increase the Dodo test timeout; retain a full-suite gate in CI.

### BUG-012 — Storefront images lack explicit dimensions in several paths

**Severity:** P3 Minor<br>
**Priority:** Medium-term<br>
**Locations:** `src/components/storefront/ProductCard.astro:33`, `src/components/storefront/sections/Gallery.astro`, `src/pages/app/store.astro:339`.<br>
**Impact:** Potential CLS and slower visual stabilization on image-heavy storefronts.<br>
**Recommended fix:** Emit width/height or aspect-ratio contracts from media metadata and add CLS assertions to the public browser gate.

### BUG-013 — Production billing shows a phantom “updating plan” operation

**Severity:** P3 Minor<br>
**Priority:** Short-term deployment regression<br>
**Module:** Seller billing UI<br>
**Environment:** Production<br>
**URL:** `/app/billing`

**Precondition:** Seller subscription is `Pro / suspended` with no visible active billing operation.<br>
**Actual:** The page displays “Đang cập nhật gói — Selinow đang xử lý với Dodo Payments” indefinitely beneath the suspended-plan card. This implies an active mutation even though no upcoming payment or invoice exists.<br>
**Evidence:** `qa-artifacts/seller-audit-2026-08-23/production-billing-phantom-operation.jpg`. The dirty source now contains `.operation-banner[hidden] { display:none; }` at `src/pages/app/billing.astro:563`, indicating the fix exists locally but is not deployed.<br>
**Impact:** Seller may wait indefinitely, avoid retrying, or contact support for a non-existent operation.<br>
**Recommended fix:** Deploy the hidden-state CSS together with operation-ID-driven polling; add a regression screenshot for suspended/no-operation and operation-in-progress states.

## Security Và Authorization

- Truy cập trực tiếp `/app/*` và `/admin` khi chưa đăng nhập redirect về `/login`.
- Actual Chrome với Seller owner truy cập `/admin` bị deny; fake order ID trả clear 404 và không lộ order khác.
- Seller API không có session trả `401 authentication_required`; public catalog/checkout fail-closed bằng `409 tenant_not_ready` hoặc `402 subscription_required` cho shop suspended đã quan sát.
- Audit riêng billing chưa tìm thấy tenant IDOR có thể khai thác qua browser; checkout status/reconciliation và invoice identity đều bind theo shop.
- Backend audit chạy 164/164 focused tests và xác nhận cross-tenant isolation nhìn chung tốt cho customers, members, API credentials/public API, domains, exports/deletion và manual fulfillment.
- Tuy nhiên có intra-tenant RBAC bypass nghiêm trọng: viewer/support đọc full order-message body (BUG-019), viewer đọc integration metadata (BUG-022); catalog read-only role lại bị false-deny (BUG-020).
- Fake product/shop selectors không bypass authorization nhưng silently fall back về list/real shop, làm direct-link semantics khó chẩn đoán (BUG-046).
- Không đọc cookie, local storage, password, secret hoặc nội dung production database.

## UI/UX, Responsive Và Accessibility

Static contract/source audit ghi nhận primitives, skip link, dialog/toast/state component và server-side table contract tương đối nhất quán. Staging visual suite đạt **8 pass / 12 fail**; failure gồm thay đổi render home/product/cart/login và lỗi `aria-hidden-focus` đã xác nhận. Dù staging matrix không flag overflow, actual Chrome production xác nhận document overflow ở Products/storefront 320 px, internal Seller overflow 390 px và label mobile bị truncate (BUG-045).

Actual keyboard checks có phạm vi giới hạn nhưng tích cực: Tab đầu tiên focus skip link, focus indicator nhìn thấy được, và Escape đóng dialog đã test. Đây không phải full accessibility PASS; tab order toàn trang, focus trap, announcement, contrast, screen reader và live axe vẫn chưa hoàn tất. Hai alias redirect đúng destination nhưng không mở/focus panel mục tiêu, reconfirm BUG-017 bằng Chrome.

Rủi ro polish bổ sung: nhiều `transition: all` và `outline: none`, thiếu reduced-motion cho celebration/step animation của onboarding, placeholder dùng ASCII `...`, và CSS storefront lớn (`PlatformLayout` khoảng 143 KB, `StorefrontLayout` khoảng 107 KB).

## Backend/API Và State Consistency

- Health endpoint trả HTTP 200 nhưng báo `commerce.provider_pending`; tín hiệu này hữu ích cho vận hành nhưng phải là release gate, không được hiểu là commercial-ready.
- Public storefront fail-closed đúng với subscription/readiness enforcement, nhưng label state phía Seller không nhất quán (BUG-008).
- Product ledger projection không nhất quán với canonical catalog projection (BUG-007).
- Seller physical-stock projection không dùng nguồn authoritative, mâu thuẫn với storefront/checkout (BUG-025).
- Shipping transition không có FSM/CAS/idempotency và có thể complete order sớm (BUG-018).
- D1 vẫn là nguồn authoritative; trong các path đã kiểm tra, KV/cache không làm nguồn quyết định cho billing hoặc stock.
- Product/order/customer có contract pagination/filter/sort; live Chrome chỉ kiểm tra được search persistence trên Products, 0-order/0-customer states và fake-order 404, chưa đủ full filter/sort/pagination/mutation matrix.

## Subscription/Billing Audit

Focused Dodo/catalog/worker/webhook suites đạt **153/153 pass**. Kết quả này không phủ định các design defect đã xác nhận ở BUG-002 đến BUG-006. Production hiện báo `provider_pending`; chưa xác minh invoice hoặc paid entitlement thật. Không nên chạy upgrade/downgrade/cancel/reactivate trên production trước khi Dodo sandbox xác minh cancel/reload/retry, expiry, processing, reconciliation exhaustion, 401/403, webhook replay và rollback.

## Domain/DNS Và Integrations

Đã discover domain, DNS, SSL, primary/custom-domain state machine và API nhưng không thực hiện DNS mutation hoặc external verification live. Certificate HTTPS cho `*.selinow.com` hợp lệ đến 2026-10-24, song HTTP redirect/HSTS vẫn là blocker. Telegram, Zalo OA, PayOS, API credentials, automation, shipping, media và webhooks đã được inventory; external authentication/connect/disconnect vẫn chưa xác minh.

## Release Và Migration Audit

- Clean HEAD có migration ledger hỏng vì thiếu tracked `0113` (BUG-032); dirty worktree che lỗi bằng file untracked. Không deploy dirty tree.
- `0113–0115` additive, nhưng Worker mới không chạy được trên schema cũ: billing cần cột `0113`, OTP issuance cần table `0114`, auth queries cần `pending_password_hash` từ `0115`. Trình tự bắt buộc: **backup/drill → migrate schema → validate invariants → deploy Worker**; không rollback migration.
- Rollback Worker committed không tương thích behavior với provider-backed `open` checkout (BUG-004). Cần fix-forward/compat rollback hoặc drain/block checkout và chứng minh zero open sessions trước rollback.
- `npm run deploy:dry-run` chỉ chạy local build/Wrangler `--dry-run` vì admission bị skip khi `dryRun`/`buildOnly` (`scripts/deploy.mjs:95-100,564-577`). PASS này không kiểm tra remote migration ledger, backup/restore, secrets, routes, D1 preflight hay approvals.
- Auth migrations còn thiếu retention và real-D1 concurrency/atomicity coverage (BUG-038, BUG-039).

Release sequence đề xuất: tạo clean reviewed commit chứa `0113` + dependent code/tests; xác nhận target DB đang kết thúc ở `0112`; chạy clean gates; staging backup/restore drill; apply `0113–0115`; deploy staging Worker; chạy Dodo/auth UAT + lost/late webhook + rollback rehearsal; chỉ sau observation/owner approvals mới lặp ceremony production.

External release requirements còn thiếu: 4 owner-approved live Dodo product IDs; Dodo API key/webhook key/public ID cùng live business/catalog; fresh staging UAT artifact; production backup/restore evidence; named monitoring/support/rollback owners. Không ghi hoặc kiểm tra giá trị secret trong report.

## Performance

TTFB staging tương đối khoảng 0.64–1.26 giây. Không kết luận Core Web Vitals tuyệt đối vì actual Chrome run không thu thập LCP/CLS/INP đầy đủ trên representative authenticated/public journeys. CSS payload lớn và image thiếu dimensions là các rủi ro performance rõ nhất. Build cũng cảnh báo dynamic import của inventory crypto không có tác dụng do module này được static import ở nơi khác.

## Scorecard

Điểm là release-risk score, không phải pass-rate: **High** = production probe hoặc focused test + source; **Medium** = source/staging contract với một phần runtime; **Low** = inventory/read-only only hoặc browser/provider bị blocked.

| Hạng mục | Điểm / 10 | Evidence / confidence |
|---|---:|---|
| Onboarding | 2 | Medium-high — 91 tests/source + actual existing-shop validation fail; full New Seller flow blocked; 4 P1s |
| Seller Dashboard | 6 | Medium — partial Chrome + source; state-label inconsistency |
| Product Management | 3 | Medium-high — actual create/edit entitlement failures; no successful lifecycle mutation |
| Store Management | 4 | Medium — Builder observed; readiness mismatch |
| Theme/Template | 6 | Medium — source/staging contracts; baselines stale |
| Public Storefront | 4 | High — production probes; safe fail-closed + HTTP blocker |
| Customer Experience | 4 | Medium — guest routes probed; purchase blocked |
| Checkout | 2 | High risk confidence — source/focused tests; provider pending |
| Orders | 3 | Medium — source/API tests; live mutation blocked |
| Subscription/Billing | 2 | High risk confidence — production snapshot + focused tests |
| Domain/DNS | 5 | Low — state machine mapped; no live mutation/propagation |
| Integrations | 3 | Medium — actual automation create contract failure; no external authentication |
| Backend/API Logic | 4 | High — 164 API tests + source findings |
| Authorization | 4 | High — focused isolation tests + confirmed intra-tenant gaps |
| UI Quality | 5 | Medium-high — staging/source + actual overflow/truncation; full state matrix incomplete |
| UX Quality | 4 | Medium-high — actual invalid fallback, raw errors, stale/loading and alias-focus defects |
| Responsive | 3 | High defect confidence — actual 320/390 px overflow on Seller and storefront |
| Accessibility | 5 | Medium — static contracts + confirmed axe failure |
| Performance | 6 | Low — relative TTFB/source only; no production CWV |
| Error Handling | 3 | Medium-high — actual invalid response, raw entitlement, members and token recovery failures |
| Overall Readiness | 2 | High decision confidence — multiple independent P1 gates |

## Remediation Roadmap

### Critical Remediation Matrix

| Problem | Root cause | Impact | Recommended solution | Priority | Regression test |
|---|---|---|---|---|---|
| BUG-001 plaintext HTTP | Edge không canonicalize scheme; HSTS absent | MITM/downgrade trên public/store/API | Universal 308 + staged HSTS after verified TLS | Immediate | HTTP matrix mọi host/path; custom-domain/local exclusions |
| BUG-002/003 checkout dead-lock | Client mất stable attempt; backend thiếu stale-provider terminal state | Seller không retry/upgrade được | Persist session identity, explicit cancel/expiry/quarantine/replacement | Immediate | Cancel/reload/return/null/processing/exhausted/late webhook |
| BUG-004 rollback incompatibility | Forward và rollback Worker hiểu `open` khác nhau | Expire/suspend payment in-flight hoặc paid-lost-webhook | Compat rollback or checkout drain + zero-open proof | Immediate | Forward→rollback with in-flight, paid-late, missed webhook |
| BUG-032 missing tracked `0113` | Migration local chưa commit trước `0114/0115` | Clean release admission fail; dirty deploy integrity risk | Commit reviewed migration unit; validate Git tree in CI/dry-run | Immediate | Clean archive ledger must be 1..N continuous |
| BUG-014/026 onboarding false/block | Active client/API drift; celebration in `finally`; activation errors swallowed | New Seller không cấu hình/publish nhưng thấy success | Canonical contracts + verified server projection before success | Immediate | 400/403/404/409/500/network, refresh, retry, real route methods |
| BUG-033 demo inventory sellable | Preset dùng production inventory import với active status | Giao mã giả, refund/chargeback | Draft/non-allocatable demo; require real stock; quarantine existing sample rows | Immediate | Preset cannot satisfy fulfillment/readiness until replacement |
| BUG-018 shipping state corruption | Không FSM/CAS/idempotency | Complete sớm, đi lùi, lost update | Explicit transition graph + version guard + transaction/idempotency | Immediate | Skip/backward/double-submit/two-tab/concurrent reservation |
| BUG-019 order-message RBAC | `shop:read` thay dedicated order visibility | Viewer/support lộ message/PII | Viewer deny, support masked, owner/manager full | Immediate | Role matrix + direct URL/ID manipulation |

Verification blocker BUG-010: làm deterministic local server/cache lifecycle, sau đó bắt buộc rerun browser matrix; không gộp nó thành product incident production.

### Immediate — P0/P1

1. Enforce universal HTTPS redirect at the edge and validate HSTS/custom-domain rollout safely (BUG-001).
2. Redesign Dodo checkout recovery and stale-session release; add cancel/reload/retry/expiry browser tests (BUG-002, BUG-003).
3. Commit/review missing `0113`, validate ledger from clean Git tree, and block deployment of dirty worktree (BUG-032).
4. Build a state-compatible rollback candidate and rehearse lost/late webhook rollback; never blind rollback while provider checkout remains `open` (BUG-004).
5. Repair active onboarding client/API contracts and make publish success conditional on verified backend publication/readiness (BUG-014, BUG-026).
6. Remove/quarantine demo license keys from sellable inventory and require real inventory before publish (BUG-033).
7. Enforce shipping FSM/CAS/idempotency và order-message RBAC (BUG-018, BUG-019).

### Test Environment Blocker

1. Repair local Astro/Vite E2E harness, then repeat authenticated Seller/public responsive, keyboard, a11y and state-consistency gates (BUG-010). Đây là release-verification blocker, không phải bằng chứng production runtime hỏng.

### Short-term — P2

1. Require exact checkout/tenant metadata binding during reconciliation (BUG-005).
2. Classify provider 401/403 as platform configuration/unavailable and alert operators (BUG-006).
3. Fix `COUNT(DISTINCT product_variants.id)` projection and add one-variant/many-key regression coverage (BUG-007).
4. Publish a single readiness state machine to Dashboard, Store Builder and storefront (BUG-008).
5. Remove nested focusable controls under `aria-hidden` ProductCard wrapper (BUG-009).
6. Localize onboarding v2 and replace the obsolete onboarding browser contract (BUG-015, BUG-016).
7. Sửa catalog/integration RBAC, nested stock hierarchy và stock conflict semantics (BUG-020 đến BUG-023).
8. Đồng bộ physical stock projection giữa Seller/storefront/checkout (BUG-025).
9. Fix existing-shop persistence, pricing plan carryover, stable idempotency và policy attestation flow (BUG-027 đến BUG-030).
10. Make OTP registration/session commit retry-safe, add server-backed signup resume và preserve redirect intent (BUG-031, BUG-035).
11. Unify onboarding resume/overview with authoritative readiness and gate manager/non-owner UX (BUG-034, BUG-036).
12. Add bounded OTP admission retention and real-D1 auth migration/concurrency tests (BUG-038, BUG-039).
13. Enforce visible required-field validation and authoritative projection before onboarding step transition (BUG-040).
14. Fix automation action-field applicability and normalize the create response contract (BUG-041).
15. Diagnose and restore the production membership ledger query with retry/request-ID diagnostics (BUG-042).
16. Align product create/edit controls with subscription entitlement and provide a billing recovery CTA (BUG-043).
17. Repair Account Security token refresh, terminal loading states and per-tab error reset (BUG-044).
18. Remove Seller/storefront overflow at 320/390 px and add responsive overflow assertions (BUG-045).

### Medium-term — P3

1. Fix test doubles/full-suite contention and keep the complete Vitest gate green (BUG-011).
2. Add explicit image dimensions/aspect ratios and CLS assertions (BUG-012).
3. Deploy and regression-test the billing hidden operation banner fix (BUG-013).
4. Replace `transition: all`, restore visible focus outlines, and normalize typographic punctuation.
5. Complete authenticated tablet/mobile/keyboard audit after the local harness is repaired; preserve actual Chrome artifacts as a separate production evidence layer.
6. Make Seller aliases activate and focus the intended panels (BUG-017).
7. Đồng bộ shipping audit resource ID để timeline đầy đủ (BUG-024).
8. Derive preset launch summary from actual fulfillment type (BUG-037).
9. Return explicit invalid-resource/shop feedback instead of silent deep-link fallback (BUG-046).

### Long-term — P4

1. Reduce storefront CSS payload and measure LCP/INP/CLS on representative templates.
2. Add automated cross-module state-consistency probes: Seller → API → D1 → storefront → customer.
3. Add safe staging drills for domain propagation, payment failure, webhook replay and multi-tab concurrency.

## Limitations Và Release Decision

Actual Chrome run đã giữ nguyên session Seller hiện tại, mở read-only đủ 17 functional Seller screens, kiểm tra 2 aliases và thực thi sâu một tập negative/recovery/responsive/accessibility flows. Tuy nhiên đây là bounded production audit: không có safe fixture cho financial/destructive/cross-tenant mutation và không thu thập được full action/modal/network/DB matrix trên mọi screen. Các phạm vi sau là **Blocked/Not tested live**, không phải PASS:

- New Seller signup/OTP/onboarding hoàn chỉnh; close-reopen/session-change recovery. Existing-shop empty-name + refresh path đã được test và fail/pass theo từng assertion.
- Second tenant và cross-tenant ID manipulation; manager/support/viewer/customer/authenticated-admin sessions. Seller owner→admin denial và fake order 404 đã được test.
- Successful product mutation/publish/archive, real order/customer/fulfillment mutation, multi-tab/concurrency và direct D1 before/after inspection. Product create/edit rejected paths đã được test.
- Checkout/payment/order confirmation; upgrade/downgrade/cancel/reactivate; invoices/payment method.
- Domain/DNS/SSL propagation, custom hostname mutation và primary-domain redirect; current default/custom-domain states chỉ được read-only inspect.
- PayOS/Dodo/Telegram/Zalo/OAuth/webhook connect/disconnect/reconnect, expired credentials và external timeout; automation create failure và provider summary state đã được inspect.
- Full all-screen tablet/landscape/zoom/mobile matrix, complete keyboard order/focus trap, screen reader semantics, live axe và absolute LCP/CLS/INP. Bounded Tab/skip-link/focus/Escape checks đã pass.

Production state probes chỉ dùng GET và các validation POST dừng trước order/payment creation. Tài khoản Seller hiện tại không bị logout; không đọc cookie/local storage/password/secret; không có financial/destructive operation hoặc production DB mutation.

Với các lỗi P1 đã xác nhận ở billing recovery/expiry/rollback, false-success onboarding, plaintext HTTP và việc chưa có clean live E2E gate, quyết định release là:

> **🟠 NOT READY — Không promote commerce changes lên production.**

Chỉ mở lại release audit sau khi các P1 fix đã deploy lên Dodo sandbox/staging, local browser harness hoạt động, toàn bộ authenticated/public responsive matrix pass, và rollback/reconciliation drill tạo được evidence bền vững.
