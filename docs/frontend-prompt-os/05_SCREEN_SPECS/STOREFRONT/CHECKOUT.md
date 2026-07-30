# Checkout

## Purpose

Xác nhận exact amount và payment method một cách đáng tin cậy.

## Layout

Two-column desktop: order summary + payment/contact. One column mobile.

## Exact hierarchy

Merchant, item/variant, exact amount, currency, payment provider, optional contact, terms/policies, Turnstile when configured, confirm button.


## Mandatory states

quote loading, quote expired, price/stock changed, ready, submitting, provider unavailable, rate limited, validation error.

## Mobile 390px

One column. Exact total and primary CTA remain prominent. Payment logos are supporting, not decorative.

## Acceptance criteria

- Return/cancel URL is not paid proof.
- Idempotency key on mutation.
- Noindex/no-store.
- Exact amount server-confirmed.
