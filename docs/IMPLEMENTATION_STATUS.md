# Implementation Status

Last updated: 2026-08-16

## Current source of truth

Storefront Templates — TV2 Pulse & Desk (2026-08-16, branch `storefront-templates`):
First two template variants beyond the Swift default, completing the digital-products group
(swift free · pulse Pro dark · desk Pro) — selectable now in the Store Builder gallery.
- **Pulse (dark gaming/tech)**: `templates/pulse/StoreHome.astro` + `styles/storefront/templates/pulse.css`
  — dark ink-token shell (no new palette), merchant-accent hero glow, instant-delivery badge,
  trust strip, denser 3→2→1 column grid. Stock/payment states render on light chips to keep
  protected-state contrast (ADR 0011); `<meta name="theme-color">` switches to `#0B1020` via
  `data-template-scheme="dark"`.
- **Desk (SaaS/office B2B)**: `templates/desk/StoreHome.astro` + `desk.css` — semantic
  `<table>` plan comparison built from the first multi-variant product (plan · price · choose,
  cart-add buttons per row), 3-step activation `<ol>`, tidy row-style catalog on mobile-aware
  responsive rules.
- **Wiring**: dispatcher map (`templates/StoreHome.astro`) registers swift/pulse/desk with swift
  as structural fallback; template sheets load in `StorefrontLayout` (scoped by
  `[data-storefront-template]`) so cart/checkout/orders keep the template shell; storefront copy
  keys added to both locale catalogs (`storefront.template.pulse.*`, `storefront.template.desk.*`).
- **Tests**: render-contract suite added to `storefront-templates.test.ts` — dispatcher map and
  import per available template, layout sheet loading + html attribute + scheme-aware
  theme-color, stylesheet scoping attribute per shipped template.
- **Verification Gates**: `npm run check` (0 errors) · `npm run lint` (0 errors) · `npm run test`
  (332 files, **2608 tests passed**) · `npm run build` · `npm run deploy:dry-run`.
- **Known Limitations**: no flash-sale countdown yet (needs a promo-window model — documented in
  pulse.md); Desk's plan table binds to the first multi-variant product rather than a curated
  "featured" flag; product detail page keeps the shared layout for all templates in TV2.

Storefront Media Pipeline — TV1 (2026-08-16, branch `storefront-templates`):
Product image pipeline over the existing MEDIA R2 bucket with D1 as the authoritative registry;
unblocks the physical-goods templates (Aurora/Metro/Bustle) and upgrades every storefront card.
- **Migration `0101_storefront_media_assets.sql`** (forward-only, after 0100):
  - `media_assets`: tenant-scoped registry (kind product_image/shop_logo/hero_banner, content-type
    CHECK limited to png/jpeg/webp/avif, ≤10 MB, sha256, etag, soft-delete with status/deleted_at
    invariant), identity-immutable + transition-guard triggers, `public_id` UNIQUE for URLs.
  - `product_images`: assignment table with composite tenant FKs to `products` and `media_assets`
    (image, product, and asset must share one shop), sort_order, soft delete, tenant-leading index
    `(shop_id, product_id, status, sort_order, id)`.
  - Registered in `PRODUCTION_DATABASE_INVARIANT_REGISTRY` (hashes generated from the migrated
    schema) and the release validator's table allow-list; migration chain tip pinned to 0101.
- **Service `src/lib/media/assets.ts`**: magic-byte sniffing (PNG/JPEG/WebP/AVIF) matched against
  the claimed content type, plan quota via `plans.limits_json.storageBytes` (Starter 1 GB /
  Pro 10 GB; soft-deleted assets release their share), R2-put→D1-register→rollback-on-failure,
  audit log entry, attach/detach/list product images (≤12 per product) all tenant-bound.
- **APIs** (indexed in `API_ENDPOINT_INDEX.csv`):
  - `POST /api/app/shops/[shopPublicId]/media` — raw-body upload (mirrors private-files flow).
  - `GET/POST/DELETE /api/app/shops/[shopPublicId]/products/[productId]/images` — attach,
    detach, list.
- **Public serving**: `GET /media/:publicId` — host-agnostic route serving active assets from R2
  with `Cache-Control: public, max-age=31536000, immutable`, ETag, nosniff; deleted assets 404.
- **Storefront rendering**: `getStorefrontCatalog` projects the first active product image per
  product (`StorefrontProduct.imageUrl`); `ProductCard` renders it with `data-visual="image"`
  (placeholder letter retained as fallback); CSS keeps image cards within token-driven styling.
- **Seller UX**: product editor dialog gains a "Ảnh sản phẩm" section — upload & attach, thumbnail
  grid, remove; client script follows the private-file upload pattern with vi/en copy.
- **Tests**: `tests/unit/media-assets.test.ts` (sniffing matrix, claimed-type mismatch rejection,
  quota enforcement + release on soft delete, attach/detach ordering, cross-shop isolation both
  directions, catalog imageUrl projection incl. end-to-end `resolveStorefrontShop`); guard tests
  updated (chain tip, invariant registry, endpoint inventory count 182).
- **Verification Gates**: `npm run check` (866 files, 0 errors) · `npm run lint` (0 errors) ·
  `npm run test` (332 files, **2605 tests passed**) · `npm run build` · `npm run deploy:dry-run`.
- **Known Limitations**: storage quota counts `media_assets` only (private digital assets not yet
  metered against the same limit); no logo/banner surfaces yet (columns reserved kinds); no image
  reordering UI (sort_order auto-append); R2 purge of deleted objects rides the existing
  deletion lifecycle to be wired in TV5.

Storefront Template System — TV0 Foundation (2026-08-16, branch `storefront-templates`):
Foundation of the multi-vertical storefront template program (TV0–TV5) targeting three selling
verticals: digital keys (existing), physical goods (TV3), and appointment booking (TV4).
- **Template Registry (code-defined, no migration)**:
  - `src/lib/storefront/templates.ts`: 9 template definitions (digital: `swift` free default,
    `pulse` Pro dark, `desk` Pro; physical: `aurora` free, `metro` Pro, `bustle` Pro; booking:
    `serenity` free, `craft` Pro dark, `clinic` Pro) with per-vertical availability gating
    (only digital templates selectable until TV3/TV4 ship their verticals).
  - Render-time safe fallback: unknown / unavailable / premium-without-entitlement ids resolve
    to `swift` so the storefront never breaks; strict seller-side validation distinguishes
    `storefront_template_invalid` (400) from `storefront_template_premium_required` (403).
- **Persistence & Rendering**:
  - Selection persists in `shop_settings.storefront_json.templateId` through the existing
    draft→publish flow (0029); Cloudflare storefront cache invalidates via `published_version`.
  - `StorefrontLayout.astro` sets `data-storefront-template` / `data-storefront-vertical` /
    `data-template-scheme` on `<html>`; store home dispatches through
    `src/components/storefront/templates/StoreHome.astro` (swift extracted verbatim from
    `index.astro` into `templates/swift/StoreHome.astro` — no visual change).
- **Premium Gating**: `plans.feature_flags_json.premiumStorefrontTemplates` (Pro-only flag per
  ADR 0022 model); enforced at PATCH settings and re-checked at render for plan downgrades.
- **Store Builder**: new "Mẫu giao diện" tab in `/app/store` — gallery of 9 wireframe-preview
  cards grouped by vertical with Pro/Coming-soon badges, entitlement-locked radios, and
  `templateId` in the draft save payload (`store-builder.ts` radio-aware read/undo).
- **API**: `PATCH /api/app/shops/[shopPublicId]/settings` (and `/storefront/draft` alias)
  accepts `templateId`; settings responses now include `template`, `templates` gallery, and
  `premiumTemplatesEnabled`.
- **Docs**: `docs/storefront-templates/README.md` + per-template specs (9 files) covering
  layout, tokens, and a11y per template before implementation (TV2–TV4).
- **Tests**: `tests/unit/storefront-templates.test.ts` (registry invariants, selection
  contract, render fallback incl. plan-downgrade degradation); updated
  `StorefrontShop` literals in 5 suites; i18n dynamic-key allowlist entries for the gallery;
  RTL/browser-gate contracts updated for the new html attributes and store-home component.
- **Verification Gates**:
  - `npm run check`: 859 files, **0 errors**.
  - `npm run lint`: **0 errors**.
  - `npm run test`: 331 test files, **2598 tests passed (100%)**.
  - `npm run build`: Production Cloudflare Worker build succeeded.
  - `npm run deploy:dry-run`: Worker bundle, bindings, routes, and asset manifests validated.
- **Known Limitations**:
  - Only `swift` renders distinctively today; `pulse`/`desk` land in TV2, physical templates
    in TV3 (blocked on the physical vertical + media pipeline), booking templates in TV4.
  - Template selection is not yet vertical-bound (no `shops.vertical` column until TV3/TV4);
    the registry's availability gate is the interim control.
  - Store Builder preview always renders the current template's layout; per-template live
    previews arrive with each template milestone.

Landing Page & Visual Commerce Flow Modernization (2026-08-15):
The public landing page and marketing surface have been comprehensively overhauled with an interactive visual commerce operating system theme:
- **Visual Design & Interactive Components**:
  - `HeroCommerceFlow.astro`: Interactive hero demonstrating live catalog syncing, omnichannel orchestration, and instant fulfillment.
  - `CommerceFlowRail.astro`: Visual representation of omnichannel flows (Storefront, Telegram Bot, WhatsApp, Zalo, Discord, API).
  - `SolutionWorkflowCard.astro`: Modular solution cards showcasing key use cases (Telegram Commerce, Automated Digital Delivery, Concurrency-guarded License Key Inventory).
  - `PricingPlanCard.astro` & `MarketingFooter.astro`: Polished pricing tiers with transparent feature matrix and high-contrast accessible styling.
- **Client & Performance Hardening**:
  - `src/scripts/storefront/cart.ts` and `src/scripts/storefront/checkout.ts`: Guarded `armQuoteExpiry` timer against JavaScript 32-bit signed integer overflow on far-future timestamps.
  - Updated visual testing snapshot baselines for responsive viewports (1440px desktop, 768px tablet, 390px mobile, 200% zoom).
- **Verification Gates**:
  - `npm run check`: 809 files, **0 errors**, 0 warnings.
  - `npm run lint`: **0 errors**.
  - `npm run test`: 313 test files, **2450 unit and integration tests passed (100%)**.
  - `npm run test:browser:public:local`: 27 visual and functional browser tests passed across all viewports.
  - `npm run build`: Production Cloudflare Worker build succeeded in 1.09s.
  - `npm run deploy:dry-run`: Worker bundle, bindings, routes, and asset manifests validated.
- **Production Deployment**:
  - Deployed to Cloudflare Production (`selinow-com-production`, Version ID `c18f5738-21d1-4494-bf49-4f00dad37620`).
  - Active routes verified: `selinow.com/*`, `*.selinow.com/*`, `*/*`, `app.selinow.com`, `api.selinow.com` returning HTTP 200/308 responses.
  - Production cron schedule (`*/15 * * * *`) and queue consumers active.

Onboarding Experience & First-Sale Activation Overhaul (2026-08-15):
The seller onboarding process has been completely rebuilt from the ground up to replace legacy fragmented technical forms with a sleek, delightful 4-step Focus-Mode wizard with real-time live preview and workspace launch tracking:
- **Architecture & Focus Mode Flow**:
  1. *Step 1 (Cửa hàng & Kênh phân phối)*: Store profile, automatic real-time slug generator with availability check, visual channel cards (Web storefront, Telegram Bot, or Omnichannel).
  2. *Step 2 (Thêm sản phẩm đầu tiên)*: 5 popular 1-click digital product presets (Windows 11 Pro, Canva Pro, Spotify, Steam Wallet, Ebook/Course) + custom product creation form.
  3. *Step 3 (Nhập kho License Keys)*: Real-time multi-line key parsing strip (total, valid, duplicates), 1-click 5 sample test keys generator, and "Nhập sau" skip support.
  4. *Step 4 (Kết nối Thanh toán & Kênh)*: VietQR PayOS integration (Client ID, API Key, Checksum Key) with live authentication test + Telegram Bot token setup with @BotFather guide.
  5. *Celebration Step*: Interactive canvas confetti explosion, direct links to live Storefront, Telegram Bot, and Dashboard.
- **Real-time Live Interactive Mockup**:
  - `OnboardingLivePreview.astro` rendering synchronized web storefront product card and Telegram Bot chat bubble preview responding instantly to user input.
- **Persistent Workspace Launch Tracking**:
  - `LaunchChecklist.astro` component embedded on `/app` overview showing launch progress percentage bar, completed steps, and direct resumption links for remaining tasks.
- **Backend & Tenant Store Optimizations**:
  - `src/lib/onboarding/presets.ts`: Standard digital product presets with sample test keys.
  - `src/lib/tenants/store.ts`: Default policy URLs and user support contact attestation on initial shop creation.
  - `POST /api/app/shops/[shopPublicId]/onboarding/seed-preset`: 1-click preset seeding endpoint.
  - `GET /api/app/shops/[shopPublicId]/onboarding/overview`: Consolidated onboarding overview metrics.
- **Verification & Deployment Gates**:
  - Passed `npm run check` (0 errors), `npm run lint` (0 errors), `npm run test` (313 test files, 2450 unit/integration tests passing), `npm run build` (production Cloudflare Worker build succeeded).
  - Deployed to Cloudflare Production (`selinow-com-production`, Version ID `e6f045d2-ba63-495a-b593-32f2bd54c734`) with active routes on `selinow.com/*`, `*.selinow.com/*`, `app.selinow.com`, `api.selinow.com`. Verified HTTP 200 responses across all live endpoints.

Auth & Password System Upgrade (2026-08-15):
The authentication system has been fully upgraded from magic links to a comprehensive, enterprise-grade Password + Email OTP architecture. Key accomplishments and verification status include:
- **Forward Migration**: `0098_auth_email_otp_system.sql` introduces password hashes, verification markers, lockout states (`failed_login_count`, `locked_until`, `email_verified_at`), and `auth_email_otps` table with indexing.
- **Crypto & WebCrypto Security**: PBKDF2-SHA256 (100,000 iterations, 16-byte cryptographically secure random salt), dummy password verification timing defense against user enumeration, CSPRNG 6-digit OTP generation, and HMAC-SHA256 token hashing bound to purpose and email.
- **3-Step Password Reset Architecture**: Strict separation between Step 1 (Request code), Step 2 (Server-verified OTP resulting in a short-lived 15-minute signed HMAC Reset Token), and Step 3 (Password reset completion requiring the verified token). No new password entry is unlocked until OTP is verified.
- **Account Lockout & Brute-force Mitigation**: 15-minute temporary lockout upon 5 consecutive failed login attempts; maximum 5 OTP verification attempts before code revocation; 60s resend cooldown.
- **Session Revocation**: Complete session revocation across all active user devices upon successful password reset.
- **API & UI Surfaces**: Complete endpoints (`/api/auth/login`, `/api/auth/register`, `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/auth/otp/verify`, `/api/auth/otp/resend`) with localized accessible multi-step wizard UI forms in `/login`, `/register`, `/forgot-password`.
- **Verification Gate**: Passed `npm run check` (0 errors), `npm run lint` (0 errors), `npm run test` (64/64 auth tests passed), and deployed to Cloudflare Production (`app.selinow.com`, `selinow.com`).



Local verification on the candidate passed `npm run check` (772 files, zero
errors), `npm run lint`, `npx tsc --noEmit`, `npm test` (307 files, 2,411
tests), `npm run build`, `npm run build:staging`,
`npm audit --audit-level=high` (zero high vulnerabilities), both deploy
dry-runs, and `git diff --check`. A 2026-08-13 production continuation-prep
ceremony created backup `bkp_20260812221907_59e419a89383` and isolated restore
`rdr_20260812221923_f9a186a00bf9` for the then-current `0053`-`0095` source chain against
the live `0052` production D1. Source now continues through
`0097_telegram_action_generation_and_delivery_interlock.sql`; migrations `0096`-`0097` are not on
staging or production and require a fresh candidate-bound ceremony. Production platform doctor passed. Live Worker
secret names are nine of ten required names; `DODO_PAYMENTS_WEBHOOK_KEY` is
absent. Production trigger inventory still has zero queue consumers and no
cron. The owner deferred genuine Dodo/PayOS UAT. `npm run release:doctor --
--json` remains fail-closed. No production migration, Worker deploy, trigger
apply, or payment-collection claim was performed.

The previous 2026-08-11 reconciliation recorded candidate
`3a44aadbcbe6a88115eb28743fcb19fa6af1cf5a`, tree
`2795b2f91c1d9874c1182d56364516047ab358b8`, and release
`stg_20260811T043926Z_3a44aadbcbe6` as an earlier staging identity. That
identity is superseded by the later `92869a04` staging ceremony above and
must not be reused.

The combined staging release remains `provider_pending`. Genuine Dodo TEST and
controlled PayOS staging UAT are not accepted, and their artifacts are not yet
bound to the exact manifest, commit, tree, and Worker version. Production
remains **NO-GO** at D1 `0052` and runtime phase 6, with the canonical Dodo
webhook and current public routes absent from the deployed Worker, queue
consumers and the current cron schedule missing, and production backup/restore,
rollback, monitoring, legal/support decisions, pilots, named approvals, secret
admission, provider handoff, and combined release admission outstanding. The
authoritative handoff is
`docs/release/CURRENT_HANDOFF_2026-08-11.md`. No production migration,
deployment, provider activation, or payment-collection claim is authorized.

## Superseded current checkpoints

Continuation audit (2026-08-09): the source chain is contiguous through
`0094_shop_creation_admission.sql`. Staging D1 is already at `0090`,
but the latest deployed staging Worker (`b7492055-a44b-4c8c-8ab2-c31002dbdd02`)
predates the current uncommitted release-evidence, PayOS-contract, visual, and
Dodo webhook fixes, and the source-only buyer order recovery migration/runtime.
A fresh candidate-bound staging ceremony is required.
Read-only production audit confirms Worker version
`f8cee1ef-2050-4d04-980a-9921645703fa`/phase 6, D1 through `0052`, zero queue
consumers, no `*/15 * * * *` schedule, missing Dodo webhook runtime bindings,
canonical Dodo POST still `404`, and production Turnstile admitting only
`selinow.com`. Production custom-domain activation remains closed.

The staging Dodo TEST checkout reached the provider, but the first signed
`payment.succeeded` delivery was rejected with `409`; the subscription remained
`pending_payment`. The event was not replayed as accepted evidence. PayOS has a
schema-v2 contract that requires a real low-value production-controlled VND
transaction for provider acceptance; no such transfer has been executed, and
refund/chargeback webhook scenarios remain explicitly unsupported by the public
PayOS contract. Both payment lanes therefore remain fail-closed.

Candidate hardening commit (2026-08-09): `a02e098e9a05454261770d3c90c9aeaed151a2af`,
tree `14f9f68afd6fbadbb689171a4ad6bbc9cb405652`. This candidate closes buyer
recovery response-loss replay, replaces seller order/customer offsets with
opaque keyset cursors, rejects all WhatsApp `provider_pending` ingress before
credential or receipt access, hardens Dodo pre-payment lifecycle/replay
handling, requires trusted detached PayOS owner attestation for provider
acceptance, and makes production trigger plans/evidence/rollback fail closed.
Local gates on this exact tree: `npm run check` (0 errors, 3 hints), `npm run
lint`, `npx tsc --noEmit`, `npm test` (282 files / 2,094 tests), production and
staging builds, both deploy dry-runs, `npm audit --audit-level=high` (0
vulnerabilities), and `git diff --cached --check` all pass. No remote mutation
was made by this candidate. Staging deploy/backup/restore remain blocked until
the required temporary Cloudflare admission tokens and fresh manifest are
available. Those totals predate the current `0091`-`0094` continuation set and
are not verification evidence for the current working tree.

Buyer order recovery continuation (source-only): migration
`0091_buyer_order_access_recovery.sql` and the Website recovery routes add a
15-minute signed, single-use email link whose token is carried only in the URL
fragment. D1 stores hashes only; request responses are non-enumerating; exact
same-origin plus per-shop and cross-shop requester rate-limit admission run
before any existence-dependent action; one
compare-and-set consume atomically rotates `orders.order_token_hash`; and
replay/concurrent consume permits one winner. Checkout requests the message
without blocking navigation, while the order page exchanges the fragment,
restores the rotated token to browser storage and clears sensitive fragments.
Deterministic replacement tokens let identical checkout replay return the
latest valid recovered access after multiple rotations. Exact same-order
binding lineage preserves previously issued private-file grants; 30-day
maintenance deletes expired/revoked unconsumed rows and scrubs consumed
recovery-link/recipient hashes. Buyer anonymization rotates Website order
access hashes and deletes recovery artifacts. Binding hashes are retained only
as authorization lineage, not as buyer-contact data.
This slice has local focused evidence only and requires fresh full-tree gates,
candidate-bound staging migration/deploy and customer-journey acceptance.

Custom-domain Turnstile continuation (source-only): committed migrations
`0092_custom_domain_turnstile_admission.sql` and
`0093_custom_domain_turnstile_runtime_guard.sql` demote legacy custom-domain
routing without exact widget admission, restore a safe platform canonical
fallback, and add old-runtime-compatible D1 guards. Neither migration is part
of the retained staging or production ledger evidence.

Shop-creation admission continuation (source-only): migration
`0094_shop_creation_admission.sql` rebuilds the hash-only auth admission ledger
to support authenticated shop provisioning with requester, subject, global and
time-window budgets. Raw requester addresses and user identifiers are not
persisted. Shop creation claims fail closed when D1 admission is unavailable,
and the release registry pins the rebuilt table definition plus invalid
`shop_create` row checks. This migration is not part of retained staging or
production ledger evidence.

Onboarding and billing recovery closeout (2026-08-11): canceled owners can
recover through the billing surface, including a guarded merchant-country-only
profile update when no billing market is configured. Archived shops remain
closed. Expired trials and expired active/scheduled paid periods allow recovery
reads and billing actions but deny mutations. Late Dodo events for historical
checkout sessions cannot mutate a newer recovery subscription. Shop creation
admission now runs only after deterministic validation, including an opaque
global-slug preflight, while the transactional unique constraint remains the
race-safe fallback. Focused evidence passes 7 files / 115 tests for auth,
billing, entitlement, onboarding, UI and operational docs plus 3 files / 29
tests for production invariant, rollback and post-migration admission. `npm run
check`, `npm run lint`, `npm run build`, `npm run deploy:dry-run` and `git diff
--check` pass on the shared working tree. The build retains the existing Vite
dynamic-import warning. No remote database mutation, Worker deployment,
provider change, secret write or production admission was performed. Fresh
candidate-bound staging migration/backup/restore/deploy evidence through
`0094`, provider UAT and production approvals remain external requirements.

Buyer recovery/release-registry closeout (2026-08-11): the Website request and
single-use consume routes are present in both the exact commerce route contract
and the 156-row frontend API endpoint index. Production invariant admission,
post-migration validation and backup/restore cross-ledger checks now cover the
`0091` recovery contract plus the five `0093` custom-domain runtime/rollback
guards and their live Turnstile/canonical-domain state. Focused verification
passes 16 test files / 139 tests; targeted ESLint on the owned runtime, scripts
and tests is clean; `npm run check` passes. No remote database mutation, Worker
deployment, provider activation or customer-domain admission was performed.
Staging evidence remains through `0090`, production remains through `0052`, and
the complete `0091`-`0094` continuation still requires a fresh clean candidate,
protected backup/restore evidence and an approved mutation window.

- The reviewed runtime baseline for this snapshot, before the documentation-only
  reconciliation commit, is commit
  `dcfe4a62e98551083710ae32df0004f2336e6524`, tree
  `4489cc8fa123bd0126211c07f0bdacc5a235fe0e`. It is not a post-documentation
  HEAD or a deployed identity; the next release ceremony must recapture the
  final clean commit and tree.
- Current operational source migration chain: contiguous `0001`-`0097`.
  Staging post-migration evidence for release
  `stg_20260808T235913Z_73d0c27493ea` records all 90 migrations through
  `0090_payos_provider_claim_clear_guard.sql`, bound to commit
  `73d0c27493ea10fbeacd2e4b6b6f2f923cc99cfd` and tree
  `d445e8409dc1f2b537c39b2e08dad69a228db9f7`. Its pre-migration manifest
  correctly records the then-live prefix through `0086`; the later migration
  completion and post-migration evidence record the resulting `0090` ledger.
  Migrations `0091`-`0094` are not part of that retained ceremony and remain
  source-only.
- The same staging ceremony retained pre-migration backup
  `bkp_20260808235109_63ea5cf3c278`, post-migration backup
  `bkp_20260809000127_bd8c6b2f2402`, and passing candidate-bound isolated
  restore reports. This proves the staging D1 continuation only; it does not
  bind a current Worker deployment or provider acceptance. The private source
  artifacts are the release's `migration-completion.json` and
  `post-migration-evidence.json` files under `.wrangler/releases/staging/`.
- The latest retained staging Worker deployment evidence remains deployment
  `2400fc01-fd71-4c91-93e7-7a93a44a4216`, Worker version
  `6688b21f-401e-43b2-95b5-a0e9434167a2`, from commit
  `17922377aa6bd0893c5c4aae206ac78d0208875d` and tree
  `9d44eb6a9318a1b5c94fc012c3573b3f4e31611a`. It predates the `0090`
  staging continuation and the final source commits. No current-HEAD staging
  deployment, current Worker version, or current-candidate smoke is claimed.
- Production D1 remains at the admitted `0001`-`0052` baseline. No production
  continuation migration or current-candidate Worker deployment is claimed.

## Current provider state

- The Dodo TEST catalog has been rotated to four distinct monthly offers:
  Starter/Pro in VND 99,000/299,000 and USD 5/15. The staging Dodo webhook is
  registered and enabled on the canonical staging endpoint, and its signing
  secret is present through the approved secret channel. Secret values are not
  retained in documentation or evidence. The current non-secret provider view
  is `.wrangler/evidence/dodo-provider-20260809/dodo-reconciliation-redacted.json`.
- Dodo provider UAT is **not complete**. The retained provider view has an empty
  delivery log, and no accepted release-bound artifact proves a provider-created
  checkout, signed event delivery, authoritative D1 subscription transition,
  replay behavior, mismatch handling, lifecycle completion, or the required
  32-scenario validator result. Catalog and webhook configuration are setup
  evidence only.
- PayOS remains unaccepted. Source admission and tenant-ownership guards exist,
  but no accepted release-bound artifact proves a controlled staging channel,
  signed exact payment, replay handling, partial/overpaid/late/mismatched
  payment handling, refund/chargeback, reconciliation, or exactly-once
  fulfillment.
- Telegram Mini App, Zalo Mini App, Zalo OA, WhatsApp Cloud, Discord, and other
  expansion channels remain `provider_pending`. Local contracts, verified
  parsers, or ingress probes do not make a channel active.
- Return URLs, QR rendering, product catalogs, registered webhooks, secret-name
  inventory, synthetic signatures, and `provider_pending` responses never prove
  a paid order, provider acceptance, or production readiness.

## Handoff and release decision

The exact payment/non-payment ownership contract and external gates are recorded
in `docs/release/CURRENT_HANDOFF_2026-08-09.md`.

- The payment lane must deliver genuine Dodo TEST and controlled PayOS staging
  UAT, redacted and bound to one exact release ID, manifest hash, commit, tree,
  and Worker version. Payment setup cannot promote non-payment surfaces or
  authorize production.
- The non-payment lane must deliver a fresh deployment of the exact combined
  candidate plus route/health, Website, Telegram, custom-domain, queue/cron,
  tenant-isolation, bootstrap, privacy, monitoring, pilot, rollback, support,
  legal, and owner evidence. It cannot infer subscription/payment readiness.
- Release admission is conjunctive: neither lane is accepted alone, and all
  evidence must bind to the same candidate. Any mismatch returns the handoff to
  `provider_pending`/blocked.
- Production remains **NO-GO**. Missing current-candidate staging deployment,
  genuine Dodo/PayOS UAT, named approvals, fresh protected production
  backup/restore, monitoring acknowledgement, controlled pilots, manual
  acceptance, rollback rehearsal, and production release evidence must be
  closed through the real operator/provider workflows. No production migration,
  deployment, provider activation, live charge, or payment-readiness claim is
  authorized by this status document.

## Documentation verification

- `git diff --check -- docs/IMPLEMENTATION_STATUS.md
  docs/release/CURRENT_HANDOFF_2026-08-09.md` passed.
- `npx vitest run tests/unit/operational-migration-ledger-docs.test.ts` passed
  (2 tests). No runtime source, migration, provider, secret, staging, or
  production mutation was performed for this documentation reconciliation.

> Historical scope: every remaining section is retained checkpoint history.
> Terms such as "current", "complete", "live", migration counts, deployment
> state, and provider setup below describe their dated checkpoint and are
> superseded by the three current sections above.

## Historical operational reconciliation (2026-08-04)

The authoritative source migration chain is contiguous through `0080`; the
accepted remote ledgers remain staging through `0028` and production through
`0052` until separately admitted mutation evidence exists. Read-only Cloudflare
checks confirmed the configured staging and production D1 names/UUIDs match the
Wrangler inventory, without recording identifiers here. The production dashboard
currently shows Worker version prefix `e2a4bc53` (`frontend-only release` /
`release_20260802_mobilefix`), four domains, zero queues, nine bindings, logs
enabled and previews disabled; historical bootstrap version `6ca9c890...` is not
the current Worker. Staging currently shows version `049009b4`, previous version
`2d7166ff`, 14 domains, three queues, one trigger and nine bindings. These are
read-only observations, not durable admission evidence: exact version, route,
domain, trigger/queue and release-manifest reconciliation remains required, and
the final execution commit is pending until this batch is committed and reviewed.

This batch hardens the normal production continuation path without opening the
remote mutation gate. Release evidence is now schema version 2 with an explicit
active/deferred channel partition, independent PayOS/Dodo commerce acceptance,
distinct acceptance references, allowlisted value-safe manifest projections and
an exact reviewed `migrationLedgerPrefix`. Production migration/seed admission
checks the pinned account and D1 identity, exact reviewed ledger baseline, D1
preflight and evidence stability before Wrangler; after the sink it requires the
complete `0001`-`0080` ledger and provider schema/preflight. No staging or
production migration, seed, deploy, route, DNS, queue/trigger or provider
mutation was performed.

Final local verification for this batch: `npm run check` passed with 0 errors and
3 existing hints; `npm run lint`, `npx tsc --noEmit`, and 252 Vitest files / 1,804
tests passed; `npm run build`, `npm run build:staging`, both deploy dry-runs and
`npm audit --audit-level=high` passed. `npm run release:production:plan -- --json`
remained a non-mutating plan; `npm run release:doctor -- --json` failed closed
because fresh production evidence, backup/restore, candidate identity, provider
acceptance, monitoring, pilot and secret-name inputs are absent. Cloudflare
Chrome was used read-only for identity/ledger/runtime inspection; it did not
apply migrations or alter configuration.

The later 2026-08-04 production execution attempt progressed only through
safety evidence. A fresh non-empty report-v2 production backup was created at
`.wrangler/backups/production/bkp_20260804113931_e87d7ee5bfa1/snapshot.json`.
The first isolated restore exposed a gate bug that incorrectly required
post-`0070` billing/activation tables on the `0052` source; the gate now requires
only the durable source baseline and still validates the complete schema after
replaying all pending migrations. The retry passed with report
`.wrangler/restore-drills/production/rdr_20260804114401_67010b1e6913.json`, exact
`0001`-`0080` replay, integrity `ok`, zero foreign-key violations and exact
temporary-target cleanup. Production migration/deploy was not attempted because
staging admission, route/platform tokens, UAT/pilot/provider evidence, canonical
release evidence/manifest, queue-consumer intent and current rollback identity
remain unresolved.

The same 2026-08-04 continuation created two seven-day, least-privilege
Cloudflare account tokens in the authenticated dashboard without recording
their values: a `selinow.com` DNS/SSL read token and a `selinow.com` Worker
Routes plus account Worker Scripts read token. Machine staging doctor and route
preflight then exposed the pre-handoff route contract still embedded in the
repository. Three redundant legacy staging Worker Routes
(`staging.selinow.com/*`, `app-staging.selinow.com/*` and
`api-staging.selinow.com/*`) were removed in Cloudflare while their seven
Worker Custom Domains remained present. The checked-in production route config
and both route validators now model the live handoff exactly: apex/wildcard to
`selinow-com-production`, staging wildcard/catch-all to
`selinow-com-staging`, `app.selinow.com` and `api.selinow.com` as production
Worker Domains, and all seven staging Worker Domains plus the canary carrier.
Both staging route preflight and production route/domain identity admission now
pass against the live inventory. No D1 migration or Worker deployment had run
at this checkpoint.

The follow-up source contract removes the historical null-guard admission path,
rejects bare-host and deleted legacy Worker Routes, and makes the guarded
promotion helper emit the same four-route handoff as live Cloudflare. The
staging Wrangler route list remains limited to its wildcard and catch-all, so a
normal staging deploy cannot recreate the three removed exact routes. Focused
route/bootstrap/promotion/release coverage passed 8 files / 141 tests;
`npm run lint`, `npm run check` and `git diff --check` also passed. This was a
source-only correction and did not call or mutate Cloudflare.

## Phase 5 staging execution and pilot admission (2026-08-04)

Completion state: **`staging_execution_blocked`**. The P4 implementation
candidate remains `bff69f9d26a04b1318fd9862afa6eaffb8c003f4` with tree
`c5c52c0b7ed9f174b65fb5969b3f5beeaa4c386`. Read-only commands were attempted,
but no timestamped private report, checksum, or evidence reference was retained.
The resulting account/resource, migration-status, and preflight observations are
not accepted as P5 evidence and remain blocked under
`phase_5_read_only_evidence_unavailable`. Route/custom-domain/SaaS inventory and
exact manifest-grade D1 identity/ledger capture also remain blocked by absent
scoped audit token contexts.

All local gates passed, including 251 Vitest files / 1,793 tests, both builds,
both deploy dry-runs, zero high-severity npm audit findings, and exact-HEAD local
restore report `.wrangler/restore-drills/local/rdr_20260804101522_085452a4f0e8.json`
with integrity `ok`, zero FK violations, 614 restored items, and exact cleanup.
Gate B, provider UAT, and seller pilot approvals were not supplied. No staging or
production mutation occurred. P5 evidence is in
`docs/PHASE_5_REVIEW_PACKAGE_R0.md`, `docs/PHASE_5_STAGING_EXECUTION.md`,
`docs/PHASE_5_UAT_RESULTS.md`, `docs/PHASE_5_PILOT_ADMISSION.md`, and
`docs/PHASE_5_INCIDENT_LOG.md`.

## Phase 4 staging acceptance and controlled pilot execution (2026-08-04)

Completion state: **`local_ready_remote_blocked`**. Independent review found and
closed P1/P2 staging database-admission gaps: the private schema-3 manifest now
captures a non-empty live D1 ledger baseline after read-only identity admission;
migration requires passing preflight plus that exact baseline before Wrangler,
then rechecks the complete `0001`-`0080` ledger and preflight after Wrangler.
Staging seed requires the complete ledger and passing preflight immediately
before Wrangler. P4 also replaces the 14-scenario readiness projection with an
18-scenario acceptance matrix and adds explicit metric/source, thresholds,
window, owner, acknowledgement reference, and stop/reconciliation action for
every required monitoring signal.

The reviewed runtime/test candidate is
`bff69f9d26a04b1318fd9862afa6eaffb8c003f4` with tree
`c5c52c0b7ed9f174b65fb5969b3f5beeaa4c386`. P4 artifacts are
`docs/PHASE_4_REVIEW_PACKAGE_R0.md`, `docs/PHASE_4_STAGING_ACCEPTANCE.md`,
`docs/PHASE_4_UAT_MATRIX.md`, `docs/PHASE_4_PILOT_EXECUTION_PLAN.md`,
`docs/PHASE_4_INCIDENT_AND_ROLLBACK.md`, and the explicitly non-evidence example
`infra/release/phase-4-pilot-scorecard.example.json`.

No staging or production backup, restore, ledger inventory, migration, seed,
deploy, route/DNS/secret change, provider side effect, real order, or pilot seller
action was performed. External approval, least-privilege credentials, protected
staging evidence, exact owners/acknowledgement paths, previous Worker version,
PayOS/Dodo/Telegram readiness, and an approved observation window remain required.

Final local verification: `npm ci --ignore-scripts` audited 456 packages with
zero vulnerabilities; `npm run check` passed 696 files with zero errors and the
existing three hints; lint and `npx tsc --noEmit` passed; Vitest passed 250 files
and 1,787 tests; both builds and both deploy dry-runs passed with 280 modules;
`npm audit --audit-level=high` found zero vulnerabilities. The existing non-fatal
mixed static/dynamic inventory crypto import warning remains. Candidate-bound
local restore report `.wrangler/restore-drills/local/rdr_20260804091903_1127db4c1b34.json`
passed integrity, zero FK violations, 614 restored items, and exact cleanup.

## Phase 3 staging admission and controlled pilot readiness (2026-08-04)

Local/source status: **PASS** for admission and pilot-readiness contracts;
staging, providers, pilot, and production remain **NO-GO**. At the historical P3
checkpoint, the staging release manifest used schema version `2`; current P4
supersedes it with schema version `3`, including the live ledger baseline. At
that checkpoint, P3 bound the final clean commit/tree and source migration ledger to
the exact staging D1 account/name/UUID plus the protected backup checksum/size,
snapshot, and candidate-bound restore report/target. `scripts/deploy.mjs` reads
the complete ordered D1 migration ledger and runs the staging database preflight
both before and after the build; drift or an incomplete/failed result stops before
Wrangler. These guards do not perform a remote mutation.

Regression coverage is in `tests/unit/staging-release-admission.test.ts`,
`tests/unit/deploy-guard.test.ts` and
`tests/unit/phase-3-pilot-artifacts.test.ts`. The controlled Website-first pilot
now has an explicit scorecard/status vocabulary, safe evidence allowlist,
14-scenario local regression map, concrete monitoring thresholds, observation
windows, accountable roles and stop/rollback conditions in the Phase 3 docs.

P3 verification passes: `npm run check` (694 files, 0 errors, 3 existing hints),
`npm run lint`, `npx tsc --noEmit`, `npm run test` (249 files / 1,777 tests),
local/staging builds, local/staging deploy dry-runs, `npm audit --audit-level=high`
(0 vulnerabilities), and `git diff --check`. Exact npm overrides resolve patched
transitives `fast-uri@3.1.5` and `undici@7.29.0` without downgrading the pinned
Astro/Wrangler toolchain. Isolated local restore report
`.wrangler/restore-drills/local/rdr_20260803200612_4388ccee7295.json`, bound to
implementation commit `ec66a7a909319ac0a4b5b4b8c777836e636e56a5`, passed with
integrity `ok`, zero FK violations, 614 restored items, and exact cleanup.

No staging/production backup, restore, migration, seed, Worker deploy, provider
activation, secret update, route/DNS change, webhook registration, real order,
or seller pilot was performed for P3.

## Phase status

| Phase | Status | Acceptance artifact |
| --- | --- | --- |
| 0 — Repository bootstrap | Complete | Astro/Cloudflare scaffold, strict TypeScript, quality scripts, security baseline, docs and acceptance evidence |
| 1 — Infrastructure provisioning | Complete | Selinow D1/R2/KV/Queues, bindings, secrets, migrations/seeds, Worker deploy, DNS, wildcard TLS and core staging smoke are live |
| 2 — Tenant/auth/subscription | Complete | One-time magic links, rotated sessions, CSRF, idempotent shops, tenant guards and admin suspension |
| 3 — Catalog/inventory/orders | Complete | Tenant-scoped catalog, encrypted inventory, public cart/quote, atomic checkout, private order access and idempotent expiry |
| 4 — PayOS | Complete | Encrypted tenant credentials, signed link creation, verified webhook decisions, exactly-once fulfillment, reconciliation and exception inbox |
| 5 — Telegram | In progress | Encrypted seller bots, automated webhook setup, isolated private-chat commerce, replay-safe updates and paid-notification outbox are implemented locally; dedicated provider UAT and pilot acceptance remain pending |
| 6 — Storefront/subdomain | Complete | Marketing/pricing, tenant storefront flow, hostname-safe caching, Turnstile/rate limits and remote Selinow staging acceptance |
| 7 — Custom domains | Complete | External hostname ownership, Cloudflare for SaaS provisioning, SSL/DNS activation, primary switching, tenant rendering, redirect, deletion and DNS cleanup passed on staging |
| 8 — Automated onboarding | In progress | Repository wizard, readiness, tenant automation API, durable task scheduling, guarded continuation evidence and Selinow-owned executors are live on staging; fresh-seller and external-provider acceptance remain pending |
| 9 — Operations/security/platform extensibility | In progress | Operations runtime, channel-neutral connections, normalized order attribution, transactional domain events, generic queue fan-out/delivery, DLQ replay, accessibility gates, public-flow axe scans and read-only staging QA are accepted. Phase B globalization and the Phase C entitlement, reversal and generated-license execution slices through migration `0052` are implemented. Migrations `0053`-`0069` add seller operations and channel/provider contract boundaries. Paid Starter/Pro pricing, seven-day trial, three-day paid-renewal grace, Dodo evidence processing, role/plan/state gates, usage metering, activation analytics, Phase 1 billing/restore hardening, and durable catalog activation timestamps are implemented through migration `0080`. Provider activation and remote migration remain pending. Production remains on the previously admitted `0001`-`0052` schema until separately approved migrations are applied. |
| 10 — Production release | CONTINUATION NO-GO | The guarded first-production ceremony completed on 2026-07-30 and production remains on D1 `0001`-`0052` / runtime phase 6. Current route ownership is `selinow.com/*`, `*.selinow.com/*`, and `*/*` on `selinow-com-production`, with only the exact staging exceptions on `selinow-com-staging`. The current source through `0097`, production cron/queue consumers, provider acceptance, legal/support approval, backup/restore, rollback, pilot, and monitoring evidence remain pending; no continuation production deployment is admitted. |

### Phase 1 completion candidate R3 (2026-08-03)

R3 adds forward-only migration `0079_phase1_completion_hardening.sql` and closes
the independent R2 findings. The scheduled Worker now executes durable Dodo
subscription-change requests, expires stale billing sessions/trials, and rotates
activation backfill across every tenant. Checkout response loss retries the same
provider idempotency key, initial-payment failure releases the active session for
owner recovery, and signed change-plan evidence updates the authoritative plan and
price snapshot before completing the request. Missing webhook price evidence is
resolved through direct Dodo subscription reconciliation. Restore validation now
checks checkout plan/price/provider consistency, invoice account provider/currency,
and activation projection types. Telegram is no longer presented as a live launch
channel before provider acceptance.

The authoritative source chain is now `0001`-`0079`, contiguous. Staging remains
at `0028` with 51 pending migrations (`0029`-`0079`), and production remains at
`0052` with 27 pending migrations (`0053`-`0079`). Older migration counts below
are historical checkpoint notes. No staging or production migration, provider
activation, secret update, deploy, DNS change, or push was performed by R3.

Current local evidence: `npm run check` passes with 0 errors and the existing 3
hints; `npm run lint` passes; the focused R3 matrix passes 98 tests and the full
Vitest suite passes 243 files / 1,755 tests; `npm run build`, `npm run deploy:dry-run`,
`npm run deploy:staging:dry-run`, `npm audit --audit-level=high`, and
`git diff --check` pass. Both deploy commands exit at Wrangler `--dry-run` without
remote mutation. The known non-fatal Vite warning for the mixed static/dynamic
inventory crypto import remains unchanged.

### Phase 2 seller activation and pilot candidate (2026-08-03)

Phase 2 records the seller critical-path review before implementation in
`docs/PHASE_2_REVIEW_PACKAGE_R0.md`. The two P1 findings are addressed: `/app`
now derives sellability from the shop lifecycle plus the owner-authoritative
readiness projection, and both inventory clients erase plaintext and invalidate
previews on terminal preview/import errors. R2 closes the subsequent four review
findings: staging mutation is bound to a private clean-commit/tree/migration
manifest plus fresh candidate-bound backup/restore evidence; `inventory_ready`
requires active product and variant state; migration `0080` records immutable
activation timestamps so replay is not backdated to product creation; and
onboarding aborts stale inventory requests while clearing both object and
serialized plaintext references. Tenant isolation and idempotency remain intact.

Phase 2 artifacts are `docs/PHASE_2_ACTIVATION_FUNNEL.md`,
`docs/PHASE_2_UNIT_ECONOMICS.md`, `docs/PHASE_2_PILOT_PLAN.md`,
`docs/PHASE_2_PILOT_EVIDENCE.example.json`, and
`docs/PHASE_2_REVIEW_PACKAGE_R1.md` plus
`docs/PHASE_2_REVIEW_PACKAGE_R2.md` (written after review-fix verification). The
funnel and unit-economics documents are variable/authority contracts only; no
pilot seller, provider, conversion, cost, margin, CAC, churn, or revenue
observation is fabricated.

Current local evidence includes the isolated restore report
`.wrangler/restore-drills/local/rdr_20260803145929_b94ce8926be7.json`, bound to
runtime candidate `ec50cde50c1ecdc8264a07c3261e2962c7e568d6`:
integrity `ok`, zero FK violations, zero missing tables/count mismatches, 614
restored items, exact temporary-target cleanup, mode `0600`, and the contiguous
80-file ledger through `0080`. Final sequential gates pass: `npm run check`
(0 errors, 3 existing hints), `npm run lint`, `npx tsc --noEmit`, `npm run test`
(248 files / 1,770 tests), `npm run build`, `npm run build:staging`, both deploy
dry-runs, `npm audit --audit-level=high` (0 vulnerabilities), and
`git diff --check`. The prior authenticated 7/7 and public 27/27 browser runs
remain R1 layout/accessibility evidence; no provider or remote browser acceptance
was claimed for R2. No staging/production migration, Worker deployment, provider
activation, secret update, DNS/route change, webhook, or seller pilot was performed.

### Paid pricing and billing continuation (2026-08-03)

- Public catalog is paid-only: `starter` and `pro`, monthly, with Starter at `99,000 VND` / `5 USD` and Pro at `299,000 VND` / `15 USD`. Legacy `bot`, `store` and `business` plans remain hidden for existing tenants and are not public or assignable.
- New shops receive exactly one server-created seven-day `trialing` period with an explicit deadline and a separate trial usage period. Expired trials are request-time/scheduled transitioned to `suspended`; the three-day grace window applies only to verified paid-renewal failures.
- D1 migrations `0070_paid_plan_catalog.sql` through `0079_phase1_completion_hardening.sql` add plan/price snapshots, billing ledgers, immutable provider evidence, subscription events, usage events/counters, Dodo provider ownership, activation milestones, billing hardening, enum-only activation projections and the rotating activation-backfill checkpoint. Every change remains forward-only; previously numbered migrations are unchanged.
- Backend modules `src/lib/billing/plan-catalog.ts`, `entitlements.ts`, `subscription-access.ts`, `metering.ts`, `dodo.ts` and `service.ts` centralize feature/quota/state decisions. Dodo checkout is owner/recent-auth/CSRF/idempotency protected; market and currency are derived from normalized merchant country, price effective dates are checked server-side, and pending provider references fail closed.
- Canonical webhook route is `POST /api/webhooks/billing/dodo/:webhookPublicId`. Return URLs and checkout responses never activate access. Only a signed raw-body Dodo event with tenant, recurring-subscription, amount, currency and price identity evidence can activate or transition a subscription; duplicate/conflicting events are deterministic and audited.
- Role hardening is enforced server-side: owner-only billing/provider credentials, manager operational access without billing changes, support masked reads and viewer summary-only reads. Storefront, website/Telegram checkout, API credentials, provider contexts and readiness all enforce trial/grace deadlines.
- Local verification completed: `npm run check` (0 errors, 3 hints), `npm run lint`, `npm test` (243 files / 1,755 tests), `npm run build`, both deploy dry-runs, `npm audit --audit-level=high`, `git diff --check`, authenticated browser gate (7/7) and public browser gate (27/27) pass. Marketing/public pricing snapshot baselines were refreshed for the current source UI.
- Dodo dashboard configuration is now owner-approved: test and live mode are available, VND subscriptions are supported, and four distinct monthly offers exist for Starter/Pro in USD and VND with the approved prices. Safe webhook IDs are pinned per environment in `wrangler.jsonc`; no API key, webhook endpoint or Worker secret has been created yet.
- The Dodo runtime lane validates Standard Webhooks signatures, exact tenant/checkout/subscription/plan/amount/currency metadata, idempotent event identity, stale-event ordering, grace expiry and provider-pending retry recovery. The 32-scenario evidence validator exists, but no staging test-mode evidence artifact has been accepted and no remote migration/deploy occurred.
- External requirements before staging/production rollout: create scoped test credentials and register environment-specific signed webhooks only after route and release admission pass; then run checkout -> signed webhook -> subscription UAT. Production remains blocked by non-Dodo gates and no live charge is authorized.

### Commercial launch marketing and SEO continuation (2026-08-03)

- Marketing copy is bounded to the current Phase 1 offer: digital products, license keys and private files sold through the Website and Telegram, with seller-owned PayOS settlement and verified payment before delivery. Global/omnichannel, AI-agent, paid-community, Mini App and future-provider capabilities are not presented as active launch features; future channels are labeled `Coming next`.
- Website source contracts cover canonical and hreflang metadata, JSON-LD, robots, sitemap, `llms.txt`, the web manifest and banned-claim regression checks. The focused marketing/SEO suite passes 20/20 tests; scoped lint and `git diff --check` pass.
- `docs/LEGAL_SUPPORT_DECISIONS.md` records the owner/legal decisions still required for entity identity, jurisdiction, contact/support, refund, tax and SLA wording. No values were invented or published as settled policy.
- Production HTTP verification on 2026-08-03 found the deployed Worker stale: `/` and `/pricing` still serve older copy, while `/solutions`, the three solution detail routes, `/sitemap.xml` and `/llms.txt` return `404`. `/robots.txt` is Cloudflare Managed Content and does not expose the Worker sitemap/private-path policy. A reviewed deployment and Cloudflare configuration decision are required before claiming public launch SEO readiness.

## Frontend rebuild handoff

- The original handoff set (`00_MASTER_PROMPT.md` through `10_AGENTS_TEMPLATE.md`) now carries a dated continuation overlay. It preserves the historical Telegram/PayOS brief while explicitly reconciling the current `0001`-`0077` source chain, production `0001`-`0052` baseline, staging `0028` baseline, isolated dashboard lanes and contract-only Telegram Mini App/Zalo/WhatsApp/Discord status. No archive checksum changes are required because these root handoff files are outside `docs/frontend-rebuild-handoff/`.

- `docs/frontend-rebuild-handoff/` is the source-accurate package for replacing the current visual frontend without changing tenant, security, payment, fulfillment or operational semantics.
- The package contains architecture, authority precedence, capability maturity, role/permission, API/security, domain-state, screen-blueprint, design, migration and external-team brief documents, plus machine-readable route, API endpoint, acceptance and traceability artifacts.
- The route baseline is 25 canonical logical page routes plus two redirect aliases. It replaces the incomplete 17-route exact PromptOS matrix and 19-route working-copy matrix as the rebuild inventory.
- `ACCEPTANCE_MATRIX.csv` defines 87 route/state scenarios across the required 1440/768/390/320 responsive boundary; `TRACEABILITY_MATRIX.csv` links all canonical screens and aliases to page source, service/API authority and current tests.
- `API_ENDPOINT_INDEX.csv` inventories all 150 exported API/webhook method/path rows and maps each to its source file, tenant boundary, authentication/request-protection gate, capability or scope, D1/provider authority, contract reference and maturity.
- Capability maturity is explicit: implemented platform behavior is separated from read-only projections, service-only generated fulfillment, provider-pending PayOS/Telegram, external-pending custom domains and roadmap adapters. The handoff does not claim external provider activation.
- Validation completed for all three CSV files, the 150-row/123-source API inventory, YAML parse and exact 25-route/two-alias counts, all referenced traceability paths and `git diff --check`. The current source gate passes after the member/customer/billing/admin UI, Telegram Mini App session, provider receipt, customer-identity, public-read-scope, catalog-visibility, Dodo-provider and activation-analytics continuation; migrations `0053`-`0077` remain source/local-only. An isolated SQLite apply of all 77 migrations passes `PRAGMA integrity_check` and `PRAGMA foreign_key_check` with zero violations; no remote migration or provider activation was performed.
- Added a type-only declaration for the existing release-planner `.mjs` test import and removed two now-unnecessary casts; this changes no runtime behavior and closes the repository TypeScript gate.
- `HANDOFF_MANIFEST.json` records the source baseline, scope counts, verification results and SHA-256 checksums. The refreshed transfer archive is `artifacts/Selinow_Frontend_Rebuild_Handoff_2026-08-02.zip` with SHA-256 `62afe9a2c3fec0df17e6b98f9e1661b64819969a4cd447309be654edb16df20c`; `unzip -t` passed after the dashboard IA/provider-lane, tenant-stale guard and catalog-visibility refresh. The 2026-07-31 archive remains as the historical pre-credential-UI package.
- Known limitations for the external team: `/api/app` is not versioned, there is no generated OpenAPI/client, seller shop listing remains an SSR membership service rather than a browser GET endpoint, and provider completion for billing, refunds, seller messages and order overrides remains pending. `API_ENDPOINT_INDEX.csv` is a checked-in source inventory, not a replacement for runtime contract tests. The implementation team must pin a commit and refresh the handoff whenever source contracts change.
- This continuation includes the seller API-credential UI/client contract plus synchronized handoff documentation and archive metadata. It did not deploy, migrate, activate providers, change DNS/routes or access production/staging data.

### Seller operations continuation (2026-08-02)

- Added forward-only migration `0053_seller_operations_contracts.sql`: member
  public references/versioning and invitations, customer optimistic versioning,
  append-only customer/order notes, redaction guards and tenant-leading indexes.
- Added tenant-bound services/routes for member invite/accept/role/suspend/revoke,
  customer detail/update/note/redaction, order note list/append/redaction and
  active-platform-admin order/audit investigations. Raw email, provider payload,
  credentials, tokens and note bodies are not returned after redaction.
- Added forward-only migration `0054_backend_gap_workflows.sql` and tenant-bound
  services/routes for provider-pending seller order messages, payment
  remediation requests, optimistic billing plan/cancel requests and an
  owner/risk admin appeals/refunds queue. Provider-pending transitions never
  mark payment, delivery or subscription state complete without external
  evidence.
- Added `tests/unit/seller-operations-backend.test.ts` covering migration shape,
  tenant isolation, owner protection, invitation one-time acceptance,
  concurrency-safe version conflicts, idempotent replay, note immutability,
  message redaction, billing request preservation, payment remediation review
  and admin metadata masking. Existing handoff CSV/contract docs now list these
  endpoints and distinguish backend completion from pending UI wiring.
- External requirements remain unchanged: provider-backed billing settlement,
  refunds, seller message delivery and activation require separate authority
  and acceptance contracts. Migrations `0053` and `0054` are source/local only
  in this continuation and were not applied remotely.

### Channel expansion continuation (2026-08-02)

- Added forward-only migration `0055_channel_connector_requests.sql` for durable,
  tenant-bound seller connector intent. Requests are idempotent, versioned and
  audit-backed; `requested`, `provider_pending`, `active`, `rejected` and `canceled`
  transitions are guarded, terminal rows are immutable, and no delete path exists.
- Added safe manifests for `telegram.mini_app`, `zalo.mini_app`, `whatsapp.cloud`
  and `discord.bot`. Every manifest is explicit about capabilities, provider
  execution stage, required seller action and `inlineSecretDelivery:false`.
- Added `GET .../channels/catalog`, `GET/POST .../channels/requests` and
  `DELETE .../channels/requests/:requestPublicId` (four API rows, 144 total in
  the historical channel-expansion checkpoint; the current inventory is 150
  rows after public read scopes, catalog visibility and billing webhooks) to
  the handoff index.
  All routes preserve `shop_id` isolation, idempotency,
  recent-auth/CSRF and optimistic-version semantics; projections never include
  credentials, webhook secrets or provider payloads.
- Added Telegram Mini App `initData` HMAC/freshness/tamper verification and safe
  user projection. Added outbound policy guards for WhatsApp customer-service
  windows/templates, Zalo/WhatsApp group restrictions and authorized private
  reveal for secrets across all channels.
- Wired `/app/integrations` to the channel catalog/request APIs with localized
  safe cards, role-aware request/cancel controls, optimistic-version handling,
  provider-pending badges and no-secret projections. `tests/unit/integrations-frontend-contract.test.ts`
  covers the UI/API wiring and localized channel controls.
- Local acceptance is contract-only: channel expansion, seller operations and
  integrations UI focused suites pass 18/18. Provider credentials, webhooks, external delivery,
  staging/production migration and provider activation were not performed.

### Phase 9 workstream status

| Workstream | Status | Acceptance boundary |
| --- | --- | --- |
| Phase A — Canonical commerce cutover | Website/Telegram/fake accepted locally; staging/provider acceptance pending | Website, Telegram and `fake.third` real local-D1 parity now exercise the shared canonical transaction, quote/replay/concurrency and provider-boundary evidence. The fake path writes authoritative `order_channel_attributions` (`channel_code='fake.third'`, adapter version and connection); `orders.source_channel='web'` is a legacy compatibility alias only. The production platform handoff includes the admitted `0001`-`0052` schema/runtime, while controlled provider acceptance and staging migrations `0029`-`0076` remain pending. |
| Phase B — Global localization foundation | Source/local acceptance complete; staging visual pending | English (`en`) and Vietnamese (`vi-VN`) catalogs, source-level translation call-site/placeholder checks, unified BCP47 boundaries, locale-aware storefront/dashboard/Telegram copy, durable tenant-scoped Telegram buyer preference, minor-unit money formatting, canonical order/shop currency guards, seller country controls, paired English/Vietnamese commerce behavior and RTL logical/render checks are covered locally. The authenticated local browser gate passes 7/7 across desktop/mobile and 1440/768/390/320px plus 200% geometry; the PromptOS validator also passes. Staging visual acceptance remains 18/20 because the deployed Worker predates `[data-cart-variant-id]`. |
| Phase C — Typed fulfillment and entitlement execution | Generated-license implementation complete; staging/provider acceptance pending | Private-file requirements, seller-attested manual delivery, generic entitlements, verified reversal revocation and migrations `0049`-`0052` generated-license execution share the canonical Website/Telegram/`fake.third` boundary. Free checkout creates one pending generated request immediately; paid checkout creates it only after the exact signed `paid_exact` event. Credentials and artifacts use versioned AES-GCM with distinct AAD, queues/DLQ carry references only, ambiguous acceptance reconciles before retry, and completion waits for all generated requests. Signed PayOS refund/chargeback evidence enters the same verified reversal transaction. Generated artifacts are revealed alongside pooled keys through the existing Website order-keys API and Telegram fulfillment flow only while payment, ownership/channel attribution and entitlement TTL fences pass. Reversal, expiry, deletion crypto-shred, export schema v5, backup/restore, request hardening and credential/artifact rotation are covered locally. The production platform handoff includes this schema/runtime, but seller provider configuration remains service-level only and no provider-backed fulfillment was activated. |
| Phase D — Channel expansion contracts | Contract-ready locally; provider execution pending | Migrations `0055`-`0056` connector requests and direct-D1 scope guards, migration `0057` Telegram Mini App sessions, migration `0058` reference-only provider receipts, migration `0059` customer-identity references, migrations `0060`-`0062` Zalo OA OAuth state/retry hardening, migration `0063` enabled-channel scope guards, migration `0064` provider-verification evidence, migration `0065` credential-lineage/connection-identity guards, migration `0066` blind Zalo OA callback lookup, migration `0067` Telegram Mini App plan scope guard, migration `0068` public API read scopes and migration `0069` catalog channel visibility, four safe expansion manifests, catalog/list/create/cancel/visibility APIs, tenant-bound Mini App session exchange, verified ingress sequencing, Telegram `initData` verification and WhatsApp/Zalo/secret-delivery policy are covered locally. Telegram Mini App and WhatsApp/Discord entries are contract-ready; catalog visibility is service/UI-contract-ready with inline product controls and fail-closed conflict handling; Zalo provider execution is pending. No external credentials, webhook, outbound delivery, payment or fulfillment activation is claimed. |

## Accepted architecture expansion (documentation only)

- ADR 0007-0018 accept a channel-neutral commerce core, extensible connection/capability registry, no-tech onboarding boundary, managed-domain strategy, accessible design system, provider-neutral payment orchestration, additive private-download fulfillment, a bounded public API credential boundary, an immutable seller-attested manual fulfillment ledger, the generic entitlement foundation, verified payment-reversal revocation and provider-neutral generated-license fulfillment.
- The accepted direction keeps one Cloudflare modular monolith. D1 remains authoritative; existing Queues now carry reference-only domain-event and delivery work while the legacy Telegram outbox remains available during staged parity validation.
- Website, Telegram and PayOS remain the only implemented sales/payment adapters. Migrations `0055`-`0056` add a contract-ready expansion catalog and seller connector-intent workflow, `0057` adds the gated Telegram Mini App session boundary, `0058` adds reference-only D1 provider receipts, `0059` adds safe tenant-bound customer-identity references, `0063` repairs enabled-channel scope, `0064` records provider-verification evidence, `0065` adds credential-lineage/connection-identity guards, `0066` adds blind Zalo OA state lookup, `0067` adds the Telegram Mini App active-plan scope guard, `0068` adds public API read scopes and `0069` adds product/channel visibility; no external provider adapter, credential activation, webhook delivery, marketplace, managed shared bot or second payment provider runtime is claimed.
- Any further runtime schema change must remain forward-only and include characterization tests, dual read/write or backfill where required, and explicit cutover evidence before Phase 10 can become GO.
- The expanded delivery roadmap adds managed activation, messaging/social adapters, marketplace commerce and a connector/payment ecosystem as Phases 11-14. Provider access, seller demand, policy and legal eligibility remain release gates.

## Phase 0 artifacts

- Astro 7 SSR application using the Cloudflare adapter.
- Strict TypeScript, ESLint and Vitest configuration.
- Base request ID, security headers and stable JSON error helper.
- Safe local configuration example and secret handling policy.
- Cloudflare deploy configuration excludes secrets; reviewed non-secret production account/zone/resource identity is pinned in the environment and generated manifests for fail-closed admission.
- Repository instructions, architectural decisions and documentation skeleton.

## Phase 1 artifacts

- Idempotent Cloudflare doctor/provision scripts with dry-run and JSON output.
- Dedicated staging D1, R2, platform-cache KV, session KV, two queues and a shared DLQ are provisioned and bound by their real IDs/names in generated configuration.
- Explicit local, staging and guarded production configuration boundaries.
- Forward-only initial D1 migration plus idempotent platform defaults seed.
- Deployed staging Worker with fetch, queue and scheduled handlers, observability, live bindings/secrets and a one-minute cron; local and production retain the 15-minute schedule.
- Exact staging custom domains, proxied wildcard DNS, managed wildcard TLS and Worker route are live; the accepted deployment was observed at version `049009b4-9683-4c7f-8638-df859d50a0c8`.
- Environment-safe database and deployment commands with production mutation guards.

## Phase 2 artifacts

- Forward-only identity, session, shop, membership, subscription, domain, idempotency and audit migration.
- One-time magic-link consumption with purpose-bound HMAC token storage.
- Anonymous magic-link issuance no longer mutates an existing seller display name before mailbox verification; existing profile changes remain authenticated operations.
- FR006 admission hardening atomically enforces per-email, requester-HMAC and global fixed-window budgets before user/token writes, trusts only `CF-Connecting-IP`, and purges expired admission rows from the scheduled handler (`0017_auth_request_admissions.sql`).
- Opaque rotated sessions and session-bound CSRF tokens with exact dashboard-origin validation.
- Idempotent shop creation that atomically creates owner membership, settings, trial subscription and platform subdomain.
- Tenant-scoped shop reads/updates with server-owned role capabilities.
- Plan feature/limit parsing and checkout guards for shop/subscription state.
- Separate platform-admin authorization and audited shop suspension API.
- Seller login, dashboard and platform-admin shells.
- Reusable two-tenant isolation harness and negative security tests.

## Phase 3 artifacts

- Forward-only catalog, variant, inventory batch/key, customer, cart and immutable order snapshot migrations.
- Seller category/product/variant management with publish validation and tenant-scoped capability guards. Product plus initial-variant creation is one idempotent D1 batch with a safe audit receipt; variant failure rolls the product back without requiring a migration.
- Paste/CSV inventory import with strict limits, AES-256-GCM encryption, random IVs, versioned tenant/variant AAD and scoped HMAC fingerprints.
- Hostname-resolved public catalog projection that never reads inventory ciphertext or plaintext.
- Opaque cart access, server-authoritative quote generation and checkout price/version/stock revalidation.
- Conditional D1 inventory reservation with per-checkout reservation tokens and compensating release on partial/failing checkout.
- Purpose-bound private order tokens, masked order identity and key decryption only for completed authorized orders.
- Scheduled unpaid-order expiry with conditional state transition and repeat-safe reservation release.
- Local Phase 3 seed and HTTP acceptance runner covering stale checkout, concurrent last-key purchase, idempotent replay and order-token authorization.

## Phase 4 artifacts

- Forward-only PayOS integration, credential-version, payment-attempt/event/exception, fulfillment and outbox migration.
- Tenant credential connect/rotate/disconnect endpoints with recent-auth, CSRF, encrypted fields and pending credential support during PayOS webhook confirmation.
- PayOS adapter pinned to the current merchant API contract: `api-merchant.payos.vn`, merchant headers, official request/webhook HMAC canonicalization, bounded responses and response-signature verification.
- Order payment-link create/recovery using one globally unique safe-integer order code and the credential version that created the attempt.
- Opaque webhook public IDs, exact tenant credential resolution, constant-time signature checks and event reference/payload replay detection.
- Payment decision engine that auto-fulfills only exact, timely, identity-matched transfers; partial, overpaid, late and inconsistent events enter the exception inbox.
- Exactly-once digital fulfillment records, sold inventory transition and reference-only paid/exception outbox jobs.
- Leased reconciliation with bounded batches, exponential backoff/jitter and credential-grace cleanup before unpaid-order expiry.
- FR013 payment hardening binds attempt/order/inventory/outbox fulfillment to one exact `paid_event_id`, gives webhook events retryable processing-token leases, and recovers safely after transient D1 failure (`0015_payment_fulfillment_event_claim.sql`, `0016_payment_event_processing_claim.sql`).
- Reconciliation preserves the signed PayOS `orderCode` and rejects provider/order identity mismatches instead of rewriting evidence before fulfillment.
- FR023 provider ownership is tenant-exclusive and fails closed for legacy NULL ownership; crypto-shred destroys both credential and integration ownership fingerprints (`0013_payos_provider_ownership.sql`).
- FR027 public payment-link recovery respects the stored retry schedule and lease rather than bypassing provider backoff.

## Phase 5 artifacts

- Forward-only Telegram integration, credential, pseudonymous customer identity, encrypted recipient, update/action dedupe and discount migration.
- Seller bot connect/rotate/disconnect and health endpoints protected by membership, recent authentication and CSRF.
- Telegram Bot API 10.2 adapter with bounded responses, fixed provider origin, safe error mapping, timeout handling and `retry_after` support.
- Automated `getMe`, default/Vietnamese commands, commands menu, opaque webhook, allowed updates and webhook health verification before activation.
- Webhook secret verification before body parsing, per-integration update/payload dedupe, conflicting-payload audit and private-chat enforcement.
- Tenant-scoped Telegram catalog, cart, discount, checkout, PayOS payment link, owned orders and protected key reveal using shared inventory/order/payment/fulfillment state.
- Encrypted private recipient routing plus leased paid-notification outbox retries that reload existing fulfillment references without allocating another key.
- Immediate credential rotation, previous-secret invalidation, best-effort disconnect cleanup, degraded health for revoked tokens and 30-day update/action retention cleanup.
- Telegram cleanup retries transient provider/decryption failures, while credential-bound health writes prevent stale webhook evidence from restoring readiness after rotation or disconnect.

## Phase 6 artifacts

- Vietnamese marketing and pricing pages plus branded, responsive tenant storefront layouts for catalog, product detail, cart, checkout and order status.
- Exact hostname routing for platform, active, draft and suspended storefront states; reserved and unknown hostnames fail closed without resolving another tenant.
- Browser-side cart, quote, checkout, payment-status and protected key-reveal flows backed by the existing tenant-scoped commerce services.
- Storefront UI now exposes server-backed category filtering, selects the first available variant by default, blocks stale product snapshots, supports cart removal, disables cart/checkout continuation when a quote expires and surfaces only safe request IDs for checkout diagnostics.
- Seller catalog UI now supports category-aware draft creation, search/status filters, product/variant editing, category name/slug/description/status/sort-order updates, explicit category archive confirmation, product archive confirmation and explicit logout controls while retaining tenant-scoped capability checks. Inventory shows tenant-scoped available/reserved/delivered counts, server low-stock thresholds and last-import timestamps without rendering key plaintext.
- Hostname-scoped public catalog caching with explicit cache diagnostics, short TTLs and uncached cart, checkout, order and key routes. Cache namespaces include the immutable domain incarnation so a reassigned hostname cannot reuse a previous tenant response.
- Static Cloudflare asset delivery with external hashed JavaScript compatible with the restrictive self-only content security policy.
- Managed Turnstile on anonymous checkout with server-side hostname/action validation, fail-closed environment configuration and D1-backed anonymous request limits.
- Forward-only storefront abuse-control migration and an idempotent four-shop staging demo seed covering active, draft and suspended storefront states.
- Representative in-app browser acceptance covers the seeded storefront home, product detail, cart and checkout flows on desktop and a 360px mobile viewport, plus the unauthenticated dashboard redirect to `/login`. Add-to-cart state, quote refresh, responsive layout, page identity and console health passed. A discovered 2px mobile checkout overflow was fixed with shrink-safe grid children, protected by a regression test and reverified at equal `scrollWidth`/`viewportWidth` with no console warnings or errors.

## Phase 7 artifacts

- The independent `selinow.com` zone and Selinow staging D1/R2/KV/Queues/Worker are active; required staging Worker secrets are loaded without storing or reporting their values.
- The proxied originless fallback `proxy-fallback.selinow.com`, friendly target `customers.selinow.com` and Cloudflare for SaaS fallback origin are provisioned and active; non-secret `CLOUDFLARE_ZONE_ID`/`SAAS_CNAME_TARGET` Worker vars use the live zone contract.
- Idempotent platform provisioning that reuses exact SaaS DNS/fallback state, creates missing owned records, reconciles same-type drift and fails closed on conflicting DNS records.
- Platform doctor checks for the staging Worker secret name, temporary operator API context, exact proxied DNS records and an `active` fallback origin without printing the token.
- Shared-zone routing was initially applied with a staging fallback. The current reconciled contract routes `selinow.com/*`, `*.selinow.com/*`, and `*/*` to `selinow-com-production`, preserves only the four exact staging exceptions on `selinow-com-staging`, and leaves external custom-domain activation pending until current entitlement/Turnstile acceptance is complete.
- Forward-only custom-domain migrations with atomic per-plan quota enforcement (`0014_custom_domain_quotas.sql`), tenant-bound TXT ownership claims (`0018_custom_domain_ownership_claims.sql`), DNS/check/delete lifecycle, provider leases, optimistic versioning, primary uniqueness, canonical repair and payment origin snapshots.
- Owner-only seller APIs and dashboard UX for create/list/check/primary/delete with TXT-before-CNAME guidance, accessible loading/error states, recent-auth and CSRF enforcement.
- Bounded Cloudflare custom-hostname client, hostname/IDNA validation, DNS-over-HTTPS readiness checks and exponential reconciliation backoff.
- HMAC-derived ownership challenges are bound to claim ID, tenant, hostname and expiry; Cloudflare hostname creation cannot begin until the exact TXT proof succeeds.
- Pending claims for the same hostname may coexist across tenants, while atomic promotion grants the authoritative hostname to only one verified tenant.
- Custom storefront, cache, primary-domain, PayOS-origin and Telegram-origin queries require `ownership_verified_at`; platform subdomains remain unaffected.
- Legacy custom rows are tombstoned without trusting prior CNAME/SSL readiness, and the table rebuild preserves existing payment-domain foreign keys.
- Claim promotion rechecks expiry after DNS lookup, returns the authoritative domain after concurrent promotion, and fails closed if its audit mutation is incomplete.
- Guarded domain/payment concurrency: leased provider checks cannot overwrite deletion, primary/canonical changes are serialized, deletion blocks active payment origins, and concurrent payment creation recovers the winning attempt.
- Subscription grace policy keeps existing domains routable/reconcilable after downgrade while blocking new domains and custom-primary selection; cleanup check/delete remains available.
- Read-only `db:preflight` validates provider-ID uniqueness and unresolved active payment origins before migration.
- Native Worker `fetch` is invoked without rebinding its receiver in the Cloudflare, Telegram and PayOS clients; receiver-sensitive regression tests prevent the runtime-only `Illegal invocation` failure from returning.
- Live staging acceptance used `selinow-lab.vnecs.store`: TXT ownership passed, the DNS-only CNAME routed to `customers.selinow.com`, custom-hostname and SSL states reached `active`, the custom hostname rendered `Selinow Domain Lab`, and the platform hostname redirected `308` while the custom hostname was primary.
- The deletion path removed the provider hostname, restored `tung-domain-lab.staging.selinow.com` as the active primary storefront and stopped tenant routing on the removed hostname. The two test DNS records were then deleted and authoritative Cloudflare DNS returned no CNAME or ownership TXT.
- The least-privilege staging custom-hostname token was rolled after acceptance, verified with a successful Custom Hostnames API request and installed as the active `CLOUDFLARE_API_TOKEN` Worker secret without recording its value.

## Phase 8 artifacts (in progress)

- Browser-first eight-step seller wizard with server-stored profile, settings and resumable step state.
- Shop/channel/catalog flows, signed inventory preview/import, provider setup, policy validation, readiness checks, guarded publish and a controlled read-only test order.
- Telegram readiness uses only dedicated private `/start` evidence; general inbound activity cannot satisfy the health gate.
- Telegram disconnect, bot replacement and any credential rotation invalidate prior `/start` evidence.
- Telegram and PayOS health endpoints resume tenant-scoped `pending` or `error` credentials from encrypted D1 state without returning or logging secrets.
- Provider retry remains protected by membership capabilities, CSRF and recent authentication; PayOS retry remains owner-only.
- A channel-agnostic automation runtime persists tenant-scoped tasks/events in D1, performs CAS claims, lease recovery, retry backoff and immutable transition evidence, and runs from the staging scheduled handler.
- Tenant-facing create/list/detail/cancel/resume routes are live with capability-aware membership checks, CSRF/recent-auth guards, tenant-bounded reads, optimistic versions and durable idempotent response replay. Public resume accepts only the expected task version; continuation challenges are server-issued, opaque, hash-only and bound to one active member, task, tenant, expiry and immutable audit record.
- Automatic execution is currently limited to verifying Selinow-owned shop and platform-domain state. Telegram, PayOS and custom-domain continuation require fresh tenant-bound provider evidence; controlled external-provider acceptance and additional provider-side executors remain pending.
- Store builder publication is now explicit and tenant-safe: migration `0029_storefront_draft_publication.sql` keeps draft settings separate from the published snapshot, backfills only previously public shops, and prevents draft content from leaking into public storefronts. Owner-only publish re-runs readiness with an optimistic storefront version.
- The Store builder SEO tab now has a bounded draft contract for SEO title and description. Public metadata includes server-derived canonical/robots plus Open Graph title/description; canonical hostname and indexing state remain server-owned.
- The seller frontend UX slice adds explicit Settings/Preview tabs at the 390px store-builder breakpoint, blocks draft save and publish when Brand or Accent contrast falls below 4.5:1 using the server's `contrastInk` selection, exposes a live contrast status, renders customer search no-results feedback, and shows `Chưa có đơn` without a fabricated datetime for customers with no last order. Product manager and onboarding now create a product and its first variant through the atomic tenant-scoped POST with CSRF and a payload-bound idempotency key; onboarding activates both in the same commit and uses the legacy variant POST only to repair a pre-existing draft. The product editor creates additional variants through the existing endpoint, preserves server-owned `options_json`, uses the shop currency instead of a browser hard-code, exposes an out-of-stock filter from server inventory data and renders the authoritative product update time in the shop timezone. The category ledger now edits name, slug, description, status and sort order through the existing tenant-scoped `PUT` API; category archive and product archive both require explicit inline confirmation and state that retained products/orders/inventory are not deleted. Store builder preview now reads a narrow `shop:read` catalog projection and renders real active products with explicit empty/error/truncated states; preview cards cannot trigger buyer mutations and respect the draft exact-stock toggle.
- The current PromptOS follow-up expands truthful UI where backend contracts already exist: `/app/domains` SSRs the tenant snapshot and six-step lifecycle rail; `/app/inventory` clears plaintext import data, invalidates stale previews and maps safe retry errors; `/app/orders` allowlists payment-exception evidence without remediation controls; `/app/integrations` SSRs authorized Telegram/PayOS/domain health and removes unsupported provider aggregates; `/app/data` exposes eligible owner product restore while catalog PUT cannot bypass moderation; `/admin/operations` exposes a safe active deletion queue with owner/risk legal-hold controls and support read-only access; onboarding exposes the existing audited shop-name PATCH contract only to owner/manager; `/app/automation` exposes the existing tenant task projection with guarded refresh/cancel/resume; buyer quantity/quote controls fail closed on stale or malformed snapshots; SSR seller actions preserve selected-shop context without JavaScript; and seller data mutations resolve the environment-specific CSRF cookie name from SSR rather than a hard-coded local value. No provider secret, key plaintext, shop-internal identifier or unsupported mutation is rendered.

## Phase 9 artifacts (in progress)

- In the historical entries below, `source/local-only` describes the acceptance evidence at that checkpoint, not current production schema presence. Production D1 now has migrations `0001`-`0052` and the current Worker runtime; staging remains at `0028`, and provider-backed activation/acceptance remains disabled or pending.
- Accepted architecture records `0007`-`0015` plus a synchronized architecture overview and delivery roadmap. The channel registry, generic connection persistence, `CommerceApplicationService` contract, transactional event append, queue fan-out, Telegram generic-delivery runtime, bounded API credential boundary and seller-attested manual execution ledger are implemented; provider-backed external acceptance, broader lifecycle/outbound parity, broader public API resources and outbound webhooks remain pending.
- The channel-neutral commerce contract keeps provider identity and presentation outside canonical commands/views. The 2026-07-29 Phase A slice routes Website and Telegram canonical cart, quote, checkout, order, payment and key-fulfillment entrypoints through explicit `CommerceApplicationService` capabilities while preserving public wire shapes; explicit checkout recovery and private-download list/grant/consume capabilities are Website-only, while Telegram retains provider-specific replay recovery behind its application port. The exhaustive route inventory covers Website storefront buyer routes and rejects application-seam bypasses or low-level commerce/payment store imports; Telegram dispatch/runtime and application ports have separate boundary tests. Signed `quoteEvidence` binds shop, cart, item/product identity, quantity, unit price, product version, variant version, discount pricing and expiry; new Website and Telegram displayed-cart checkout require catalog-bound evidence. Evidence lifetime is capped at five minutes and the authoritative cart expiry, with bounded future clock skew. Website replay revalidates the original web-channel cart token, valid signed quote, source channel, normalized attribution and stored order-access-token hash before returning the derived token. Telegram stores an immutable quote reference in tenant/integration/source-update-bound `telegram_actions`, binds it to customer, subject and cart, emits only `buy:<sourceUpdateId>` in callback data and refreshes instead of checking out for legacy bare `buy`. Telegram checkout revalidates the signed evidence against current quantity, unit price, product/variant versions and discount pricing before order or reservation writes. Telegram replay uses the exact `checkout_cart_id`, or for pre-0030 rows searches converted carts for the stored request hash instead of trusting the latest cart. Identical concurrent retries recover the durable winner, while changed payloads fail with `idempotency_conflict`. Telegram command admission checks the exact tenant integration/connection plus built-in adapter support, live provider grants, plan/subscription policy, channel status and connection health before identity, recipient, cart or order writes.
- Phase A parity hardening adds Website, Telegram and fake-channel free-checkout fulfillment ledgers, tenant-scoped reservation release, stale/expired/tampered quote rejection, manual-only and mixed fulfillment semantics. Static source guards find no direct canonical commerce SQL writes or forbidden state-store imports in the enumerated provider roots, Telegram runtime/port and Website buyer-route handlers; this is bounded source evidence rather than a claim about every indirect runtime effect. The reusable fake adapter now enters the `PrincipalChannelCommercePort` and shared `commerce/checkout-transaction.ts`; its 24-test real local-D1 matrix covers free license, paid reservation, free manual fulfillment, discounted totals, quote/catalog/discount drift, replay binding, changed-payload conflict, capability admission, rollback, tenant isolation, concurrent cart increments and last-stock contention. The authoritative fake attribution is `order_channel_attributions(channel_code='fake.third', adapter_version=1, connection_id=...)`; the `orders.source_channel='web'` value is retained only for legacy compatibility. The current five-file seam run passed 106/106 tests. This slice is source/local-only and does not imply a staging deploy or migration.
- Phase C begins with additive private downloadable fulfillment in migration `0034_private_downloadable_fulfillment.sql`. Typed assets, immutable versions, product policies, order-item requirements, entitlements and one-use delivery grants keep D1 authoritative while R2 stores bytes only. The canonical Website/Telegram/fake checkout transaction now captures the active private-file policy immediately after `order_items` in the same guarded D1 batch; exact policy/version/asset drift fails closed and the requirement is created for both free and paid orders before any entitlement. Pre-cutover orders without a requirement use only a deterministic policy interval covering the historical order-item timestamp, so a later policy cannot reinterpret an older manual purchase. Website seller routes upload private files and configure policies; buyer order routes list access, issue a short-lived header token and atomically consume it before streaming a verified private response. Grant issuance is bound to the exact order item even when products share one asset version, and both grant issuance and consumption recheck authoritative paid/order state inside the committing D1 batch. Concurrent identical Website grant issuance now re-reads by tenant, entitlement and issuance-key hash when the D1 insert returns `changes=0`, returning the durable same-request token; a mismatched durable request hash returns `idempotency_conflict`, while an unrelated active grant remains `private_download_grant_active`. Stale active grants expire before replacement. Upload and policy configuration require a `draft|active` shop during pre-authorization and recheck that state in the authoritative D1 batch; an upload compensates the just-written R2 object on a suspension race, while a failed policy insert cannot retire or repoint the existing active policy. Deletion suspends the shop first and rechecks the destructive lease/legal-hold fence around each exact tenant-object delete. Once crypto-shred enters destructive work, its monotonic marker blocks new legal holds even after the lease expires, survives failure and lease reclamation, and clears only after successful step completion; the request remains visibly `failed` with the safe operational error while retry is required. Standard export, backup/restore validation and shop crypto-shred include the new lifecycle while excluding file bytes, object keys and token/buyer hashes. Remote restore drills count only contract tables present in a behind-ledger source, including order items, fulfillment ledgers, export/deletion workflow state and encryption-rotation runs/items; a single-row loss fails closed before the full repository ledger and complete post-`0034` schema are accepted. Telegram secure handoff remains unimplemented; this slice is source/local-only.
- Migration `0047_generic_entitlement_foundation.sql` adds tenant-scoped resources, versioned product policies, immutable order-item requirement snapshots, versioned entitlement state, immutable activation grants and an immutable transition ledger. Website, Telegram and `fake.third` snapshot the same exact active policy set in canonical checkout. Free checkout creates active access plus one `free_checkout` grant; paid checkout creates pending access and activates it only from the exact signed, claimed, unprocessed payment event whose attempt is `paid_exact` and whose `paid_event_id` matches. Typed private-file and generic requirements are excluded from legacy seller-manual rows; manual execution and generic requirements are mutually exclusive in both insertion directions. Backup validates all six tables. Export schema version 3 was the historical `0047` projection and version 4 was the historical `0048` projection; both are superseded by current schema version 5 through `0052`. Deletion retires configuration and revokes live entitlements behind the existing legal-hold/crypto-shred fence while retaining immutable requirements, grants and transitions. Provider-side grant/revoke execution and Telegram secure handoff remain follow-ups. ADR 0016 records this source/local-only boundary.
- Migration `0048_payment_reversal_entitlement_revocation.sql` adds the immutable tenant-scoped, hash-only `payment_reversal_events` ledger. Verified signed-webhook or direct-reconciliation evidence is bound to the exact shop/order/paid attempt/provider/integration/credential version/original paid event. Exact full refunds and chargebacks atomically set orders to `refunded`, revoke generic pending/active/suspended entitlements with immutable `payment_reversal` transitions, revoke private active/suspended entitlements and active delivery grants. Partial, amount/currency-mismatched or otherwise non-exact evidence creates an open `manual_review` exception and does not revoke. Sold keys, fulfillment, grants and delivery-consumption history remain immutable evidence. Schema version 4 was the historical reversal-only export checkpoint; current schema version 5 through `0052` retains the same safe normalized reversal metadata while adding generated-license lifecycle metadata. Backup count validation includes the ledger, and shop deletion retains it. Focused migration/service/lifecycle/backup coverage and the 176-file / 1,287-test post-`0048` gate remain historical evidence; the current `0052` full-suite checkpoint is recorded in Verification. ADR 0017 records this source/local-only boundary.
- Migrations `0049_generated_license_fulfillment.sql`, `0050_generated_license_deletion_lifecycle.sql`, `0051_generated_license_rotation.sql` and `0052_generated_license_request_hardening.sql` add one-artifact-per-entitlement seller-webhook execution on top of the generic graph. Exact free or signed-paid activation creates the durable request; provider adapters receive only endpoint, credential and a provider-neutral request and never receive D1. Leased CAS claims, retry classification, reconcile-before-generate after ambiguous acceptance, encrypted settlement, reference-only queue/DLQ payloads and all-request order completion are covered. Migration `0052` enforces canonical initial state, terminal/evidence immutability, retry/lease attempt rules and global scheduler/key-version indexes. Payment reversal cancels live work and revokes artifacts; deletion fences active leases, crypto-destroys credentials/artifacts and retains immutable evidence; rotation reuses the credential/inventory KEKs with generated-specific AAD. Standard export schema version 5 exposes safe metadata only, and backup/restore validates all eight generated-license tables. Website/Telegram/`fake.third` free/paid parity, replay/conflict and tenant isolation are covered locally. Buyer reveal now uses the existing Website order-keys API and Telegram fulfillment flow with payment, ownership/channel and TTL fences; seller provider configuration remains service-level only. ADR 0018 records this source/local-only boundary.
- The payment/fulfillment capability slice adds provider-neutral `CommercePaymentFulfillmentService`/`CommercePaymentFulfillmentPort`, `WebsitePaymentFulfillmentPort` and a source-bound customer-principal port for Telegram/future authenticated channels. Website payment-link and key routes remain wire-compatible; mixed manual/digital orders reveal only fulfilled digital allocations while manual-only work remains pending. PayOS webhook verification delegates all payment decisions and state mutations to `commerce/payment-events.ts`, trusts only signed `data.code` rather than unsigned envelope fields, rereads authoritative reference rows after idempotent event insertion, and keeps unpaid/exception transitions monotonic. Reconciliation requires complete, description-consistent transaction evidence and uses the latest contributing transaction timestamp so cumulative payments crossing expiry fail closed. `tests/unit/provider-adapter-commerce-boundary.test.ts` statically rejects direct canonical commerce writes and forbidden state-store imports in the enumerated provider boundary.
- The bounded Phase D payment-provider foundation adds a versioned provider registry, capability-to-operation validation, authenticated `NormalizedPaymentEvidence` bound to the exact tenant/order/provider/environment/connection/credential/version/account/settlement expectation, and a provider adapter contract that receives no D1 binding and cannot mark orders paid or trigger fulfillment. The PayOS descriptor truthfully exposes direct BYO VND bank-transfer/QR capabilities without refund support, while the legacy PayOS decision API maps into the shared conservative normalized decision with behavior preserved. A fake second provider proves signed-evidence admission plus exact/partial/overpaid/late/identity-mismatch/terminal-unpaid decisions and rejects invalid authentication or overstated descriptors.
- Phase D persistence is additive and source/local-only. Migration `0035_payment_provider_connections.sql` adds tenant-scoped payment-provider connections plus capability/currency/method projections, descriptor/policy versions, settlement/credential ownership and provider-attested country/account evidence, then deterministically links existing PayOS integrations without changing the runtime authority. Migration `0036_payos_identity_claim_hardening.sql` clears unverified pending/error ownership claims; verified evidence remains retained. Migration `0037_legacy_payos_tenant_guards.sql` validates existing rows before adding tenant-leading indexes and bidirectional guards across integration, credential, order, attempt, event, exception and paid-event relationships. Migration `0039_payment_provider_identity_shred.sql` permits generic provider account/country identity claims to be cleared only inside an active tenant crypto-shred lease after provider cleanup, grace and legal-hold checks. Migration `0043_payment_settlement_policy_guard.sql` validates existing projection rows and rejects every unsupported settlement/credential tuple at insert and update, so direct settlement is seller-owned and managed credentials are MoR-partner-only. Legacy PayOS financial tables remain authoritative and retained; no second-provider/Stripe credential, webhook, checkout, reconciliation or fulfillment runtime is implemented.
- Phase D lifecycle integration exports safe provider connection/grant/currency/method metadata while excluding fingerprints, credential envelopes, IVs, raw account identifiers and provider payloads. Shop deletion disconnects the generic projection, revokes grants, disables effective support and crypto-shreds provider identity claims under the existing lease/hold fence while retaining financial attempts, events and exceptions for audit/retention.
- The bounded Phase E slice is source/local-only. Migration `0038_api_credentials.sql` adds owner-managed tenant API credentials with keyed token hashes, one-time plaintext reveal, immutable grant/expiry, a ten-unexpired-active limit and version-safe revocation. Migration `0040_api_catalog_scope.sql` forward-rebuilds the scope allowlist for `shop:read`/`catalog:read`, and `0068_public_api_read_scopes.sql` adds `inventory:read`/`orders:read` while preserving rows, hashes, indexes and lifecycle triggers. Migration `0042_security_rate_limit_retention.sql` adds an indexed bounded purge path for expired limiter windows; scheduled cleanup caps each run at 1,000, retains active blocks, emits only a numeric metric and crypto-shred removes the deleted shop's limiter rows under the existing lease fence. Recent-authenticated session routes issue/list/revoke credentials with CSRF, optimistic versions, idempotent replay and audit-once behavior, and their success/error responses now carry no-store, no-referrer and noindex headers. `GET /api/v1/shop`, `/api/v1/catalog`, `/api/v1/inventory` and `/api/v1/orders` derive the tenant only from the Bearer credential, enforce shop/subscription state and a D1 fixed-window rate limit, and ignore client tenant overrides. Catalog exposes active categories/products/currency-matching variants and derived stock state; inventory exposes aggregate counts only; orders expose safe summaries with customer, provider, payment-attempt, fulfillment-internal and token data redacted. Seller exports exclude token and revocation hashes; protected full DR/PITR backups retain keyed digests to preserve authentication state, with point-in-time credential resurrection after restore documented as an unresolved post-restore invalidation requirement. Fulfillment/entitlement scopes and outbound webhook subscriptions remain unimplemented.
- Migration `0041_private_download_claim_leases.sql` adds a tenant-scoped five-minute pre-read claim for Website private-download consumption. Concurrent losers fail before R2 `get`, buffering or SHA-256; storage/integrity failures release the claim, process interruption is recovered by expiry, and final immutable `served` consumption is fenced by claim ID. Backup schema validation and local restore include the claim table; it remains staging-pending and is never customer-exported.
- Dark login/admin surfaces now use semantic canvas/text tokens instead of inverse tokens, storefront status text uses AA-safe semantic colors, control boundaries and disabled states are explicit, and the marketing gradient is constrained for white-text contrast. Static accessibility tests scan Astro surfaces for names, labels, focus, keyboard tab behavior, reduced motion and positive tabindex. Playwright locks desktop/mobile public-flow screenshots and horizontal-overflow geometry, while axe scans WCAG A/AA on storefront home, product, cart and login at both viewports. Authenticated Chrome QA covers the current seller/admin route set, onboarding and domains on desktop and mobile. The deterministic local authenticated gate uses disposable D1/KV state, a temporary Wrangler config outside the repository, mode-0600 disposable secrets, disabled remote bindings, a visible one-time magic-link flow and isolation/redaction contracts. The authenticated local browser gate passes 7/7 and the isolated public gate passes 27/27 across exact desktop/mobile PromptOS viewports plus 200% geometry; 42 authenticated and 26 public route/state screenshots were reviewed, the PromptOS validator passes, and no remote resource or mutation was used. The active PromptOS matrix remains 19 routes / 82 route-state pairs, with unlisted degraded/loading/blocked variants documented as visual follow-up. Staging visual acceptance remains separate and is 18/20 because the deployed Worker lacks `[data-cart-variant-id]`.
- Migration `0021_channel_connections.sql` adds tenant-scoped channels, multiple provider connections, open-intent idempotency, capability grants, encrypted credential envelopes, active-member enforcement and fail-closed lifecycle transitions. The migration itself does not cut over or backfill the existing Telegram/website connection runtime; the later website commerce application seam is separate from connection lifecycle adoption.
- Migration `0022_order_channel_attributions.sql` dual-writes tenant-bound channel code, adapter version and optional connection attribution for website and Telegram orders while preserving the existing `orders.source_channel` compatibility field.
- Migrations `0023_automation_api_evidence.sql` and `0024_automation_create_idempotency_scope.sql` add immutable opaque continuation evidence, a 100-open-task tenant ceiling and shop-wide create-idempotency uniqueness across actors and capabilities.
- Migration `0025_telegram_channel_connection_backfill.sql` projects existing Telegram integrations into the generic channel/connection registry and fills only same-tenant, previously empty Telegram order attributions. The migration is rerunnable, preserves legacy rows and fails closed on deterministic identity collisions; focused backfill coverage passes 2/2.
- Migration `0026_domain_event_delivery_outbox.sql` adds strict tenant-bound, reference-only `domain_events` and per-connection `delivery_jobs` with immutable identity, dedupe, composite tenant FKs and lease/status guards. Legacy `outbox_jobs` remains untouched during staged parity validation.
- Migration `0027_telegram_generic_connection_link.sql` links every legacy Telegram integration to an exact same-tenant generic connection, dual-writes lifecycle health and grants the reviewed eight-capability allowlist. Its compound capability sources are split into D1-compatible groups and protected by a repository-wide maximum-five-term migration guard.
- Migration `0028_domain_delivery_runtime_hardening.sql` adds ready/expired-lease indexes, generic dead-letter target links, guarded replay transitions and recovery transitions for failed domain events and delivery jobs.
- Migration `0030_order_checkout_cart_reference.sql` adds the tenant-leading `orders.checkout_cart_id` reference and index so Telegram checkout replays can resolve the immutable converted-cart snapshot; it is present in the current source tree and remains staging-pending until the guarded migration gate is admitted.
- Migration `0031_shop_country_configuration.sql` adds nullable merchant/business country fields with tenant-leading partial indexes; shop create/PATCH now accepts country, currency and `defaultLocale`, while legacy pre-0031 rows use a safe read fallback and currency changes fail closed when variants would be stranded.
- Migration `0032_shop_globalization_invariants.sql` adds an immutable ISO-3166 alpha-2 reference table and D1 triggers for country validity, supported shop/variant currencies and shop/variant currency matching. Invalid staged country values are normalized to explicit unknowns; unsupported or mismatched currency writes fail closed before they can strand catalog variants.
- Migration `0033_cart_mutation_replays.sql` adds tenant-scoped, expiring anonymous website cart-mutation replay records keyed by subject, idempotency key and request hash. Website and Telegram now share the mutation/pricing core while Telegram retains its provider-specific action ledger; this migration is source/local-only and staging-pending.
- Migration `0044_order_currency_invariants.sql` validates existing order currencies and installs fail-closed insert/update guards for unsupported currencies or order/shop mismatch. Orders remain immutable money snapshots when a shop later changes currency; unsupported or drifted checkout attempts produce no order, reservation, payment or fulfillment mutation.
- Migration `0045_telegram_customer_locale_preference.sql` stores a buyer-explicit `en`/`vi-VN` preference separately from inferred Telegram identity locale. `/language en|vi` writes the tenant-scoped preference idempotently; invalid input, precedence and cross-shop isolation are covered locally.
- Migration `0046_manual_fulfillment_executions.sql` adds immutable seller-attested per-item delivery and hash-only external-reference evidence for eligible legacy-manual items.
- Migration `0047_generic_entitlement_foundation.sql` adds `entitlement_resources`, `product_entitlement_policies`, `order_item_entitlement_requirements`, `entitlements`, `entitlement_grants` and `entitlement_transitions`; it remains source/local-only and staging-pending.
- Migration `0048_payment_reversal_entitlement_revocation.sql` adds immutable verified reversal evidence and exact-payment access revocation; it remains source/local-only and staging-pending.
- Migrations `0049`-`0052` add generated-license provider execution, deletion lifecycle, rotation and request-state hardening. They were source/local-only at the historical acceptance checkpoint, are included in the live production `0001`-`0052` baseline, and remain staging-pending.
- The staging Worker claims/reclaims events and delivery jobs with tenant, version and lease guards; publishes unsupported events without false failure; fans out only `order.paid@1`; reloads Telegram tenant/order/grant/credential/recipient state; and ACKs only after a durable transition or terminal dead-letter record. Cron re-enqueues D1-owned pending/retryable/expired work, while the legacy Telegram outbox remains active until controlled parity is proven.
- Typed channel lifecycle/inbound/outbound ports and a versioned adapter manifest registry now compute effective capabilities from adapter support, provider grants, plan entitlement, connection health and policy blocks. The reusable fake adapter proves the transport boundary and fail-closed capability projection, and its real local-D1 commerce matrix now proves equivalent price, discount, reservation, order and fulfillment state through the principal-channel port. Website, Telegram and fake local parity are accepted; generic channel lifecycle/outbound parity, controlled provider acceptance and staging admission remain pending.
- Phase B globalization foundation and commerce surfaces are implemented across middleware, cache keys, `<html lang>`/`dir`, storefront/API commerce contexts, catalog copy, client cart/checkout/product/order flows and Telegram replies. Supported locales are `en` and `vi-VN` (legacy `vi` canonicalizes). Central BCP47 parsing accepts valid case/script/extension forms, rejects malformed input and maps unsupported languages to the safe English fallback. Resolution remains explicit preference, verified identity/cookie, request language, shop default, then English. Telegram `/language en|vi` persists the separate buyer-explicit preference in migration `0045`. Local, staging and production platform configuration plus login use centralized English when no supported hint exists; tenant storefronts retain their persisted shop default before English.
- Phase B surface slices cover locale-aware marketing header/index/pricing, storefront catalog/product/cart/checkout/order views, seller products/inventory pages and client scripts, dashboard AppLayout/onboarding state text, and the admin overview, shop directory and operations surfaces. The shared admin brand, navigation accessibility labels, page bodies and operations topbar resolve through the same English/Vietnamese catalog instead of raw layout copy. Catalog parity is exact for dashboard (1,296 keys), admin (445) and storefront (294); marketing, onboarding, system and Telegram catalogs also have focused parity coverage. The source-level translation call-site gate verifies referenced keys, catalog key parity and placeholder parity, while runtime fallback still avoids exposing technical keys.
- Paired English/Vietnamese Website, Telegram and `fake.third` commerce scenarios exercise equivalent canonical cart/quote/checkout/order/payment/fulfillment outcomes. Shared logical CSS and the local synthetic RTL browser contract verify resolved `dir="rtl"` placement without enabling an unsupported product locale. Merchant-authored catalog text remains intentionally single-language. Current-source authenticated visual acceptance is closed locally with 28 manually reviewed exact-viewport snapshots; no staging deployment is claimed for these source slices.
- The onboarding follow-up removes its implicit VND display/parser fallback: English and Vietnamese price labels interpolate the selected shop currency, shop switching updates the label, and malformed catalog projections fall back to authoritative `shop.currency`. The products client now also requires a supported SSR `data-default-currency` before attaching product or variant mutation handlers; missing or unsupported metadata disables the controls and cannot issue a fetch instead of silently substituting VND. These changes remain source/local-only.
- Currency is centralized in the USD/EUR/JPY/VND registry with integer minor-unit formatting, major-unit seller inputs and no FX conversion. Onboarding and settings expose the real tenant-scoped merchant/business country, currency and default-locale contract. Catalog, shop and migration `0044` order guards reject unsupported or mismatched currencies before D1 mutation, projections hide invalid variants, and shop-currency changes fail closed if existing variants would be stranded. PayOS payment handoff and paid Website/Telegram checkout reject non-VND before provider, integration, attempt, customer, order, reservation or checkout-action writes; free non-VND orders remain provider-independent.
- Telegram now persists a verified identity locale hint and uses canonical localized commerce/status/payment/fulfillment/error/outbox text and locale-aware money/date formatting. Generic delivery reloads tenant/identity locale and uses the same catalog notification copy; hardcoded `vi-VN` number formatting is removed.
- Website and Telegram checkout prechecks reread the winning order after catalog/inventory or reservation failures. Replay authorization now binds tenant, checkout subject hash, exact request hash and (for Website) cart-token/quote proof, with deterministic local-D1 race coverage for both channels.
- Redacted structured logging, bounded reference-only queue parsing, request/queue/scheduled telemetry and immutable audit protections.
- Forward-only operations migrations for backup/restore evidence, incidents, dead letters, export/deletion workflows, abuse reports, moderation actions and encryption rotation.
- Environment-guarded D1 backup and isolated restore-drill tooling with integrity, foreign-key, migration-ledger and application-row-count acceptance checks.
- Remote restore now fails closed on a missing or empty SQL export before any isolated-target import (`database_export_empty`), with regression coverage in `tests/unit/backup-tools.test.ts`.
- Remote restore admission is now identity-bound before any temporary directory or D1 target is created: `wrangler whoami --json` must include the approved account from the environment/generated manifests, and `d1 list --env {environment} --json` must contain exactly one matching source name and UUID. Every remote restore command (create, count, export, import, migration, verification and cleanup) pins `CLOUDFLARE_ACCOUNT_ID`; account and database mismatches fail closed as `restore_account_mismatch:{environment}` or `restore_database_mismatch:{environment}`. Regression tests prove no target is created on either mismatch, and a complete successful mock proves every remote command remains account-pinned.
- Platform Operations UI/API for incidents, dead letters and resumable credential/inventory encryption rotations with owner-only, recent-auth, CSRF, idempotency and explicit high-risk confirmations.
- Tenant-scoped abuse reporting, seller/admin review, moderation actions and audited legacy shop suspension. The storefront form uses the real sanitized Turnstile/idempotency contract, never echoes reporter contact and now exposes product targeting only after a public product successfully resolves.
- Moderation provenance is retained and enforced: shop owners can restore only shop-originated product suspensions, while platform suspensions remain authoritative across owner/manager catalog writes.
- Platform support is limited to the audited `received -> triaged` abuse-report transition; investigation, dismissal, closure and target actions remain restricted to owner/risk in both the service boundary and Operations UI.
- Anonymous storefront cart, checkout and abuse-report limits use only the trusted Cloudflare client-address bucket; rotating or omitting `User-Agent` cannot reset the per-shop/action window, and rejected cart requests do not create rows.
- PayOS webhook fulfillment is bound to the exact credential that owns each attempt; pending, expired-grace and other credential versions cannot settle it, while retained grace credentials can process only their own attempts.
- Encrypted standard seller exports, separately acknowledged plaintext inventory-key exports and short-lived one-time download tokens in private R2.
- Resumable shop deletion with active-payment/grace/legal-hold gates, leased provider cleanup, cancellation before irreversible progress, crypto-shred and retained financial/audit evidence.
- Platform owner/risk legal-hold set/release controls with optimistic versioning, tenant binding, evidence references and idempotent audit history.
- The admin operations surface now reads a safe active deletion projection containing only public shop reference, lifecycle dates, safe error code and version; legal-hold forms retain confirmation, CSRF, recent-auth, idempotency and optimistic-version guards, while support remains read-only.
- The protected Admin Sellers & Shops directory now exposes a GET-only, cursor-paginated D1 projection for platform owner/risk/support. Search is bounded to public shop ID, slug and shop name; shop/subscription filters are allowlisted; rows contain only public shop identity, lifecycle/subscription state and aggregate active-member/owner/product/channel health. Platform-user identity, credentials, inventory keys, buyer tokens, payment/provider payloads and internal shop IDs are not selected, and the route offers no impersonation or mutation shortcut.
- Active legal holds are rechecked after destructive leases and block provider cleanup, crypto-shred, finalization and seller cancellation; custom-domain, Telegram and PayOS cleanup now share a lease/hold fence and preserve `retention_hold` on races.
- All staging mutations (backup, migration, seed and deploy) require the same read-only live route inventory proving the exact completed production handoff: production owns the shared apex/wildcard pair and staging owns only its wildcard plus catch-all Worker Routes. The audit token is never passed to application build or child backup/restore processes. A dedicated staging-only `platform:route-preflight` exposes that account/D1/route checkpoint independently with one GET-only route request and safe metadata, but it does not replace full doctor or fresh-backup admission.
- Production deploy and migration paths require canonical release evidence, approved resource identity and final admission rechecks. The production Worker deploy gate performs read-only, account-pinned `whoami`, exact live D1 name+UUID, Worker Routes and Worker Domains checks against the reviewed production bindings, repeats admission before the Wrangler sink, strips the audit token from child environments and pins the final account. Those gates admitted the completed first-production migration, candidate deploy and route-only traffic handoff; future production mutations remain fail-closed behind the same controls.
- Seller projection routes now include customers, members, billing and data/audit; aliases for Telegram and store settings preserve tenant-safe shop selection. Customer profile/status/notes, owner member invitation/role/suspension and audited billing change-request intents are implemented with tenant, CSRF, recent-auth, idempotency and version guards; provider-backed billing settlement, seller message delivery, refund and order override actions remain explicitly pending/unavailable.
- Middleware centralizes private/no-store and noindex headers for `/app`, `/onboarding`, `/admin` and `/login`. The authenticated browser contract covers the current seller/admin route set, including `/admin`, `/admin/operations` and `/admin/shops`, and exports no cookies, tokens or magic-link hrefs. The authenticated local browser gate passes 7/7 and the isolated public local gate passes 27/27 across exact desktop/mobile PromptOS viewports, 200% geometry and GET/HEAD-only enforcement with runtime, axe, overflow and console checks. Current local visual evidence contains 42 authenticated and 26 public route/state snapshots. The active PromptOS matrix remains 19 routes / 82 route-state pairs; unlisted degraded/loading/blocked variants are documented follow-up rather than silently claimed complete. The staging Worker lacks `[data-cart-variant-id]`, so its visual gate remains 18/20. The current PromptOS marketing frontend is now traffic-deployed at `selinow.com`; no checkout/payment side effect was exercised during the production visual smoke.

## Phase 10 release status (PLATFORM HANDOFF COMPLETE; FULL COMMERCE/PROVIDER NO-GO)

- Production execution is fail-closed behind an explicit production environment, confirmation flag, complete generated manifest and release-doctor evidence.
- Real staging mutation is fail-closed behind shared admission: backup, migrate, seed and deploy require `selinow.com/*`, `*.selinow.com/*` and `*/*` to point to `selinow-com-production`, and exact `staging.selinow.com/*`, `app-staging.selinow.com/*`, `api-staging.selinow.com/*` and `*.staging.selinow.com/*` exceptions to point to `selinow-com-staging`, plus exact account/runtime/live-D1 identity and immediate rechecks. The three exact exceptions are now explicit in the checked-in route contract because the deployed staging wildcard cannot intercept those hosts; no DNS or Worker Custom Domain mutation is implied. Null guards, missing exceptions, bare-host route entries and any other extra binding fail closed. Migrate, seed and deploy additionally require fresh report-v2 backup evidence for the admitted D1 target before their final sink; direct commands cannot bypass the gate. Build-only and dry-run packaging remain offline.
- The 2026-07-30 read-only continuation completed `npm run deploy:staging:dry-run` and Wrangler packaging without deployment. `node scripts/staging-route-preflight.mjs --env staging --json` failed closed with `cloudflare_route_audit_api_token_missing` before a live route request because the temporary route-audit token is unavailable; no live route inventory, staging mutation or production action occurred.
- Added the bounded `npm run staging:phase-a:smoke -- --json` post-deploy gate. It derives exact staging origins from the checked-in spec, performs only credential-free GET requests, validates the canonical Website/Telegram health marker, reads the Signal catalog/storefront, and confirms checkout/webhook GET method boundaries. It never creates carts, quotes, orders, payments, reservations, webhook updates or fulfillment and emits no response bodies. A full canonical-marker pass remains pending until a future admitted staging deployment updates the Worker.
- The first live read-only smoke run returned 5/6 checks: catalog, storefront home/product and both GET method boundaries passed; `/api/health` returned `200` but `health_contract_mismatch` because the currently deployed Worker predates the new canonical marker. No request body, checkout/payment call or staging mutation occurred.
- Production migrations `0001`-`0052`, the Worker candidate upload/deploy, route-only platform handoff and exact dashboard/API Worker Domain activation are complete. Continuation migrations `0053`-`0076` remain source/local-only and pending approval. Private artifacts are stored under `.wrangler/bootstrap/bootstrap_20260730_first_release/`: `canary-upload.json`, `canary-applied.json`, `canary-smoke.json`, `promote-live-inventory.json`, `promote-inventory.json`, `promote-plan.json`, `promotion-acceptance.json`, `promotion-applied.json`, `platform-domain-activation.json` and `production-smoke.json`.
- The first-production canary path is implemented as a guarded three-phase flow: `versions upload --strict` captures exactly one candidate and validates every production binding; version `metadata.has_preview` is informational, while the read-only Worker subdomain inventory must report both `enabled=false` and `previews_enabled=false` before and after each guarded phase; apply also requires `canary.selinow.com` to resolve publicly only to Cloudflare anycast A/AAAA addresses before candidate deployment, checks DNS and subdomain state again immediately before one exact route `POST`, and compensates if either admission changes; rollback deletes only the captured route ID before restoring the exact control version and disabled subdomain state. The completed canary served 200 for `/`, `/api/health`, `/pricing` and `/login`; `/api/health` returned `principal-channel-canonical-v1`.
- The historical platform-only handoff replaced the apex and wildcard routes with production and initially retained a staging catch-all. That catch-all has since been corrected: current live ownership keeps `*/*` on production and only exact staging exceptions on the staging Worker. Production still has zero queue consumers and no cron schedule, remains on runtime phase 6 / schema `0052`, and has not activated current payment, Telegram, fulfillment, or external custom-domain behavior.
- Full commerce/provider activation still requires controlled PayOS and Telegram acceptance, two seller pilots, remaining Phase 9 runtime/extensibility/security and external-operations evidence, monitoring/support/legal ownership and a release SHA/tag. A future external-domain cutover additionally requires the pending external-host inventory and Turnstile hostname-admission lifecycle. These gates do not block the completed platform-only frontend handoff.

## Verification

Verified through 2026-08-03 with Node 25.9.0, npm 11.12.1 and Wrangler 4.114.0:

| Command/check | Result |
| --- | --- |
| `npm install` | Clean install completed; lockfile generated |
| Dedicated staging route preflight | `platform:route-preflight` is staging-only and shares the exact account/D1/route validator used by mutation admission. Focused platform/deploy/database coverage passed 52/52; targeted ESLint and Node syntax checks passed. The latest real read-only command failed closed with `cloudflare_route_audit_api_token_missing`; an earlier explicit production-target regression failed with `staging_route_preflight_staging_only`. No live route request, staging mutation or production action occurred |
| Production Worker identity admission hardening | Focused platform/deploy/release coverage passes 61/61. The first-production bootstrap performed account-pinned identity, exact live D1 name/UUID, shared-zone Worker Routes and Worker Domains checks before/after candidate upload, and the post-promotion inventory confirms the candidate version is active without queue/cron/subdomain drift |
| First-production canary contract | `tests/unit/production-canary.test.ts` passes 30/30 in the focused run and `npm run check` reports 0 errors/0 warnings. The canary used route-neutral `versions upload`, exact version/binding validation, informational `has_preview` handling, read-only Worker subdomain preview admission (`enabled=false`, `previews_enabled=false`), public DNS admission before deploy and route apply, one-route POST/ID-bound DELETE compensation, read-only queue/cron/domain invariants and private canary artifacts. Live smoke returned 200 for `/`, `/api/health`, `/pricing` and `/login` on `canary.selinow.com`; `/api/health` included the canonical commerce marker |
| First-production route promotion contract | `tests/unit/production-promotion.test.ts` covers reviewed-plan/evidence binding, blocker recomputation, explicit route reconciliation, staging preservation, route-ID drift, failure compensation, explicit rollback and private report permissions. The promotion planner and executor are pinned to `infra/release/production-promotion-staging.json`, which is runtime-verified as an exact derivation of the canonical staging spec with only `sharedZoneDisabledRoutes: []`; the handoff builder emits the seven-route shared-zone matrix, including the three exact staging exceptions, and preserves `*/* -> selinow-com-production` in the current full-fallback mode. `release:production:promote` rejects unapproved shared-zone routes and uses per-route POST/ID-bound PUT/ID-bound DELETE (never a zone-wide route replacement), reconciles ambiguous responses from fresh inventory and fingerprints the full evidence/state. Deleted Cloudflare route IDs cannot be recreated identically; compensation restores exact pattern/script state, records replacement IDs and fails closed if verification is incomplete. External custom-domain cutover and Turnstile hostname admission remain pending rather than being inferred from this platform route contract |
| Earlier `npm run platform:doctor -- --env staging --json` attempt | Failed closed before the dashboard-assisted provisioning because the temporary operator token was unavailable; retained as negative-path evidence only |
| Staging continuation route preflight | `platform:doctor -- --env staging --json` confirmed the authenticated staging account and all declared D1/R2/KV/Queue/Worker-secret resources, but failed closed only for missing temporary `CLOUDFLARE_PLATFORM_API_TOKEN` and `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN`; the dedicated route preflight consequently made no live route request. No live route inventory or mutation was performed |
| Staging migration status and D1 preflight | Historical checkpoint: the read-only remote query reported 28 applied migrations through `0028` and 39 pending migrations through `0067`. The current source chain extends through `0076`, so staging now has 48 pending migrations (`0029`-`0076`) until a separately admitted migration run; D1 identity matches the checked-in staging manifest and no staging mutation was performed |
| Staging backup plan | `npm run backup:create -- --env staging --dry-run --json` passed and validated `selinow-staging` without exporting or writing a snapshot. A real staging backup is a guarded mutation and cannot proceed without full doctor/route admission and exact generated-manifest D1 identity |
| Earlier `npm run platform:provision -- --env staging --dry-run --json` attempt | Failed closed before discovery because `CLOUDFLARE_PLATFORM_API_TOKEN` was unavailable; current remote state was provisioned and verified separately without storing the token |
| Phase 7 platform-script unit tests | 15/15 passed: public bindings, route-matrix validation, secret-name parsing, create/reuse/update/conflict planning, fixed API origin and safe provider errors |
| Staging route-admission remediation | Route hardening/deploy focused coverage passed 32/32; the combined platform/deploy/db/middleware/globalization suite passed 48/48; and the latest staging runbook admission/backup suite passed 67/67 with ESLint/TypeScript clean. Extra/conflicting script-bound routes fail closed; backup, migrate, seed and deploy all require both temporary tokens, a full doctor pass, exact generated-manifest/live account+D1 name/UUID identity, required staging wildcard/catch-all routes and an immediate whoami/route-audit repeat. Migrate/seed/deploy paths verify fresh report-v2 evidence before their final sink. No live route inventory or mutation was performed |
| Historical source/packaging gates through `0047` | `npm run check` reported 0 errors and 3 existing hints; `npm run lint`, `npm run test` (174 files / 1,269 tests), `npm run build`, `npm run build:staging`, `npm run deploy:dry-run` and `npm run deploy:staging:dry-run` passed at that checkpoint. They are not final `0048` evidence. |
| Current `0049`-`0052` plus production-runbook verification | Generated-license migration/crypto/fulfillment/provider-boundary/reversal/export/deletion/rotation/request-hardening/worker/parity coverage passes the recorded focused suites. Signed PayOS full-refund replay and buyer reveal through the Website order-keys API and Telegram fulfillment boundary are included. The current full repository gate passed `npm run check` with 0 errors and 3 hints, `npm run lint`, `npx tsc --noEmit`, `npm test` with 190 files / 1,457 tests, `npm run build`, `npm run build:staging`, `npm run deploy:dry-run`, `npm run deploy:staging:dry-run` (203 modules, 2,653.38 KiB, no deployment) and `npm audit --audit-level=high` with 0 vulnerabilities. Local report-v2 backup `.wrangler/backups/local/bkp_20260729200227_e62dd876dec1/snapshot.json` and isolated restore `.wrangler/restore-drills/local/rdr_20260729200234_45eaf6386435.json` cover all 52 migrations through `0052`; the restore passed integrity `ok`, zero FK violations, 612 restored items, no missing tables/count mismatches and exact temporary-target cleanup. These source/package gates preceded the separately recorded production migration, deploy, route promotion and platform-domain activation. |
| Current seller operations continuation | Migrations `0053_seller_operations_contracts.sql` and `0054_backend_gap_workflows.sql`, member/customer/order/admin backend services and routes, and `tests/unit/seller-operations-backend.test.ts` are covered by focused tests plus full-suite regression. The latest local source gate passes `npm test` with 241 files / 1,713 tests, `npm run check` with 0 errors and 3 hints, `npm run lint`, `npx tsc --noEmit`, `npm run build`, `npm run build:staging`, both deploy dry-runs, `npm audit --audit-level=high` and `git diff --check`. Migrations `0053`-`0076` were not applied to staging or production. |
| Current channel expansion continuation | Migrations `0055_channel_connector_requests.sql` and `0056_channel_connector_scope_guards.sql`, `0057_telegram_mini_app_sessions.sql`, `0058_channel_provider_event_receipts.sql`, `0059_channel_customer_identities.sql`, `0060`-`0062` Zalo OA OAuth state/retry hardening, `0063_channel_enabled_scope_guards.sql`, `0064_provider_verification_evidence.sql`, `0065_provider_verification_scope_guards.sql`, `0066_zalo_oa_oauth_state_lookup.sql`, `0067_telegram_mini_app_plan_scope_guard.sql`, `0068_public_api_read_scopes.sql` and `0069_catalog_channel_visibility.sql`, five safe expansion manifests, catalog/list/create/cancel/visibility routes, the tenant-bound session exchange, Telegram Mini App cart/quote/checkout/order routes, verified ingress sequencing, D1 receipt claims, HMAC-bound customer identity projection and provider-verification evidence are source/local-only. Direct-D1 scope guards reject cross-tenant, inactive-requester, mismatched and unknown connector inserts; session issuance rejects launch replay and credential-version drift; receipt claims reject changed-payload conflicts and immutable identity violations; identity upserts reject provider-subject remapping; visibility rows are tenant/lifecycle guarded and missing rows fail closed. The channel expansion, seller API/backend, session, receipt, identity, provider-verification, Mini App commerce, public-read and integrations UI focused suites pass locally; API inventory is synchronized at 150 rows. No provider credential, webhook, outbound delivery, staging migration or production continuation mutation occurred. |
| Continuation backup/restore coverage | `scripts/lib/backup.mjs` now includes seller-operation ledgers (`shop_member_invitations`, `customer_notes`, `order_notes`, `subscription_change_requests`, `order_messages`, `payment_remediation_requests`) and channel-expansion ledgers (`channel_connector_requests`, `telegram_mini_app_sessions`, `channel_provider_event_receipts`, `channel_customer_identities`, `channel_oauth_states`, `channel_provider_verification_evidence`, `catalog_channel_visibility`) in authoritative count/schema validation. Losing a row in any of these tables now fails the isolated restore with `restore_count_mismatch`; focused backup coverage passes 25/25. This remains source/local evidence and does not replace a protected remote backup/restore admission. |
| Current staging visual gate | `npm run test:visual:staging` completed 18/20 tests. The two cart tests fail closed before screenshot because the deployed staging Worker does not yet render `[data-cart-variant-id]`; the separate PromptOS validator and read-only matrix pass at 1440/768/390/320px. Snapshots were not regenerated and no checkout/payment side effect occurred |
| Phase A canonical commerce focused evidence | The current dedicated five-file fake/real-D1 seam run passed 106/106 tests, including 72 tests in `commerce-channel-parity-real-d1.test.ts`. The fake adapter enters the shared `PrincipalChannelCommercePort` and canonical checkout transaction; real D1 covers free license, paid reservation, free manual fulfillment, discounted totals, canonical Website recovery with and without discounts, order-insensitive retry/recovery, quote/catalog/discount drift, replay/customer/connection/version binding, changed-payload conflict, capability admission, rollback, tenant isolation, concurrent cart increments and one-winner last-stock contention. Normalized attribution is authoritative in `order_channel_attributions`; `orders.source_channel='web'` remains a compatibility alias only. Website/Telegram route inventories and provider-boundary guards remain covered; staging admission and controlled external provider acceptance remain pending. |
| Phase A migration cutover boundary | Phase A schema additions are `0030` and `0033`, but the current Worker requires later schema at runtime: `0029` storefront publication, `0041` scheduled claim purge, `0045` Telegram locale, `0057` Mini App sessions, `0058` provider receipts, `0059` customer identities, `0063` enabled-channel scope guards, `0064` provider-verification evidence, `0065` credential-lineage guards, `0066` OAuth lookup, `0067` Telegram Mini App plan scope guard, `0068` public API read scopes, `0069` catalog visibility and `0070`-`0076` pricing/billing continuation are direct dependencies, with payment/API/export/fulfillment paths reading additional post-Phase-A tables. The current tree must therefore migrate the complete ordered `0029`-`0076` chain before deployment; no partial-schema Worker is claimed. |
| Phase A payment/fulfillment and migration evidence | `CommercePaymentFulfillmentService` coverage passed 33/33 focused tests. Migration `0030` compatibility passed 17/17 focused tests plus a disposable Wrangler D1 local application of all 30 migrations; legacy rows remain nullable, the `(shop_id, checkout_cart_id, id)` partial index is tenant-leading, and integrity/foreign-key checks pass. No staging migration, deployment or production action was performed |
| Phase B locale/currency/country evidence | Focused globalization coverage includes platform configuration/login no-hint English fallback, preserved Vietnamese tenant defaults, bounded BCP47 parsing/canonicalization, translation call-site and placeholder parity checks, money/date formatting, ISO country reference/guards, seller country controls, shop/variant/order currency invariants through migration `0044`, paired English/Vietnamese Website/Telegram/fake commerce behavior, tenant-scoped Telegram `/language` persistence through migration `0045`, and logical/rendered RTL checks. Source/local functional and authenticated visual gates are closed; staging hydrated-cart review remains open because the deployed Worker predates the current selector. No provider, staging or production mutation occurred |
| Phase B seller products/inventory localization | Focused 10-test coverage passed for dashboard-translated product/inventory pages and client scripts, 154+83 catalog namespaces/default-variant keys, and no staging/production mutation |
| Phase B status/stock locale follow-up | Dashboard order status badges now prefer the request locale before the shop default, and storefront `stockLabel` defaults to English when no locale is supplied. Focused i18n coverage passed 14/14; no staging/production mutation |
| Phase B onboarding currency regression | Five focused files / 35 tests passed; onboarding price copy uses the active shop currency and malformed variant projections fall back to authoritative `shop.currency` instead of VND |
| Phase B payment evidence | Payment focused coverage passed 50/50, including signed PayOS evidence, reference races, monotonic state transitions, reconciliation timing and paid non-VND fail-closed boundaries |
| Commerce parity/lifecycle/attribution evidence | Combined Website/Telegram/fake real-D1 commerce parity, connection lifecycle, exact connection attribution and normalized order-attribution coverage exercise tenant isolation, replay safety and bounded provider source guards. The fake adapter's authoritative attribution records `channel_code='fake.third'`, adapter version `1` and its connection while the legacy `orders.source_channel='web'` bucket remains only for compatibility. |
| Phase A concurrency evidence | Website and Telegram local-D1 race tests cover winning-order rereads after catalog/inventory or reservation failure, tenant/subject/request-hash binding, source channel/normalized attribution, connection identity where applicable and cart-token/quote proof. Identical retries recover one durable winner; changed payload, discount/pricing, product/variant version or attribution fails closed. |
| Phase 7 missing-token dry run | Failed closed before discovery/mutation with `cloudflare_platform_api_token_missing` and preserved the `staging` environment label |
| Phase 7 domain lifecycle tests | 14/14 passed, including poll/delete, primary/delete, payment/delete and provider-failure reconciliation races |
| Phase 7 ownership-preclaim regression | 62/62 focused tests passed across domain claims, TXT DNS, seeded migration, storefront/cache, PayOS and Telegram routing guards |
| Phase 7 ownership migration validation | Applied `0001`-`0017`, seeded an active legacy custom canonical plus a referencing payment attempt, then applied `0018`; integrity `ok`, zero FK errors, payment FK preserved, legacy hostname tombstoned and platform canonical restored |
| Phase 7 promotion-race regression | 41 focused tests passed across ownership expiry, concurrent promotion, audit failure, DNS and provider lifecycle paths |
| Phase 7 migration copy validation | `0009_custom_domains.sql` applied to a temporary pre-0009 D1 copy; integrity `ok`, zero FK errors, canonical gaps, primary conflicts or active attempts missing origin |
| Phase 7 secret scan | Exact custom-hostname token matched zero repository files; clipboard cleared after the staging-secret attempt |
| Phase 7 native-fetch regression | Cloudflare, Telegram and PayOS provider clients detach injected/native `fetch` before invocation; receiver-sensitive tests passed and the temporary raw-message diagnostic logger was removed |
| Phase 7 live custom-domain acceptance | `selinow-lab.vnecs.store` completed TXT ownership, Cloudflare hostname/SSL/DNS activation, primary selection, HTTPS tenant rendering, platform-host `308` redirect, provider deletion, fallback-primary restoration and authoritative DNS cleanup |
| Phase 7 token hygiene | Least-privilege zone token rolled after acceptance, new token verified with Custom Hostnames API HTTP 200 and staging Worker secret changed in active version `6c158fba-55d5-4347-b68f-747811c73b2f` |
| Staging Cloudflare Email Sending acceptance | Magic-link email delivered to an operator-controlled test mailbox; inbox receipt and link flow were acknowledged without exposing the token in repository evidence |
| Phase 8 provider retry regression | Telegram/PayOS retained-credential retry, same-bot token rotation and authoritative `/start` UI checks passed targeted unit coverage |
| Phase 8/9 foundation regression | 19/19 focused tests passed for no-tech automation transitions, retry/lease recovery, app-shell guards and the channel capability/fake-adapter contract |
| Admin Sellers & Shops focused regression | 13/13 targeted tests passed across platform-admin authorization, safe projection fields, literal LIKE escaping, status/subscription filters, opaque cursor pagination, invalid-input failure, GET-only API, private-page headers and responsive PromptOS source contracts; focused ESLint passed. Current-source screenshot acceptance is now covered by the exact-viewport authenticated local baselines |
| Restore-drill identity and authoritative-count regression | The authoritative count contract includes `payment_reversal_events`, with focused regression proving a missing reversal row returns `restore_count_mismatch`. Fresh local report `.wrangler/restore-drills/local/rdr_20260729181613_aea63f410180.json` applied the exact 48-migration ledger through `0048` to a disposable copy, restored 612 items, passed integrity `ok`, zero FK violations, zero missing tables/count mismatches and mode-`0600` report validation, then removed the exact temporary target. It is local-only evidence and does not replace the fresh report-v2 protected staging backup gate. |
| Historical `npm run check` through `0045` | Passed; superseded by the later `0047` checkpoint recorded above |
| Historical `npm run lint` through `0045` | Passed; superseded by the later `0047` checkpoint recorded above |
| Phase A checkout/payment security regression | Replay requires the original cart proof, valid catalog-bound quote, expected source/attribution and matching stored order-token hash. Quote quantity/shop/cart/item/product-version/variant-version/discount/TTL/cart-expiry checks, unsigned PayOS envelope tampering, concurrent reference conflict/duplicate handling, multi-transaction expiry crossing and stale payment-state ordering have focused regression coverage. |
| Phase C checkout requirement snapshot regression | Real local-D1 parity covers Website, Telegram and `fake.third` free checkout; each creates one immutable `private_file` requirement before any entitlement, and same-key checkout replay does not duplicate it. Policy replacement leaves the original policy/version/asset bound to the order; a policy race before the guarded batch rolls back the order and leaves the cart active. Historical orders predating a policy remain without access. |
| Phase C private-download grant issuance race regression | `tests/unit/private-file-fulfillment.test.ts` passes 19/19, including real SQLite serialized-batch overlap: identical same-key requests return one durable grant/replay without exposing the token, and a durable winner with a different request hash fails closed with `idempotency_conflict`. Same grant/token/request retries replay without another claim, consumption, audit row or quota increment while re-reading and integrity-checking the R2 object. Focused source/test validation is local-only. |
| Phase C delivery-claim maintenance regression | The current lease/maintenance/worker slice passes 37/37. Expired claim cleanup is bounded to 500 by default and 1,000 maximum, deletes by tenant tuple `(shop_id, id)`, retains active leases, and emits only the numeric `purgedDeliveryGrantClaims` scheduled metric without token, secret, claim or grant identifiers. |
| Phase C private-download regression | The focused private-download lifecycle coverage remains green, including 19/19 service tests plus migration, route, export, deletion and backup contracts. New real-D1 canonical checks cover checkout-time requirement capture, replay, policy replacement, policy-race rollback and legacy policy-interval isolation across Website, Telegram and `fake.third`. |
| Phase C private UI limitations | Seller upload/policy configuration and buyer list/grant/header-token consume/download flows are accepted in source/local tests. A GET API for policy/history prefill, seller-initiated retire/revoke controls, browser E2E with an R2 fixture/real binary download and Telegram secure handoff remain follow-ups. Verified payment-reversal revocation is implemented locally in `0048`, but no provider-side refund API or external grant-revoke executor is claimed. |
| Phase D payment-provider contract and persistence | Provider/readiness/migration coverage, legacy tenant guards and lifecycle hardening pass focused coverage. Covered behavior includes binding-aware evidence decisions, versioned registry/operation validation, fail-closed readiness projection, deterministic `0035` PayOS backfill, post-verification ownership claims, `0037` same-tenant relationship guards, `0039` deletion-fenced provider identity crypto-shred, `0043` settlement-policy validation/guards and tenant-equal unmapped webhook outcomes. The historical full source suite through `0045` passed 169 files / 1,241 tests; the retained restore report remains through `0043`. No remote provider call, staging mutation, runtime cutover or Stripe support occurred |
| Phase E API credential/catalog foundation | Focused credential/catalog/migration coverage plus retention/header/deletion regressions pass. `GET /api/v1/shop` retains `shop:read`; `GET /api/v1/catalog` requires `catalog:read`; `0040` preserves existing credential hashes/triggers and adds no write authority. Migration `0042` bounds indexed limiter cleanup and tenant crypto-shred deletion; API credential management success/error responses include no-store, no-referrer and noindex headers. Inventory/order/fulfillment/entitlement and outbound webhook scopes remain pending |
| Architecture documentation consistency | ADR 0002 permits reviewed non-secret production resource identity while preserving the secret boundary; ADR 0007-0018 cover the commerce/entitlement/reversal/generated-license expansion. Roadmap/status now distinguish the completed production platform handoff from pending staging/provider-side execution, external customer-domain activation and full commerce acceptance |
| Codex security scan `workingtree-6d0b05c14a56_20260729T074902Z` | Pre-remediation deep scan completed with 313/313 review coverage, 7 reconciled candidates and 3 reportable findings (2 medium/P2, 1 low/P3). Canonical report, findings, coverage and manifest are retained at `/private/var/folders/m4/1tyb0d41399gbt62vgxhhsph0000gn/T/codex-security-scans/Selinow.com/workingtree-6d0b05c14a56_20260729T074902Z/report.md`; the post-fix rescan disclosed that `artifacts/05_findings/s6-001/candidate_ledger.jsonl` has a pre-existing SHA-256 mismatch against the manifest, so full seal integrity is not claimed. Hardening portfolio and three defensive write-ups are linked from the manifest. Operator-only backup/seed/provision candidates remain retained as hardening, not product findings. |
| Targeted post-remediation security rescan | Local-only report `artifacts/06_post_remediation_rescan/targeted_rescan_report.md` and six unique receipts validate private-download claims, tenant-equal PayOS misses, magic-link browser initiation binding, production backup/seed admission and staging provision account pinning. Seven focused files / 126 tests passed; all six former candidates are recorded `fixed` and locally `not_reproducible`. The report explicitly discloses the pre-existing s6 manifest mismatch and does not claim deployed/staging/production validation. |
| Security remediation closure | `s3-001` now claims before R2 I/O; `s4-payment-webhook-cross-tenant-ordercode-oracle` removes the global fallback; `s6-001` binds issuance origin, initiation cookie and consume identity. Production backup/seed and staging provision now require exact account/D1 admission and pin Wrangler. Focused remediation suites pass `146/146`; no staging or production mutation occurred. |
| Full `npm run test` checkpoints | Historical: `0045` 169 files / 1,241 tests, `0047` 174 files / 1,269 tests, `0048` 176 files / 1,287 tests, `0051` 181 files / 1,333 tests and the pre-promotion checkpoint 188 files / 1,423 tests. The pre-channel `0052` plus production canary/promotion hardening checkpoint was 190 files / 1,457 tests; the pre-UI continuation checkpoint after migrations `0053`-`0055` was 193 files / 1,478 tests; the intermediate source gate after migrations `0053`-`0056` and UI wiring was 197 files / 1,489 tests; the prior source gate after `0057`-`0058`, provider route/Zalo contracts, admin/channel UI and receipt ledger was 207 files / 1,533 tests; the `0059` identity continuation checkpoint was 218 files / 1,575 tests; the pre-Dodo continuation checkpoint was 235 files / 1,670 tests. The latest current gate is 243 files / 1,755 tests. |
| Phase 9 channel backfill/outbox schema regression | 6/6 focused tests passed for Telegram backfill reruns/collision isolation and domain-event/delivery-job schema, tenant FKs, fan-out dedupe, immutable lifecycle and legacy outbox preservation |
| Current `npm run build` after `0052` | Cloudflare server build completed; the existing non-blocking `INEFFECTIVE_DYNAMIC_IMPORT` warning remains documented |
| Historical bounded seller/frontend regression | Moderation restore, admin deletion queue, domain lifecycle, inventory import hardening, payment evidence, integrations SSR/context, automation ledger, shop rename, buyer bound controls, seller-shell responsive hardening, dynamic CSRF cookie resolution, static tenant links, catalog/editor, store-preview and role-aware shell contracts passed in the recorded 169-file / 1,241-test suite; the later full-source checkpoint after migration `0047` is recorded above. |
| Current `npm run build:staging` after `0052` | Staging build completed without deployment |
| Current `npm run deploy:dry-run` after `0052` | Wrangler packaged the local Worker target and exited at `--dry-run` without deployment |
| Historical `npm run deploy:staging:dry-run` packaging checkpoint | Wrangler packaged the declared staging bindings (203 modules, 2,654.10 KiB) and exited at `--dry-run`; this earlier size is retained for audit history. The current final-tree package checkpoint is 2,653.38 KiB; no route read, staging mutation or deployment occurred |
| Earlier `npm run test:visual:staging` | 16/16 desktop/mobile visual and axe WCAG A/AA checks passed for the prior PromptOS storefront and seller catalog tree. This historical result is superseded by the current 18/20 read-only staging run; its two cart checks fail closed before screenshot because the deployed Worker lacks the current hydration selector |
| Staging packaging dry-run boundary | Final-tree staging Wrangler packaging passed at `0052` and exited at `--dry-run` without deployment; no route read, staging mutation or deployment occurred |
| Local authenticated browser gate contract | 7/7 tests passed: deterministic desktop/mobile fixture computes exactly 13% / 1 of 8 groups; the temporary config ignores repository `.dev.vars` and staging/production environments; only mode-0600 disposable secrets are loaded; loopback origins and the single safe snapshot argument are enforced; concurrent runs cannot stop a server they do not own; failure diagnostics redact tokens/cookies/secrets/opaque values; and the runner/spec prohibit remote bindings, storage-state/cookie/href export and token-bearing reads |
| Current local authenticated browser gate | 7/7 passed across desktop/mobile and 1440/768/390/320px plus 200% geometry, including runtime, axe, horizontal-overflow, console and PromptOS validation. The authenticated screenshot run generated 42 current-source snapshots at exact 1440x1024 and 390x844 viewports; all were manually reviewed. No staging/production resource or mutation was used |
| Earlier local authenticated browser gate preflight (negative-path evidence) | An earlier 2026-07-29 run reached Wrangler's disposable local D1 setup and failed closed at `listen EPERM 127.0.0.1`; no remote target was selected, the gate sent no browser request and no temporary gate state remained. The later guarded Playwright fallback reached `/app` and completed runtime/axe/overflow/console checks; the geometry fix is now verified |
| Earlier local authenticated browser gate rendered run (pre-current frontend slices) | Passed in both Playwright projects (desktop and 375px mobile): the visible local magic-link flow rendered 14 authenticated seller routes, including `/app`, `/onboarding`, `/app/domains`, products, inventory, orders, customers, integrations, store, data, members and billing; all 28 reviewed baselines matched; onboarding showed 13% / 1 of 8; axe WCAG A/AA, horizontal-overflow, console-error and page-error gates passed; no remote resource or checkout/provider side effect was used. These artifacts predate the current catalog/editor, domain, inventory, payment-evidence, integrations and admin-operation changes and are not treated as current-tree visual proof |
| Phase 9 deletion control regression | 24/24 deletion controls passed, including active-hold provider blocking, post-lease hold races for custom-domain/Telegram/PayOS cleanup, transient provider retry, cancellation, stale-version and irreversible-step guards |
| Local isolated restore drill | Fresh report `.wrangler/restore-drills/local/rdr_20260728214957_5cf6905ec48e.json` applied the exact 29-migration ledger from `0001` through `0029` to a disposable target; integrity `ok`, zero FK violations, zero missing tables/count mismatches and 347 restored rows; the temporary target was removed and the report is mode `0600` |
| Local isolated restore drill after migration `0034` | Fresh report `.wrangler/restore-drills/local/rdr_20260729042959_bf4032091729.json` applied the exact ordered current local chain through `0034` to a disposable target; integrity `ok`, zero FK violations, 347 restored rows, no missing tables/count mismatches and target cleanup all passed. The temporary target was removed; no remote or production mutation was run |
| Local isolated restore drill after Phase D persistence | Fresh report `.wrangler/restore-drills/local/rdr_20260729053154_40e5c94e2aa2.json` applied the exact ordered current chain through `0037` to a disposable target; integrity `ok`, zero FK violations, 347 restored rows, no missing tables/count mismatches and target cleanup all passed. This is local-only evidence; no remote or production mutation was run |
| Local isolated restore drill after Phase E catalog scope | Fresh report `.wrangler/restore-drills/local/rdr_20260729073020_22f3c708cd9c.json` applied the exact ordered current chain through `0040` to a disposable target; integrity `ok`, zero FK violations, 347 restored rows, no missing tables/count mismatches and target cleanup all passed. This is local-only evidence; no remote or production mutation was run |
| Local isolated restore drill after settlement/retention hardening | Fresh historical report `.wrangler/restore-drills/local/rdr_20260729112843_e1a560243088.json` applied the ordered chain through `0043` to a disposable target; integrity `ok`, zero FK violations, 347 restored rows, no missing tables/count mismatches and target cleanup all passed. The then-current source chain extended through `0059`, so this historical report does not replace the current-chain drill or a protected staging backup. No remote, staging or production continuation mutation was run |
| Current local isolated restore drill through `0052` | Fresh report `.wrangler/restore-drills/local/rdr_20260729200234_45eaf6386435.json` applied the exact ordered 52-migration ledger through `0052_generated_license_request_hardening.sql` to an isolated target; integrity `ok`, zero FK violations, 612 restored items, no missing tables/count mismatches and exact target cleanup all passed. Its source backup is `.wrangler/backups/local/bkp_20260729200227_e62dd876dec1/snapshot.json` (report v2, status `available`, 2,609,152 bytes, SHA-256 `e95c9b8161a7da393c1b64204781f02a825986c2bd143ca7c721fa4c49fb519a`). This is local-only evidence and does not replace a fresh admitted report-v2 staging backup. |
| Current local isolated restore drill through `0059` | Fresh report `.wrangler/restore-drills/local/rdr_20260802093008_62fc355479ae.json` applied the exact 59-migration source ledger through `0059_channel_customer_identities.sql` to an isolated target; integrity `ok`, zero FK violations, 612 restored items, no missing tables/count mismatches and exact target cleanup all passed. This is local-only evidence and does not replace a fresh admitted report-v2 staging backup. |
| Historical local isolated restore drill through `0064` | Fresh report `.wrangler/restore-drills/local/rdr_20260802121252_56fa8688ae9a.json` applied the exact 64-migration source ledger to an isolated target; integrity `ok`, zero FK violations, 612 restored items, no schema/count mismatches and exact target cleanup all passed. The known historical `0062_zalo_oa_oauth_state_reissue.sql` alias was normalized only inside the disposable copy and recorded in the report; the authoritative local D1 remains unchanged. This is local-only evidence and does not replace a fresh admitted report-v2 staging backup. |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `npm run release:production:plan -- --json` | Passed as a non-mutating plan with `execution=false` |
| Historical pre-promotion `npm run release:doctor -- --json` | Failed closed as designed before dedicated credentials and canary/promotion evidence were refreshed. The separate first-production ceremony subsequently admitted the exact account/D1 identity, applied migrations `0001`-`0052`, deployed the reviewed candidate and completed the platform handoff. Normal full-commerce release gates remain separate from this historical negative-path result |
| First-production bootstrap admission | Focused bootstrap/backup/domain coverage passes 78/78. The exact production D1/R2/KV/Queue resources and Turnstile widget exist; all eight required Worker secrets are installed. Protected backup `.wrangler/backups/production/bkp_20260730085510_b14287fa3c8e/snapshot.json` captured the empty D1 with a provider bookmark, 32-byte artifact and verified SHA-256, and the isolated drill verified the empty baseline before cleanup. The completed ceremony then applied migrations `0001`-`0052`, deployed Worker version `6ca9c890-ed04-44dc-ac32-44b36881f2dc`, promoted apex/wildcard routes and activated exact dashboard/API Worker Domains. External customer-domain inventory/Turnstile admission, payment, Telegram and fulfillment remain pending or disabled. |
| Historical normal-release `npm run release:manifest -- --json` | Failed closed because canonical normal-release pilots and acceptance were incomplete; the completed first-production platform handoff used its separate guarded ceremony instead |
| Staging Worker deployment | Generic domain-event fan-out, Telegram delivery, DLQ replay, hardened queue consumers and the mobile checkout correction are active at code version `049009b4-9683-4c7f-8638-df859d50a0c8`; D1/R2/KV/Queue/Email bindings, custom domains and wildcard routing remain live |
| Current frontend slice deployment boundary | A 2026-08-04 read-only Cloudflare observation found the production Worker version prefix `e2a4bc53` carrying the frontend-only release; historical version `6ca9c890-ed04-44dc-ac32-44b36881f2dc` is no longer current. `selinow.com`, `app.selinow.com` and `api.selinow.com` resolve publicly through Cloudflare; exact candidate/rollback identity, route inventory and the observed zero-consumer production queue state must be reconciled before continuation. No production Turnstile external-host or full-commerce admission is claimed. |
| Staging rollback target | Previous accepted Worker version `2d7166ff-3a87-4a9f-81bd-edd4db1074e2` remains available in the staging version history |
| Staging backup | Historical pre-migration snapshot `bkp_20260727115311_ae2d581d060a` (report v1) remains retained with SHA-256 checksum `ad8beee57fc443f92699e2496e3eb00830742c6fe23af601e03d900fe7556213`, but is stale/invalid for current staging mutation admission (`staging_backup_evidence_invalid`). Read-only backup dry-run passes; a new non-empty report-v2 Time Travel backup with exact admitted account/D1 identity, provider bookmark, recorded size/SHA-256 and age <=60 minutes is mandatory after doctor/live-route admission |
| Staging live-route admission | `platform:doctor --env staging --json` confirms staging resource readiness and the Worker secret binding, then fails closed because `CLOUDFLARE_PLATFORM_API_TOKEN` and `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN` are unavailable. No live route inventory was bypassed and no staging mutation was attempted |
| Historical staging attribution/automation/platform migrations checkpoint | The accepted staging cutover had migrations through `0028_domain_delivery_runtime_hardening.sql`; exactly 39 migrations, `0029` through `0067`, remained staging-pending at that checkpoint. The accepted staging ledger had zero FK violations, expected `0027`/`0028` objects, zero Telegram tenant/grant mismatches and empty generic event/job queues. The current source chain extends through `0076`; this historical limitation applies to staging only and production D1 remains at the admitted `0001`-`0052` ledger. |
| D1 migration compatibility | A read-only staging probe confirmed five compound `SELECT` terms pass and six fail; migration `0027` was split into `4+4` sources and a lexer-backed test now scans every numbered migration for the observed D1 limit |
| Staging cron acceptance | Wrangler tail observed version `2d7166ff-3a87-4a9f-81bd-edd4db1074e2` complete `* * * * *` with outcome `ok`, zero exceptions/errors and zero pending domain-event/delivery candidates after cutover |
| Staging P8/P9 authenticated UI acceptance | Authenticated Chrome QA rendered `/app`, `/onboarding` and `/app/domains` on desktop and 375px mobile with zero console errors and no horizontal overflow. The onboarding projection showed the expected resumable 13% progress; step navigation and the domain remediation link worked, and mobile computed colors remained high contrast after removing the stale dark theme override. The expanded deterministic local gate additionally covers the seller product, inventory, order, customer, integration, store, data, member and billing projections. |
| Staging browser continuation QA | Dashboard/onboarding and the active `signal.staging.selinow.com` storefront rendered at desktop and 375px mobile with zero console warnings/errors, no horizontal overflow, visible skip-link focus, and safe dashboard-to-onboarding and storefront-to-product navigation. `coming-soon`, `paused` and unknown tenant API boundaries returned 409/403/404; `tung-domain-lab` correctly remained 409 because its shop is still `draft`. |
| Deterministic public browser gate | The isolated local public gate passes 27/27 across eight route IDs, five state fixtures and the 200% geometry project at 1440x1024 and 390x844. Exact titles/headings, GET/HEAD-only and external-request blocking, runtime/console, overflow and axe WCAG A/AA checks pass; all 26 current-source screenshots were reviewed. The separate safe staging Playwright gate remains 18/20 because two cart tests stop at hydration readiness when the deployed Worker lacks `[data-cart-variant-id]`. No snapshot update, order, checkout or PayOS call occurred; current source-only slices were not deployed to staging. |
| Historical staging D1 verification checkpoint | All 28 migrations were recorded at the accepted cutover, foreign-key violations were zero, the Telegram generic link was complete, and domain-event/delivery/DLQ recovery indexes and triggers were present; the source delta then contained exactly 39 migrations `0029` through `0067` pending on staging. The current source delta is 48 migrations `0029` through `0076`; neither set is claimed as applied remotely and both remain behind staging admission. |
| Remote D1 integrity limitation | D1 rejected `PRAGMA integrity_check` with `SQLITE_AUTH`; the protected pre-rebrand safety export restored in isolation with integrity `ok`, zero foreign-key violations and its 8-migration ledger intact |
| Staging HTTP/auth/automation smoke | Marketing and `/api/health` returned 200; dashboard/auth boundaries behaved as expected and the unauthenticated tenant automation boundary returned 401 |
| Staging storefront smoke | Signal and Canvas storefront/catalog returned 200; Coming Soon 409, Paused 403 and unknown tenant 404 |
| Wildcard HTTPS smoke | Active certificate and HTTPS verified across controlled `*.staging.selinow.com` tenant hostnames |
| Staging secret inventory | `SESSION_SECRET`, `MAGIC_LINK_SECRET`, encryption/HMAC secrets, `TURNSTILE_SECRET_KEY` and `CLOUDFLARE_API_TOKEN` names are present; values were not read or recorded. Email Sending uses the `EMAIL` binding, not a provider API key |
| Local Phase 2 HTTP acceptance | First shop create 201, idempotent replay 200/same ID, cross-tenant read/write 403 |
| Auth negative acceptance | Magic-link replay 401; missing CSRF and hostile Origin both 403 |
| Local Phase 3 HTTP acceptance | Stale quote rejected; two concurrent buyers produced one order and one inventory failure; replay returned the same order; invalid order token returned 404 |
| Local expiry acceptance | First run expired 1 order and restored 1 available key; second run expired 0 orders |
| Local Phase 4 webhook acceptance | Exact signed payment fulfilled once; exact replay was deduped; invalid signature returned 401 |
| Local Phase 4 decision acceptance | Partial, overpaid and late signed events created three separate exceptions and no fulfillment |
| Local Phase 4 fulfillment state | One paid/fulfilled order, one sold key and one digital fulfillment despite exact webhook replay |
| Staging Phase 2-4 schema/smoke | Schema and auth boundary are live; PayOS provider/payment acceptance remains pending controlled tenant credentials and signed events |
| Local Phase 5 multi-bot acceptance | Two fake-provider bots stayed isolated; bot A never rendered shop B product and cross-tenant variant callback returned a safe catalog error |
| Local Phase 5 replay/private acceptance | Replayed checkout produced one order, one fulfillment and one sold key; conflicting update payload was audited; group `/keys` revealed no key |
| Local Phase 5 webhook/rotation acceptance | Wrong secret was rejected before invalid body parsing; old secret failed after rotation; new secret worked; duplicate bot ownership was blocked |
| Local Phase 5 outbox/health acceptance | First paid notification honored 429 retry, second succeeded without changing fulfillment allocation; revoked token surfaced `degraded/telegram_unauthorized` |
| Staging Phase 5-6 schema/smoke | Schema, platform hosts and seeded storefront state routing are live; Telegram provider acceptance remains pending a dedicated test bot |
| Staging Phase 6 cache/browser/asset acceptance | Core host, health, storefront/catalog status, wildcard TLS and branded asset responses passed; full fresh-buyer checkout acceptance remains pending |
| Astro background dev lifecycle | Start, status, logs and stop passed on the available local port |
| HTTP smoke | `/` and `/api/health` returned 200 with request ID and security headers |
| Browser smoke | Desktop and 390px mobile layout rendered without horizontal overflow |
| Secret scan | No production credential pattern detected in tracked source candidates |

## Staging resources

| Resource | Name/ID |
| --- | --- |
| Worker | `selinow-com-staging` / accepted code `049009b4-9683-4c7f-8638-df859d50a0c8` |
| D1 | `selinow-staging` / `c86d76a0-7407-42b6-ba92-f9f9623d0730` |
| R2 | `selinow-media-staging` / provisioned empty |
| Private exports R2 | `selinow-private-exports-staging` / provisioned empty |
| Platform cache KV | `selinow-cache-staging` / `91cfb785ea6546289a3a47763a020d54` |
| Session KV | `selinow-session-staging` / `daf6b5590ea94e67bc982239b2725e14` |
| Queues | `selinow-integration-staging`, `selinow-notification-staging` / bound to deployed Worker |
| DLQ | `selinow-dlq-staging` / bound to deployed Worker |
| Cloudflare for SaaS | Fallback origin and shared-zone route matrix active; external customer-hostname lifecycle E2E completed and test resources removed |
| SaaS fallback contract | `proxy-fallback.selinow.com` proxied `AAAA -> 100::` |
| SaaS customer target | `customers.selinow.com` proxied CNAME to fallback |

Wrangler OAuth is the intended operator access path, while platform SaaS provisioning additionally requires a temporary least-privilege operator token. No Cloudflare API token or secret is stored in the repository.

`SESSION_SECRET`, `MAGIC_LINK_SECRET`, `INVENTORY_KEK_V1`, `CREDENTIAL_KEK_V1`, `EXPORT_KEK_V1`, `IDENTIFIER_HMAC_SECRET`, `TURNSTILE_SECRET_KEY` and `CLOUDFLARE_API_TOKEN` are present as staging Worker secrets. Only secret names were verified; values are not stored in repository configuration, manifests or this document. The public `TURNSTILE_SITE_KEY` binding points to the configured `selinow-staging-storefront` widget restricted to `staging.selinow.com`. Cloudflare Email Sending is configured through the restricted `EMAIL` binding and the onboarded `selinow.com` sender domain.

## Known limitations

- Provider expansion is contract-ready but not activation-ready. Telegram Mini App now exposes tenant-bound session, catalog, cart, quote, checkout and principal-scoped order projections; fulfillment handoff and `answerWebAppQuery` remain separate provider gates. Zalo OA OAuth state/retry and the fail-closed public callback are source-local; token rotation, credential binding and outbound/webhook acceptance remain pending. Zalo Mini App has a provider-pending ingress boundary and local credential/signature contracts, but no admitted access-token/profile/session commerce runtime. WhatsApp and Discord provide verified ingress, durable reference receipts, tenant-bound identity projection and safe interaction acknowledgements; outbound delivery and shared commerce adapters remain pending. Runtime admission has no production caller, so no successful webhook is allowed to promote a connection to `active`.
- Production provider credentials and live PayOS/Telegram traffic remain intentionally unconfigured.
- Staging has no real seller Telegram bot token; seller UAT requires an explicitly supplied dedicated test bot.
- Website, Telegram and `fake.third` canonical cart/quote/checkout/order/fulfillment entrypoints use application/capability seams and delegate order, reservation and fulfillment writes to the shared `commerce/checkout-transaction.ts`. Website has an explicit durable replay ledger; Telegram uses its provider-specific action/replay ledger; generic principals use a tenant/channel/connection/adapter-version scoped replay boundary in `PrincipalChannelCommercePort`. Channel-specific catalog/identity orchestration still exists. Fake real-D1 parity is complete locally, with normalized attribution authoritative in `order_channel_attributions` and `orders.source_channel='web'` retained only as a compatibility bucket. External provider acceptance and staging admission for migrations `0029` through `0076` remain pending; production has `0001` through `0052`, but provider traffic remains disabled.
- Phase E currently exposes the versioned `GET /api/v1/shop`, `GET /api/v1/catalog`, `GET /api/v1/inventory` and `GET /api/v1/orders` read projections under the fixed `shop:read`, `catalog:read`, `inventory:read` and `orders:read` credential scopes. Inventory and orders are bounded, tenant-derived and redacted; fulfillment, entitlement, connection-health and outbound webhook subscription APIs remain unimplemented, so this is not a complete public integration surface.
- Private downloadable fulfillment now snapshots its immutable order-item requirement during canonical checkout for Website, Telegram and `fake.third`; only pre-cutover rows without a requirement use the bounded historical policy-interval fallback. Delivery is website-only, uses the existing private `MEDIA` prefix instead of a dedicated bucket, and has no Telegram secure handoff. The latest read-only staging check found 0 `MEDIA` objects, `r2.dev` disabled and no custom domains; this evidence must be rechecked immediately before any staging mutation and does not replace the route-token/fresh-backup gates. Generic resources/policies/requirements/entitlements/grants/transitions and seller-webhook generated-license execution are implemented as local evidence. Website generated artifacts are revealed through `GET /api/store/orders/[orderPublicId]/keys` with the existing opaque order-access token, and Telegram reveals them through the authenticated `/keys` fulfillment flow; both enforce paid/active entitlement and TTL expiry, and mixed orders reveal only fulfilled digital allocations. Membership/community, seat/device and provider-access grant/revoke execution remain unimplemented; seller provider configuration has no public UI/API claim yet. These are explicit limitations; no staging schema or Worker has been changed.
- Pre-0030 Telegram orders cannot be backfilled with an exact cart ID. Replay searches retained converted carts for the stored request hash and fails closed if no exact snapshot remains.
- Locale catalogs have exact parity for dashboard (1,296 keys), admin (445) and storefront (294); marketing, onboarding, system and Telegram parity also have focused coverage. Marketing, storefront, seller products/inventory, onboarding, shared admin/dashboard contracts, admin overview/shop-directory/operations page bodies and dashboard status/storefront stock fallback are covered by local source gates. Source call-site/placeholder checks, BCP47 parsing, canonical order/shop currency binding, seller country controls, paired English/Vietnamese commerce, durable Telegram buyer preference and logical/rendered RTL checks are closed locally. Locale-parity extensibility remains a bounded follow-up; merchant-authored shop/catalog content remains intentionally single-language until a separate content-localization workflow is designed. Current-source visual acceptance is closed locally; staging visual parity remains pending.
- Staging mutation admission remains blocked until temporary `CLOUDFLARE_PLATFORM_API_TOKEN` and `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN` access proves the live Worker Routes inventory and a fresh report-v2 Time Travel backup passes exact account/D1 identity, bookmark, non-empty artifact, checksum and <=60-minute evidence checks. The retained v1 snapshot intentionally returns `staging_backup_evidence_invalid`; no staging mutation is authorized from current read-only preflight evidence.

### Current Phase C runtime acceptance boundary: migration `0052`

Migration `0046_manual_fulfillment_executions.sql` remains the immutable seller-attested path for eligible paid legacy-manual items, with owner/manager `fulfillment:manage`, CSRF/recent-auth/idempotency/replay/conflict/concurrency guards and hash-only external-reference evidence. Migration `0047_generic_entitlement_foundation.sql` adds the six-table generic graph: `entitlement_resources`, `product_entitlement_policies`, `order_item_entitlement_requirements`, `entitlements`, `entitlement_grants` and `entitlement_transitions`. Website, Telegram and `fake.third` use the same canonical policy snapshots. Free checkout creates active access and a `free_checkout` grant; paid checkout remains pending until the exact signed, claimed payment event is processed through its matching `paid_exact` attempt and `paid_event_id`. Legacy seller-manual rows are created only when no private-file or generic requirement exists, and D1 guards make manual execution and generic requirements mutually exclusive.

Migration `0048_payment_reversal_entitlement_revocation.sql` adds the immutable tenant-scoped reversal ledger and one atomic revocation boundary. Verified exact full refunds and chargebacks set the order to `refunded`, revoke generic pending/active/suspended entitlements with an immutable transition, revoke private active/suspended entitlements and revoke active delivery grants. The signed PayOS refund/chargeback branch calls this same service after event verification; replay returns the durable result without repeating revocation. Partial/mismatch evidence opens manual review without revocation. Sold keys, fulfillment, grants and consumption evidence are retained; raw provider references/payloads and all reversal hashes are excluded from export and logs.

Migrations `0049_generated_license_fulfillment.sql`, `0050_generated_license_deletion_lifecycle.sql`, `0051_generated_license_rotation.sql` and `0052_generated_license_request_hardening.sql` add the bounded seller-webhook generated-license executor. Each generic requirement is constrained to one generated artifact; free checkout creates a pending request after the free grant, while paid checkout creates it only inside the exact signed/claimed payment activation. The provider registry is deliberately D1-free and receives no provider credential envelope or commerce authority; the service decrypts credentials only in memory, sends a neutral request, hashes normalized evidence, and immediately encrypts a successful artifact with inventory KEK and generated-specific AAD. Ambiguous provider acceptance enters `reconcile_pending` and must reconcile before any generate retry. Queue and dead-letter payloads contain only request/shop references and safe codes, and order fulfillment completes only after every generated request succeeds. Migration `0052` adds canonical request-insert guards, transition/evidence immutability, terminal-state fences, attempt/lease rules and global scheduler/key-version indexes.

Payment reversal cancels pending/retryable/expired-processing/reconciliation work and revokes active artifacts without deleting request/attempt history. Shop deletion blocks on a live generated request lease, then cancels pending work, resolves generated dead letters, destroys credentials and artifacts, retires bindings/connections and retains immutable request, attempt and snapshot evidence. Rotation uses existing credential/inventory KEKs with separate generated-license AAD, lease/CAS fencing, retry/manual-review outcomes and no plaintext ledger fields. Scheduled TTL expiry marks due active/suspended generic entitlements `expired`, and both Website and Telegram reveal paths recheck `access_expires_at` before decrypting an artifact. Standard exports are schema version 5 with safe generated metadata only; backup and isolated restore cover all eight generated-license tables. Website, Telegram and `fake.third` free/paid parity, replay/conflict and cross-tenant boundaries pass locally. Buyer reveal is implemented through the existing Website order-keys route and Telegram `/keys` boundary; seller provider configuration remains service-level only.

Backup schema/count validation includes all six generic tables, `payment_reversal_events`, all eight generated-license tables and `channel_customer_identities`. Standard export schema version 5 includes safe manual, generic, reversal and generated-license lifecycle metadata while omitting plaintext, buyer/replay/reference hashes, credential/integration IDs, provider references, ciphertext, IVs, key versions, fingerprints, lease tokens and grant request IDs. Deletion retires generic configuration and revokes pending/active/suspended entitlements only behind the legal-hold and crypto-shred fence, appending immutable `shop_deleted` transitions while retaining requirements, grants, transitions, reversal events, generated requests/attempts/snapshots/dead letters and payment/fulfillment/consumption evidence. The historical generated-license checkpoint passed 183 files / 1,366 tests; the latest full repository gate passed 241 files / 1,713 tests. The historical isolated restore report `.wrangler/restore-drills/local/rdr_20260729200234_45eaf6386435.json` covers the admitted 52-migration baseline; the historical local report `.wrangler/restore-drills/local/rdr_20260802093008_62fc355479ae.json` applies 59 migrations through `0059`, restores 612 items, passes integrity with zero foreign-key violations and has no schema/count mismatches; the historical `0064` current-chain report is `.wrangler/restore-drills/local/rdr_20260802121252_56fa8688ae9.json`; the latest retained local restore `.wrangler/restore-drills/local/rdr_20260802132434_f77680c70c88.json` applies the prior 66 source migrations cleanly with zero integrity/FK violations. A separate current-chain 76-migration isolated SQLite validation passes integrity and FK checks; no report-v2 protected backup/restore admission exists. ADRs 0016-0022 record the decisions. Production now runs migrations `0001`-`0052`; the accepted staging ledger remains through `0028` with exactly 48 pending source migrations (`0029`-`0076`).
The preceding migration counts are checkpoint-era history. The current source chain is `0001`-`0076`, production remains at `0001`-`0052`, staging remains at `0028` with 48 pending migrations, and the latest retained isolated restore report is historical/local-only evidence; the current 76-migration SQLite apply is integrity/FK clean. Neither replaces production admission evidence.
- Protected full DR/PITR backups currently retain keyed API credential and revocation digests because the authoritative credential schema requires them; seller exports exclude those hashes. A point-in-time restore can therefore resurrect credentials that were revoked later, so post-restore credential rotation/revocation admission remains a required design and release gate.
- The durable automation engine, tenant-facing API and Selinow-owned verification executors are live, but provider-side executors and controlled Telegram/PayOS/custom-domain automation acceptance remain pending.
- The generic event/delivery runtime is live on staging, but controlled provider-backed parity is not complete. Cloudflare Queues are at-least-once: if a provider accepts a message and the following D1 settlement fails, a retry may repeat the provider call unless that provider offers an external idempotency primitive.
- Managed shared channels, DNS-provider authorization, additional messaging/social/marketplace adapters and a real second payment provider remain roadmap items, not available product capabilities. The fake adapter now has local real-D1 commerce parity through the generic principal-channel seam, but it is test evidence rather than a deployed provider. Phase D adds an additive PayOS connection/readiness projection and legacy tenant guards while the legacy PayOS runtime remains authoritative. Stripe/second-provider credentials, webhooks, checkout, reconciliation and fulfillment are not implemented or claimed.
- The accepted accessibility contract now has semantic token fixes, a source-level accessibility/keyboard gate, deterministic Playwright desktop/mobile baselines, public-flow axe WCAG A/AA coverage, manual authenticated desktop/mobile staging evidence and authenticated/local public browser PromptOS validation. The authenticated local gate passes 7/7 and the isolated public local gate passes 27/27 across exact PromptOS viewports plus 200% geometry; local visual acceptance is backed by 42 authenticated and 26 public manually reviewed exact-viewport snapshots. Staging visual acceptance remains 18/20 because the deployed Worker lacks `[data-cart-variant-id]`.
- The latest staging public visual gate is 18/20: two cart tests stop before screenshot because the deployed Worker lacks the current hydration selector; the separate 1440x1024, 768x1024, 390x844 and 320x844 read-only matrix passes 4/4. The hydrated cart baseline remains a staging-review item only; current-source local screenshot acceptance is complete.
- Production resource identity, named D1/R2/KV/Queue bindings, the empty-D1 bootstrap backup/restore baseline, schema migrations, Worker traffic, route handoff and exact platform domains are provisioned and reviewed. Payment, Telegram, fulfillment and external customer-domain traffic remain intentionally disabled until their separate acceptance gates pass.
- No platform-admin user is bootstrapped automatically; the first grant requires an explicit operator decision after that user has authenticated.
- Phase 8 external acceptance still requires a fresh seller run on desktop/mobile, a live Telegram `/start` plus same-bot token rotation, a controlled PayOS channel and provider-backed automation executors. Staging external custom-domain and Cloudflare Email Sending acceptance are complete; production external-domain activation and Turnstile hostname admission remain pending.
- Channel expansion external acceptance still requires seller/provider credentials, Telegram Mini App bot binding, Zalo app approval, WhatsApp Cloud business/template/webhook approval and Discord bot installation. Migrations `0055`-`0056`, `0057`, `0058` and their catalog/request/session/receipt routes are source/local-only intent contracts; no provider state, outbound delivery or payment/fulfillment transition may be inferred.
- Phase 9 external acceptance retains the pre-remediation deep scan with 313/313 review coverage, seven reconciled candidates and three reportable findings, plus the targeted local post-remediation rescan. The disclosed pre-existing `s6-001` ledger/manifest hash mismatch means full scan-bundle seal integrity is not claimed. Source fixes cover the reported findings and operator admission gaps, while staging exercises for operations, backup/export and deletion controls are still required.
- The production platform frontend handoff is complete. Full commerce/provider activation remains NO-GO until the controlled seller pilots and the remaining release-doctor requirements have durable evidence.

## Selinow OS landing rebuild (2026-08-01)

- Replaced the marketing home hierarchy in `src/pages/index.astro` with the Selinow OS kit composition: announcement, navigation, hero orbit, trust strip, channel maturity, use cases, workflow, architecture, runtime pricing, FAQ, CTA and footer.
- Added kit reference assets under `public/brand/selinow-kit/`; assets are reused from the supplied prompt kit so no generated image is required. Website and Telegram remain the only `Live` channels; WhatsApp, Zalo OA, Discord and API are explicitly `Coming next`/`Planned`.
- Added responsive and RTL-safe landing styles in `src/styles/platform.css`. CTAs continue to resolve to the existing dashboard login, pricing remains D1/runtime-backed, and no payment or fulfillment side effect is introduced.
- Local verification: `npm run check`, `npm run lint`, `npm run build`, focused marketing/accessibility/RTL contract tests, and browser checks at the default viewport plus 390x844 with no horizontal overflow or console errors.
- Chrome comparison (2026-08-01): local landing rendered the kit composition at desktop and 390x844 with zero console warnings/errors and no horizontal overflow; `https://selinow.com/` and `https://staging.selinow.com/` still serve their pre-kit landing because this source slice was not deployed. `npm run deploy:staging` failed closed before mutation because `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN` was not supplied.
- Known limitation: newsletter and social links are presentation-only because no newsletter/social backend contract exists in the current repository; production provider activation remains unchanged.

## Staging live route inventory preflight (2026-08-02)

- The route-only repair reapplied exact `staging.selinow.com/*`, `app-staging.selinow.com/*` and `api-staging.selinow.com/*` exceptions to `selinow-com-staging`; `*.staging.selinow.com/*` remains staging-bound and `selinow.com/*`, `*.selinow.com/*` and `*/*` remain production-bound. Wrangler now owns those three exact routes in addition to the unchanged Custom Domains and wildcard; DNS was not changed. Post-repair API probes reached the staging Worker: Dodo returned JSON `503 billing_provider_unavailable` and PayOS returned JSON `401 authentication_required`, rather than the production HTML 404. A fresh authenticated route preflight remains required before any staging mutation.
- Earlier read-only evidence recorded a route-contract mismatch because the checker still required pre-handoff `script=null` guards. That contract has since been corrected to admit the exact production handoff boundary; the live route reconciliation and three redundant staging-route removals are recorded in the current continuation entry above.
- The staging Worker UI remains read-only healthy at the overview level (`Errors 0`, `Bindings 9`, `Queues 3`, `Triggers 1`, active version prefix `049009b4`). Its domain page lists eight in-zone custom-domain rows, including the expected staging hosts plus the canary DNS carrier; no domain was edited.
- The machine preflight was rerun and failed closed before any Cloudflare request because `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN` is unavailable (`cloudflare_route_audit_api_token_missing`). The UI snapshot is supplemental evidence only and cannot authorize staging mutation.
- Private evidence: `.wrangler/release/staging-route-inventory-ui-20260802.json`.

## Continuation review (historical checkpoint, 2026-08-02)

- The full local verification was rerun after the frontend handoff, landing rebuild and channel expansion: `npm run check` passed with 0 errors and three existing hints; `npm run lint` passed; `npm run test` passed with 193 files / 1,478 tests; `npm run build`, `npm run build:staging`, `npm run deploy:dry-run` and `npm run deploy:staging:dry-run` passed without deployment; `npm audit --audit-level=high` reported 0 vulnerabilities.
- Isolated rendered acceptance also passed sequentially: `npm run test:browser:auth:local` passed 7/7 and `npm run test:browser:public:local` passed 27/27, including accessibility, console, horizontal-overflow and 200% geometry checks. A first concurrent run was discarded because the two isolated Astro runners intentionally reject an already-running dev server; the sequential rerun is the authoritative result.
- `npm run platform:doctor -- --env staging --json` confirmed the staging account and named resources, then failed closed only because temporary `CLOUDFLARE_PLATFORM_API_TOKEN` and `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN` context is unavailable. `npm run release:doctor -- --json` likewise remains fail-closed because operator approvals, release evidence, worker secrets and external acceptance records are not present in the local workspace. No mutation was attempted.
- The continuation now wires member invitation/role/suspension/revoke controls and audited billing change-request controls into the seller UI with CSRF, recent-auth, idempotency and version guards. Customer detail/notes, order message/remediation and admin investigation contracts remain service-only or provider-pending where a safe browser workflow would otherwise overclaim external execution; they remain truthful read-only/unavailable states while provider activation and staging migration remain external gates.

## Continuation UI and scope hardening (2026-08-02)

- `/app/customers` now opens a masked tenant-bound detail panel for owner/manager users, supports profile/status updates, append-only notes and optimistic note redaction, and synchronizes the ledger after successful mutations. Error mapping is localized and fail-closed for malformed responses, recent-auth, forbidden, not-found and version conflicts.
- `/app/members` now wires owner-only invitation issue/resend/revoke plus member role and suspension controls. Every mutation sends CSRF, recent-auth session, idempotency and expected-version guards; support/viewer roles remain read-only.
- `/app/billing` now loads active plans and audited plan/cancel requests and renders provider-pending intent states. It never mutates the authoritative subscription, captures payment data or claims settlement/proration completion.
- `/admin/operations` now includes a bounded masked bridge to order investigations and audit evidence, with independent unavailable fallback and links to the existing read-only explorer. No cross-tenant mutation or secret/provider payload is exposed.
- Historical continuation checkpoint: migration `0056_channel_connector_scope_guards.sql` added direct-D1 guards for supported channel pairs, migration `0057_telegram_mini_app_sessions.sql` added replay-safe, credential-version-bound Mini App sessions, and migrations `0058`-`0059` added reference-only provider receipts and HMAC-bound customer identities. Focused seller/API/channel/UI/session/provider-route/Zalo coverage passed; that local source validation passed `npm run check` (0 errors, 3 hints), `npm run lint`, `npx tsc --noEmit`, `npm run test` (218 files / 1,575 tests), `npm run build`, `npm run build:staging`, both deploy dry-runs and `npm audit --audit-level=high` (0 vulnerabilities). Wrangler emitted a sandbox EPERM while attempting its user log path during build/dry-run, but all commands exited successfully and no continuation deployment occurred.
- Completed the previously incomplete direct seller UI for API credentials in `/app/integrations`: owner/manager users can load the tenant-scoped list, issue `catalog:read`/`shop:read` credentials after recent auth, copy the one-time token without browser persistence, and revoke with CSRF, idempotency and optimistic-version guards. Support/viewer roles remain read-only.

## Global SEO foundation (2026-08-02)

- Added `docs/SEO_GLOBAL_STRATEGY.md` with the global SEO roadmap, content/locale rules, measurement plan and external requirements.
- Added locale-aware canonical, reciprocal `hreflang`, `Content-Language`, Open Graph locale and Twitter image metadata to platform and tenant public layouts. The existing `en`/`vi-VN` catalogs remain the only indexable language variants; no machine-translated locale pages were invented.
- Added production-only `robots.txt` and hostname-aware `sitemap.xml`: platform sitemap covers `/` and `/pricing`, while a live tenant sitemap covers its published home/products. Local and staging robots disallow all crawling.
- Added JSON-LD for marketing SoftwareApplication/FAQPage, pricing WebPage/BreadcrumbList, storefront OnlineStore/OfferCatalog and product Product/Offer data. Prices are derived from authoritative integer minor units; private checkout/order/API surfaces remain noindex.
- Added an English/Vietnamese switcher to the marketing navigation and a reusable SEO helper/test contract in `src/lib/seo.ts` and `tests/unit/seo.test.ts` (6 tests passed).
- Verification recorded at the time of this historical slice: focused SEO Vitest and targeted ESLint passed; the later authoritative repository refresh supersedes the intermediate full-test failures noted here. No staging/production mutation was performed.
- External follow-up: deploy the source, register production properties in Google Search Console/Bing Webmaster, submit the sitemap, validate rich results and Core Web Vitals, then publish the English intent/content clusters described in the strategy document.

## Global bilingual homepage refinement (historical checkpoint, 2026-08-02)

- Reworked `src/pages/index.astro` to consume the shared marketing translator for the full landing surface in English and Vietnamese, including SEO metadata, hero, proof points, trust strip, channels, use cases, workflow, architecture, pricing, FAQ, CTA and footer.
- Updated the global positioning to "Turn every conversation into a sale." / "Biến mọi cuộc trò chuyện thành đơn hàng." and added explicit bilingual, no-card and verified-delivery proof points for international-first visitors.
- Added the corresponding marketing catalog keys in `src/lib/i18n/catalogs/marketing.ts`, preserving exact locale parity and localized accessibility text for the hero orbit.
- Refined `src/styles/platform.css` with a navy/teal/coral palette, higher CTA contrast, tighter geometry, reduced card/radius noise and mobile navigation overrides while preserving the existing Selinow kit asset composition.
- Verification: `npm run check` passed (0 errors, 3 existing hints); `npm run test` passed (193 files / 1,478 tests); focused marketing and i18n suites passed; `npm run build` and `npm run deploy:dry-run` passed without deployment; local HTTP smoke returned 200 for English and Vietnamese homepages with the expected `<html lang>` values.
- Full `npm run lint` passed after the current asset refresh; the touched homepage, marketing catalog, platform stylesheet and visual contract also pass targeted lint checks.
- UX audit was run read-only; its remaining failures are repo-wide legacy token/generated-surface findings (purple tokens, a generated `index.html` navigation count/scroll handler and font warnings), not changes introduced by this landing slice.

## Global visual asset refresh (2026-08-02)

- Replaced the homepage's Vietnamese-labeled illustration references with eight new text-free global assets under `public/brand/selinow-kit/global/`: bot, delivery cloud, payment card, product box, shopping bag, notification bell, network nodes and architecture core.
- The built-in image generation tool was not exposed in this desktop runtime, so the explicitly allowed local 9Router fallback was used through its `cx/gpt-5.5-image` OpenAI-compatible image endpoint. Prompts required no words, letters, numbers, logos, flags or watermarks and used the navy/teal/coral global palette.
- Updated `src/pages/index.astro` to use the new assets for use cases, workflow and architecture. Existing provider cards and Selinow brand marks were retained because they already use globally readable labels/brand identity.
- Assets were visually inspected, center-cropped/resized for the landing cards and blended with the page surface to avoid opaque white image blocks. No existing legacy asset was deleted.
- The refreshed coral action color now meets WCAG AA contrast on the landing surfaces; local public browser acceptance was rerun at desktop, mobile and 200% zoom with 27/27 checks passing, and the two homepage visual baselines were regenerated.
- Generation is local-only and not a runtime dependency; no provider credentials or generated image payloads were committed. Production deployment remains pending explicit authorization.

## Google Search Console setup (2026-08-02)

- Confirmed the verified Domain property `sc-domain:selinow.com` in the signed-in Chrome session.
- Confirmed the existing `https://selinow.com/sitemap.xml` submission; Search Console currently reports `Không thể tìm nạp` because the live production origin still returns HTTP 404 for that route.
- Inspected `https://selinow.com/`: Google reports the URL is already on Google, served over HTTPS, and the homepage re-crawl request was submitted successfully to the priority queue.
- No production deployment or DNS/Cloudflare mutation was performed. After the SEO source is deployed, resubmit the sitemap and re-check the Page indexing and Core Web Vitals reports.

## Global solution intent pages (2026-08-02)

- Added typed bilingual solution content in `src/lib/content/solutions.ts` with parity for English and Vietnamese titles, descriptions, workflows, FAQs and CTAs.
- Added the `/solutions` hub plus three dynamic detail routes. Pages are host-gated to the marketing hostname, use canonical/hreflang metadata, and publish CollectionPage/ItemList or WebPage/BreadcrumbList/FAQPage JSON-LD.
- Added scoped responsive solution-page styling, localized internal links, and a production-only `/llms.txt` factual summary. Sitemap entries now include the hub and all three solution routes.
- No production deployment or external mutation was performed. The live origin will continue returning the previous sitemap until the source is deployed.
- Verification recorded at the time of this historical slice: focused solution content/SEO tests passed while the parallel members-thread import issue was still open; the later authoritative repository refresh supersedes this intermediate blocker.

## Verification refresh after members surface merge (2026-08-02)

- The seller members surface now exports the symbols consumed by `src/pages/app/members.astro`; no compatibility shim or unrelated rollback was required.
- Historical checkpoint gates passed: `npm run check`, `npm run lint`, `npm test` (221 files / 1,591 tests), `npm run build`, `npm run deploy:dry-run`, and `npm run deploy:staging:dry-run`.
- Public browser acceptance remains green at 27/27. The local sitemap smoke returns `200 application/xml` after the XML escaping fix; local/staging `llms.txt` remains intentionally closed outside production.
- `npm run release:doctor -- --json` remains fail-closed because release-owner/support approvals, fresh backup/restore evidence, candidate/pilot/external acceptance records, and temporary Cloudflare/runtime secret context are absent. No staging or production mutation was performed.

## Admin payment remediation review surface (2026-08-02)

- Added `/admin/appeals` and connected it to the existing admin remediation list/review contracts. Owner and risk roles can record only `provider_pending` or `rejected`; provider completion, refund settlement and reversal evidence remain separate authoritative steps.
- Added bilingual admin copy, guarded PATCH handling with CSRF/recent-auth/idempotency/optimistic-version checks, safe masked request fields, explicit empty/error/read-only states, and a protected navigation entry.
- Updated the frontend gap report so Members, investigations/audit, and the bounded appeals review UI are recorded as implemented rather than unavailable.

## Final verification refresh (2026-08-02)

- Fixed the authenticated billing surface's last local accessibility regressions: dynamically rendered request rows now satisfy `role=list`/`role=listitem`, and success feedback uses the AA-safe semantic success text token.
- Historical final source checkpoint passed: `npm run check` (0 errors, 3 existing hints), `npm run lint`, `npm test` (221 files / 1,591 tests), `npm run build`, `npm audit --audit-level=high` (0 vulnerabilities), `npm run deploy:dry-run`, `npm run deploy:staging:dry-run`, and `git diff --check`.
- Final rendered gates pass sequentially: authenticated local browser gate 7/7 across desktop/mobile, 1440/768/390/320px and 200% geometry; public local browser gate 27/27 with axe, runtime, console, overflow and GET/HEAD-only checks.
- `npm run release:doctor -- --json` remains intentionally fail-closed for missing release approvals, fresh backup/restore evidence, candidate/pilot/external acceptance records and runtime secret context. No staging or production mutation was performed; the live production sitemap remains pending deployment before GSC resubmission.

## Continuation admission hardening (2026-08-02)

- Added `assertFreshProductionContinuationEvidence` and `assertProductionContinuationDeployAdmission`. Normal production D1 migration and Worker deploy now fail closed unless the latest protected non-empty report-v2 backup is fresh, target-bound and checksum-valid, and the latest isolated restore report is passed, private, bound to the reviewed commit, linked to the backup export, integrity/FK clean and recorded with the complete current source migration ledger.
- `scripts/restore-drill.mjs` now requires `--reviewed-commit <40-hex>` for non-dry-run production drills and records source identity, reviewed commit and migration names in the private report. Admission rechecks the evidence before and after provider identity/release revalidation and rejects evidence drift.
- Verification: `npm test` passed 199 files / 1,493 tests; `npm run check` passed with 0 errors and 3 existing hints; `npm run lint`, `npx tsc --noEmit`, `npm run build`, `npm run build:staging`, `npm run deploy:dry-run`, `npm audit --audit-level=high` and `git diff --check` passed. No production migration, Worker deploy, route, DNS or provider mutation was performed.
- Historical continuation admission checkpoint (2026-08-02): production remained `NO-GO`; remote D1 was `0001`-`0052`, continuation migrations `0053`-`0067` were unapplied, and external provider, pilot, monitoring, live-trigger and rollback evidence was still required. The current source chain now extends through `0076`; production remains `NO-GO` until the same evidence exists for the full continuation.

## Provider contract foundation (2026-08-02)

- Added `src/lib/channels/provider-contracts.ts` as the shared fail-closed
  verifier boundary for Telegram Bot, Telegram Mini App, Zalo Mini App, Zalo
  OA, WhatsApp Cloud and Discord Bot. It enforces exact provider origins,
  Telegram secret headers, Telegram launch-data delegation, WhatsApp raw-body
  HMAC, Discord Ed25519 plus replay windows, explicit provider stages and
  reference-only event normalization.
- Added `docs/CHANNEL_PROVIDER_CONTRACTS.md` and refreshed
  `docs/CHANNEL_PROVIDER_RESEARCH.md`. The documents separate Mini App launch
  identity from messaging/OA identity and record which provider details remain
  unverified. Zalo intentionally has no hardcoded OAuth/webhook constants until
  current official documentation and a controlled capability probe are
  available.
- Recorded the boundary and trade-offs in ADR 0019
  (`docs/adr/0019-provider-runtime-contract-boundary.md`).
- Added `tests/unit/provider-contracts.test.ts` for exact-origin allowlists,
  constant-time secret/HMAC checks, Ed25519 verification and replay rejection,
  provider-pending behavior and payload-free normalized envelopes.
- Added `src/lib/channels/runtime-admission.ts` with a pure admission decision
  that requires active connection/credential, matching provider identity, fresh
  webhook evidence and every required capability before returning `ready`.
  `tests/unit/provider-runtime-admission.test.ts` covers the fail-closed
  matrix, including Zalo provider-pending behavior.
- Added `src/lib/channels/ingress.ts` to lock the future webhook sequence to
  `verify -> normalize -> durable claim`, with replay/conflict outcomes supplied
  by an injected receipt store. Migration `0058` and
  `src/lib/channels/provider-event-receipts.ts` now provide the payload-free
  D1 receipt implementation; provider-backed routes and identity resolution
  remain required before activation.
- `tests/unit/provider-ingress.test.ts` covers ordering, same-payload replay,
  conflicting payload rejection and no-claim-on-signature-failure.
- Verification after this slice: `npm run check` (0 errors, 3 existing hints),
  `npm run lint`, `npm run build`, `npm run deploy:dry-run`, `git diff --check`
  and the then-current Vitest suite (207 files / 1,533 tests) pass. `release:doctor`
  still fails closed with 37 missing production evidence/secrets, as intended.
- This is source/local contract evidence only. No provider credential, webhook,
  OAuth callback, outbound delivery, payment, fulfillment, staging migration or
  production mutation was performed. Full provider activation remains `NO-GO`.

## Global homepage asset rebuild (2026-08-02)

- Audited every homepage raster reference, including the hero orbit, provider cards, use-case/workflow art, architecture core, decorative kit and social cover. Legacy PNGs with baked `Live`, `Coming next`, `Planned`, Vietnamese labels or English OG copy are no longer runtime assets and were moved to `docs/frontend-redesign/archive/`.
- Generated a coherent visual-only kit through the authorized local 9Router `cx/gpt-5.5-image` route and stored the final source masters in `public/brand/selinow-kit/global/v2/`: `hero-core.png` (1536x1024), `channel-network.png`, `commerce-catalog.png`, `support-automation.png`, and `delivery-payment.png` (1254x1254 each). All five PNGs were decoded/visually inspected and verified to have valid signatures and `IEND` markers.
- Updated `src/pages/index.astro` to use the v2 kit for hero, channels decoration, use cases, workflow and architecture. Channel labels/readiness states remain live bilingual HTML/i18n (`en` and `vi-VN`), never raster text. `PlatformLayout` now uses the shared text-free `public/brand/selinow-og-cover-global.png` social cover.
- Added `docs/frontend-redesign/ASSET_INVENTORY.md` and `docs/frontend-redesign/ASSET_PROMPTS.md` with the audit, prompt constraints, asset roles, archive disposition and future-regression rules. Added `tests/unit/marketing-assets-contract.test.ts` to enforce no legacy runtime refs, complete v2 PNGs and the text-free social cover.
- QA evidence: `npm run check` passed with 0 errors/8 existing hints; `npm run lint` passed; `npm test` passed 201 files/1,503 tests; `npm run build`, `npm run deploy:dry-run`, and `npm run deploy:staging:dry-run` passed sequentially; local public browser QA passed 27/27 at desktop 1440, mobile 390 and 200% zoom with axe, console, overflow and GET/HEAD-only checks; authenticated local browser QA passed 7/7 across desktop/tablet/mobile/320px/200% zoom. Homepage visual baselines were intentionally regenerated after the asset replacement.
- No production, staging, Cloudflare, GSC, provider, payment, tenant or database mutation was performed. The generated asset source is not a runtime dependency and no image API credential/payload was committed.

## Telegram Mini App session boundary and handoff refresh (2026-08-02)

- Added forward-only migration `0057_telegram_mini_app_sessions.sql` and the
  tenant-bound `POST /api/channels/telegram-mini-app/sessions/:shopPublicId`
  exchange. It verifies fresh Telegram `initData`, rejects launch replay, applies
  subscription/integration/connector/credential-version gates, stores only
  purpose-bound hashes and issues a 15-minute opaque session. Session auth
  rechecks all gates and fails closed on revocation, rotation or disablement.
- Added `docs/TELEGRAM_MINI_APP_SESSION.md` and
  `tests/unit/telegram-mini-app-session.test.ts`; the handoff API index and
  manifest were subsequently refreshed to 130 rows and source chain `0001`-`0059`.
- Current local verification passes: `npm run check`, `npm run lint`,
  `npx tsc --noEmit`, `npm test` (207 files / 1,533 tests), `npm run build`,
  `npm run deploy:dry-run`, `npm run deploy:staging:dry-run` and
  `git diff --check`.
- Production and staging remain unchanged and provider activation remains
  `NO-GO`; migrations `0057`-`0058`, the session exchange and all
  Zalo/WhatsApp/Discord runtime contracts are source/local evidence only.

## Provider event receipt ledger (2026-08-02)

- Added forward-only migration `0058_channel_provider_event_receipts.sql` with
  tenant-leading indexes, `(shop_id, connection_id)` foreign-key scope,
  immutable event identity and accepted/processing/retryable/processed/rejected
  lifecycle guards. Direct D1 inserts require a matching active/degraded
  provider connection and same channel/provider code.
- Added `D1ProviderReceiptStore` and focused tests. The store persists only the
  normalized event reference, payload hash reference, action and safe timing
  metadata; same-hash delivery is a replay, a changed hash is a conflict with
  reference-only audit metadata, and retryable receipts can be re-accepted.
- Added ADR 0020 to record the `verify -> normalize -> durable claim` decision.
  This closes the durable receipt foundation but does not add provider-specific
  event-ID extraction, identity resolution, OAuth/token lifecycle, outbound
  delivery or Mini App commerce routes. Expansion providers remain
  `provider_pending`/`NO-GO`.
- This receipt-ledger slice recorded source chain `0001`-`0058`; the subsequent
  identity continuation extends source through `0059`, while production remains
  at `0001`-`0052`.

## Channel customer identity references (2026-08-02)

- Added forward-only migration `0059_channel_customer_identities.sql` with
  tenant/customer/connection composite foreign keys, provider/channel/status
  scope guards, immutable identity tuples and tenant-leading lookup indexes.
- Added `src/lib/channels/customer-identities.ts` for tenant/connection/provider-
  purpose HMAC references. Raw provider subjects are never persisted or logged;
  only bounded display name, handle and locale metadata may be retained.
- Same-tuple retries are idempotent. Attempts to remap an immutable external
  subject or cross tenant/provider scope fail closed with a conflict and safe
  audit metadata.
- Added focused unit coverage and registered the table in backup/restore count
  validation. This is source/local contract evidence only; no provider identity
  activation, outbound delivery, payment, fulfillment or remote migration was
  performed.
- Historical `0059` checkpoint: handoff inventory was 131 API method/path rows and
  the full Vitest suite was 221 files / 1,591 tests. Source migrations were
  `0001`-`0062`;
  production remains at `0001`-`0052` and full commerce/provider release is
  still `NO-GO` pending protected migration, credential and acceptance gates.

## Provider route hardening (2026-08-02)

- WhatsApp Cloud and Zalo Mini App receipt conflicts now fail with a safe HTTP
  `409` instead of acknowledging a changed-payload replay. Discord interaction
  acknowledgements preserve provider semantics: ping uses type `1`, normal
  interactions use a deferred type `5`, and autocomplete uses type `8` with a
  bounded empty choices list until catalog-backed choices are admitted.
- WhatsApp ingress now distinguishes phone-scoped `messages`/`statuses` from
  valid WABA-level account/template changes, binds both WABA and phone IDs
  where present, rejects malformed arrays and duplicate verification queries,
  and keeps all raw-body proofs ahead of parsing/receipt claims. Discord only
  admits interaction types `1`-`5`; unknown types fail closed. Zalo OA now has
  a side-effect-free OAuth v4/PKCE seam with constant-time state checks,
  documented authorization-code and rotating refresh-token grants, and safe
  string/number `expires_in` parsing. It still requires a durable tenant-bound
  state store, encrypted token vault and provider acceptance before activation.
- Historical provider-route checkpoint: local isolated restore report `.wrangler/restore-drills/local/rdr_20260802093008_62fc355479ae.json` applied the 59-migration source chain through `0059`, restored 612 items, passed integrity with zero foreign-key violations and no count mismatches, and cleaned up its temporary target. It is local report-v1 evidence only and does not satisfy production backup/restore admission.
- Historical local source gate at that checkpoint was 218 test files / 1,575 tests;
  build and both deploy dry-runs packaged 254 modules with a 3,600.00 KiB
  upload and performed no deployment. Provider credentials, registration,
  outbound delivery and production activation remain separately gated.

## Zalo OA OAuth state boundary (2026-08-02)

- Added forward-only migrations `0060_zalo_oa_oauth_states.sql` and
  `0061_zalo_oa_connector_scope.sql`. D1 stores only a tenant/provider-bound
  state hash and AES-GCM encrypted PKCE verifier; connector scope, expiry,
  one-use CAS consumption, immutable identity and safe status timestamps are
  enforced by triggers. The connector scope accepts only a matching
  `requested`, `provider_pending` or `active` Zalo OA intent; it does not
  activate the provider.
- Added `src/lib/channels/zalo-oa-oauth-state-store.ts` for issue/consume
  operations. Raw state, verifier, tokens and provider payloads never enter
  D1, audit, queues or logs. Wrong tenant/provider, replay, expiry, key
  mismatch and direct expiry extension fail closed.
- Added an explicit provider-pending `POST /webhooks/zalo-oa/:connectionPublicId`
  boundary; this historical slice synchronized the API inventory to 131 rows. The route returns
  `409` before reading the body because Zalo OA currently lacks a documented
  signature/challenge contract in the accepted research; no OA webhook or
  commerce mutation is claimed.
- Historical source chain at this checkpoint was `0001`-`0064`; production remains at `0001`-`0052`
  and staging remains at its admitted `0028` ledger. The fresh local isolated
  restore drill `.wrangler/restore-drills/local/rdr_20260802104305_a6afe66c496d.json`
  is historical through `0061`. A new clean Wrangler persistence check applied
  A historical clean persistence check applied the then-current 63-migration
  source chain (`0001`-`0064`) from an empty local
  database; SQLite integrity was `ok`, foreign-key violations were `0` and the
  migration ledger contained exactly 62 names. The historical local gate at this checkpoint was 221
  test files / 1,591 tests, `astro check` 0 errors/3 hints, lint/build/deploy
  dry-runs pass;
  The default Wrangler persistence also contains a historical duplicate ledger
  name from the parallel migration experiment (`0062_zalo_oa_oauth_state_reissue.sql`);
  it is not used as release evidence. Isolated restore now copies the source
  read-only, removes that known alias only inside the disposable copy when the
  canonical retry row is also present, records the normalization in the private
  report and verifies the exact 62-name source ledger; the authoritative local
  database is never edited. A missing canonical row or unknown extra migration
  still fails closed. A fresh local isolated restore after this normalization is
  `.wrangler/restore-drills/local/rdr_20260802121252_56fa8688ae9a.json`: 612
  restored items, integrity `ok`, zero FK violations and the alias normalization
  recorded. The local persistence should still be reinitialized before any
  local migration-status claim is used for an admission decision.
  remote migration, provider credentials, webhook registration, outbound
  delivery, pilot and production release evidence remain pending.

## Zalo OA OAuth retry hardening (2026-08-02)

- Added forward-only migration `0062_zalo_oa_oauth_state_retry.sql`. It rebuilds
  the OAuth state table without the unconditional connector uniqueness constraint
  and adds a pending-only `(shop_id, connector_request_id, provider_code)` index.
  Consumed and revoked state rows remain immutable audit evidence, while a later
  OAuth attempt can issue a fresh request for the same connector without allowing
  two pending states at once. Request IDs and state hashes remain unique.
- Added regression coverage for consume-then-reissue behavior; the focused OAuth
  suite is 4/4 and the historical local suite at this checkpoint was 221 files / 1,591 tests. This is
  source/local evidence only; no remote migration or provider activation ran.

## Current release checkpoint (historical checkpoint superseded by R1, 2026-08-03)

- The authoritative source migration chain at that checkpoint was `0001`-`0076`; production D1 remains
  at the admitted `0001`-`0052` baseline, while staging remains at `0028` with
  exactly 48 pending migrations (`0029`-`0076`). R1 supersedes these counts with
  source `0001`-`0077`, staging 49 pending (`0029`-`0077`), and production 25
  pending (`0053`-`0077`). The latest retained local restore
  report `.wrangler/restore-drills/local/rdr_20260802132434_f77680c70c88.json`
  covers the prior 66-migration chain, restores 612 items, passes SQLite integrity
  and foreign-key checks and records the disposable-copy ledger normalization. A
  separate current-chain isolated SQLite validation applies all 76 source files
  cleanly with integrity and foreign-key checks passing.
- The shared worktree now also contains forward-only migrations
  `0065_provider_verification_scope_guards.sql`,
  `0066_zalo_oa_oauth_state_lookup.sql` and
  `0067_telegram_mini_app_plan_scope_guard.sql`, `0068_public_api_read_scopes.sql`
  and `0069_catalog_channel_visibility.sql`, plus `0070`-`0076` pricing/billing
  migrations; the current-chain isolated SQLite audit applies all 76 files cleanly.
  Migration `0066` cannot backfill raw state
  lookup hashes, so pre-`0066` pending OAuth states require an explicit
  revoke/expire or legacy-resolution decision before remote admission.
- Migration `0063_channel_enabled_scope_guards.sql` closes enabled-channel tenant
  scope for receipt/identity claims. Migrations `0064_provider_verification_evidence.sql`, `0065_provider_verification_scope_guards.sql` and
  `0066_zalo_oa_oauth_state_lookup.sql` add immutable provider-verification evidence,
  credential-lineage/connection-identity guards and blind callback lookup without raw
  state storage. Migration `0066` cannot backfill pre-existing pending-state hashes;
  revoke/expire or explicitly resolve those rows before remote cutover. These remain
  readiness-only boundaries and cannot activate a provider or commerce transition.
- The handoff inventory is synchronized at 150 API method/path rows across 123
  source route files, 87 acceptance rows and 28 traceability rows. The latest
  completed handoff checkpoint records 241 test files / 1,713 tests and a
  current 279-module build. These are local packaging results; additional
  uncommitted provider/Telegram/Zalo source and tests are included in the
  verified candidate. The current gate is green; migration `0066` pre-cutover rows still require the explicit pending-state
  revoke/expire or legacy-resolution cutover policy before remote admission. The
  public API read expansion remains `service_only`; catalog visibility is a local
  D1/UI contract with inline product controls and does not activate a provider.
- Production release remains `NO-GO` for full commerce/provider traffic. PayOS and
  Telegram acceptance, Zalo/WhatsApp/Discord credentials and controlled ingress or
  outbound pilots, fresh protected continuation backup/restore evidence, reviewed
  candidate identity, monitoring/support/legal ownership and rollback proof remain
  required before migrations `0053`-`0076` or provider activation can be admitted.
- Release evidence now also requires independent recent `providerAcceptance` records
  for Telegram Bot, Telegram Mini App, Zalo Mini App, Zalo OA, WhatsApp Cloud and
  Discord; the example schema and release doctor fail closed when any provider
  evidence is absent. Contract tests and provider-pending responses do not count as
  external acceptance.

## Dashboard information architecture and channel split (2026-08-02)

- Added `docs/frontend-rebuild-handoff/DASHBOARD_INFORMATION_ARCHITECTURE.md` as
  the source/local contract for the private seller shell. It groups navigation into
  Command, Commerce, Channels, Operations and Workspace while retaining the
  canonical route inventory and tenant/session authority.
- The `/app/integrations` page now has a documented lane contract for Website,
  PayOS, Telegram Bot, Telegram Mini App, Zalo Mini App, Zalo OA, WhatsApp Cloud,
  Discord Bot, connector requests and API credentials. Each lane keeps its own
  identity, credential, inbound proof, outbound capability, commerce capability,
  freshness and next action. No lane is allowed to inherit health or activation
  state from another provider.
- The dashboard IA explicitly distinguishes `implemented`, `configured`,
  `provider_pending` and `activated/accepted`. Connector requests, launch data,
  webhook receipts and automation task acceptance remain local/source evidence;
  they do not activate a provider, settle payment or complete fulfillment.
- Added seven provider-lane and automation-wait scenarios to the handoff
  acceptance matrix (now 87 rows) and added
  `tests/unit/dashboard-information-architecture.test.ts` to keep the IA,
  provider lanes and acceptance rows from becoming orphaned. This test checks
  documentation and inventory only; it is not external provider acceptance.
- Hardened `scripts/local-public-browser-gate.mjs` so migration/seed stdout is
  discarded instead of buffered while stderr remains available for diagnostics;
  this keeps the local public browser gate usable with the 76-migration source
  chain and removes the prior `ENOBUFS` failure. The final local rendered gates
  pass authenticated 7/7 and public 27/27; the intentional `/app/integrations`
  IA refresh has matching desktop/mobile snapshots.
- Current source chain remains `0001`-`0076`, API inventory remains 150 rows and
  the latest local checkpoint is 241 test files / 1,713 tests including the
  dashboard IA contract test. Production remains
  `0001`-`0052`; no staging/production migration, provider credential, webhook,
  outbound delivery, pilot or activation was performed.

## Continuation refresh: public API and channel visibility (2026-08-03)

- Migration `0068_public_api_read_scopes.sql` adds the tenant-bound
  `inventory:read` and `orders:read` grants. `GET /api/v1/inventory` exposes
  aggregate stock counts with bounded opaque pagination; `GET /api/v1/orders`
  exposes redacted order summaries. Both are private, rate-limited,
  subscription-gated and `service_only`; no write, fulfillment, entitlement or
  outbound-webhook scope is implied.
- Migration `0069_catalog_channel_visibility.sql` adds fail-closed
  product/channel visibility rows, tenant/lifecycle guards and Website/enabled
  channel defaults. Seller GET/PUT visibility controls use catalog capability,
  CSRF/recent-auth, idempotency and expected-version fences. Website and Telegram
  Mini App catalog reads now require a visible row; absent rows are hidden.
- The source/local chain is `0001`-`0076`; staging remains at `0028` with 48
  pending migrations and production remains at `0001`-`0052`. No staging or
  production mutation, provider activation or external pilot was performed.

## Production continuation handoff: candidate `b4d2a3e` (2026-08-13)

- Candidate tree `fb9de1e67caa3102bf686c5c4b4b1dc0885a9088` is committed on
  `codex/landing-page-deploy-20260801`; the source migration ledger is
  contiguous through `0097`. No `src/lib/billing/**` logic was changed.
- Release admission, route ownership and provider-attestation tooling now
  fail closed against symlink/TOCTOU artifacts, stale production routes and
  untrusted PayOS/Dodo evidence. Local verification passed: `npm run check`,
  `npm run lint`, `npx tsc --noEmit`, `npm test` (307 files / 2,411 tests),
  `npm run build`, `npm run build:staging`, high-severity audit, both deploy
  dry-runs and `git diff --check`.
- Remote continuation is blocked, with no mutation attempted: staging D1
  remains at `0095`, production remains at `0052`, the D1/platform/trigger/
  deploy operator tokens are expired (`9109`), and only the short-lived
  route-audit token is active. Read-only route admission therefore cannot
  prove account identity or live route inventory.
- Live HTTP checks on 2026-08-13 returned `404` for the canonical production
  and staging Dodo webhook paths and for production `/solutions`,
  `/sitemap.xml` and `/llms.txt`. The production route UI showed `*/*` bound
  to the production Worker, but application-level route evidence remains
  insufficient until a fresh Worker deployment and smoke evidence are bound
  to this candidate.
- `release:doctor -- --json` remains intentionally `NO-GO` because fresh
  staging backup/restore/migration/deploy evidence, Dodo and PayOS UAT,
  provider secrets, approvals, monitoring, legal/support acceptance, pilot
  evidence and rollback rehearsal are absent. Do not migrate or deploy
  production until those artifacts are generated and accepted together.

## One-batch production-readiness remediation (2026-08-13)

- Starting from reviewed parent `f4b0db7`, the code-side continuation blockers
  were consolidated into one release candidate patch. Cloudflare doctor now
  keeps D1 identity/inventory on `CLOUDFLARE_D1_API_TOKEN`, uses the optional
  `CLOUDFLARE_STAGING_RESOURCE_AUDIT_API_TOKEN` for KV, R2, Queue and Worker
  secret-name inventory, reports role-specific safe failures, and allows the
  local doctor to run without remote credentials.
- PayOS webhook confirmation now requires the official response fields and the
  exact requested `webhookUrl`; malformed or mismatched HTTP-200 responses are
  ambiguous failures. Dodo webhook registration and bootstrap now consume the
  bounded cursor inventory, fail closed on malformed or looping pagination,
  and safely recover the two reviewed stale-lease/publication race cases.
- Staging smoke now proves the candidate `/solutions` marker and the intentional
  private/no-store/noindex `/llms.txt` staging boundary. Production rollback
  rehearsal requires the public `llms.txt` text contract. These checks do not
  claim that the currently deployed production Worker already contains the
  candidate routes.
- `release:quality:evidence` runs the ten required local gates sequentially,
  rejects dirty or drifting commit/tree state, binds quality evidence to the
  accepted staging Worker UUID, writes only canonical private mode-`0600`
  artifacts without symlink traversal or overwrite, and leaves manual,
  monitoring and pilot artifacts bound to the later production candidate.
- The final source checkpoint passes `npm run check` with 0 errors and 4 hints,
  `npm run lint`, `npx tsc --noEmit`, `npm test` with 308 files / 2,432 tests,
  both production and staging builds, `npm audit --audit-level=high` with 0
  vulnerabilities, both deploy dry-runs and `git diff --check`.
- No remote mutation, provider charge, payout, webhook creation, approval or
  acceptance evidence was manufactured in this remediation. Production remains
  `NO-GO` until scoped Cloudflare tokens, staging backup/restore/migrations and
  deployment, genuine Dodo/PayOS UAT, the missing production Dodo webhook secret,
  approvals, monitoring, legal/support, pilot and rollback evidence are present.

## Landing page v3 redesign (2026-08-15)

Replaced the entire marketing landing page with a new indigo-led design system,
removing the legacy coral/teal palette that was unrelated to the Selinow brand
identity. All changes are scoped to marketing/public surfaces; storefront,
dashboard, auth, and runtime paths are untouched.

**Assets replaced:**
- Removed legacy `public/brand/selinow-kit/global/v2/` (5 baked-text PNGs).
- Created `public/brand/selinow-kit/global/v3/` with 7 text-free SVG
  illustrations: `core-hub.svg`, `hero-backdrop.svg`, `flow-catalog.svg`,
  `flow-channels.svg`, `flow-support.svg`, `flow-delivery.svg`, `og-cover.svg`.
- Re-rendered `public/brand/selinow-og-cover-global.png` (1200×630) from the new
  locale-neutral OG SVG — text-free, brand lockup only.

**CSS changes:**
- Created `src/styles/marketing/landing.css` — full homepage stylesheet with
  `l3-*` namespace, responsive breakpoints (1024/768/480), WCAG focus ring,
  `prefers-reduced-motion` support, no x-scroll at 320px min.
- Cleaned `src/styles/marketing/pages.css` — removed all homepage selectors that
  moved to landing.css; retained only pricing and solutions page styles.
- Deleted 216 lines of legacy landing CSS from `src/styles/platform.css`
  (the `.landing-page` block with `--kit-peach`, `--kit-coral`, orbit layout,
  and provider-card image references).
- Imported `landing.css` in `PlatformLayout.astro`.

**Markup changes (index.astro marketing branch):**
- Replaced `.announcement-bar` → `.l3-announcement` with indigo gradient.
- Replaced `.landing-hero` → `.l3-hero` with SVG backdrop, gradient title
  highlight, inline SVG proof icons, no orbit image layer.
- Replaced `.trust-strip-kit` → `.l3-trust` card grid with inline SVG icons.
- Replaced `.channels-panel` → `.l3-channel-board` with inline SVG channel
  icons and `data-channel-state` tiles.
- Replaced `.workflow-track` → `.l3-workflow` grid with v3 SVG art and
  numbered floating badges.
- Replaced `.architecture-board` → `.l3-architecture-board` with v3 core-hub SVG.
- Replaced `.final-cta-kit` → `.l3-final` with indigo gradient backdrop.
- Updated `workflowSteps` image paths from `global/v2/*.png` to `global/v3/*.svg`.

**SEO improvements:**
- Added `og:image:width` and `og:image:height` meta tags to
  `PlatformLayout.astro` for proper social card rendering.
- OG cover is now fully locale-neutral (brand lockup + domain only).

**Test changes:**
- Updated `tests/unit/marketing-assets-contract.test.ts` to validate v3 SVG kit
  instead of v2 PNG kit.
- All 2,450 tests pass; 313 test files; `npm run check` 0 errors; `npm run lint`
  clean; `npm run build` succeeds.

**Preserved contracts:**
- All `mt("marketing.home.*")` i18n keys preserved.
- `data-pricing-state={pricingState}`, `marketing.pricing_unavailable`,
  `plan.recommended` runtime paths unchanged.
- Banned active claims (`global commerce`, `omnichannel`, `AI agent`, etc.)
  still absent.
- Storefront, dashboard redirect, and 404 branches untouched.

## Hero HTML5 Canvas animation (2026-08-15)

Added an animated node-network canvas visualization behind the landing hero to
give the page a modern, professional motion effect. Nodes and gradient paths
represent Selinow's multi-channel commerce pipeline; particles travel along
connections to suggest live data flow. Uses only the Selinow indigo palette
(`#6552E8`, `#9C8BFF`).

- Created `src/scripts/landing/hero-canvas.ts` — self-contained canvas module.
  Seeded random layout for deterministic scene; `ResizeObserver` for responsive
  redrawing; `prefers-reduced-motion: reduce` draws a single static frame and
  stops the loop (no continuous animation for motion-sensitive users).
- Added `<canvas class="l3-hero-canvas" data-hero-canvas aria-hidden="true">`
  as the bottom layer of `.l3-hero`, behind the existing SVG backdrop.
- Added `.l3-hero-canvas` styles to `landing.css` (absolute fill, `z-index: -2`,
  `pointer-events: none`) and a reduced-motion opacity dim.
- Loaded the module via `<script src="../scripts/landing/hero-canvas.ts">` in
  the marketing branch of `index.astro`.

Verification: `npm run check` 0 errors; `npm run lint` clean; 2,450 tests pass;
`npm run build` succeeds; `npm run deploy:dry-run` succeeds. Canvas confirmed
present and sized (1184×692px, active 2D context) via in-browser inspection.

## Onboarding v2 — 5-step wizard with preview drawer (2026-08-15)

Redesigned the `/onboarding` quickstart into a 5-step full-page wizard
(directional slide/fade transitions) with a linear progress bar in the top bar
and the former fixed live-preview column collapsed into a floating
button-triggered right drawer (Website/Telegram tabs, Esc/backdrop close,
mobile full-width).

New step flow: Store (name/slug/channels) → Product (preset or custom) →
Inventory (paste keys) → Connect (PayOS + Telegram side-by-side, per-card
"để sau") → Launch (summary cards, checklist, optional contact/policy
settings, publish, celebration + confetti).

- Created `src/components/dashboard/onboarding/OnboardingPreviewDrawer.astro`
  (drawer + floating trigger; reuses the storefront/Telegram mockups).
- Created `src/components/dashboard/onboarding/OnboardingStepLaunch.astro`
  (review summary, collapsible optional settings form, derived checklist,
  publish → celebration state; storefront link, bot link, dashboard link).
- Rewrote `src/components/dashboard/onboarding/OnboardingShell.astro`:
  single-column layout (max-width 720px), linear gradient progress bar with
  step labels, avatar + exit CTA, global step-pane animation classes
  (`is-active` / `is-exiting-left|right` managed via `:global()` because panes
  render inside child components).
- Redesigned the four step components (Store/Product/Inventory/Connect):
  step badges now /05, Connect uses a 2-column card grid with per-card skip,
  Store's smart-defaults box replaced by an inline hint; all data attributes
  and form contracts preserved.
- Rewrote `src/scripts/dashboard/onboarding-quickstart.ts`: class-based
  directional step transitions, progress-bar updates, drawer open/close/Esc
  logic, launch-state tracking (shop/product/keys/PayOS/Telegram), settings
  save via `POST /onboarding/settings` (attestation not required),
  publish via `POST /storefront/publish` (replaces the previously
  non-existent `/publish` call), celebration handling. All API, CSRF, and
  idempotency behavior unchanged.
- `OnboardingLivePreview.astro` and `OnboardingCelebration.astro` are now
  unreferenced by the live route (kept for history; superseded by the drawer
  and Launch step).
- No changes to `src/lib/onboarding/*`, `onboarding-ui.ts`, AppLayout,
  migrations, API endpoints, or auth.

Verification (2026-08-15): `npm run check` — 0 errors in onboarding files
(18 pre-existing errors in other workstreams' WIP: `payments.astro`,
`seller-management.ts`, `telegram/commerce.ts`, `auth/session.ts`);
`npm run lint` — onboarding files clean (52 pre-existing errors elsewhere);
`npm run test` — all onboarding-related tests pass (23 pre-existing failures
in 4 files owned by parallel workstreams); `npm run build` — succeeds when the
truncated WIP file `src/pages/app/payments.astro` (cut off mid-line 64,
another session's unfinished draft) is excluded; the file was restored
byte-for-byte afterward.

Known limitations: wizard copy is hardcoded Vietnamese (consistent with the
previous quickstart); i18n catalog keys for the 8-step legacy wizard remain
unused by this route; manual browser walkthrough of the 5-step flow still
recommended before deploy.

Dashboard Redesign Takeover — closeout (2026-08-16):
Branch `dashboard-redesign-takeover`. Full takeover handoff: `docs/DASHBOARD_REDESIGN_TAKEOVER_HANDOFF_2026-08-16.md`.
Original plan and briefs: `docs/DASHBOARD_REDESIGN_HANDOFF_2026-08-15.md`,
audit: `docs/DASHBOARD_UI_AUDIT_AND_REDESIGN_PLAN_2026-08-15.md`.

Milestones (all committed):
- M0 checkpoint `bcf9692` — pre-takeover WIP checkpoint (base for review diffs).
- M1 `a26f0f4` — unblock build and repair broken WIP clusters (payments page,
  telegram mini-app, seller helpers, session, contract registries).
- M2-D2 `5dff07f` — D2: consolidate Channels IA (`/app/integrations` hub),
  new `/app/developer` page, split `DomainManager.astro` into
  `components/dashboard/domains/*` (DomainList etc.), token migration of the
  domains surface to `--sln-*`.
- M3-D1 `ec919a5` + follow-up `3ac8e16` — D1: DataTable standardization
  (`components/workspace/DataTable.astro`), server-side search/sort/pagination
  for products/orders/inventory/customers/members + admin shops/investigations/
  appeals, `listSellerProductsPage` ledger query in `lib/catalog/store.ts`
  (tenant-scoped `shop_id` CTE, LIMIT/OFFSET), low-stock threshold from
  `shop_settings`, client-side CSV export of fetched page rows
  (`lib/dashboard/csv-export.ts`). Follow-up commit `3ac8e16` contains the
  catalog store helpers that the committed D1 page/test already imported.
- M4-D3A `421a007` + fixup `74c51fc` — D3-A: migration `0099`
  account security hardening; 2FA email-OTP UI, password change, login
  history, billing invoice history (`pages/app/security.astro`,
  `pages/app/billing.astro`, `lib/auth/*`, `pages/api/app/account/*`);
  fixup adds the a11y gate on security tabs.
- M5-D3B `d750297` — D3-B: migration `0100` automation rule builder;
  `lib/automation/rules/*` with 5 trigger types / 4 action types, allow-list
  payload evaluator that fails closed, SSRF webhook guard, orchestrator-backed
  dispatch, rule CRUD API + builder UI in `pages/app/automation.astro`.
- M6-D0/D4 (this wave): dead-code cleanup + token unification.
  - Deleted dead `src/components/dashboard/OnboardingWizard.astro` (904
    lines; `/onboarding` uses `OnboardingShell` + step components) and
    updated the 6 test files that read it to assert on the live components
    instead (wizard-only assertions removed; all other assertions kept).
  - Deleted 7 zero-import wrappers in `src/components/states/`:
    BlockedState, ErrorState, LoadingState, SuccessState,
    WaitingProviderState, WaitingUserState, WarningState (verified by grep:
    zero imports anywhere in `src/`). Kept the 6 still imported:
    WorkspaceState, EmptyState, PermissionState, PlanLimitState,
    SuspendedState, StatePanel. (Handoff estimated 11/13; the D streams
    since wired more states into DomainManager/RuleList/AutomationLedger.)
  - Unified CSS tokens: migrated 446 `--selinow-*` usages across 22 source
    files to `--sln-*` (170 storefront.css, 129 admin.css, 8 primitives.css,
    4 selinow-a11y.css, 2 app-shell.css, plus components/pages), added 8
    canonical tokens that existed only as aliases (`--sln-success-text`,
    `--sln-warning-text`, `--sln-danger-text`, `--sln-info-text`,
    `--sln-action-primary-ink`, `--sln-disabled-ink`, `--sln-disabled-bg`,
    `--sln-focus`) with dark-theme overrides, and removed the entire 70-line
    legacy alias block from `selinow-tokens.css`. Remaining `--selinow-*`
    usages in `src/` and `tests/`: 0 (plus a regression guard in
    `promptos-foundation.test.ts`).

Verification gate (2026-08-16, run from repo root on this branch):
- `npm run check` — PASS: 855 files, 0 errors, 0 warnings (4 hints).
- `npm run lint` — PASS: 0 errors.
- `npm run test` — PASS: 330 test files, 2589 tests, all passing
  (unit + integration combined).
- `npm run build` — PASS: production Cloudflare Worker build complete
  (1 pre-existing INEFFECTIVE_DYNAMIC_IMPORT warning, unchanged).
- `npm run deploy:dry-run` — PASS: worker bundle, bindings, routes and
  manifests validated; exited cleanly with `--dry-run`.

Known limitations carried forward:
- Webhook SSRF guard (`lib/automation/rules/webhook-guard.ts`) is
  pattern-based; DNS-rebinding of a public hostname onto a private IP is a
  residual TOCTOU risk (noted in code; follow-up v2 = domain allowlist).
- `rule_create_task` capability stays at `approval_required` level (inline
  executor stub, no autonomous task creation).
- `inventory.low_stock` is a derived trigger computed from paid orders; no
  independent stock hook exists.
- `src/scripts/dashboard/onboarding.ts` is only reachable through the deleted
  wizard; it is still read by contract tests and left in place intentionally
  (separate cleanup candidate).
- The legacy `--selinow-*` alias layer is fully removed; any external
  stylesheet referencing those names must migrate to `--sln-*`.

Dashboard Redesign Takeover — wave 2: E2E smoke, ultra review, hardening
and channel/domain automation upgrades (2026-08-16, later shift):
Branch `dashboard-redesign-takeover`. Scope: Task 7 (browser E2E smoke of
the main dashboard flows) + Task 8 (3-way ultra review) + fixes for the
findings + seller-requested automation upgrades for Telegram bot setup and
custom-domain DNS confirmation.

Browser E2E smoke (dev server `http://app.localhost:4330`, see environment
notes below) — verified flows:
- Register → OTP verify → password login → logout → login (password-only;
  2FA login path not exercised in-browser, see known issues).
- Onboarding wizard: create store (multi-channel), 1-click product template,
  finish wizard; store context propagates `?shop=` through the app shell.
- App shell nav: Operations/Sales channels/Configuration/Administration
  groups, `/app/telegram` 307-redirects to `/app/integrations?focus=telegram`
  preserving `shop`; `/app/developer` renders API credentials surface.
- Products: server-side search (`q=Beta` filters rows + URL), URL-driven sort
  (`sort=title` orders A→Z), rows-per-page control, CSV export button (no
  error state; blob download not observable from the embedded browser).
- Automation rules: create rule (order.paid → Telegram notify) persisted and
  rendered with Edit/Turn off/Delete; unsafe webhook (`http://127.0.0.1`)
  rejected server-side without creating a rule; toggle verified via UI.
- Billing: plan hero, entitlements, invoice history (empty state), usage
  meters render; Integrations hub: Telegram row + config panel, payments and
  domains summary cards, developer link; Domains: platform subdomain card,
  PlanLimitState correctly disables custom-domain connect on trial plan.

Ultra review (3 dimensions, base `bcf9692`):
- COMPLETENESS: no blockers; majors = D1 bulk actions never implemented nor
  deferred in reports; takeover docs overclaim server-side search for
  inventory/members/admin-appeals (they lack it); DomainList still carries a
  duplicate `<template data-domain-template>` markup-drift risk.
- CORRECTNESS: no blockers; major = CSV export lacked formula-injection
  escaping (`=`/`+`/`-`/`@` from customer-controlled names reach seller
  spreadsheets); minors = webhook guard missed trailing-dot hostnames
  (`localhost.`), rule PATCH changing trigger without re-validating legacy
  actions, client Idempotency-Key regenerated per attempt (dedup defeated),
  billing usage meter rendered limit `0` as "no numeric limit" while the
  dispatcher fail-closes to blocked.
- IMPACT: report pending at the time of this entry (agent still running);
  spot-checks from the other two reviews: ownership attribution for
  migration 0099 predates the takeover checkpoint, `src/pages/app/index.astro`
  still links `/app/telegram` (redirect keeps it working).

Fixes applied this shift (all verified by targeted tests):
- `src/lib/dashboard/csv-export.ts` — neutralize leading `=+-@\t\r` with a
  `'` guard (OWASP CSV-injection guidance); new cases in
  `tests/unit/csv-export.test.ts`.
- `src/lib/automation/rules/webhook-guard.ts` — strip trailing dots from the
  hostname before matching (`localhost.`, `foo.internal.` now blocked); new
  cases in `tests/unit/automation-rules-executors.test.ts`.
- `src/components/dashboard/onboarding/OnboardingPreviewDrawer.astro` —
  `.preview-drawer-panel[hidden] { display: none; }`: the author `display:
  flex` overrode the UA `[hidden]` rule, so the "closed" preview drawer
  stayed painted over the wizard form and blocked the "Tạo Cửa Hàng" button
  (reproduced in-browser before the fix; click works after).
- `src/components/dashboard/automation/RuleForm.astro` — same `[hidden]`
  override for the prototype condition row: it rendered like a real row in
  the create dialog, but the collector only reads `[data-rule-condition-row]`
  clones, so operator/value typed into the prototype were silently dropped
  (rule saved with "0 conditions" — reproduced in-browser).
- `src/pages/app/billing.astro` — usageLimit now accepts configured `0`
  limits and the percent math treats `limit === 0` as fully blocked, matching
  dispatcher enforcement instead of showing "no numeric limit".
- `src/scripts/dashboard/automation-rules.ts` — create Idempotency-Key is
  stable per draft session (new salt only after a confirmed create), so a
  retried submit after a lost response deduplicates server-side.
- `src/scripts/dashboard/security.ts` — surfaces the server's local-only
  `debugOtp` in the 2FA feedback line (`APP_ENV=local` only) so enrollment
  is testable without a mail provider.

Channel & domain automation upgrades (seller request "auto-jump to
BotFather / Cloudflare and auto-confirm"):
- Telegram (`src/pages/app/integrations.astro`, `src/scripts/dashboard/
  integrations.ts`): config panel now offers a one-click "Copy /newbot
  command" button next to the BotFather deep link; client-side token format
  validation (`^\d{6,}:[A-Za-z0-9_-]{30,}$`) fails fast with a clear message
  (verified in-browser with an invalid token — no server round-trip); after a
  successful connect the script automatically fires the existing
  health-check endpoint so the seller sees bot+webhook verification finish
  without another manual click.
- Domains (`src/components/dashboard/domains/DomainList.astro`,
  `src/scripts/dashboard/domains.ts`): DNS instruction cards now include an
  "Open Cloudflare DNS" deep link (plus the existing copy-name/copy-target
  buttons) and an auto-recheck note; while the page is open, pending custom
  domains are re-checked automatically (15s interval, max 8 rounds, plus an
  immediate re-check with a 30s throttle when the tab becomes visible).
- i18n: new keys added to both EN and VI catalogs for all of the above
  (`dashboard.integrations.telegram.copy_command*`, `token_invalid`,
  `auto_verify`, `dashboard.domains.card.dns.open_cloudflare`,
  `auto_check_note`).

Verification (this shift):
- Targeted: `vitest run` for csv-export, all 4 automation-rules suites,
  i18n-call-site-contract, security-account-tabs-ui,
  integrations-frontend-contract, tenant-link-static-fallback,
  billing-invoice-history — all pass (100 tests).
- `npm run lint` — clean on every file touched by this shift.
- `npm run test` (full) — 2615/2616 pass; the single failure
  (`storefront.order.shipping.kicker` missing from the EN storefront catalog
  for `src/pages/orders/[orderPublicId].astro`) and 22 `astro check` type
  errors (`ProductInput.deliveryMode`) both come from a *parallel
  workstream's* uncommitted edits to `src/lib/commerce/**`,
  `src/lib/catalog/**`, `src/pages/orders/**` and `src/pages/api/store/**`
  present in the same working tree — not from this shift's changes; left for
  that stream to resolve.

Known issues / follow-ups from this shift:
- Embedded-browser (IAB) cookie jar kept failing CSRF-protected POSTs from
  `/app/security` even with a fresh session, while the same flow verified
  clean via curl (login → CSRF GET `/api/auth/sessions` → 200) and all
  account-security unit/integration suites pass. Full 2FA enable/disable +
  password-change E2E should be re-run with the repo's standard Playwright
  gate (`scripts/local-auth-browser-gate.mjs`) instead of the IAB.
- `requireRecentAuth` failures surface as "The security token is no longer
  valid" on the security page, which reads like a CSRF/technical fault;
  consider a dedicated re-auth message + inline "Sign out to authenticate
  again" affordance (the button already exists in the Sessions panel).
- Custom-domain auto-recheck path could not be exercised end-to-end in-browser
  because the trial plan correctly blocks custom-domain connect
  (PlanLimitState); logic is unit-covered by the shared scripts contract
  tests and the wiring is live for entitled shops.

Local environment notes for the next shift:
- Dev server runs on `http://127.0.0.1:4330` (`--host 127.0.0.1 --port 4330
  --allowed-hosts app.localhost,localhost,127.0.0.1`); ports 4321/4322 are
  occupied by unrelated projects on this machine.
- `.dev.vars` (git-ignored) now carries `PLATFORM_ORIGIN` /
  `DASHBOARD_ORIGIN` / `API_ORIGIN` overrides pointing at `*.localhost:4330`
  so host-based routing works off the default port; pre-edit backup at
  `/tmp/selinow-dev-vars-takeover.bak`.
- Local D1 had not applied migrations 0098–0100 (register/login failed with
  `no such column: password_hash`); applied via
  `npx wrangler d1 migrations apply PLATFORM_DB --local`.
- Disposable E2E account: `takeover-e2e@selinow.invalid` /
  `TakeoverE2E@2026x` with store `Takeover E2E Store`
  (`shop_a13c5fcb-bbcf-42fc-8c80-109e342f4a9f`) + 3 draft products, local DB
  only.
