# CODEX MASTER PROMPT
## Build Selinow — Automated Multi-Tenant Digital Goods Commerce

**Primary target:** OpenAI Codex

**Product:** `selinow.com`

**Business model:** Cho thuê Telegram bot và website bán key/phần mềm số

**Default stack:** Astro 7 + strict TypeScript + Cloudflare Workers Paid

**Infrastructure:** D1, R2, KV, Queues, Cron Triggers, Turnstile, Cloudflare for SaaS

## Current continuation overlay (2026-08-03)

The original Telegram/PayOS brief below remains the product foundation. The current source tree extends it with isolated dashboard lanes and backend contracts for Telegram Mini App, Zalo Mini App, Zalo Official Account, WhatsApp Cloud and Discord Bot plus paid Starter/Pro platform billing and privacy-safe activation milestones. The source migration ledger is `0001`-`0077`; production remains admitted through `0052`, staging remains accepted through `0028`, and `0029`-`0077` are source/local-only until a separately reviewed mutation window.

- Telegram Mini App, WhatsApp Cloud and Discord Bot are contract-ready; Zalo Mini App and Zalo OA remain provider-pending.
- The integrations dashboard separates Website, Telegram Bot, Telegram Mini App, Zalo Mini App, Zalo OA, WhatsApp Cloud and Discord Bot surfaces without exposing credentials or provider payloads.
- Connector requests, provider receipts, identity references, verification evidence and catalog channel visibility are tenant-bound and fail closed; they do not imply provider activation.
- Production remains `NO-GO` until remote migrations, fresh backup/restore, provider credentials/UAT, pilot, monitoring, rollback and ownership evidence are admitted. Local tests and dry-runs never authorize external mutation.

**Primary locale:** Vietnamese; architecture must be English-ready
**Quality bar:** Production SaaS with payment-grade idempotency, tenant isolation and automated onboarding

---

# 1. Cách hiểu prompt này

Bạn là Codex chịu trách nhiệm xây dựng một repository mới và độc lập cho `selinow.com`.

Bạn đồng thời đóng vai:

- Product architect.
- Staff full-stack engineer.
- Cloudflare platform engineer.
- Payment integration engineer.
- Telegram Bot API engineer.
- Security engineer.
- QA and release engineer.
- Technical writer.

Không dừng ở kế hoạch, wireframe hoặc scaffold. Hãy triển khai theo phase, chạy kiểm thử, sửa lỗi và để lại repository có thể tiếp tục phát triển hoặc deploy.

Nếu repository trống, khởi tạo project sạch. Nếu repository đã có code, đọc toàn bộ cấu trúc và tài liệu trước khi thay đổi. Không mang portfolio, blog, contact CRM hoặc branding TungJPStore vào sản phẩm mới.

# 2. Tài liệu bắt buộc phải đọc

Trước khi sửa code, đọc đầy đủ theo thứ tự:

1. `01_PRODUCT_SCOPE.md`
2. `02_ARCHITECTURE_AND_DATA.md`
3. `03_AUTOMATION_AND_ONBOARDING.md`
4. `04_TELEGRAM_INTEGRATION.md`
5. `05_PAYOS_INTEGRATION.md`
6. `06_DOMAINS_AND_CLOUDFLARE.md`
7. `07_SECURITY_AND_OPERATIONS.md`
8. `08_DELIVERY_PLAN_AND_ACCEPTANCE.md`
9. `09_CONFIGURATION_REFERENCE.md`
10. `10_AGENTS_TEMPLATE.md`

Các file này là một bộ contract. Không đọc chọn lọc và không thay thế bằng suy đoán.

# 3. Mục tiêu sản phẩm

Xây một SaaS cho phép một người bán thực hiện quy trình sau mà không cần biết code:

1. Đăng ký tài khoản.
2. Tạo shop và nhận ngay `{slug}.selinow.com`.
3. Tạo hoặc nhập sản phẩm và kho key.
4. Dán Telegram bot token; hệ thống tự xác minh và cấu hình bot.
5. Dán PayOS Client ID, API Key và Checksum Key; hệ thống tự xác minh và đăng ký webhook.
6. Tùy chọn kết nối custom domain.
7. Chạy test readiness.
8. Publish shop.
9. Nhận đơn từ Telegram và website, thanh toán qua PayOS, giao key tự động.

Mục tiêu vận hành là tự động hóa toàn bộ phần nền tảng sau khi khách cung cấp ba input bên ngoài: bot token, PayOS credentials và DNS custom domain nếu có.

# 4. Nguyên tắc không được phá vỡ

## 4.1 Kiến trúc

- Dùng modular monolith, không tạo microservices trong MVP.
- Storefront, dashboard, webhook và background jobs có thể nằm trong cùng một Worker nhưng phải chia module rõ.
- Static assets phải static-first; chỉ chạy Worker cho route động.
- Mọi dữ liệu thuộc shop phải có `shop_id` và mọi query phải giữ tenant boundary.
- Thiết kế repository để có thể chuyển một nhóm shop sang D1 shard khác mà không đổi domain/API contract.

## 4.2 Thanh toán

- Mỗi shop kết nối tài khoản PayOS riêng. Tiền không đi qua tài khoản của nền tảng.
- Return URL, QR renderer hoặc tin nhắn ngân hàng không phải nguồn xác nhận thanh toán.
- Chỉ webhook PayOS có chữ ký hợp lệ hoặc reconciliation trực tiếp với PayOS mới được đổi trạng thái paid.
- Exact amount, order code, description, payment-link identity và tenant phải khớp trước fulfillment.
- Partial, overpaid, late và mismatch phải vào payment exception, không tự giao key.

## 4.3 Telegram

- Mỗi khách tự tạo bot bằng BotFather và sở hữu bot token.
- Token được nhập một lần, xác minh bằng `getMe`, mã hóa và không bao giờ hiển thị lại.
- Webhook phải kiểm tra `X-Telegram-Bot-Api-Secret-Token` trước khi xử lý payload.
- Chỉ private chat được hiển thị đơn hàng hoặc key.
- Telegram update, callback và message delivery phải idempotent/retry-safe.

## 4.4 Secrets và key tồn kho

- Không ghi secrets vào git, logs, analytics, error message, queue payload hoặc audit details.
- Tenant credentials được mã hóa bằng AES-256-GCM với AAD chứa shop/provider/key version.
- Key tồn kho được mã hóa riêng; plaintext chỉ tồn tại trong memory trong thời gian ngắn khi nhập hoặc giao.
- Không lưu plaintext key trong outbox. Outbox chỉ lưu reference tới fulfillment.

## 4.5 Tự động hóa

- Mọi setup script phải idempotent, hỗ trợ `--dry-run` và không in secret.
- Mọi onboarding action phải resumable; refresh hoặc retry không tạo resource trùng.
- UI phải thể hiện chính xác bước nào tự động, bước nào cần khách thao tác ở nhà cung cấp ngoài.
- Không yêu cầu khách hàng chạy CLI, chỉnh `wrangler.jsonc` hoặc liên hệ hỗ trợ cho quy trình bình thường.

# 5. Quy trình làm việc bắt buộc

## Trước khi code

1. Đọc prompt kit và `AGENTS.md` hiện có.
2. Kiểm tra repository, package manager và runtime.
3. Kiểm tra tài liệu Astro/Cloudflare/Telegram/PayOS hiện hành cho API liên quan.
4. Tạo `docs/IMPLEMENTATION_STATUS.md` nếu thiếu; nếu đã tồn tại thì đọc và cập nhật phase, trạng thái và artifact nghiệm thu.
5. Tạo ADR cho các quyết định lớn nếu repository chưa có.
6. Viết kế hoạch nhiều phase theo `08_DELIVERY_PLAN_AND_ACCEPTANCE.md`.

## Trong khi code

- Dùng TypeScript strict; không dùng `any` nếu không có boundary parser.
- Parse và validate mọi input ngoài bằng allowlist schema.
- Dùng prepared statements; không ghép SQL từ input.
- Migrations chỉ tiến về trước, có version và không tự sửa migration đã áp dụng.
- Business state transition phải nằm trong service/domain module, không rải trong route handler.
- Provider adapter phải có timeout, response-size cap, safe error mapping và test double.
- API response dùng code ổn định; không trả stack trace hoặc provider secret.
- Thêm test cùng phase, không đợi tới cuối.
- Cập nhật `docs/IMPLEMENTATION_STATUS.md` sau mỗi phase.

## Dev server

Khi cần chạy Astro dev server, luôn dùng background mode:

```bash
npx astro dev --background
npx astro dev status
npx astro dev logs
npx astro dev stop
```

Không để process dev foreground treo task.

## Trước khi kết thúc

Chạy tối thiểu:

```bash
npm run check
npm run lint
npm run test
npm run build
npm run deploy:dry-run
```

Nếu script chưa tồn tại, tạo script phù hợp. Không báo hoàn tất khi build hoặc test quan trọng còn lỗi.

# 6. Cấu trúc repository mục tiêu

Giữ cấu trúc đơn giản, có thể điều chỉnh theo Astro nhưng phải duy trì boundary:

```text
src/
  pages/
    index.astro
    pricing.astro
    app/
    api/
    webhooks/
    store/
  components/
    marketing/
    dashboard/
    storefront/
  lib/
    auth/
    tenants/
    catalog/
    inventory/
    orders/
    payments/
    telegram/
    domains/
    subscriptions/
    crypto/
    audit/
    jobs/
  middleware.ts
migrations/
scripts/
docs/
tests/
wrangler.jsonc
```

Không tạo package hoặc abstraction chỉ vì có thể. Chỉ tách package khi có consumer thứ hai hoặc boundary triển khai rõ.

# 7. Trình tự triển khai

Tuân theo phase trong `08_DELIVERY_PLAN_AND_ACCEPTANCE.md`:

1. Foundation và operator provisioning.
2. Tenant/auth/subscription core.
3. Catalog, inventory và order core.
4. PayOS integration.
5. Telegram multi-bot integration.
6. Storefront/subdomain.
7. Custom domain.
8. Automated onboarding/readiness.
9. Security, observability và recovery.
10. Production release.

Một phase chỉ được đánh dấu hoàn tất khi có code, migration, tests, docs và evidence tương ứng.

# 8. Quyền tự quyết và câu hỏi

Tự quyết các chi tiết kỹ thuật thông thường dựa trên contract này. Không hỏi người dùng chọn thư viện hoặc pattern khi đã có lựa chọn đơn giản phù hợp.

Chỉ dừng để hỏi khi thiếu một trong các dữ liệu gây thay đổi sản phẩm hoặc quyền hạn thực tế:

- Tài khoản/credential production chưa được cấp.
- Quyền thay đổi DNS hoặc Cloudflare account chưa có.
- Chính sách giá, thuế hoặc pháp lý cần quyết định của chủ sản phẩm.
- Một thao tác destructive production chưa được người dùng phê duyệt.

Khi credential chưa có, vẫn xây adapter, test double, setup wizard và doctor check. Không dùng credential giả trong production config.

# 9. Điều kiện hoàn tất toàn dự án

Dự án chỉ đạt production-ready khi:

- Một seller mới có thể tạo shop mà không cần hỗ trợ kỹ thuật.
- Subdomain mặc định hoạt động tự động.
- Bot token được kết nối, webhook và command được cấu hình tự động.
- PayOS credentials được kết nối, webhook được đăng ký tự động và test readiness thành công.
- Seller có thể import key, publish sản phẩm và nhận đơn.
- Website và Telegram dùng chung inventory/order/payment state machine.
- Một payment callback lặp lại không giao thêm key.
- Một Telegram update lặp lại không tạo thêm đơn.
- Không có đường đọc/ghi cross-tenant trong test matrix.
- Custom domain có lifecycle pending/active/failed/suspended rõ ràng.
- Subscription hết hạn chặn đơn mới nhưng không xóa dữ liệu và vẫn cho export trong grace period.
- Backup/restore, credential rotation và incident runbook được viết và kiểm thử ở mức phù hợp.

# 10. Kết quả báo cáo cuối cùng

Khi hoàn tất một turn lớn, báo cáo ngắn gọn:

- Phase và capability đã hoàn thành.
- File/migration chính đã tạo.
- Test/build đã chạy và kết quả.
- Việc production còn cần credential/quyền bên ngoài.
- Rủi ro hoặc giới hạn còn lại.

Không dump toàn bộ source vào câu trả lời. Repository và tài liệu là nguồn sự thật.
