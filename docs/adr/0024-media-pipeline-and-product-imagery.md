# ADR 0024: Media pipeline and product imagery

## Status

Accepted

## Date

2026-08-16

## Context

The storefront rendered no product imagery (letter placeholders only), which
blocks the physical-goods vertical and weakens every template. Sellers need to
upload pictures; buyers need them served fast; the platform must meter storage
per plan (Starter 1 GB / Pro 10 GB via `limits_json.storageBytes`).

Existing assets: the private digital-file pipeline (R2 MEDIA bucket + D1
registry + audit + rollback) is a proven pattern, but serves encrypted,
buyer-scoped artifacts through short-lived grants — the wrong shape for public
storefront imagery.

## Decision

1. **Public media is a separate D1-registry-backed pipeline**
   (`migrations/0101`): `media_assets` (kind, content-type allowlist png/jpeg/
   webp/avif, ≤10 MB, sha256, soft delete) and `product_images` (assignment,
   sort order, composite tenant FKs to product and asset). Objects live under
   `storefront-media/<shop_id>/<asset_id>` in the same MEDIA bucket.

2. **Uploads validate before storage**: magic-byte sniffing must match the
   claimed content type; the quota check sums active `media_assets.byte_size`
   against `plans.limits_json.storageBytes` (soft-deleted assets release their
   share); R2 put → D1 register → rollback-on-failure mirrors the private-file
   transaction; every write is audited.

3. **Serving is host-agnostic and immutable**: `/media/:publicId` streams from
   R2 keyed by an opaque `public_id`, `Cache-Control: public, max-age=31536000,
   immutable` (uploads always create new assets), `nosniff`, ETag. Deleted
   assets 404 immediately via the D1 row.

4. **Storefront integration stays minimal**: the catalog projects the first
   active image per product (`StorefrontProduct.imageUrl`); cards render it with
   the letter placeholder as fallback; no variant-level imagery yet (reserved
   for template-specific galleries).

## Consequences

- Storage quota counts only `media_assets`; private digital assets are not yet
  metered against the same limit (tracked follow-up).
- No processing/transcoding: sellers upload final images; sizes are bounded by
  the 10 MB check.
- R2 object purge for soft-deleted assets rides the existing deletion lifecycle
  (tracked for TV5) — the D1 row stops serving immediately.
