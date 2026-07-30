# ADR 0016: Generic entitlement foundation

## Status

Accepted

## Date

2026-07-30

## Context

The legacy `license_key|manual` fulfillment values cannot represent memberships,
community access, seats, device activations, generated licenses, or provider
access without overloading one mutable order-level fulfillment row. The private
download and seller-attested manual ledgers solve narrower delivery cases, but
neither provides a reusable tenant-scoped resource, policy, grant, and lifecycle
model.

Payment and fulfillment must remain separate. A return URL or QR render cannot
activate access, and a paid order can activate access only from the exact signed
payment event claimed by the canonical payment processor. Historical orders
must retain the policy that was effective at checkout even when a seller later
changes the product configuration.

## Options considered

1. Add more values and nullable columns to the legacy fulfillment tables.
2. Rebuild all existing license-key, private-file, and manual fulfillment paths
   on one replacement schema.
3. Add a generic entitlement graph beside the existing paths and integrate it
   through the canonical checkout and exact-payment transactions.

## Decision

- Migration `0047_generic_entitlement_foundation.sql` adds tenant-scoped
  resources, versioned product policies, immutable order-item requirement
  snapshots, entitlement state, immutable activation grants, and an immutable
  transition ledger.
- D1 remains authoritative. Resources and policies are metadata only; provider
  credentials, generated keys, private-file bytes, buyer tokens, and plaintext
  external references are not stored in the generic graph.
- Website, Telegram, and external channel adapters enter the same canonical
  checkout transaction. The transaction guards the exact active policy set and
  creates the requirement and entitlement in the same D1 batch as the order.
- Free checkout creates an active entitlement and immutable `free_checkout`
  grant. Paid checkout creates a pending entitlement. Activation requires a
  signed, claimed, unprocessed payment event whose attempt is `paid_exact` and
  whose `paid_event_id` matches that event.
- A requirement records the checkout-time resource, policy version, item
  quantity, grant quantity, and TTL. Later policy changes cannot reinterpret the
  order.
- Entitlement state is versioned as `pending|active|suspended|expired|revoked`.
  Every state change appends one tenant-bound transition row; grants and
  transitions cannot be updated or deleted.
- Manual seller attestation and generic requirements are mutually exclusive per
  order item in both insertion directions. Legacy manual fulfillment rows are
  created only for manual items without a typed private-file or generic
  requirement.
- Standard export exposes safe lifecycle metadata only. Backup validation
  covers the graph. Shop deletion retires configuration and revokes live
  entitlements behind the existing legal-hold and crypto-shred fence while
  retaining immutable financial and transition evidence.

## Trade-offs

- Existing license-key, private-file, and seller-manual schemas remain in place,
  so fulfillment has multiple typed projections during the migration period.
- The foundation records entitlement evidence but does not yet execute a
  provider grant, generate a license, join a community, or allocate a seat or
  device.
- Only exact paid and free-checkout activation are supported. Partial,
  overpaid, late, mismatched, refunded, or reversed payments do not activate or
  automatically mutate an external resource.
- Immutable grants and transitions increase row count and require bounded
  maintenance queries, but preserve replay, audit, and incident evidence.
- A product can own multiple active policies for distinct resources, which
  increases checkout guard complexity but avoids encoding unrelated access in a
  single opaque payload.

## Consequences

- New entitlement types can be added without changing the canonical order and
  payment authority boundaries.
- Channel parity is testable at one checkout seam, and payment activation is
  idempotent, tenant-isolated, and bound to exact signed evidence.
- Seller and buyer UI can project typed access without treating every legacy
  `manual` item as awaiting seller attestation.
- Staging must apply migration `0047` before deploying code that relies on the
  generic schema. The current source/local work does not authorize a staging or
  production migration.

## Revisit triggers

Revisit before implementing refund/reversal revocation, provider-side grant or
revoke adapters, partial quantity grants, transferable access, pooled seats,
device replacement, or a controlled cutover that retires the legacy
fulfillment projections.
