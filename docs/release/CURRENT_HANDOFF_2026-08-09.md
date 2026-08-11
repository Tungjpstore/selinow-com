# Current Release Handoff - 2026-08-09

This is the non-secret handoff contract for the combined payment and non-payment
release. It records current evidence boundaries and external gates; it does not
authorize a production database migration, Worker deployment, route or DNS
change, secret write, provider mutation, pilot, or live charge.

## Candidate and staging state

The current continuation work adds provider-specific PayOS evidence admission,
safe Dodo pre-payment lifecycle acknowledgements, and release-trigger
hardening. The clean source candidate is commit
`a02e098e9a05454261770d3c90c9aeaed151a2af`, tree
`14f9f68afd6fbadbb689171a4ad6bbc9cb405652`. It has not been deployed to a
new staging Worker version; the next staging ceremony must generate fresh
manifest, backup/restore, deployment, and acceptance artifacts for this exact
identity.

- Reviewed runtime baseline before this documentation-only handoff commit:
  commit
  `dcfe4a62e98551083710ae32df0004f2336e6524`, tree
  `4489cc8fa123bd0126211c07f0bdacc5a235fe0e`. This is not a deployment
  admission identity after the documentation lands; the next ceremony must
  recapture the final clean commit and tree.
- Source migration ledger: contiguous `0001`-`0093`.
- Staging D1 post-migration evidence: release
  `stg_20260808T235913Z_73d0c27493ea`, commit
  `73d0c27493ea10fbeacd2e4b6b6f2f923cc99cfd`, tree
  `d445e8409dc1f2b537c39b2e08dad69a228db9f7`, with all 90 migrations through
  `0090_payos_provider_claim_clear_guard.sql` and passing post-migration
  backup/restore evidence. The private references are the release's
  `migration-completion.json` and `post-migration-evidence.json` files under
  `.wrangler/releases/staging/`.
- Latest retained staging Worker deployment evidence: deployment
  `2400fc01-fd71-4c91-93e7-7a93a44a4216`, Worker version
  `6688b21f-401e-43b2-95b5-a0e9434167a2`, commit
  `17922377aa6bd0893c5c4aae206ac78d0208875d`, tree
  `9d44eb6a9318a1b5c94fc012c3573b3f4e31611a`.
- The staging D1 continuation and the retained Worker deployment are different
  candidate identities, and both predate the reviewed runtime baseline. That
  baseline is therefore not staging-deployed or staging-accepted.
- Migrations `0091_buyer_order_access_recovery.sql` through
  `0093_custom_domain_turnstile_runtime_guard.sql` and their runtimes are newer
  than both retained staging artifacts. Staging therefore remains at `0090`
  until a fresh exact-candidate migration/backup/restore/deploy ceremony passes.
- Production remains at the admitted `0001`-`0052` D1 baseline and remains
  **NO-GO**.
- Current non-secret Dodo setup evidence is retained at
  `.wrangler/evidence/dodo-provider-20260809/dodo-reconciliation-redacted.json`;
  it records the configured catalog/webhook view, not completed UAT.

## Candidate handoff details

- Additional uncommitted schema change after the recorded clean candidate:
  `0091_buyer_order_access_recovery.sql`. The subsequent `0092` and `0093`
  custom-domain Turnstile migrations are committed, so the worktree source
  migration ledger is contiguous through `0093`; no remote database contains
  `0091`-`0093` as a result of this handoff update.
- Runtime contracts changed: Dodo signed-event rejection/replay behavior,
  PayOS UAT schema-v2 owner-attestation and scenario-artifact validation,
  production trigger plan/evidence/rollback validation, opaque seller order and
  customer cursors, retry-safe Website checkout recovery, signed single-use
  buyer order recovery with atomic order-token rotation, deterministic current
  token replay, exact-order binding lineage, 30-day contact/link hash scrubbing
  and anonymization revocation, and fail-closed
  WhatsApp ingress admission.
- Principal changed files: `src/lib/billing/service.ts`,
  `src/lib/channels/whatsapp-webhooks.ts`,
  `src/lib/commerce/seller-orders.ts`,
  `src/lib/commerce/buyer-order-recovery.ts`,
  `src/lib/commerce/website-checkout-recovery.ts`,
  `src/pages/api/store/orders/[orderPublicId]/recovery.ts`,
  `src/pages/api/store/orders/[orderPublicId]/recovery/consume.ts`,
  `src/lib/tenants/seller-management.ts`,
  `scripts/lib/payos-uat-evidence.mjs`,
  `scripts/lib/commerce-uat-evidence.mjs`,
  `scripts/lib/production-trigger-ceremony.mjs`,
  `scripts/production-trigger.mjs`, and their unit/visual contracts.
- Required secret/env names only: existing Worker secret inventory plus
  `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY`, temporary scoped
  Cloudflare staging/production admission tokens, and the non-secret PayOS
  owner-attestation public-key binding
  `SELINOW_PAYOS_UAT_ATTESTATION_KEY_ID` /
  `SELINOW_PAYOS_UAT_ATTESTATION_PUBLIC_KEY_PEM_BASE64`. No value is recorded
  in this handoff.
- Verification on the earlier clean candidate: `npm run check` (0 errors, 3 hints),
  `npm run lint`, `npx tsc --noEmit`, `npm test` (282 files / 2,094 tests),
  `npm run build`, `npm run build:staging`, `npm audit --audit-level=high` (0
  vulnerabilities), both deploy dry-runs, and `git diff --check` pass.
- The `0091` buyer recovery continuation has focused local
  migration/service/route/UI/release contract evidence, and the committed
  `0092`-`0093` domain continuation has migration/runtime guard coverage, but
  current full-tree verification and exact clean commit/tree are pending this
  batch's closeout and must replace the earlier totals before release admission.
- Known limitations: staging backup/restore and deploy evidence are not bound to
  this commit; Dodo TEST UAT is not accepted; PayOS controlled real-transaction
  UAT and owner signature are absent; legal/support decisions, named approvals,
  pilots, monitoring, production backup/restore, rollback, secrets, migrations,
  and production deploy remain blocked.
- Integration assumptions: billing/provider acceptance stays fail-closed;
  unsupported expansion channels remain `provider_pending`; refund provider
  execution is not claimed; no return URL or synthetic payload can mark an
  order or subscription paid.

## Payment lane contract

The payment owner supplies release-bound provider evidence and owns all payment
readiness claims. Configuration or source tests alone cannot satisfy this lane.

Required Dodo TEST evidence:

1. Confirm the rotated four-offer TEST catalog and enabled canonical staging
   webhook without recording provider secrets or checkout URLs.
2. Deploy the exact combined candidate first, then run provider-created
   Starter/Pro and VND/USD checkouts against that Worker version.
3. Deliver signed provider events and prove authoritative D1 subscription state,
   idempotent duplicate handling, conflicting/stale/out-of-order rejection,
   amount/currency/provider/tenant mismatch handling, payment failure and
   recovery, renewal/grace, plan changes, cancellation/resume, response-loss and
   concurrent-checkout behavior.
4. Complete all 32 scenarios in the Dodo UAT evidence contract, including
   redaction, tenant isolation, and storage/log/queue/audit checks.
5. Bind the redacted artifact to the exact release ID, manifest path and hash,
   commit, tree, Worker version, request/event/session references, and safe
   fingerprints. A registered webhook with an empty delivery log is not UAT.

Required PayOS controlled-staging evidence:

1. Admit one controlled seller channel with the exact tenant-owned credential
   fingerprint and canonical webhook identity.
2. Complete the provider-required scenarios `signed_exact_payment` and
   `direct_reconciliation` with a real low-value VND transaction using the
   controlled production API. Local assurance scenarios (signature/replay,
   mismatch, tenant isolation, and exactly-once fulfillment) are recorded
   separately. `signed_refund` and `signed_chargeback` are explicit
   `provider_unsupported` capability gaps; they must never be fabricated or
   relabeled as provider acceptance.
3. Bind the redacted artifact to the same release ID, manifest hash, commit,
   tree, and Worker version used by Dodo and the non-payment lane.

The payment lane must not infer payment from a return URL, QR display, catalog,
webhook registration, unauthenticated route probe, or synthetic signature. It
must not claim live payments, refunds, fulfillment, or production readiness
until the provider-created evidence is accepted.

## Non-payment lane contract

The non-payment owner supplies the deploy, platform, tenant, channel, operations,
and customer-journey evidence for the exact combined candidate.

Required staging evidence:

1. Generate a fresh manifest from the clean current candidate, admit and apply
   `0091`-`0093` over the retained `0090` staging ledger, complete the two-phase
   backup/restore evidence, deploy that exact tree, and bind the resulting
   Worker version and deployment ID to the complete `0093` D1 ledger.
2. Re-run route/domain inventory, health, Website and Telegram flows,
   custom-domain and Turnstile admission, queue consumers, DLQ, cron, and
   tenant-isolation checks. Capture a schema-compatible rollback target.
3. Complete first-admin bootstrap, session/recovery, buyer privacy/legal
   decisions, fulfillment parity, and two controlled seller pilots with named
   support and incident owners.
4. Record monitoring and budget dashboards, thresholds, destinations,
   acknowledgement tests, and the 5m/15m/1h/next-day observation windows.
5. Keep Telegram Mini App, Zalo Mini App, Zalo OA, WhatsApp Cloud, Discord, and
   other expansion channels at `provider_pending` until each provider supplies
   ownership, credential, webhook, outbound/inbound, policy, and seller-consent
   acceptance.

The non-payment lane must not infer an active subscription, collectible payment,
refund execution, or paid fulfillment from source behavior or provider setup.

## Combined admission rule

Release admission is conjunctive. The release owner accepts the handoff only
when both lanes use the same exact commit, tree, release ID, manifest hash, and
Worker version, and all required artifacts are current, redacted, immutable, and
reviewed. Any identity drift or missing provider/operations artifact fails
closed.

Before any production continuation, the release owner must additionally obtain:

- named release, data, payment, security, legal, support, domain, and incident
  approvals;
- a fresh protected production backup and provider bookmark plus an isolated
  restore drill for the exact candidate and `0053`-`0093` continuation;
- accepted production secret-name inventory through the approved secret channel;
- current monitoring, pilot, manual Website/Telegram/payment/custom-domain
  acceptance, and rollback rehearsal evidence;
- passing full repository verification and `release:doctor`/closeout admission;
- a separately approved production mutation window.

Until every item is accepted, production remains **NO-GO** and expansion
channels remain `provider_pending`.
