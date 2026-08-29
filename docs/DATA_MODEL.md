# Data Model

The authoritative numbered source chain is contiguous through `0121_payos_disconnect_projection_repair.sql`. Staging D1 is observed through `0120`, while retained deployment evidence is bound to an earlier candidate and cannot authorize this release. Production D1 remains admitted through `0112_google_auth_foundation.sql`; continuation migrations `0113` through `0121` require fresh production backup/restore and mutation-window gates. The reviewed production resource identity and platform deployment are provisioned; provider activation and commerce traffic remain separately fail-closed. The full future schema contract remains in `02_ARCHITECTURE_AND_DATA.md`.

All shop-owned access must resolve active membership first and retain the internal `shop_id` predicate for reads and writes. Public IDs are routing identifiers, not authorization authority.

All shop-owned rows must contain `shop_id`. Repository and service methods must require tenant context, and object lookup must constrain both resource ID and `shop_id`. KV must never become authoritative for inventory, orders, payments, subscriptions, credentials or keys.

Inventory plaintext is never stored. `inventory_keys` stores AES-GCM ciphertext, IV, key version and a shop/variant-scoped keyed fingerprint. The unique `(shop_id, variant_id, key_fingerprint)` constraint rejects duplicates without disclosing the source value.

Checkout reserves inventory through a conditional `UPDATE` of available rows. `reservation_token`, `reserved_order_item_id` and `reserved_until` bind each reserved key to one checkout. Order and order-item rows preserve product, SKU, title, price, currency and quantity snapshots so later catalog edits cannot rewrite order history.

`checkout_subject_hash` provides per-shop idempotency uniqueness; `checkout_request_hash` detects reuse with a different cart or expected quote. Only the HMAC of the order access token is stored.

Phase 4 adds a stable `payment_integrations` identity and versioned `payment_credentials`. Each credential field is encrypted independently with credential/shop/integration/field-bound AAD. Active attempts retain the exact credential version used when the PayOS link was created.

`payment_attempts.provider_order_code` is globally unique. Payment events deduplicate provider reference plus payload hash, while a reused reference with a different hash becomes an inconsistency exception. `fulfillments` and `fulfillment_items` provide unique guards for each order and sold inventory key. Outbox rows contain aggregate references only.

Phase 5 adds stable `telegram_integrations` and versioned `telegram_credentials`. A global live token fingerprint and active bot ID constraint prevent one seller bot from being active in two shops. Credential ciphertext is bound to shop, integration, credential version and field; webhook verification uses a stored purpose-bound HMAC digest.

`customer_identities.external_subject` stores a per-shop Telegram subject HMAC rather than a raw Telegram user ID. `telegram_recipients` stores the private chat ID encrypted separately so paid notifications can be rehydrated without placing recipient IDs in jobs or logs.

`telegram_updates` deduplicates `(integration_id, update_id)` and retains only a payload hash and safe result code. `telegram_actions` makes cart and checkout mutations replay-safe. Telegram carts continue using the shared `carts` and `cart_items` tables with `channel='telegram'`; Telegram orders use the same inventory reservation, PayOS attempt, fulfillment and outbox state as website orders.

Migration `0020_automation_tasks.sql` adds the durable no-tech automation projection. `automation_tasks` accepts only SHA-256 request/idempotency digests and a server-issued opaque reference (`d1:`, `r2:`, `audit:` or `action:` plus a resource/id path), and guards every execution with a version plus expiring lease. Provider URLs, OAuth state and credentials are rejected at the application and database boundaries. Tenant-leading indexes serve seller reads; the scheduled worker receives only due task IDs, shop IDs, status and version before making an atomic claim.

`automation_task_events` is the append-only transition trail. Each task version has one event containing the previous/next status, actor role/reference, safe result code and optional evidence/action/audit references. Raw provider requests, credentials and OAuth state are excluded. Events use a composite `(task_id, shop_id)` foreign key, so a malformed adapter cannot attach a task transition to another tenant; restrictive shop/task foreign keys prevent tenant deletion from silently erasing the audit history. Shop lifecycle remains a soft-delete/anonymization workflow.

Migration `0021_channel_connections.sql` adds the channel-neutral connection foundation without cutting over the existing Telegram or website paths. `shop_channels` identifies one tenant/channel pair; `channel_connections` supports multiple provider accounts, external-identity uniqueness, open OAuth/connect-intent idempotency and an optimistic lifecycle (`pending -> active/degraded -> disconnected`, with disconnected rows closed as evidence). A D1 trigger and repository guard reject illegal resurrection transitions.

`channel_connection_grants` stores capability grants as tenant-scoped evidence. `channel_credentials` stores only versioned encrypted envelopes, a provider fingerprint and key metadata. Repository writes require canonical base64url envelope material (AES-GCM ciphertext with a 12-byte IV and 32-byte fingerprint), and both the repository and D1 triggers require the creating user to be an active member of the same shop. Live fingerprints cannot cross connection or tenant boundaries; provider-specific credential migration and adapter cutover remain future work.

Migration `0022_order_channel_attributions.sql` adds one tenant-bound normalized attribution row per order. It stores the channel code, adapter version and optional channel connection while `orders.source_channel` remains the compatibility field during staged adapter cutover. Composite shop/order and shop/connection foreign keys prevent cross-tenant attribution; website and Telegram checkout dual-write the normalized projection atomically with the order.

Migration `0023_automation_api_evidence.sql` adds opaque continuation challenges. Only the SHA-256 token hash is stored; immutable task, tenant, actor, kind and expiry binding plus active-member and exact audit-log triggers gate consumption. Consumed challenges cannot be expired or rewritten, terminal evidence cannot be deleted, and D1 triggers cap each tenant at 100 non-terminal automation tasks across inserts, terminal-to-open transitions and cross-shop moves.

Migration `0024_automation_create_idempotency_scope.sql` strengthens create idempotency to one key per shop across capabilities and actors. The earlier capability-scoped unique index remains in place for Worker rollback compatibility while the stronger shop-scoped index governs new code and prevents concurrent same-key requests from creating different tasks.

Migration `0025_telegram_channel_connection_backfill.sql` rerunnably projects legacy Telegram integrations into the generic channel registry and fills only same-tenant, previously empty Telegram order attributions. Deterministic connection collisions fail closed instead of merging tenants.

Migration `0026_domain_event_delivery_outbox.sql` adds tenant-bound, reference-only `domain_events` and per-connection `delivery_jobs`. Composite tenant foreign keys, immutable identity, dedupe and lease/status guards prevent cross-shop fan-out and unsafe retries; the legacy Telegram outbox remains during staged parity validation.

Migration `0027_telegram_generic_connection_link.sql` links each legacy Telegram integration to one exact same-tenant generic connection, dual-writes lifecycle health and grants the reviewed capability allowlist. Migration `0028_domain_delivery_runtime_hardening.sql` adds ready/expired-lease indexes, guarded recovery/replay transitions and generic dead-letter target links. Both are part of the accepted staging ledger.

Migration `0029_storefront_draft_publication.sql` separates seller draft storefront settings from the published public snapshot and backfills only shops that were already public. Publication remains owner-controlled, tenant-scoped and optimistic-version guarded. This migration is validated locally and remains pending on staging; the admitted production baseline includes it.

Migration `0030_order_checkout_cart_reference.sql` adds nullable `orders.checkout_cart_id` with a tenant-leading partial index so Telegram checkout replay can resolve the immutable converted cart. Legacy orders remain nullable and replay fails closed when no exact retained cart snapshot exists. This migration is validated locally and remains pending on staging; the admitted production baseline includes it.

Migration `0031_shop_country_configuration.sql` adds nullable `merchant_country_code` and `business_country_code` fields with uppercase alpha-2 shape checks and tenant-leading partial indexes. Shop create/update canonicalizes country, currency and default locale; currency changes reject variants that would become mismatched, while pre-0031 rows retain a safe unknown-country read fallback. This migration is validated locally and remains pending on staging; the admitted production baseline includes it.

Migration `0032_shop_globalization_invariants.sql` adds the immutable ISO-3166 alpha-2 reference table and D1 triggers that enforce real country membership, the supported USD/EUR/JPY/VND shop and variant currencies, and exact shop/variant currency matching. Invalid staged country values become explicit unknowns before the guards activate. This migration is validated locally and remains pending on staging; the admitted production baseline includes it.

Migration `0033_cart_mutation_replays.sql` adds expiring, tenant-scoped replay protection for anonymous Website cart mutations. The unique `(shop_id, subject_hash, idempotency_key_hash)` contract detects key reuse, while `request_hash` distinguishes exact replay from payload conflict. The table stores references and hashes only; Website and Telegram share mutation/pricing logic while Telegram retains its provider-specific action ledger. This migration remains pending on staging; the admitted production baseline includes it.

Migration `0034_private_downloadable_fulfillment.sql` adds private-file fulfillment without rebuilding the legacy fulfillment CHECK constraints. `digital_assets` and immutable `digital_asset_versions` describe tenant-owned private bytes and their integrity evidence; `product_fulfillment_policies` versions the typed capability while legacy products remain `manual`. The canonical checkout transaction inserts `order_item_fulfillment_requirements` immediately after each order item, guarded by the exact active policy and asset version; the immutable row freezes the policy before payment or a grant. Pre-cutover fallback is temporal to the order-item creation interval and never applies a policy created after the order. `digital_entitlements` owns authoritative expiry and download quota, and `delivery_grants` plus `delivery_grant_consumptions` enforce one-use, retry-safe access. Composite tenant foreign keys and triggers reject identity changes, cross-tenant references, policy resurrection, historical license-key reinterpretation and grant TTLs that exceed policy. Tokens are HMAC-derived and plaintext is never stored. This migration remains pending on staging; the admitted production baseline includes it.

Migration `0035_payment_provider_connections.sql` adds an additive provider-neutral payment projection: immutable ISO-4217 currency and payment-method registries, tenant-scoped provider connections, capability grants, supported currencies and supported methods. Each connection records provider environment, descriptor/policy versions, connection and settlement mode, merchant/provider-attested country and a verified account fingerprint without storing raw account identifiers. Composite tenant links bind the projection to legacy PayOS integrations; effective projections fail closed when health, webhook verification, account identity or descriptor/policy versions are stale. The deterministic bridge backfills only the existing PayOS direct/BYO seller connection, VND, `bank_transfer_qr` and the four truthful capabilities (`checkout.create`, `credential.health`, `payment.reconcile`, `webhook.verify`). Legacy PayOS tables and runtime remain authoritative; this migration does not add a second provider or cut over payment writes.

Migration `0036_payos_identity_claim_hardening.sql` clears provider identity and credential ownership fingerprints from legacy pending/error PayOS rows that were never provider-verified. Verified active/grace/disconnected evidence is retained for safe reconciliation and reconnect behavior. New ownership claims occur only after successful provider webhook confirmation; no credential, account identifier or fingerprint plaintext is exported or logged.

Migration `0037_legacy_payos_tenant_guards.sql` validates existing legacy PayOS relationships before installing tenant-leading indexes and bidirectional D1 guards. It binds each active credential to its exact integration/shop/provider, each attempt to its exact order/integration/credential scope, each event to its exact integration/attempt scope, each exception to its exact order/attempt scope and each paid-event pointer back to the exact attempt. Any existing cross-tenant or cross-provider mismatch aborts the migration before the guards are installed; legacy financial rows remain in place and authoritative.

Migration `0038_api_credentials.sql` adds owner-managed, server-to-server API credentials for the bounded public API foundation. `api_credentials` stores the tenant, opaque public ID, fixed `shop:read` grant, optional expiry, lifecycle timestamps, optimistic version and only a purpose-bound keyed token digest; the plaintext bearer token is returned once at issuance and is never recoverable from D1. Database checks make identity, tenant, scope, hash, expiry and creator immutable, allow only `active -> revoked`, prohibit physical deletion, require the creator to be an active tenant member and cap each shop at ten active credentials whose expiry has not passed. Tenant-leading status/expiry indexes support management and quota checks. Issuance and revocation remain recent-authenticated, owner-only, idempotent and audit-once; public authentication resolves `shop_id` exclusively from the credential, rechecks credential expiry plus shop/subscription state, enforces the fixed scope and uses D1-backed per-credential rate limiting. Seller exports exclude token and revocation hashes; protected full DR/PITR backups retain keyed digests needed to restore authentication state, so post-restore credential rotation/revocation remains mandatory.

Migration `0039_payment_provider_identity_shred.sql` extends the provider-identity guard so account fingerprints and attested country evidence can be cleared only during an admitted crypto-shred step after provider cleanup, grace-period and legal-hold checks. Disconnected rows remain audit evidence, while live identity claims stay immutable outside the destructive deletion fence; no payment attempts, events or exception rows are deleted.

Migration `0040_api_catalog_scope.sql` widens the immutable API credential allowlist by forward-only table replacement to support `catalog:read` and `shop:read` (including the combined scope) without rewriting token hashes or lifecycle state. `GET /api/v1/catalog` is a tenant-derived projection of active products/variants and derived stock state; it excludes inventory ciphertext, exact stock counts, private object references, provider fields and PII.

Migration `0068_public_api_read_scopes.sql` forward-rebuilds the immutable credential scope allowlist to add `inventory:read` and `orders:read` while preserving token hashes, lifecycle triggers and existing rows. `GET /api/v1/inventory` returns bounded, tenant-scoped aggregate counts and safe catalog references; `GET /api/v1/orders` returns bounded, tenant-scoped order summaries with customer, provider, payment-attempt, fulfillment-internal and token data redacted. Both projections use opaque keyset cursors, fixed credential rate limits and no-store responses. Fulfillment, entitlement and outbound-webhook public API contracts remain unimplemented.

Migration `0069_catalog_channel_visibility.sql` adds the tenant-leading product/channel
visibility ledger with scope and lifecycle triggers, Website backfill and enabled-channel
defaults. Missing visibility rows fail closed; seller GET/PUT controls use capability,
CSRF, recent-auth, idempotency and optimistic-version guards. Website and Telegram Mini App
catalog projections apply the channel-specific `visible` fence; this is source/local
contract evidence and does not activate any external provider.

Migration `0041_private_download_claim_leases.sql` adds a tenant-scoped, five-minute `delivery_grant_claims` lease. A claim must win before private R2 reads, buffering or hashing; concurrent losers fail closed, storage/integrity failures release the claim, and final `served` consumption is fenced by the claim ID. The immutable consumption ledger and quota remain authoritative, while expired leases recover after process interruption. Migration `0042_security_rate_limit_retention.sql` adds an indexed bounded purge for expired limiter windows, `0043_payment_settlement_policy_guard.sql` rejects unsupported settlement/credential tuples, `0044_order_currency_invariants.sql` binds order money to the shop currency snapshot, `0045_telegram_customer_locale_preference.sql` persists a tenant-scoped buyer locale choice, and `0046_manual_fulfillment_executions.sql` adds immutable per-item seller-attested delivery plus a hash-only external reference ledger. The claim, retention, currency, locale and manual-execution tables are included in backup schema/count validation; manual execution export includes safe metadata only, while immutable execution/reference rows remain retained financial/audit evidence during deletion.

Migration `0047_generic_entitlement_foundation.sql` adds six tenant-scoped tables: `entitlement_resources`, `product_entitlement_policies`, `order_item_entitlement_requirements`, `entitlements`, `entitlement_grants` and `entitlement_transitions`. Resources identify the typed access capability; product policies version the active resource binding, grant quantity and optional TTL; requirements immutably snapshot that policy for one exact order item; entitlements hold the versioned `pending|active|suspended|expired|revoked` state; grants preserve immutable activation evidence; and transitions preserve the append-only lifecycle trail. Composite tenant foreign keys, tenant-leading indexes and immutable identity guards keep every relationship scoped by `shop_id`.

The canonical Website, Telegram and `fake.third` checkout batch inserts generic requirements and entitlements from the same exact policy snapshot. Free orders start active with a `free_checkout` grant. Paid orders start pending and may activate only from the exact signed, claimed, unprocessed payment event linked through a `paid_exact` attempt and matching `paid_event_id`. Manual items create legacy seller-attested work only when neither a private-file nor generic requirement exists; database guards make manual execution and generic requirements mutually exclusive in both insertion directions. Backup validation covers all six tables; export schema version 3 was the historical `0047` generic-only projection, version 4 added the historical `0048` reversal projection, and both are superseded by current schema version 5 through `0052`. Deletion retires active resources/policies and revokes live entitlements behind the legal-hold/crypto-shred fence while retaining immutable requirements, grants and transitions. Migration `0047` is included in the admitted production baseline and remains pending on staging; see ADR 0016.

Migration `0048_payment_reversal_entitlement_revocation.sql` adds immutable tenant-scoped `payment_reversal_events` rows with exact order/attempt/integration/credential/paid-event foreign-key bindings, normalized refund/chargeback decisions and only one-way provider-reference, evidence, idempotency and request fingerprints. The ledger is immutable and included in backup schema/count validation. Exact verified full refunds and chargebacks are applied atomically: the order becomes `refunded`, generic pending/active/suspended entitlements are revoked with an append-only `payment_reversal` transition, private active/suspended entitlements are revoked and active delivery grants are revoked. Sold keys, fulfillment and delivery-consumption history are retained. Partial or amount/currency-mismatched evidence opens `payment_exceptions.type='manual_review'` without revoking access; unverified evidence is rejected. Current standard seller export schema version 5 includes only safe reversal metadata and never exports hashes, credential/integration IDs or raw provider references. Shop deletion retains the immutable reversal/financial/audit ledger and existing payment/legal-hold fences continue to apply. Migration `0048` is included in the admitted production baseline and remains pending on staging; see ADR 0017.

Migration `0049_generated_license_fulfillment.sql` adds eight tenant-scoped generated-license tables. `generated_license_provider_connections` owns seller webhook connection identity and health; `generated_license_provider_credentials` stores only versioned encrypted endpoint/credential envelopes and keyed fingerprints; `generated_license_resource_bindings` binds one active `generated_license` resource to an executable connection; and immutable `generated_license_requirement_snapshots` freeze that binding for the exact entitlement/order item. `generated_license_requests` is the authoritative leased state machine for `pending|processing|retryable|reconcile_pending|succeeded|failed|manual_review|canceled`; immutable `generated_license_attempts` records generate/reconcile/revoke evidence; `generated_license_artifacts` stores one encrypted text/JSON artifact per request/entitlement; and `generated_license_dead_letters` owns safe operator remediation state. Composite foreign keys, tenant-leading indexes and triggers preserve `shop_id` isolation, immutable identities and the bounded v1 quantity of one.

Provider secrets are AES-GCM encrypted with the credential key family and AAD `generated-license-provider-secret:v1\0{keyVersion}\0{shopId}\0{connectionId}\0{credentialId}\0{field}`. Artifact plaintext is encrypted with the inventory key family and separate AAD `generated-license-artifact:v1\0{keyVersion}\0{shopId}\0{requestId}\0{artifactId}\0{format}`. Queue envelopes and generated-license DLQ rows contain only shop/request/operation references and safe context. A generated request can exist only after the generic entitlement is active and an immutable grant exists: free checkout after `free_checkout`, or paid checkout after exact signed/claimed `paid_exact` activation. Ambiguous provider outcomes become `reconcile_pending`, and the next action is `reconcile` rather than another `generate`.

Migration `0050_generated_license_deletion_lifecycle.sql` permits only the guarded forward lifecycle needed for crypto-shred: retired connections may clear their external-account fingerprint, and revoked artifacts may become `destroyed` with envelope fields replaced by the destruction marker. Exact payment reversal cancels pending/retryable/processing/reconcile-pending requests locally and revokes active artifacts without provider I/O while retaining requests and attempts. Shop deletion adds the stronger work-lease fence, cancels non-terminal requests, resolves generated-license DLQ state, retires bindings/connections, destroys credential/artifact ciphertext and retains immutable snapshots, requests, attempts and financial/audit evidence.

Migration `0051_generated_license_rotation.sql` forward-rebuilds the existing rotation control tables to add two independent resumable families and resource types: `generated_license_credentials`/`generated_license_credential` use the credential key family, while `generated_license_artifacts`/`generated_license_artifact` use the inventory key family. Migration `0052_generated_license_request_hardening.sql` freezes canonical request creation, terminal evidence and retry/lease transitions and adds global due/lease and key-version indexes. Leased rotation may change only the encrypted envelope and key version while preserving tenant/provider identity and immutable evidence. Standard seller export schema version 5 exposes safe connection/binding/snapshot/request/attempt/artifact/DLQ metadata but excludes endpoints, credentials, ciphertext, IVs, key versions, fingerprints/hashes, provider references and artifact plaintext. Protected backup and isolated restore schema/count validation include all eight generated-license tables. Migrations `0049`-`0052` are included in the admitted production baseline; this paragraph records the historical `0052` checkpoint and does not supersede the current source/remote status at the top of this document. See ADR 0018.

Migration `0058_channel_provider_event_receipts.sql` adds the generic inbound
provider receipt ledger for the verified ingress seam. It stores only
tenant/connection/provider identity, provider event ID, action, payload hash
reference, safe timestamps, attempts and bounded lifecycle status. Composite
tenant foreign keys and direct-D1 triggers reject mismatched provider/channel
connections or non-active connections; immutable identity and transition guards
make same-hash retries safe and changed-payload conflicts auditable. Raw
provider bodies, credentials, tokens and commerce state are never persisted in
this table. Concrete provider routes, identity resolution, OAuth/token
lifecycle and outbound adapters remain future acceptance work.

Migration `0059_channel_customer_identities.sql` adds the generic
`channel_customer_identities` projection without changing the legacy Telegram
`customer_identities` table. Each row binds one canonical shop customer to an
exact provider connection and stores only a tenant/connection-purpose HMAC of
the external subject plus bounded display name/handle and locale metadata.
Composite foreign keys and provider/channel/status triggers reject cross-tenant,
provider-mismatched or provider-pending claims; the identity tuple is immutable
while safe presentation metadata may refresh. `upsertChannelCustomerIdentity`
is idempotent for the same tuple and fails closed if a provider subject is
remapped to a different customer. Raw external subjects and provider payloads
never enter D1, queues, exports or logs.

Migration `0091_buyer_order_access_recovery.sql` adds tenant-scoped,
single-use buyer recovery grants for Website orders. D1 stores only the
purpose-bound token and recipient hashes, safe request ID, customer/order
references and bounded timestamps; plaintext recovery tokens and buyer emails
never enter the ledger.
At most one active grant exists per `(shop_id, order_id)`. Exact composite
foreign keys and insert/update triggers bind every grant to the same shop,
order and customer, while terminal state and identity fields are immutable.
Consumption is a compare-and-set update, and an `AFTER UPDATE` trigger rotates
the authoritative `orders.order_token_hash` in the same transaction, so replay
or concurrent consumption has exactly one winner and the previous order token
cannot remain valid. The runtime sends only a short-lived token in a URL
fragment and requires exact same-origin request/consume admission. Existing
hash-only limiter rows bound per-shop requester and platform requester
constrain abuse without letting fabricated order IDs lock a buyer email out.
Replacement access tokens are deterministic from the recovery ID, so an exact
checkout replay returns the latest valid token after one or many rotations.
Consumed rows retain only the exact same-order binding lineage needed for
private-file authorization compatibility; after 30 days the recovery-link and
recipient hashes are replaced with unlinkable values, while expired or revoked
unconsumed rows are deleted. Customer anonymization rotates Website order
access hashes and deletes all recovery rows, revoking both prior and recovered
access. This
migration is source-only; retained staging evidence ends at `0090`.

Migrations `0092_custom_domain_turnstile_admission.sql` and
`0093_custom_domain_turnstile_runtime_guard.sql` remove legacy custom-domain
routing that lacks exact, fresh Turnstile widget admission, restore a safe
platform-domain canonical fallback when possible, and enforce the boundary in
D1 during migrate-before-deploy and rollback windows. These migrations are also
source-only relative to the retained remote evidence.

Migration `0094_shop_creation_admission.sql` rebuilds the hash-only auth
admission ledger to admit authenticated `shop_create` claims while preserving
existing magic-link rows and requester/subject window indexes. Shop creation
claims require a subject hash and permitted delivery marker; raw requester and
user identifiers remain outside D1. This migration is source-only relative to
the retained remote evidence.

Migration `0121_payos_disconnect_projection_repair.sql` is a forward-only data
repair for the PayOS projection introduced by `0119`. It clears a stale account
fingerprint and verification timestamp only when the provider connection and
same-tenant legacy integration are both fully disconnected, the legacy row has
no active credential, no provider country attestation remains, and stale
projection state is present. The repair copies the legacy update timestamp and
increments the projection version under the `0120` identity fence; the legacy
integration remains authoritative and this migration does not establish payment
authority or activate fulfillment.

Current operational ledger note: source migrations `0001`-`0121` are contiguous;
staging D1 is observed through `0120`, and production remains admitted only
through `0112`. All later migration descriptions in this document are schema
contracts or checkpoint history until a protected, exact-target admission and
remote ledger proof are recorded.
