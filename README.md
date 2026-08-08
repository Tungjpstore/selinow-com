# Selinow

Repository này chứa cả implementation và prompt/acceptance contract của SaaS độc lập `selinow.com`: một nền tảng vận hành thương mại số đa kênh, dùng chung catalog, kho key, đơn hàng, thanh toán và fulfillment. Website, Telegram và PayOS là các adapter đầu tiên; kiến trúc đã chốt đường mở rộng sang messaging, social commerce, marketplace và payment provider khác mà không sao chép business logic theo từng nền tảng.

Trạng thái phase, verification gần nhất, yêu cầu staging bên ngoài và production NO-GO được ghi tại `docs/IMPLEMENTATION_STATUS.md`. Không suy ra production readiness chỉ từ việc route, migration hoặc release script đã tồn tại.

## Tiếp tục implementation hiện tại

1. Đọc `AGENTS.md`, `00_MASTER_PROMPT.md` và các contract được master prompt yêu cầu.
2. Đọc `docs/IMPLEMENTATION_STATUS.md`, kiểm tra worktree và xác minh artifact hiện có trước khi sửa code.
3. Tiếp tục phase chưa hoàn tất đầu tiên; không làm lại phase đã có evidence trừ khi verification phát hiện regression.
4. Không chạm production D1, R2, Queue, provider credential, DNS hoặc custom-hostname resource nếu chưa qua Phase 10 gate và chưa có phê duyệt riêng cho mutation đó.

Verification cục bộ chuẩn:

```bash
npm run check
npm run lint
npx tsc --noEmit
npm run test
npm run build
npm run build:staging
npm run deploy:dry-run
npm run deploy:staging:dry-run
npm audit --audit-level=high
```

Read-only staging continuation (không migrate/deploy):

```bash
npm run platform:route-preflight -- --json
npm run platform:doctor -- --env staging --json
npm run db:migrate:status -- --env staging
npm run db:preflight -- --env staging --json
npm run backup:create -- --env staging --dry-run --json
```

`platform:route-preflight` là checkpoint staging-only, read-only: nó cần `CLOUDFLARE_D1_API_TOKEN` để pin Wrangler vào account đã khai báo và đối chiếu live D1 name+UUID, cùng `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN` để gọi đúng một Worker Routes `GET`; token và raw route response không được in hoặc truyền vào child process. D1 token chỉ được map thành `CLOUDFLARE_API_TOKEN` bên trong child Wrangler; runtime Worker secret không bao giờ là operator input. Checkpoint này không thay thế full `platform:doctor`, vốn vẫn cần `CLOUDFLARE_PLATFORM_API_TOKEN`, `CLOUDFLARE_D1_API_TOKEN` và `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN` trước khi chạy backup thật, migration hoặc deploy staging. Source/local chain hiện tới `0090`; retained staging evidence dừng ở `0086`, nên `0087`-`0090` cần fresh candidate admission. Read-only evidence hiện tại xác nhận staging D1 identity và `MEDIA` đang private, nhưng phải kiểm tra lại route inventory, D1 identity và `MEDIA` ngay trước mọi mutation; backup report-v2 của đúng staging D1 cũng phải mới không quá 60 phút. Xem thứ tự mutation có guard tại `docs/RELEASE.md`; không suy diễn deploy/migration đã xảy ra từ dry-run.

Public staging browser gate (Google Chrome required, no real checkout submission):

```bash
npm run test:visual:staging
```

Use `npm run test:visual:staging:update` only after intentionally reviewing a UI change; it replaces the accepted desktop/mobile screenshot baselines. The checkout test mocks cart/quote responses and never presses the order submission button.

Deterministic authenticated local browser gate (Google Chrome required):

```bash
npm run test:browser:auth:local
```

The gate creates disposable local D1/KV state plus a temporary Wrangler config and mode-0600 `.dev.vars` file, applies the current numbered migrations through `0090`, starts Astro in background mode with remote bindings disabled, requests a local-only magic link through the login form, and follows only the visible `mở liên kết đăng nhập` action. Its contract covers the current seller/admin route set at desktop and mobile widths with screenshot, overflow and axe WCAG A/AA checks. It rejects remote origins and alternate Playwright configs, passes only an explicit local child environment, never exports cookies, storage state, hrefs or magic-link tokens, never submits checkout, and never uses staging/production resources. The PromptOS checklist passes 19/19, the authenticated gate passes 7/7, and the public gate passes 27/27 across desktop/mobile, exact 1440/768/390/320px geometry and 200% CSS-viewport checks with runtime, axe, overflow, console and screenshot assertions. Current local evidence contains 42 authenticated and 26 public route/state snapshots at the reviewed 1440x1024 and 390x844 viewports. The active PromptOS matrix defines 19 routes and 82 route-state pairs; the explicit screenshot fixtures cover the reviewed order, cart, checkout, forbidden and provider states, so unlisted matrix variants remain a documented visual follow-up. Current repository checkpoint: 241 Vitest files / 1,713 tests passed. The current 90-migration chain passes isolated SQLite integrity and foreign-key checks. Both are local-only. Staging visual acceptance remains 18/20 because the deployed Worker predates `[data-cart-variant-id]`; production remains NO-GO and neither artifact authorizes staging or production mutation. To intentionally update reviewed baselines after a UI change, run the corresponding local browser gate with `--update-snapshots` and inspect every changed PNG.

## Cách dùng ở task mới

Mở task trong repository này hoặc một repository Selinow mới, sau đó gửi cho Codex:

```text
Đọc đầy đủ bộ prompt kit tại:
/Users/tunbee27/Documents/Selinow.com/00_MASTER_PROMPT.md

Thực hiện dự án đúng theo prompt kit. Nếu repository đã có implementation, hãy đọc docs/IMPLEMENTATION_STATUS.md và tiếp tục phase chưa hoàn tất đầu tiên. Không dừng ở bước lập kế hoạch; hãy kiểm thử và cập nhật tài liệu trạng thái sau mỗi phase.
```

Codex phải đọc `00_MASTER_PROMPT.md` trước. File đó bắt buộc Codex đọc các tài liệu hỗ trợ theo đúng thứ tự trước khi sửa code.

## Bản đồ tài liệu

| File | Vai trò |
| --- | --- |
| `START_NEW_TASK.md` | Prompt ngắn để dán vào task Codex mới |
| `00_MASTER_PROMPT.md` | Prompt điều hành chính cho task Codex mới |
| `01_PRODUCT_SCOPE.md` | Phạm vi sản phẩm, vai trò người dùng, màn hình và gói dịch vụ |
| `02_ARCHITECTURE_AND_DATA.md` | Kiến trúc Cloudflare, module và mô hình dữ liệu multi-tenant |
| `03_AUTOMATION_AND_ONBOARDING.md` | Provisioning nền tảng và onboarding khách hàng gần như tự động |
| `04_TELEGRAM_INTEGRATION.md` | Contract kết nối nhiều Telegram bot, webhook, commerce và bảo mật |
| `05_PAYOS_INTEGRATION.md` | Contract PayOS theo tenant, xác nhận thanh toán và đối soát |
| `06_DOMAINS_AND_CLOUDFLARE.md` | Subdomain, custom hostname, SSL và Cloudflare for SaaS |
| `07_SECURITY_AND_OPERATIONS.md` | Mã hóa credential/key, auth, audit, backup và vận hành |
| `08_DELIVERY_PLAN_AND_ACCEPTANCE.md` | Phase triển khai, test matrix và điều kiện nghiệm thu |
| `09_CONFIGURATION_REFERENCE.md` | Bindings, biến môi trường, secrets, script và endpoint chuẩn |
| `10_AGENTS_TEMPLATE.md` | Nội dung `AGENTS.md` đề xuất cho repository mới |
| `docs/ARCHITECTURE.md` | Kiến trúc runtime, channel ports, capability model, event boundaries và ADR index |
| `docs/IMPLEMENTATION_STATUS.md` | Evidence đã chạy, giới hạn hiện tại và production gate |

## Các quyết định đã chốt

- Đây là sản phẩm độc lập, không phải module của portfolio hiện tại.
- Stack mặc định: Astro 7, TypeScript strict, Cloudflare Workers Paid, D1, R2, KV, Queues và Cloudflare for SaaS.
- Bắt đầu bằng modular monolith; không dùng microservices.
- Một commerce application core dùng chung cho storefront, Telegram và mọi channel adapter tương lai; adapter chỉ verify, normalize, render và deliver.
- Connection registry hỗ trợ nhiều bot/page/account/phone/marketplace connection theo shop; effective capability là giao của adapter support, provider grant, plan, seller setting và health.
- D1 vẫn là source of truth; domain-event outbox và Cloudflare Queues chỉ mang reference để fan-out/retry, không dùng event sourcing.
- Telegram tenant-owned và PayOS credential riêng vẫn là implementation hiện tại; managed channel và provider-neutral payment port là hướng mở rộng đã được chấp nhận.
- Tiền bán hàng mặc định đi trực tiếp về provider/account của seller; platform custody, split payment hoặc payout cần quyết định pháp lý và kiến trúc riêng.
- Tenant được xác định bằng session dashboard, hostname storefront hoặc public integration ID trong webhook.
- D1 dùng schema multi-tenant có `shop_id`; thiết kế sẵn đường sharding nhưng chưa shard trong MVP.
- Subdomain `{slug}.selinow.com` được cấp tự động; custom domain dùng Cloudflare for SaaS và ưu tiên managed DNS authorization trước manual fallback.
- Credential của tenant và key tồn kho được mã hóa ở tầng ứng dụng; không tạo hàng nghìn Worker secrets.
- Mọi webhook, checkout, allocation và delivery đều idempotent, retry-safe và có audit.
- Dashboard/storefront phải dùng semantic design tokens, WCAG AA contrast, keyboard/focus, reduced-motion và visual regression gates; tenant theme không được làm mất khả năng đọc.

## Ranh giới tự động hóa và consent

Mục tiêu sản phẩm là không còn bước cấu hình kỹ thuật sau khi khách hàng cấp consent hoặc xác nhận quyền sở hữu bắt buộc. Khách hàng không chạy CLI, chỉnh Worker, tự dựng webhook URL, cầm infrastructure token hoặc phải hiểu DNS để dùng subdomain mặc định.

Hai mode connection được chấp nhận:

1. `managed`: Selinow sở hữu/vận hành provider resource và tự tạo tenant binding; cần isolation, quota, abuse và policy control chặt chẽ.
2. `bring_your_own`: khách cấp quyền cho resource hiện có, ưu tiên OAuth/one-click authorization; copy credential chỉ là fallback khi provider không hỗ trợ delegated access.

BotFather, merchant onboarding, provider app review hoặc quyền sở hữu DNS có thể vẫn cần thao tác bên ngoài vì provider không cho Selinow làm thay. Sau consent/input hợp lệ, hệ thống phải tự mã hóa, đăng ký webhook, khám phá capability, kiểm tra health, retry/repair và resume onboarding. Custom domain chỉ được gọi là one-click khi DNS connector thực sự tự hoàn tất ownership và routing; manual TXT/CNAME là fallback trung thực.

## Nguồn tham chiếu chính thức

- Astro: https://docs.astro.build
- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Cloudflare D1: https://developers.cloudflare.com/d1/
- Cloudflare for SaaS: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/
- Telegram Bot API: https://core.telegram.org/bots/api
- PayOS: https://payos.vn/docs/
- Meta business messaging: https://developers.facebook.com/documentation/business-messaging/
- Instagram Messaging API: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api
- Zalo Official Account API: https://developers.zalo.me/docs/api/official-account-api-230
- TikTok Shop Partner API: https://partner.tiktokshop.com/docv2
- Shopee Open Platform: https://open.shopee.com/documents

Mọi quota, giá, payload hoặc API của nhà cung cấp có thể thay đổi. Codex phải kiểm tra tài liệu chính thức hiện hành trước khi khóa implementation, nhưng không được tự ý thay đổi các nguyên tắc bảo mật và nghiệp vụ đã chốt trong bộ prompt này.
