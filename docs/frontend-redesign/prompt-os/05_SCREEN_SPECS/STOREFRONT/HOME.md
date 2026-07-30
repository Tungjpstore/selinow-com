# Tenant storefront home

## Purpose

Cho buyer khám phá shop và catalog nhanh, đặc biệt từ Telegram.

## Layout

Merchant header, announcement, hero/search, featured/catalog, support, policies, footer. Mobile-first.

## Exact hierarchy

- Merchant logo and name.
- Headline and description.
- Search/filter if supported.
- Product cards with title, short description, price, variant/stock state.
- Support CTA.
- Minimal Selinow attribution according to plan.


## Mandatory states

loading shell, empty catalog, draft, suspended, unknown tenant, product unavailable, degraded support.

## Mobile 390px

Primary design. 20px gutter. One or two columns based on content width. Sticky support/cart only when useful.

## Acceptance criteria

- Semantic HTML renders without JS.
- Hostname determines tenant.
- Draft/suspended never leak unpublished products.
- Correct canonical hostname.
