# Non-payment production handoff - 2026-08-08

## Candidate identity

- Runtime implementation commit: `3c598fcf242127891e8fe4112720938cc3592c4e`
- Runtime implementation tree: `3bf5cb32aab3d23060042aabd3f97ac7d20ff696`
- Handoff identity: the final release manifest must bind the clean reviewed HEAD that contains this document; a committed file cannot safely self-record its own commit hash.
- Production readiness: not claimed. A protected staging backup and candidate-bound isolated restore drill were executed as pre-admission evidence; authoritative staging/production databases, Workers, routes, DNS, queues and provider configuration were not mutated by that drill.

## Non-payment changed files

Onboarding and tenancy:

- `migrations/0082_account_trial_claims.sql`
- `src/components/dashboard/OnboardingWizard.astro`
- `src/lib/dashboard/onboarding-ui.ts`
- `src/lib/i18n/catalogs/onboarding.ts`
- `src/lib/tenants/store.ts`
- `src/pages/api/app/shops/index.ts`
- `src/scripts/dashboard/onboarding.ts`
- `tests/unit/onboarding-i18n-contract.test.ts`
- `tests/unit/shop-country-service.test.ts`

Commerce and seller operations:

- `src/lib/commerce/checkout-transaction.ts`
- `src/lib/commerce/policy.ts`
- `src/lib/commerce/seller-orders.ts`
- `src/lib/tenants/seller-management.ts`
- `src/pages/api/app/shops/[shopPublicId]/customers/index.ts`
- `src/pages/api/app/shops/[shopPublicId]/orders/index.ts`
- `tests/unit/commerce-checkout-admission-policy.test.ts`
- `tests/unit/commerce-channel-parity-real-d1.test.ts`
- `tests/unit/commerce-store-zero-total-fulfillment.test.ts`
- `tests/unit/order-channel-attribution.test.ts`
- `tests/unit/seller-surface-contracts.test.ts`

Telegram:

- `src/lib/commerce/payment-events.ts`
- `src/lib/commerce/telegram-port.ts`
- `src/lib/telegram/credentials.ts`
- `src/lib/telegram/commerce.ts`
- `src/lib/telegram/integrations.ts`
- `src/lib/telegram/webhooks.ts`
- `src/worker.ts`
- `tests/unit/telegram-generic-connection-runtime.test.ts`
- `tests/unit/worker-domain-delivery.test.ts`

Domains and release infrastructure:

- `infra/environments/production.example.json`
- `infra/environments/production.json`
- `infra/environments/staging.json`
- `scripts/lib/platform.mjs`
- `scripts/lib/production-promotion-staging.mjs`
- `scripts/lib/release.mjs`
- `src/lib/domains/store.ts`
- `src/lib/storefront/abuse.ts`
- `tests/unit/platform-scripts.test.ts`
- `tests/unit/production-bootstrap.test.ts`
- `tests/unit/production-domain-infrastructure.test.ts`
- `tests/unit/production-promotion-staging.test.ts`
- `tests/unit/release-readiness.test.ts`
- `tests/unit/storefront-abuse.test.ts`
- `wrangler.jsonc`

Security and account operations:

- `migrations/0083_auth_admission_subject_limits.sql`
- `migrations/0084_checkout_recovery_capabilities.sql`
- `migrations/0085_buyer_privacy_lifecycle.sql`
- `migrations/0086_platform_admin_bootstrap_receipt.sql`
- `src/lib/auth/admission.ts`
- `src/lib/auth/session.ts`
- `src/lib/operations/logger.ts`
- `src/lib/platform/bindings.ts`
- `src/pages/api/auth/sessions.ts`
- `src/pages/api/app/shops/[shopPublicId]/customers/[customerPublicId]/privacy.ts`
- `scripts/platform-admin-bootstrap.mjs`
- `scripts/lib/platform-admin-bootstrap.mjs`
- `scripts/worker-typegen.mjs`
- `scripts/lib/worker-typegen.mjs`
- `scripts/lib/worker-typegen.d.mts`
- `tests/integration/non-payment-release-contract.test.ts`
- `tests/unit/auth-magic-link-rate-limit.test.ts`
- `tests/unit/logger.test.ts`

Release evidence and inventories:

- `docs/IMPLEMENTATION_STATUS.md`
- `docs/NON_PAYMENT_PRODUCTION_HANDOFF_2026-08-08.md`
- `docs/RUNBOOKS.md`
- `docs/frontend-rebuild-handoff/API_ENDPOINT_INDEX.csv`
- `package-lock.json`
- `tests/unit/admin-shop-directory.test.ts`
- `tests/unit/provider-surface-audit.test.ts`
- `tests/unit/worker-typegen.test.ts`

## Schema and exported contracts

- `0082_account_trial_claims.sql`: durable one-trial-per-account claim with a primary-key concurrency fence.
- `0083_auth_admission_subject_limits.sql`: email-subject admission hash and soft delivery suppression state.
- `GET /api/app/shops`: returns only assignable public `starter`/`pro` plans and authoritative localized price/feature data.
- `POST /api/app/shops`: atomically creates the tenant graph and rejects replay mismatch, duplicate slug, concurrent second trial and expired trial creation.
- Seller order/customer collections accept validated bounded `limit` and `cursor` and return `nextCursor`.
- `GET /api/auth/sessions` lists safe session metadata; `DELETE /api/auth/sessions` revokes all sessions with CSRF and recent-auth admission.
- Paid-order Telegram notification authority is domain event -> delivery job -> queue. Legacy paid-order Telegram outbox enqueue/cron processing is removed.
- Telegram catalog and canonical checkout both reject active private-file products; buyers must use the Website delivery path.
- Checkout recovery capabilities are durable, signed, expiring, tenant/cart/request-bound and atomically single-use; replay returns `checkout_recovery_consumed`.
- Buyer privacy export is allowlisted and replay-safe; anonymization blocks active operational records and retains financial/audit references.
- First-admin bootstrap requires an explicit owner-confirmed ceremony, an exact active user, empty admin/receipt state and a durable receipt; migrations never seed admins.
- Expansion channels remain `provider_pending` at activation/runtime admission until external evidence, while verified ingress contracts remain separately testable.
- Wrangler type generation is wrapped and normalized mechanically so Cloudflare `Env` remains generated without narrowing global `NodeJS.ProcessEnv`.
- Production owns `*/*`; staging owns only explicit staging domains and `*.staging.selinow.com/*`. Custom-host Turnstile admission requires exact tenant/domain readiness.

## Billing/payment integration assumptions

- The payment workstream owns migration `0081_dodo_catalog_contract.sql`, billing runtime, provider secrets, PayOS/Dodo acceptance and refund execution.
- Onboarding consumes the existing public plan/catalog and subscription-placeholder contracts without modifying `src/lib/billing/**`.
- Subscription/entitlement-dependent capabilities remain fail-closed until the payment handoff is accepted.
- No claim is made that Selinow can collect money, reconcile providers or execute refunds.

## Required environment and secret names

No new provider secret was created. Existing names consumed by these changes are:

- `IDENTIFIER_HMAC_SECRET`
- `MAGIC_LINK_SECRET`
- `SESSION_SECRET`
- `TURNSTILE_SECRET_KEY`
- `TURNSTILE_SITE_KEY`
- `CLOUDFLARE_ZONE_ID`
- `SAAS_CNAME_TARGET`

Values must remain in Cloudflare secrets or reviewed environment configuration and must not appear in evidence.

## Verification

- Targeted Agent F integration/release contracts: 14/14 pass, including isolated replay of all 86 source migrations with `integrity_check=ok` and zero foreign-key violations.
- `npm run check`, `npm run lint` and `npx tsc --noEmit`: pass on the runtime implementation candidate.
- `npm test`: 270 files / 1,923 tests pass on the runtime implementation candidate.
- Production/staging builds, both deploy dry-runs and `npm audit --audit-level=high`: pass on the runtime implementation candidate; rerun them against the final handoff HEAD before release admission.
- `npm run release:doctor -- --json`: fail-closed as expected on missing approvals, backup/restore evidence, candidate identity, monitoring, pilot, secrets and PayOS/Dodo acceptance.
- `git diff --check`: pass.

## Known limitations and external requirements

- Buyer privacy pages remain policy-blocked pending owner/legal approval; the underlying export/anonymization service is implemented and fail-closed.
- Refund provider execution remains unsupported until the payment handoff supplies it.
- Seller pagination uses validated offset cursors, not snapshot-stable keyset pagination.
- TXT ownership and CNAME setup remain manual; Selinow automates only hostname/SSL polling after DNS is correct.
- Production and staging migrations remain blocked until contiguous-ledger review through `0086`, protected backup/restore evidence, approved staging execution and UAT evidence, and a generated manifest bound to this candidate are available.
