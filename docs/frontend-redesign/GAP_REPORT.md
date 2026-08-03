# Frontend dependency gap

Updated: 2026-08-03

This report distinguishes a backend contract that is genuinely missing from a backend capability that exists but has no truthful UI. No unsupported production behavior is mocked.

## Backend capability now covered by truthful UI

| Area | Evidence | Current UI result |
| --- | --- | --- |
| Deletion legal hold | `listActiveDeletionRequests()` and the existing audited legal-hold POST contract | `/admin/operations` renders a safe active queue, lifecycle evidence, owner/risk set-release controls and support read-only projection. |
| Seller moderation | Owner-scoped `product_suspend` / `product_restore` actions | `/app/data` renders eligible restore only for owner-originated suspensions; ordinary catalog PUT cannot bypass a moderation suspension. |
| Domain lifecycle | Existing tenant-scoped domain API | `/app/domains` SSRs the selected tenant, renders `ownership → hostname → DNS → SSL → primary → routing`, and keeps suspended/forbidden/plan-limited states explicit. |
| Inventory import | Existing preview/import endpoints | `/app/inventory` clears plaintext on close/error/success, invalidates stale previews, locks pending mutations and maps safe error/request IDs. |
| Provider integrations | Existing Telegram, PayOS and domain GET/health contracts | `/app/integrations` SSRs authorized projections, uses the AppLayout tenant context, and leaves unsupported provider aggregates unavailable. |
| Channel expansion | Migrations `0055_channel_connector_requests.sql` and `0056_channel_connector_scope_guards.sql`, safe expansion manifests and connector catalog/request APIs | `/app/integrations` renders Telegram Mini App, Zalo Mini App, WhatsApp Cloud and Discord contracts; owner/manager request/cancel controls are guarded, and direct-D1 scope guards reject cross-tenant/inactive/mismatched connector inserts. Provider activation remains explicitly pending. |
| API credential management | Existing recent-authenticated issue/list/revoke contracts | `/app/integrations` lists scoped credentials, issues a one-time token, supports clipboard copy without browser storage, and revokes with idempotency plus optimistic version checks. |
| Payment exception evidence | Existing safe evidence projection | `/app/orders` allowlists mismatch evidence and links to the tenant-scoped order detail without adding remediation controls. |
| Shop display name | Existing `PATCH /api/app/shops/:shopPublicId` contract backed by `updateShopName()` | Onboarding exposes a tenant-bound rename form only for owner/manager, preserves the selected shop and immutable slug/URL, sends CSRF through the shared request client, and refreshes from the server response. |
| Automation task ledger | Existing tenant-scoped automation list/cancel/resume contracts | `/app/automation` SSRs the safe task projection, exposes truthful empty/forbidden/unavailable states, and keeps cancel/resume guarded by server capability, CSRF, recent-auth, idempotency and optimistic version checks. |
| Buyer quantity/quote integrity | Existing public catalog and quote snapshots | Product and cart controls fail closed on malformed/expired snapshots, enforce server-projected min/max bounds and recheck the authoritative product snapshot before enabling add-to-cart. |
| Seller shell tenant context | Existing selected-shop navigation helper | Mobile dialog state is announced with `aria-controls`/`aria-expanded`, support/viewer setup links stay read-only, and SSR actions across billing, customers, integrations, inventory, members, orders and onboarding domains retain the selected shop when JavaScript is disabled. |
| Seller data controls | Existing export, deletion and moderation POST contracts | `/app/data` now reads the runtime `${SESSION_COOKIE_NAME}_csrf` name from SSR data instead of a hard-coded cookie, so local/staging owner mutations use the same CSRF contract as the authenticated session. |
| Admin Sellers & Shops | Existing platform-admin roles plus D1 shop/subscription/member/product/channel state | `/admin/shops` and `GET /api/admin/shops` provide a bounded, cursor-paginated, server-filtered read-only directory using only public shop identity and aggregate operational health. Platform-user identity, credentials, keys, buyer tokens and provider payloads are not selected. |
| Seller operations backend | Migrations `0053_seller_operations_contracts.sql` and `0054_backend_gap_workflows.sql` plus member/customer/order/admin services and routes | Member invitations/role/suspension/revoke, customer detail/update/notes/redaction, order notes/messages, masked admin order investigations, billing change requests, payment remediation queue and redacted audit pagination are tenant-bound, idempotent and audited. Provider completion remains explicitly pending. |
| Seller members operations | Migrations `0053` plus invitation/role/suspension/revoke contracts | `/app/members` reads masked membership state and exposes owner-only guarded invitation, role, suspension and revoke controls with CSRF, recent-auth, idempotency, version and audit boundaries. |
| Admin payment remediation review | Existing admin appeals list/review contracts | `/admin/appeals` lists masked seller remediation requests and lets owner/risk roles record `provider_pending` or `rejected` decisions with CSRF, recent-auth, idempotency, optimistic version and explicit provider-pending copy. |
| Admin investigations and audit explorer | Existing masked order/audit projections | `/admin/investigations` provides filtered orders/audit tabs with opaque cursors, safe metadata and no mutation shortcut. |

## Backend contract missing or not sufficient for production UI

| Area | Evidence | Backend work required before UI claims capability |
| --- | --- | --- |
| Seller order messages | `src/lib/commerce/order-messages.ts` and `/api/app/.../messages` | Request/list/redaction is implemented locally with a provider-pending state; provider delivery evidence and retry scheduling remain pending. |
| Payment exception remediation/refund | `src/lib/payments/remediation.ts` and `/api/app/.../payments/remediation` | Audited seller request plus owner/risk review is implemented locally; only verified provider reversal may complete/refund. |
| Billing upgrade/cancel | `src/lib/tenants/billing-requests.ts` and `/api/app/.../billing/requests` | Plan catalog and optimistic request workflow are implemented locally; provider checkout, pricing/proration and completion evidence remain pending. |
| Admin provider completion | `/admin/appeals` now records the bounded review decision | Verified provider reversal, settlement evidence and completion webhooks remain required before a request can become `completed`. |

## Existing UI behavior that must be corrected

- Inventory now projects the server threshold per variant, exposes low/out-of-stock filters and hardens import plaintext/preview lifecycle; the current authenticated local gate covers desktop/mobile behavior and the 1440/768/390/320px viewport matrix.
- Store builder now renders a safe server-backed active-catalog preview projection (`src/lib/storefront/preview.ts`) with explicit empty/error/truncated states and no buyer mutation affordances. Its current local desktop/mobile baselines are part of the reviewed 42-snapshot authenticated set.
- Product manager now creates the product, first variant, idempotency receipt and safe audit receipt in one tenant-scoped D1 batch; a variant failure rolls the product back, and retries return the original IDs. It also supports a second variant, preserves opaque options on update, exposes an out-of-stock filter and renders the server product update time in the shop timezone. Category and product archive retain linked commerce evidence. Migration `0069` now supplies the tenant-bound product/channel visibility GET/PUT contract with fail-closed missing rows; `/app/products` now exposes inline channel controls with disabled-until-loaded state, CSRF/recent-auth, idempotency and expected-version conflict reloads. Provider activation and remote migration admission remain separate gates.
- Public abuse reporting is implemented across storefront, product, cart, checkout and order layouts through the sanitized Turnstile/idempotency API. The product target is now offered only when a reportable product resolved, so a product 404 cannot present an action the backend will reject as `resource_not_found`. Source/axe coverage remains authoritative for the dialog; the current public staging visual gate is 18/20 because both desktop and mobile cart checks stop before screenshot when the deployed Worker lacks the current hydration selector.
- Order list/detail surfaces now show allowlisted expected/received amounts, evidence time and key-count mismatch impact; payment exception remediation requests remain provider-pending until the audited provider contract completes them.
- The dedicated automation workspace and shop-name rename UI are source-verified; the isolated authenticated local browser gate supplies desktop/mobile rendered evidence without remote bindings.

## Safe UI fallback implemented

- Shared states expose loading/empty/success/warning/blocked/waiting-user/waiting-provider/error/forbidden/plan-limited/suspended without fabricating provider results.
- Unsupported mutation areas remain explicit read-only or blocked states with remediation copy.
- Sensitive values remain omitted; keys are hidden by default and only a server-authorized value can reach `KeyRevealCard`.

## Backend/product decisions required

- Whether seller messaging/notes are in MVP and which channel adapters may deliver them.
- Refund/appeal legal and PayOS authority policy.
- Billing provider and plan/price source of truth.
- Admin support scope for masked order/payment investigation.
- Whether the currently universal storefront abuse form should later become policy-enabled per merchant; that requires a published server-owned setting before UI gating changes.

## What was not mocked

No fake seller members, plan limits, refunds, payment remediation, provider health or buyer abuse submission result was introduced. The admin shop directory reads only the bounded D1 projection described above; existing backend state remains the only data source.

## Current verification boundary

- Latest completed frontend source verification checkpoint (before the current
  production promotion/DNS test additions): `npm run check` passed with 0 errors
  and 3 existing non-blocking hints; `npm run lint` passed; `npm test` passed with
  189 files / 1,447 tests; `npm run build` and `npm run deploy:dry-run` passed
  without deployment. Rerun the full repository gate before treating the test
  total as current.
- The authenticated Playwright contract covers 21 seller/admin surface IDs with 42
  desktop/mobile screenshots plus axe, overflow and console checks. The isolated
  local gate passes 7/7, and the public local gate passes 27/27 with 26 additional
  route/state screenshots. All 68 current-source snapshots were regenerated and
  manually reviewed at 1440x1024 and 390x844; runtime, axe, overflow and console
  coverage also includes the 768px and 320px viewports. The active PromptOS
  acceptance matrix remains 19 routes / 82 route-state pairs; unlisted variants
  remain documented follow-up rather than claimed pixel parity. The current
  staging public visual gate is 18/20: two cart tests
  fail closed before screenshot because the deployed staging Worker predates the
  hydrated-cart contract. The separate read-only 1440/768/390/320 viewport matrix
  passes 4/4; no snapshot, checkout or payment mutation occurred.
- Phase B source/local globalization gates are closed: source-level missing-key
  detection, unified BCP47 validation, durable Telegram explicit preference,
  canonical order currency binding, seller merchant/business-country controls,
  paired English/Vietnamese commerce evidence and the rendered RTL gate pass.
  Current-source authenticated visual review is complete; staging hydrated-cart
  acceptance remains open until the Worker matches the source contract.
- These frontend changes remain local source changes. No staging deployment or production mutation was performed.
