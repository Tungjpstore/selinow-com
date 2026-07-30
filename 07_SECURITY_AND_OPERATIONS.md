# Security and Operations Contract

## 1. Threat model

Tài sản quan trọng:

- Tenant bot token và PayOS credentials.
- License keys chưa bán và đã giao.
- Order/customer identity và payment evidence.
- Seller session và membership.
- Custom domain ownership/routing.
- Platform master encryption keys và Cloudflare credentials.

Đối thủ/rủi ro chính:

- Buyer cố lấy key không thanh toán.
- Seller/staff truy cập tenant khác.
- Webhook giả hoặc replay.
- Credential/key lộ qua log, analytics, error, queue hoặc support.
- Race condition bán cùng key hai lần.
- Domain takeover/cache confusion.
- Compromised seller account hoặc revoked provider token.
- Abuse platform để bán hàng vi phạm.
- Runaway job/cost hoặc provider outage.

## 2. Secret classes

### Global platform secrets

Lưu bằng Cloudflare Worker secrets hoặc secret manager tương đương:

- Session signing/encryption secret.
- Magic link/OAuth secrets.
- Credential encryption root keys theo version.
- Inventory encryption root keys theo version.
- HMAC fingerprint/hash keys.
- Turnstile secret.
- Cloudflare API token cho custom hostname provisioning.
- Cloudflare Email Service `send_email` binding và sender-domain onboarding; không lưu email-provider API key trong Worker secrets.
- Platform billing PayOS credentials nếu có.

### Tenant secrets

Lưu mã hóa trong D1:

- Telegram bot token.
- Telegram webhook secret.
- PayOS Client ID/API Key/Checksum Key.
- Future per-shop provider credentials.

Tenant secrets không trở thành Worker secrets riêng lẻ.

## 3. Envelope encryption

Dùng Web Crypto trên Worker:

- AES-256-GCM.
- Random 96-bit IV cho mỗi encryption.
- AAD chứa schema version, purpose, shop ID, provider/record ID và key version.
- Root key là 32 random bytes, base64url, lưu trong Worker secret.
- Tách purpose cho `tenant-credential`, `inventory-key`, `telegram-recipient` bằng HKDF hoặc root key riêng.
- Ciphertext record lưu `ciphertext`, `iv`, `key_version`, không lưu plaintext.

Ví dụ AAD semantic:

```text
selinow.v1
tenant-credential
shop:{shopId}
provider:payos
name:checksum_key
key-version:v1
```

Decrypt phải fail closed khi AAD/version sai. Không fallback thử mọi key vô hạn.

## 4. Key rotation

- Mọi encrypted row có `key_version`.
- Giữ old decrypt keys trong thời gian migration có kiểm soát.
- New writes dùng active version.
- Rotation job đọc batch nhỏ, decrypt old, encrypt new và audit aggregate; không log plaintext.
- Có dry-run/count trước rotation.
- Không xóa old key cho tới khi scan chứng minh không còn row phụ thuộc và backup retention đã xử lý.

Provider credential rotation khác encryption key rotation; hai workflow phải tách.

## 5. Authentication

Seller dashboard:

- Host-only `Secure`, `HttpOnly`, `SameSite=Lax` session cookie.
- Session ID opaque, rotate sau login/privilege change.
- Magic link one-time, short TTL, hashed token storage.
- OAuth state/PKCE nếu dùng Google OAuth.
- Turnstile và rate limit cho login request.
- Recent authentication cho credential, billing, team owner và domain destructive actions.

Platform admin:

- Cloudflare Access hoặc strong SSO plus application role.
- Không dùng seller dashboard role làm platform admin.

## 6. Authorization and tenant isolation

Mọi seller mutation theo trình tự:

1. Authenticate user/session.
2. Resolve shop từ route/session.
3. Load membership `(shop_id, user_id)`.
4. Check role/capability.
5. Query resource với cả `id` và `shop_id`.
6. Apply plan/status guard.
7. Audit mutation.

Không nhận `role`, `shop_id`, price, payment status hoặc fulfillment status từ client như authority.

Viết negative tests cho mọi resource quan trọng bằng hai tenant A/B.

## 7. CSRF, Origin and CORS

- Cookie-auth mutation yêu cầu CSRF token và validate Origin/Host.
- Dashboard API chỉ cho origin chính xác `app.selinow.com` theo environment.
- Không dùng wildcard CORS với credentials.
- Webhook endpoints không dùng cookie/CSRF; dùng provider signature/secret.
- Public buyer API bound tenant từ hostname và có rate limit/idempotency.

## 8. Input/output safety

- Content type allowlist.
- Request body hard limits và bounded stream reader.
- UTF-8 fatal decoding cho JSON/text nếu phù hợp.
- Schema allowlist; reject unknown field ở sensitive API.
- URL allowlist HTTPS và expected host cho provider calls.
- Sanitize filename, hostname, slug và display text.
- Escape all seller-controlled content in HTML; không lưu/render arbitrary HTML.
- CSP, `nosniff`, frame policy và referrer policy phù hợp.
- Checkout/order/keys/credential responses `private, no-store`.

## 9. Webhook security

Telegram:

- Opaque route ID + secret header.
- Update ID dedupe và payload hash.

PayOS:

- Opaque route ID + HMAC signature verification.
- Provider event/order code dedupe và payload hash.

Chung:

- Body cap.
- Không parse/execute business mutation trước authentication thích hợp.
- Return stable 2xx/4xx theo provider retry contract.
- Request ID và safe event log.
- Replay không lặp side effect.

## 10. Inventory and fulfillment security

- Import plaintext không được log hoặc ghi public object store.
- Duplicate detection bằng HMAC fingerprint.
- Atomic reserve/sold transition.
- Key reveal kiểm tra paid, ownership và fulfillment allocation.
- Admin UI không có nút “xem toàn bộ plaintext key”. Nếu cần support reveal, dùng explicit break-glass, reason, recent auth và audit; tốt nhất không cung cấp trong MVP.
- Export key tồn kho là high-risk action: owner only, recent auth, encrypted temporary object, short-lived signed URL và audit.
- Notification outbox không chứa plaintext key.

## 11. Logging and observability

Structured logs allowlist:

- event name
- request ID
- safe shop public ID hoặc internal ID nếu logs private
- route/method/status
- latency
- provider safe error code
- retry count

Không log:

- Authorization/cookie.
- Telegram token/webhook secret.
- PayOS credentials/signature raw.
- License key.
- Full webhook body.
- Full email/chat ID/account number.
- Checkout URL/QR payload nếu chứa payment identity không cần thiết.

Tạo redaction helper và test log output. Console statement provider-related phải qua safe logger.

## 12. Rate limiting

Áp dụng theo route + shop + pseudonymous actor/IP:

- Signup/login/magic-link.
- Shop creation/slug checking.
- Product/key import.
- Anonymous checkout/quote/order status.
- Telegram/provider configuration test.
- Custom domain create/poll manual action.
- Key reveal/export.

D1 atomic limiter, Durable Object hoặc Cloudflare rate limiting có thể dùng. Không dựa chỉ vào in-memory state.

## 13. Audit

Audit bắt buộc cho:

- Shop/member/role changes.
- Product publish/suspend.
- Inventory import/revoke/export aggregate.
- Telegram/PayOS connect/rotate/disconnect.
- Domain create/primary/delete.
- Subscription/plan/suspension.
- Manual payment exception resolution.
- Support/break-glass action.
- Encryption key rotation.

Audit metadata phải mô tả hành động nhưng không chứa secret/key/plain provider payload.

## 14. Backup and recovery

- D1 Time Travel/bookmark/export theo khả năng plan hiện hành.
- Backup trước migration lớn/rotation.
- R2 object version/retention policy phù hợp.
- Restore runbook cho staging và production.
- Sau restore, revalidate domain cache, queue/outbox leases và provider webhook state.
- Không restore production credential/key plaintext ra developer machine.

Thực hiện restore drill định kỳ ở environment cô lập.

## 15. Job reliability

- Queue messages nhỏ, reference-based và versioned.
- Consumer idempotent.
- Exponential backoff + jitter.
- Max attempts và dead-letter.
- Lease fencing cho D1 outbox/cron claims.
- Provider concurrency bounded.
- Cron dùng cursor/index, không full-table scan.
- Một job lỗi tenant A không chặn tenant B.

## 16. Data retention and deletion

Định nghĩa retention theo loại:

- Telegram update payload: giữ tối thiểu cần cho dedupe/debug, sau đó purge.
- Idempotency rows: purge sau cửa sổ replay hợp lý.
- Orders/payments/audit: theo nghĩa vụ kinh doanh/pháp lý.
- Revoked credentials: ciphertext giữ ngắn theo rotation/reconciliation need, sau đó delete.
- Suspended/canceled shop: grace/export trước deletion.
- Custom domain mapping: remove routing trước data deletion.

Shop deletion là workflow nhiều bước, không `DELETE CASCADE` tức thời từ UI.

## 17. Abuse and legal operations

- Seller attests right to sell products.
- Report abuse endpoint.
- Platform can suspend product/shop.
- Preserve audit/evidence within policy.
- Do not reveal buyer/seller private data to reporter.
- Terms clarify seller responsibility, payment flow and platform role.

## 18. Incident runbooks

Viết runbook cho:

- Telegram token leaked/revoked.
- PayOS credential leaked/rotated.
- Payment webhook outage.
- Duplicate/incorrect fulfillment suspicion.
- D1 overloaded/unavailable.
- Custom domain takeover/misroute.
- Master encryption key compromise.
- Queue backlog.
- Cloudflare/Telegram/PayOS outage.
- Abusive seller/takedown.

Runbook phải có detect, contain, recover, verify và communicate.
