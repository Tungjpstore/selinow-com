# Channel Provider Research

Last reviewed: 2026-07-26

This is a product and architecture discovery note, not a claim that these providers are implemented. Provider access, policy review, billing, seller demand and market eligibility remain release gates.

## Automation boundary

Selinow can be fully technical-configuration-free after a seller has a valid account on the provider and grants the required consent. No provider reviewed here exposes a safe API for Selinow to create or legally verify the seller's business account, phone number, Official Account, Facebook Page or TikTok Shop on the seller's behalf. The onboarding state machine must therefore distinguish `prerequisite_required`, `consent`, `token_exchange`, `webhook_setup`, `billing_required`, `ready` and `reauthorization_required`.

## Provider matrix

| Provider | Best first capability | Automation after consent | Irreducible seller action | Commerce boundary |
| --- | --- | --- | --- | --- |
| Zalo OA | Vietnamese conversational channel | OAuth/PKCE token exchange, OA selection, webhook routing and health checks | Own a verified OA and eligible paid package for third-party apps | Catalog/order APIs are promising; verify current Shop entitlement and checkout behavior with a capability probe |
| TikTok Shop | Marketplace order/catalog sync | OAuth token exchange, shop discovery, Event API/webhook setup and reconciliation | Activated Shop and completed KYC; app review may apply | TikTok owns native checkout/payment; Selinow imports authenticated orders and pushes fulfillment/status |
| WhatsApp Cloud | International conversational channel | Embedded Signup, WABA/phone setup, token exchange, `subscribed_apps` and webhook setup | OTP/phone and business verification; billing may require a Solution Partner path | Use Selinow Checkout + PayOS for Vietnam unless a supported native payment path is proven |
| Facebook Messenger | Meta conversational channel | Facebook Login for Business, Page selection, Page token and webhook subscription | Seller must already own a Facebook Page; App Review/Advanced Access may apply | Use Selinow Checkout; do not assume native Vietnam payment |

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

- Zalo App: https://developers.zalo.me/docs/official-account/bat-dau/khoi-tao-ung-dung
- Zalo OAuth: https://developers.zalo.me/docs/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new
- Zalo webhook: https://developers.zalo.me/docs/official-account/webhook/tong-quan
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
