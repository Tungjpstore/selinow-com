# Phase 2 Review Package R0

Status: baseline findings recorded before fixes

Reviewed baseline: `4d3081a03a320ea84fdf66c31cf22e97f041a386`

Branch: `codex/landing-page-deploy-20260801`

Worktree at review start: clean

Source migrations: `0001`-`0079`, 79 files, contiguous

Runtime: Node `v25.9.0`, npm `11.12.1`; repository engines are Node
`>=22.12.0 <26` and npm `>=11`.

## Findings

### P1 - Inventory plaintext survives ordinary preview/import failures

- Location: `src/scripts/dashboard/inventory.ts:209` and
  `src/scripts/dashboard/onboarding.ts:1720`.
- Current behavior: the inventory workspace erases the textarea only for
  authentication/recent-auth failures, and onboarding retains plaintext for
  most preview/import errors.
- Expected behavior: erase plaintext and invalidate the bound preview after
  every error, as already happens on success, cancel, close, and shop switch.
- Impact: a failed network, validation, conflict, or provider-independent error
  can leave license-key plaintext in the DOM longer than necessary, increasing
  shoulder-surfing, screenshot, browser-inspection, and support-handling risk.
- Fix: centralize terminal plaintext cleanup in both clients and require a new
  preview after any failed attempt.
- Evidence required: source-contract tests for both surfaces plus the local
  authenticated browser gate.

### P1 - Overview equates `shops.status = active` with permission to sell

- Location: `src/pages/app/index.astro:111` and
  `src/pages/app/index.astro:304`.
- Current behavior: the primary store status and open-storefront action use only
  the shop lifecycle value. An active shop can therefore be presented as active
  even when authoritative readiness blocks selling, the subscription is not
  publishable, or readiness is unavailable.
- Expected behavior: show a dedicated sellability state derived from shop
  lifecycle plus the authoritative readiness projection; unavailable and
  role-forbidden readiness must remain unknown/limited rather than success.
- Impact: sellers can follow the wrong next action, support can misdiagnose an
  activation blocker, and suspended billing/readiness failures can be masked by
  an otherwise active shop row.
- Fix: introduce a pure overview sellability decision, use it for the headline
  and primary action, and prevent partial projections from rendering a false
  all-clear action queue.
- Evidence required: unit coverage for ready, blocked, draft, suspended,
  unavailable, and role-limited states plus browser coverage.

### P2 - Activation recovery misses manual-fulfillment readiness

- Location: `src/lib/analytics/activation.ts:360`.
- Current behavior: `inventory_ready` backfill considers only an accepted
  inventory batch. A manual-fulfillment product can satisfy the authoritative
  fulfillment readiness check without creating an inventory batch.
- Expected behavior: recover `inventory_ready` from the earliest authoritative
  accepted inventory batch or active manual-fulfillment product.
- Impact: manual-product pilots can be undercounted, time-to-inventory can remain
  undefined, and funnel abandonment can be attributed to a milestone that the
  seller actually completed.
- Fix: use a tenant-scoped union of both authoritative evidence paths.
- Evidence required: idempotent backfill test covering a manual-only seller and
  preserving tenant isolation.

### P2 - Staging/production admission documents describe an obsolete candidate

- Location: `docs/STAGING_MUTATION_REVIEW_PACKAGE.md:13` and
  `docs/PRODUCTION_RELEASE.md:5`.
- Current behavior: the staging package stops at `0077`, has a TBD candidate,
  and the production runbook says the shared tree is dirty and the pending
  continuation ends at `0077`.
- Expected behavior: identify the Phase 2 candidate boundary, source chain
  through `0079`, exact pending ranges from staging `0028` and production
  `0052`, local restore/dry-run evidence, and explicit remote NO-GO gates.
- Impact: reviewers can approve the wrong migration range or mistake historical
  worktree state for current admission evidence.
- Fix: refresh the checked-in admission packages after local verification and
  keep the final commit identity explicitly pending until the Phase 2 commit is
  created.
- Evidence required: migration continuity, fresh isolated restore report,
  schema/FK results, sequential build/deploy dry-runs, exact commit, and clean
  worktree verification.

## Baseline decision

- P0 findings: 0.
- P1 findings: 2; local Phase 2 PASS is blocked until both are fixed.
- P2 findings: 2; staging admission is not reviewable until they are fixed.
- Remote staging, provider, pilot, and production status: NO-GO. No remote
  mutation is authorized by this package.
