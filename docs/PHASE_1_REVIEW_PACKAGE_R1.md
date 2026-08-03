# Selinow Phase 1 Review Package R1

Status: local review-ready, not a staging or production approval

Reviewed: 2026-08-03 (Asia/Tokyo)

This package records the current Phase 1 launch candidate after the R0 review,
billing hardening, launch-marketing/SEO narrowing, activation analytics, and
local accessibility verification. It does not authorize a Cloudflare, D1,
provider, DNS, secret, commit, or push mutation.

## Candidate identity and dirty-worktree boundary

- `HEAD`: `1144ae7`; no clean reviewed candidate exists. The R0 baseline recorded
  306 porcelain entries (162 modified, 31 deleted, 113 untracked). The current
  worktree reports 322 entries (168 modified, 31 deleted, 123 untracked) after
  the local continuation and documentation/snapshot refresh.
- Source migrations are contiguous `0001`-`0077`. Staging is still applied
  through `0028` with 49 pending (`0029`-`0077`). Production is still applied
  through `0052` with 25 pending (`0053`-`0077`).
- The current candidate scope is the billing, commercial marketing/SEO,
  onboarding/activation, accessibility, migration, test, and release-document
  work described below. Existing frontend rebuild assets, provider-contract
  continuations, and other dirty paths outside that scope must be classified
  separately before staging or production admission.
- No remote migration, deploy, DNS/route change, secret mutation, provider
  activation, commit, or push was performed.

## Exact candidate scope

### Billing and commercial access

- Migrations `0070_paid_plan_catalog.sql` through
  `0076_dodo_platform_price_provider.sql`.
- `src/lib/billing/plan-catalog.ts`, `src/lib/billing/entitlements.ts`,
  `src/lib/billing/subscription-access.ts`, `src/lib/billing/metering.ts`,
  `src/lib/billing/dodo.ts`, `src/lib/billing/service.ts`.
- `src/pages/api/app/shops/[shopPublicId]/billing/checkout.ts`, `plans.ts`,
  and `requests.ts`; `src/lib/tenants/billing-requests.ts`;
  `src/lib/dashboard/billing-ui.ts`; `src/pages/app/billing.astro`;
  `src/scripts/dashboard/billing.ts`.
- Billing and Dodo contract tests under `tests/unit/`, including
  `dodo-billing.test.ts`, `dodo-billing-webhook-route.test.ts`,
  `billing-entitlements.test.ts`, `billing-metering.test.ts`,
  `paid-plan-billing-migrations.test.ts`, and `subscription-access.test.ts`.

### Launch marketing and SEO

- `src/pages/index.astro`, `src/pages/pricing.astro`,
  `src/pages/sitemap.xml.ts`, `src/lib/content/solutions.ts`,
  `src/lib/storefront/marketing.ts`, `src/lib/i18n/catalogs/marketing.ts`,
  `public/site.webmanifest`.
- Marketing/SEO contract tests under `tests/unit/`, including
  `marketing-surface-contracts.test.ts` and `marketing-assets-contract.test.ts`.
- Launch copy is limited to digital products, license keys/private files,
  Website, Telegram, and seller-owned PayOS; future providers remain pending.

### Onboarding and activation analytics

- `migrations/0077_activation_milestone_ledger.sql`;
  `src/lib/analytics/activation.ts`; shop creation/readiness/publish/safe-test
  wiring in the tenant/onboarding services and routes.
- `tests/unit/activation-analytics.test.ts` and the onboarding/readiness focused
  tests; `docs/ACTIVATION_ANALYTICS.md`.
- Milestones are allowlisted, tenant-scoped, idempotent, and best-effort. The
  ledger is additive and is not a source of truth for billing, stock, orders,
  credentials, or subscription state.

### Accessibility and visual evidence

- `src/pages/app/integrations.astro`: provider-mark colors are darkened for
  WhatsApp Cloud and Discord contrast on mobile.
- Updated public visual baselines:
  `tests/visual/local-public.spec.ts-snapshots/public-marketing-home-public-desktop-1440-darwin.png`,
  `public-marketing-home-public-mobile-390-darwin.png`, and
  `public-pricing-public-mobile-390-darwin.png`.

### Review and operational documentation

- Current/review packages: `docs/CURRENT_STATE.md`,
  `docs/PHASE_1_REVIEW_PACKAGE_R0.md`, this file,
  `docs/STAGING_MUTATION_REVIEW_PACKAGE.md`,
  `docs/PRODUCTION_MUTATION_REVIEW_PACKAGE.md`,
  `docs/PILOT_READINESS_RUNBOOK.md`, `docs/LEGAL_SUPPORT_DECISIONS.md`,
  `docs/RELEASE.md`, `docs/RUNBOOKS.md`, `docs/PROVIDER_GATE_AUDIT.md`,
  `docs/PRODUCTION_RELEASE.md`, and `docs/IMPLEMENTATION_STATUS.md`.
- Historical checkpoint paragraphs in the long-form documents remain labeled
  as historical; the current overlay in `IMPLEMENTATION_STATUS.md` and the
  matrix in `CURRENT_STATE.md` are authoritative for this review.

## Verification evidence

| Gate | Result |
| --- | --- |
| `npm run check` | Pass: 0 errors, 3 hints |
| `npm run lint` | Pass |
| `npm test` | Pass: 242 files, 1,728 tests |
| `npm run build` | Pass |
| `npm run build:staging` | Pass |
| `npm run deploy:dry-run` | Pass; exits before Wrangler mutation |
| `npm run deploy:staging:dry-run` | Pass; exits before Wrangler mutation |
| `npm audit --audit-level=high` | Pass: 0 vulnerabilities |
| `git diff --check` | Pass |
| `npm run test:browser:public:local` | Pass: 27/27; baselines refreshed for current UI |
| `npm run test:browser:auth:local` | Pass: 7/7 |
| Disposable migration drill | Pass: all 77 migrations; SQLite integrity `ok`, foreign-key check zero rows, ledger count 77 |

Build output includes the existing Vite `INEFFECTIVE_DYNAMIC_IMPORT` warning for
`src/lib/crypto/inventory.ts`; it is non-fatal and does not alter the release
decision.

## Security and tenant-isolation review

- D1 remains authoritative for tenant, catalog, inventory, order, payment,
  fulfillment, subscription, billing, and activation state.
- Billing mutations use owner/recent-auth/CSRF/idempotency boundaries; signed
  Dodo raw-body events are required for subscription state changes. Return URLs,
  QR rendering, pending provider references, partial/overpaid/late/mismatched
  evidence, and provider-pending requests fail closed.
- Activation writes carry `shop_id`, an allowlisted milestone, an idempotency
  key, and safe metadata. They never carry credentials, provider payloads,
  buyer tokens, PII, license plaintext, or payment authority.
- Public and authenticated browser gates reject non-read-only external requests,
  private leakage, WCAG failures, and framework overlays. The provider-mark
  contrast issue found in R1 was fixed and reverified.

## Known limitations and external requirements

- Dodo merchant/bank review, correct Selinow website URL, product/price IDs,
  webhook signing secret, VND/tax treatment, refunds/invoices, and staging UAT
  remain external requirements. No provider secret is stored in this package.
- Staging and production still require fresh protected backup/restore evidence,
  exact account/D1 admission, a clean reviewed tree, and a separately approved
  mutation window before applying `0029`-`0077` or `0053`-`0077`.
- PayOS/Telegram provider acceptance, fulfillment UAT, seller pilots, monitoring
  ownership, legal/support decisions, custom-domain/Turnstile admission, and
  rollback evidence remain blocked. The deployed production Worker is stale
  relative to current marketing routes (`/solutions*`, `/sitemap.xml`, and
  `/llms.txt` were 404 in the read-only check).
- Dodo checkout replay after a provider reference exists still requires a new
  checkout session. Provider price-field immutability is not fully represented
  by database overlap guards, and subscription event ordering needs continued
  regression review.
- The worktree contains unrelated dirty paths and cannot be staged wholesale;
  a release owner must produce a clean reviewed commit and regenerate private
  release evidence from that exact tree.

## Review decision

**R1 local review: READY FOR OWNER REVIEW; remote launch: NO-GO.**

The candidate is locally coherent and fully verified under the listed gates, but
the missing clean tree, remote migration/backup admission, provider evidence,
legal/support decisions, pilots, and production SEO deployment prevent a
commercial-launch GO decision.
