# Telegram Mini App Session Boundary

This is a local contract boundary only. It does not configure a Telegram bot,
activate a connector, send a message, or claim provider acceptance.

## Endpoint

`POST /api/channels/telegram-mini-app/sessions/:shopPublicId`

Request body:

```json
{"initData":"<raw Telegram.WebApp.initData>"}
```

The route accepts no cookie session and does not enable wildcard CORS. The
tenant identifier is only a lookup selector: the server proves the same shop
owns the active Telegram integration, credential, subscription, and
`telegram.mini_app` connector request before issuing a session.

Successful response (`201`) returns a one-time bearer token, an opaque session
identifier, expiry, and the validated Telegram language code. Raw `initData`,
bot tokens, Telegram user IDs, and bearer tokens are never persisted or logged.

## Verification and Binding

- Verify raw `initData` with the tenant bot token using Telegram's
  `WebAppData` HMAC algorithm and constant-time hash comparison.
- Require `auth_date` freshness of 300 seconds, reject duplicate fields,
  control characters, malformed hashes, and Telegram IDs above 52 bits.
- Hash Telegram's canonical signed data-check string (not raw query ordering) and reject a second exchange of the same launch.
- Store only a purpose-bound subject hash and session-token hash in D1.
- Pin each session to shop, integration, active connector request, credential
  ID, and credential version. Credential rotation/revocation, connector
  disablement, subscription suspension, or integration disablement immediately
  makes validation fail closed.
- Session lifetime is 15 minutes. Exchange admission is limited to 12 attempts
  per requester and shop per minute using the existing D1 rate-limit ledger.

Future Mini App catalog/cart/checkout routes must call
`authenticateTelegramMiniAppSession` and still reload authoritative catalog,
quote, order, payment, and fulfillment state. `start_param`, client-side
`initDataUnsafe`, prices, and cart totals are never authorization inputs.

## Evidence

- Migration: `migrations/0057_telegram_mini_app_sessions.sql`
- Service: `src/lib/channels/telegram-mini-app-session.ts`
- Route: `src/pages/api/channels/telegram-mini-app/sessions/[shopPublicId].ts`
- Tests: `tests/unit/telegram-mini-app-session.test.ts`

The local test fixture uses an `active` connector request as a reviewed
contract fixture. It does not represent a real Telegram provider activation or
external credential acceptance.
