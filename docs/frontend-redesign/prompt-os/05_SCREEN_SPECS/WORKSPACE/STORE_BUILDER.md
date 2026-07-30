# Store builder

## Purpose

Tùy chỉnh storefront có preview mà không cho user chỉnh raw JSON.

## Layout

Desktop two-pane: settings 420px + live preview. Header: draft state, device selector, undo, publish.

## Exact hierarchy

Tabs: Nội dung, Thương hiệu, Bố cục, SEO, Support.
Fields: shop name, slug/domain summary, headline, description, announcement, logo, merchant brand/accent, support, policies.
Preview uses real storefront components and draft data.


## Mandatory states

loading draft, saved, unsaved, save failed, invalid contrast, publish blocked, publishing, published, forbidden.

## Mobile 390px

Settings and preview become tabs. Device preview fits width; no nested horizontal overflow.

## Acceptance criteria

- Merchant colors server-clamped.
- Semantic payment/error/focus colors protected.
- Publish explicit; draft not automatically live.
