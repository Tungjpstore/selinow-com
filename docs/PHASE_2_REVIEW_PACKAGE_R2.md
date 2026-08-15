# Phase 2 Review Package R2

Status: local review-fix candidate **PASS**; staging, providers, pilot, and
production remain **NO-GO**

Reviewed locally: 2026-08-03 (Asia/Tokyo)

## Candidate identity

- Review-fix baseline: `b67a1e5ce0166fb2762c5a979a2a4934fc813ad7`.
- Immutable runtime candidate: `ec50cde50c1ecdc8264a07c3261e2962c7e568d6`.
- Runtime tree: `a35e2c871d2db97b392910fb04f51b7aaa27313c`.
- Commit message: `fix: close phase 2 review findings`.
- Branch: `codex/landing-page-deploy-20260801`.
- This package is a documentation-only follow-up. Staging execution identity is
  not copied from this document: the guarded manifest command must derive the
  final clean HEAD, tree, and migration ledger after fresh staging evidence.

## R1 re-review findings and disposition

### Finding 1 - Staging mutation was not bound to one immutable candidate

Fixed. Real staging migration, seed, and deploy now require a canonical private
release manifest under `.wrangler/releases/staging/<release-id>/`. The manifest
binds a clean Git commit, tree, exact ordered migration ledger, creation time,
expiry, and release ID. It is revalidated before and after admission/build work.
The writer enforces directory mode `0700` and file mode `0600`, including when a
path already exists.

Staging continuation admission additionally requires a fresh protected
report-v2 backup and a passed isolated staging restore report for the exact
reviewed commit, account, D1 UUID/name, backup checksum/size, complete migration
ledger, integrity result, zero foreign-key violations, and a distinct temporary
target. Evidence drift fails closed before Wrangler. Every real non-local
restore drill now requires `--reviewed-commit`.

Evidence: `scripts/lib/staging-release.mjs`,
`scripts/staging-release-manifest.mjs`, `scripts/deploy.mjs`, `scripts/db.mjs`,
`scripts/lib/backup.mjs`, and the staging release/continuation/deploy/database
admission tests.

### Finding 2 - Recovered inventory readiness could ignore catalog sellability

Fixed. Activation replay accepts an inventory batch only when its tenant-bound
product and variant are both active. Manual fulfillment similarly requires an
active product and active variant. The legacy product-only create API rejects an
active product without an initial variant, preserving the same invariant at the
write boundary.

Evidence: `src/lib/analytics/activation.ts`, `src/lib/catalog/store.ts`,
`tests/unit/activation-analytics.test.ts`, and
`tests/unit/catalog-atomic-create.test.ts`.

### Finding 3 - Activation replay could backdate readiness to product creation

Fixed with forward-only migration `0080_catalog_activation_timestamps.sql`.
Products and variants now retain their first activation timestamp. Existing
active rows are conservatively backfilled from their latest authoritative
`updated_at`; future activation is recorded by immutable triggers. Inventory
readiness uses the latest of product activation, variant activation, and accepted
inventory import. Manual readiness uses the latest product/variant activation
boundary. Atomic manual creation and active manual updates emit the same
idempotent milestone immediately.

Evidence: `migrations/0080_catalog_activation_timestamps.sql`,
`src/lib/analytics/activation.ts`, `src/lib/catalog/store.ts`, and the activation
timestamp/analytics/catalog tests.

### Finding 4 - Onboarding retained stale inventory request plaintext/state

Fixed. Onboarding inventory preview/import requests use a mutable sensitive-body
wrapper that clears both the object data field and serialized body reference.
Each request owns an `AbortController`; switching shops aborts and clears the
pending request, and a stale request cannot clear or overwrite the replacement
request's state. Terminal error and success paths still remove form plaintext and
invalidate expired previews as appropriate.

Evidence: `src/lib/security/sensitive-request-body.ts`,
`src/scripts/dashboard/onboarding.ts`,
`tests/unit/sensitive-request-body.test.ts`, and
`tests/unit/inventory-frontend-contract.test.ts`.

## Rejected findings

None. All four re-review findings were implemented and regression-tested.

## Migration evidence

- Source chain: 80 contiguous forward-only files, `0001` through
  `0080_catalog_activation_timestamps.sql`.
- No previously numbered migration was edited.
- Staging historical ledger remains through `0028`; 52 migrations
  (`0029`-`0080`) are pending unless fresh read-only evidence proves otherwise.
- Production historical ledger remains through `0052`; 28 migrations
  (`0053`-`0080`) are pending.
- No remote ledger was queried or changed in this task.

## Verification

- `npm run check`: passed across 694 files, 0 errors, 0 warnings, 3 existing
  TypeScript hints.
- `npm run lint` and `npx tsc --noEmit`: passed.
- Focused review-fix, staging admission, backup/restore, catalog, analytics, and
  sensitive-body tests passed.
- `npm run test`: 248 files / 1,770 tests passed.
- `npm run build` and `npm run build:staging`: passed.
- `npm run deploy:dry-run` and `npm run deploy:staging:dry-run`: passed with 280
  modules and exited at Wrangler `--dry-run`; no deployment occurred.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `git diff --check` and the pre-commit cached diff check passed.
- The existing non-fatal mixed static/dynamic inventory crypto import warning
  remains unchanged.

## Restore evidence

- Candidate-bound report:
  `.wrangler/restore-drills/local/rdr_20260803145929_b94ce8926be7.json`.
- Reviewed runtime commit:
  `ec50cde50c1ecdc8264a07c3261e2962c7e568d6`.
- Report permissions: mode `0600`.
- Integrity: `ok`; foreign-key violations: 0.
- Schema/count checks: zero missing tables, missing count tables, count
  mismatches, or cross-ledger mismatches.
- Migration ledger: exact 80-file chain through `0080`.
- Restored items: 614; exact temporary target removed.
- This is isolated local evidence only. It does not replace a fresh protected
  staging or production backup/restore pair.

## Secret and boundary review

A bounded high-confidence scan of every implementation file changed by R2 found
no cloud access key, payment secret prefix, private-key block, or Telegram bot
token. No credential, provider secret, customer token, license-key plaintext,
production database ID, or unrelated repository branding was added. The task did
not run staging/production backups, migrations, seeds, deploys, provider calls,
route/DNS changes, webhook registration, or secret mutation.

## Known limitations and external requirements

- `release:staging:manifest -- --write` intentionally cannot succeed until the
  worktree is clean and fresh staging backup/restore evidence exists for that
  exact HEAD. Unit/contract tests validate the local admission logic; no manifest
  was fabricated to imply remote readiness.
- The prior authenticated 7/7 and public 27/27 browser runs remain R1
  layout/accessibility evidence. R2 did not perform a new provider-backed or
  remote browser acceptance run.
- Pre-`0066` pending OAuth rows still need an explicit revoke/expire or reviewed
  legacy-resolution decision before remote continuation.
- Dodo merchant/product/price/webhook setup, PayOS and Telegram controlled UAT,
  retention/privacy/legal decisions, monitoring thresholds, rollback ownership,
  and seller pilot evidence remain incomplete.

## Environment decision

### Local

**PASS** for runtime candidate `ec50cde50c1ecdc8264a07c3261e2962c7e568d6`.
The four findings, migration chain, focused/full tests, static checks, builds,
dry-runs, audit, and isolated restore are locally verified.

### Staging

**NO-GO** until written approval, fresh read-only identity/route inventory,
protected report-v2 backup, candidate-bound isolated restore, private staging
manifest, pre-`0066` decision, forward-only `0029`-`0080` migration window,
reviewed deploy, smoke/monitoring, rollback owner, and controlled UAT exist.

### Production

**NO-GO** for the current commerce/provider candidate. The historical platform
handoff and `0001`-`0052` ledger do not prove this source. Production requires
accepted staging evidence and its own exact clean candidate, protected
backup/restore, approved window, manifest, canary, monitoring, rollback/forward
fix, external-host/Turnstile admission, and legal/support ownership.

### Providers and pilot

**NO-GO**. No provider acceptance, signed-payment exercise, seller pilot, unit
economics observation, revenue, conversion, CAC, churn, or margin evidence was
created or inferred.

## Decision

The Phase 2 review findings are closed locally. R2 supports requesting a guarded
staging review window; it does not authorize or claim staging mutation, provider
activation, pilot acceptance, production release, or commercial validation.
