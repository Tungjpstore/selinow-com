# Storefront product detail

## Purpose

Giúp buyer chọn variant/quantity và hiểu delivery before cart.

## Layout

Product media + purchase panel desktop; one column mobile.

## Exact hierarchy

Title, description, price, variant selector, quantity, stock state, add to cart, delivery explanation, support/refund/policy links.


## Mandatory states

available, low stock, out of stock, selected variant invalid, price refreshed, product unavailable, suspended.

## Mobile 390px

Purchase action sticky bottom when content is long. Controls 44px. Variant labels readable.

## Acceptance criteria

- Stock state uses available/low_stock/out_of_stock.
- Do not expose count unless setting permits.
- Server reconfirms at checkout.
