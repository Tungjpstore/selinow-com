# PayOS Integration

Each shop connects its own PayOS channel and receives funds directly. Only a valid signed webhook or direct provider reconciliation can confirm payment. Return URLs, browser query parameters and QR rendering never mark an order paid.

Implementation is source-complete but externally gated. Tenant credentials are
encrypted in D1; there are no global PayOS API secrets. Staging checkout,
reconciliation and webhook processing fail closed unless the Worker secret
`PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT` attests a dedicated controlled
PayOS test channel. The fingerprint is derived from the channel client ID with
the configured identifier HMAC family and must never be fabricated or copied
from production. Production behavior remains unchanged, and real-money actions
require owner confirmation immediately before execution.

The tenant connect route is `PUT /api/app/shops/:shopPublicId/payments/payos`;
it registers `paywh_<uuid>` and performs provider-identity ownership checks
before calling PayOS. Signed webhook, reconciliation, retry, replay,
response-loss, concurrency and tenant-isolation tests are covered locally.
Staging acceptance is blocked until the controlled channel and canonical route
are admitted; do not enter production credentials into staging.
