# Integrations

## Purpose

Kết nối và theo dõi provider health.

## Layout

Status rows grouped by channel, payment, infrastructure, notifications.

## Exact hierarchy

Telegram, PayOS, Cloudflare/domain, email, webhook or current supported providers.
Each row: logo/icon, connection, account/identifier safe summary, last health check, state, action.


## Mandatory states

disconnected, connecting, healthy, degraded, waiting user, waiting provider, expired credential, failed, forbidden.

## Mobile 390px

Stacked rows. Action full-width only in detail. Secret entry in secure dedicated panel.

## Acceptance criteria

- Secret never prefilled.
- Last check shown.
- Provider error translated to safe message.
