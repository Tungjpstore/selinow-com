# ADR 0007: Channel-neutral commerce core and adapter ports

## Status

Accepted

## Date

2026-07-26

## Context

Selinow currently exposes website and Telegram commerce. Both channels must preserve the same tenant, catalog, price, discount, inventory, order, payment and fulfillment invariants. Additional conversational, social and marketplace channels will have different webhook, identity, rendering and delivery contracts, but they must not copy transactional commerce logic.

The application remains a Cloudflare modular monolith. There is no measured independent scaling or team boundary that justifies microservices, event sourcing or a separate deployable per provider.

## Decision

- Keep one deployable Worker and introduce a channel-neutral application layer under `src/lib` before adding another production provider.
- Website, Telegram and future providers become adapters around the same commerce commands and views.
- Only the commerce application layer may create carts or orders, calculate discounts, reserve or allocate inventory, create payment handoffs, authorize order access or reveal fulfillment.
- Split provider ports by capability rather than creating one universal adapter interface:
  - connection lifecycle: authorize, connect, discover grants, configure webhook, health check and disconnect;
  - inbound webhook: verify the raw request, enforce bounds, deduplicate and normalize provider events;
  - messaging delivery: render canonical views, send, classify failures and record receipts;
  - catalog synchronization: plan and apply provider catalog changes when supported;
  - marketplace orders: import native orders and push status or fulfillment when supported.
- Normalize inbound provider data before it reaches commerce. Provider payload types, access tokens, message IDs and API error bodies do not enter catalog, inventory, order, payment or fulfillment contracts.
- Keep state-changing commerce commands synchronous with D1 when the request needs an immediate result. Append a reference-only domain event in the same authoritative mutation for asynchronous notification, synchronization and repair work.
- Use an append-only domain-event outbox and per-target delivery jobs for fan-out. Queue messages contain only stable references such as event ID and schema version; they never contain credentials, customer secrets or license-key plaintext.
- D1 remains the source of truth. The event outbox is an integration mechanism, not event sourcing, and read models remain direct projections of authoritative state.

## Trade-offs

- Extracting duplicated website and Telegram behavior requires characterization tests and staged migration before new providers can ship.
- Capability-specific ports create several small interfaces instead of one simple-looking adapter interface.
- Some providers may require synchronous acknowledgement while their business work continues asynchronously, so each adapter must document its response deadline and retry contract.
- Reference-only jobs require consumers to reload current D1 state, trading a database read for safer retries and smaller messages.

## Consequences

- A normalized checkout command must produce the same order, reservation and fulfillment outcome regardless of the originating channel.
- Adding a provider should primarily add authorization, verification, normalization, rendering and delivery code rather than another commerce implementation.
- One domain event can create independent Telegram, email, WhatsApp, marketplace or future delivery jobs without one consumer marking the whole event complete.
- Existing Cloudflare Queues can carry integration and notification references; a new queue or deployable is added only after measured isolation or scaling needs justify it.
- Contract tests must run the same commerce scenarios through website, Telegram and a fake third adapter before the first new provider is accepted.

## Revisit triggers

Reconsider a separate deployable only when measurements show an independently scaling provider workload, a provider-specific availability or compliance boundary, repeated cross-provider deployment incidents, or an organizational team boundary that the modular monolith cannot safely support.
