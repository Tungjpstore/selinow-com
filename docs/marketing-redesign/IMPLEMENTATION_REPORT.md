# Selinow Marketing Redesign — Commerce Flow OS (v5 rebuild)

Date: 2026-08-16/17 · Branch: `dashboard-redesign-takeover`

## Summary

Full teardown of the rejected "Landing V4 Aurora" attempt (dark cinematic, canvas
aurora, `motion` dependency, geo locale detection — restored to the v3 commit,
untracked artifacts deleted; backup tarball + diff kept in `/tmp`), followed by a
clean rebuild of every public marketing surface per the original master prompt:
**Selinow — Commerce Flow OS**, light / calm / operational / indigo. A second
visual pass (v5.1) applied owner feedback: denser rhythm, hairline section
separation, layered card-vs-canvas surfaces, dot-grid + gradient-hairline
detailing, a stronger layered hero scene, and more professional card interiors —
all still light-themed, JS-free, and reduced-motion safe.

## Routes redesigned

| Route | What changed |
| --- | --- |
| `/` (marketing host) | New hero (54/46 split, 60px display type, eyebrow pill, proof chips, layered transaction simulation with ghost card + 3 floating status chips), factual hero status strip, commerce flow rail (5 connected node cards), why-section (4 accent cards), one-core diagram (dot-grid panel, dashed halo hub, live/next channel truth), solutions preview (3 tiles with per-solution mini rails), payment-ownership facts (numbered panel), runtime pricing preview, FAQ panel, raised final-CTA card. Host routing (marketing/storefront/404), storefront mode, and structured data untouched. |
| `/pricing` | Breadcrumb, dot-grid hero, unavailable/preview/ready runtime states, market switcher preserved, plan cards with gradient top line + recommended treatment, desktop comparison table + new mobile grouped ledger (no horizontal scroll), FAQ panel. All pricing runtime contracts byte-preserved. |
| `/solutions` | Breadcrumb, hero with answer signal, three solution tiles with distinct rails, core CTA band. |
| `/solutions/telegram-commerce` · `/digital-product-delivery` · `/license-key-inventory` | Semantic breadcrumb nav, hero + per-slug `SolutionHeroVisual` (Telegram chat flow / delivery lifecycle ledger / masked license pool), proof checklist panel, timeline workflow cards, FAQ, related links. Unique SEO titles/descriptions per slug preserved. |
| `/legal` `/privacy` `/support` | Publication gates restyled into the new system (status tag, itemized blocked scopes, governance aside, actions). Blocked-pending-owner-approval copy preserved verbatim — no invented content. |
| `/login` | Restyled split auth (42/58): refreshed card, inputs, button, status tones; right panel is the new commerce-flow illustration (SVG icons, status chips, masked key). All form markup, IDs, `data-*` hooks, 2FA panel, redirect/noindex/no-store semantics untouched. |

## Design-system changes

- Tokens (`tokens.css`): kept the Selinow Indigo palette; added marketing canvas
  tokens (`--mk-canvas: #F7F8FB`, `--mk-canvas-deep`), hairline atoms
  (`--mk-hairline`, `--mk-hairline-soft`, `--mk-dot`, `--mk-rule-gradient`), and
  layered card shadows (`--mk-card-shadow[-hover]`, `--mk-panel-shadow`).
- Shell (`shell.css`): denser section rhythm, larger balanced headings, section
  headers now carry a hairline rule + gradient accent.
- Landing (`landing.css`): rewritten twice (v5 → v5.1 feedback pass) — layered
  hero canvas with masked dot grid, floating chips, ghost card, dash-connector
  rails, accent cards, unified core-diagram panel, structured tile interiors,
  numbered fact panels, raised final CTA.
- Components (`components.css`): glassy sticky header, FAQ as one bordered panel
  with hairline rows, footer on deeper canvas with column hairlines; dead
  announcement-bar / dark final-cta blocks removed.
- Pages (`pages.css`): pricing/solutions brought onto the same surface system
  (dot-grid heroes, gradient top lines, card timelines, mobile ledger).

## Components added / refactored / removed

- Added: `icons.ts` (text-free stroke SVG glyph kit), `HeroFlowSim.astro`,
  `SolutionHeroVisual.astro`, `solutionRails.ts` (shared per-solution rails).
- Refactored: `MarketingHeader` (Product/Solutions/Pricing/Support nav; contract
  markers kept), `MarketingFooter` (single source, new groups incl. Company),
  `CommerceFlowRail` (rail cards), `SolutionWorkflowCard` (tiles + rails, CTA
  moved to catalog), `PublicationGate`, `ProductFlowIllustration`.
- Removed: `HeroCommerceFlow.astro`, `SolutionDiagram.astro` (emoji diagrams),
  `PricingPlanCard.astro` (orphaned), `scripts/landing/hero-canvas.ts`.

## Runtime contracts preserved

- `/` host branching (www 308, dashboard 308, tenant storefront, 404) unchanged.
- Pricing: D1 `getMarketingPlans` / preview plans, market completeness rules,
  `dashboardOrigin` local-port IIFE, structured offers only when ready; zero
  hardcoded plan counts or amounts.
- Locale: middleware `?lang=` → cookie → Accept-Language; catalog parity en/vi
  (i18n call-site contract green); no geo detection (removed with v4).
- SEO: canonical → `selinow.com`, reciprocal hreflang + x-default, per-slug
  titles, Organization/WebSite/SoftwareApplication/FAQPage/Breadcrumb/ItemList
  JSON-LD, OG/Twitter untouched; login stays noindex/no-store with 308 to the
  canonical dashboard origin.

## Validation performed

- `npm run check`: 0 errors in marketing files (8 pre-existing `AppLayout.astro`
  errors belong to the parallel dashboard stream and exist at HEAD).
- `npm run lint`: clean (added scoped node/browser globals for dev-time scripts).
- `npm run test`: **335 files / 2630 tests pass**, including the intentionally
  updated `marketing-assets-contract` (kit refs → `core-hub.svg` only; kit still
  ships complete) and `legal-placeholder-surfaces` (footer source →
  `MarketingFooter.astro`).
- `npm run build` + `npm run deploy:dry-run`: pass.
- `scripts/landing-visual-check.mjs` (extended to 12 targets × 4 viewports):
  **48 captures, no horizontal overflow, no console errors** at 1440/768/390/320
  in EN and VI; screenshots in `test-results/landing-v4/`.
- In-browser checks (IAB): mobile menu opens via keyboard and closes on Escape;
  pricing market switcher + disabled states; comparison swaps table→grouped
  ledger at ≤768px with no overflow; FAQ toggles; authenticated `/login`
  correctly redirects to `/app`; hero strip/chips/ghost verified live.

## Known limitations / non-blockers

- Pricing shows the truthful "temporarily unavailable" state locally until Dodo
  price refs are published in D1 (preview capabilities render instead).
- Legal/privacy/support gate copy remains English-only (published content is
  owner-gated; no translations invented).
- Floating hero chips and dash connectors are decorative (aria-hidden); the
  panel itself carries the accessible description.
- OG cover image remains the v3 global PNG (locale-neutral, valid).

## Files changed

See `git show --stat` for the redesign commit. Excluded intentionally:
`.zcode/`, `docs/storefront-templates/DETAIL_UPGRADE_PLAN_2026-08-16.md`
(parallel stream artifacts).
