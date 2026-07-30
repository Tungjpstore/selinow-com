# Cart

## Purpose

Cho buyer review item trước khi quote/checkout.

## Layout

Item list + order summary + checkout CTA.

## Exact hierarchy

Each item: product, variant, quantity, unit price display, remove/update.
Notice: price and stock will be reconfirmed before payment.


## Mandatory states

empty, loading quote, item changed, out of stock, price changed, quote failed.

## Mobile 390px

One column. Summary near CTA. Remove remains accessible and requires no tiny hit target.

## Acceptance criteria

- localStorage is convenience only.
- Server quote is authority.
- Noindex/no-store.
