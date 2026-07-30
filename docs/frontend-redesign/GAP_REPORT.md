# Frontend dependency gap

Updated: 2026-07-30

This report distinguishes a backend contract that is genuinely missing from a backend capability that exists but has no truthful UI. No unsupported production behavior is mocked.

## Backend capability now covered by truthful UI

| Area | Evidence | Current UI result |
| --- | --- | --- |
| Deletion legal hold | `listActiveDeletionRequests()` and the existing audited legal-hold POST contract | `/admin/operations` renders a safe active queue, lifecycle evidence, owner/risk set-release controls and support read-only projection. |
| Seller moderation | Owner-scoped `product_suspend` / `product_restore` actions | `/app/data` renders eligible restore only for owner-originated suspensions; ordinary catalog PUT cannot bypass a moderation suspension. |
| Domain lifecycle | Existing tenant-scoped domain API | `/app/domains` SSRs the selected tenant, renders `ownership → hostname → DNS → SSL → primary → routing`, and keeps suspended/forbidden/plan-limited states explicit. |
| Inventory import | Existing preview/import endpoints | `/app/inventory` clears plaintext on close/error/success, invalidates stale previews, locks pending mutations and maps safe error/request IDs. |
| Provider integrations | Existing Telegram, PayOS and domain GET/health contracts | `/app/integrations` SSRs authorized projections, uses the AppLayout tenant context, and leaves unsupported provider aggregates unavailable. |
| Payment exception evidence | Existing safe evidence projection | `/app/orders` allowlists mismatch evidence and links to the tenant-scoped order detail without adding remediation controls. |
| Shop display name | Existing `PATCH /api/app/shops/:shopPublicId` contract backed by `updateShopName()` | Onboarding exposes a tenant-bound rename form only for owner/manager, preserves the selected shop and immutable slug/URL, sends CSRF through the shared request client, and refreshes from the server response. |
| Automation task ledger | Existing tenant-scoped automation list/cancel/resume contracts | `/app/automation` SSRs the safe task projection, exposes truthful empty/forbidden/unavailable states, and keeps cancel/resume guarded by server capability, CSRF, recent-auth, idempotency and optimistic version checks. |
| Buyer quantity/quote integrity | Existing public catalog and quote snapshots | Product and cart controls fail closed on malformed/expired snapshots, enforce server-projected min/max bounds and recheck the authoritative product snapshot before enabling add-to-cart. |
| Seller shell tenant context | Existing selected-shop navigation helper | Mobile dialog state is announced with `aria-controls`/`aria-expanded`, support/viewer setup links stay read-only, and SSR actions across billing, customers, integrations, inventory, members, orders and onboarding domains retain the selected shop when JavaScript is disabled. |
| Seller data controls | Existing export, deletion and moderation POST contracts | `/app/data` now reads the runtime `${SESSION_COOKIE_NAME}_csrf` name from SSR data instead of a hard-coded cookie, so local/staging owner mutations use the same CSRF contract as the authenticated session. |
| Admin Sellers & Shops | Existing platform-admin roles plus D1 shop/subscription/member/product/channel state | `/admin/shops` and `GET /api/admin/shops` provide a bounded, cursor-paginated, server-filtered read-only directory using only public shop identity and aggregate operational health. Platform-user identity, credentials, keys, buyer tokens and provider payloads are not selected. |

## Backend contract missing or not sufficient for production UI

| Area | Evidence | Backend work required before UI claims capability |
| --- | --- | --- |
| Seller order messages | `src/pages/app/orders/[id].astro:163-166` explicitly says no seller message contract. | Define tenant-scoped message thread/read/send API, channel/provider capability, idempotency, audit, moderation and safe delivery status. |
| Seller order notes | `src/pages/app/orders/[id].astro:168-171` explicitly says no note contract. | Define append/list note API, role capability, immutable audit, optimistic version and redaction policy. |
| Payment exception remediation/refund | `src/pages/app/orders/[id].astro:183` says no override; current payment exception reads are read-only. | Define exception transition/remediation/refund evidence contract with payment-provider authority, role/recent-auth/CSRF/idempotency and audit. |
| Members invite/role/revoke | `src/pages/app/members.astro:28-39` labels invite unavailable and explains mutation contract is absent. | Add invite token lifecycle, role mutation, revoke, ownership safeguards, recent-auth/CSRF/idempotency and audit endpoints. |
| Billing upgrade/cancel | `src/pages/app/billing.astro:31-42` is a read-only runtime projection. | Define subscription plan catalog, checkout/provider ownership, proration/tax/legal policy, idempotency and current-plan mutation API. |
| Admin Orders & Payments investigation | `src/layouts/AdminLayout.astro:33` marks investigation API unavailable. | Add cross-tenant-safe masked payment/order investigation projection and evidence-only remediation workflow. |
| Admin Appeals / Refunds | `src/layouts/AdminLayout.astro:34` marks queue API unavailable. | Add appeal/refund queue contract, provider evidence and bounded state machine before UI. |
| Full audit explorer | Admin currently has moderation/operations ledgers only. | Add paginated filter/read API with redacted metadata and immutable cursor contract. |

## Existing UI behavior that must be corrected

- Inventory now projects the server threshold per variant, exposes low/out-of-stock filters and hardens import plaintext/preview lifecycle; the current authenticated local gate covers desktop/mobile behavior and the 1440/768/390/320px viewport matrix.
- Store builder now renders a safe server-backed active-catalog preview projection (`src/lib/storefront/preview.ts`) with explicit empty/error/truncated states and no buyer mutation affordances. Its current local desktop/mobile baselines are part of the reviewed 28-snapshot authenticated set.
- Product manager now creates the product, first variant, idempotency receipt and safe audit receipt in one tenant-scoped D1 batch; a variant failure rolls the product back, and retries return the original IDs. It also supports a second variant, preserves opaque options on update, exposes an out-of-stock filter and renders the server product update time in the shop timezone. Category and product archive retain linked commerce evidence. Channel visibility and a hidden state still lack backend contracts and remain unavailable.
- Public abuse reporting is implemented across storefront, product, cart, checkout and order layouts through the sanitized Turnstile/idempotency API. The product target is now offered only when a reportable product resolved, so a product 404 cannot present an action the backend will reject as `resource_not_found`. Source/axe coverage remains authoritative for the dialog; the current public staging visual gate is 18/20 because both desktop and mobile cart checks stop before screenshot when the deployed Worker lacks the current hydration selector.
- Order list/detail surfaces now show allowlisted expected/received amounts, evidence time and key-count mismatch impact; payment exception remediation remains read-only until the audited backend contract above lands.
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

- Current source verification: `npm run check` passed with 0 errors and 3 existing
  non-blocking hints; `npm run lint` passed; `npm test` passed with 184 files /
  1,371 tests; `npm run build` and `npm run deploy:dry-run` passed without
  deployment.
- The authenticated Playwright contract enumerates 14 seller/admin routes with 28
  desktop/mobile screenshot comparisons plus axe, overflow and console checks.
  The isolated local gate passes 6/6 and all 28 current-source snapshots were
  regenerated and manually reviewed at 1440x1024 and 390x844; runtime, axe,
  overflow and console coverage also includes the 768px and 320px viewports. The
  current staging public visual gate is 18/20: two cart tests
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
