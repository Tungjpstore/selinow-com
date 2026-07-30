# Architecture and Data Contract

## 1. Kiến trúc được chọn

Dùng modular monolith chạy trên Cloudflare Workers:

```text
Buyer / Seller / Provider
          |
          v
Cloudflare DNS + TLS + WAF + Turnstile
          |
          v
Astro Worker
  - marketing
  - seller dashboard/API
  - multi-tenant storefront
  - Telegram webhook
  - PayOS webhook
  - queue consumers / cron
          |
          +--> D1: transactional state
          +--> R2: public media and controlled exports
          +--> KV: hostname/config cache, non-authoritative
          +--> Queues: provider work and delivery retries
          +--> Telegram Bot API
          +--> PayOS Merchant API
          +--> Cloudflare API for SaaS custom hostnames
```

Không dùng KV làm source of truth cho order, payment, inventory hoặc subscription. KV chỉ cache dữ liệu có thể tái tạo từ D1.

Chuỗi migration nguồn hiện kéo dài đến `0048_payment_reversal_entitlement_revocation.sql`. Staging vẫn chỉ áp dụng 28 migration đến `0028`; `0029`-`0048` (20 migration) là source/local-only và chưa được coi là đã áp dụng từ xa. Production chưa được chạm tới và vẫn `NO-GO`.

## 2. Host routing

Request context phải được xác định trước khi chạy business logic:

| Host/path | Context |
| --- | --- |
| `selinow.com` | Marketing/platform public |
| `www.selinow.com` | Redirect về apex |
| `app.selinow.com` | Seller dashboard |
| `api.selinow.com` | Webhooks và API integration |
| `{slug}.selinow.com` | Tenant storefront |
| Custom hostname active | Tenant storefront |

Tenant resolver trả về object tối thiểu:

```ts
type TenantContext = {
  shopId: string;
  shopPublicId: string;
  slug: string;
  status: "draft" | "active" | "suspended" | "archived";
  subscriptionState: string;
  canonicalOrigin: string;
  requestHostname: string;
};
```

Không lấy `shop_id` từ body/query của buyer API nếu tenant đã được xác định từ hostname. Dashboard API lấy shop từ membership/session và kiểm tra authorization ở server.

## 3. Module boundaries

### `auth`

- Seller login, magic link/OAuth, session rotation, CSRF và membership authorization.
- Platform admin được bảo vệ riêng, ưu tiên Cloudflare Access cộng application-level authorization.

### `api`

- Owner-managed server-to-server credentials, public Bearer authentication, fixed scopes, D1-backed rate limits and versioned `/api/v1` contracts.
- A public request derives its tenant only from the authenticated credential; a client path, body, query or header cannot select or override `shop_id`.

### `tenants`

- Shop lifecycle, slug, readiness, plan limits và tenant resolution.

### `catalog`

- Categories, products, variants, pricing, publishing và public projections.

### `inventory`

- Import batches, encrypted key material, reservation, allocation, release và revoke.

### `orders`

- Cart normalization, quote, checkout, order state và channel ownership.

### `payments`

- Provider-neutral payment attempts/evidence/decisions plus PayOS payment link, webhook, reconciliation và exceptions. Generic provider connection projections remain separate from channel connections; legacy PayOS tables stay authoritative until a reviewed runtime cutover.

### `telegram`

- Bot onboarding, webhook verification, update dedupe, command/menu, cart và notification.

### `domains`

- Default subdomain, Cloudflare custom hostname, certificate state và canonical redirect.

### `subscriptions`

- Plan entitlements, trial, grace, suspension và platform billing state.

### `crypto`

- Envelope encryption, key versioning, hashing và secret redaction.

### `jobs`

- Queue messages, retry policy, outbox leases, cron maintenance và dead-letter handling.

Provider-specific types không được lan sang toàn domain. Adapter map provider payload thành domain command/event.

## 4. ID strategy

- Internal primary IDs: UUID v4 hoặc UUID v7 dạng text, sinh server-side.
- Public IDs: random opaque ID, không tuần tự và không tiết lộ số tenant/order.
- Human order number: prefix ngắn + sequence/random readable, unique theo shop.
- PayOS `orderCode`: positive safe integer, globally unique trong platform cho mọi payment attempt còn lưu.
- Telegram webhook public ID và PayOS webhook public ID: ít nhất 128-bit entropy.
- Không dùng slug, Telegram username hoặc email làm primary key.

## 5. Multi-tenant schema

Tên cột có thể điều chỉnh nhưng semantic và constraint phải giữ.

### Identity và tenant

#### `platform_users`

- `id`
- `email_normalized` unique
- `display_name`
- `status`
- `created_at`, `updated_at`, `last_login_at`

#### `shops`

- `id`
- `public_id` unique
- `slug` unique, normalized lowercase
- `name`
- `status`: `draft|active|suspended|archived`
- `default_locale`
- `currency` mặc định `VND`
- `timezone` mặc định `Asia/Ho_Chi_Minh`
- `canonical_domain_id` nullable
- `readiness_version`
- timestamps

#### `shop_members`

- `shop_id`, `user_id`
- `role`: `owner|manager|support|viewer`
- `status`
- unique `(shop_id, user_id)`
- index `(user_id, status)`

#### `shop_settings`

- `shop_id` primary/unique
- branding JSON đã validate hoặc các cột có cấu trúc
- storefront settings
- order expiry, low-stock threshold
- policy URLs/contact
- `version` cho optimistic concurrency

### Subscription

#### `plans`

- `id`, `code` unique
- feature flags và numeric limits có schema/version
- active/version/timestamps

#### `shop_subscriptions`

- `id`, `shop_id`
- `plan_id`
- `state`
- `trial_ends_at`, `current_period_start`, `current_period_end`
- `grace_ends_at`, `canceled_at`
- unique active subscription per shop bằng guard/service rule

#### `usage_counters`

- `shop_id`, `metric`, `period_key`
- `value`, `updated_at`
- unique `(shop_id, metric, period_key)`

### Domain

#### `shop_domains`

- `id`, `shop_id`
- `hostname_normalized` globally unique
- `type`: `platform_subdomain|custom`
- `status`: `pending|validating|active|failed|suspended|deleted`
- `is_primary`
- Cloudflare custom hostname ID nullable
- hostname/SSL status và validation metadata không chứa secret
- `last_checked_at`, `activated_at`, timestamps
- index `(shop_id, status)`

### Integrations và credentials

#### `shop_integrations`

- `id`, `shop_id`
- `provider`: `telegram|payos|email|cloudflare_domain`
- `status`: `disconnected|pending|active|degraded|disabled|error`
- provider identity đã sanitize: bot ID/username, PayOS channel label
- `health_code`, `last_checked_at`, `activated_at`
- unique `(shop_id, provider)` cho provider singleton trong MVP

#### `shop_credentials`

- `id`, `shop_id`, `provider`, `credential_name`
- `ciphertext_b64`, `iv_b64`, `key_version`
- optional `fingerprint` HMAC để phát hiện nhập trùng, không dùng hash có thể brute force
- `status`, `created_at`, `rotated_at`, `revoked_at`
- unique active `(shop_id, provider, credential_name)` bằng service rule

Không lưu token/secret trong `shop_integrations.metadata_json`.

#### `api_credentials` (`0038`, widened by `0040`)

- `id`, `public_id`, `shop_id`, `name`, `created_by_user_id`
- `scope_json` is limited to `catalog:read`, `shop:read` or the canonical combined scope; the grant, tenant, token hash and expiry are immutable
- Store only the purpose-bound keyed HMAC `token_hash`; reveal plaintext once at issuance and never recover it from D1
- `status`: `active|revoked`; optional `expires_at`, `last_used_at`, `revoked_at`, safe `revoke_reason`, optimistic `version`
- D1 triggers require the creator to be an active member of the same shop, allow only `active -> revoked`, prohibit physical deletion and cap each shop at ten active unexpired credentials
- Tenant-leading `(shop_id, status, updated_at, id)` and active-expiry indexes

Owners issue, list and revoke credentials through recent-authenticated dashboard routes. Mutations require CSRF, an idempotency key, an optimistic version and audit-once evidence. Seller exports exclude token and revocation-request hashes. Protected full DR/PITR backups retain keyed digests required to restore authoritative authentication state; post-restore credential rotation/revocation remains mandatory because a point-in-time restore can resurrect a later-revoked credential.

### Catalog

#### `product_categories`

- `id`, `shop_id`, `slug`
- localized name/description hoặc MVP Vietnamese fields
- `sort_order`, `status`
- unique `(shop_id, slug)`

#### `products`

- `id`, `shop_id`, `category_id`
- `slug`, `title`, `description`
- `status`: `draft|active|suspended|archived`
- `fulfillment_type`: `license_key|manual`
- media references
- policy/terms metadata
- `version`, timestamps
- unique `(shop_id, slug)`
- indexes `(shop_id, status, updated_at)`, `(shop_id, category_id, status)`

#### `product_variants`

- `id`, `shop_id`, `product_id`
- `sku` unique per shop
- `title`, structured options
- `price_minor`, `compare_at_minor`, `currency`
- min/max per order
- `status`
- indexes `(shop_id, product_id, status)`

#### `discounts`

- `id`, `shop_id`, `code_normalized`
- type/value/currency/minimum/window/usage limits
- status/version
- unique `(shop_id, code_normalized)`

### Inventory

#### `inventory_batches`

- `id`, `shop_id`, `variant_id`
- import source, filename sanitized, total/accepted/rejected counts
- checksum/fingerprint của file nếu cần dedupe
- created by/timestamps

#### `inventory_keys`

- `id`, `shop_id`, `variant_id`, `batch_id`
- `status`: `available|reserved|sold|revoked`
- `ciphertext_b64`, `iv_b64`, `key_version`
- `key_fingerprint` HMAC unique theo shop/variant để chặn duplicate mà không lộ key
- `reserved_order_item_id`, `reserved_until`
- `sold_order_item_id`, `sold_at`, `revoked_at`
- indexes:
  - `(shop_id, variant_id, status, id)`
  - `(shop_id, reserved_until, status)`
  - unique `(shop_id, variant_id, key_fingerprint)`

Allocation phải là atomic conditional write. Không dùng flow `SELECT available` rồi `UPDATE` tách rời mà không có guard.

### Buyer, cart và order

#### `shop_customers`

- `id`, `shop_id`
- email normalized/masked nullable
- display name, locale, status
- timestamps
- unique email chỉ trong cùng shop: `(shop_id, email_normalized)`

#### `customer_identities`

- `id`, `shop_id`, `customer_id`
- `provider`: `email|telegram`
- `external_subject`
- display handle sanitized
- verified timestamp
- unique `(shop_id, provider, external_subject)`

#### `carts`

- `id`, `shop_id`, `channel`
- browser/Telegram subject hash
- locale, discount code, state, expiry
- unique active cart theo `(shop_id, channel, subject_hash)`

#### `cart_items`

- `cart_id`, `shop_id`, `variant_id`, `quantity`
- unique `(cart_id, variant_id)`

#### `orders`

- `id`, `public_id`, `shop_id`, `customer_id`
- `order_number`
- `source_channel`: `web|telegram`
- `status`: `pending_payment|processing|completed|canceled|expired|exception`
- `payment_status`: `unpaid|pending|paid|partial|overpaid|failed|expired|refunded`
- `fulfillment_status`: `unfulfilled|reserved|fulfilled|failed|manual_review`
- monetary snapshot fields in minor units
- locale, customer snapshot, expiry, paid/fulfilled timestamps
- checkout subject hash, order token hash
- unique `(shop_id, order_number)`; `public_id` globally unique
- indexes `(shop_id, created_at, id)`, `(shop_id, payment_status, created_at)`

#### `order_items`

- `id`, `shop_id`, `order_id`, `product_id`, `variant_id`
- immutable title/SKU/option/price snapshot
- quantity, line totals, fulfillment type
- index `(shop_id, order_id)`

### Payment

#### `payment_attempts`

- `id`, `public_id`, `shop_id`, `order_id`
- provider `payos`
- unique `provider_order_code`
- payment link ID, checkout URL, QR payload/reference as appropriate
- exact expected amount/currency/description/account identity
- state, expiry, last reconciled time
- raw provider payload không được lưu nếu chứa dữ liệu không cần thiết; lưu normalized fields và payload hash
- indexes `(shop_id, order_id)`, `(provider, provider_order_code)`

#### Provider connection projection (`0035`)

- `iso_4217_currency_codes`: immutable ISO-4217 code/minor-unit reference rows.
- `payment_method_codes`: immutable supported method-code registry.
- `payment_provider_connections`: tenant-scoped provider code, environment, descriptor/policy versions, connection/settlement mode, credential ownership, merchant/provider-attested country, verified account fingerprint, health/webhook state and an optional same-tenant legacy PayOS link.
- `payment_provider_connection_capabilities`: provider grant, effective projection, version/evidence references, expiry and revocation state.
- `payment_provider_connection_currencies` and `payment_provider_connection_methods`: provider-supported and effective currency/method projections.

Composite tenant keys and database guards reject cross-shop links and stale effective projections. The deterministic source/local PayOS bridge grants only direct BYO seller VND `bank_transfer_qr` plus `checkout.create`, `credential.health`, `payment.reconcile` and `webhook.verify`; it does not create Stripe/second-provider credentials, webhooks, checkout, reconciliation or fulfillment. Migration `0036` clears only unverified legacy PayOS identity claims, preserving verified evidence for reconciliation/reconnect safety. Migration `0037` validates existing rows and installs tenant-leading indexes plus bidirectional guards across legacy integration, credential, attempt, event, exception and paid-event relationships. Migration `0039` permits release of provider identity evidence only during the admitted deletion crypto-shred fence; live claims remain immutable otherwise.

#### `payment_events`

- `id`, `shop_id`, `payment_attempt_id`
- provider event/reference ID
- payload hash
- signature verified boolean
- normalized event type/state
- received/processed timestamps, process result
- unique provider identity + payload hash theo contract

#### `payment_exceptions`

- `id`, `shop_id`, `order_id`, `payment_attempt_id`
- type: `partial|overpaid|late|identity_mismatch|inconsistent|manual_review`
- status/notes/resolution/audit timestamps

#### `payment_reversal_events` (`0048`)

- immutable `id`, `shop_id`, exact `order_id`, `payment_attempt_id`, `integration_id`, `credential_id` and `original_payment_event_id`
- credential version, provider, `refund|chargeback` kind, decision (`full_refund|chargeback|partial|mismatch|manual_review`) and verification method
- amount/currency plus expected amount/currency, reason and occurred/created timestamps
- provider-reference, evidence, idempotency and request fingerprints only; raw provider references, payloads, credentials and secrets are never stored
- tenant-leading order/attempt/decision indexes, same-tenant foreign keys and immutable update/delete guards

Only verified exact full refunds and chargebacks can mark the order `refunded` and revoke live generic/private access and active delivery grants in the same guarded batch. Partial or mismatched evidence creates an open `manual_review` exception without revocation. Sold keys, fulfillment, grants and consumption history remain retained evidence. Schema version 4 was the historical reversal-only seller-export checkpoint; current schema version 5 through `0052` retains the same safe normalized reversal metadata and adds generated-license lifecycle metadata. Backup counts include the ledger and shop deletion retains it.

### Fulfillment và jobs

#### `fulfillments`

- `id`, `shop_id`, `order_id`
- channel, state, idempotency key
- created/fulfilled/failed timestamps
- unique `(shop_id, order_id, fulfillment_type)`

#### `fulfillment_items`

- `id`, `shop_id`, `fulfillment_id`, `order_item_id`, `inventory_key_id`
- delivered timestamp/channel
- unique `inventory_key_id`

#### `outbox_jobs`

- `id`, `shop_id`, `kind`
- aggregate reference only, không plaintext key/secret
- status, attempts, next attempt, lease token/expiry, last safe error code
- indexes `(status, next_attempt_at)`, `(shop_id, kind, status)`

#### `idempotency_keys`

- `shop_id`, `namespace`, `key_hash`
- request hash, response reference, status, expiry
- unique `(shop_id, namespace, key_hash)`

#### `telegram_updates`

- `shop_id`, `bot_integration_id`, `update_id`
- payload hash, status, lease/attempt/timestamps
- unique `(bot_integration_id, update_id)`

#### `audit_logs`

- `id`, `shop_id` nullable cho platform events
- actor type/id, action, resource type/id
- safe metadata JSON đã redact
- request ID/IP hash/user-agent truncated
- immutable created timestamp

## 6. State transition rules

Mọi transition phải kiểm tra state hiện tại bằng conditional update. Ví dụ:

```sql
UPDATE orders
SET payment_status = 'paid', paid_at = ?
WHERE id = ? AND shop_id = ? AND payment_status IN ('unpaid', 'pending');
```

Sau đó kiểm tra `changes`. Không ghi đè terminal state không tương thích.

Reversal state follows the same conditional-update rule. A verified exact full refund or chargeback must fence the event row, update one still-`paid` order to `refunded`, revoke only pending/active/suspended generic entitlements, revoke active/suspended private entitlements and active delivery grants, then append the corresponding immutable `payment_reversal` transition. If the order CAS does not change exactly once, roll back the batch. Partial/mismatch/manual-review evidence creates no access mutation; replay with the same shop-scoped idempotency/reference/evidence hashes returns the original result, while changed evidence or tenant binding fails closed.

Key allocation:

1. Quote xác nhận variant và stock summary.
2. Checkout tạo order/items.
3. Reserve đúng số key bằng atomic update/returning hoặc guarded batch.
4. Nếu không đủ key, rollback/compensate toàn bộ order creation.
5. Hết TTL khi chưa paid: release reservation idempotently.
6. Paid: convert reserved key thành sold và tạo fulfillment một lần.

Nếu D1 primitive không cho một transaction dễ chứng minh, ưu tiên một SQL statement atomic hoặc transaction guard record. Viết concurrency test cho hai checkout tranh cùng key cuối.

## 7. Query rules

- Không dùng `SELECT *` ở production path.
- Mọi seller list dùng cursor pagination, không dùng offset lớn.
- Mọi list/filter thường dùng phải có composite index bắt đầu bằng `shop_id`.
- Public catalog chỉ đọc projection field cần thiết, không join inventory plaintext/ciphertext.
- Count stock có thể duy trì counter có guard hoặc query indexed status; source of truth vẫn là inventory rows.
- Mọi object load sau khi đã có tenant phải query `WHERE id = ? AND shop_id = ?`.

## 8. Cache rules

Cache được phép:

- Hostname -> shop public context.
- Public catalog projection ngắn hạn.
- Branding/theme.
- Plan entitlement snapshot.

Cache không được phép là source of truth cho:

- Stock exact.
- Checkout quote cuối cùng.
- Payment state.
- Subscription enforcement ở mutation nhạy cảm.
- Credential/key.

Mutation publish/domain/settings phải purge/version cache. Khi cache lỗi, fallback D1; không fallback sang tenant khác hoặc dữ liệu bootstrap không còn hợp lệ.

## 9. Sharding path

MVP có thể dùng một D1 transactional database. Ngay từ đầu:

- Tạo `shop_storage_locations` hoặc abstraction resolver đơn giản nếu cần.
- Không để route import trực tiếp một database toàn cục ở mọi nơi; repository nhận database binding/context.
- ID và webhook URL không chứa database name.
- Khi tăng tải, shard theo nhóm `shop_id`; platform directory giữ shop -> shard.

Không triển khai sharding trước khi metrics cho thấy single D1 là nút thắt.

## 10. API style

- Internal dashboard/public API dùng REST JSON đơn giản.
- Version public/integration API bằng `/api/v1` nếu có consumer ngoài browser nội bộ.
- Response thành công: `{ "ok": true, ... }`.
- Response lỗi: `{ "ok": false, "code": "stable_machine_code", "requestId": "..." }`.
- Validation có `issues` nhưng không echo secret/raw payload.
- Mutation hỗ trợ idempotency header/key ở checkout và provisioning.
- Các endpoint secret/order/key trả `private, no-store`, `nosniff`, `noindex`.

### Public API credential boundary

- The server-to-server Bearer token carries an environment marker and opaque credential public ID; compare its HMAC digest in constant time.
- After authentication, derive `shop_id` only from the credential row and recheck scope, expiry, shop lifecycle and subscription state. Ignore or reject client tenant overrides.
- The D1 per-credential rate limit is authoritative for this boundary; responses expose safe limit headers and KV is not quota authority.
- The bounded slice contains `GET /api/v1/shop` with `shop:read` and `GET /api/v1/catalog` with `catalog:read` (or the canonical combined scope), minimal tenant-derived projections and `private, no-store` headers.
- Every new scope/resource must define an operation matrix, idempotency/concurrency semantics, tenant-leading query path, redaction, export/deletion/backup lifecycle and contract tests before a route opens.
- Inventory, order, payment, fulfillment and entitlement APIs plus outbound webhook subscriptions remain follow-up work; `0040` grants only the catalog read projection and does not authorize those operations.
