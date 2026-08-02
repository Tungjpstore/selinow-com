# Product capability catalog

## Cach doc

- `Implementation` noi schema/service/API da co hay chua.
- `Frontend` noi surface hien tai/new rebuild duoc phep expose.
- `Activation` noi production platform deploy co dong nghia tinh nang ngoai da san sang hay khong.

Khong bien `provider_pending`, `external_pending`, `service_only` hoac `read_only` thanh success demo trong production frontend.

## Platform, identity va tenancy

| Capability | Implementation | Frontend contract | Activation/limitation |
| --- | --- | --- | --- |
| Marketing + runtime pricing | live | `/`, `/pricing` public SSR | Production live; khong hard-code plan/price |
| Magic-link auth | live | `/login`, request/consume/logout | Production surface live; rate limit/expiry states required |
| Opaque session + CSRF | live | Private workspace/admin APIs | Khong expose session token; recent auth 15 phut cho sensitive action |
| Multi-shop membership | live | SSR shop switcher, selected public shop query | Khong co browser shop-list API; chi active memberships |
| Seller roles/capabilities | live | Owner/manager/support/viewer matrix | Server is final authority |
| Platform admin roles | live | Owner/risk/support | Khong impersonation |
| Plan features/limits | live projection | Billing/readiness/action policy | Mutation plan/subscription chua co |
| Locale/currency/timezone | live | `en`, `vi-VN`, minor units, shop timezone | No FX; merchant content single-language |

## Shop setup va storefront publication

| Capability | Implementation | Frontend contract | Activation/limitation |
| --- | --- | --- | --- |
| Shop create/profile | live | Onboarding/settings | Currency change fail closed neu variant drift |
| Platform subdomain | live | Created atomically, fallback routing | Production platform domains live |
| Onboarding wizard | live | Durable server steps, re-entry/regression | Fresh external-provider seller acceptance pending |
| Readiness engine | live | Render all checks/freshness/blockers | UI khong tu aggregate |
| Storefront draft/theme/content/SEO | live | `/app/store` read/edit | Theme freedom trong allowlisted fields |
| Storefront publish snapshot | live | Owner, readiness/version gated | Draft != public live |
| Public storefront home/product | live | SSR/no-JS, hostname-resolved | Production platform host surface live |
| Storefront search/category filter | live | Published catalog only | Progressive enhancement |

## Catalog va inventory

| Capability | Implementation | Frontend contract | Activation/limitation |
| --- | --- | --- | --- |
| Categories | live | Create/update/archive | No hard delete |
| Products | live | Draft/active/suspended/archive | Moderation suspension authoritative |
| Variants/options/price/min-max | live | Full create/update | Seller options JSON string, public object |
| Atomic product + initial variant | live | Idempotent create | Avoid two-write orphan UI |
| Encrypted license-key import | live | Preview then exact import | Recent-auth; no plaintext render/log |
| Inventory availability/reservation/sale | live | Counts and safe timestamps | Counts not allocation promise |
| Private file upload/policy | live service/API | Catalog UI may expose bounded setup | No public R2 URL; buyer grant flow required |
| Product channel visibility/hidden state | absent | Do not expose | Needs new backend contract |
| Discount management | absent | Do not expose | Checkout may consume existing discount, no seller CRUD |

## Buyer commerce

| Capability | Implementation | Frontend contract | Activation/limitation |
| --- | --- | --- | --- |
| Opaque cart | live | Create/mutate; client retains capability token | No cart GET |
| Server quote | live | Total/discount/evidence/expiry | Client total not authoritative |
| Atomic checkout/reservation | live | Drift/Turnstile/rate-limit/idempotency states | Production provider/fulfillment activation separately controlled |
| Order access without buyer account | live | Order route + opaque access token | Current MVP has no buyer accounts |
| Order/payment/fulfillment status | live | Independent axes | Return page never confirms paid |
| Public abuse report | live | Sanitized, Turnstile, idempotent | Reporter contact never echoed |
| Buyer account/history/profile | absent | Do not expose | Roadmap only |

## Payments

| Capability | Implementation | Frontend contract | Activation/limitation |
| --- | --- | --- | --- |
| Tenant PayOS credentials | live code | Connect/rotate/disconnect/health, secret one-way input | Controlled production seller channel not activated |
| Payment link + QR | live code | Order action; state is pending only | QR/return not payment evidence |
| Signed webhook decision | live | Exact paid/partial/overpaid/late/mismatch | Provider UAT pending for external activation |
| Reconciliation | live | Safe pending/retry projection | Correct tenant credential required |
| Payment exceptions | live read projection | Owner/manager read; safe evidence only | No seller resolution/override API |
| Exact refund/chargeback revocation | live service/schema/test | Render refunded/revoked states | Provider-backed reversal activation pending |
| Refund/cancel from seller UI | absent | Do not expose | Needs provider/operator contract |
| Second payment provider | roadmap | Do not advertise | Provider-neutral architecture only |

## Fulfillment va entitlements

| Capability | Implementation | Frontend contract | Activation/limitation |
| --- | --- | --- | --- |
| Pooled license-key fulfillment | live | Protected buyer reveal | Plaintext response is no-store/no-log |
| Seller-attested manual fulfillment | live API/service | Owner/manager exact item action | UI currently not primary browser client; use exact contract |
| Private downloadable fulfillment | live | Entitlement list -> one-time grant -> stream | Website delivery; Telegram secure handoff follow-up |
| Generic entitlement graph | live service/schema | Render pending/active/suspended/expired/revoked | UI coverage partial/service-oriented |
| Generated-license execution | live service/schema/test | Queue/reconcile/manual-review/artifact states | Seller provider config service-only; provider activation pending |
| Payment-reversal access revocation | live service/schema/test | Future access closes, history immutable | No client/provider shortcut |
| Membership/community/seat/device entitlements | foundation only | Do not market as complete product | Requires product-specific runtime/UI |

## Telegram va channels

| Capability | Implementation | Frontend contract | Activation/limitation |
| --- | --- | --- | --- |
| Seller Telegram bot connect/health | live code | `/app/integrations` safe projection | Controlled production bot/channel inactive |
| Telegram private-chat catalog/cart/checkout | live code/test | Shared canonical commerce | Provider-backed acceptance pending |
| Paid notification/key reveal | live code | Shared fulfillment fences | External activation pending |
| Generic channel registry/capabilities | live foundation | Render effective capabilities only | Generic lifecycle UI incomplete; expansion catalog is additive and safe |
| Telegram Mini App manifest + launch verifier | contract_ready | Render catalog/request status; bind identity only after server HMAC/freshness checks | Bot/provider activation and tenant rollout pending |
| Zalo Mini App manifest + connector request | provider_pending | Render safe catalog entry and durable request states | Zalo app credentials, policy and provider execution pending |
| WhatsApp Cloud manifest + messaging policy | contract_ready | Render safe catalog/request states; enforce customer-service window/templates | Meta business credentials, webhook and provider acceptance pending |
| Discord bot manifest + connector request | contract_ready | Render safe catalog/request states; direct/private reveal only | Bot installation, permissions and provider execution pending |
| Channel connector requests (migrations `0055`-`0056`) | contract_ready | Catalog + list/create/cancel request APIs; direct-D1 scope guards; show requested/provider-pending/canceled states | No inline secret delivery; provider activation remains pending |
| Fake adapter parity | test-only | Never show to users | Verification boundary only |
| Other Meta/marketplace/second payment provider | roadmap | Do not advertise/control | No runtime adapter |
| Managed shared channel/bot | roadmap | Do not expose | External policy/product work |

## Domains

| Capability | Implementation | Frontend contract | Activation/limitation |
| --- | --- | --- | --- |
| Platform shop subdomain | live | Always-visible safe fallback | Production platform surface live |
| Custom hostname ownership claim | live code | TXT guidance/check lifecycle | External customer-domain activation pending |
| Cloudflare hostname/DNS/SSL | live code | Separate lifecycle rail | Cloudflare SaaS/Turnstile hostname gates required |
| Primary/canonical switching | live code | Owner/version/recent-auth | Only fully ready active domain |
| Domain delete/cleanup | live code | Suspended -> provider cleanup -> deleted | Active payment origin/hold may block |
| Other DNS provider OAuth | roadmap | Do not expose | Manual DNS only |

## Seller operations surfaces

| Capability | Implementation | Frontend contract | Activation/limitation |
| --- | --- | --- | --- |
| Order list/detail | live | Safe masked read | Latest 200, no server filters/pagination |
| Customer ledger | read-only | Masked list | No detail/edit/merge/note/delete |
| Members | read-only | Owner list | No invite/role/revoke |
| Billing | read-only | Plan/subscription/usage | No billing mutation/provider |
| Automation tasks | live | Read all; controls capability/version gated | Start API limited to two capabilities |
| API credentials | live API/service | `/app/integrations` lists, issues and revokes scoped credentials; new token is shown once | Requires recent auth; token cannot be recovered after issuance |
| Audit ledger | live read | Owner safe projection | Safe fields only |
| Standard export | live | Encrypted R2, one-time download | 7-day retention |
| Plaintext inventory export | live high-risk | Explicit risk acknowledgement | 1-hour retention; never browser-preview |
| Shop deletion | live | Ordered/resumable/legal-hold states | Irreversible fences; do not imply instant delete |
| Seller moderation | live | Owner product suspend/restore boundary | Cannot override platform suspension |
| Analytics/dashboard reporting | absent | Do not fake charts/metrics | Needs data/product contract |

## Platform admin/operations

| Capability | Implementation | Frontend contract | Activation/limitation |
| --- | --- | --- | --- |
| Abuse triage/moderation | live | Support triage; owner/risk decisions | Audited, recent-auth, idempotent |
| Shop directory | read-only live | Safe public identity/aggregates | No identity join, impersonation or shortcut mutation |
| Incidents | live | Acknowledge/resolve/version guards | Safe context only |
| Dead letters | live | Acknowledge/retry/resolve/replay | Retry requested != completed |
| Deletion legal holds | live | Owner/risk set/release | Blocks irreversible work |
| Encryption rotation | live | Platform owner, dry/live confirmations | High-risk operator surface |
| Admin orders/payments/appeals | absent/incomplete | Do not invent screens | Reports/audit live within current surfaces only |

## Production interpretation

Production hien chay current Worker/schema cho platform routes. Dieu nay khong dong nghia cac external integration da duoc bat. Frontend rebuild phai dung ba lop hien thi:

1. `implemented`: code/schema/service co.
2. `configured`: tenant/platform da co credential/resource hop le.
3. `activated/accepted`: external provider/domain flow da qua controlled gate.

Chi khi server projection xac nhan ca lop can thiet thi UI moi duoc dung copy "san sang" hoac "dang hoat dong".
