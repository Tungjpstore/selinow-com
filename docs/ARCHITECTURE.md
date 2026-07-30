# Architecture

Selinow is an Astro modular monolith deployed to Cloudflare Workers. Marketing, seller application, storefront, provider webhooks and background handlers share one deployable application while preserving explicit domain boundaries under `src/lib`.

The current production-shaped implementation has website and Telegram adapters. The accepted extension direction is channel-neutral: every future messaging, social or marketplace connector calls the same commerce application services and exposes only the capabilities it can safely support.

## Runtime shape

```text
Buyer / Seller / Provider
          |
          v
Cloudflare DNS + TLS + WAF + Turnstile
          |
          v
Astro Worker (one deployable modular monolith)
  - request context and tenant authorization
  - channel connection adapters
  - commerce application services
  - payment provider adapters
  - seller dashboard and storefront
  - webhook ingress and queue consumers
          |
          +--> D1: authoritative tenant, catalog, inventory, order,
          |        payment, fulfillment, entitlement, connection, generated-license
          |        and audit state
          +--> R2: validated media and controlled private exports
          +--> KV: reconstructable cache and opaque sessions
          +--> Queues: reference-only integration and notification jobs
          +--> Cloudflare for SaaS: custom hostname lifecycle
          +--> Provider APIs: Telegram, PayOS and future connectors
```

D1 remains authoritative for all transactional mutations. R2 and KV are not sources of truth for stock, payment, credentials, keys or subscription state. Queues carry small references and are safe to replay. The design does not use event sourcing, Kafka or a microservice per provider.

Environment identity remains separate from runtime activation. Staging has the accepted 28-migration runtime. Production now has reviewed D1/R2/KV/Queue/Turnstile resource identity and an empty-D1 backup/restore baseline, with non-secret identifiers intentionally pinned in `infra/environments/production.json`, `infra/generated/production.json` and `wrangler.jsonc` for fail-closed admission. The production D1 has no application tables or migration ledger, and no production Worker version, route/domain handoff or traffic has been promoted. Resource identity is therefore not a runtime or release claim.

## Request and tenant context

Request context must be resolved before business logic:

| Host/path | Context |
| --- | --- |
| `selinow.com` | Marketing/platform public |
| `app.selinow.com` | Seller dashboard and session membership |
| `api.selinow.com` | API and provider webhooks |
| `{slug}.selinow.com` | Tenant storefront |
| Active custom hostname | Tenant storefront after ownership and SSL checks |
| Opaque provider webhook ID | Connection lookup plus provider authentication |

Dashboard authority comes from an active membership row. Storefront authority comes from an active canonical hostname. Webhook authority comes from an opaque connection or webhook public ID plus provider verification. A client-provided `shop_id`, role or channel never becomes authorization authority.

## Module boundaries

- `auth`: magic links, sessions, CSRF, membership and platform-admin authorization.
- `tenants`: shop lifecycle, plans, entitlements, tenant resolution and readiness versioning.
- `catalog`: categories, products, variants, pricing, publishing and public projections.
- `inventory`: encrypted key import, fingerprints, reservation, allocation, release and revoke.
- `commerce`: channel-neutral cart, quote, discount, checkout, order access and fulfillment commands.
- `channels`: connection registry, capability calculation, inbound normalization, rendering and delivery ports.
- `telegram`, `meta`, `zalo`, `whatsapp` and future provider modules: provider API clients and adapter implementations only.
- `payments`: provider-neutral payment state and decision orchestration plus provider adapters such as PayOS.
- `domains`: platform subdomains, Cloudflare custom hostnames, ownership, SSL and canonical routing.
- `onboarding`: durable, resumable setup tasks derived from selected connection capabilities.
- `operations`: audit, redacted logging, queues, dead letters, backup/restore, rotation, abuse and deletion.
- `crypto`: envelope encryption, key versions, HMAC identities and secret redaction.

Provider request/response types must not cross into `commerce`, `inventory`, `orders`, `fulfillment` or payment decision code. The provider adapter maps external payloads to normalized commands, evidence or delivery receipts.

## Channel ports

Ports are capability-specific instead of one universal interface. A representative contract is:

```ts
type ChannelCapability =
  | "conversation.inbound"
  | "conversation.outbound"
  | "message.rich_ui"
  | "message.template_outside_window"
  | "catalog.read"
  | "catalog.publish"
  | "cart.interactive"
  | "checkout.external_link"
  | "checkout.native"
  | "orders.import"
  | "orders.status_push"
  | "fulfillment.push"
  | "fulfillment.inline_secret"
  | "identity.private"
  | "provisioning.managed";

interface ConnectionDriver {
  authorize(input: AuthorizationInput): Promise<AuthorizationResult>;
  connect(input: ConnectionInput): Promise<ConnectionResult>;
  healthCheck(connectionId: string): Promise<HealthResult>;
  disconnect(connectionId: string): Promise<void>;
}

interface InboundDriver {
  verifyAndNormalize(request: Request, connectionId: string):
    Promise<NormalizedInboundEvent[]>;
}

interface MessagingDriver {
  render(view: CommerceView, constraints: ProviderConstraints): OutboundCommand[];
  deliver(command: OutboundCommand): Promise<DeliveryReceipt>;
  classifyError(error: unknown): "retry" | "terminal" | "recipient_unavailable";
}

interface CommerceApplicationService {
  execute(context: CommerceContext, command: CommerceCommand): Promise<CommerceView>;
}
```

Adapters verify bounded raw requests, normalize identities and actions, render canonical views and deliver provider requests. They never reserve stock or create orders directly. The application service enforces tenant, plan, price, inventory, payment and fulfillment invariants once.

## Private downloadable fulfillment boundary

Private downloadable fulfillment is an additive capability beside the legacy `license_key|manual` columns. A product with a private-file policy remains legacy `manual`; typed policy, requirement, entitlement and grant tables carry the new semantics without rebuilding historical commerce tables.

D1 is authoritative for asset identity, policy version, order-item requirement, buyer binding, entitlement status, expiry and remaining quota. R2 stores bytes only under the private `MEDIA` namespace. The Worker never returns a permanent public object URL: it authorizes the order token, issues a short-lived grant whose verifier is stored as an HMAC-derived value, atomically consumes that one-use grant against the entitlement quota, verifies the R2 size/ETag/SHA-256 evidence and streams the response with private no-store headers.

Grant, entitlement and asset mutations always include `shop_id`. Audit and queue records contain references and safe counts only; standard seller export excludes object keys, bytes, buyer bindings, nonces and token/request hashes. Shop crypto-shred revokes access and deletes exact tenant objects only after the existing grace, provider-cleanup, lease, active-work and legal-hold fences pass.

The canonical checkout transaction now captures an active private-file policy and asset version immediately after its order items, in the same guarded D1 batch. The cart guard requires the exact policy/version/limits and active asset to still match, so policy drift rolls back the order rather than creating an unbound manual item. Pre-cutover orders without a requirement use only a deterministic policy interval at the order-item creation time; a policy added later cannot reinterpret an older manual purchase. Delivery remains website-only and uses the existing private prefix in `MEDIA`; Telegram secure handoff and a dedicated private-assets bucket remain follow-up work.

Seller-attested manual fulfillment is an additive per-item ledger in migration `0046_manual_fulfillment_executions.sql`. It records immutable owner/manager execution evidence and an optional hash-only external reference while retaining the legacy fulfillment/order rows as compatibility projections. Paid, tenant-bound, exact-quantity execution is idempotent and concurrent one-winner; a private-file order-item requirement is mutually exclusive with the manual ledger in both insertion directions. Standard exports and backup counts include safe metadata, while deletion retains the immutable financial/audit ledger and crypto-shreds no reference plaintext because none is stored.

## Generic entitlement boundary

Migration `0047_generic_entitlement_foundation.sql` adds a tenant-scoped six-table graph beside the legacy license-key, private-file and seller-manual paths: `entitlement_resources`, `product_entitlement_policies`, `order_item_entitlement_requirements`, `entitlements`, `entitlement_grants` and `entitlement_transitions`. Resources and versioned policies describe generated-license, membership, community-access, seat, device-activation and provider-access capabilities; immutable order-item requirements snapshot the exact resource, policy version, quantity, grant quantity and TTL accepted at checkout. D1 remains authoritative for entitlement identity and lifecycle, while provider credentials, generated key plaintext, private-file bytes and buyer tokens remain outside this graph.

Website, Telegram and `fake.third` enter the same canonical checkout transaction and receive the same guarded policy snapshots. Free checkout creates an `active` entitlement plus one immutable `free_checkout` grant. Paid checkout creates a `pending` entitlement; activation is permitted only while processing the exact signed and claimed payment event whose attempt is `paid_exact` and whose `paid_event_id` matches that event. Return URLs, QR rendering, partial, overpaid, late or mismatched payments never activate access.

Fulfillment classification is typed per order item. Legacy seller-manual rows are created only for manual items without a private-file or generic requirement; private-file requirements, generic requirements and seller attestation cannot reinterpret one another. Every generic lifecycle change is versioned and appends an immutable tenant-bound transition. Backup validation covers all six tables, standard exports expose safe lifecycle metadata only, and shop deletion retires active configuration and revokes live entitlements behind the existing legal-hold and crypto-shred fence while retaining immutable requirements, grants and transitions. The decision and trade-offs are recorded in `docs/adr/0016-generic-entitlement-foundation.md`.

## Payment reversal and access-revocation boundary

Migration `0048_payment_reversal_entitlement_revocation.sql` adds the immutable tenant-scoped `payment_reversal_events` ledger beside the authoritative payment attempt/event graph. Only provider-authenticated normalized metadata and HMAC/SHA-256-derived fingerprints are stored; raw provider references, payloads, credentials and secrets never enter the ledger, queue, audit metadata or seller export. Each event is bound by `shop_id` to the exact order, paid attempt, integration, credential version and original signed `paid_exact` event. Shop-scoped idempotency and provider-reference fingerprints make identical replays stable and changed evidence fail closed.

Only a verified exact full refund or exact chargeback may set the order payment state to `refunded`. The same atomic D1 batch revokes pending/active/suspended generic entitlements, appends immutable `payment_reversal` transitions, revokes active/suspended private entitlements and revokes active delivery grants. Sold inventory keys, fulfillment rows, generic/private grants and delivery-consumption history remain immutable evidence; a reversal closes future access but does not rewrite what was already delivered or consumed. Partial, currency/amount mismatched or otherwise non-exact evidence creates an open `manual_review` payment exception and leaves access unchanged.

Standard seller export schema version 5 exposes safe reversal and generated-license metadata only; it excludes reversal/generated-license hashes, credential/integration identifiers, ciphertext, IVs, endpoints, raw references and artifact plaintext. Backup schema/count validation includes `payment_reversal_events` and all generated-license tables, and shop deletion retains immutable reversal, request and attempt evidence together with the financial/audit ledgers. The decisions are recorded in `docs/adr/0017-payment-reversal-entitlement-revocation.md` and `docs/adr/0018-generated-license-provider-fulfillment.md`.

## Generated-license provider fulfillment boundary

Migrations `0049_generated_license_fulfillment.sql`, `0050_generated_license_deletion_lifecycle.sql`, `0051_generated_license_rotation.sql` and `0052_generated_license_request_hardening.sql` add the generated-license execution projection beside the generic entitlement graph. The eight tenant-scoped tables hold provider connections, encrypted credentials, resource bindings, immutable checkout requirement snapshots, requests, attempts, encrypted artifacts and a generated-license dead-letter ledger. D1 is authoritative for configuration, request/retry/reconciliation state, artifact state and operator remediation; provider state never marks an order paid or changes entitlement authority. Migration `0052` also freezes canonical request creation and terminal evidence while adding global due/lease and key-version indexes.

The `seller.webhook` adapter receives no D1 binding. It sends a small versioned provider-neutral request with a stable idempotency key and normalizes only provider results. `408`, `425`, `429` and `5xx` responses are retryable. Network failures and invalid successful responses are ambiguous: the request enters `reconcile_pending`, and the next attempt calls `reconcile` before any retry of `generate`. Permanent or exhausted failures retain immutable attempt evidence and open the generated-license DLQ.

Provider credentials use the credential key family and an AAD contract bound to purpose, key version, shop, connection, credential and field. Artifacts use the inventory key family and a separate AAD contract bound to purpose, key version, shop, request, artifact and format. AES-GCM ciphertext, IVs and fingerprints remain in D1; plaintext exists only in bounded provider-call or buyer-reveal memory. Queue envelopes and DLQ rows contain references and safe context only, never credentials, provider payloads, customer secrets or artifact plaintext.

The generated request is materialized only after an active generic entitlement and grant: a free checkout after its `free_checkout` grant, or a paid checkout after the exact signed/claimed unprocessed `paid_exact` event activates the entitlement. Website, Telegram and `fake.third` share this canonical transaction and payment fence. Exact payment reversal cancels pending, retryable, reconcile-pending and processing requests locally, revokes active artifacts and performs no provider I/O; immutable request, attempt, fulfillment and consumption evidence remains. The existing Website order-key route and Telegram principal fulfillment boundary reveal generated artifacts alongside pooled keys only while payment, tenant/channel/customer access and entitlement TTL fences pass. Deletion retires configuration, cancels local non-terminal work, destroys credential/artifact ciphertext behind the existing fences and retains immutable evidence. Credential and artifact re-encryption use separate resumable rotation families. This slice is source/local-only: staging remains at 28 applied migrations through `0028` with 24 source migrations (`0029`-`0052`) pending. Production resources exist only at the empty-bootstrap identity/recovery layer; no production schema, Worker traffic or route/domain promotion exists, and release remains `NO-GO`.

## Connection and capability model

The target data model adds generic concepts without deleting provider detail prematurely:

- `shop_channels`: logical channel selected by a shop and its entitlement/readiness.
- `channel_connections`: concrete bot, page, phone, account or marketplace connection; multiple connections of a provider may belong to one shop.
- `channel_credentials`: encrypted, versioned credential envelope with provider schema version and fingerprint.
- Channel-scoped customer identities and encrypted outbound recipients.
- Provider event receipts and action claims for replay and duplicate protection.
- External order references and order attribution for native marketplace orders and multi-touchpoint journeys.

Effective capabilities are the intersection of adapter support, provider grants, plan entitlement, seller settings and current connection health/policy state. Provider constraints such as text limits, media formats, messaging windows, approved templates and secure-secret delivery are stored separately from capability names. Unsupported operations fail closed in both server authorization and UI projection.

Migration uses forward-only migrations, dual-read or dual-write, backfill, verification and explicit cutover. Existing `web|telegram` data is preserved while the generic registry is introduced; existing migrations are never edited.

## Event and delivery boundaries

The standard flow is:

```text
provider webhook
  -> signature/secret verification and body bounds
  -> provider event receipt and dedupe
  -> normalized inbound envelope
  -> commerce command or native-order command
  -> D1 transaction + reference-only domain event
  -> queue message containing event ID and schema version
  -> per-connection delivery job
  -> provider rendering, delivery and receipt
```

Domain events include stable references such as `order.created`, `payment.confirmed`, `fulfillment.ready`, `inventory.low`, `catalog.changed` and `shop.suspended`. A single event fans out to independent `(event, connection, purpose)` deliveries. Delivery retry or dead-letter state never re-runs inventory allocation or payment confirmation.

Provider webhooks must acknowledge within the provider deadline, but business work may continue asynchronously when the channel permits it. All inbound events, commands and deliveries have idempotency keys scoped to tenant and connection. Queue payloads never contain provider credentials, customer secrets or license-key plaintext.

## Payment boundary

`payments` owns payment attempts, signed evidence, conservative decisions, exceptions and fulfillment eligibility. A provider port handles credential health, payment-link create/recovery, webhook verification/normalization, reconciliation and explicitly supported cancel/refund operations. PayOS remains the first adapter and retains its exact signing, order-code, credential-version and webhook rules inside the PayOS module.

The provider-neutral payment projection is separate from the channel connection registry. Migration `0035_payment_provider_connections.sql` adds tenant-scoped provider connections plus capability, currency and method support projections with descriptor/policy versions, settlement/credential ownership, country evidence and verified account fingerprints. Its deterministic PayOS backfill links each projection row to one legacy PayOS integration and grants only the capabilities the current adapter implements. Migration `0036_payos_identity_claim_hardening.sql` removes unverified legacy identity claims, `0037_legacy_payos_tenant_guards.sql` validates/guards exact shop/provider relationships across legacy integrations, credentials, attempts, events, exceptions and paid-event pointers, and `0039_payment_provider_identity_shred.sql` permits releasing provider identity evidence only inside the admitted deletion crypto-shred fence. These migrations are additive and source/local-only; legacy PayOS tables and runtime remain authoritative, and effective authorization must be recomputed from current adapter support, grants, plan/policy, health and eligibility rather than trusting a persisted flag.

Marketplace-native payment is imported only from authenticated provider evidence and remains linked to the owning external order and connection. Return URLs never confirm payment. Platform-held funds, split settlement, payouts and balance accounting require a separate legal and architectural decision.

## Public API credential boundary

The public API is a separate server-to-server trust boundary from seller sessions, storefront host resolution and provider webhooks. Owners manage credentials through recent-authenticated dashboard routes; create and revoke mutations require CSRF protection, an idempotency key and tenant-scoped audit evidence. A token is environment-bound, revealed once and retained only as a purpose-bound HMAC digest. Credential identity, tenant, fixed scope and expiry are immutable, revocation is optimistic-version guarded and physical deletion is prohibited so the security lifecycle remains auditable.

Public requests authenticate a Bearer token before loading application data. The credential, not a request path, body, query or header supplied by the client, selects the authoritative `shop_id`. Authentication then rechecks active/unexpired credential state, exact scope, shop lifecycle and subscription eligibility, applies a D1-backed per-credential fixed-window rate limit and updates safe last-use telemetry without changing the revocation version. Responses remain private and non-cacheable.

The first bounded surfaces are `GET /api/v1/shop` (`shop:read`) and `GET /api/v1/catalog` (`catalog:read`, or the canonical combined scope). They return minimal tenant-derived projections and do not authorize inventory, order, payment, fulfillment, entitlement or webhook operations. New scopes require an explicit resource/operation matrix, tenant-isolation and concurrency coverage, lifecycle/export/deletion updates and a reviewed expansion of the credential grant model; client-provided tenant overrides remain invalid.

## No-tech onboarding boundary

The product goal is zero technical configuration after required consent or ownership confirmation. A seller does not run a CLI, edit Worker configuration, construct webhook URLs or handle platform credentials.

Connections support `managed` and `bring_your_own` modes. Managed resources make onboarding immediate but require per-tenant routing, abuse controls, rate limits and provider policy ownership. BYO connections prefer OAuth or one-click consent; copied credentials are a fallback only when the provider offers no delegated authorization.

Onboarding is a durable task graph with `pending`, `running`, `waiting_user`, `waiting_provider`, `retryable`, `succeeded`, `failed` and `canceled` states. Each executor is idempotent, leased or version-guarded, auditable and safe to resume. Readiness is derived from selected required capabilities and fresh evidence, not a fixed Telegram/PayOS checklist.

The Selinow subdomain is always the immediate no-DNS path. Custom domains use managed DNS authorization when supported and exact TXT/CNAME fallback otherwise. Manual DNS is not described as one-click automation.

## Frontend and tenant theming

The dashboard and storefront share semantic design tokens. Seller branding is projected through constrained tokens so it cannot reduce text, focus, error, payment or security-state contrast. New connector screens must include loading, empty, blocked, retry and success states.

Release acceptance includes WCAG AA contrast (4.5:1 normal text and 3:1 large text/UI where applicable), keyboard focus and order, reduced motion, touch targets, mobile review and deterministic visual regression. No status may rely on color alone.

## Scaling and extraction rule

Stay in the modular monolith until measurements show an independently scaling provider workload, a provider-specific compliance or availability boundary, repeated cross-provider deployment incidents, or a team boundary that cannot be handled by module ownership. If extraction becomes justified, extract the adapter or queue consumer first; keep D1 commerce invariants and public application contracts stable.

## Related ADRs

- [ADR 0001: Modular monolith on Cloudflare](adr/0001-modular-monolith-on-cloudflare.md)
- [ADR 0002: Secret and environment boundaries](adr/0002-secret-and-environment-boundaries.md)
- [ADR 0003: Opaque sessions and tenant-scoped authorization](adr/0003-opaque-sessions-and-tenant-authorization.md)
- [ADR 0004: Atomic inventory reservation and encrypted key storage](adr/0004-atomic-inventory-reservation.md)
- [ADR 0005: Tenant-owned PayOS credentials and payment decisions](adr/0005-tenant-payos-and-payment-decisions.md)
- [ADR 0006: Tenant-owned Telegram bots and private commerce](adr/0006-telegram-multibot-and-private-commerce.md)
- [ADR 0007: Channel-neutral commerce core and adapter ports](adr/0007-channel-neutral-commerce-core.md)
- [ADR 0008: Extensible channel connections, identities and capabilities](adr/0008-extensible-channel-connections-and-capabilities.md)
- [ADR 0009: No-tech onboarding and automation boundary](adr/0009-no-tech-onboarding-automation-boundary.md)
- [ADR 0010: Managed domain connection strategy](adr/0010-managed-domain-connection-strategy.md)
- [ADR 0011: Accessible design system and tenant theming](adr/0011-accessible-design-system-and-tenant-theming.md)
- [ADR 0012: Provider-neutral payment orchestration](adr/0012-provider-neutral-payment-orchestration.md)
- [ADR 0013: Additive private-download fulfillment](adr/0013-additive-private-download-fulfillment.md)
- [ADR 0014: Public API credential boundary](adr/0014-public-api-credential-boundary.md)
- [ADR 0015: Seller-attested manual fulfillment ledger](adr/0015-seller-attested-manual-fulfillment-ledger.md)
- [ADR 0016: Generic entitlement foundation](adr/0016-generic-entitlement-foundation.md)
- [ADR 0017: Payment reversal entitlement revocation](adr/0017-payment-reversal-entitlement-revocation.md)
- [ADR 0018: Seller webhook generated-license fulfillment](adr/0018-generated-license-provider-fulfillment.md)

Provider discovery and current onboarding constraints are tracked in [Channel Provider Research](CHANNEL_PROVIDER_RESEARCH.md). It is directional evidence only; no provider is considered implemented until its contract, policy and staging acceptance gates pass.
