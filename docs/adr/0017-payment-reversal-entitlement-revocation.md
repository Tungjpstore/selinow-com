# ADR 0017: Payment reversal entitlement revocation

## Status

Accepted (source/local-only)

## Date

2026-07-30

## Context

An exact payment confirmation can create paid access, but a later provider refund
or chargeback can invalidate that access. Reversal handling must not trust a
buyer redirect, an unverified provider message, or an amount that does not match
the original paid order. It must also preserve financial, fulfillment and
consumption evidence for audit and recovery.

The existing generic entitlement graph (`0047`) and private-file delivery path
have independent lifecycle rows. A reversal therefore needs one tenant-scoped,
idempotent application boundary that revokes every live access projection while
leaving sold keys, fulfillment history, delivery consumption and immutable grant
evidence intact.

## Options considered

1. Flip the order payment status and let later reads infer revoked access.
2. Delete or rewrite grants, entitlements and delivery history when a reversal
   arrives.
3. Record an immutable normalized reversal event and atomically apply an access
   fence plus typed revocations, with manual review for non-exact evidence.

## Decision

- Migration `0048_payment_reversal_entitlement_revocation.sql` adds the
  tenant-scoped immutable `payment_reversal_events` ledger. It stores only
  normalized metadata and HMAC/SHA-256-derived fingerprints; raw provider
  references, payloads, credentials and secrets are never persisted.
- A reversal is admissible only after verified signed-webhook evidence or direct
  reconciliation is bound to the exact shop, order, payment attempt, provider,
  integration, credential version and original paid event. The database guards
  repeat those same-tenant and exact-payment checks.
- Only an exact full refund or exact chargeback changes
  `orders.payment_status` to `refunded` and revokes pending/active/suspended
  generic entitlements, active/suspended private entitlements and active
  delivery grants. Suspended generic entitlements are unsuspended before they
  are marked revoked so no stale suspension timestamp survives the transition.
- Each generic revocation increments the entitlement version and appends one
  immutable `payment_reversal` transition. Existing grants, sold inventory keys,
  fulfillment rows and delivery-consumption history are retained; no external
  provider resource is implicitly deleted.
- Partial, mismatched, already-terminal or otherwise non-exact evidence creates
  an open `payment_exceptions` row with `manual_review` and does not revoke
  access. Unverified evidence is rejected before any ledger or commerce write.
- Replays are safe: the shop-scoped idempotency hash and provider-reference hash
  return the original result for identical evidence, while changed evidence or
  bindings fail closed as a conflict. The order update and all typed revocations
  execute in one D1 batch and roll back on a state conflict.
- Standard seller export advances to schema version 4 and exposes only safe
  reversal metadata (order/attempt public IDs, provider, kind, decision,
  verification method, amounts/currencies, reason and timestamps). Hashes,
  credential/integration IDs and raw provider references are excluded.
- Backup schema/count validation includes `payment_reversal_events`. Shop
  deletion retains the immutable reversal and financial/audit ledgers; existing
  active-payment and legal-hold fences continue to block unsafe deletion.

## Consequences

- Refund and chargeback access revocation is explicit, replay-safe and
  tenant-isolated instead of being inferred from mutable order state.
- The access fence closes generic and private delivery paths, but it does not
  undo a previously fulfilled or consumed item. Seller/operator workflows must
  resolve partial and mismatched reversals manually.
- The ledger and transition rows increase backup/export/deletion lifecycle
  obligations. Safe projections and immutable retention keep those obligations
  auditable without exposing provider secrets or hashes.
- `0048` is validated in source/local focused coverage only. Staging still has
  28 applied migrations and 20 pending migrations (`0029`-`0048`); no staging or
  production mutation is authorized until the normal route, identity and fresh
  backup admission gates pass.

## Revisit triggers

Revisit before supporting partial-quantity entitlement revocation, provider-side
refund APIs, automatic external grant cancellation, or a production cutover that
changes the retained financial/audit ledger policy.
