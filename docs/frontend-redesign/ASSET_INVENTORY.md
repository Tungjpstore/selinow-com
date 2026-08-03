# Selinow frontend asset inventory

Audit date: 2026-08-02

Scope: every file under `public/brand`, `public/icons`, and `public/favicon.ico`, plus all image references found in `src`. No files were replaced in this audit.

## Executive findings

- The public bundle still contains a legacy illustration kit whose labels are rasterized into PNGs. This includes `Live`, `Coming next`, `Planned`, and Vietnamese copy. These labels cannot be localized or updated without regenerating the image. The current home patch has removed those refs, but the files remain a future regression risk.
- `hero.selinow-core.png` contains a cropped orbit scene with peripheral provider cards and status text. The current home patch replaces it with HTML/CSS channel cards, so the duplicate/clipped UI is no longer rendered; the stale asset should still be archived or deleted after release review.
- The `global/*.png` set is text-free, but each file is an opaque RGB square with a warm cream background. The marketing surface uses cool cloud/lilac surfaces, so these images can render as visible cream squares and do not share the page background.
- Many legacy cards and illustrations are 90-165 px wide. They are acceptable only at small fixed sizes and will look soft on high-density screens or if a responsive layout scales them up.
- There are many logo/icon variants (PNG, SVG, 1x, 2x) and exact duplicate app icons (`brand/logo/selinow-app-icon*.png` and `icons/selinow-{128,512}.png`). This increases selection ambiguity and maintenance cost, although the logo family itself is not a visual defect.
- `selinow-brand-board.png` and the archived `selinow-og-cover.png` contain baked English marketing copy. The runtime now uses the shared text-free `selinow-og-cover-global.png` for both locales.

## Referenced assets and defects

| Asset | Size / format | Source use | QA result | Recommended disposition |
| --- | --- | --- | --- | --- |
| `brand/selinow-kit/hero.selinow-core.png` | 265x260 PNG, alpha | Legacy home hero (no longer referenced by current `src/pages/index.astro`) | **P0**: baked orbit/provider cards and statuses; visible cropped labels; previously duplicated six HTML-overlaid provider images | Keep only as migration reference; do not reintroduce. Use text-free transparent core art and HTML/CSS provider cards |
| `brand/selinow-kit/provider.website-card.png` | 155x79 PNG, alpha | Legacy hero/channels (no longer referenced by current `src/pages/index.astro`) | **P0**: baked `Website` + `Live` | Archive; current HTML card renders label/status correctly |
| `brand/selinow-kit/provider.telegram-card.png` | 165x100 PNG, alpha | Legacy hero/channels (no longer referenced by current `src/pages/index.astro`) | **P0**: baked `Telegram` + `Live` | Archive; current HTML card renders label/status correctly |
| `brand/selinow-kit/provider.whatsapp-card.png` | 137x104 PNG, alpha | Legacy hero/channels (no longer referenced by current `src/pages/index.astro`) | **P0**: baked `WhatsApp` + `Coming next` | Archive; never encode roadmap state in an image |
| `brand/selinow-kit/provider.zalo-card.png` | 123x95 PNG, alpha | Legacy hero/channels (no longer referenced by current `src/pages/index.astro`) | **P0**: baked `Zalo OA` + `Coming next`; Vietnamese product naming | Archive; current HTML card is locale-aware |
| `brand/selinow-kit/provider.discord-card.png` | 165x95 PNG, alpha | Legacy hero/channels (no longer referenced by current `src/pages/index.astro`) | **P0**: baked `Discord` + `Planned` | Archive; status must remain data-driven |
| `brand/selinow-kit/provider.api-card.png` | 160x88 PNG, alpha | Legacy hero/channels (no longer referenced by current `src/pages/index.astro`) | **P0**: baked `API` + `Planned` | Archive; current HTML card renders status data |
| `brand/selinow-kit/illustration.workflow-strip.png` | 505x154 PNG, alpha | No runtime source reference found | **P0**: baked Vietnamese title and four step labels; not localizable | Archive/reference only or regenerate text-free workflow illustration |
| `brand/selinow-kit/diagram.hero-orbit.png` | 565x150 PNG, alpha | No runtime source reference found | **P0**: baked Vietnamese title and flow labels | Archive/reference only or regenerate text-free diagram |
| `brand/selinow-kit/illustration.payment-card.png` | 110x79 PNG, alpha | No runtime source reference found | **P0**: baked Vietnamese `The thanh toan` | Regenerate text-free payment icon; render caption in HTML |
| `brand/selinow-kit/illustration.notification-bell.png` | 95x91 PNG, alpha | No runtime source reference found | **P0**: baked Vietnamese `Chuong thong bao` | Regenerate text-free notification icon |
| `brand/selinow-kit/architecture.core.png` | 104x100 PNG, alpha | No runtime source reference found | **P0**: baked Vietnamese `Selinow Core` label; low resolution | Regenerate text-free architecture core icon at >=512 px |
| `brand/selinow-kit/illustration.shopping-bag.png` | 94x110 PNG, alpha | No runtime source reference found | **P0**: baked Vietnamese `Tui mua sam`; low resolution | Regenerate text-free shopping bag icon at >=512 px |
| `brand/selinow-kit/illustration.product-box.png` | 100x103 PNG, alpha | No runtime source reference found | **P0**: baked Vietnamese `Hop hang`; low resolution | Regenerate text-free product box icon at >=512 px |
| `brand/selinow-kit/illustration.selinow-cube.png` | 105x90 PNG, alpha | No runtime source reference found | **P0**: baked Vietnamese `Selinow Cube`; low resolution | Regenerate text-free cube icon at >=512 px |
| `brand/selinow-kit/illustration.delivery-cloud.png` | 100x85 PNG, alpha | No runtime source reference found | **P0**: baked mixed-language `Cloud giao hang`; low resolution | Regenerate text-free delivery icon at >=512 px |
| `brand/selinow-kit/illustration.bot.png` | 115x99 PNG, alpha | No runtime source reference found | **P0**: baked Vietnamese `Bot AI`; low resolution | Regenerate text-free bot icon at >=512 px |
| `brand/selinow-kit/decorative.sparkles.png` | 115x73 PNG, alpha | No runtime source reference found | **P1**: tiny decorative raster; no text, but likely soft when scaled | Replace with CSS/SVG vector decoration or >=512 px transparent asset |
| `brand/selinow-kit/decorative.dotted-curve.png` | 124x66 PNG, alpha | No runtime source reference found | **P1**: tiny decorative raster; no text | Prefer CSS/SVG path so color/background can follow theme |
| `brand/selinow-kit/decorative.cta-gift.png` | 156x76 PNG, alpha | No runtime source reference found | **P1**: tiny decorative raster; no text | Regenerate as text-free transparent asset at >=512 px or CSS/SVG |
| `brand/selinow-kit/decorative.gradient-orbs.png` | 105x76 PNG, alpha | No runtime source reference found | **P1**: tiny decorative raster; no text | Prefer CSS radial gradients or vector |
| `brand/selinow-kit/decorative.network-nodes.png` | 110x77 PNG, alpha | No runtime source reference found | **P1**: tiny decorative raster; no text | Prefer CSS/SVG vector decoration |
| `brand/selinow-kit/global/global-shopping-bag.png` | 418x418 PNG, opaque RGB | Home use-case card | **P1**: cream square background; does not match cool cloud/lilac UI; no alpha | Regenerate with transparent background or exact page surface color; keep object text-free |
| `brand/selinow-kit/global/global-bot.png` | 418x418 PNG, opaque RGB | Home use-case + workflow | **P1**: cream/white square background; no alpha | Regenerate transparent or theme-colored; use object-only art |
| `brand/selinow-kit/global/global-delivery-cloud.png` | 418x418 PNG, opaque RGB | Home use-case + workflow | **P1**: cream square background; no alpha | Regenerate transparent or theme-colored |
| `brand/selinow-kit/global/global-product-box.png` | 418x418 PNG, opaque RGB | Home use-case | **P1**: cream square background; no alpha | Regenerate transparent or theme-colored |
| `brand/selinow-kit/global/global-network-nodes.png` | 418x418 PNG, opaque RGB | Home use-case + workflow | **P1**: cream square background; no alpha | Regenerate transparent or theme-colored |
| `brand/selinow-kit/global/global-notification-bell.png` | 418x418 PNG, opaque RGB | Home use-case | **P1**: cream square background; no alpha | Regenerate transparent or theme-colored |
| `brand/selinow-kit/global/global-payment-card.png` | 341x512 PNG, opaque RGB | Home workflow | **P1**: portrait cream square/background; no alpha; inconsistent aspect ratio with other 418x418 assets | Regenerate transparent object at a consistent 1:1 or 4:3 artboard |
| `brand/selinow-kit/global/global-architecture-core.png` | 394x443 PNG, opaque RGB | Home architecture core (HTML sets 104x100) | **P1**: opaque warm background and portrait ratio; rendered down to 104x100, wasting pixels | Regenerate transparent 1:1 core object and use a larger CSS display size |

## Logo, social, and icon set

| Asset group | Dimensions | Runtime use | QA result |
| --- | --- | --- | --- |
| `brand/logo/selinow-logo-primary.svg`, `selinow-logo-black.svg`, `selinow-logo-reversed.svg`, `selinow-logo-white.svg` | 760x160 SVG | Header/footer/login/app/admin | Vector and scalable. `reversed`/`white` SVGs include a baked `#0B1020` rectangle, so they are not transparent and should only be used on matching dark surfaces. |
| Logo PNGs (`*-logo-*.png`, including `@2x`) | 760x160 or 1024x216 | Mostly not referenced by `src`; reference/export variants | Large redundant family. Keep SVG as source of truth; retain PNG only for external brand kit. |
| Mark SVG/PNG (`selinow-mark-*`) | 128x128 SVG/PNG; 512x512 `@2x` | CTA/app/storefront | Vector is preferred. `selinow-mark-white.svg` includes a baked dark rectangle, so it is not transparent despite its use as a CTA mark. |
| App icons (`brand/logo/selinow-app-icon*.png/svg`, `icons/selinow-*.png`) | 16-512 px | Favicons/PWA/apple touch | `brand/logo/selinow-app-icon.png` == `icons/selinow-128.png` and `brand/logo/selinow-app-icon@2x.png` == `icons/selinow-512.png` byte-for-byte. Consolidate to one generated icon pipeline. |
| `brand/selinow-og-cover-global.png` | 1200x630 PNG | `PlatformLayout` OG/Twitter image | Text-free derivative of the generated hero visual; shared safely by EN/VI metadata. |
| `brand/selinow-brand-board.png` | 1600x1000 PNG | No runtime source reference | Internal board with baked English copy and palette swatches; keep outside runtime bundle. |
| `brand/visuals/conversation-to-sale-flow.svg` | 800x500 SVG | No runtime source reference found | Baked English labels (`Conversation`, `Checkout`, `Delivery`, etc.); safe only as an intentional English-only diagram. |
| `brand/visuals/selinow-pattern-light.svg` | 1200x800 SVG | `src/styles/platform.css` | Text-free vector, but hard-coded `#F8FAFC` surface. Fine for light platform shell only; not suitable on warm global art surfaces. |
| `brand/visuals/selinow-pattern-dark.svg` | 1200x800 SVG | `src/styles/platform.css` | Text-free vector, hard-coded `#080B14`; use only on dark shell. |

## Runtime reference map

- `src/pages/index.astro`: current home uses HTML channel cards (labels/status are i18n); the hero and architecture use `global/v2/hero-core.png`; Use Cases/Workflow use the versioned v2 object masters. Legacy hero/provider/global PNG refs were removed in the current working tree.
- `src/layouts/PlatformLayout.astro`: `brand/selinow-og-cover-global.png`, favicon icons.
- `src/components/marketing/MarketingHeader.astro`: `brand/logo/selinow-logo-primary.svg`.
- `src/pages/pricing.astro`, `src/pages/solutions/index.astro`, `src/pages/solutions/[slug].astro`: `brand/logo/selinow-logo-black.svg`.
- `src/pages/login.astro`: primary logo + favicon/apple icon.
- `src/layouts/AppLayout.astro`, `src/layouts/AdminLayout.astro`: reversed logo + favicon/apple icon.
- `src/layouts/StorefrontLayout.astro`: app-icon SVG, mark-gradient SVG, favicon/apple icon; tenant logo is external and data-driven.
- `src/styles/platform.css`: light/dark pattern SVG backgrounds.
- No runtime refs found for the legacy `illustration.*`, `decorative.*`, `diagram.hero-orbit.png`, or `conversation-to-sale-flow.svg` files; treat these as reference/archive assets unless reintroduced intentionally.

## Versioned replacement delivered

The homepage now uses the generated visual-only kit in `public/brand/selinow-kit/global/v2/`:

- `hero-core.png` (1536x1024) powers the hero and architecture core crop.
- `channel-network.png`, `commerce-catalog.png`, `support-automation.png`, and `delivery-payment.png` are 1254x1254 object masters for channels, use cases, and workflow steps.
- All five files are complete PNGs with a valid `IEND` marker, exceed 1,000px on their source edge, contain no rasterized copy/status, and use the homepage cloud-white backdrop `#f7f8f4`.
- The homepage no longer references `global/global-*.png`, `hero.selinow-core.png`, or any `provider.*-card.png`; labels and readiness states remain localized HTML/i18n.
- `selinow-mark-white.svg` was removed from the CTA runtime path because it embeds a dark rectangle; the CTA now uses the transparent black mark with a CSS invert filter.
- Legacy PNGs and the old copy-bearing OG cover were moved out of `public/` into `docs/frontend-redesign/archive/`, so they are retained for historical comparison but cannot leak into the production asset bundle or be reintroduced by a broad `public/` copy.

## Replacement acceptance criteria

1. Every marketing image is text-free; all labels, statuses, roadmap states, and copy remain HTML/i18n data.
2. Primary hero/core and all reusable icons are transparent PNG/WebP/SVG with no baked page background. If raster is required, export at >=2x the largest CSS size (prefer 512 px object masters).
3. Global use-case objects share one visual language and one background contract: transparent object or exact `--kit-cloud`/surface color; no cream squares.
4. Provider/channel status is a data field (`live`, `expanding`, `planned`, `extensible`) and never part of an image filename or bitmap.
5. Locale QA covers `/` in `en` and `vi`, checking that no Vietnamese copy appears in EN and no English-only baked status remains in VI.
6. Responsive QA checks 320, 375, 768, 1024, and 1440 px widths at DPR 1 and 2; no cropped labels, duplicated provider cards, or raster blur.
7. Social QA generates distinct EN/VI OG previews (or a text-free shared image) and confirms a 1200x630 image with readable contrast.
