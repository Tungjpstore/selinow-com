# Configuration Reference

## Current continuation overlay (2026-08-03)

Telegram Mini App, Zalo Mini App/OA, WhatsApp Cloud and Discord Bot credentials are tenant-owned encrypted envelopes in D1, not Worker vars and never browser-readable after submission. Provider endpoints, webhook secrets, access tokens and public keys are resolved only inside the provider boundary. A provider contract or connector request is not a production configuration; activation requires the reviewed evidence and remote environment gates documented in `docs/IMPLEMENTATION_STATUS.md`.

## 1. Configuration principles

- Public constants/non-secret values nằm trong `vars` hoặc typed config.
- Global secrets nằm trong Worker secrets.
- Tenant credentials nằm encrypted trong D1.
- Resource IDs/bindings được provision script quản lý theo environment.
- `.dev.vars.example` chỉ chứa placeholder, không chứa value thật.
- Production config không được phụ thuộc file local không commit.

## 2. Cloudflare bindings

Tên có thể điều chỉnh một lần trước implementation, sau đó giữ ổn định:

| Binding | Type | Purpose |
| --- | --- | --- |
| `PLATFORM_DB` | D1 | Tenant, catalog, orders, integrations, subscription |
| `MEDIA` | R2 | Public seller/product media |
| `PRIVATE_EXPORTS` | R2 | Private encrypted seller export objects; never public/custom-domain routed |
| `PLATFORM_CACHE` | KV | Hostname/config/public projection cache |
| `INTEGRATION_QUEUE` | Queue producer | Telegram/PayOS/domain/provider jobs |
| `NOTIFICATION_QUEUE` | Queue producer | Telegram/email notification jobs |
| `INTEGRATION_DLQ` | Queue | Dead-letter jobs |
| `EMAIL` | Cloudflare Email Service `send_email` | Magic-link delivery from the onboarded `selinow.com` sender domain |
| `ASSETS` | Static Assets | Astro client/static build |

Queue consumer có thể dùng cùng Worker deployment nếu cấu hình hỗ trợ.

`send_email` is configured independently in every named Wrangler environment (it is not inherited). Staging and production restrict `EMAIL` to `no-reply@selinow.com` with `remote: true`.

## 3. Non-secret vars

| Variable | Example | Notes |
| --- | --- | --- |
| `APP_ENV` | `production` | `local|staging|production` |
| `PLATFORM_NAME` | `Selinow` | Display only |
| `PLATFORM_BASE_DOMAIN` | `selinow.com` | Hostname, no scheme |
| `PLATFORM_ORIGIN` | `https://selinow.com` | Marketing origin |
| `DASHBOARD_ORIGIN` | `https://app.selinow.com` | Seller app |
| `API_ORIGIN` | `https://api.selinow.com` | Webhooks/API |
| `MEDIA_PUBLIC_BASE_URL` | `https://media.selinow.com` | R2/media origin |
| `CLOUDFLARE_ZONE_ID` | 32-character zone identifier | Non-secret zone selector |
| `SAAS_CNAME_TARGET` | `customers.selinow.com` | Customer DNS target |
| `DEFAULT_LOCALE` | `vi-VN` | Primary locale (`vi` remains a legacy alias) |
| `DEFAULT_CURRENCY` | `VND` | MVP currency |
| `DEFAULT_TIMEZONE` | `Asia/Ho_Chi_Minh` | Seller override later |
| `CREDENTIAL_KEY_VERSION` | `v1` | Active encryption key version |
| `INVENTORY_KEY_VERSION` | `v1` | Active inventory key version |
| `ACTIVE_CREDENTIAL_KEY_VERSION` | `v1` | Active version for new provider credential writes, including generated-license providers |
| `ACTIVE_INVENTORY_KEY_VERSION` | `v1` | Active version for new inventory-key and generated-license artifact writes |
| `EXPORT_KEY_VERSION` | `v1` | Active version for encrypted export objects |
| `SESSION_COOKIE_NAME` | `selinow_session` | Host-only dashboard cookie |
| `MAGIC_LINK_GLOBAL_RATE_LIMIT` | `200` | Accepted anonymous magic-link requests per fixed window |
| `MAGIC_LINK_REQUESTER_RATE_LIMIT` | `20` | Accepted magic-link requests per trusted client-address bucket |
| `MAGIC_LINK_RATE_LIMIT_WINDOW_SECONDS` | `900` | Fixed magic-link admission window |
| `TELEGRAM_WEBHOOK_MAX_CONNECTIONS` | `20` | Telegram allows 1-100; keep explicit and bounded per environment |
| `TURNSTILE_SITE_KEY` | public key | Non-secret |
| `EMAIL_FROM_ADDRESS` | `no-reply@selinow.com` | Platform sender |
| `EMAIL_FROM_NAME` | `Selinow` | Platform sender name |
| `LOG_LEVEL` | `info` | No secret debug dumping |

## 4. Global Worker secrets

| Secret | Purpose |
| --- | --- |
| `SESSION_SECRET` | Session/token cryptography |
| `MAGIC_LINK_SECRET` | Magic-link token HMAC if separate |
| `CREDENTIAL_KEK_V1` | 32-byte root for tenant credentials, including generated-license providers under distinct AAD |
| `CREDENTIAL_KEK_V2` | Optional next credential root retained only while rows reference `v2` |
| `INVENTORY_KEK_V1` | 32-byte root for inventory keys and generated-license artifacts under distinct AAD |
| `INVENTORY_KEK_V2` | Optional next inventory root retained only while rows reference `v2` |
| `EXPORT_KEK_V1` | Dedicated 32-byte root for private export objects |
| `IDENTIFIER_HMAC_SECRET` | IP/subject/fingerprint pseudonymization |
| `TURNSTILE_SECRET_KEY` | Server verification |
| `CLOUDFLARE_API_TOKEN` | Custom hostname provisioning, least privilege |
| `CLOUDFLARE_ACCOUNT_ID` | Treat as sensitive config if desired |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Only if OAuth enabled |
| `DODO_PAYMENTS_API_KEY` | Platform subscription checkout/API access |
| `DODO_PAYMENTS_WEBHOOK_KEY` | Platform subscription webhook signature verification (`DODO_PAYMENTS_WEBHOOK_SECRET` is accepted as a compatibility alias) |
| `DODO_PAYMENTS_ENVIRONMENT` | `test_mode` or `live_mode`; defaults to `test_mode` outside production and `live_mode` in production |
| `DODO_PAYMENTS_API_BASE_URL` | Optional HTTPS API override; use the Dodo test/live endpoint |

Tạo root secret bằng cryptographically secure random 32 bytes và encode base64url. Không dùng password/passphrase thủ công.

`CLOUDFLARE_API_TOKEN` chỉ cần quyền custom-hostname tối thiểu trên đúng zone và được lưu bằng Worker secret. One-time platform setup dùng token operator riêng `CLOUDFLARE_PLATFORM_API_TOKEN` với quyền DNS/fallback cần thiết. Staging doctor/deploy dùng thêm `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN`, chỉ có quyền đọc Worker Routes trên zone, để chứng minh hai null-script guard và catch-all Worker ngay trước deploy. Hai operator token này chỉ tồn tại tạm trong operator shell hoặc secret manager, không đưa vào Worker, Wrangler vars hay manifest.

Dodo product/price IDs không phải Worker secrets. Migration `0076` seeds four
  fail-closed `pending:dodo:*` references for Starter/Pro in VN/global; after
  Dodo merchant verification, replace those references in the target D1 price
  rows with the provisioned recurring price IDs and revalidate amount, currency,
  interval and tax behavior before enabling checkout. Return URLs alone never
  activate a subscription.

## 5. Tenant credential names

Trong `shop_credentials`:

### Telegram

- provider `telegram`, name `bot_token`
- provider `telegram`, name `webhook_secret`

### PayOS

- provider `payos`, name `client_id`
- provider `payos`, name `api_key`
- provider `payos`, name `checksum_key`

Mọi credential record có `shop_id`, `key_version`, encrypted bytes và lifecycle status.

## 6. Local example

`.dev.vars.example`:

```dotenv
APP_ENV=local
PLATFORM_BASE_DOMAIN=localhost
PLATFORM_ORIGIN=http://localhost:4321
DASHBOARD_ORIGIN=http://app.localhost:4321
API_ORIGIN=http://api.localhost:4321
CLOUDFLARE_ZONE_ID=00000000000000000000000000000000
SAAS_CNAME_TARGET=customers.localhost
DEFAULT_LOCALE=vi-VN
DEFAULT_CURRENCY=VND
DEFAULT_TIMEZONE=Asia/Ho_Chi_Minh
CREDENTIAL_KEY_VERSION=v1
INVENTORY_KEY_VERSION=v1
ACTIVE_CREDENTIAL_KEY_VERSION=v1
ACTIVE_INVENTORY_KEY_VERSION=v1
EXPORT_KEY_VERSION=v1
TURNSTILE_SITE_KEY=replace-me
EMAIL_FROM_ADDRESS=no-reply@selinow.com
EMAIL_FROM_NAME=Selinow

# Secrets below are placeholders only. Put real local values in .dev.vars,
# never commit .dev.vars.
SESSION_SECRET=replace-with-local-random-secret
CREDENTIAL_KEK_V1=replace-with-32-byte-base64url
INVENTORY_KEK_V1=replace-with-32-byte-base64url
EXPORT_KEK_V1=replace-with-dedicated-32-byte-base64url
IDENTIFIER_HMAC_SECRET=replace-with-local-random-secret
TURNSTILE_SECRET_KEY=replace-me
```

Local provider integration mặc định dùng fake/stub adapter. Chỉ bật real Telegram/PayOS local test bằng explicit opt-in và dedicated test credentials.
Local magic-link requests intentionally return a debug link and do not use the remote `EMAIL` binding.

## 7. Route inventory

Tên route có thể phù hợp Astro conventions nhưng contract phải rõ.

### Marketing/auth

- `GET /`
- `GET /pricing`
- `GET|POST /login`
- `POST /api/auth/magic-link/request`
- `GET /api/auth/magic-link/consume`
- `POST /api/auth/logout`

### Seller app API

- `POST /api/app/shops`
- `GET /api/app/shops/:shopPublicId/readiness`
- Product/category/variant CRUD.
- Inventory preview/import/revoke/export.
- Orders/payment exceptions.
- Telegram connect/test/rotate/disconnect.
- PayOS connect/test/rotate/disconnect.
- Domain create/status/primary/delete.
- Export list/create/one-time download.
- Deletion request/status/resume/cancel.
- Shop abuse-report review and seller-scoped moderation.
- Team/settings/subscription/audit.

### Buyer API

- `GET /api/store/catalog`
- `GET /api/store/products/:slug`
- `POST /api/store/quote`
- `POST /api/store/checkout`
- `GET /api/store/orders/:publicId`
- `POST /api/store/orders/:publicId/reveal`

Buyer tenant lấy từ hostname. Order status/reveal yêu cầu order access token hoặc verified identity.

### Provider webhook

- `POST /webhooks/telegram/:webhookPublicId`
- `POST /webhooks/payos/:webhookPublicId`
- Platform billing Dodo webhook phải route/credential namespace riêng với seller
  PayOS webhook và không được dùng credential của seller.

### Platform operations

- `GET|POST /api/admin/operations/rotations`
- `POST /api/admin/operations/rotations/:runId/process`
- `POST /api/admin/operations/deletions/:deletionRequestId/legal-hold`
- `GET /api/admin/operations`
- `POST /api/admin/operations/dead-letters/:deadLetterId`
- `POST /api/admin/operations/incidents/:incidentId`
- `GET /api/admin/abuse-reports`
- `POST /api/admin/abuse-reports/:reportPublicId`
- `POST /api/admin/moderation/actions`

Encryption rotation is operated through the authenticated platform Operations UI/API. Creating or processing a run requires an active platform owner, recent authentication, CSRF validation and an idempotency key. Global and live runs also require explicit confirmation phrases; each process request is capped at 100 records.

## 8. API headers

- `Content-Type: application/json` cho JSON mutation.
- `Idempotency-Key` cho checkout/provisioning mutation public quan trọng.
- `X-CSRF-Token` cho cookie-auth dashboard mutation.
- `X-Request-Id` có thể accept safe upstream value hoặc server generate.
- `X-Telegram-Bot-Api-Secret-Token` từ Telegram.
- PayOS signature nằm trong payload/header theo contract hiện hành; adapter xác minh đúng tài liệu.
- `X-Order-Access-Token` hoặc Authorization bearer opaque cho order access, không đặt token dài hạn trong query nếu tránh được.

## 9. Response headers

Sensitive responses:

```text
Cache-Control: private, no-store, max-age=0
Pragma: no-cache
X-Content-Type-Options: nosniff
X-Robots-Tag: noindex, nofollow
```

Public catalog có cache policy ngắn và tenant-aware. Security headers phải áp dụng cả Static Assets và Worker routes.

## 10. Standard error codes

Ví dụ ổn định:

```text
authentication_required
authorization_denied
csrf_invalid
tenant_not_found
tenant_suspended
subscription_required
plan_limit_reached
validation_failed
rate_limited
idempotency_conflict
inventory_unavailable
order_not_found
order_access_required
payment_not_configured
payment_pending
payment_exception
telegram_not_configured
telegram_webhook_invalid
payos_signature_invalid
domain_not_ready
provider_unavailable
```

Không trả `error.message` thô từ crypto/provider/database.

## 11. Required scripts

```text
dev
check
lint
test
test:unit
test:integration
test:smoke
build
platform:doctor
platform:provision
db:migrate
db:preflight
db:migrate:status
db:seed
backup:create
restore:drill
release:doctor
release:manifest
release:production:plan
release:production:dry-run
release:pilot:smoke
deploy:dry-run
deploy:staging:dry-run
deploy:staging
deploy
```

Không có `crypto:rotate:*` CLI trong repository. Rotation dry-run/live/resume dùng HTTP operator surface ở trên để giữ application auth, CSRF, recent-auth, idempotency, tenant resolution và audit trong cùng trust boundary.

Deploy luôn yêu cầu explicit environment flag. `npm run deploy` không target sẽ fail với `deploy_environment_required`; non-dry-run `--env local` fail với `remote_deploy_target_required` vì Wrangler base config vẫn là một remote Worker target. Staging deploy dùng script explicit `deploy:staging`; production mutation còn yêu cầu `--confirm-production`. Không mặc định bất kỳ remote target nào.

## 12. Wrangler configuration rules

- Base config không chứa secret.
- Resource IDs/name theo environment được provision/generate có kiểm soát.
- `compatibility_date` được pin và review khi nâng.
- `nodejs_compat` chỉ bật nếu dependency cần.
- Cron interval chọn theo workload; không để một cron full-scan mỗi phút.
- Queue consumer limits/concurrency đặt có chủ đích.
- Observability sampling không log body/secret.
- `keep_vars` và generated config behavior phải được hiểu rõ trước deploy.
- `send_email` must be declared per named environment and its `allowed_sender_addresses` must match `EMAIL_FROM_ADDRESS`.
- Production routes/domain không tồn tại trong local config.

## 13. Configuration doctor checks

`platform:doctor`/runtime readiness phải phát hiện:

- Missing/malformed origins/domain.
- Secret key wrong byte length/version.
- D1/R2/KV/Queue binding missing.
- Cloudflare API scope thiếu.
- Turnstile site/secret mismatch.
- Custom hostname fallback/CNAME target chưa active.
- Cloudflare Email Sending domain onboarding, DNS authentication records and the `EMAIL` binding are not ready.
- Migration pending.
- Duplicate/reserved host configuration.

Doctor không decrypt/print tenant credentials hàng loạt. Tenant integration health là job/API riêng.
