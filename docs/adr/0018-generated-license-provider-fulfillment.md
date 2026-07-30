# ADR 0018: Seller webhook generated-license fulfillment

## Status

Accepted (source/local-only)

## Date

2026-07-30

## Context

The generic entitlement graph can describe a generated license, but a seller
needs a bounded provider execution path that does not move provider authority
into the commerce core. The execution path must preserve D1 tenant and payment
authority, survive ambiguous network outcomes, and keep provider credentials
and generated artifacts out of queues, logs, exports and immutable evidence.

## Decision

- Migrations `0049_generated_license_fulfillment.sql`,
  `0050_generated_license_deletion_lifecycle.sql` and
  `0051_generated_license_rotation.sql` add eight tenant-scoped tables:
  provider connections, provider credentials, resource bindings, requirement
  snapshots, requests, attempts, artifacts and generated-license dead letters.
  `0052_generated_license_request_hardening.sql` adds canonical request
  creation/terminal-evidence guards and scheduler/key-version indexes.
  D1 is authoritative for configuration, request state, retry/reconciliation,
  artifact state and operator remediation state. Bounded v1 permits one
  generated artifact per entitlement (`grant_quantity = 1`, ordinal `1`).
- The first adapter is `seller.webhook`. It receives no D1 binding, posts a
  versioned provider-neutral request with a stable idempotency key, and only
  normalizes provider results. Provider credentials and artifact plaintext are
  materialized only in bounded request/provider-call/reveal memory.
- Provider credentials use the credential key family and AES-GCM envelopes.
  Each endpoint/credential field uses AAD
  `generated-license-provider-secret:v1\0{keyVersion}\0{shopId}\0{connectionId}\0{credentialId}\0{field}`.
  Generated artifacts use the inventory key family and a separate AAD
  `generated-license-artifact:v1\0{keyVersion}\0{shopId}\0{requestId}\0{artifactId}\0{format}`.
  Tenant/purpose-bound HMAC fingerprints support equality and incident checks
  without storing plaintext.
- Queue and DLQ records are reference-only. A generated-license queue envelope
  contains the shop ID, generated request ID and safe operation/reference
  fields; the generated-license DLQ stores safe context and hashes only. No
  credential, provider payload, customer secret or license artifact plaintext
  is persisted in those records.
- A request is created only after an active generic entitlement and grant
  exist: free checkout after the `free_checkout` grant is committed, or paid
  checkout after the exact signed/claimed unprocessed `paid_exact` payment
  event activates the entitlement. Website, Telegram and `fake.third` use the
  same canonical checkout and payment-activation transactions.
- `408`, `425`, `429` and `5xx` provider responses are retryable. Network
  failures and invalid successful responses are ambiguous and enter
  `reconcile_pending`; the next provider call is `reconcile`, never a second
  `generate`. Exhausted or permanent failures retain immutable attempt
  evidence and open the generated-license DLQ for operator resolution.
- A verified exact payment reversal is a local D1 access fence. It cancels
  pending, retryable, reconcile-pending and processing generated-license
  requests, revokes active generated artifacts, and retains immutable request,
  attempt, fulfillment and consumption evidence. It performs no provider I/O;
  partial, mismatched or unverified evidence remains manual review and does not
  revoke access.
- Deletion remains behind the existing active-payment, grace, legal-hold and
  lease fences. It retires bindings/connections, cancels non-terminal local
  work, destroys credential and artifact ciphertext, and retains requirement,
  request, attempt, DLQ, financial and audit evidence. Provider cleanup and
  crypto-shred are recorded as resumable steps.
- Credential and artifact re-encryption are separate resumable rotation
  families: `generated_license_credentials` uses the credential key family and
  `generated_license_artifacts` uses the inventory key family. Rotation changes
  only encrypted envelopes and fingerprints under a lease; it never rewrites
  identity or immutable evidence.
- Standard seller export is schema version 5 and exposes safe generated-license
  metadata only. It excludes ciphertext, IVs, key versions, fingerprints,
  endpoints, credentials, provider references and artifact plaintext. Protected
  backup and isolated restore validation cover all eight generated-license
  tables and their schema/count contracts.

## Consequences

- Generated-license fulfillment is executable without making a provider the
  source of truth or coupling provider types to checkout, payment or D1 code.
- Ambiguous outcomes require reconciliation before retry, so an accepted
  provider request is not duplicated merely because the Worker lost a response.
- The feature has a larger retention and operator surface: attempts, requests,
  safe DLQ state, hashes and audit records remain after reversal or deletion.
- The implementation is source/local-only. Staging still has 28 applied
  migrations through `0028` and 24 pending migrations `0029`-`0052`; no
  staging migration/deploy or production mutation is claimed. Production is
  untouched and remains `NO-GO`.

## Revisit triggers

Revisit before supporting quantities above one, provider-side revoke calls,
additional provider protocols, Telegram secure handoff, automatic external
refund cancellation, or a production cutover that changes retention or key
family policy.
