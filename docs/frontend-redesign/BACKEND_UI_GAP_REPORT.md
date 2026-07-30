# Frontend/backend coverage report

Updated: 2026-07-30

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
  stale previews, locks pending actions and maps safe errors without exposing
  inventory-key plaintext in HTML, logs or screenshots.
- **Orders:** `/app/orders` and `/app/orders/:id` use tenant-scoped seller order
  projections. Payment and fulfillment stay on separate axes; customer identity,
  access tokens, provider payloads and key plaintext are never returned. Payment
  exception evidence is allowlisted into localized amount/time/key-count facts;
  the ledger remains read-only and links to the tenant-scoped order detail.
- **Customers:** `/app/customers` reads a masked customer ledger and safe order
  metadata, with explicit empty and unavailable states.
- **Members:** `/app/members` reads membership, role and status projections with
  masked identity fields and server-derived capabilities.
- **Billing:** `/app/billing` reads subscription, entitlement and usage
  projections from D1 without inventing plan limits or payment state.
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
- **Admin operations:** `/admin/operations` reads a safe active deletion queue and
  exposes owner/risk legal-hold controls with support read-only access.
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
- **Buyer integrity:** public product/cart controls enforce server-projected
  quantity bounds and fail closed on malformed or expired quote snapshots.

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

- **Members:** invite, role-change and revoke mutations still need a complete
  recent-auth, CSRF, optimistic-version, idempotency and audit contract.
- **Billing:** plan change, payment-method, upgrade/downgrade and cancellation
  flows need an explicit subscription/billing provider and operator contract;
  the read-only projection must remain read-only until then.
- **Customers:** detail, edit, merge, notes and deletion actions need a defined
  privacy/retention contract. The current masked ledger is intentionally safe.
- **Orders:** seller message/note, retry-delivery and payment/fulfillment
  override actions are not available in the backend and are not shown as fake
  controls.
- **Catalog presentation:** product channel visibility and a hidden product state
  lack a backend contract and remain unavailable. Product creation plus the first
  variant now commits atomically with its idempotency and audit receipts; focused
  rollback, replay/conflict and cross-tenant coverage closes the former two-write
  orphan-draft risk.
- **Global shop configuration:** onboarding now exposes tenant-scoped merchant and
  business country, supported currency and default-locale controls for initial
  setup and later settings updates. Server validation, currency-drift guards and
  the authenticated local visual gate cover the truthful seller flow.
- **Provider-backed UAT:** Telegram/PayOS integration APIs and the integrations
  workspace are present, but a dedicated seller test bot, controlled PayOS
  channel and provider-backed automation parity are still external acceptance
  work. The SSR/UI work does not replace those provider-backed gates.
- **Authenticated visual evidence:** the automation workspace, buyer-bound
  controls and shell/static tenant-link changes are covered by source/unit
  contracts. The isolated local Playwright gate passes 7/7 across desktop/mobile
  and 1440/768/390/320px coverage; all 42 current-source authenticated snapshots
  for 21 surface IDs were regenerated and manually reviewed at 1440x1024 and
  390x844. The public local gate passes 27/27 with 26 additional route/state
  screenshots.
- **Additional adapters:** managed shared channels, DNS-provider authorization,
  social/marketplace adapters and a second payment provider remain roadmap work.

## Product boundary

No screen fabricates sales, stock, payment, entitlement, customer or provider
state. D1 remains authoritative; cache/KV is never used to decide a commerce or
subscription mutation. Production remains `NO-GO` until Phase 10 release gates,
controlled provider pilots, operations evidence and ownership approvals pass.

- Latest completed frontend source verification checkpoint (before the current
  production promotion/DNS test additions): `npm run check` passed with 0 errors
  and 3 existing non-blocking hints; `npm run lint` passed; `npm test` passed with
  189 files / 1,447 tests; `npm run build` and `npm run deploy:dry-run` passed
  without deployment. Rerun the full repository gate before treating the test
  total as current.

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
