# Channel Provider Contracts

Last reviewed: 2026-08-02

This document defines the backend boundary for Telegram Bot, Telegram Mini App,
Zalo Mini App, Zalo Official Account, WhatsApp Cloud and Discord Bot. It is
not provider-activation evidence. A contract-ready adapter is still
`provider_pending` until the seller credential, provider verification, webhook
acceptance, capability probe and outbound acceptance are recorded.

## Runtime matrix

| Provider | Inbound proof | Outbound origin | Local stage | Missing before activation |
| --- | --- | --- | --- | --- |
| Telegram Bot | `X-Telegram-Bot-Api-Secret-Token`, verified before JSON parsing | `https://api.telegram.org` | Implemented for the existing Telegram runtime | Current provider health, queue/cron inventory, signed payment and seller pilot evidence |
| Telegram Mini App | Server-side `initData` HMAC with `WebAppData`, fresh `auth_date` | `https://api.telegram.org` | Contract-ready verifier | External Mini App catalog/cart acceptance, provider identity/credential evidence and seller pilot |
| Zalo Mini App | `x-zevent-signature`: SHA-256 of sorted top-level values concatenated with the API Key | None admitted | Provider-pending | API Key/IP allowlist, App/Mini App identity, user-token/appsecret proof flow, webhook acceptance, capability probe and outbound evidence |
| Zalo Official Account | Provider-specific OAuth/webhook proof is intentionally not hardcoded | None admitted | Provider-pending | Verified OA, eligible package, consent, OAuth/refresh lifecycle, webhook and outbound acceptance |
| WhatsApp Cloud | `X-Hub-Signature-256` HMAC over the exact raw body; GET challenge is a separate route contract (local defensive body cap 3 MiB; Meta documents payloads up to 3 MB) | `https://graph.facebook.com` | Contract-ready verifier | WABA/phone ownership, approved scopes/templates, webhook subscription, event ledger, 24-hour window and delivery acceptance |
| Discord Bot | Ed25519 over `timestamp + raw body` using the application public key | `https://discord.com` | Contract-ready verifier | Interaction endpoint acceptance, Gateway intent review, bot scope/token setup, rate-limit and delivery evidence |

The source of truth for the local verification rules is
`src/lib/channels/provider-contracts.ts`. The module only verifies provider
proof and creates safe reference envelopes; it does not persist credentials,
parse untrusted payloads into commerce state or mark a connection active.

Body limits in the runtime matrix are defensive local caps, not claims that a
provider rejects larger requests. Meta documents WhatsApp webhook payloads up
to 3 MB; the local 3 MiB cap is a deliberately bounded approximation and is
not provider enforcement.
Replay metadata is explicit: a numeric value means a local
timestamp/freshness fence, while `null` means the provider has no signed
timestamp contract and durable event receipts own duplicate/conflict handling.

## Non-negotiable ingress rules

1. Bound the raw body before reading it. Verify the provider signature/secret
   against the exact bytes, then parse JSON. Zalo Mini App is the documented
   exception: its signature is defined over parsed canonical field values, so
   the bounded JSON object must be parsed before hashing.
2. Resolve the connection from the tenant-bound webhook/connector public ID
   and provider identity. Reject a valid signature when the WABA, phone, OA,
   bot or application identity belongs to another tenant.
3. Persist only a reference envelope: `(shop_id, connection_id,
   provider_event_id, payload_hash, received_at)`. The same event and same
   hash is an idempotent replay; the same event with a different hash is a
   conflict that must be audited and rejected.
4. Enqueue references only. Provider payloads, credentials, access tokens,
   webhook secrets, customer tokens and license values never enter queue or
   audit payloads.
5. A webhook returns success only after the reference claim is durable. Any
   provider action, payment confirmation, inventory allocation or fulfillment
   happens in the canonical D1 transaction after the provider-specific proof.

## Provider-specific constraints

### Telegram Bot

- `setWebhook` and `getUpdates` are mutually exclusive. Keep an explicit
  `allowed_updates` list and verify the configured `max_connections`.
- Telegram's `secret_token` is 1-256 characters and may contain only
  `A-Z`, `a-z`, `0-9`, `_` and `-`; the local verifier applies that provider
  allowlist before comparing the tenant-bound secret.
- Telegram retries webhook responses outside the 2xx range for a reasonable
  number of attempts and retains undelivered updates for no longer than 24
  hours. Claim the update and acknowledge quickly; do not make a provider
  call before the durable claim.
- `update_id` is the provider idempotency key. `retry_after` from a 429 is the
  lower bound for the next attempt. Keep per-chat and global throttles; do not
  retry permanent 401/403 recipient failures.
- Enforce provider payload bounds (`sendMessage` text and callback data) before
  calling the API. A return URL, QR image or `answerWebAppQuery` response is
  never payment evidence.

### Telegram Mini App

- Validate only server-received `initData`; `initDataUnsafe` is not trusted.
- Use the bot-token HMAC algorithm and a short local freshness window (the
  current contract uses 300 seconds) for checkout or account actions. Telegram
  documents the HMAC fields but does not prescribe this replay TTL.
  Replay keys hash the canonical sorted signed fields, not raw query ordering.
  `start_param` is routing metadata, not tenant proof.
- The local session boundary is documented in
  `docs/TELEGRAM_MINI_APP_SESSION.md`: one-use/replay hash,
  credential-version binding, short-lived opaque session, active connector
  admission and revocation on credential rotation. It remains source/local
  evidence, not an external provider acceptance claim.

### Zalo Mini App and Zalo Official Account

- They are separate provider identities. Do not reuse Telegram-only customer
  identities or conflate Mini App launch identity with OA messaging.
- Zalo Mini App Open API webhook events use `x-zevent-signature` and SHA-256 of
  alphabetically sorted top-level field values followed by the API Key. The
  current verifier is local-only; activation still requires app identity, API
  key, server IP allowlist, webhook registration and a capability probe. Mini
  App user identity uses `zmp-sdk.getAccessToken`, then the server calls
  `https://graph.zalo.me/v2.0/me` with `access_token` and mandatory
  `appsecret_proof` HMAC. The current local credential envelope stores only
  App ID/API Key, so no profile route is admitted until the app-secret field,
  rotation policy and provider acceptance are separately reviewed. Profile
  fields and phone access remain consented, scoped operations.
- Zalo OA OAuth v4 uses PKCE. The authorization code is one-use and valid for
  10 minutes; access tokens last 25 hours; refresh tokens rotate on each use
  and are valid for 3 months. Token examples use `expires_in`, while the
  response-property table also documents `expire_in`; the local exchange
  accepts either only when unambiguous and rejects conflicting values. Token exchange is
  `https://oauth.zaloapp.com/v4/oa/access_token` with the `secret_key` header.
  The OA webhook contract requires HTTPS and a 200 response within 2 seconds,
  retries at 30s/5m/15m/30m/1h and adds `num_retry` on retries, but the official
  page does not document a signature or challenge. OA inbound proof therefore
  remains fail-closed.
- The local credential boundary is implemented in
  `src/lib/channels/zalo-oa-credentials.ts`: the app secret key, access/refresh
  tokens, app/OA identity and expiry metadata are encrypted with
  tenant/connection/credential AAD and fingerprinted only from the app/OA
  identity. The state hash helper
  in `src/lib/channels/zalo-oa-state.ts` scopes a pending state to the tenant
  and connector request without persisting raw state or verifier material.
  The durable D1 one-use state row with atomic consume is now source-local in
  migrations `0060`-`0062`; token rotation persistence, webhook event dedupe
  and read-only capability probes remain pending. No Zalo provider endpoint is
admitted in the active runtime. The public OAuth callback matches Zalo's GET
redirect query (`code`, `oa_id`, `state`) and also accepts the bounded JSON
relay shape for internal callers. It returns `channel_provider_pending`
without consuming state: a browser must never provide `secret_key` or assert
an OA identity. The returned `oa_id` is retained only as an untrusted hint
until server-side provider identity binding is admitted.

The local OAuth seam is implemented in `src/lib/channels/zalo-oa-oauth.ts`.
It builds the documented v4 OA authorization URL with S256 PKCE, validates a
tenant-supplied callback state in constant time, exchanges a one-use code with
the required `authorization_code` grant, and rotates a one-use refresh token
with the documented `refresh_token` grant through
`https://oauth.zaloapp.com/v4/oa/access_token` using the `secret_key` header.
It accepts Zalo's documented string or numeric `expires_in` response form and
fails closed on malformed provider responses. The helper is deliberately
side-effect free: callers must keep the verifier transient, bind and consume
state under the tenant, atomically encrypt/replace returned access and refresh
tokens in the credential vault, and complete provider review, OA selection,
webhook registration and capability probes before activation.

### WhatsApp Cloud

- Verify the GET subscription challenge against the connection-specific verify
  token. For POST, compute HMAC-SHA256 over the exact raw body using the app
  secret and compare `X-Hub-Signature-256` in constant time.
- Meta does not provide a signed timestamp header for this webhook. Replay
  protection therefore comes from the tenant-bound durable receipt ledger and
  its retention policy, not from a guessed timestamp window. Meta may retry
  failed deliveries for up to seven days.
- Meta documents webhook bodies up to 3 MB and retries failed or undeliverable
  deliveries for up to 7 days. There is no provider timestamp header, so the
  runtime contract does not apply a timestamp replay window; the durable
  receipt ledger must retain enough history to cover this retry horizon.
- Resolve WABA and phone-number identity before accepting a message or status
  event. The encrypted connection credential binds `businessAccountId` and
  `phoneNumberId`; the raw payload's `entry[].id` and
  `value.metadata.phone_number_id` must match before event normalization.
  Metadata-less changes are admitted only for the explicit WABA-level field
  allowlist (`account_update`, `business_capability_update`,
  `message_template_quality_update`, `message_template_status_update`); an
  unknown or phone-scoped change without phone metadata is rejected before
  the receipt claim. Dedupe `messages[].id` and status references per
  tenant/connection.
- Derive the customer-service window from an authenticated inbound message;
  never accept a seller-provided expiry. Outside the open window require an
  allowlisted, approved template with validated language/components.
- Unknown Graph timeouts are ambiguous. Reconcile before retrying a send; use
  bounded backoff, `Retry-After`, a reference-only DLQ and safe delivery states.

### Discord Bot

- Verify interaction requests with Ed25519 over `X-Signature-Timestamp` plus
  the raw body and the application public key. Reject stale/future timestamps.
- Discord documents interaction types `1` (PING), `2` (application command),
  `3` (message component), `4` (autocomplete) and `5` (modal submit). An HTTP
  interaction endpoint must send its initial response within 3 seconds; the
  inline response is a `200` with a callback body, while the callback API
  returns `202` with no body. The local 30-second future-skew/300-second age
  fence is defensive because Discord signs a timestamp but does not publish a
  replay TTL.
- Keep Gateway intents and bot scopes explicit and least-privilege. A valid
  signature does not grant tenant access; bind the application/bot identity to
  the connection before processing commands.
- Model Discord interaction acknowledgement separately from commerce state.
  A deferred response, ephemeral message or component interaction is not
  payment or fulfillment evidence. Respect Discord rate-limit buckets and
  retry only when the provider contract says the request is safe.
- Preserve callback semantics by interaction type: `PING` returns type `1`,
  supported command/component/modal interactions may be deferred with type `5`,
  and autocomplete type `4` must return type `8` with a bounded choices list
  (the current contract returns an empty list until catalog-backed choices are
  admitted). Never send a type-`5` callback for autocomplete.
- The local interaction parser admits only Discord types `1`-`5`; an unknown
  future type is rejected rather than acknowledged with a mismatched callback.
  Add a reviewed contract and tests before expanding that allowlist.

## Official references

- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram Mini Apps validation: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
- Zalo Mini App user auth: https://docs.zaloplatforms.com/docs/MA/intro/best-practices/authen-user
- Zalo Mini App Open API signature: https://docs.zaloplatforms.com/docs/MA/openApis/open/webhook/verifysignature
- Zalo Mini App webhook setup: https://docs.zaloplatforms.com/docs/MA/openApis/open/webhook/intergration-webhook
- Zalo OA OAuth v4: https://docs.zaloplatforms.com/docs/OA/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new
- Zalo OA webhook: https://docs.zaloplatforms.com/docs/OA/webhook/tong-quan
- Zalo developer documentation: https://developers.zalo.me/
- WhatsApp webhook overview: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview
- WhatsApp message sending: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
- WhatsApp messaging limits: https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits
- Discord receiving/responding: https://discord.com/developers/docs/interactions/receiving-and-responding
- Discord Gateway intents: https://discord.com/developers/docs/topics/gateway#gateway-intents

## Local evidence

- `tests/unit/provider-contracts.test.ts` covers contract stages, exact origin
  allowlists, Telegram secret validation, WhatsApp raw-body HMAC, Discord
  Ed25519/replay validation, Zalo canonical-event signature behavior, provider
  pending behavior and reference-only normalization.
- `src/lib/channels/ingress.ts` and `tests/unit/provider-ingress.test.ts`
  provide the shared `verify -> normalize -> durable claim` sequencing seam;
  `src/lib/channels/provider-routes.ts` and
  `tests/unit/provider-routes.test.ts`/`tests/unit/zalo-mini-app-webhook.test.ts`
  add tenant-bound reference claims for the verified launch/webhook edges.
  Migrations `0058_channel_provider_event_receipts.sql` and
  `0059_channel_customer_identities.sql`, together with
  `src/lib/channels/provider-event-receipts.ts`,
  `src/lib/channels/provider-context.ts` and the concrete webhook services,
  now provide payload-free receipt claims, tenant-bound credential resolution
  and provider subject projection. WhatsApp Cloud and Discord interaction
  routes are contract-ready but still require external provider evidence;
  Zalo Mini App remains provider-pending and rejects ingress before body read.
- Migration `0059_channel_customer_identities.sql` and
  `src/lib/channels/customer-identities.ts` add a tenant/connection-bound
  HMAC identity projection for provider subjects. The projection keeps raw
  subjects out of D1, queues, exports and logs, preserves the legacy Telegram
  identity table, and rejects remapping one provider subject to another
  canonical customer.
- Provider activation, external credentials, webhook registration, outbound
  delivery, payment, fulfillment and production migration remain separate
  release gates in `docs/PROVIDER_GATE_AUDIT.md`.
