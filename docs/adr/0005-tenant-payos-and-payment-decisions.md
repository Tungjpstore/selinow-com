# ADR 0005: Tenant-owned PayOS credentials and payment decisions

## Status

Accepted

## Context

Each seller receives money through their own PayOS channel. Credentials cannot become per-shop Worker secrets, and browser return URLs cannot prove a bank transfer. Webhooks may be duplicated, delayed, delivered during credential rotation or conflict with the expected order identity.

## Decision

- Store versioned PayOS credentials encrypted per field in D1 with AES-256-GCM and credential/shop/integration/field-bound AAD.
- Keep a stable opaque webhook identity per shop integration. Allow a pending credential to verify the PayOS confirm-webhook probe, then atomically activate it and retain the previous version for a short grace period.
- Follow the official PayOS merchant API and SDK canonicalization for HMAC-SHA256 request, response and webhook signatures.
- Allocate a globally unique positive safe-integer provider order code and retain the credential version used for every payment attempt.
- Create payment attempts locally before the provider call. If the create response is lost, recover using the same order code instead of allocating a new one.
- Classify signed evidence as `paid_exact`, `partial`, `overpaid`, `late`, `identity_mismatch`, `inconsistent`, `pending` or `terminal_unpaid`.
- Only `paid_exact` can atomically mark the order paid, sell reserved inventory and create unique fulfillment records.
- Reconcile pending attempts with bounded leases and the same decision engine before expiring unpaid orders.

## Trade-offs

- Credential connection depends on PayOS successfully probing the public webhook endpoint.
- Exception orders retain evidence and require a later manual-resolution workflow rather than guessing intent.
- Direct D1 transaction scripts are verbose but keep tenant, current-state and idempotency guards visible.

## Consequences

- Return URL query parameters cannot mark orders paid.
- Duplicate signed events acknowledge successfully without repeating fulfillment.
- Partial, overpaid, late or mismatched payments never reveal keys automatically.
- Credential rotation can verify in-flight events using a bounded grace version without using another tenant's keys.
