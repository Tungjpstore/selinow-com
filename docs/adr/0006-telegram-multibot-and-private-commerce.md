# ADR 0006: Tenant-owned Telegram bots and private commerce

## Status

Accepted

## Context

Each seller owns a different Telegram bot. Bot tokens appear in the provider URL, updates can be duplicated or conflict, callback data is client-controlled, and group chats cannot safely establish buyer ownership for orders or license keys. Payment completion must notify the original Telegram buyer without storing credentials, recipient IDs or plaintext keys in an outbox job.

## Decision

- Keep one stable Telegram integration and opaque webhook public ID per shop while storing versioned encrypted credentials in D1.
- Use a global keyed token fingerprint and active bot-ID uniqueness to prevent one live bot from serving multiple shops.
- Encrypt bot token, webhook secret and recipient chat ID with separate record/field-bound AAD. Store only purpose-bound HMAC values for webhook verification and buyer subjects.
- Follow Telegram Bot API 10.2 onboarding order: identity, commands, menu, webhook, webhook health, then atomic credential activation.
- Verify the webhook secret before reading the bounded body. Dedupe update ID plus payload hash and audit a reused ID with different content.
- Allow only short callback intent/reference namespaces and reload tenant, price, stock, ownership, payment and fulfillment state server-side.
- Restrict cart checkout, order access and key reveal to private chats. Groups receive only a private-chat prompt.
- Reuse shared carts, inventory reservation, orders, PayOS payment attempts and fulfillment records for Telegram commerce.
- Deliver payment notifications from leased reference-only outbox rows. Retries rehydrate the existing fulfillment and never allocate inventory.

## Trade-offs

- Synchronous webhook replies can repeat a harmless Telegram message after an ambiguous provider response, but business mutations remain idempotent.
- Recipient chat IDs must be decrypted for outbound delivery, so credential KEK availability is required for notifications.
- One bot per shop in the MVP simplifies routing and active credential constraints; multiple bots per shop would require a broader integration key.

## Consequences

- A duplicated Telegram update cannot create another cart mutation or order.
- A callback from one shop cannot select another shop's variant, order or fulfillment.
- Token rotation changes the webhook secret without changing the public webhook route.
- Revoked tokens surface as degraded health using safe error codes and no provider description or token disclosure.
- Paid-notification retries do not create new fulfillment rows or sell another key.
