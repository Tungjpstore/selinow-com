# Context Plan

## Task

Rebuild the Selinow frontend against the Prompt OS Professional v1.0 kit while preserving the existing Astro/Cloudflare route, API, tenant, payment, fulfillment and security contracts. The work is local/staging only; production remains NO-GO.

## Surface and user

- Marketing (`selinow.com`): prospective seller; editorial, light-first, one primary CTA.
- Seller workspace (`app.selinow.com`): owner, manager, support and viewer; operational control room with action queues, health rails, ledgers and timelines.
- Tenant storefront (`{slug}.selinow.com` or active custom domain): buyer; mobile-first, static-first catalog and safe order access.
- Admin operations: platform owner/risk/support; dark, dense, evidence-first and no secret/plaintext-key display.

## Selected skills and source precedence

- Prompt OS design-system operating instructions: `docs/frontend-redesign/prompt-os/11_AGENT_SKILLS/selinow-design-system/SKILL.md`.
- Prompt OS source precedence: repository security/business contracts > accepted ADRs > redesign brief > curated Brand OS > screen/component specs > reference images.
- Repository `AGENTS.md`, `00_MASTER_PROMPT.md`, `01_PRODUCT_SCOPE.md` through `10_AGENTS_TEMPLATE.md` were read before edits.
- The exact attached Professional v1.0 ZIP is preserved byte-for-byte at
  `docs/frontend-prompt-os/` (183 files). The 184-file
  `docs/frontend-redesign/prompt-os/` tree is the implementation working copy,
  including updated acceptance evidence and the admin-shops context extension.

## Current architecture inspected

- Astro 7 SSR with Cloudflare adapter and strict TypeScript.
- Four layouts: `src/layouts/PlatformLayout.astro`, `src/layouts/AppLayout.astro`, `src/layouts/StorefrontLayout.astro`, `src/layouts/AdminLayout.astro`.
- Existing business-backed projections under `src/pages/app`, `src/pages/admin`, `src/pages/products`, `src/pages/cart.astro`, `src/pages/checkout.astro`, `src/pages/orders`.
- D1-backed catalog, inventory, orders, PayOS, Telegram, domains, onboarding, export/deletion, abuse and automation services remain authoritative.

## Files changed in this foundation phase

- `src/styles/base.css`
- `src/styles/primitives.css`
- `src/styles/selinow-a11y.css`
- `src/layouts/AppLayout.astro`
- `src/layouts/PlatformLayout.astro`
- `src/layouts/StorefrontLayout.astro`
- `src/layouts/AdminLayout.astro`
- `src/components/primitives/` (typed controls, fields, alerts, dialog, drawer, toast, skeleton)
- `src/components/states/` (explicit state matrix plus `WorkspaceState` compatibility adapter)
- `src/components/workspace/` (action/health/readiness/activity/table primitives)
- `src/components/commerce/` (stock, variant, order timeline and key reveal primitives)
- `src/components/commerce/PaymentState.astro`
- `src/components/commerce/FulfillmentState.astro`
- `src/components/primitives/StatusBadge.astro`
- `docs/frontend-redesign/`

## Contracts that must not change

- No API URLs, payloads, route names or persisted state names change for visual convenience.
- Tenant authority comes from hostname/session membership; client `shop_id`, role, price, stock, payment and fulfillment values are never trusted.
- Payment and fulfillment remain separate UI states; return/cancel URLs never prove payment.
- Telegram tokens, PayOS credentials, order access tokens and inventory-key plaintext never render in logs, analytics, queue payloads or unauthorised UI.
- Mutations keep CSRF, recent-auth, role, plan, idempotency and tenant guards.
- Storefront catalog remains HTML-first and sensitive pages retain noindex/no-store behavior.

## Required Prompt OS specifications

- Tokens: `docs/frontend-redesign/prompt-os/03_DESIGN_SYSTEM/selinow-frontend-tokens.css`.
- State system: `docs/frontend-redesign/prompt-os/03_DESIGN_SYSTEM/STATE_SYSTEM.md`.
- Component manifest: `docs/frontend-redesign/prompt-os/04_COMPONENT_SYSTEM/component-manifest.json`.
- Route/state acceptance: `docs/frontend-redesign/prompt-os/09_QA/ROUTE_ACCEPTANCE_MATRIX.csv` and `STATE_MATRIX.csv`.
- Progressive enhancement: `docs/frontend-redesign/prompt-os/07_IMPLEMENTATION/PROGRESSIVE_ENHANCEMENT.md`.

## Implementation phases

1. Foundation: canonical styles, primitives, state matrix, responsive shell and accessibility contracts.
2. Seller critical path: overview, onboarding/readiness, integrations, domains, products, inventory, orders and store builder.
3. Buyer critical path: storefront, product, cart, checkout, order status and key reveal.
4. Marketing/admin: landing, pricing, login, abuse and operations surfaces.
5. Hardening: visual parity, 320/390 responsive, keyboard, contrast, performance, SEO and security review.

## Responsive targets

- Minimum 320px; primary mobile acceptance 390x844; desktop acceptance 1440x1024.
- Touch targets at least 44px.
- Tables become labelled record lists; wizard rails become progress summary/selector; checkout/order/domain instructions become one column.
- No horizontal overflow.

## State coverage

Loading, empty, success, warning, blocked, waiting user, waiting provider, error/retry, forbidden, plan-limited and suspended states are explicit components. Provider/payment/fulfillment states retain separate semantics and canonical Vietnamese copy.

## Tests and screenshots

- Existing public and authenticated Playwright gates remain the behavioral source of truth.
- Add source-level manifest/copy/accessibility tests for the shared foundation.
- Run `npm run check`, `npm run lint`, `npm run test`, `npm run build` and the relevant visual gates after route work.

## Excluded scope

- No production deployment, migration, DNS, provider traffic or secret read.
- No Chophanmem.com changes or deletion/Trash action.
- No unsupported provider, billing, seller-member mutation or admin investigation behavior fabricated in UI.

## Risks and gaps

- Several backend read/mutation contracts remain intentionally unavailable; the frontend must show truthful blocked/read-only states until those contracts exist.
- Store builder preview is currently a local draft composition, not the live catalog projection.
- Prompt OS includes reference assets and a vendor archive; they are preserved for art direction only and cannot override business/security source.
