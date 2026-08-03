# Activation analytics

Selinow measures onboarding activation with the tenant-scoped
`activation_milestones` ledger. It is server-side product telemetry, not an
anonymous external analytics SDK and not a source of commerce truth.

The fixed milestone vocabulary is:

`setup_started`, `shop_created`, `product_created`, `inventory_ready`,
`payos_connected`, `telegram_connected`, `readiness_passed`,
`safe_test_passed`, `storefront_published`, `first_order_created`,
`first_paid_fulfilled`, `trial_converted`.

Each row is keyed by `shop_id`, stores only an allowlisted source/reason and
enum-like projection, and uses a SHA-256 idempotency hash. Replaying the same
tenant key with the same payload returns the existing row; a changed payload is
an idempotency conflict. Reads and purge operations require an explicit
`shop_id`; no cross-tenant aggregate is inferred from a cache.

Onboarding distinguishes `preview_ready` (catalog/domain setup and safe checks
can be inspected before payment configuration) from `live_ready` (PayOS is
connected and its signed webhook is fresh and verified). A return URL, QR code,
or browser state never marks an order paid. Every milestone is emitted at a
server-side authoritative transition: setup/shop creation, product and
inventory readiness, verified PayOS and Telegram connections, readiness, safe
test, storefront publication, authoritative order creation, paid fulfillment
on both commerce channels, and signed Dodo trial conversion. Writes remain
best effort for the business transaction, while `backfillActivationMilestones`
deterministically rebuilds missing evidence from authoritative D1 state. The
projection uses allowlisted enums and canonical UTC timestamps and stores no
provider payload, credential, buyer identity, or checkout capability.

Retention is intentionally not guessed in code. Before production activation,
the owner must approve a cutoff and schedule an explicit tenant-scoped purge;
the purge helper will not run without that cutoff.
