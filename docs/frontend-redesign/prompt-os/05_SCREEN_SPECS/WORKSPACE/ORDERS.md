# Orders

## Purpose

Theo dõi payment và fulfillment theo hai trục riêng.

## Layout

Header + filters + order ledger. Desktop table; mobile record list.

## Exact hierarchy

Filters: Tất cả, Chờ thanh toán, Đã thanh toán, Đang giao, Hoàn tất, Cần xử lý.
Columns: order ID, customer, item, gross amount, payment state, fulfillment state, channel, created, action.


## Mandatory states

loading, empty, no results, payment pending, verified, fulfillment processing, fulfilled, exception, forbidden.

## Mobile 390px

Each card shows order ID, amount, payment badge, fulfillment badge, time. Avoid horizontal table scroll when possible.

## Acceptance criteria

- Payment and fulfillment never merged.
- Safe public/private IDs according to route.
- No sensitive token in URL copy.
