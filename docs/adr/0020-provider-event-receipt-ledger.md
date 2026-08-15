# ADR 0020: Payload-Free Provider Event Receipt Ledger

## Status

Accepted for local/source implementation; provider activation remains blocked.

## Context

Provider verifiers for Telegram Mini App, WhatsApp Cloud, Discord and Zalo
Mini App can prove a request, but verification alone does not provide durable
idempotency, tenant-scoped replay handling or a safe queue handoff. Persisting
raw provider payloads would increase secret/PII retention risk and would make
provider retries harder to reconcile consistently.

## Decision

Add migration `0058_channel_provider_event_receipts.sql` and a D1 receipt store
that records only the tenant, connection, provider event identity, action,
payload reference, lifecycle status and safe timestamps. The shared ingress
sequence is `verify -> normalize -> claim`; an identical event/hash is a
replay, while an identical event with a different hash is a conflict audited
with references only. The table is tenant-leading, connection-bound and
immutable in identity. It does not activate a provider, parse business state,
or enqueue a provider payload.

## Consequences

- Provider-specific routes can acknowledge only after a durable reference
  claim, then enqueue a reference for a later parser/commerce worker.
- Telegram Bot keeps its existing `telegram_updates` ledger during staged
  parity validation; this migration does not rewrite that runtime.
- A future adapter must add provider identity resolution, credential
  decryption, event-ID extraction, outbound delivery and acceptance evidence
  before moving beyond `provider_pending`.
