# Marketing Redesign Context Plan — Commerce Flow OS (Rebuild v5)

## 0. Why this rebuild

The 2026-08-16 "Landing V4 Aurora" attempt (dark cinematic hero, canvas aurora,
self-hosted webfonts, `motion` dependency, geo-detect locale) was rejected by the
owner and fully removed (tracked files restored to the v3 commit, untracked v4
artifacts deleted; tarball backup at `/tmp/landing-v4-teardown-backup.tar.gz`
plus `/tmp/landing-v4-working-tree.diff`). This document plans the clean rebuild
against the original master prompt: **Selinow — Commerce Flow OS** — light, calm,
operational, commerce-first.

## 1. Repository baseline (verified 2026-08-16)

- Astro 7.1.3 + TypeScript strict + @astrojs/cloudflare 14.1.4; npm pinned.
- Verification: `npm run check`, `npm run lint`, `npm run test`, `npm run build`,
  `npm run deploy:dry-run`; dev server on `http://localhost:4330` via `.dev.vars`
  origins (4321/4322 are occupied by unrelated projects).
- Baseline after teardown: marketing unit contracts 25/25 green;
  `astro check` has 8 pre-existing `AppLayout.astro` errors owned by the parallel
  dashboard stream (present at HEAD, out of marketing scope).
- CSS: `src/styles/marketing/{tokens,shell,components,pages,landing}.css`
  imported by `PlatformLayout.astro`; global tokens (`selinow-tokens.css`,
  `base.css`, `primitives.css`, `platform.css`) are shared with other surfaces.
- `src/styles/marketing/tokens.css` already matches the prompt's Selinow Indigo
  palette (`--brand-50..900`, surfaces, radii, shadows) — keep and extend rather
  than replace.

## 2. Route inventory and host contracts (preserved exactly)

- `/` — host-aware: marketing host → marketing landing; `www` → 308 platform
  origin; dashboard host → 308 `/app`; tenant host → storefront (or 404). Never
  simplify to "always marketing".
- `/pricing` — marketing host only, else 404 + no-store; runtime D1 plans with
  the local `dashboardOrigin` port-preserving IIFE (pinned by tests).
- `/solutions`, `/solutions/[slug]` — 3 canonical slugs from
  `src/lib/content/solutions.ts`; per-slug SEO/FAQ/breadcrumb JSON-LD.
- `/legal`, `/privacy`, `/support` — publication-gated truthfulness surfaces
  (blocked-pending-owner-approval copy is contractual; never invent content).
- `/login` — canonical dashboard origin only (308 otherwise), password + 2FA,
  noindex/no-store; auth semantics and every `data-*` hook must survive a restyle.

## 3. Runtime data authorities

- Plans/limits/prices: `src/lib/storefront/marketing.ts` (`getMarketingPlans`,
  `isMarketingPricingReady`, `formatMarketingPrice`, `planFeatureList`, market
  helpers). Plan count is runtime (currently starter+pro public); render N plans
  generically; prices render only when D1 publishes non-pending Dodo offers,
  otherwise the intentional unavailable state (never fake prices).
- Solutions copy: `src/lib/content/solutions.ts` (bilingual; 4-step workflows,
  3-item FAQs — depth pinned by `solutions-seo.test.ts`).
- i18n: `src/lib/i18n/catalogs/marketing.ts` (en + vi-VN parity enforced);
  every new visible string gets a catalog key; locale via middleware
  (`?lang=` → cookie → Accept-Language); no geo detection.

## 4. Test contracts that pin implementation details

- `marketing-surface-contracts.test.ts`: exact `mt(...)`/`t(...)` call sites in
  index/pricing (`flow.payment`, `flow.payment_detail`, `flow.delivery_detail`,
  `data-pricing-state={pricingState}`, `group.*` keys, `capability.no`/
  `capability.unpublished`, dashboardOrigin IIFE lines, `plan.prices`,
  `data-market`, market-root/offer attributes), header mobile-menu hooks, login
  form markers, banned phrases (no "omnichannel", "AI agent",
  "workflow automation", …), channel `state: "live"` / `state: "next"` rows with
  `<small>{channel[1]}</small>`, `mt("marketing.home.channels.status.next")`.
- `marketing-assets-contract.test.ts`: v3 kit SVGs must ship; landing kit-art
  references updated intentionally (design moves to HTML/CSS diagrams;
  `core-hub.svg` stays as the architecture core glyph); channel names stay in
  catalog + HTML.
- `legal-placeholder-surfaces.test.ts`: `/legal` `/privacy` `/support` linked
  from the landing footer surface; blocked + owner-approval wording stays.
- `i18n-call-site-contract.test.ts` + catalog parity: literal keys must exist in
  both locales; no new unallowlisted dynamic translator keys.
- SEO suite: canonical/hreflang/x-default wiring in `PlatformLayout` +
  `lib/seo.ts` (untouched); sitemap/robots/llms content contracts (untouched).

## 5. Design strategy (Commerce Flow OS, light edition)

- **Feeling**: premium, calm, operational, precise — light surfaces, Selinow
  indigo accents, thin 1px borders, restrained shadows; no dark hero, no canvas
  particles, no marquee, no bento-everywhere, no card wall.
- **Visual grammar**: flow rails, status nodes, timelines, structured rows,
  editor-like panels. Diagrams are HTML/CSS with small inline SVG icons
  (stroke 1.6–1.8, 16–22px) — locale-neutral, sharp at all DPRs.
- **Hero**: 54/46 split — copy left (eyebrow, H1 ≤56px, lead, CTA pair, 3
  factual proof chips); right an editor-like *transaction simulation*: channel
  message → order core (`#SLN-2084` created → payment verified → entitlement
  allocated → delivered) with semantic status chips, masked key material, and an
  "illustrative workflow" caption. Static states + one subtle connector
  animation; fully static under reduced motion; no JS required.
- **Homepage**: hero → commerce flow rail (channel→order→payment→fulfillment→
  customer; horizontal desktop, vertical mobile) → why Selinow (4 outcomes,
  mixed text/diagram, not icon cards) → one commerce core diagram (Website
  live, Telegram next; core services between) → solutions preview (3 tiles,
  each a distinct mini rail) → payment ownership (provider settles funds; no
  escrow claims) → runtime pricing preview → FAQ (`details/summary` + matching
  JSON-LD) → quiet final CTA → footer.
- **Pricing**: runtime grid (N-plan safe), unavailable state, market switcher
  preserved, desktop comparison table + mobile grouped view from the same
  runtime data (no page-level horizontal scroll).
- **Solutions**: hub = editorial numbered rows; detail = breadcrumb nav,
  hero + per-solution workflow visual (telegram chat rail / delivery lifecycle
  states / masked license inventory), proof list, workflow timeline, FAQ,
  related links.
- **Publication gates**: same blocked-pending-approval truth restyled into the
  new system (status panel + itemized blocked scopes + governance note).
- **Login**: same split form/2FA markup and hooks; restyled to the new tokens;
  right panel becomes the refined commerce-flow illustration.
- **Motion**: small and purposeful (fade/translate 4–8px, 160–260ms; one
  connector pulse); everything respects `prefers-reduced-motion`; content never
  depends on animation; no libraries.
- **Typography**: existing system stack (Inter/Be Vietnam Pro when installed,
  deterministic system fallback); deliberate ramp, tight display tracking,
  55–72ch prose.

## 6. Files expected to change

- Rewrite: `src/pages/index.astro`, `pricing.astro`, `solutions/index.astro`,
  `solutions/[slug].astro`, `legal.astro`, `privacy.astro`, `support.astro`,
  `login.astro` (markup/styles only), `MarketingHeader/Footer`,
  `ProductFlowIllustration`, `SolutionWorkflowCard`, `PublicationGate`.
- New marketing components: `HeroFlowSim.astro`, rebuilt `CommerceFlowRail`,
  `SolutionHeroVisual.astro` (per-slug), shared inline icon helpers.
- Delete (superseded v3-only): `HeroCommerceFlow.astro`,
  `scripts/landing/hero-canvas.ts`.
- Styles: rewrite `landing.css` sections, extend `components.css`/`pages.css`;
  keep `tokens.css`/`shell.css` as the base.
- Catalog: remove keys that lose their surfaces, add new section keys
  (en + vi-VN parity).
- Tests updated intentionally: `marketing-assets-contract.test.ts` (kit refs),
  `legal-placeholder-surfaces.test.ts` (footer link source moves to
  `MarketingFooter.astro`); `marketing-surface-contracts.test.ts` only if a
  pinned call site legitimately moves (avoid where possible).

## 7. Risk areas

- Host-routing regressions on `/` (storefront/dashboard modes) — keep the
  frontmatter branching byte-identical where possible.
- Pricing runtime states (ready/unavailable/local preview) must all render;
  never hardcode plan count or amounts.
- Test-pinned call sites and data attributes (see §4) — check before renaming.
- Shared CSS tokens are also consumed by storefront/error surfaces — scope new
  rules to marketing classes.
- Vietnamese string lengths (buttons, nav) — verify at 320/390px in both
  locales.

## 8. Testing strategy

- `npm run check` + `npm run lint` after each major surface (my files: 0 new
  errors; the 8 AppLayout errors belong to the parallel stream).
- Full `npm run test` before build; every failing contract triaged as
  redesign-caused (fix product code) or intentionally-updated (documented here).
- `npm run build` + `npm run deploy:dry-run`.
- Browser: dev server on :4330; screenshot matrix 1440/768/390/320 × en/vi for
  `/`, `/pricing`, `/solutions`, one detail page, gates, login via
  `scripts/landing-visual-check.mjs` (targets extended); programmatic overflow
  assertion; keyboard pass (menu, FAQ, pricing switcher, login form).
