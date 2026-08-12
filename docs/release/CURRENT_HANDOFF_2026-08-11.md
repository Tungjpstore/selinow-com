# Current Release Handoff - 2026-08-11

This is the non-secret handoff contract for the combined payment and
non-payment release. It records the current staging evidence and the remaining
admission gates. It does not authorize a production migration, deployment,
route or DNS mutation, provider activation, pilot, or live charge.

## Candidate identity

- Commit: `92869a04a250b9d0d17941f287ca0024821e0267`.
- Tree: `c2bce000b0069ba4126b1f53ad5a17aa60109f3e`.
- Last deployed staging migration ledger: contiguous `0001`-`0094`, ending at
  `0094_shop_creation_admission.sql`.
- Current source ledger continues through
  `0095_telegram_generation_and_legacy_outbox_quarantine.sql` and requires a
  fresh clean commit, staging ceremony, and deployment evidence.
- Staging release ID: `stg_20260811T053816Z_92869a04a250`.
- Private release manifest:
  `.wrangler/releases/staging/stg_20260811T053816Z_92869a04a250/release-manifest.json`.
- Known staging Worker version:
  `97639e04-d3d1-49df-9914-94ad906152c6`, active at 100% in the live staging
  deployment inventory. No production deployment is
  authorized or implied by this staging version.

Documentation changes made after this identity require a fresh clean commit
and, if release admission binds the documentation commit, a regenerated
manifest and staging deployment. The release owner must reject any commit,
tree, manifest, or Worker-version mismatch.

## Staging database evidence

The guarded staging release revalidated the already complete `0001`-`0094`
ledger, recorded all 94 migration names, and completed fresh pre/post backup and
isolated-restore evidence for the exact candidate.
The candidate-bound evidence references are:

- Pre-migration backup: `bkp_20260811053627_91573bc7fa7e`.
- Pre-migration isolated restore: `rdr_20260811053655_8206c52ec592`.
- Migration completion:
  `.wrangler/releases/staging/stg_20260811T053816Z_92869a04a250/migration-completion.json`.
- Post-migration backup: `bkp_20260811054007_72a2f95717db`.
- Post-migration isolated restore: `rdr_20260811054034_63364d08dcce`.
- Post-migration evidence:
  `.wrangler/releases/staging/stg_20260811T053816Z_92869a04a250/post-migration-evidence.json`.

These private artifacts contain infrastructure identifiers and remain outside
version control. They prove the staging D1 continuation and restore drill only;
they do not prove payment-provider acceptance or production readiness.

## Runtime contracts and changed areas

The combined candidate exports or consumes these stable boundaries:

- authoritative Starter/Pro shop-creation admission and hash-only account,
  requester, subject, and global provisioning limits;
- signed single-use buyer order recovery with atomic order-token rotation;
- opaque seller order/customer pagination and provider-independent remediation;
- fail-closed channel readiness and Telegram delivery fencing;
- custom-domain hostname, SSL, DNS-target, Turnstile, cron, queue, and tenant
  isolation admission;
- Dodo and PayOS payment/subscription behavior through their owned billing and
  provider contracts, without treating return URLs or synthetic evidence as
  payment confirmation;
- separated Cloudflare D1, platform, route-audit, trigger-audit, deploy, and
  payment-mutation operator credentials; only secret names may enter release
  records.

The exact hardening delta from the previous handoff candidate
`c812edd79203d23bdb61a833d93c8ca2bde48f4a` to this deployed candidate contains
these 68 files:

```text
docs/RUNBOOKS.md
docs/DODO_PAYMENTS_RELEASE.md
docs/IMPLEMENTATION_STATUS.md
docs/PAYOS_RELEASE.md
docs/PRODUCTION_RELEASE.md
docs/PRODUCTION_RELEASE_CLOSEOUT_2026-08-09.md
docs/frontend-rebuild-handoff/API_ENDPOINT_INDEX.csv
docs/frontend-rebuild-handoff/DASHBOARD_INFORMATION_ARCHITECTURE.md
docs/frontend-rebuild-handoff/HANDOFF_MANIFEST.json
docs/frontend-rebuild-handoff/QUICK_START.md
docs/frontend-rebuild-handoff/README.md
docs/release/CURRENT_HANDOFF_2026-08-09.md
docs/release/CURRENT_HANDOFF_2026-08-11.md
infra/environments/production.json
package.json
scripts/db.mjs
scripts/lib/backup.mjs
scripts/lib/commerce-uat-evidence.d.mts
scripts/lib/commerce-uat-evidence.mjs
scripts/lib/dodo-uat-evidence.d.mts
scripts/lib/dodo-uat-evidence.mjs
scripts/lib/payos-uat-evidence.d.mts
scripts/lib/platform.d.mts
scripts/lib/platform.mjs
scripts/lib/release-closeout.mjs
scripts/lib/release.mjs
scripts/lib/staging-release.mjs
scripts/lib/trigger-inventory.d.mts
scripts/lib/trigger-inventory.mjs
scripts/dodo-uat-collect.mjs
scripts/dodo-uat-validate.mjs
scripts/payos-uat-artifact.d.mts
scripts/payos-uat-artifact.mjs
scripts/payos-uat-sign.d.mts
scripts/payos-uat-sign.mjs
scripts/payos-uat-validate.d.mts
scripts/payos-uat-validate.mjs
scripts/trigger-inventory.mjs
src/lib/domains/store.ts
src/lib/payments/reconciliation.ts
src/lib/payments/staging-uat-reconciliation.ts
src/pages/api/app/shops/[shopPublicId]/domains/[domainId].ts
src/pages/api/app/shops/[shopPublicId]/payments/payos/uat-reconciliation.ts
src/scripts/storefront/checkout.ts
src/scripts/storefront/order-access-storage.ts
src/scripts/storefront/order.ts
tests/unit/auth-magic-link-rate-limit.test.ts
tests/unit/buyer-order-recovery-ui.test.ts
tests/unit/dashboard-information-architecture.test.ts
tests/unit/db-post-migration-contract.test.ts
tests/unit/db-read-only-token.test.ts
tests/unit/dodo-uat-evidence.test.ts
tests/unit/dodo-uat-tooling.test.ts
tests/unit/domain-delete-route.test.ts
tests/unit/domain-store.test.ts
tests/unit/operational-migration-ledger-docs.test.ts
tests/unit/payos-staging-uat-reconciliation.test.ts
tests/unit/payos-uat-evidence.test.ts
tests/unit/payos-uat-tooling.test.ts
tests/unit/platform-scripts.test.ts
tests/unit/production-domain-infrastructure.test.ts
tests/unit/provider-surface-audit.test.ts
tests/unit/release-closeout-audit.test.ts
tests/unit/release-readiness.test.ts
tests/unit/staging-release-admission.test.ts
tests/unit/storefront-buyer-contracts.test.ts
tests/unit/storefront-order-access-storage.test.ts
tests/unit/trigger-inventory.test.ts
```

The earlier runtime continuation summarized by the contracts above includes
the onboarding, buyer access, commerce, Telegram, domain, security, operations,
provider, and migration `0091`-`0094` work already present in the previous
handoff candidate. Release closeout must regenerate the exact full accepted
commit-range inventory after this documentation lands.

Required secret or environment names are recorded by the release tooling only.
They include `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY`, the approved
PayOS staging channel identity fingerprint binding, and scoped Cloudflare
operator-token names. No value, provider credential, customer token, license
key, or webhook payload belongs in this handoff.

## Provider status

The combined staging release remains `provider_pending`.

- Dodo TEST UAT is not accepted. A canonical route, secret-name inventory, or
  unsigned-request rejection does not prove provider registration, signed
  delivery, subscription transition, replay/conflict handling, lifecycle
  behavior, or the required release-bound scenario evidence.
- PayOS controlled-staging UAT is not accepted. A fingerprint record alone does
  not prove tenant ownership or a real transaction. Acceptance still requires
  the controlled channel plus the signed exact-payment and direct-reconciliation
  scenarios, redacted and bound to this release identity. Refund and chargeback
  remain explicit `provider_unsupported` capabilities until provider execution
  exists.
- Telegram Mini App, WhatsApp Cloud, Discord Bot, Zalo Mini App, and Zalo OA
  remain `provider_pending`. They cannot expose activation, checkout,
  fulfillment, or a fake connected state.
- No return URL, QR rendering, test catalog, webhook registration, synthetic
  signature, or secret-name inventory can mark an order or subscription paid.

The payment owner must provide one accepted, redacted handoff for Dodo and
PayOS that is bound to the exact release ID, manifest hash, commit, tree, and
staging Worker version used by the non-payment lane.

## Production NO-GO

Production remains **NO-GO**. Fresh read-only evidence still shows the old production
runtime and schema boundary: D1 through `0052`, health phase 6, missing current
public routes such as `/solutions`, `/sitemap.xml`, and `/llms.txt`, canonical
Dodo webhook `404`, no production queue consumers, no production cron schedule,
and nine of ten required Worker secret names with
`DODO_PAYMENTS_WEBHOOK_KEY` absent. The shared-zone route ownership itself is now
correct: production owns `*/*`, `selinow.com/*`, and `*.selinow.com/*`; the four
explicit staging exceptions remain staging-owned. Source-side corrections do not
change the other remote blockers.

The following gates remain mandatory before any production continuation:

1. Accepted Dodo TEST and PayOS controlled-staging UAT bound to the exact
   combined staging release.
2. Fresh full staging journey acceptance for onboarding, Website and Telegram
   commerce, buyer recovery, seller operations, privacy, custom domains,
   Turnstile, tenant isolation, queues, DLQ, cron, and rollback.
3. Clean reviewed final commit/tree plus passing full repository verification,
   release doctor, migration admission, and immutable evidence index.
4. Fresh protected production backup and isolated restore drill for the
   `0053`-`0094` continuation, with a reviewed rollback target and mutation
   window.
5. Production Worker secret-name inventory, route/domain/hostname/SSL/DNS,
   Turnstile, queue-consumer, cron, and monitoring admission.
6. Named release, data, payment, security, legal, support, domain, and incident
   approvals; owner-approved legal/support/refund/privacy values; controlled
   pilots; acknowledgement tests; and observation windows.

Production must not be migrated or deployed while any item is missing. The
product must not be described as able to collect payments until the payment
handoff and combined release admission are accepted.

## Verification boundary

The exact deployed candidate passed `npm run check` (766 files, zero errors),
`npm run lint`, `npx tsc --noEmit`, `npm test` (301 files, 2,325 tests),
`npm run build`, `npm run build:staging`, `npm audit --audit-level=high` (zero
vulnerabilities), both deploy dry-runs, and `git diff --check`.

The final exact-HEAD closeout must rerun the complete required sequence before
release admission:

```bash
npm run check
npm run lint
npx tsc --noEmit
npm test
npm run build
npm run build:staging
npm audit --audit-level=high
npm run deploy:dry-run
npm run deploy:staging:dry-run
npm run release:doctor -- --json
git diff --check
```

Documentation closeout must also rerun the operational migration-ledger docs
test. Any later source, evidence, or release-tooling change invalidates the
recorded totals until the full gate is rerun.
