# Telegram Integration

Each shop connects a seller-owned bot. The platform verifies the token, encrypts it, configures commands and installs an opaque webhook automatically. Webhooks authenticate the Telegram secret header before processing a bounded payload and deduplicate updates by bot integration and update ID.

Phase 5 implements the current Telegram Bot API 10.2 contract checked on 2026-07-25:

- `getMe`, localized `setMyCommands`, `setChatMenuButton`, `setWebhook` and `getWebhookInfo` run in that order before activation.
- Webhooks accept only `message` and `callback_query`, use an opaque public ID and verify `X-Telegram-Bot-Api-Secret-Token` before reading the bounded JSON body.
- Bot tokens, webhook secrets and private recipient chat IDs are encrypted with tenant/integration/record/field-bound AES-256-GCM AAD. Token fingerprints, Telegram subjects and webhook verification values use purpose-bound HMACs.
- Update IDs deduplicate per integration. Reusing an update ID with a different payload hash is rejected and audited.
- Catalog, cart, discount, checkout, payment link, order and key operations reload tenant-owned server state. Callback data contains only allowlisted intent references and never carries price or credential state.
- Checkout and key reveal require a private chat. Group, supergroup and channel requests receive only a safe prompt to open the bot privately.
- Paid notifications lease the reference-only payment outbox. Retries reload the existing fulfillment allocation and never reserve or sell another key.
- Token rotation keeps the stable integration/webhook identity, atomically switches credential versions and immediately invalidates the previous webhook secret. Disconnect retains customer and order history.

No shared platform bot token exists. Real seller tokens are never used by local or CI acceptance tests.
