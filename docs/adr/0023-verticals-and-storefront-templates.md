# ADR 0023: Selling verticals and the storefront template system

## Status

Accepted

## Date

2026-08-16

## Context

Selinow launched as a single-vertical product: digital key selling. The go-to-market
now targets three seller groups — digital keys (existing), physical goods (fashion,
phones), and appointment services (spa, barber, clinic). Each group needs a different
storefront presentation, and the last two need new checkout semantics (shipping
address + fee, slot booking) without destabilizing the digital money path.

Constraints that shaped the decision:

- D1 is authoritative; the checkout transaction is a single guarded batch where
  money-relevant state (inventory, fees, appointments) must be proven atomically.
- Tenant isolation is enforced by composite keys and scope guards; any new table
  must follow the same pattern (forward-only migrations, tenant-leading indexes).
- ADR 0011 constrains tenant theming to semantic tokens; WCAG AA is a release gate.
- Production invariant hashes pin schema objects, so parent-table rebuilds are
  high-risk and were rejected for this program.

## Decision

1. **Verticals are additive columns, not fulfillment-type rewrites.**
   `shops.vertical` (digital/physical/booking, default digital) is advisory
   metadata; the operative markers are per-catalog:
   - Physical goods: `products.delivery_mode = 'shipping'` (keeps
     `fulfillment_type = 'manual'`), stock in `variant_stock_levels`, fee in
     `shop_shipping_methods`, address snapshot in `order_shipping_addresses`.
   - Booking services: `product_variants.duration_minutes IS NOT NULL`,
     resources/schedules/holds/bookings tables (migration 0103).
   This avoids widening CHECK constraints on `products`/`order_items`/
   `fulfillments` (which would require parent-table rebuilds) and keeps every
   existing invariant hash byte-identical.

2. **Checkout semantics extend the canonical transaction, not the adapters.**
   Physical carts carry a `shipping` snapshot (method row proven unchanged by a
   guard in the order INSERT; fee computed from the live row against the
   post-discount amount). Booking carts carry a `booking` snapshot whose slot
   freedom (no overlapping hold or booked appointment) is proven inside the same
   guarded INSERT. Both use the reservation-token proof pattern from license
   keys, and both bind their choice into the checkout request fingerprint so
   idempotent retries cannot silently change address, method, or slot.
   Cross-mode carts are rejected (`mixed_fulfillment_unsupported`); physical and
   booking carts are website-only and paid-only.

3. **Templates are code-defined, registry-resolved, token-scoped.**
   A 9-template registry (`src/lib/storefront/templates.ts`) maps three verticals
   × three styles. The seller persists `templateId` inside the existing
   draft→publish `storefront_json` flow; rendering resolves through the registry
   with a safe fallback to `swift` for unknown, unavailable, or
   premium-without-entitlement ids. Premium templates gate on
   `plans.feature_flags_json.premiumStorefrontTemplates` (Pro). Template CSS is
   scoped by `[data-storefront-template]` and may only consume `--sln-*` and
   `--merchant-*` tokens (ADR 0011); dark templates keep payment/stock states on
   light chips for absolute contrast.

## Consequences

- The digital checkout path is unchanged for existing shops; all new guards are
  additive `WHERE` conjuncts that evaluate to no-ops for digital carts.
- Order expiry owns release: physical stock is returned by order-item
  quantities, bookings are cancelled and holds released. Payment reversal does
  not yet restock (tracked for the reversal milestone).
- Template availability (registry `available` flags) is the rollout control:
  vertical templates ship enabled only with their backend milestone.
- Telegram cannot sell physical goods or bookings by design until those
  channels gain address/slot surfaces.

## Alternatives considered

- Widening `products.fulfillment_type` CHECK (rejected: parent rebuilds vs
  pinned invariants), JSON vertical blobs on `shop_settings` (rejected: money
  semantics belong in typed columns), and per-template database theming rows
  (rejected: registry + published JSON is sufficient and cache-friendly).
