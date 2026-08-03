# Phase 2 Review Package R1

Status: local Phase 2 pilot candidate PASS; staging, providers, pilot, and production remain **NO-GO**

Reviewed locally: 2026-08-03 (Asia/Tokyo)

## Candidate identity

- Baseline: `4d3081a03a320ea84fdf66c31cf22e97f041a386`.
- Exact implementation candidate: `a0a4a1624e29772d851a46cdea4a0ef0fe89d49d`.
- Candidate commit message: `feat: complete phase 2 pilot candidate`.
- Branch: `codex/landing-page-deploy-20260801`.
- The R1/admission binding is a documentation-only follow-up so the candidate
  commit remains immutable. No amend or push is used.

## R0 findings and disposition

### P1 - Inventory plaintext survived ordinary preview/import failures

Fixed. The inventory workspace now erases the form, clears request-body data,
and invalidates the preview after every preview/import request error. Onboarding
does the same for preview and import errors, in addition to its existing success
and shop-switch cleanup. Cancel/close/payload-change paths remain covered. The
client never stores or renders inventory plaintext in SSR, browser storage,
logs, snapshots, queue payloads, audit payloads, or committed evidence.

Evidence: `src/scripts/dashboard/inventory.ts`,
`src/scripts/dashboard/onboarding.ts`, and
`tests/unit/inventory-frontend-contract.test.ts`.

### P1 - Overview equated `shops.status = active` with permission to sell

Fixed. `/app` derives sellability from shop lifecycle plus the authoritative
readiness projection. Active-but-blocked, readiness-unavailable, and owner-only
readiness states are distinct. The public storefront action appears only for a
ready shop, and the action queue cannot show an all-clear when required
readiness, order, or catalog authority is unavailable or forbidden.

Evidence: `src/lib/dashboard/overview-ui.ts`, `src/pages/app/index.astro`,
`src/lib/i18n/catalogs/dashboard.ts`, and `tests/unit/overview-ui.test.ts`.

### P2 - Activation recovery missed manual-fulfillment readiness

Fixed. `inventory_ready` backfill uses the earliest tenant-scoped accepted
inventory batch or active manual-fulfillment product. Replay remains idempotent,
and the regression test verifies that another tenant receives no event.

Evidence: `src/lib/analytics/activation.ts` and
`tests/unit/activation-analytics.test.ts`.

### P2 - Admission documents described an obsolete candidate

Fixed for local review. Source migrations are recorded as `0001`-`0079`;
staging remains at `0028` with 51 pending migrations, and production remains at
`0052` with 27 pending migrations. Local evidence is separated from remote
approval, backup, migration, deploy, provider, and pilot requirements.

Evidence: `docs/STAGING_MUTATION_REVIEW_PACKAGE.md`,
`docs/PRODUCTION_RELEASE.md`, and this package.

## Rejected findings

None. No R0 finding was dismissed. The R1 re-review broadened the inventory P1
fix to onboarding preview-request failures before final verification.

## Source and contract surface

- Runtime/source: seller overview authority, dashboard bilingual copy,
  inventory/onboarding plaintext lifecycle, and activation backfill.
- Tests: sellability/action-authority unit coverage, inventory frontend source
  contracts, activation replay/backfill and tenant-isolation coverage.
- Product artifacts: activation funnel, variable-only unit economics, controlled
  pilot plan, and a non-evidence JSON example.
- Handoff/status: current state, implementation status, seller screen/API
  contracts, backend/UI gap report, staging admission, and production runbook.
- Browser baselines: the intentional mobile `/app` sellability copy and the
  current-source mobile marketing page were visually reviewed before acceptance.

## Migration evidence

- No migration was added or edited by Phase 2.
- Source chain: 79 contiguous forward-only files, `0001` through
  `0079_phase1_completion_hardening.sql`.
- Staging historical ledger: through `0028`; remote status was not queried or
  changed in this task.
- Production historical ledger: through `0052`; remote status was not queried or
  changed in this task.
- Pre-`0066` pending OAuth rows still require an explicit revoke/expire or
  legacy-resolution decision before any remote continuation.

## Verification

- `npm run check`: passed across 689 files, 0 errors, 0 warnings, 3 existing
  TypeScript hints.
- `npm run lint`: passed.
- Changed-path regression matrix: 3 files / 15 tests passed.
- `npm run test`: 244 files / 1,760 tests passed.
- `npm run build`: passed; the existing non-fatal mixed static/dynamic inventory
  crypto import warning remains.
- `npm run build:staging`: passed; build only, no remote mutation.
- `npm run deploy:dry-run`: passed; 280 modules, then exited at Wrangler
  `--dry-run` without deployment.
- `npm run deploy:staging:dry-run`: passed; 280 modules, then exited at Wrangler
  `--dry-run` without deployment.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `git diff --check` and `git diff --cached --check`: passed.

## Browser evidence

- Authenticated local gate: 7/7 passed across desktop/mobile plus
  1440/768/390/320 and 200% geometry projects, including axe, overflow, console,
  private-header, safe-failure, and isolated-secret checks.
- The mobile dashboard baseline changed intentionally from generic setup copy to
  the authoritative `Chua publish` sellability state. The desktop dashboard was
  visually inspected and remained pixel-identical for its fixture.
- Public local gate: 27/27 passed across desktop/mobile and 200% geometry,
  including price-changed, expired quote, provider-unavailable, separate
  payment/fulfillment timelines, accessibility, console, and external-request
  checks.
- The mobile marketing baseline was refreshed only after visual review of the
  current-source full page; Phase 2 changed no public marketing runtime source.

## Restore evidence

- Candidate-bound report:
  `.wrangler/restore-drills/local/rdr_20260803135956_a4239ef55749.json`.
- Reviewed commit in report:
  `a0a4a1624e29772d851a46cdea4a0ef0fe89d49d`.
- Report permissions: mode `0600`.
- Integrity: `ok`; foreign-key violations: 0.
- Schema/count checks: zero missing tables, missing count tables, count
  mismatches, or cross-ledger mismatches.
- Migration ledger: exact 79-file chain through `0079`.
- Restored items: 614; exact temporary target removed.
- This is isolated local evidence, not a protected staging or production backup.

## Secret scan

A bounded scan of every changed/untracked Phase 2 file found no high-confidence
AWS access key, live/test secret-key prefix, private-key block, Telegram bot
token, or assignment-like API/client/webhook secret/password value. Documentation
contains only secret names, prohibitions, nulls, booleans, and safe references.
No secret value was requested, printed, committed, or used for a remote action.

## Activation, monetization, and pilot evidence

- `docs/PHASE_2_ACTIVATION_FUNNEL.md` defines denominators,
  time-to-milestone, abandonment, retry/backfill, cohort separation, prohibited
  data, and `not_occurred` versus `projection_unavailable`.
- `docs/PHASE_2_UNIT_ECONOMICS.md` models Starter/Pro with variables and
  conservative/base/upside scenarios. Unknown fees, costs, conversion, churn,
  CAC, support burden, losses, FX, tax, and fixed costs remain `TBD` or owner
  decisions; no source price was changed.
- `docs/PHASE_2_PILOT_PLAN.md` covers exact payment, duplicate webhook,
  mismatched/late/partial/overpaid payment, inventory race, fulfillment replay,
  subscription recovery, support escalation, rollback, and cleanup.
- `docs/PHASE_2_PILOT_EVIDENCE.example.json` is explicitly proposed and contains
  no actual seller, buyer, credential, provider, payment, or fulfillment evidence.

## Known limitations

- Detailed readiness is owner-only by the existing backend policy; manager,
  support, and viewer overview states remain explicitly limited rather than
  inferring sellability.
- Overview order data is the latest bounded 200-record projection; no historical
  revenue/conversion dashboard is claimed.
- The activation funnel is a measurement contract, not a seller-facing analytics
  dashboard and not pilot evidence.
- Unit-economics inputs and acceptance thresholds require owner/provider/pilot
  evidence before commercial decisions.
- The local restore drill does not replace a fresh protected report-v2 staging
  backup or a production continuation backup.
- The existing three TypeScript hints and the non-fatal inventory crypto chunking
  warning remain unchanged.
- Current source is not proven deployed to staging or production.

## Environment status

### Local

**PASS** for the exact implementation candidate. P0 findings: 0. P1 findings:
0 open. Seller activation authority, tests, browser gates, restore drill, build,
dry-run, audit, documentation, and pilot-planning artifacts are locally verified.

### Staging

**NO-GO**. Required: explicit mutation approval, fresh read-only identity and
route inventory, protected non-empty report-v2 backup, candidate-bound isolated
restore, pre-`0066` OAuth-row decision, forward-only migrations `0029`-`0079`,
reviewed Worker deploy, smoke/monitoring evidence, rollback owner, and UAT.

### Production

**NO-GO** for the current commerce/provider candidate. The historical
platform-only Worker and `0001`-`0052` ledger do not prove this source. Required:
staging acceptance, exact production candidate, protected backup/restore,
approved continuation window, monitored canary, rollback/forward-fix evidence,
external-host/Turnstile admission, and named legal/support/incident owners.

### Providers and pilot

**NO-GO**. PayOS needs a controlled signed-payment/reconciliation exercise;
Telegram needs a dedicated seller bot and private `/start` acceptance; Dodo
needs merchant/product/price/webhook setup and billing UAT. Zalo, WhatsApp,
Discord, Telegram Mini App, and other connector requests remain contract-ready,
provider-pending, or roadmap only. No pilot seller or commercial result exists.

## Decision

Phase 2 local evidence supports requesting staging admission for candidate
`a0a4a1624e29772d851a46cdea4a0ef0fe89d49d`. It does not authorize or claim a
staging deployment, provider activation, pilot acceptance, production release,
or commercial validation.
