# Kien truc he thong danh cho frontend rebuild

## Runtime

Selinow la Astro 7 SSR modular monolith chay tren Cloudflare Workers. Mot deployable Worker phuc vu marketing, seller workspace, tenant storefront, protected admin, API, provider webhooks, queue consumer va scheduled jobs. TypeScript strict; Cloudflare adapter; Node `>=22.12 <26`; npm `>=11`.

```text
Browser / Telegram / PayOS / Operator
                  |
                  v
Cloudflare DNS + TLS + WAF + Turnstile
                  |
                  v
Astro Worker modular monolith
  request context -> auth/tenant/role -> application service -> D1 transaction
        |                    |                   |
        |                    |                   +-> reference-only queue event
        |                    +-> provider adapter / R2 controlled byte access
        +-> SSR HTML / JSON safe projection
                  |
   +--------------+----------------+----------------+----------------+
   |                               |                |                |
   v                               v                v                v
  D1 authoritative                R2 bytes         KV cache/session Queues
```

## Bon surface tach biet

| Surface | Host/path | Context authority | Cache/SEO |
| --- | --- | --- | --- |
| Marketing | `selinow.com`, `/`, `/pricing`, `/login` | Platform host classification | Public SEO; login private/noindex |
| Seller workspace | `app.selinow.com`, `/app/**`, `/onboarding` | Auth session + active shop membership + selected public shop ID | Private/no-store/noindex |
| Tenant storefront | `{slug}.selinow.com` hoac active custom hostname | Active canonical hostname -> shop | Home/product public cache; cart/checkout/order private |
| Platform admin | `/admin/**` tren dashboard surface | Auth session + active `platform_admins` role | Private/no-store/noindex |

`api.selinow.com` la API/provider ingress. Path khong duoc dung de bo qua host/context rule. Client-provided `shop_id`, role, status hoac channel khong bao gio la authorization authority.

## Data authority

| Domain | Authority | Frontend duoc lam gi |
| --- | --- | --- |
| Tenant, membership, plan, subscription | D1 | Render projection va capability server tra ve |
| Catalog, price, variant version | D1 | Hien draft/live state; revalidate truoc cart/checkout |
| Inventory | D1 + ciphertext trong D1 | Chi render counts/safe timestamps; khong giu plaintext |
| Cart/quote/order | D1 | Gui opaque token va expected snapshot; khong tu tinh final total |
| Payment | Signed provider event/reconciliation + D1 | Render state; return/QR chi la navigation |
| Fulfillment/entitlement | D1 | Reveal qua protected grant/order-token route; khong cache secret |
| Domain lifecycle | D1 + Cloudflare evidence | Render tung buoc ownership/DNS/SSL/routing rieng |
| Provider credentials | AES-GCM ciphertext trong D1 | Chi form nhap mot lan; khong render lai credential |
| Media/private export | R2 bytes, D1 metadata authority | Worker cap grant ngan han; khong public object URL |
| Cache | Reconstructable KV/Cloudflare cache | Khong dung de quyet dinh stock/payment/subscription |
| Queue | Reference-only delivery work | UI chi doc projection D1; khong tin queue la final state |

## Module boundary

- `auth`: magic link, session, CSRF, recent-auth.
- `tenants`: shop, membership, role/capability, plan, subscription, readiness.
- `catalog`: category, product, variant, price, publication.
- `inventory`: encrypted import, reservation, allocation, sold/revoked lifecycle.
- `commerce`: cart, quote, checkout, order access, canonical cross-channel commands.
- `payments`: attempt, signed event, decision, reconciliation, exception.
- `fulfillment`/`entitlement`: pooled keys, private file, manual attestation, generic entitlement, generated license.
- `channels`: provider-neutral connection/capability registry, channel-expansion manifests and tenant-bound connector-request workflow; Website va Telegram dung chung commerce service, while Telegram Mini App, Zalo Mini App, WhatsApp Cloud and Discord bot remain contract/provider-boundary slices.
- `domains`: platform subdomain, custom hostname, ownership, DNS, SSL, primary/canonical routing.
- `onboarding`/`automation`: resumable setup va durable task orchestration.
- `operations`: audit, abuse/moderation, incident, DLQ, export, deletion, rotation, backup/restore.
- `crypto`: versioned encryption, AAD, HMAC identity, redaction.

Frontend khong duoc import provider-specific decision logic vao component. Component goi page/API contract; service backend map provider state sang projection an toan.

## Request flow chuan

### Seller read

```text
GET page -> authenticate session -> list active memberships
-> select only a membership-owned shop public ID
-> service getShopForMember(capability)
-> tenant-leading D1 query -> safe SSR projection
```

Khi switch shop, phai xoa entity/filter cua tenant cu. Order detail quay ve `/app/orders`; query `shop={publicId}` duoc them lai.

### Seller/admin mutation

```text
UI confirmation/form
-> same-origin request
-> session + Origin + CSRF cookie/header
-> recent-auth neu sensitive
-> role/capability + tenant lookup
-> allowlisted body + idempotency/version guard
-> D1 transaction + audit
-> safe JSON result/requestId
```

### Storefront checkout

```text
hostname -> active shop -> public catalog snapshot
-> opaque cart + server quote
-> revalidate price/version/stock/discount
-> atomic reservation/order snapshot
-> free completion OR PayOS attempt
-> signed exact payment event/reconcile
-> independent fulfillment/entitlement transition
```

Partial, overpaid, late, mismatched hoac ambiguous payment khong auto-fulfill.

### Provider webhook

```text
opaque webhook ID -> credential/connection lookup
-> verify secret/signature before business parse
-> bounded body + dedupe
-> normalized command/evidence
-> D1 mutation + reference-only async delivery
```

## Rendering strategy

- SSR/HTML-first cho page shell va public content; khong suy ra static generation.
- Public catalog home/product phai co semantic HTML va link hoat dong khong JavaScript.
- Hydration chi cho mutation, filter nang cao, live refresh va progressive interaction.
- Dashboard/admin SSR phai fail closed voi explicit 401 redirect, 403 forbidden, 503 unavailable; khong render data cua tenant/role gan nhat.
- Storefront cache key gom hostname, domain incarnation, publication version va locale. Cart/checkout/order/API store khong cache public.
- Locale: `en`, `vi-VN`; legacy `vi` canonicalize. Merchant-authored catalog hien la single-language.

## Production boundary hien tai

- Production Worker/version va D1 migrations `0001`-`0052` dang live cho platform surface. Migrations `0053`-`0056` are source/local-only in the current continuation and are not applied remotely.
- `selinow.com`, `app.selinow.com`, `api.selinow.com` dang route production.
- Queue/cron/provider activation khong duoc suy ra tu viec code/schema da deploy.
- Controlled PayOS, Telegram, provider-backed generated fulfillment va external customer-domain activation van can acceptance/activation rieng.
- Frontend moi phai hien thi trang thai unavailable/pending trung thuc thay vi gia lap provider success.

### Channel expansion boundary

- `GET .../channels/catalog` exposes only safe manifests and declared/safe capability metadata. `POST .../channels/requests` records seller intent in D1 through migrations `0055`-`0056`; `GET` lists and `DELETE` self-cancels requests with idempotency and optimistic-version guards.
- Telegram Mini App launch identity must pass server-side `initData` HMAC verification, freshness and tamper checks before tenant/customer binding. The bot credential is read only at the credential boundary and is never returned or persisted by the verifier.
- WhatsApp Cloud messaging enforces the customer-service window and approved template requirement; Zalo Mini App and WhatsApp group scope are fail-closed where policy disallows it. Secrets use authorized private reveal only and never generic outbound messages, groups or inline connector payloads.
- Connector statuses (`requested`, `provider_pending`, `active`, `rejected`, `canceled`) are durable workflow state, not proof of provider account activation, webhook verification, message delivery or payment/fulfillment completion.
