# Channel Provider Research

Last reviewed: 2026-08-02

This is a product and architecture discovery note, not a claim that these providers are implemented. Provider access, policy review, billing, seller demand and market eligibility remain release gates.

The provider-specific runtime boundary and fail-closed verification rules are
recorded in `docs/CHANNEL_PROVIDER_CONTRACTS.md`. This note remains the
discovery/roadmap view and is not activation evidence.

## Automation boundary

Selinow can be fully technical-configuration-free after a seller has a valid account on the provider and grants the required consent. No provider reviewed here exposes a safe API for Selinow to create or legally verify the seller's business account, phone number, Official Account, Facebook Page or TikTok Shop on the seller's behalf. The onboarding state machine must therefore distinguish `prerequisite_required`, `consent`, `token_exchange`, `webhook_setup`, `billing_required`, `ready` and `reauthorization_required`.

## Provider matrix

| Provider | Best first capability | Automation after consent | Irreducible seller action | Commerce boundary |
| --- | --- | --- | --- | --- |
| Zalo OA | Vietnamese conversational channel | OAuth v4/PKCE token exchange, OA selection, webhook routing and health checks | Own a verified OA and eligible package; grant app permissions | Catalog/order APIs are promising; verify current Shop entitlement and checkout behavior with a capability probe |
| TikTok Shop | Marketplace order/catalog sync | OAuth token exchange, shop discovery, Event API/webhook setup and reconciliation | Activated Shop and completed KYC; app review may apply | TikTok owns native checkout/payment; Selinow imports authenticated orders and pushes fulfillment/status |
| WhatsApp Cloud | International conversational channel | Embedded Signup, WABA/phone setup, token exchange, `subscribed_apps` and webhook setup | OTP/phone and business verification; billing may require a Solution Partner path | Use Selinow Checkout + PayOS for Vietnam unless a supported native payment path is proven |
| Facebook Messenger | Meta conversational channel | Facebook Login for Business, Page selection, Page token and webhook subscription | Seller must already own a Facebook Page; App Review/Advanced Access may apply | Use Selinow Checkout; do not assume native Vietnam payment |

## Bot and Mini App boundary

Telegram Bot, Telegram Mini App, Zalo Mini App, Zalo OA, WhatsApp Cloud and
Discord Bot are separate identities and connection families. A Mini App launch
proof does not establish a messaging webhook, and a messaging webhook does not
prove payment or fulfillment. Telegram server-side `initData` HMAC, Discord
Ed25519 interaction proof, WhatsApp raw-body HMAC and the Zalo Mini App
`x-zevent-signature` canonical-event hash are implemented as local verifier
contracts. Zalo Mini App/OA activation remains provider-pending until app/OA
identity, credentials, allowlists, entitlements, webhook registration,
capability probes and outbound evidence are recorded.

## Bot and Mini App research matrix

| Surface | Provider identity | Inbound proof | Outbound boundary | Selinow backend boundary |
| --- | --- | --- | --- | --- |
| Telegram Bot | Bot token + tenant webhook secret | `X-Telegram-Bot-Api-Secret-Token` and `update_id` replay ledger | `https://api.telegram.org` with per-bot throttles | Existing private-chat commerce adapter; payment and fulfillment still require provider acceptance |
| Telegram Mini App | Bot-bound Web App launch | Server-side `initData` HMAC and fresh `auth_date` | Telegram Bot API / `answerWebAppQuery` only after explicit capability grant | Contract-ready session exchange plus tenant-bound catalog/cart/quote/checkout/order projections; payment and fulfillment remain separate gates |
| Zalo Mini App | App ID + API Key + allowlisted server identity | `x-zevent-signature` canonical event hash; user access token for profile calls | Zalo Open API after `appsecret_proof` and app policy checks | Provider-pending route; no body consumption or commerce mutation before admission |
| Zalo Official Account | OA ID + OAuth v4 grant | HTTPS webhook delivery; current official contract does not document a signature/challenge | OA API with rotating access/refresh tokens | OAuth/PKCE state is source-local, but the public callback remains provider-pending until a server-side secret binding and provider-returned OA identity proof exist |
| WhatsApp Cloud | WABA/phone-number/app connection | GET verify-token challenge; POST `X-Hub-Signature-256` over raw bytes; no signed timestamp header | `https://graph.facebook.com`, templates and customer-service window rules | Contract-ready credential-bound webhook and receipt claim; Meta business acceptance remains pending |
| Discord Bot | Application ID + public key + bot installation | Ed25519 over timestamp plus exact raw body | `https://discord.com` REST/Gateway with explicit intents and rate limits | Contract-ready interaction acknowledgement and receipt claim; installation and outbound acceptance remain pending |

The matrix is deliberately split by identity and proof. A valid signature or
launch payload only authenticates the provider request; it never authorizes a
tenant, confirms a payment, allocates inventory or reveals fulfillment data
without the corresponding D1 connection, subscription and capability fences.

## Verified Zalo constraints

- Mini App user login uses `zmp-sdk.getAccessToken`; the server calls
  `https://graph.zalo.me/v2.0/me` with `access_token` and mandatory
  `appsecret_proof = HMAC-SHA256(app_secret, access_token)`. Profile and phone
  fields are consented/scoped operations. The current local credential
  envelope stores App ID/API Key only, so profile/session runtime remains
  provider-pending until an app-secret field and rotation/acceptance contract
  are admitted.
- Mini App Open API webhooks use `x-zevent-signature`; the official algorithm
  sorts top-level field names, concatenates their values (nested objects use
  JSON serialization), appends the API Key, then computes SHA-256 hex. The
  webhook is configured in the Zalo App and independent apps have a smaller
  event/API surface than solution partners.
- OA OAuth v4 uses PKCE. Authorization codes are one-use and valid for 10
  minutes; access tokens last 25 hours; refresh tokens rotate on use and are
  valid for 3 months. After authorization, Zalo redirects the OA
  administrator's browser to the registered callback with a GET query
  containing `code` and `oa_id` (and the caller's state when supplied); the
  local callback matches that transport but remains provider-pending before
  state consumption/token persistence. The current token examples use
  `expires_in`, while the response-property table also spells the field
  `expire_in`; the adapter accepts either only when unambiguous. OA webhook
  delivery requires HTTPS and HTTP 200 within 2 seconds, retries at
  30s/5m/15m/30m/1h and adds the `num_retry` request header on retries. The
  current official webhook page does not document a signature or challenge.

## Recommended order

1. `zalo_oa` — highest fit for Vietnamese seller demand and the existing conversational adapter shape.
2. `tiktok_shop` — proves Selinow is a commerce platform, but must be modeled as a marketplace/order-sync adapter rather than a chat adapter.
3. `whatsapp_cloud` — strongest no-tech onboarding mechanics, with Meta verification and billing constraints.
4. `facebook_messenger` — reuse the shared Meta OAuth, token vault and webhook router after WhatsApp.

## Shared architecture

- Keep `zalo_oa`, `whatsapp_cloud` and `facebook_messenger` as separate conversational adapters over shared OAuth, credential vault, webhook ingress and delivery primitives.
- Keep `tiktok_shop` as a marketplace adapter with external order identity, immutable provider snapshots, reconciliation, inventory conflict states and fulfillment push retries.
- Use capabilities such as `messaging`, `catalog_write`, `inventory_write`, `orders_read`, `fulfillment_write`, `returns`, `finance` and `native_checkout`; never infer support from provider name alone.
- Preserve Selinow's commerce core as the source of truth for website/PayOS orders. Import marketplace payment state only from authenticated provider evidence.

## Official sources

- Zalo Mini App auth: https://docs.zaloplatforms.com/docs/MA/intro/best-practices/authen-user
- Zalo Mini App signature: https://docs.zaloplatforms.com/docs/MA/openApis/open/webhook/verifysignature
- Zalo Mini App webhook: https://docs.zaloplatforms.com/docs/MA/openApis/open/webhook/intergration-webhook
- Zalo App: https://developers.zalo.me/docs/official-account/bat-dau/khoi-tao-ung-dung
- Zalo OAuth: https://docs.zaloplatforms.com/docs/OA/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new
- Zalo webhook (official Markdown): https://docs.zaloplatforms.com/docs/OA/webhook/tong-quan.md
- Zalo Shop products: https://developers.zalo.me/docs/zalo-shop/api/san-pham
- Zalo Shop orders: https://developers.zalo.me/docs/zalo-shop/api/don-hang
- WhatsApp Embedded Signup: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview
- WhatsApp Catalogs: https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/catalogs-overview
- Messenger onboarding: https://developers.facebook.com/documentation/business-messaging/messenger-platform/get-started
- Messenger App Review: https://developers.facebook.com/documentation/business-messaging/messenger-platform/app-review
- TikTok authorization: https://partner.tiktokshop.com/docv2/page/authorization-overview-202407
- TikTok API overview: https://partner.tiktokshop.com/docv2/page/tts-api-concepts-overview
- TikTok webhooks: https://partner.tiktokshop.com/docv2/page/tts-webhooks-overview

## Open probes before implementation

- Zalo Shop entitlement and current order/checkout API behavior for the intended account tier.
- TikTok Shop API access, digital-goods policy and target-market capabilities.
- WhatsApp `send_cart`/catalog permissions and the billing path for a non-Solution-Partner integration.
- Messenger Page creation limits and the exact Advanced Access/App Review requirements.
