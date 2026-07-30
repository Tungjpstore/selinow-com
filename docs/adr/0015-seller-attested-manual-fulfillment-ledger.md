# ADR 0015: Seller-attested manual fulfillment ledger

## Status

Accepted

## Date

2026-07-30

## Context

Legacy manual products create one order-level `fulfillments` row, but that row does not prove which order item was delivered, who attested delivery, or whether a retry reused a different external reference. Private-file products also retain the legacy `manual` value for compatibility, so treating every manual order item as seller-deliverable would let an operator bypass the typed private-file entitlement path.

External delivery references may themselves be sensitive. Storing reference plaintext, raw provider payloads or credentials in D1, audit rows or queues would violate the repository secret boundary.

## Options considered

1. Update the legacy fulfillment row directly without a per-item ledger.
2. Store seller notes or external references as plaintext JSON.
3. Add an immutable, tenant-scoped execution ledger with hash-only optional reference evidence and keep the legacy row as a compatibility projection.

## Decision

- Migration `0046_manual_fulfillment_executions.sql` adds one immutable `seller_attested_delivery` execution per tenant/order item and an optional immutable external-reference row.
- Only an active owner or manager with `fulfillment:manage`, a recent authenticated session, valid CSRF and a bounded idempotency key may complete an item.
- The order must be authoritatively paid and processing/completed. The execution records the exact ordered quantity and can complete the legacy fulfillment/order projection only after every eligible manual item is complete.
- Any order item with a typed `private_file` requirement is ineligible. Database guards enforce mutual exclusion in both directions so a private-file requirement cannot be attached after a manual execution either.
- External reference plaintext is accepted only long enough to derive a tenant/type-bound HMAC. D1 retains the hash, key version and safe reference type; responses, audit metadata and standard exports never expose the plaintext or digest.
- Same-key retries return the durable execution, changed payloads fail with an idempotency conflict, and concurrent different-key attempts allow one winner.
- Backup schema/count validation includes both ledgers. Standard export includes only safe execution/reference metadata. Shop deletion retains the immutable rows with financial/audit evidence; there is no recoverable secret to crypto-shred.

## Trade-offs

- The first contract is all-or-nothing per order item; partial manual delivery is not represented.
- A hash-only external reference cannot be redisplayed or used as a provider credential.
- This is seller attestation, not proof from an external provider and not generated-license execution.
- New typed automated fulfillment requirements must be excluded from manual attestation explicitly; future general entitlement migrations must widen the mutual-exclusion guard beyond `private_file`.

## Consequences

- Existing license-key and manual checkout behavior remains compatible.
- Seller actions become replay-safe, attributable and tenant-isolated without putting provider data in the commerce contract.
- Generated licenses, membership/community entitlement, seat/device activation, reversal evidence and provider-backed reconciliation remain separate Phase C work.

## Revisit triggers

Revisit before supporting partial quantities, provider-confirmed manual delivery, generated-license webhooks, generic entitlement requirements, or any workflow that must revoke an external provider resource during shop deletion.
