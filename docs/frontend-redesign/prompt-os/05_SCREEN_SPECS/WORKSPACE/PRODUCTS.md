# Products

## Purpose

Quản lý product, price, variant, channel visibility và status.

## Layout

Page header + filters + desktop table / mobile record list + create/edit drawer or page according to repo.

## Exact hierarchy

Columns: product, price, variants, available stock state, channels, status, updated, actions.
Filters: all, active, draft, hidden, out of stock, archived.
Primary action: `Thêm sản phẩm`.


## Mandatory states

loading, empty first product, no results, save success, validation error, plan limited, forbidden.

## Mobile 390px

Record cards with title, price, stock, status, channel and kebab action. Search/filter in drawer.

## Acceptance criteria

- Semantic status.
- Server validates price and stock.
- Destructive archive confirmation.
