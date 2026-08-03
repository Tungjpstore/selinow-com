# Domains and Cloudflare Contract

## Current continuation overlay (2026-08-03)

The platform-only production route handoff is live for Selinow-owned hosts, but external customer-domain cutover and Turnstile hostname admission remain pending evidence. New provider webhook endpoints use opaque connection/public identifiers and do not change DNS ownership or authorize a provider. Local development and dry-runs must continue using isolated bindings and must never target production custom-hostname resources.

## 1. Domain map

```text
selinow.com                 Marketing/platform
www.selinow.com             308 -> apex
app.selinow.com             Seller dashboard
api.selinow.com             API/webhooks
media.selinow.com           Public media delivery
customers.selinow.com       Cloudflare for SaaS CNAME target
proxy-fallback.selinow.com  SaaS fallback origin
{slug}.selinow.com          Default tenant storefront
```

Reserved subdomains/slugs tối thiểu:

```text
www, app, api, admin, media, assets, customers, proxy-fallback,
status, support, docs, help, mail, email, billing, auth, login,
signup, dashboard, cdn, static, test, staging, dev
```

## 2. Cloudflare resources

Tạo resource riêng theo environment:

- Worker application.
- D1 database.
- R2 media bucket.
- KV namespace cho hostname/config cache.
- Queue(s) và dead-letter queue.
- Cron triggers.
- Turnstile site/secret.
- Cloudflare for SaaS configuration trên zone.
- Worker routes/custom domains.

Không dùng resource portfolio hiện tại.

## 3. Platform subdomain

- DNS wildcard `*.selinow.com` route tới Worker phù hợp.
- Tenant resolver nhận hostname, loại suffix và normalize slug.
- Reserved hostname không đi vào storefront resolver.
- Shop draft trả preview gate/coming-soon, không lộ dashboard data.
- Shop suspended trả storefront-safe notice và chặn checkout.
- Unknown hostname trả 404, không redirect về tenant khác.

Subdomain được tạo logic trong D1 ngay khi shop tạo; không cần tạo một DNS record cho từng shop nếu wildcard đã cấu hình.

## 4. Cloudflare for SaaS

Dùng Cloudflare for SaaS cho external custom hostname. Theo tài liệu hiện hành, platform cần:

1. Zone `selinow.com` trên Cloudflare.
2. Enable Cloudflare for SaaS.
3. Proxied fallback origin.
4. Friendly CNAME target `customers.selinow.com`.
5. Tạo custom hostname qua API cho từng seller domain.
6. Theo dõi hostname validation và SSL validation riêng.

Không coi hostname ready chỉ vì TLS handshake tạm thành công. Source of truth readiness:

- Custom hostname `status == active`.
- SSL `status == active`.
- DNS trỏ tới đúng SaaS target.

## 5. Supported custom domain MVP

Ưu tiên:

```text
shop.customer.com CNAME customers.selinow.com
```

Không hứa hỗ trợ apex `customer.com` trong MVP nếu provider DNS không hỗ trợ CNAME flattening hoặc Cloudflare plan không có apex proxying phù hợp.

UI phải:

- Giải thích subdomain custom là lựa chọn khuyến nghị.
- Detect apex và đưa warning/unsupported code có hướng dẫn.
- Không yêu cầu seller upload certificate.
- Không yêu cầu seller proxy qua CDN khác; custom hostname dùng CDN khác có thể không validate.

## 6. Custom hostname API lifecycle

```text
requested
  -> creating
  -> pending_dns
  -> validating_hostname
  -> validating_ssl
  -> active
  -> failed | suspended | deleting | deleted
```

Create action:

1. Validate plan entitlement và hostname.
2. Check global uniqueness in D1.
3. Create pending row với idempotency key.
4. Call Cloudflare API.
5. Store Cloudflare hostname ID và validation records đã sanitize.
6. Return exact DNS instructions.
7. Poll with backoff until active/failed timeout.

Delete action:

- Confirm impact.
- Remove from canonical routing first.
- Delete Cloudflare custom hostname.
- Invalidate caches.
- Mark deleted, giữ audit.
- Không tự xóa seller DNS record vì platform không sở hữu DNS của họ.

## 7. Domain ownership and safety

- Normalize lowercase, strip trailing dot, IDNA/punycode handling.
- Reject URL input; field chỉ nhận hostname.
- Reject IP address, localhost, internal suffix, wildcard và credentials/path/query.
- Prevent hostname claim race bằng unique constraint.
- Verify seller ownership qua Cloudflare validation process.
- Không cho một shop claim hostname platform/system.
- Domain reassignment giữa shop cần delete/cooldown/audit để tránh data exposure.

## 8. Canonical URL

- Mỗi shop có một primary domain.
- Non-primary active domain redirect 308 tới primary cho public catalog, giữ safe path/query.
- Không redirect webhook/API/order-token route dựa trên storefront canonical logic.
- Khi custom domain chưa active, subdomain platform vẫn là primary/fallback.
- Chuyển primary domain chỉ sau khi custom domain active.

Return/cancel URL của payment attempt nên snapshot canonical origin tại thời điểm tạo, nhưng order-status resolver phải chịu được domain đổi sau đó.

## 9. Hostname cache

KV/cache record:

```json
{
  "shopPublicId": "...",
  "shopId": "...",
  "status": "active",
  "canonicalOrigin": "https://...",
  "version": 12
}
```

- TTL ngắn-vừa, có version.
- D1 là source of truth.
- Domain create/activate/suspend/delete purge cache.
- Negative cache rất ngắn để hostname mới không bị 404 lâu.
- Không cache credential, key hoặc session.

## 10. Storefront rendering and caching

- Static CSS/JS/media dùng Cloudflare Static Assets/R2 CDN.
- Public catalog SSR hoặc cached HTML ngắn hạn theo hostname + locale/path.
- Cache key bắt buộc chứa normalized hostname và locale.
- Checkout/cart/order/key không cache public.
- Product/inventory mutation purge/version public catalog cache.
- Stock hiển thị có thể stale nhẹ, nhưng checkout luôn kiểm tra source of truth.

## 11. R2 media

- Seller uploads logo/product images qua authenticated API.
- Validate MIME, magic bytes, dimensions và size.
- Object key namespaced bằng shop ID/public ID và immutable version/hash.
- Public media bucket không chứa key, credential, CSV import, export nhạy cảm hoặc private draft nếu không có access layer.
- Custom domain `media.selinow.com` hoặc Worker media route.
- Seller delete product không ngay lập tức xóa object đang được order snapshot/reference dùng; dùng garbage collection có retention.

## 12. Turnstile and WAF

Turnstile cho:

- Signup/login magic-link request.
- Anonymous website checkout khi risk threshold yêu cầu.
- Domain/contact abuse-sensitive forms.

Server verifies token, hostname/action và fail-closed khi site key/secret config lệch. Rate limiting vẫn cần dù có Turnstile.

## 13. Capacity and pricing awareness

Cloudflare quotas/pricing thay đổi; không hard-code marketing claim từ prompt này. Trước release kiểm tra:

- Workers requests và CPU billing.
- D1 reads/writes/storage và database limits.
- KV operations.
- Queue operations.
- R2 storage/operations.
- Cloudflare for SaaS included/custom hostname pricing.

Tạo usage dashboards và budget alerts. Custom domain nên là plan/add-on có giá vì có hostname cost và support burden.

## 14. Domain tests

- Wildcard subdomain resolves đúng tenant.
- Reserved hostname không resolve thành shop.
- Unknown hostname không leak default tenant.
- Same custom hostname cannot attach two shops.
- Hostname active nhưng SSL pending chưa được mark ready.
- Primary domain redirect preserves safe path/query.
- Cache key cannot mix tenant content.
- Suspended/deleted domain invalidates cache.
- Unicode/punycode hostname normalized consistently.
- Custom domain flow survives repeated create/poll requests.

## 15. Official references

- Cloudflare for SaaS: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/
- Hostname validation: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/
- Workers: https://developers.cloudflare.com/workers/
- D1: https://developers.cloudflare.com/d1/
- R2: https://developers.cloudflare.com/r2/
- Turnstile: https://developers.cloudflare.com/turnstile/
