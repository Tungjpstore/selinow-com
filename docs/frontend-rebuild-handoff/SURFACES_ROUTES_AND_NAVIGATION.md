# Surfaces, routes va navigation

## Runtime route model

Tat ca page la Astro SSR (`output: "server"`); khong co page `prerender`. Hien tai co 25 logical canonical frontend routes va 2 redirect aliases. File `/` dung chung cho marketing va tenant storefront, phan nhanh theo hostname.

Cloudflare routing la lop van hanh; session/role/tenant policy van phai enforce trong source. Hien khong co global host firewall cho moi seller/admin/login/API path, vi vay frontend moi khong duoc coi hostname la auth boundary thay cho session/capability.

## Host classification

| Host kind | Hanh vi |
| --- | --- |
| Apex `selinow.com` | Marketing `/`; public pricing; production platform surface |
| `www.selinow.com` | Redirect 308 ve apex |
| `app.selinow.com` | `/` redirect 308 den `/app`; seller/admin/login intended origin |
| `api.selinow.com` | API va provider ingress; `/` khong render marketing/storefront |
| `{slug}.selinow.com` | Tenant candidate neu slug khong reserved |
| Active custom hostname | Tenant storefront sau ownership/SSL/routing validation |
| Reserved/unknown | Fail closed, khong resolve nham shop |

Public live tenant `/` va `/products/:slug` la edge-cache candidate: 60 giay, `stale-while-revalidate=300`. Cart, checkout, order va `/api/store/**` luon private/no-store.

## Canonical route inventory

### Marketing va auth

| Route | Audience/auth | Data/action | Required states |
| --- | --- | --- | --- |
| `/` tren marketing host | Anonymous | Runtime marketing/plans; host redirect rules | ready, data unavailable, wrong host 404 |
| `/pricing` | Anonymous, marketing host only | Runtime plan projection; no fake price/limit | ready, unavailable, wrong host 404 |
| `/login` | Anonymous; authenticated redirects `/app` | Magic-link request/consume | idle, submitting, accepted, rate-limited, expired/invalid, authenticated redirect |

Login la dashboard-auth surface, khong phai marketing contract du duoc kit cu xep vao marketing. Route private/no-store/noindex.

### Seller workspace

Moi route can session; anonymous redirect 302 den `/login`. Query `?shop=shop_...` chi chon tu danh sach active memberships; invalid/missing thuong fallback shop dau tien. Order detail la ngoai le: requested shop/order cross-tenant bi tu choi ro rang.

| Route | Audience | Data/action contract | Required states |
| --- | --- | --- | --- |
| `/app` | Tat ca seller roles | Overview, order ledger, readiness/catalog projections theo capability | no-shop, ready, subprojection forbidden, unavailable |
| `/onboarding` | Auth member; flow intended owner/manager, server owner-gates sensitive steps | Create/select/rename shop; channels, catalog, inventory, Telegram, PayOS, settings, readiness, test, publish | no-shop, step pending/in-progress/blocked/warning/ready, provider waits, forbidden |
| `/app/products` | Owner/manager | Category/product/variant CRUD-by-status; private-file policy; channel visibility remains a tenant-bound API contract with fail-closed missing rows (no inline control yet) | loading, empty, filtered empty, validation, conflict, forbidden, unavailable |
| `/app/inventory` | Owner/manager | Counts; preview/import encrypted keys | empty, preview valid/expired, importing, duplicate/rejected, recent-auth, forbidden, unavailable |
| `/app/orders` | Tat ca roles read; payment exception owner/manager | Latest 200 safe summaries; payment/fulfillment axes | empty, ready, payment exception unavailable/forbidden, data unavailable |
| `/app/orders/:id` | Member cua selected shop | Safe order detail, attempts, fulfillment, audit; manual fulfillment API co contract | ready, 403 cross-tenant, 404 missing, unavailable; messages/notes read-only/unavailable |
| `/app/customers` | Tat ca roles | Masked customer ledger; owner/manager detail, profile/status update, internal notes and redaction | empty, ready, forbidden, unavailable; support/viewer remain read-only; merge/unmask/delete unavailable |
| `/app/integrations` | Owner/manager Telegram+PayOS and channel connectors; owner domains | Safe provider/domain health; channel expansion catalog; connector request/cancel theo capability | disconnected, connecting, active, degraded, requested, provider-pending, canceled, waiting-user/provider, expired, failed, forbidden |
| `/app/domains` | Owner | Custom domain create/check/primary/delete | no custom domain, claim, DNS, hostname, SSL, routing, active, failed, forbidden |
| `/app/automation` | Tat ca roles read; controls theo task capability | Task list/detail, start limited capabilities, cancel/resume | pending, waiting-user, waiting-provider, running, retryable, succeeded, failed, canceled, forbidden |
| `/app/store` | Tat ca roles read; owner/manager edit; owner publish | Draft settings, narrow preview, readiness-gated publish | no-shop, draft, live, unpublished changes, blocked, conflict, forbidden, unavailable |
| `/app/members` | Owner | Masked membership projection plus owner invitation, role-change, suspension and revoke workflow | empty, ready, forbidden, unavailable; non-owner access fails closed; owner/self membership and hard delete remain protected |
| `/app/billing` | Owner | Plan/subscription/usage projection plus audited plan-change/cancel request intents | trialing, active, past-due, grace, canceled/blocked; request is provider-pending and never settles subscription state |
| `/app/data` | Owner | Audit, exports, deletion, seller abuse/moderation | empty, export pending/ready/expired, deletion lifecycle/legal hold, forbidden, unavailable |

### Redirect aliases

| Alias | Redirect | Rule |
| --- | --- | --- |
| `/app/telegram` | 307 -> `/app/integrations?focus=telegram#telegram` | Preserve selected `?shop` |
| `/app/store/settings` | 307 -> `/app/store?focus=settings#store-settings` | Preserve selected `?shop` |

Khong tao hai screen rieng cho aliases.

### Platform admin

Session + active platform role `owner|risk|support`. Non-admin render 403; role lookup/data failure render 503, khong fallback data.

| Route | Audience | Contract | Required states |
| --- | --- | --- | --- |
| `/admin` | Tat ca platform admin read; owner/risk risk actions; support triage | Abuse reports, moderation actions, recent ledger | empty, ready, forbidden, permission unavailable, data unavailable, mutation pending/conflict |
| `/admin/operations` | Tat ca admin read va co the acknowledge/resolve incident, acknowledge/request-retry/resolve unlinked DLQ; owner/risk legal hold va linked replay; owner rotations | Deletion, incident, DLQ, encryption rotation projections/actions | empty by section, role-scoped controls, waiting/retry/conflict, forbidden, unavailable |
| `/admin/shops` | Tat ca admin read | Bounded cursor directory, public identity + safe aggregate health | empty, filtered empty, next cursor, forbidden, unavailable; no impersonation/mutation shortcut |

Khong co route doc lap `/admin/orders`, `/admin/appeals`, `/admin/reports`, `/admin/audit`. Reports/audit la section/anchor cua `/admin`; orders/payments va appeals khong co read API day du.

### Tenant storefront

Tat ca route phai resolve active hostname. Custom domain can ownership verified. Live home/product indexable; coming-soon, suspended, missing va private buyer flow noindex/no-store.

| Route | Audience | Contract | Required states |
| --- | --- | --- | --- |
| `/` tren tenant host | Anonymous buyer | Published snapshot only; search/category filter progressive enhancement | live catalog, empty catalog, coming soon/draft, suspended, missing, unavailable |
| `/products/:slug` | Anonymous buyer | Public product projection; variant availability/version recheck | available, sold out, product missing/unpublished, catalog drift, suspended |
| `/cart` | Anonymous co opaque cart token | Client-held cart ID/token; server quote | empty, quoting, valid, expired, catalog/stock drift, invalid token, error |
| `/checkout` | Anonymous co cart/quote | Intent/recovery/final checkout; Turnstile/rate-limit; no paid inference | ready, quote expired, drift, inventory unavailable, provider unavailable, pending, order created |
| `/orders/:orderPublicId` | Buyer co order access token | Order/payment/fulfillment state, payment link, keys/downloads | unpaid/waiting, partial/manual review, paid/not fulfilled, fulfilled, expired, refunded/revoked, token/missing 404 |

## Navigation rules

- Marketing nav khong mang session/shop assumptions.
- Workspace shell co shop switcher membership-bound va role-aware nav.
- Workspace nav chia thanh Command, Commerce, Channels, Operations va Workspace.
  `DASHBOARD_INFORMATION_ARCHITECTURE.md` la source cho thu tu va grouping; day
  la presentation IA, khong phai authorization moi.
- Selected shop query duoc giu khi di giua workspace routes.
- Khi switch shop: xoa entity ID, cursor, filter, hash va local draft cua tenant cu; `/app/orders/:id` quay ve `/app/orders`.
- Storefront nav khong cho buyer chon tenant; hostname la context.
- Order/cart/grant tokens khong dat vao URL, analytics, logs hoac link share.
- Admin shell khong co seller impersonation.
- Error/forbidden state phai co safe exit route, khong tu redirect sang shop/admin gan nhat neu co nguy co data confusion.

### Integrations lane split

`/app/integrations` van la mot canonical screen nhung phai tach lane va anchor
cho Website, PayOS, Telegram Bot, Telegram Mini App, Zalo Mini App, Zalo OA,
WhatsApp Cloud, Discord Bot, connector requests va API credentials. Moi lane
co identity, connection, inbound proof, outbound capability, commerce
capability, freshness va next action rieng. Khong duoc copy health/credential/
activation state tu lane khac; khong duoc hien provider payload, token, secret,
internal tenant ID hoac coi `requested`/`provider_pending` la `active`.

`/app/telegram` la redirect alias den Telegram Bot lane (`focus=telegram#telegram`),
khong phai mot screen thu hai. Telegram Mini App co anchor rieng va van dung
session exchange route; Zalo, WhatsApp va Discord chi hien safe catalog/request
projections cho toi khi external gate duoc chap nhan.

`/app/automation` doc durable tasks theo cac nhom `needs_seller`,
`waiting_provider`, `running_retryable` va `terminal`. Task projection chi co
safe error/status/action URL; client khong duoc tu tao evidence token, lease,
provider payload hoac claim external work da hoan tat.

## Stale kit warning

PromptOS exact kit chi co 17 route; working-copy matrix chi co 19. Cac matrix do bo sot nhieu canonical routes hien tai, aliases va admin overview/shop directory. Khong mo rong frontend moi bang cach chi patch matrix cu; dung inventory 25+2 trong tai lieu nay va `route-contracts.yaml`.
