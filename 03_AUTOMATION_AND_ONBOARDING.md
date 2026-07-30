# Automation and Onboarding Contract

## 1. Automation objective

Tự động hóa có hai lớp khác nhau:

1. **Operator provisioning:** chủ nền tảng tạo hạ tầng Cloudflare và deploy `selinow.com`.
2. **Seller onboarding:** khách hàng tạo shop, kết nối provider và publish mà không chạy CLI.

Hai lớp không được trộn. Seller không bao giờ nhận Cloudflare API token hoặc truy cập hạ tầng platform.

## 2. Những việc bắt buộc con người làm

Hệ thống phải nói rõ, không hứa “một click” giả:

- Seller tạo Telegram bot trong BotFather và dán token.
- Seller tạo PayOS payment channel và dán ba credentials.
- Seller tạo DNS record cho custom domain, trừ khi họ đã cấp quyền DNS qua một integration tương lai.
- Platform owner đăng ký/kiểm soát domain `selinow.com`, Cloudflare account và Cloudflare Email Service sender-domain/DNS onboarding; sender binding dùng `no-reply@selinow.com` và không cần email-provider API key.

Mọi bước sau input phải được tự động hóa và có trạng thái kiểm tra.

## 3. Operator provisioning CLI

Tạo script idempotent. Provision/reconcile ban đầu dùng:

```bash
npm run platform:provision -- --env staging --dry-run
npm run platform:provision -- --env staging
npm run platform:doctor -- --env staging --json
```

Với staging đã tồn tại, mỗi change phải theo thứ tự guard sau:

```bash
# 1. Offline packaging; không đọc route và không deploy.
npm run deploy:dry-run
npm run deploy:staging:dry-run

# 2. Read-only admission: phải đọc được live route inventory trước mutation.
npm run platform:doctor -- --env staging --json
npm run db:migrate:status -- --env staging
npm run db:preflight -- --env staging --json

# 3. Validate rồi tạo protected backup của đúng staging D1.
npm run backup:create -- --env staging --dry-run --json
npm run backup:create -- --env staging --json

# 4. Chỉ sau admission + backup hợp lệ mới apply reviewed changes.
npm run db:migrate -- --env staging
npm run db:migrate:status -- --env staging
npm run db:seed -- --env staging

# 5. Live deploy tự audit routes lần nữa ngay trước Wrangler.
npm run platform:doctor -- --env staging --json
npm run deploy:staging
```

Hai operator token tạm `CLOUDFLARE_PLATFORM_API_TOKEN` và `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN` phải được cấp ngoài source control cho live admission; thiếu một token, route inventory không đọc được hoặc route drift thì dừng trước backup thật, migration và deploy. `db:seed` chỉ chạy khi seed đã được review cho change đó, không phải bước mặc định; migrations `0035`-`0045` tự backfill/validate theo từng forward-only contract và không biến seed thành điều kiện mặc định. Source/local migration chain hiện qua `0045`; accepted staging ledger vẫn qua `0028`, với `0029`-`0045` pending. Read-only evidence hiện tại cho D1 identity và private `MEDIA` không thay thế việc recheck ngay trước mutation, và protected report-v2 backup của đúng staging D1 phải mới không quá 60 phút. Dry-run packaging không chứng minh route admission và không được dùng để tuyên bố staging đã deploy. Phase B source/local acceptance is complete for the reviewed locale catalogs, source-level key/placeholder detection, unified BCP47 boundaries, durable Telegram explicit preference, canonical order currency binding, seller country controls, paired English/Vietnamese commerce evidence and RTL logical/render checks. Seller onboarding/globalization remains visual-review pending; staging and production are not authorized by local evidence.

`platform:provision` phải:

1. Kiểm tra Node/package manager/Wrangler version.
2. Kiểm tra Cloudflare login/API token mà không in token.
3. Resolve account ID và zone ID của `selinow.com`.
4. Tạo hoặc tìm D1 database theo environment.
5. Tạo hoặc tìm R2 bucket.
6. Tạo hoặc tìm KV namespace.
7. Tạo hoặc tìm Queues và dead-letter queue.
8. Tạo Worker config từ template bằng resource IDs thực.
9. Kiểm tra DNS host nền tảng.
10. Kiểm tra Cloudflare for SaaS và fallback origin/CNAME target.
11. Báo danh sách global secrets còn thiếu; không tự sinh lại secret đang tồn tại.
12. Sinh secret local hoặc hướng dẫn `wrangler secret put` cho production.
13. Chạy migration/seed chỉ khi flag cho phép.
14. Ghi manifest không chứa secret vào `infra/generated/{env}.json` hoặc tương đương.

Script phải có:

- `--dry-run`.
- `--json` cho CI.
- Exit code khác 0 khi requirement bắt buộc thiếu.
- Không ghi đè resource khác cùng tên nếu ownership tag/manifest không khớp.
- Không xóa resource trong command provision.

## 4. Environment separation

Tối thiểu:

- `local`: local D1/test doubles, không chạm production provider.
- `staging`: resource Cloudflare riêng, bot test và PayOS test/controlled channel riêng.
- `production`: domain và credential thật.

Không dùng production D1/R2/token trong local dev. Không cho staging webhook ghi vào production database.

## 5. Seller onboarding state machine

Lưu onboarding state ở server, không chỉ localStorage:

```text
account_ready
  -> shop_created
  -> channel_selected
  -> catalog_ready
  -> inventory_ready
  -> telegram_ready (optional by plan/channel)
  -> payos_ready
  -> domain_ready (platform subdomain always; custom optional)
  -> readiness_passed
  -> published
```

Mỗi step record:

- `status`
- `version`
- `started_at`, `completed_at`
- safe `blocking_code`
- last check time
- actor/action audit reference

UI phải cho phép quay lại, retry và skip bước tùy chọn.

## 6. Tạo shop tự động

Sau signup:

1. Normalize và validate slug.
2. Chặn reserved/profane/system slug.
3. Tạo `shops`, owner membership, settings, subscription trial và platform subdomain trong một guarded operation.
4. Seed theme, category và một product draft mẫu nếu người dùng chọn.
5. Warm hostname cache.
6. Hiển thị preview `https://{slug}.selinow.com` ngay cả khi shop chưa publish; preview phải yêu cầu seller session hoặc preview token.

Retry cùng idempotency key phải trả về shop đã tạo, không tạo shop mới.

## 7. Telegram connection automation

Seller chỉ dán token. Server thực hiện:

1. Validate format sơ bộ và body limits.
2. Gọi `getMe` với timeout.
3. Từ chối token không thuộc bot hoặc token đã active ở shop khác.
4. Sinh webhook secret và webhook public ID.
5. Mã hóa token/secret; transactionally lưu pending integration.
6. Gọi `setMyCommands` cho locale hỗ trợ.
7. Cấu hình menu button nếu dùng.
8. Gọi `setWebhook` cuối cùng.
9. Gọi `getWebhookInfo` và xác nhận URL.
10. Mark integration active và hiển thị bot username, không hiển thị token.
11. Hướng dẫn seller mở bot và gửi `/start` để chạy health test end-to-end.

Nếu bước 6–9 lỗi, integration giữ `pending/error`, token vẫn được bảo vệ và nút Retry tiếp tục từ trạng thái an toàn.

## 8. PayOS connection automation

Seller dán Client ID, API Key, Checksum Key. Server:

1. Validate độ dài/control characters, không log payload.
2. Mã hóa credentials ngay khi nhận.
3. Dùng credentials để gọi một operation xác minh an toàn theo API hiện hành.
4. Sinh PayOS webhook public ID.
5. Đăng ký webhook tự động bằng PayOS confirm-webhook API nếu channel/API cho phép.
6. Lưu identity đã sanitize và trạng thái.
7. Chạy readiness check: credentials usable, webhook registered, shop domain origin hợp lệ.
8. Cho phép seller tạo controlled test order; không tự tạo giao dịch tiền thật không có xác nhận.

Nếu PayOS không cung cấp operation read-only để xác minh credentials, dùng confirm-webhook hoặc tạo/cancel payment link test theo tài liệu chính thức và trình bày rõ tác động.

## 9. Product and key import automation

Hỗ trợ hai đường:

- Form tạo product/variant.
- CSV template và paste multiline.

Import workflow:

1. Upload/paste vào endpoint giới hạn kích thước.
2. Parse stream hoặc bounded buffer.
3. Normalize line endings; không trim nội dung key ngoài quy tắc được xác định.
4. Reject empty/oversized/control-character key.
5. Tạo HMAC fingerprint để phát hiện duplicate.
6. Preview accepted/rejected/duplicate counts, không echo toàn bộ key trong response/log.
7. User confirm.
8. Encrypt và insert batch idempotently.
9. Xóa plaintext buffer/reference nhanh nhất có thể.

Không upload file key plaintext vào public R2. Nếu cần staged import, dùng encrypted object với TTL và access control riêng; MVP ưu tiên xử lý trực tiếp bounded payload.

## 10. Custom domain onboarding automation

1. Seller nhập hostname, ví dụ `shop.example.com`.
2. Normalize IDNA/punycode và validate ownership constraints.
3. Từ chối apex nếu flow hiện tại không hỗ trợ đáng tin cậy.
4. Tạo Cloudflare custom hostname qua API.
5. Lưu hostname ID/status.
6. Hiển thị chính xác CNAME/TXT records cần tạo.
7. Poll bằng job có exponential backoff.
8. Chỉ mark ready khi hostname và SSL đều active và DNS trỏ đúng target.
9. Tự chuyển canonical domain chỉ sau explicit seller confirmation hoặc setting đã chọn.
10. Tự gia hạn/monitor certificate qua Cloudflare; seller không thao tác SSL thủ công.

## 11. Readiness engine

Tạo một service duy nhất trả về checks, dùng chung cho dashboard, publish guard và support:

```ts
type ReadinessCheck = {
  code: string;
  status: "pass" | "warning" | "fail";
  required: boolean;
  messageKey: string;
  actionUrl?: string;
  checkedAt: string;
};
```

Checks bắt buộc:

- Shop/subscription cho phép publish.
- Platform subdomain resolves.
- Có ít nhất một active product/variant.
- Product license-key có inventory hoặc fulfillment mode hợp lệ.
- PayOS active và webhook healthy.
- Nếu Telegram channel enabled: bot active và đã nhận health update.
- Nếu website enabled: storefront responds/canonical hợp lệ.
- Policies/contact cơ bản đã cấu hình.
- Không có critical security/integration error.

Publish API luôn chạy lại critical checks ở server; không tin trạng thái UI đã cache.

## 12. Automated test order

Readiness nên cung cấp test mode tách với production sale:

- Catalog/inventory dry allocation không tiêu thụ key thật, hoặc dùng key test đã đánh dấu.
- Telegram health message xác nhận bot -> webhook -> queue -> response.
- PayOS có thể tạo payment link test/controlled low-value theo provider capability.
- Không tự đánh dấu paid nếu chưa có signed provider evidence.
- Sau test, cleanup idempotent và không xóa audit.

## 13. Self-healing và monitoring

Cron/queue jobs:

- Recheck degraded Telegram webhook.
- Reconcile pending PayOS payments.
- Release expired inventory reservations.
- Retry notification/fulfillment outbox.
- Poll pending custom hostname.
- Expire idempotency/update dedupe records theo retention.
- Recompute readiness khi integration/domain/subscription đổi.
- Send low-stock, payment exception và subscription reminders.

Không silently retry mãi. Sau ngưỡng, chuyển dead-letter/manual review và hiển thị seller action.

## 14. Automation acceptance

Một seller mới phải hoàn thành chỉ bằng browser/Telegram:

- Signup.
- Tạo shop/subdomain.
- Tạo/import product và key.
- Connect bot token.
- Connect PayOS credentials.
- Run readiness.
- Publish.
- Receive test/real order.

Không có bước SSH, CLI, source edit, database edit, Worker secret hoặc ticket support trong happy path.
