# ADR 0013: Additive private-download fulfillment

## Status

Accepted

## Date

2026-07-29

## Context

The existing catalog and fulfillment tables use legacy checked values for `license_key` and `manual`. Rebuilding those tables to add a private-file enum would increase migration and rollback risk, while treating a downloadable file as license-key inventory would weaken access, quota and object-lifecycle invariants.

Private delivery also has two distinct authorities: R2 stores immutable bytes, while D1 must decide whether an exact buyer may download an exact asset version. A short-lived delivery token cannot become the authority for payment, entitlement state or remaining quota.

## Options considered

1. Rebuild legacy catalog, order-item and fulfillment tables with new enum values.
2. Encode private-file configuration in unvalidated JSON on the existing product row.
3. Add typed capability tables alongside the legacy fulfillment columns and cut over incrementally.

## Decision

- Keep the legacy fulfillment columns unchanged. A private-file product remains legacy `manual` and gains a typed, versioned `private_file` policy.
- Add tenant-scoped assets and immutable asset versions. R2 stores bytes under the private `MEDIA` namespace; D1 stores the object reference, size, ETag and SHA-256 integrity evidence.
- Snapshot the selected policy into an immutable order-item requirement before creating the entitlement. The grant request names the exact order item, so separate products that share an asset version retain separate policy snapshots, entitlements and quotas. Historical license-key order items are never reinterpreted as private files.
- Make D1 authoritative for entitlement status, expiry and download quota. The entitlement owns `max_downloads` and `download_count`; each delivery grant is a short-lived, one-use ticket bound to the shop, order, order item, buyer binding and asset version. Grant issuance and consumption recheck `payment_status='paid'` and `status IN ('processing','completed')` inside the D1 batch that commits the mutation.
- Store only a nonce plus HMAC-derived token verifier. Pass the token in headers, return the file through the Worker, and prohibit public permanent R2 URLs.
- Consume a grant atomically with the entitlement quota. Concurrent consumption can produce at most one successful download for a one-use grant and can never exceed the entitlement quota.
- Keep audit and queue payloads reference-only. Standard export includes redacted lifecycle metadata but omits the object key, file bytes, buyer binding, nonce and token/request hashes.
- Integrate private assets with backup validation and shop deletion. Upload and policy configuration require a `draft|active` shop during pre-authorization and in the committing D1 statements. Upload compensates the R2 object if its authoritative insert loses a suspension race; policy replacement cannot retire the existing active policy unless the guarded new policy insert succeeds. Deletion suspends the shop before cleanup, revokes grants and entitlements, retires policies, marks the destructive step in flight and rechecks the lease/legal-hold fence around each exact tenant R2 deletion. The destructive marker is monotonic: it blocks new legal holds regardless of lease expiry, survives failed/reclaimed crypto-shred attempts, remains visible beside the request-level safe failure, and clears only when the step completes successfully.

## Rationale

The additive model preserves forward-only migration safety and keeps the current commerce/runtime contracts compatible. Separating entitlement quota from delivery tickets gives retry-safe issuance without granting unlimited access. Keeping R2 non-authoritative allows object storage to remain a byte store while D1 enforces payment, tenant, identity, expiry and concurrency rules.

## Trade-offs

- Products with private-file policies still expose the legacy `manual` fulfillment value to code that has not adopted the capability projection.
- Pre-cutover orders without a requirement retain a bounded temporal compatibility path: a policy is eligible only when its validity interval covered the order-item creation time. A policy configured after an older order therefore cannot grant that order a new file.
- Private bytes currently share the `MEDIA` bucket under a private prefix rather than a dedicated binding.
- The first delivery surface is the website order-access flow; Telegram does not yet render a secure private-download handoff.

## Consequences

- New fulfillment capabilities can be added with typed tables without rebuilding legacy order history.
- Asset replacement creates a new immutable version and policy version; existing requirements continue referencing their original version.
- Backup, export, deletion and restore validation must evolve whenever a new authoritative fulfillment table is added. A restore drill may start from a source whose applied ledger is behind the repository: it compares counts only for source tables that exist, applies the complete current ledger to the isolated target, and then requires the full current schema.
- Checkout-time requirement snapshotting is now part of the canonical Website/Telegram/fake checkout transaction. A dedicated private-assets bucket, channel-neutral secure delivery and generic generated/membership/activation capabilities remain explicit follow-up work.

## Revisit triggers

Revisit this decision before adding generated licenses, memberships with seats/devices, external fulfillment providers, cross-channel private delivery, a dedicated private-assets bucket, or any checkout flow that must guarantee policy capture before the first buyer access.
