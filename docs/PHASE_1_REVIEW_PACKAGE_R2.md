# Selinow Phase 1 Review Package R2

Status: candidate for independent R2 review; remote launch remains **NO-GO**

Reviewed locally: 2026-08-03 (Asia/Tokyo)

## Candidate boundary

- Branch: `codex/landing-page-deploy-20260801`
- HEAD: `1144ae7b7021e6d6828cfebfb68f403fc6a2c2b0`
- Current porcelain boundary: 330 entries (`172` modified, `31` deleted,
  `127` untracked). This includes pre-existing frontend/provider/release work;
  no wholesale staging or cleanup was performed.
- Source migrations are contiguous `0001`-`0078`. Staging remains at `0028`
  and production at `0052`; no remote migration, deploy, DNS, secret, or
  provider mutation was performed.

## R1 findings and R2 treatment

1. **Subscription changes were request-only.** Added migration-backed durable
   execution metadata and Dodo POST change-plan/PATCH cancellation adapters.
   Execution claims a tenant-bound request, uses a stable HMAC idempotency key,
   retries provider failures, and completes only from signed webhook or direct
   reconciliation evidence. Starter upgrades are immediate; Pro downgrades are
   scheduled for the next billing date.
2. **Checkout could block a shop.** Added request-time expiration, terminal
   expiry transitions, official Dodo retrieve replay, replacement/recovery
   checkout handling, active-session uniqueness, and suspended initial-payment
   recovery. Checkout URLs are not persisted or logged.
3. **Webhook tenant mapping was unsafe.** Migration `0078` enforces unique
   Dodo subscription references and provider-scope guards. Webhook lookup now
   requires supplied identifiers to agree, rejects cross-tenant collisions, and
   records only safe identity evidence.
4. **Archived products bypassed quota.** Product quota now counts current
   non-archived rows per tenant, guards create/reactivation atomically, preserves
   rollback and idempotent replay, and treats usage metering as recoverable
   projection rather than authority.
5. **Activation was 4/12 and loss-prone.** All 12 milestones have authoritative
   server emitters, typed allowlisted projections, tenant-scoped idempotency,
   and deterministic D1 backfill from source-of-truth state. Commerce remains
   non-blocking when telemetry writes fail.
6. **Marketing overstated readiness.** Public pricing filters pending/invalid
   Dodo references, suppresses purchase Offers/CTAs until a complete market is
   ready, and uses truthful pilot/setup wording for unaccepted providers.
7. **Restore omitted billing/activation evidence.** Backup schema/count gates
   now cover plans/prices, subscriptions, billing ledgers, usage ledgers and
   activation milestones, with FK and cross-ledger mismatch checks. Forward
   migration-seeded rows are allowed to increase counts; loss still fails.

## Artifacts and migration

- `migrations/0078_dodo_billing_hardening.sql`
- Billing: `src/lib/billing/service.ts`, `src/lib/billing/dodo.ts`,
  `src/lib/tenants/billing-requests.ts`, billing tests.
- Quota: `src/lib/catalog/store.ts` and catalog regression tests.
- Activation: `src/lib/analytics/activation.ts`, commerce/payment/Telegram/
  readiness emitters, and activation integration tests.
- Marketing: `src/lib/storefront/marketing.ts`, `src/pages/pricing.astro`,
  `src/pages/index.astro`, marketing catalogs and runtime tests.
- Restore: `scripts/lib/backup.mjs`, `scripts/lib/backup.d.mts`,
  `tests/unit/backup-tools.test.ts`, `docs/DATA_LIFECYCLE.md`.

## Verification evidence

- `npx astro check`: pass, 0 errors, 3 hints.
- `npm run lint`: pass.
- R2 focused matrix: 11 files, 107 tests passed.
- `npm test`: 243 files, 1,748 tests passed.
- `npm run build`: pass; existing non-fatal Vite ineffective dynamic import
  warning remains for `src/lib/crypto/inventory.ts`.
- `npm run build:staging`: pass.
- `npm run deploy:dry-run`: pass; exits before Wrangler mutation.
- `npm run deploy:staging:dry-run`: pass; exits before Wrangler mutation.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `git diff --check`: pass.
- Disposable migration drill: 78 files, SQLite integrity `ok`, foreign-key
  check zero rows, latest migration `0078_dodo_billing_hardening.sql`.
- Local backup/restore drill: pass; integrity `ok`, FK violations `0`, restored
  item count `614`.
- Public browser gate: 27/27 passed after pricing accessibility fix and
  snapshot refresh; authenticated gate: 7/7 passed.

## External requirements and limitations

- Dodo merchant review, live product/price references, webhook secret, tax/VND
  treatment, refunds/invoices, and provider UAT remain external requirements.
- PayOS and Telegram acceptance, seller pilots, legal/support ownership,
  monitoring thresholds, protected staging backups, clean-tree admission and
  remote migration approval remain pending.
- No production D1, R2, KV, queues, bots, provider APIs, secrets or DNS were
  mutated by this R2 work. Local browser/test fixtures are not provider proof.
- Historical R0/R1 documents and unrelated handoff artifacts retain their
  original checkpoint claims; they are not rewritten as if history changed.

## Review decision

Local candidate is ready for independent R2 review only. It is not a production
approval. Keep remote launch **NO-GO** until the reviewer verifies provider
contracts, migration admission, restore evidence, tenant isolation and the
clean reviewed tree.

## Reviewer focus

- Reconcile Dodo operation idempotency and webhook completion after response
  loss, timeout, duplicate delivery, and downgrade scheduling.
- Attempt duplicate/cross-tenant provider references and renewal events without
  metadata.
- Exercise archived-product reactivation at the quota boundary concurrently.
- Verify all 12 milestone emitters and deterministic backfill against source
  state, including Website and Telegram first paid fulfillment.
- Confirm public pricing cannot expose `pending:*` references or purchasable
  structured Offers before provider readiness.
- Simulate missing billing/activation tables, rows, FK links and cross-ledger
  identity mismatches during restore.
