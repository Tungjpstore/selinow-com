# Current Release Handoff - 2026-08-09

This is the non-secret handoff contract for the combined payment and non-payment
release. It records current evidence boundaries and external gates; it does not
authorize a production database migration, Worker deployment, route or DNS
change, secret write, provider mutation, pilot, or live charge.

## Candidate and staging state

The current continuation work adds provider-specific PayOS evidence admission,
safe Dodo pre-payment lifecycle acknowledgements, and release-trigger
hardening. These changes are not yet bound to a clean commit or Worker version;
the next staging ceremony must generate all manifests, backup/restore records,
and acceptance artifacts again.

- Reviewed runtime baseline before this documentation-only handoff commit:
  commit
  `dcfe4a62e98551083710ae32df0004f2336e6524`, tree
  `4489cc8fa123bd0126211c07f0bdacc5a235fe0e`. This is not a deployment
  admission identity after the documentation lands; the next ceremony must
  recapture the final clean commit and tree.
- Source migration ledger: contiguous `0001`-`0090`.
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
- Production remains at the admitted `0001`-`0052` D1 baseline and remains
  **NO-GO**.
- Current non-secret Dodo setup evidence is retained at
  `.wrangler/evidence/dodo-provider-20260809/dodo-reconciliation-redacted.json`;
  it records the configured catalog/webhook view, not completed UAT.

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

1. Generate a fresh manifest from the clean current candidate, deploy that exact
   tree to staging, and bind the resulting Worker version and deployment ID to
   the already complete `0090` D1 ledger.
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
  restore drill for the exact candidate and `0053`-`0090` continuation;
- accepted production secret-name inventory through the approved secret channel;
- current monitoring, pilot, manual Website/Telegram/payment/custom-domain
  acceptance, and rollback rehearsal evidence;
- passing full repository verification and `release:doctor`/closeout admission;
- a separately approved production mutation window.

Until every item is accepted, production remains **NO-GO** and expansion
channels remain `provider_pending`.
