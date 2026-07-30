# Pricing

## Purpose

Giúp seller chọn plan dựa trên capability thực tế và runtime data.

## Layout

Header same marketing shell. Intro + billing cadence control if supported + plan cards + comparison table + FAQ.

## Exact hierarchy

- H1 và explanation không hứa unlimited.
- Plans come from `getMarketingPlans` or current runtime source.
- Highlight recommended plan only when product decides.
- Comparison groups: store, orders, domain, Telegram, team, automation, audit/export.
- Every limit has unit and reset period.


## Mandatory states

Loading, unavailable, current plan when authenticated, plan changed, plan limited.

## Mobile 390px

Plan cards stack. Comparison table becomes grouped list; no clipped columns.

## Acceptance criteria

- No hard-coded limits.
- Currency/period explicit.
- Upgrade CTA maps to existing flow.
