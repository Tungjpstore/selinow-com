# Selinow Frontend Agent Operating System

## Mission

Rebuild and evolve Selinow frontend as a calm, capable, trustworthy commerce control system while preserving the current product, security, tenant, payment, and fulfillment contracts.

## Mandatory start sequence

For every task:

1. Read `PROMPT_OS_MANIFEST.yaml`.
2. Read `00_START_HERE/NON_NEGOTIABLES.md`.
3. Read `01_SOURCE_OF_TRUTH/SOURCE_PRECEDENCE.md`.
4. Classify the task by surface and capability.
5. Activate the smallest sufficient skills under `11_AGENT_SKILLS/`.
6. Read the corresponding screen specs and component contracts.
7. Inspect the current repository before proposing or editing code.
8. Produce a concise Context Plan.
9. Implement only the requested scope.
10. Run the required validation and visual checks.

## Product surfaces

Do not mix these contexts:

- Marketing platform: `selinow.com`
- Seller workspace: `app.selinow.com`
- Tenant storefront: `{slug}.selinow.com` or custom domain
- Platform operations: protected admin routes

Each surface has its own navigation, session assumptions, tenant resolution, visual density, and risk model.

## Technical invariants

- Astro 7, TypeScript strict, Cloudflare adapter.
- SSR/static-first.
- Public catalog content must render without JavaScript.
- Use Astro components + TypeScript DOM modules by default.
- D1 remains business source of truth.
- Storefront tenant authority comes from hostname, never a client-supplied `shop_id`.
- Dashboard mutations retain session, CSRF, role, plan, and tenant guards.
- Price, stock, payment, fulfillment, and readiness are server-confirmed.
- Sensitive pages are `noindex` and `no-store` according to project contracts.
- Never expose Telegram tokens, PayOS credentials, order access tokens, or plaintext inventory keys.
- Payment and fulfillment are separate states everywhere.
- Mutations must be idempotent when retried.

## Visual invariants

- Brand name: Selinow.
- Core promise: Turn conversations into sales.
- Telegram-first, not Telegram-only.
- Light-first for marketing, workspace, and storefront.
- Dark surface reserved for admin/risk and selective inverse sections.
- Primary action color is indigo, not green.
- Green is semantic success only.
- Use official tokens exactly.
- Use 8px layout rhythm with 4px micro-spacing.
- Avoid card walls, excessive gradients, glassmorphism, glow, and robot mascots.
- Prefer rails, rows, ledgers, timelines, and clear status systems.

## Completion report

Every completion must state:

- context and skills loaded;
- files changed;
- contracts preserved;
- visual decisions;
- validation commands and results;
- screenshots produced;
- known gaps or assumptions.
