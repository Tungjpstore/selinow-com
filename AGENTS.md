# AGENTS.md

## Product boundary

This repository is the independent `selinow.com` SaaS. Do not import portfolio, blog, personal CRM, TungJPStore branding, production database IDs, or secrets from another repository.

## Development

Use Node.js and package versions pinned by the repository. When starting Astro, use background mode:

```bash
npx astro dev --background
npx astro dev status
npx astro dev logs
npx astro dev stop
```

Never point local development at production D1, R2, queues, Telegram bots, PayOS channels, or custom-hostname resources.

## Architecture

- Keep a modular monolith until measured scaling needs justify extraction.
- D1 is authoritative for tenant, catalog, inventory, order, payment, fulfillment, subscription, and audit state.
- KV/cache is never authoritative for stock, payment, credentials, keys, or subscription mutations.
- Every shop-owned query and mutation must preserve `shop_id` tenant isolation.
- Website and Telegram use the same order, payment, inventory, and fulfillment services.

## Secrets and sensitive data

- Never commit or log credentials, bot tokens, webhook secrets, PayOS keys, session secrets, customer tokens, or license-key plaintext.
- Global secrets belong in Cloudflare Worker secrets.
- Tenant credentials and inventory keys belong encrypted in D1 with explicit key versions and AAD.
- Queue, outbox, and audit payloads store references, never license-key plaintext or provider credentials.
- Doctor, test, setup, and deployment scripts must not print secret values.

## Payments and webhooks

- Return URLs and QR rendering never mark an order paid.
- Only a valid signed PayOS event or direct reconciliation with the correct tenant credentials may confirm payment.
- Webhooks, checkout, state transitions, Telegram updates, inventory allocation, and fulfillment must be idempotent and retry-safe.
- Partial, overpaid, late, or mismatched payments never auto-fulfill.

## Database changes

- Use forward-only numbered migrations and never edit one that may have been applied.
- Back up or bookmark the target database before risky production migrations.
- Add tenant-leading indexes for tenant-scoped list and filter paths.
- Include concurrency and tenant-isolation tests for inventory, order, and payment changes.

## Verification

Before reporting completion, normally run:

```bash
npm run check
npm run lint
npm run test
npm run build
npm run deploy:dry-run
```

Update `docs/IMPLEMENTATION_STATUS.md` with artifacts, verification, external requirements, and known limitations.
