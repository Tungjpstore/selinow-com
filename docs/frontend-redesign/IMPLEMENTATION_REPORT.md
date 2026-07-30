# Selinow PromptOS implementation report

Updated: 2026-07-30

## Outcome

The Astro frontend now follows the PromptOS Soft Precision Commerce direction
across marketing, seller workspace, buyer storefront and admin operations. The
critical seller and buyer paths use real tenant-scoped services and truthful
state projections; unsupported mutations remain unavailable rather than being
simulated.

The supported PromptOS frontend is substantially implemented at source level,
and the currently automated functional, runtime, accessibility and overflow
subset passes. The authenticated local browser gate passes 6/6 across its 14
seller/admin routes, with 28 reviewed snapshots at 1440x1024 and 390x844. The
Professional v1.0 checklist is 19/19 for source contracts, but it is not a full
route/state/pixel-parity acceptance matrix: public marketing/pricing/order-status,
workspace order detail, admin shops and blocked/degraded/expired/plan-limited
states still need canonical visual coverage. The public desktop baseline also
remains 1280x900; its 1440/768/390/320 matrix currently checks representative
overflow rather than screenshot parity. Staging acceptance remains open: the
last read-only staging visual gate was 18/20 because the deployed staging Worker
is older than the source contract and does not render `[data-cart-variant-id]`
for the desktop/mobile cart checks. No staging deployment occurred and production
remains `NO-GO`.

Phase B globalization is source/local-only. English (`en`) and Vietnamese
(`vi-VN`) catalogs, locale-aware storefront/dashboard/Telegram/email surfaces,
minor-unit money formatting, country/currency guards, source-level key/
placeholder detection and unified BCP47 handling are implemented and covered by
focused tests. Tenant-scoped Telegram `/language en|vi` preference is durable
and outranks verified identity, request language, shop default and English
fallback. Paired English/Vietnamese commerce behavior and the logical/rendered
RTL gate also pass locally. No staging or production resource is used for these
source slices.

Phase C private-file UI is also complete at source/local acceptance. Sellers can
upload files and configure access policy; buyers can list eligible files, create
an idempotent grant, consume it through a header token and download the returned
Blob. Grant tokens do not enter URLs, DOM or browser storage, and seller order
views expose only safe filename/status/remaining-use projections. Staging
acceptance remains pending with the rest of the undeployed source tree.

## Prompt OS files applied

- `docs/frontend-redesign/prompt-os/01_SOURCE_OF_TRUTH/FRONTEND_REDESIGN_BRIEF_VI.md`
- `docs/frontend-redesign/prompt-os/03_DESIGN_SYSTEM/selinow-frontend-tokens.css`
- `docs/frontend-redesign/prompt-os/03_DESIGN_SYSTEM/STATE_SYSTEM.md`
- `docs/frontend-redesign/prompt-os/05_SCREEN_SPECS/`
- `docs/frontend-redesign/prompt-os/06_COPY_DECK/vi-VN.json`
- `docs/frontend-redesign/prompt-os/09_QA/ROUTE_ACCEPTANCE_MATRIX.csv`
- `docs/frontend-redesign/prompt-os/09_QA/PIXEL_PARITY_PROTOCOL.md`

## Source files changed

- Shared layouts/primitives: `src/layouts/`, `src/components/`, `src/styles/`.
- Seller routes: `src/pages/app/`, `src/pages/onboarding.astro`.
- Buyer routes: `src/pages/index.astro`, `src/pages/products/`, `src/pages/cart.astro`, `src/pages/checkout.astro`, `src/pages/orders/`.
- Buyer interactions now include category filtering, available-first variant selection,
  cart removal and quote-expiry blocking so the UI stays aligned with server truth.
- Seller catalog now includes category-aware product creation, search/status filters,
  product/variant editing, category name/slug/description/status/sort-order updates,
  explicit category and product archive confirmations, and logout controls in the
  responsive app shell. Category archive retains linked products; product archive
  retains existing order and inventory evidence. Inventory projects available/
  reserved/delivered counts, low-stock thresholds and last-import timestamps from
  tenant-scoped D1 data.
- Product creation accepts an initial variant in the existing tenant-scoped
  product POST. D1 atomically commits the product, variant, idempotency receipt and
  safe audit receipt; a variant constraint failure rolls the product back. Product
  manager and onboarding use this CSRF/idempotency contract, while onboarding
  retains the old variant endpoint only to repair a pre-existing draft.
- The product ledger's `Cập nhật` column uses the authoritative product `updatedAt`
  projection and the selected shop timezone. Variant update time is not inferred
  because the current seller variant projection does not expose that field.
- The store-builder preview and its product cards now consume a scoped semantic
  `--sln-preview-*` palette from the shared token sheet. The centralized values
  preserve the reviewed light-preview colors exactly while preventing route and
  component CSS from reintroducing raw color literals.
- Domain management now uses the AppLayout tenant context, SSRs the initial
  domain projection and renders the six-step lifecycle rail; DNS values wrap and
  copy feedback remains visible without introducing a second shop switcher.
- Inventory import now clears plaintext from form, `FormData` and request-body
  references, invalidates preview/idempotency on context changes, locks pending
  actions and maps safe errors including `recent_auth_required`.
- Orders allowlist payment-exception evidence into localized amount, time and
  key-count facts, preserving a read-only remediation boundary and a tenant-safe
  order-detail link.
- Integrations SSRs authorized Telegram, PayOS and domain projections, uses the
  AppLayout tenant context, resets credential forms after every result and keeps
  unsupported provider aggregates unavailable.
- Admin operations now has a safe active shop-deletion queue with lifecycle
  evidence and owner/risk legal-hold controls; support remains read-only.
- Admin Sellers & Shops now has a protected read-only directory with bounded
  shop-name/slug/public-ID search, allowlisted shop/subscription filters and
  opaque cursor pagination. Rows expose only public shop identity and aggregate
  owner/product/channel posture; seller email/display name, credentials, keys,
  buyer tokens and raw provider data never enter the query or HTML.
- The seller workspace now includes an SSR automation ledger backed by the
  existing tenant-scoped task API. Safe refresh, cancel and resume controls
  preserve server capability, CSRF, recent-auth, idempotency and optimistic
  version checks; no evidence token or provider payload reaches the browser.
- Onboarding now exposes the existing shop-name PATCH contract to owner/manager
  only, and the responsive shell keeps selected-shop context on high-risk action
  links even when JavaScript is unavailable. Mobile dialogs expose their open
  state to assistive technology.
- Seller fallback navigation now preserves the selected shop across billing,
  customers, integrations, inventory, members, orders and onboarding domain
  links. Data export, deletion and moderation controls read the runtime CSRF
  cookie name projected by SSR instead of assuming one local cookie literal.
- Shared page headings wrap safely at 320px, omit empty action wrappers and no
  longer present a decorative live indicator without server evidence.
- Buyer product/cart controls now fail closed on malformed or expired quote
  snapshots, enforce server-projected min/max quantities and recheck the current
  product snapshot before enabling add-to-cart. Checkout rewrites every line from
  the authoritative quote; order status hides key reveal for manual fulfillment,
  invalidates rejected access tokens and keeps payment-provider waiting states
  distinct from fulfillment.
- Private downloadable fulfillment now has source/local seller and buyer UI:
  seller upload/policy configuration, buyer entitlement listing, idempotent grant,
  header-token consumption and Blob download. Grant tokens are excluded from URL,
  DOM and storage, while seller order detail renders only safe file metadata and
  remaining-use state.
- Admin routes: `src/pages/admin/`.
- Tenant-safe services: `src/lib/tenants/`, `src/lib/commerce/`, `src/lib/storefront/`.
- Storefront draft/publication: `migrations/0029_storefront_draft_publication.sql`, `src/pages/api/app/shops/[shopPublicId]/storefront/`, `src/lib/tenants/storefront-settings.ts`.

## Product/security contracts preserved

- D1 remains authoritative; every shop-owned read/write preserves `shop_id`.
- Draft storefront settings never render publicly until owner-only publish passes
  fresh readiness checks; public resolver reads only the published snapshot.
- Payment and fulfillment remain separate, and return URLs never mark orders paid.
- Credential, key, token, cookie and provider payload values are not rendered or
  exported to browser fixtures, logs or reports.
- Authenticated mutations retain exact-origin CSRF, recent-auth and capability
  checks. Private/no-store and noindex headers are centralized.

## Components and states implemented

- Workspace shell with desktop sidebar, mobile navigation and tenant-safe shop
  picker.
- Overview, onboarding/readiness, domains, products, inventory, orders/detail,
  automation, integrations, store builder, customers, members, billing and
  data/audit.
- Store builder content, brand, layout, SEO and support tabs with draft/save,
  undo, stale-version, publish-blocked and published states.
- Store builder catalog preview uses a narrow tenant-scoped `shop:read` projection
  of real active products. It omits SKU, options and inventory-key fields, exposes
  empty/error/truncated states, and cannot trigger buyer cart mutations.
- Product editing supports additional variants through the existing tenant-scoped
  endpoint, preserves opaque variant options on update and derives currency from
  the selected shop.
- Category editing uses the existing tenant-scoped `PUT` endpoint for name, slug,
  description, status and sort order. Category and product archive actions open an
  explicit inline confirmation before writing archived status; neither flow claims
  to delete linked commerce evidence.
- Storefront catalog, category/search filtering, multi-variant product detail,
  current-snapshot drift blocking, cart removal/quote expiry, checkout with safe
  request IDs, order/payment/fulfillment and key access states; admin incident,
  dead-letter, abuse and rotation projections.
- Moderation reports now project target status and owner restore eligibility;
  catalog writes cannot silently restore a product suspended by moderation.
- The shared buyer abuse-report dialog uses the real sanitized API on storefront,
  product, cart, checkout and order surfaces. Product targeting is now derived from
  a successfully resolved public product instead of the URL alone, preventing a
  misleading product action on 404/unavailable product routes.

## Responsive evidence

- The authenticated local browser gate passes 6/6. It covers desktop/mobile and
  the 1440/768/390/320px viewport set for functional behavior, runtime errors,
  axe accessibility, console/page errors and horizontal overflow. It uses
  disposable local state and no staging/production resource.
- The last read-only staging visual gate completed 18/20. Only the desktop/mobile cart
  checks stop before screenshot because the older staging Worker lacks
  `[data-cart-variant-id]`; this is staging version drift, not current source/local
  runtime proof. The checks submit no checkout/payment request and snapshots are
  not regenerated during that staging run.
- Current-source local visual acceptance is backed by 28 manually reviewed exact-
  viewport snapshots: 14 at 1440x1024 and 14 at 390x844. The 768px and 320px
  geometry/runtime/a11y coverage remains active in the same isolated local gate.
  Approved-target staging acceptance remains separate and open.

## Accessibility evidence

- Semantic landmarks, skip links, labels, keyboard focus, reduced-motion and
  tenant contrast guards are covered by source-level and axe tests.
- Payment, fulfillment, warning, blocked, forbidden and plan-limited states use
  explicit text rather than color alone.

## Validation commands and results

The full verification below was rerun against the current source tree on
2026-07-30. Build commands were executed sequentially so they did not share or
race the same `dist/` output.

- `npm run check` — pass (0 errors, 3 existing non-blocking hints).
- `npm run lint` — pass across the final tree.
- `npm run test` — pass, 184 files / 1,371 tests.
- `npm run build` — pass.
- `npm run build:staging` — pass without deployment.
- `npm run deploy:dry-run` — pass without deployment.
- `npm run deploy:staging:dry-run` — pass without deployment.
- `python3 docs/frontend-redesign/prompt-os/10_AUTOMATION/validate_kit.py docs/frontend-redesign/prompt-os`
  — PromptOS structure valid.
- `npm run test:browser:auth:local -- --update-snapshots` — pass, 6/6 and generated
  28 current-source exact-viewport snapshots: 14 at 1440x1024 and 14 at 390x844.
- `npm run test:browser:auth:local` — pass, 6/6 functional/runtime/a11y/overflow
  checks across desktop/mobile and 1440/768/390/320px coverage after snapshot
  generation.
- Browser-plugin-first local QA was attempted, but the available Chrome extension
  blocked both `localhost` and `app.localhost` with `ERR_BLOCKED_BY_CLIENT`.
  Validation therefore used the repository's isolated Playwright gate; it creates
  disposable local state and does not use staging or production resources.
- The last `npm run test:visual:staging` completed 18/20 tests. The desktop and
  mobile cart tests fail closed before screenshot because the deployed staging
  Worker is older than the source contract and does not render
  `[data-cart-variant-id]`; no checkout/payment request was submitted and no
  snapshot was updated. This is an open staging gate, not a blocker for the
  completed current-source local visual DoD.
- No staging deployment or production mutation was performed for the latest
  frontend slices.

## Visual screenshots

- Accepted concept: `docs/frontend-redesign/prompt-os/13_REFERENCE_ASSETS/visual/frontend-system-master-reference.png`.
- Authenticated implementation baselines are stored in
  `tests/authenticated/local-authenticated.spec.ts-snapshots/`.
- The accepted set contains 28 current-source screenshots: 14 desktop images at
  1440x1024 and 14 mobile images at 390x844. All were manually reviewed after
  deterministic generation against isolated local D1 state.
- The reviewed surfaces retain the light editorial workspace, indigo-led token
  system, open rails/rows and responsive mobile navigation. No page overflow,
  clipping, missing asset or catastrophic layout defect was found. Store-builder
  mobile tab truncation is confined to its intentional horizontal scroll
  container; fixed mobile navigation is aligned to the viewport bottom.
- These snapshots establish current-source local visual acceptance only. They do
  not claim that the older staging Worker matches the source tree.

## Assumptions

- SEO metadata is intentionally limited to title/description. Canonical host,
  robots policy and publish eligibility remain server-owned.
- No new provider, billing, customer mutation or order override behavior is
  invented while backend/external contracts are incomplete.
- Product channel visibility and a hidden product state remain unimplemented
  because the required backend contract does not exist. Product plus first-variant
  creation is now atomic, idempotent and covered for rollback, replay/conflict and
  cross-tenant rejection without a schema migration.

## Known gaps

- Member invite/role/revoke, billing plan/payment/cancel, customer detail/edit/
  merge/notes, and seller order notes/retry/override APIs remain unavailable.
- Controlled Telegram bot, PayOS channel and provider-backed automation UAT are
  still required for Phase 8/9 external acceptance.
- Phase B source/local gates are closed: source-level missing-key detection,
  bounded BCP47 boundaries, durable Telegram buyer-explicit preference,
  canonical order/shop currency binding, seller country controls, paired
  English/Vietnamese commerce evidence and a rendered RTL check all pass.
- Private-file source/local acceptance does not yet include a GET API for
  pre-filling current policy/history, retire/revoke controls, a real R2 binary
  download browser fixture or Telegram secure handoff. Verified local
  refund/chargeback access revocation is implemented by `0048`; provider-side
  refund APIs, external grant/revoke executors and browser UAT remain open.
- Current-source local visual acceptance is complete. Approved staging deployment
  and staging parity remain required for staging acceptance; the last staging gate
  was 18/20 because its Worker was older than the source tree.
- Production remains `NO-GO`; production resources, pilots, monitoring/support/
  legal ownership and rollback evidence are not supplied in this local task.
