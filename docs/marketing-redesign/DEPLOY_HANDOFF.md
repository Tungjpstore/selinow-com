# Marketing v5 "Commerce Flow OS" — Deploy Handoff

Date: 2026-08-17 · Branch: `dashboard-redesign-takeover` · Scope: **public marketing frontend only**

## 1. What is being deployed

Two commits, frontend-only, zero backend/data changes:

| Commit | Content |
| --- | --- |
| `c67fb2e` | Full marketing rebuild (v5) + owner visual-feedback pass (v5.1): landing, pricing, solutions hub + 3 SEO pages, publication gates, login restyle, marketing tokens/CSS system, marketing i18n catalog rewrite (en/vi parity), dead v3 components removed. |
| `6a5fce7` | v5.2: pricing split hero + "every plan" core panel + CTA band, solutions eyebrow pills + shared-core strip + detail CTA bands, gates hero bands, keyword-grounded SEO titles/descriptions/H1s (VN-first + EN), Organization JSON-LD `knowsLanguage`/`areaServed`, sitemap adds `/legal` `/privacy` `/support` + `lastmod`, llms.txt enrichment. |

Routes touched (rendering only — no route added/removed):
`/` (marketing host), `/pricing`, `/solutions`, `/solutions/{telegram-commerce,digital-product-delivery,license-key-inventory}`, `/legal`, `/privacy`, `/support`, `/login` (dashboard host, styles only).

## 2. CRITICAL pre-deploy checks

1. **Build from a clean checkout of `6a5fce7`, not the live working tree.**
   The current working tree on this machine contains a *parallel backend stream's
   uncommitted WIP* (`src/worker.ts`, `src/lib/payments/remediation.ts`,
   `src/lib/commerce/payment-reversal.ts`, `src/lib/domains/*`,
   `migrations/0104_remediation_completion.sql`, …). `astro build` compiles the
   working tree, so deploying from this machine as-is would ship unfinished,
   partially failing backend code (373 unit tests currently fail from that WIP).
   → Use CI, `git archive`, or `git worktree` at `6a5fce7`, or wait until the
   parallel stream commits and the full suite is green again.
2. No new environment variables, no new secrets, **no dependency changes**
   (`package.json`/lock untouched by these commits), **no migrations** (release
   guard checklist: invariant registry / table allow-list / CSV inventory /
   chain-tip tests are unaffected — nothing to update; migration `0104` in the
   working tree belongs to the parallel stream and is NOT part of these commits).
3. Tenant storefront, dashboard `/app`, admin, and all API/webhook surfaces are
   untouched; host-routing (`www` 308, dashboard→`/app`, tenant storefront) and
   middleware locale resolution behave exactly as at `6e40571`.

## 3. Expected runtime behavior after deploy (do not file as bugs)

- **`/pricing` shows "Pricing is temporarily unavailable." + capability preview
  cards ("Price not published")** until D1 `plan_prices` has non-pending Dodo
  refs for a complete market. This is the fail-closed contract, not an outage.
  Market switch buttons render disabled in that state (correct).
- Marketing pages carry `Vary: Accept-Language, Cookie`; gates/sitemap/robots/
  llms keep `Cache-Control: public, max-age=300`. No CDN purge is required
  beyond the platform's normal rollout; sitemap/llms refresh within 5 min.
- `/login` remains `noindex, nofollow, no-store` and 308-redirects non-dashboard
  origins to `DASHBOARD_ORIGIN`.
- Locale: `?lang=vi-VN` sets the preference cookie; hreflang alternates +
  `x-default` emitted on all indexable marketing pages.

## 4. Post-deploy verification checklist (production URLs)

SEO (curl the live origin):

- `curl -s https://selinow.com/ | grep "<title>"` →
  `Selinow — Sell Digital Products on Website & Telegram`
- `?lang=vi-VN` title → `Selinow — Nền tảng bán sản phẩm số trên Website & Telegram`
- `/pricing` title → `Selinow Pricing — Digital Product Plans for Website & Telegram`
- `/solutions/telegram-commerce` → `Telegram commerce: sell digital products in chat | Selinow`
- `/solutions/digital-product-delivery` → `Automatic digital product delivery after checkout | Selinow`
- `/solutions/license-key-inventory` → `License key management & secure key inventory | Selinow`
- `/` contains `"areaServed":[{"@type":"Country","name":"Vietnam"},...Worldwide...]` and
  reciprocal `hreflang="en" / "vi-VN" / "x-default"` links.
- `curl -s https://selinow.com/sitemap.xml` → includes `/legal`, `/privacy`,
  `/support` and `<lastmod>` on every entry.
- `/login` response headers → `x-robots-tag: noindex, nofollow`,
  `cache-control: private, no-store`.

Functional smoke (browser, desktop 1440 + mobile 390):

- Landing renders hero split + transaction simulation panel with floating
  status chips; no horizontal scroll; mobile menu opens/closes (Escape works).
- `/pricing` renders split hero + core panel; at ≤768px the comparison becomes
  grouped rows (no page-level horizontal scroll); market switcher toggles
  offers when a market is published.
- Solution detail pages show breadcrumbs, per-slug hero visual (chat flow /
  delivery ledger / masked license pool `XXXXX-XXXXX-••••-•••••`), timeline.
- `/legal` `/privacy` `/support` show the blocked-pending-owner-approval copy.
- EN ⇄ VI switcher flips copy and URL (`?lang=vi-VN`) on every page.

## 5. Rollback

- No data rollback needed. Revert the two frontend commits and redeploy:
  `git revert 6a5fce7 c67fb2e` → rebuild → deploy (or redeploy the previous
  worker upload through the existing release pipeline).
- Both commits are additive to marketing surfaces only; reverting restores the
  previous v3 marketing frontend byte-for-byte (they were written against `6e40571`).

## 6. Verification already performed (pre-deploy, at `6a5fce7`)

`npm run check` (0 marketing errors — 8 pre-existing `AppLayout.astro` errors
belong to the parallel dashboard WIP at HEAD) · `npm run lint` clean for all
marketing files · marketing/SEO suites **47/47** (incl. intentionally updated
`marketing-assets-contract`, `legal-placeholder-surfaces`) · full suite green at
`c67fb2e` (2630/2630) — the later 373 failures came from the parallel stream's
uncommitted work, verified file-by-file · `npm run build` + `npm run
deploy:dry-run` pass · `scripts/landing-visual-check.mjs`: 12 targets ×
{1440,768,390,320} × {en,vi} = 48 captures, zero horizontal overflow, zero
console errors · in-browser keyboard (menu/Escape, FAQ, market switcher) and
header contracts (canonical/hreflang/noindex) verified.

Full change detail: `docs/marketing-redesign/IMPLEMENTATION_REPORT.md`.
