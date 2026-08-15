# Selinow Phase 1 Review Package R3

Status: local Phase 1 completion candidate; remote launch remains **NO-GO**

Reviewed locally: 2026-08-03 (Asia/Tokyo)

## Scope

R3 fixes the independent R2 findings without mutating any remote D1, R2, KV,
queue, provider, DNS or secret. The source migration chain is contiguous
through `0079_phase1_completion_hardening.sql`.

## Completed fixes

- Scheduled billing runtime executes requested subscription changes with tenant-
  scoped claims, stable Dodo idempotency and retry-safe provider failures.
- Checkout response loss keeps the session pending and retries the same provider
  key; it never creates a second provider checkout from a new browser key.
- Initial payment failures release the active checkout row, suspend the
  subscription and expose an owner-only same-plan recovery checkout.
- Change-plan webhook handling accepts provider price evidence, performs direct
  Dodo subscription reconciliation when the event omits the price, updates the
  subscription plan/price snapshot, and completes the durable request only after
  signed or reconciled provider evidence.
- Worker cron expires stale checkout sessions/trials and rotates activation
  backfill through all shops. Shop-creation idempotent replay also retries the
  baseline activation milestones immediately.
- Activation projections are enum-only in application validation and D1 trigger
  guards. Restore validation covers checkout plan/price/provider, invoice
  account provider/currency, and invalid projection rows.
- Public marketing no longer labels Telegram as a current live launch channel;
  the copy identifies Website as current and Telegram as upcoming/pending
  acceptance.

## Artifacts

- `migrations/0079_phase1_completion_hardening.sql`
- `src/lib/billing/dodo.ts`
- `src/lib/billing/service.ts`
- `src/worker.ts`
- `src/lib/analytics/activation.ts`
- `src/lib/tenants/store.ts`
- `src/pages/app/billing.astro`
- `src/scripts/dashboard/billing.ts`
- `scripts/lib/backup.mjs`
- `tests/unit/dodo-billing.test.ts`
- `tests/unit/activation-analytics.test.ts`
- `tests/unit/backup-tools.test.ts`
- `tests/unit/worker-domain-delivery.test.ts`
- `tests/unit/paid-plan-billing-migrations.test.ts`

## Verification

- `npm run check`: 0 errors, existing 3 hints.
- `npm run lint`: passed.
- Focused R3 regression matrix: 8 files / 98 tests passed.
- Full Vitest suite: 243 files / 1,755 tests passed.
- `npm run build`: passed; the existing non-fatal mixed static/dynamic inventory
  crypto import warning remains.
- `npm run deploy:dry-run`: passed and exited before Wrangler mutation.
- `npm run deploy:staging:dry-run`: passed and exited before Wrangler mutation.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `git diff --check`: passed.

## External gates

Remote launch remains blocked until the committed candidate is independently
reviewed and admitted with a fresh protected staging backup/restore drill,
forward-only migration approval through `0079`, Dodo merchant/product/price/
webhook setup and UAT, PayOS/Telegram controlled pilot acceptance, legal/support
ownership, monitoring thresholds and rollback evidence. No provider secret or
production identifier is recorded in this package.
