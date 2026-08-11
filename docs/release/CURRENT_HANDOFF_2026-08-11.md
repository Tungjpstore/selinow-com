# Current Release Handoff - 2026-08-11

This is the non-secret handoff contract for the combined payment and
non-payment release. It records the current staging evidence and the remaining
admission gates. It does not authorize a production migration, deployment,
route or DNS mutation, provider activation, pilot, or live charge.

## Candidate identity

- Commit: `3a44aadbcbe6a88115eb28743fcb19fa6af1cf5a`.
- Tree: `2795b2f91c1d9874c1182d56364516047ab358b8`.
- Source and staging migration ledger: contiguous `0001`-`0094`, ending at
  `0094_shop_creation_admission.sql`.
- Staging release ID: `stg_20260811T043926Z_3a44aadbcbe6`.
- Private release manifest:
  `.wrangler/releases/staging/stg_20260811T043926Z_3a44aadbcbe6/release-manifest.json`.
- Known staging Worker version:
  `2f80e24b-e9bc-4c25-9bdc-51916e4d1cb5`. No production deployment is
  authorized or implied by this staging version.

Documentation changes made after this identity require a fresh clean commit
and, if release admission binds the documentation commit, a regenerated
manifest and staging deployment. The release owner must reject any commit,
tree, manifest, or Worker-version mismatch.

## Staging database evidence

The guarded staging continuation applied `0091`-`0094` over the retained
`0090` prefix and recorded all 94 migration names in the completion evidence.
The candidate-bound evidence references are:

- Pre-migration backup: `bkp_20260811043704_c66884aa6ba2`.
- Pre-migration isolated restore: `rdr_20260811043754_195d99f18aa2`.
- Migration completion:
  `.wrangler/releases/staging/stg_20260811T043926Z_3a44aadbcbe6/migration-completion.json`.
- Post-migration backup: `bkp_20260811044142_68a80a977dbd`.
- Post-migration isolated restore: `rdr_20260811044225_e9bafe5eeb46`.
- Post-migration evidence:
  `.wrangler/releases/staging/stg_20260811T043926Z_3a44aadbcbe6/post-migration-evidence.json`.

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
`c812edd79203d23bdb61a833d93c8ca2bde48f4a` to this candidate contains these
25 files:

```text
docs/RUNBOOKS.md
docs/release/CURRENT_HANDOFF_2026-08-09.md
infra/environments/production.json
package.json
scripts/db.mjs
scripts/lib/backup.mjs
scripts/lib/commerce-uat-evidence.d.mts
scripts/lib/commerce-uat-evidence.mjs
scripts/lib/payos-uat-evidence.d.mts
scripts/lib/platform.d.mts
scripts/lib/platform.mjs
scripts/lib/release.mjs
scripts/lib/staging-release.mjs
scripts/lib/trigger-inventory.d.mts
scripts/lib/trigger-inventory.mjs
scripts/trigger-inventory.mjs
tests/unit/auth-magic-link-rate-limit.test.ts
tests/unit/db-post-migration-contract.test.ts
tests/unit/db-read-only-token.test.ts
tests/unit/payos-uat-evidence.test.ts
tests/unit/platform-scripts.test.ts
tests/unit/production-domain-infrastructure.test.ts
tests/unit/release-readiness.test.ts
tests/unit/staging-release-admission.test.ts
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

Production remains **NO-GO**. Read-only evidence still shows the old production
runtime and schema boundary: D1 through `0052`, health phase 6, missing current
public routes such as `/solutions`, `/sitemap.xml`, and `/llms.txt`, canonical
Dodo webhook `404`, and missing production queue consumers and current cron
schedule. Source-side corrections do not change that remote state.

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

The last full repository gate before the final release-tooling follow-ups
passed `npm run check`, `npm run lint`, `npx tsc --noEmit`, `npm test` (295
files, 2,295 tests), `npm run build`, `npm run build:staging`,
`npm audit --audit-level=high` (0 vulnerabilities), both deploy dry-runs, and
`git diff --check`. Subsequent candidate commits hardened PayOS payment-lane
acceptance, the production SaaS DNS contract, D1 token separation, backup
queries, and staging preflight admission with focused regression coverage.

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
