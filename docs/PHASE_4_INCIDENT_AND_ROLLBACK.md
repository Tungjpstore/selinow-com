# Phase 4 Incident and Rollback

P5 execution note (2026-08-04): no runtime incident or rollback occurred. The
read-only route-audit token blocker failed closed before any mutation sink.

This contract applies to staging and controlled pilot only. It does not authorize
a mutation.

## Incident flow

1. Stop new checkout, provider intake, fulfillment, or pilot traffic for the
   affected lane; preserve safe reference-only evidence.
2. Acknowledge through the tested private path. Missing acknowledgement is itself
   a stop condition and escalates to the release and rollback owners.
3. Re-inventory account, D1, Worker versions/deployments, queues, routes, and
   relevant authoritative ledgers read-only.
4. For ambiguous responses, never retry blindly. Prove the exact state and the
   same idempotency identity before any retry.
5. Reconcile payment, order, inventory, fulfillment, queue, outbox, audit, and
   provider references. Do not expose raw payloads, credentials, PII, or keys.
6. Restore the exact captured prior staging Worker version or fix forward. D1 is
   forward-only; no down migration. A database restore/cutover needs separate
   approval and protected evidence.
7. Remove/revoke only exact pilot resources from the private inventory, verify
   cleanup, and keep traffic stopped until owners acknowledge reconciliation.

## Stop ownership

Release owns runtime rollback; data owns ledger/integrity and migration recovery;
payment owns paid-state reconciliation; integration owns provider/queue/
fulfillment containment; security owns tenant or leakage response; support owns
acknowledgement and seller coordination; finance owns budget stop. Private records
must name people and destinations before the window.

## Ambiguity outcomes

An ambiguous migration/deploy/provider response ends as `stopped` until read-only
inventory proves `passed`, `failed`, or `reconciled`. If exact state cannot be
proven, hand off to the named operator; do not guess a resource ID, Worker
version, provider order, or cleanup target.
