# Onboarding

Seller onboarding is browser-first, resumable and stored server-side. A shop may
reach `preview_ready` and run the read-only safe test before PayOS is connected;
`live_ready` and real checkout still require a fresh, verified PayOS webhook.
The only unavoidable external inputs are a Telegram bot token, PayOS credentials
and DNS records for an optional custom domain.

The Phase 8 wizard covers shop creation, channel selection, catalog, signed inventory preview/import, Telegram, PayOS, policies, readiness, a controlled read-only test order and guarded publish. Server readiness remains authoritative; client progress is only a resumable presentation fallback.

Telegram `/start` health is represented only by `lastHealthUpdateAt`. Other inbound commands update general activity timestamps but cannot satisfy the onboarding health check. Disconnecting, changing bots or rotating credentials clears prior `/start` evidence.

Telegram and PayOS setup failures retain only encrypted tenant credentials in D1. The wizard's health/retry actions can resume a `pending` or `error` setup without asking the seller to paste the secret again. These endpoints require CSRF protection and recent authentication, remain tenant-scoped and return only sanitized integration views.

Live acceptance still requires a dedicated test Telegram bot, a controlled PayOS channel, an external custom hostname and desktop/mobile fresh-seller runs against staging. No local flow may point at production providers or production Cloudflare resources.

Activation milestones are documented in [ACTIVATION_ANALYTICS.md](ACTIVATION_ANALYTICS.md). They are tenant-scoped server events only; provider credentials, customer data, license plaintext and raw webhook payloads are never stored in the analytics projection.
