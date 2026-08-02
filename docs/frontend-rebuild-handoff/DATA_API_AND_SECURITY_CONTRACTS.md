# Data, API va security contracts

## Response va error envelope

Success JSON thuong co dang:

```json
{ "ok": true, "requestId": "...", "resultSpecificField": {} }
```

Error JSON luon la:

```json
{ "ok": false, "code": "safe_error_code", "requestId": "...", "issues": ["optional_issue_code"] }
```

Khong co `message` tin cay tu server. Frontend map `code/issues` qua i18n catalog, va co the hien `requestId` cho support. Khong render raw error, stack, provider response hoac SQL error.

JSON mutation can `Content-Type: application/json`; default body toi da 16 KiB, mot so route 1-8 KiB, inventory preview/import 2 MiB, private asset raw upload 50 MiB. Sai content type `415`; qua lon `413`.

## Authentication va request protection

| Contract | Frontend obligation |
| --- | --- |
| Session | Opaque HttpOnly cookie; anonymous private API la 401, khong phai anonymous projection 200 |
| CSRF | Same-origin `Origin === DASHBOARD_ORIGIN`, `X-CSRF-Token` khop readable CSRF cookie va session hash |
| Recent auth | Sensitive action yeu cau authenticated time <= 15 phut; `recent_auth_required` can re-login |
| Idempotency | Stable key cho cung logical payload; cung key/khac payload -> 409 `idempotency_conflict` |
| Optimistic version | Gui `expectedVersion`; 409 thi reload authoritative projection, khong tu tang version |
| Tenant | Dashboard `:shopPublicId` -> active membership -> internal `shop_id`; storefront -> Host; API v1 -> Bearer credential |
| Private response | `private, no-store`; buyer order/download noindex; secret capability token khong vao URL/log/storage |

Resource public IDs dung prefix on dinh nhu `shop_`, `cat_`, `prd_`, `var_`, `order_`, `oit_`, `dom_`, `dcl_`, `akc_`, `dav_`, `dgr_`, `exp_`. Khong cat prefix hoac chuyen sang internal ID tren client.

## Auth va health API

| Method/path | Protection | Request -> response |
| --- | --- | --- |
| `GET /api/health` | Public | Service/phase + canonical Website/Telegram commerce marker |
| `POST /api/auth/magic-link/request` | Exact public Origin + rate limit | `{email,displayName?}` -> `202 {accepted,expiresAt}`; debug link local-only |
| `GET /api/auth/magic-link/consume?token=` | Initiation cookie + one-time token | Set session/CSRF cookies, 303 `/app`; invalid -> 401 |
| `GET /api/auth/session` | Session | Safe user `{displayName,email}` only |
| `POST /api/auth/logout` | CSRF | Revoke session, clear cookies |

## Storefront buyer API

Tenant luon tu hostname. Locale precedence: explicit `lang`, locale cookie, `Accept-Language`, shop default, fallback.

### Catalog, cart va quote

| Method/path | Request | Safe response / notes |
| --- | --- | --- |
| `GET /api/store/catalog` | Host context | `shop`, `categories`, public `products/variants`; exact stock chi khi `showExactStock` |
| `GET /api/store/products/:slug` | Host context | Product + public details; public variant `options` la object |
| `POST /api/store/cart` create | `{items:[{variantId,quantity}],locale?}` | `201 {cartId,cartToken,expiresAt}` |
| `POST /api/store/cart` mutate | Header `Idempotency-Key`; `{cartId,cartToken,locale?,mutation}` | Increment item hoac apply discount; `{cartId,cartToken,replayed}` |
| `POST /api/store/quote` | `{cartId,cartToken}` | Server total, expiry, evidence, exact item/version snapshot |

Khong co cart GET. Browser giu `cartId/cartToken` nhu secret capability va dung quote API de phuc hoi projection; khong tu tinh authoritative total.

### Checkout

| Method/path | Idempotency | Contract |
| --- | --- | --- |
| `POST /api/store/checkout/intent` | Trong body | `{cartId,cartToken,customerEmail?,expected[],idempotencyKey,quoteEvidence}` -> short recovery evidence |
| `POST /api/store/checkout/recover` | Trong body | Cung snapshot + `recoveryEvidence` -> order projection + order token |
| `POST /api/store/checkout` | Header | `{cartId,cartToken,customerEmail?,expected[],quoteEvidence,turnstileToken?}` -> `201` order |

Order response co `orderId/orderNumber/orderToken/currency/totalMinor/status/paymentStatus/fulfillmentStatus/expiresAt`. UI bat buoc co nhanh rieng cho `cart_not_found`, `catalog_changed`, `checkout_changed`, `inventory_unavailable`, `quantity_unavailable`, `quote_expired`, `quote_invalid`, `provider_unavailable`. Checkout success chi co nghia order da tao, khong co nghia paid/fulfilled.

### Order access va delivery

| Method/path | Protection | Contract |
| --- | --- | --- |
| `GET /api/store/orders/:orderPublicId` | `X-Order-Access-Token` | Safe order view; khong tra token/noi bo/provider raw |
| `POST .../payment-link` | Order token | `201` PayOS link/QR/attempt state; QR/return khong paid authority |
| `GET .../keys` | Order token + fulfillment fences | Plaintext keys trong response; khong cache/log/persist |
| `GET .../downloads` | Order token | Asset/entitlement/download counters |
| `POST .../downloads/:assetVersionId/grant` | Order token + `X-Order-Item-Id` + idempotency | One-time short grant token |
| `POST .../downloads/grants/:grantId/consume` | Order token + delivery grant token | Binary attachment; no JSON |

Sai order/grant token co chu dich tra 404 de khong tiet lo ton tai. Token order/grant/export/API credential la secret capability, khong dat trong query string, analytics hoac log.

### Public abuse report

`POST /api/store/abuse-reports`: header idempotency; body `{category,targetKind,summary,productSlug?,reporterContact?,turnstileToken?}`. Moi report `202`, replay `200`; response chi co public ID/status. Contact duoc hash; summary sanitize.

## Seller shop va catalog API

### Shop

| Method/path | Protection | Contract |
| --- | --- | --- |
| `POST /api/app/shops` | CSRF + idempotency 8-128 | Create shop/owner/settings/trial/subdomain atomically |
| `GET /api/app/shops/:shop` | Session + `shop:read` | `ShopView` |
| `PATCH /api/app/shops/:shop` | CSRF + `shop:update` | Partial name/currency/locale/countries; currency drift -> 409 |

`ShopView`: `publicId,slug,name,status,role,planCode,subscriptionState,currency,defaultLocale,timezone,merchantCountry,businessCountry,featureFlags,limits`. Khong co `GET /api/app/shops`; workspace shop switcher hien tai SSR bang membership service, frontend khong duoc gia dinh endpoint list.

### Seller catalog

| Method/path | Protection | Contract |
| --- | --- | --- |
| `GET .../:shop/catalog` | Session + `catalog:manage` | Categories/products/variants + safe inventory counts |
| `POST .../categories` | CSRF + catalog manage | Full category create |
| `PUT .../categories/:categoryId` | CSRF + catalog manage | Full category replacement/status archive |
| `POST .../products` | CSRF + catalog manage | Product-only, hoac atomic initial variant voi idempotency 16-128 |
| `PUT .../products/:productId` | CSRF + catalog manage | Full product replacement; active needs active variant |
| `POST .../products/:productId/variants` | CSRF + catalog manage | Full variant create |
| `PUT .../variants/:variantId` | CSRF + catalog manage | Full variant replacement |

Khong co hard delete; archive qua `status`. Seller variant `optionsJson` la JSON string; public variant `options` la object. Price la integer minor-unit, currency server validated.

### Inventory va private files

| Method/path | Protection | Contract |
| --- | --- | --- |
| `POST .../variants/:variantId/inventory/preview` | CSRF + recent auth | Body <=2 MiB source/data/filename; counts + preview token, khong key/fingerprint |
| `POST .../variants/:variantId/inventory/import` | CSRF + recent + idempotency | Exact preview payload + preview token; replay-safe result |
| `POST .../assets/private-files` | CSRF + catalog manage | Raw bytes <=50 MiB + content type/file name; metadata/hash only |
| `POST .../products/:productId/private-file-policy` | CSRF | Asset version, download limits, grant/entitlement TTL |

Preview token bind user, tenant, variant, source va exact payload. Xoa plaintext source khoi input/DOM/memory ngay sau commit/cancel; khong dua vao screenshot/log.

### Storefront draft va publication

`GET/PATCH .../settings` va `GET/PATCH .../storefront/draft` la cung contract. PATCH can CSRF + recent auth + `expectedVersion` va cac field content/theme/SEO/stock visibility. Response co `version,publishedVersion,publishedAt,publicationState,hasUnpublishedChanges`.

- `POST .../storefront/publish`: owner, CSRF, recent auth, `{expectedVersion}` -> full settings.
- `POST .../catalog/publish`: owner, CSRF, recent auth, `{expectedVersion}` -> `{status:"active"}`; day la onboarding/legacy publication route, response khac.

## Seller order va fulfillment API

| Method/path | Protection | Contract |
| --- | --- | --- |
| `GET .../orders` | Session + `shop:read` | Latest 200 masked summaries; no pagination/filter contract |
| `GET .../orders/:orderId` | Session + `shop:read` | Safe detail, payment attempts, fulfillment records, download counters, audit |
| `POST .../orders/:orderId/manual-fulfillments` | CSRF + recent + fulfillment manage + idempotency | Seller-attested per-item immutable execution; external reference khong echo |

Khong co seller cancel/refund/edit order, message/note, payment override hoac retry-delivery API. Khong tao controls gia.

## Integrations, payment va domains API

### PayOS

- `GET/PUT/DELETE .../payments/payos`; PUT/DELETE CSRF + recent auth + `payments:manage`.
- PUT exact `{clientId,apiKey,checksumKey}`; response chi safe metadata/status.
- `POST .../payments/payos/health-checks`: CSRF + recent; `201` safe projection.
- `GET .../payments/exceptions`: latest 100, `payments:manage`; `safeEvidenceJson` la JSON string can parse phong thu.

Khong bao gio render lai PayOS secret. Provider activation/controlled acceptance la external gate, khong suy ra tu status schema.

### Telegram

- `GET/PUT/DELETE .../integrations/telegram`; PUT/DELETE CSRF + recent auth + `integrations:manage`.
- PUT `{botToken,replaceBot?}`; projection chi sanitized bot identity/health.
- `POST .../integrations/telegram/health-checks`: CSRF + recent; `201`.

Khong tra bot token/webhook secret. Mini App launch identity is a separate server-side
contract: `initData` must pass Telegram Web App HMAC, hash uniqueness, bounded payload,
freshness (default 24 hours, max seven days) and user projection validation before any
tenant/customer binding. The verifier never returns or persists the bot token.

### Channel expansion connectors (migrations `0055`-`0056`)

The channel expansion catalog is a safe, additive projection. It currently lists
`telegram.mini_app`, `zalo.mini_app`, `whatsapp.cloud` and `discord.bot` with explicit
capabilities, provider execution stage and required seller action. Every manifest sets
`inlineSecretDelivery: false`; the catalog contains no credentials, webhook secrets,
provider payloads or internal tenant IDs.

| Method/path | Protection | Contract |
| --- | --- | --- |
| `GET .../channels/catalog` | Session + `shop:read` | Returns `{ok, expansions, requestId}`. Each expansion has stable `code`, `providerCode`, `family`, `capabilities`, `providerExecution`, `requiredSellerAction`, `safeDescriptionKey`, `version` and `inlineSecretDelivery:false`. |
| `GET .../channels/requests` | Session + `shop:read` | Returns at most 100 tenant-bound requests with `requestPublicId`, channel/provider code, status, safe failure code, timestamps and optimistic `version`. |
| `POST .../channels/requests` | CSRF + recent-auth + `integrations:manage` + `Idempotency-Key` | Allowlist `{channelCode,providerCode}`. Creates one durable seller intent per provider in `requested`; idempotent replay returns the same safe projection. It never accepts credentials or implies provider activation. |
| `DELETE .../channels/requests/:requestPublicId` | CSRF + recent-auth + `integrations:manage` + `Idempotency-Key` + expected version | Body `{expectedVersion}`; CAS-cancels only `requested`/`provider_pending` rows. The immutable D1 row is retained and the request never becomes active from a browser action. |

Connector state is `requested -> provider_pending -> active|rejected` or
`requested|provider_pending -> canceled`; `active` additionally requires a hashed
provider reference and reviewer evidence. Provider execution, webhook verification,
outbound delivery and payment/fulfillment decisions remain separate acceptance gates.

### Messaging policy boundary

- WhatsApp Cloud requires an open customer-service window for normal outbound messages;
  outside that window an allowlisted template name is mandatory.
- WhatsApp Cloud and Zalo Mini App reject group recipients where the provider policy
  disallows them. Secret delivery is allowed only on direct/private authorized-reveal
  paths and is rejected for groups or generic messaging adapters.
- Discord and Telegram messages remain provider-neutral projections; no connector
  request, message enqueue or return URL proves delivery or payment.

### Domains

| Method/path | Contract |
| --- | --- |
| `GET/POST .../domains` | Owner; POST recent auth `{hostname}`; 201 new/200 existing |
| `POST .../domains/:domainOrClaimId/checks` | CSRF + recent; `{}`; ID co the `dcl_` hoac `dom_` |
| `PUT .../domains/:domId/primary` | CSRF + recent; `{}` |
| `DELETE .../domains/:domId` | CSRF + recent; bat buoc JSON `{}`; 204 |

`DomainView` co lifecycle statuses, DNS instructions, safe error, validation/version; khong co Cloudflare hostname ID. Hostname khong update; delete/create lai.

## Onboarding, readiness va automation API

### Onboarding/readiness

Owner-only service boundary; mutations CSRF + recent auth.

| Method/path | Contract |
| --- | --- |
| `GET .../onboarding` | Profile, settings, fixed steps |
| `PUT .../onboarding/channels` | Website/Telegram booleans + custom domain preference; it nhat mot channel |
| `PUT .../onboarding/settings` | Attestation v1, HTTPS policy URLs, support contact |
| `POST .../onboarding/test-order` | Dry-run only, khong tao order/payment/reservation |
| `GET .../readiness` | Authoritative checks/result |
| `POST .../readiness/checks` | `{}` -> refreshed authoritative result |

Readiness check co `code,messageKey,status(pass|warning|fail),required,checkedAt,actionUrl?`. UI khong tinh readiness lai. Fixed steps: `account_ready,shop_created,channel_selected,catalog_ready,inventory_ready,telegram_ready,payos_ready,domain_ready,readiness_passed,published`.

### Automation

Public task projection chi co safe fields: `id,capabilityCode,status,attemptCount,nextAttemptAt,lastSafeErrorCode,actionUrl,canCancel,continuation,version,createdAt,updatedAt`.

| Method/path | Contract |
| --- | --- |
| `GET .../automation` | `shop:read`; optional capability/status/limit <=100 |
| `POST .../automation` | CSRF + recent + idempotency; API start chi `shop.provision`, `domain.platform.provision` |
| `GET .../automation/:taskId` | Shop read |
| `POST .../:taskId/cancel` | CSRF + recent + expectedVersion + reason + idempotency |
| `POST .../:taskId/resume` | CSRF + recent + expectedVersion + idempotency; client khong gui evidence token |

## API credentials, audit, export, deletion va seller moderation

### API credentials

- `GET .../api-credentials`: session + recent auth + owner/team manage.
- `POST .../api-credentials`: CSRF + recent + idempotency; `{name,scopes:[catalog:read|shop:read],expiresAt?}`.
- Token chi hien mot lan khi tao moi. Replay/list khong the khoi phuc token.
- `DELETE .../api-credentials/:credentialPublicId`: CSRF + recent + `{expectedVersion,reasonCode}` + idempotency.

### Audit va exports

- `GET .../audit?limit=`: owner, max 200, safe projection only.
- `GET .../exports`: owner, latest 50.
- `POST .../exports`: owner + CSRF + recent; standard hoac acknowledged plaintext inventory export; tra one-time download token.
- `POST .../exports/:exportId/download`: CSRF + recent, body `{token}` -> attachment.

Download token TTL 10 phut. Plaintext inventory export retention 1 gio; standard 7 ngay. Plaintext export can explicit risk acknowledgement va khong preview trong browser UI.

### Deletion

- `GET .../deletion`: owner -> current request/null.
- `POST .../deletion`: owner + CSRF + recent; confirmation exact `DELETE SHOP`; `202`.
- `POST .../deletion/cancel`: owner + CSRF + recent + idempotency + expected version.
- `POST .../deletion/resume`: owner + CSRF + recent; `{}`; 200 complete hoac 202 continuing.

Projection co safe lifecycle timestamps/error/version/steps; khong co provider secret. Legal hold va irreversible fences do server quyet dinh.

### Seller abuse/moderation

- `GET .../abuse-reports?cursor&status`: owner, keyset cursor.
- `POST .../moderation/actions`: owner + CSRF + recent + idempotency; chi product suspend/restore.
- Seller chi restore suspension do seller-originated action tao; platform suspension fail closed.

## External API v1

| Method/path | Credential/scope | Projection |
| --- | --- | --- |
| `GET /api/v1/shop` | Bearer `sln_<env>_...`, `shop:read` | Safe shop data |
| `GET /api/v1/catalog` | Bearer, `catalog:read` | Safe shop + catalog, stockState only |

60 request/phut/credential; rate limit headers va `Retry-After`. Query `shopPublicId` khong thay doi credential tenant. Day la server/external integration surface, khong phai browser dashboard API.

## Admin API

| Method/path | Role/protection | Contract |
| --- | --- | --- |
| `GET /api/admin/shops` | Active admin | Safe cursor directory; no identity/secrets |
| `GET /api/admin/abuse-reports` | Active admin | Cursor/status report projection |
| `POST /api/admin/abuse-reports/:id` | CSRF + recent + idempotency | Support chi received->triaged; owner/risk broader transitions |
| `POST /api/admin/moderation/actions` | Owner/risk + CSRF + recent + idempotency | Shop/product suspend/restore |
| `POST /api/admin/shops/:shop/suspend` | Owner/risk legacy | Legacy wrapper; frontend moi khong uu tien |
| `GET /api/admin/operations` | Active admin | Safe incidents, DLQ, deletion overview |
| `POST .../incidents/:id` | Active admin + CSRF + recent + expectedVersion | Acknowledge/resolve |
| `POST .../dead-letters/:id` | Active admin + CSRF + recent + expectedVersion | Acknowledge/retry/resolve/replay; replay idempotent |
| `POST .../deletions/:id/legal-hold` | Owner/risk + CSRF + recent + idempotency + expectedVersion | Set/release hold |
| `GET .../rotations` | Active admin | Runs + `canOperate` |
| `POST .../rotations` | Platform owner + CSRF + recent + idempotency | Create dry/live scoped rotation; explicit confirmations |
| `POST .../rotations/:runId/process` | Platform owner + CSRF + recent + idempotency | Process bounded 1..100 |

Incident/DLQ chi expose allowlisted safe context/envelope. Admin directory khong query email/member identity, credential, inventory key, buyer token, payment/provider payload hoac internal shop ID.

## Seller operations backend (migrations 0053-0054)

All routes below resolve `shop_id` through authenticated membership. D1 is
authoritative; mutation audit and idempotency receipts are written with the
guarded state transition. Public references never expose raw credentials,
tokens or platform-user identifiers.

| Method/path | Capability/protection | Contract |
| --- | --- | --- |
| `GET /api/app/shops/:shop/members/invitations` | `team:manage`; session | Masked invitation list, bounded to one shop. |
| `POST /api/app/shops/:shop/members/invitations` | `team:manage`; CSRF + recent-auth + idempotency | Normalized email, non-owner role allowlist, hashed seven-day token, safe delivery and audit. Provider failure leaves a durable pending invitation. |
| `POST /api/app/shops/:shop/members/invitations/:invitation` | `team:manage`; CSRF + recent-auth + idempotency + expected version | Rotates the hashed token and sends a fresh link for pending/expired invitations after an explicit retry. `DELETE` on the same resource revokes it. |
| `DELETE /api/app/shops/:shop/members/invitations/:invitation` | `team:manage`; CSRF + recent-auth + idempotency + expected version | Pending-only revoke; stale versions fail with 409. |
| `PATCH /api/app/shops/:shop/members/:member` | `team:manage`; CSRF + recent-auth + idempotency + expected version | Manager/support/viewer role change; owner/self membership is protected. |
| `DELETE /api/app/shops/:shop/members/:member` | `team:manage`; CSRF + recent-auth + idempotency + expected version | Suspend active non-owner membership; no hard delete. |
| `POST /api/auth/member-invitations/accept` | Authenticated active user; token + email match | One-time conditional acceptance; expired, replayed and cross-email tokens fail closed. |
| `GET /api/app/shops/:shop/customers/:customer` | `shop:read`; session | Masked detail, bounded order history/count and internal notes. |
| `PATCH /api/app/shops/:shop/customers/:customer` | `customers:manage`; CSRF + recent-auth + idempotency + expected version | Safe display-name/locale/status update with allowlisted audit metadata. |
| `POST /api/app/shops/:shop/customers/:customer/notes` | `customers:manage`; CSRF + recent-auth + idempotency | Append-only internal note, body bounded to 4,000 characters. |
| `DELETE /api/app/shops/:shop/customers/:customer/notes/:note` | `customers:manage`; CSRF + recent-auth + idempotency + expected version | Redaction only; delete is blocked by an immutable-note trigger. |
| `GET /api/app/shops/:shop/orders/:order/notes` | `fulfillment:manage`; session | Tenant-bound internal order-note list. |
| `POST /api/app/shops/:shop/orders/:order/notes` | `fulfillment:manage`; CSRF + recent-auth + idempotency | Append-only internal order note with audit. |
| `DELETE /api/app/shops/:shop/orders/:order/notes/:note` | `fulfillment:manage`; CSRF + recent-auth + idempotency + expected version | Immutable redaction only; cross-tenant order references return not-found. |
| `GET /api/app/shops/:shop/orders/:order/messages` | `shop:read`; session | Tenant-bound seller-to-buyer message projection; redacted bodies are empty. |
| `POST /api/app/shops/:shop/orders/:order/messages` | `fulfillment:manage`; CSRF + recent-auth + idempotency | Creates an audited `provider_pending` message. It never claims external delivery. |
| `DELETE /api/app/shops/:shop/orders/:order/messages/:message` | `fulfillment:manage`; CSRF + recent-auth + idempotency + expected version | Redacts unsent/failed messages only; immutable transition guard prevents deletion. |
| `GET /api/app/shops/:shop/payments/remediation` | `payments:manage`; session | Lists bounded seller remediation requests without provider payloads. |
| `POST /api/app/shops/:shop/payments/remediation` | `payments:manage`; CSRF + recent-auth + idempotency | Records refund/partial/manual-review intent for an open exception; order payment state is unchanged. |
| `GET /api/app/shops/:shop/billing/plans` | `billing:manage`; session | Lists active plan metadata, feature flags and limits only. |
| `GET /api/app/shops/:shop/billing/requests` | `billing:manage`; session | Lists optimistic subscription change requests. |
| `POST /api/app/shops/:shop/billing/requests` | `billing:manage`; CSRF + recent-auth + idempotency + expected version | Records plan-change/cancel intent; provider/operator evidence is required before mutation. |
| `GET /api/admin/investigations/orders` | Active platform admin | Bounded cursor/search/status/shop filters; masked customer email and allowlisted payment evidence. |
| `GET /api/admin/investigations/audit` | Active platform admin | Bounded cursor/filter explorer; scalar safe metadata with sensitive key names removed. |
| `GET /api/admin/appeals` | Active platform admin | Bounded refund/manual-review queue with public shop/order references only. |
| `PATCH /api/admin/appeals/:request` | Owner/risk + CSRF + recent-auth + idempotency + expected version | Approve into `provider_pending` or reject; no refund is marked complete. |

Provider-backed billing settlement, refund completion, seller message delivery
and external adapter activation remain outside this local workflow contract.

## API da co nhung UI hien tai chua fetch truc tiep

- Auth session projection.
- Public store catalog API.
- External API v1.
- Seller order list/detail va manual fulfillment.
- Seller member invitation/mutation, customer detail/notes, order messages,
  billing/remediation requests and admin
  investigation endpoints listed above.
- Channel expansion catalog and connector request APIs (migrations `0055`-`0056`); catalog/
  request wiring is safe to expose, but provider execution remains pending.
- Payment exceptions.
- Seller audit.
- GET export/deletion/abuse/admin operations/directory thuong duoc page SSR goi service truc tiep.
- Legacy admin suspend wrapper.

Frontend moi co the dung endpoint da co, nhung phai pin theo commit/source type va test, khong suy schema tu HTML.

## Tinh nang khong co API

Khong duoc dung UI gia cho:

- seller shop-list GET;
- customer merge/delete;
- billing payment-method/pricing/proration and provider completion;
- discount management;
- analytics/reporting;
- provider refund completion and seller order/payment overrides;
- catalog hard delete;
- cart GET;
- Zalo/Meta/WhatsApp/marketplace provider execution, webhook delivery and second payment provider;
- Discord/Telegram Mini App provider activation and outbound delivery;
- generic provider setup UI cho generated-license neu chua co service/route duoc expose.

## Contract traps checklist

- Checkout intent/recover idempotency trong body; final checkout/cart mutation/download grant o header.
- `/storefront/draft` alias `/settings`; catalog publish va storefront publish khac response.
- Seller `optionsJson` string; public `options` object.
- Seller order email masked; order token khong co trong seller projection.
- 409 optimistic conflict -> reload; khong blind retry payload moi voi key cu.
- Domain check chap nhan claim `dcl_`; primary/delete chi `dom_`.
- Once-only token khong the khoi phuc bang list.
- Payment/Telegram/domain response chi safe status/error, khong provider payload.
- Return URL/QR khong phai payment evidence.
- GET/HEAD khong duoc tao cart/order/payment/webhook/fulfillment side effect.
