# ADR 0019: Provider Runtime Contract Boundary

- Status: Accepted for source/local implementation
- Date: 2026-08-02
- Scope: Telegram Bot, Telegram Mini App, Zalo Mini App, Zalo OA, WhatsApp Cloud and Discord Bot

## Context

The product has one canonical tenant-scoped commerce core, while each channel
has different webhook proof, identity, delivery and provider policy rules.
Treating a connector request or a signed request as an active commerce channel
would allow provider payloads to bypass tenant isolation, idempotency and
payment/fulfillment authority. Zalo contracts are also subject to external
documentation and package review that cannot be safely inferred locally.

## Decision

Keep a provider-neutral contract registry and verification boundary in
`src/lib/channels/provider-contracts.ts`.

- Provider contracts declare inbound mode, exact outbound origin, verification
  family, replay window and lifecycle stage.
- Verification runs on the raw bounded body before parsing. Telegram secret
  headers, Telegram Mini App launch-data HMAC, WhatsApp raw-body HMAC and
  Discord Ed25519 are separate proof paths.
- Zalo Mini App and Zalo OA remain explicit `provider_pending` contracts until
  current official OAuth/webhook rules and a controlled capability probe are
  recorded.
- Normalization emits only tenant/connection/provider event references and a
  payload hash. Canonical D1 services remain authoritative for commerce,
  payment, inventory, fulfillment and subscription state.

## Alternatives considered

1. Put provider verification inside each API route. Rejected because it
   duplicates security policy and makes cross-channel drift likely.
2. Use one generic signature algorithm. Rejected because Telegram, Meta and
   Discord use different proofs and replay semantics.
3. Mark a connector active when a seller requests it. Rejected because seller
   intent is not provider credential, webhook, scope or delivery evidence.

## Consequences

- New providers can add a verifier and contract without changing commerce
  authority.
- Provider-pending channels fail closed rather than silently accepting or
  sending messages.
- A future provider ingress still needs a durable event-receipt migration,
  tenant-bound credential resolver, webhook challenge route and provider-backed
  acceptance before activation. This ADR does not claim those external steps
  are complete.
