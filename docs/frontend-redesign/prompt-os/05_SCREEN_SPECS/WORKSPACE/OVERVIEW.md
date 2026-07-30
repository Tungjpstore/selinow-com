# Seller overview

## Purpose

Trả lời ngay shop có live không, phần nào cần xử lý và business flow có exception nào.

## Layout

Dark sidebar + light canvas. Page header, store status strip, action queue, activity ledger, commerce summary, channel breakdown.

## Exact hierarchy

1. Page header: shop, date/filter, export if supported.
2. Store live status and public URL.
3. System health: Website, Telegram, PayOS, Kho mã, Tên miền, Subscription.
4. `Việc cần xử lý` with remediation links.
5. Recent operational activity timeline.
6. Commerce summary: gross sales, confirmed orders, payment verification rate, fulfillment rate.
7. Optional product/channel insights after health.


## Mandatory states

loading, no shop, setup required, healthy, degraded, blocked, plan limited, suspended, permission-specific.

## Mobile 390px

Bottom navigation. Health items and actions as record rows. Charts simplified; no tiny labels. Primary remediation stays visible.

## Acceptance criteria

- Health appears before decorative metrics.
- Every alert links to the exact remediation route.
- No cross-shop data leakage.
- Role visibility enforced.
