# AGENTS.md Template for Selinow

Codex phải tạo `AGENTS.md` ở root repository mới với nội dung tương đương dưới đây và cập nhật nếu project scripts thay đổi.

Current repository continuation note: the same rules apply to Telegram Bot, Telegram Mini App, Zalo Mini App/OA, WhatsApp Cloud and Discord Bot plus Dodo platform billing. Keep each provider's proof, credential lineage, identity, receipt and outbound boundary separate; never treat a connector request or provider-pending state as activation. The current source migration chain ends at `0076`, while remote environment ledgers must be verified independently before mutation.

````markdown
# AGENTS.md

## Product boundary

This repository is the independent `selinow.com` SaaS. Do not import portfolio, blog, personal CRM, TungJPStore branding, production database IDs, or secrets from another repository.

## Development

Use Node.js and package versions pinned by the repository.

When starting the Astro development server, always use background mode:

```bash
npx astro dev --background
```

Manage it with:

```bash
npx astro dev status
npx astro dev logs
npx astro dev stop
```

Never point local development at production D1, R2, queues, Telegram bots, PayOS channels, or custom-hostname resources.

## Required reading

Before changing a related area, read its project documentation under `docs/` and consult current official docs:

- Astro routing/components/styling: https://docs.astro.build
- Cloudflare Workers/D1/R2/KV/Queues: https://developers.cloudflare.com
- Cloudflare for SaaS: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/
- Telegram Bot API: https://core.telegram.org/bots/api
- PayOS: https://payos.vn/docs/

## Architecture

- Keep the application a modular monolith until measured scaling needs justify extraction.
- D1 is authoritative for tenant, catalog, inventory, order, payment, fulfillment, subscription, and audit state.
- KV/cache is never authoritative for stock, payment, credentials, keys, or subscription mutations.
- Every shop-owned query and mutation must preserve `shop_id` tenant isolation.
- Website and Telegram must use the same order/payment/inventory/fulfillment services.

## Secrets and sensitive data

- Never commit or log credentials, bot tokens, webhook secrets, PayOS keys, session secrets, customer tokens, or license-key plaintext.
- Global secrets belong in Cloudflare Worker secrets.
- Tenant credentials and inventory keys belong encrypted in D1 with explicit key versions and AAD.
- Queue/outbox/audit payloads store references, never license-key plaintext or provider credentials.
- Do not print secret values from setup, doctor, test, or deployment scripts.

## Payments and webhooks

- Return URLs and QR rendering never mark an order paid.
- Only a valid signed PayOS event or direct reconciliation with the correct tenant credentials may confirm payment.
- Webhooks, checkout, payment transitions, Telegram updates, inventory allocation, and fulfillment must be idempotent and retry-safe.
- Partial, overpaid, late, or mismatched payments require exception handling and must not auto-fulfill.

## Database changes

- Use forward-only numbered migrations.
- Do not edit a migration after it may have been applied.
- Back up/bookmark the target database before risky production migrations.
- Add indexes for tenant-scoped list/filter paths.
- Include concurrency and tenant-isolation tests for inventory/order/payment changes.

## Verification

Before reporting completion, run the relevant subset and normally all of:

```bash
npm run check
npm run lint
npm run test
npm run build
npm run deploy:dry-run
```

Update `docs/IMPLEMENTATION_STATUS.md` with completed artifacts, verification, remaining external credentials/permissions, and known limitations.
````

## Additional repository docs to create

Task triển khai nên tạo và duy trì:

- `docs/IMPLEMENTATION_STATUS.md`
- `docs/ARCHITECTURE.md`
- `docs/DATA_MODEL.md`
- `docs/ONBOARDING.md`
- `docs/TELEGRAM.md`
- `docs/PAYOS.md`
- `docs/DOMAINS.md`
- `docs/SECURITY.md`
- `docs/RUNBOOKS.md`
- `docs/RELEASE.md`
- `docs/adr/`

Không để prompt kit là tài liệu duy nhất sau khi code bắt đầu. Codex phải chuyển các contract liên quan vào documentation của repository mới và cập nhật cùng implementation.
