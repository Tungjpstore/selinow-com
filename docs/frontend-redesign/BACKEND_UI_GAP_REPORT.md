# Frontend/backend coverage report

Updated: 2026-08-03

This report tracks the PromptOS seller surfaces against the contracts that are
actually implemented. A surface is called operational only when it reads or
mutates tenant-scoped state through a real service; unavailable mutations remain
truthfully disabled instead of being simulated in the browser.

## Implemented seller surfaces

- **Catalog:** `/app/products` now exposes category-aware draft creation,
  search/status filters, product/variant editing, category name/slug/description/
  status/sort-order updates and explicit category/product archive confirmations
  through the existing tenant-scoped catalog APIs and capability guards. Category
  archive retains linked products; product archive retains existing order and
  inventory evidence. The ledger also renders the authoritative product update
  timestamp using the shop timezone instead of inventing a variant-level date.
- **Inventory:** `/app/inventory` projects tenant-scoped available, reserved and
  delivered counts, server low-stock thresholds and last-import timestamps. The
  import drawer clears plaintext from the form/request lifecycle, invalidates
  stale previews after success, cancel, close, shop switch and terminal errors,
  locks pending actions and maps safe errors without exposing inventory-key
  plaintext in HTML, logs or screenshots. Onboarding uses the same cleanup
  contract for preview/import failures.
- **Overview:** `/app` now separates shop lifecycle from sellability. The
  headline and storefront action use the owner-authoritative readiness result;
  active-but-blocked, unavailable and role-limited states remain distinct, and
  the action queue cannot claim an all-clear while required projections are
  forbidden or unavailable. Payment and fulfillment projections remain separate.
- **Orders:** `/app/orders` and `/app/orders/:id` use tenant-scoped seller order
  projections. Payment and fulfillment stay on separate axes; customer identity,
  access tokens, provider payloads and key plaintext are never returned. Payment
  exception evidence is allowlisted into localized amount/time/key-count facts;
  the ledger remains read-only and links to the tenant-scoped order detail.
- **Customers:** `/app/customers` reads a masked customer ledger and safe order
  metadata, with explicit empty and unavailable states. Owner/manager detail,
  profile/status update, immutable notes and optimistic redaction controls now
  use the tenant-bound `/api/app/shops/:shopPublicId/customers/...` contracts.
- **Members:** `/app/members` reads membership, role and status projections with
  masked identity fields and server-derived capabilities. Owner invitation,
  role change, suspension and revoke controls are backed by migration `0053`,
  recent-auth/CSRF routes, optimistic versions, idempotency records and audit
  receipts.
- **Billing:** `/app/billing` reads subscription, entitlement and usage
  projections from D1 without inventing plan limits or payment state. Owner
  plan/cancel requests are rendered as audited provider-pending intents; no
  payment method, proration or settlement is fabricated.
- **Store builder:** `/app/store` reads and writes validated draft settings,
  exposes draft/live publication state, supports owner-only publish through the
  readiness gate, includes bounded SEO title/description fields, and renders a
  narrow tenant-scoped active-catalog preview without buyer mutation affordances.
  Public storefront rendering reads only the published snapshot from migration
  `0029`.
- **Shop identity:** onboarding now exposes the existing audited shop-name PATCH
  contract only to owner/manager roles. The selected tenant remains authoritative,
  support/viewer never receive the mutation control, and slug/storefront URL are
  explicitly unchanged.
- **Data/audit:** `/app/data` uses the encrypted export, deletion/legal-hold and
  immutable audit projections already provided by the operations services.
- **Moderation:** `/app/data` exposes owner-originated product restore only when
  the server projection marks it eligible; ordinary catalog edits cannot bypass
  an applied moderation suspension.
- **Domain manager:** `/app/domains` SSRs the selected tenant, renders the full
  PromptOS lifecycle rail and keeps DNS/SSL/primary/routing actions bound to the
  existing domain contracts.
- **Integrations:** `/app/integrations` SSRs Telegram, PayOS and domain health for
  roles already authorized by backend capability checks, while support/viewer and
  unsupported aggregates remain explicitly unavailable.
- **Channel expansion:** `/app/integrations` also reads the safe channel-expansion
  catalog and tenant-bound connector requests for Telegram Mini App, Zalo Mini App,
  WhatsApp Cloud and Discord. Owner/manager request and cancel actions retain CSRF,
  recent-auth, idempotency and optimistic-version guards; provider activation is
  never inferred from a request state.
- **Admin operations:** `/admin/operations` reads a safe active deletion queue and
  exposes owner/risk legal-hold controls with support read-only access. It now
  also shows a bounded masked investigation/audit evidence bridge and links to
  the full read-only `/admin/investigations` explorer.
- **Admin Sellers & Shops:** `/admin/shops` and `GET /api/admin/shops` use active
  platform-admin authorization, enum filters and an opaque cursor to read public
  shop identity plus subscription, owner coverage, active-product and generic
  channel-health aggregates. The query does not join platform-user identity,
  credential, inventory-key, buyer-token or provider-payload fields, and the UI
  intentionally offers no impersonation or mutation shortcut.
- **Navigation/security:** `/app/telegram` and `/app/store/settings` are safe
  aliases, the global shop picker is membership-bound, and private/no-store plus
  noindex headers are centralized in middleware for authenticated surfaces. The
  responsive shell includes an explicit same-origin logout action. Seller action
  links preserve the selected tenant across billing, customers, integrations,
  inventory, members, orders and onboarding domain navigation, while `/app/data`
  resolves the environment-specific CSRF cookie name from SSR instead of assuming
  one local cookie literal.
- **Automation:** `/app/automation` reads the existing tenant-scoped task
  projection and offers only server-backed refresh/cancel/resume controls.
  Provider evidence tokens and internal references remain absent from the UI.
- **API credentials:** `/app/integrations` now consumes the existing
  recent-authenticated issue/list/revoke endpoints. It renders only scoped
  metadata, reveals the newly issued token once, never stores it in browser
  storage, and preserves idempotency plus optimistic-version revocation.
- **Buyer integrity:** public product/cart controls enforce server-projected
  quantity bounds and fail closed on malformed or expired quote snapshots.
- **Seller operations backend:** order internal notes support tenant-bound
  list/append/redact with immutable bodies, version guards and replay-safe
  idempotency. Admin-only order investigations and audit exploration expose
  masked order/payment evidence, bounded cursors and allowlisted metadata only.
- **Backend gap workflows:** migration `0054_backend_gap_workflows.sql` adds
  provider-pending seller order messages, audited payment remediation requests,
  optimistic billing change requests and an admin appeals/refunds projection.
  These workflows never mark a message sent, refund completed or subscription
  changed without verified provider/operator evidence.

## Implemented buyer interactions

- Storefront search and category filters operate only on the public published
  catalog projection.
- Product cards and product detail choose an available variant before a sold-out
  fallback. Product detail rechecks the current public API snapshot and blocks
  add-to-cart on version/price/stock drift; cart and checkout block continuation
  after server quote expiry, and checkout errors surface only a safe request ID.
- Storefront, product, cart, checkout and order layouts expose the real sanitized
  abuse-report flow with Turnstile, idempotency and safe confirmation. Product
  targeting is rendered only after a real public product resolves; unknown or
  unavailable product routes remain limited to shop/domain reporting.

## Remaining backend/UI gaps

- **Billing provider settlement:** plan-change/cancellation request recording is
  implemented and rendered as an audited pending intent, but payment-method capture, pricing/proration, provider
  execution and completion webhooks remain required before the subscription can
  mutate.
- **Customers:** merge and deletion remain intentionally unimplemented; detail,
  edit, notes and redaction now have privacy-safe tenant contracts and owner/
  manager browser controls. Support/viewer remains read-only.
- **Orders:** seller message request/list/redaction is implemented with a
  provider-pending state; verified channel delivery, retry scheduling and
  payment/fulfillment overrides remain unavailable. Internal notes remain
  tenant-bound and hidden from unsupported UI controls.
- **Catalog presentation:** migration `0069` now provides a tenant-bound product
  channel-visibility GET/PUT contract with fail-closed missing rows, and Website
  plus Telegram Mini App projections apply the visible fence. The product client
  now exposes inline controls that remain disabled until server hydration succeeds,
  then use CSRF/recent-auth, idempotency and expected-version conflict reloads;
  provider activation and remote migration admission remain separate gates.
  Product creation plus the first variant now commits atomically with its
  idempotency and audit receipts; focused rollback, replay/conflict and
  cross-tenant coverage closes the former two-write orphan-draft risk.
- **Global shop configuration:** onboarding now exposes tenant-scoped merchant and
  business country, supported currency and default-locale controls for initial
  setup and later settings updates. Server validation, currency-drift guards and
  the authenticated local visual gate cover the truthful seller flow.
- **Provider-backed UAT:** Telegram/PayOS integration APIs and the integrations
  workspace are present, but a dedicated seller test bot, controlled PayOS
  channel, Telegram Mini App/Zalo/WhatsApp/Discord provider credentials and
  provider-backed automation parity are still external acceptance work. The
  connector catalog/request UI records intent only; the SSR/UI work does not
  replace provider-backed activation, webhook or delivery gates.
- **Authenticated visual evidence:** the automation workspace, buyer-bound
  controls and shell/static tenant-link changes are covered by source/unit
  contracts. The isolated local Playwright gate passes 7/7 across desktop/mobile
  and 1440/768/390/320px coverage; all 42 current-source authenticated snapshots
  for 21 surface IDs were reviewed at 1440x1024 and 390x844; the Phase 2
  dashboard copy change intentionally refreshed the mobile dashboard baseline.
  The public local gate passes 27/27 with 26 additional route/state screenshots.
- **Additional adapters:** managed shared channels, DNS-provider authorization,
  social/marketplace adapters and a second payment provider remain roadmap work.
  The four channel-expansion manifests and connector workflow are contract-ready or
  provider-pending only; provider credentials, webhooks, delivery evidence and
  external activation remain separate acceptance gates.

## Product boundary

No screen fabricates sales, stock, payment, entitlement, customer or provider
state. D1 remains authoritative; cache/KV is never used to decide a commerce or
subscription mutation. Production remains `NO-GO` until Phase 10 release gates,
controlled provider pilots, operations evidence and ownership approvals pass.

- Latest continuation verification counts and artifact paths are recorded in
  `docs/PHASE_2_REVIEW_PACKAGE_R1.md`; no deployment or remote migration is
  performed here.

All latest frontend slices remain local-only. No staging deployment or production
mutation was performed. The authenticated Playwright contract defines 21 surface
IDs and 42 desktop/mobile screenshots plus axe, horizontal-overflow and console
checks; the isolated local gate passes 7/7. The public gate passes 27/27 with 26
route/state screenshots. The active PromptOS matrix remains 19 routes / 82
route-state pairs, with unlisted variants retained as explicit follow-up.
The public staging gate is 18/20 because desktop/mobile cart checks fail closed
before screenshot on the older deployed hydration contract. The read-only
1440/768/390/320 viewport matrix passes 4/4. The in-app Browser loopback refusal
is a tool limitation; the repository's isolated local gate supplies the complete
current-source rendered evidence without staging or production bindings.
