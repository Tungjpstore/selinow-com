# Marketing Redesign Context Plan — Commerce Flow OS

## 1. Repository Baseline
- Framework: Astro 7.1.3 + TypeScript + Cloudflare adapter (@astrojs/cloudflare 14.1.4)
- Package Manager: npm (pinned)
- Verification scripts: `npm run check`, `npm run lint`, `npm run test:unit`, `npm run test:browser:public:local`, `npm run build`
- Styling architecture: CSS custom properties (`src/styles/marketing/tokens.css`, `shell.css`, `components.css`, `pages.css`), modular scoped styles, system typography stack for English & Vietnamese diacritics.

## 2. Host and Route Inventory
- Marketing Host:
  - `/` -> Marketing homepage (Commerce Flow OS)
  - `/pricing` -> Dynamic runtime pricing and comparison
  - `/solutions` -> Solutions Hub (Telegram Commerce, Digital Delivery, License Key Inventory)
  - `/solutions/telegram-commerce` -> Telegram commerce deep-dive
  - `/solutions/digital-product-delivery` -> Digital product delivery deep-dive
  - `/solutions/license-key-inventory` -> License key inventory deep-dive
  - `/legal` -> Publication-gated legal status shell
  - `/privacy` -> Publication-gated privacy status shell
  - `/support` -> Publication-gated support status shell
- Storefront Host:
  - `/` with `hostKind === "tenant-candidate"` -> Storefront product catalog / status (Strictly preserved)
- Dashboard Host:
  - `/login` -> Password / OTP / email login with split-screen commerce flow visual on desktop, single-column on mobile.
  - `/app` -> Authenticated seller workspace (Out of scope)

## 3. Runtime Data Authorities
- Plans & Limits: `getMarketingPlans(env)` & `getMarketingPreviewPlans()` in `src/lib/storefront/marketing.ts`
- Channels & Features: `src/lib/storefront/marketing.ts`, `src/lib/content/solutions.ts`
- Localization: `src/lib/i18n/catalogs/marketing.ts`, `src/lib/i18n/catalogs/system.ts`, `src/lib/i18n/catalogs/storefront.ts`
- SEO & Meta: `src/lib/seo.ts`, `src/layouts/PlatformLayout.astro`

## 4. Design & Component Architecture
- Visual Language: Selinow Indigo primary palette (`--mk-brand: #5b5ceb`, `--brand-50` to `--brand-900`), clean light neutral surfaces, subtle border hierarchy, crisp shadows.
- Primitives: Flow nodes, status chips, timeline connectors, transaction sequence simulations.
- No Cliché Tropes: No card-wall syndrome, no fake metric graphs, no purple-on-dark, no glowing borders, no fake testimonials.
- Note (2026-08-16): the purple-on-dark / glowing-border ban is superseded for the landing hero, dark intro bands, and final CTA by `LANDING_V4_DESIGN_DIRECTION.md` (scoped, WCAG-AA-controlled deviation). Fake metrics/testimonials and card-wall remain banned everywhere.
- Responsive breakpoints: 320px, 390px, 768px, 1024px, 1440px with programmatic horizontal overflow prevention.

## 5. Security & Public/Private Boundaries
- Strictly preserve noindex, nofollow, and no-store on private routes.
- Mask all mock keys (`XXXXX-XXXXX-•••••-•••••`).
- Maintain CSRF, rate-limiting, and Turnstile integration points without modification.
