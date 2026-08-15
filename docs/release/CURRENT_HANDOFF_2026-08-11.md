# Current Release Handoff - 2026-08-11

This is the non-secret handoff contract for the combined payment and
non-payment release. It records the current staging evidence and the remaining
admission gates. It does not authorize a production migration, deployment,
route or DNS mutation, provider activation, pilot, or live charge.

## Candidate identity

- Commit: `2df45cf5936755bf4e31fabbb06891de8789c271`.
- Tree: `34ac903aea8b737fa1860d6e6aaf99c454279eda`.
- Source and staging migration ledger: contiguous `0001`-`0095`, ending at
  `0095_telegram_generation_and_legacy_outbox_quarantine.sql`.
- Staging release ID: `stg_20260812T220654Z_2df45cf59367`.
- Private release manifest:
  `.wrangler/releases/staging/stg_20260812T220654Z_2df45cf59367/release-manifest.json`.
- Known staging Worker version:
  `27f29993-8a4e-422d-95b7-e4741e041c01`, active at 100% in the live staging
  deployment inventory (`fca770d2-9d3c-46ef-80e0-f715ec086106`). No production
  deployment is authorized or implied by this staging version.

Documentation changes made after this identity require a fresh clean commit
and, if release admission binds the documentation commit, a regenerated
manifest and staging deployment. The release owner must reject any commit,
tree, manifest, or Worker-version mismatch.

## Staging database evidence

The guarded staging release applied `0095` over the retained `0094` prefix,
recorded the complete `0001`-`0095` ledger, and completed fresh pre/post backup
and isolated-restore evidence for the exact candidate.
The candidate-bound evidence references are:

- Pre-migration backup: `bkp_20260812220540_90c8e42cb6f5`.
- Pre-migration isolated restore: `rdr_20260812220604_5072afcba031`.
- Post-migration backup: `bkp_20260812220810_48860113be6d`.
- Post-migration isolated restore: `rdr_20260812220835_a1d7f430b552`.
- Post-migration evidence:
  `.wrangler/releases/staging/stg_20260812T220654Z_2df45cf59367/post-migration-evidence.json`.
- Immutable deployment evidence:
  `.wrangler/releases/staging/stg_20260812T220654Z_2df45cf59367/deployment-evidence.json`.

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

Production remains **NO-GO** for migration and Worker deploy. Fresh live
evidence still shows runtime phase 6, D1 through `0052` with `0053`-`0095`
pending, missing current public routes such as `/solutions` and `/sitemap.xml`,
canonical Dodo webhook `404`, no production queue consumers, and no production
cron schedule. Shared-zone route ownership remains correct: production owns
`*/*`, `selinow.com/*`, and `*.selinow.com/*`; the four explicit staging
exceptions remain staging-owned.

A 2026-08-13 continuation-prep ceremony completed without mutating production
schema or traffic:

- Protected backup: `bkp_20260812221907_59e419a89383`.
- Isolated restore drill of that backup plus source `0053`-`0095`:
  `rdr_20260812221923_f9a186a00bf9` (integrity ok, zero foreign-key
  violations, temporary target removed).
- Platform doctor for production resources and SaaS DNS: pass.
- Live Worker secret names observed: nine of ten required names present;
  `DODO_PAYMENTS_WEBHOOK_KEY` remains absent. No secret values were recorded.

The owner deferred genuine Dodo/PayOS UAT. That deferral does not mark
commerce accepted and does not authorize payment collection. The remaining
mandatory gates before any production continuation are:

1. Combined release admission, including owner-accepted payment evidence or an
   explicit fail-closed non-payment release contract that the current doctor
   does not provide.
2. `DODO_PAYMENTS_WEBHOOK_KEY` bootstrap, production trigger/queue-consumer
   convergence, rollback rehearsal, monitoring, legal/support values, named
   approvals, and controlled pilots.

Production must not be migrated or deployed while those items are missing. The
product must not be described as able to collect payments.

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
