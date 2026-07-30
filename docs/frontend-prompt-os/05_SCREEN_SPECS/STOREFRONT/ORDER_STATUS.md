# Buyer order status

## Purpose

Cho buyer theo dõi payment và fulfillment sau checkout.

## Layout

Order header + separate payment timeline + fulfillment timeline + support + key/access panel.

## Exact hierarchy

Order public ID, merchant, items, exact total.
Payment heading and state.
Fulfillment heading and state.
Refresh/retry/support action.
Key reveal only when authorized.


## Mandatory states

pending payment, verifying, paid processing, fulfilled, expired, canceled, exception, access denied, retry.

## Mobile 390px

One column. Separate timelines. Clear next action. Avoid celebratory success until provider verified.

## Acceptance criteria

- Opaque access token/verified identity required.
- Noindex/no-store.
- Plaintext key never enters analytics/log.
