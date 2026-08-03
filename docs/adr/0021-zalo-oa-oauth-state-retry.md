# ADR 0021: Allow Safe Zalo OA OAuth Retries

- Status: accepted for source/local contract
- Date: 2026-08-02
- Scope: Zalo Official Account OAuth state persistence

## Context

An OAuth state is one-use evidence, but a connector can legitimately need a
second authorization attempt after the first state is consumed or revoked.
The initial state table enforced unconditional uniqueness on
`(shop_id, connector_request_id, provider_code)`, which prevented a retry while
also retaining the consumed row as immutable audit evidence.

## Decision

Migration `0062_zalo_oa_oauth_state_retry.sql` rebuilds the table without the
unconditional connector uniqueness constraint and adds a partial unique index
for `status = 'pending'`. Request IDs and state hashes remain unique. Existing
identity/status/timestamp triggers are recreated unchanged, so a retry cannot
edit or delete prior evidence and two pending states cannot coexist. The
forward-only migration leaves the earlier source migrations untouched.

## Consequences

- OAuth can be retried without deleting or mutating consumed/revoked state.
- D1 remains authoritative for one-use CAS consumption and tenant scope.
- Additional retained state rows increase audit storage until the existing
  retention/crypto-shred policy is applied.
- This migration is source/local-only; it does not activate OAuth, webhooks,
  outbound delivery, payment or fulfillment.
