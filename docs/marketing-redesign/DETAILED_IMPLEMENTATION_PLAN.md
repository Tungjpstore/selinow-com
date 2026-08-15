# Selinow Marketing Redesign — Detailed Implementation Plan (Phase 0-8)

**Scope**: Marketing/public surfaces only (/ , /pricing, /solutions, /solutions/*, legal/privacy/support, dashboard-origin/login).  
**Target**: Commerce Flow OS — rails, timelines, illustrative flows, indigo-led, calm precision, semantic HTML.  
**Framework**: Astro 7 + TS + Cloudflare adapter.  
**Runtime truth**: All data (plans, channels, locale) from lib/storefront/marketing.ts and i18n catalogs.  
**Non-negotiables**: No fake content, no secrets, no overclaims, 320px min, WCAG 2.2 AA, no overflow, reduced-motion safe.

## Phase 0: Foundation & Inventory (today)
- [ ] Document this plan.
- [ ] Run baseline: `npm run check`, `npm run lint`, `npm run test:visual` (capture BEFORE screenshots).
- [ ] Inventory all selectors/data attributes in tests and scripts.
- [ ] Identify platform.css selectors shared with storefront (to avoid breakage).

**Artifacts**: 
- docs/marketing-redesign/DETAILED_IMPLEMENTATION_PLAN.md
- docs/marketing-redesign/BEFORE_VISUAL_SNAPSHOT.md (screenshots)
- docs/marketing-redesign/SELECTOR_INVENTORY.md

**Status**: Pending

## Phase 1: Marketing Tokens & Shell (next)
- Create `src/styles/marketing/tokens.css` from prompt specs (mk-* vars, no global --sln redefinition).
- Create `src/styles/marketing/shell.css` (grid, typography, responsive, shadows).
- Refactor `src/layouts/PlatformLayout.astro` to use marketing tokens (keep public surfaces only).
- Update `src/components/marketing/MarketingHeader.astro` (compact nav, locale switcher, indigo CTA, mobile disclosure).
- Add `src/components/marketing/MarketingFooter.astro` (links, status-aware legal, copyright).

**Artifacts**: 
- src/styles/marketing/tokens.css
- src/styles/marketing/shell.css
- Updated PlatformLayout.astro, MarketingHeader.astro, MarketingFooter.astro (new)

**Status**: Pending

## Phase 2: Homepage (index.astro)
- Rebuild with Commerce Flow Rail (5 stages: channel → order → payment → fulfillment → status).
- HeroCommerceFlow.astro (HTML/CSS transaction sequence, labelled illustrative, reduced-motion).
- SolutionWorkflowCard.astro for 3 use cases.
- Why Selinow (4 high-signal rows).
- Runtime pricing preview + FAQ.
- Preserve tenant storefront branch and host redirects.

**Artifacts**:
- src/pages/index.astro (full rebuild)
- New components: HeroCommerceFlow.astro, CommerceFlowRail.astro, SolutionWorkflowCard.astro

**Status**: Pending

## Phase 3: Pricing
- PricingPlanCard.astro + PricingComparison.astro (adaptive to runtime plan count 1-4).
- Market selector, unavailable state, capability comparison.
- Mobile stacked groups, no x-scroll.

**Artifacts**:
- Updated pricing.astro
- New: PricingPlanCard.astro, PricingComparison.astro

**Status**: Pending

## Phase 4: Solutions Hub & Details
- Rebuild solutions/index.astro + solutions/[slug].astro (3 distinct workflow visuals).
- Shared core diagram.
- Breadcrumb + FAQ structured data preserved.

**Artifacts**:
- Updated solutions/index.astro
- Updated solutions/[slug].astro
- New: SolutionWorkflowCard.astro (reuse)

**Status**: Pending

## Phase 5: Publication-Gated Pages
- legal.astro, privacy.astro, support.astro → use PublicationGate.astro + future EditorialPolicyShell.astro (no invented content).

**Artifacts**:
- Updated legal.astro, privacy.astro, support.astro
- New: PublicationGate.astro, EditorialPolicyShell.astro

**Status**: Pending

## Phase 6: Login Restyle
- Preserve all auth logic (magic-link, Turnstile, data-login-*).
- Desktop split: auth panel + ProductFlowIllustration.astro.
- Mobile: single-column auth.

**Artifacts**:
- Updated login.astro
- New: ProductFlowIllustration.astro

**Status**: Pending

## Phase 7: Tests & QA
- Extend Playwright tests for all routes (1440px, 390px, 320px overflow, Axe, keyboard, reduced-motion).
- Run: `npm run check`, `npm run lint`, `npm run test:visual`, `npm run build`.
- Capture visual snapshots and compare to target reference (composition, not literal content).

**Artifacts**:
- Updated playwright.config.ts + visual tests
- docs/marketing-redesign/IMPLEMENTATION_REPORT.md
- docs/marketing-redesign/GAP_REPORT.md

**Status**: Pending

## Phase 8: Final Polish & Report
- Remove dead old marketing CSS from platform.css.
- Validate SEO (canonical, hreflang, JSON-LD).
- Produce full report with screenshots, test results, known gaps.

**Final output**:
- All routes share one design language.
- Runtime/SEO/auth behavior unchanged.
- Tests pass.
- Cleaner than previous architecture.

**Known risks & blockers**:
- Runtime pricing data availability (document unavailable state).
- Legal/privacy/support content gaps (use PublicationGate only).
- CSS specificity conflicts (use marketing namespace).

**Verification commands** (run before each phase transition):
```bash
npm run check
npm run lint
npm run test:visual
npm run build
```

**Next**: Reply **"phase1"** to start Phase 1 (tokens + shell + header/footer). I will output full code blocks and use apply_patch to implement.

**Ready for Phase 1 execution.**
