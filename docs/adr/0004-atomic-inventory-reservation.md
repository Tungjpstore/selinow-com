# ADR 0004: Atomic inventory reservation and encrypted key storage

## Status

Accepted

## Context

Phase 3 sells finite digital inventory from a shared D1 database. A separate availability read followed by an unconditional update can sell the last key twice. Plaintext keys, globally reusable fingerprints and bearer tokens stored directly in D1 would also turn a database or log disclosure into immediate customer harm.

## Decision

- Encrypt every inventory key with AES-256-GCM, a random 96-bit IV and versioned AAD containing the internal shop and variant IDs.
- Detect duplicates with an independent keyed HMAC scoped to the shop and variant; never echo the source value in errors, logs or audit metadata.
- Reserve stock with one conditional D1 `UPDATE` that selects only currently available rows and returns the changed row count.
- Bind all rows reserved by one checkout to an opaque reservation token. On partial reservation or downstream failure, compensate only rows carrying that token.
- Re-read product status, variant status, price, version, quantity bounds and stock during checkout. Client quote fields are comparison inputs, not authority.
- Store only a purpose-bound HMAC of the opaque order access token. Decrypt sold keys only after exact shop/order/token authorization.
- Expire unpaid orders with a conditional order transition, then release inventory only when that order is confirmed expired. Repeated maintenance runs are no-ops.

## Trade-offs

- Direct D1 transaction scripts are more verbose than an ORM abstraction.
- Multi-line inventory imports require application encryption before the atomic database batch.
- Pending paid-provider integration means non-zero orders remain reserved and unpaid until Phase 4 handles payment confirmation.

## Consequences

- Concurrent buyers cannot reserve the same available key.
- Moving ciphertext across a tenant or variant fails authentication during decryption.
- Duplicate import errors and operational telemetry contain no license-key plaintext.
- Reservation cleanup can safely retry after cron or Worker failures.
