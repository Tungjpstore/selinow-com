# Delivery Plan and Acceptance

## Current continuation overlay (2026-08-03)

The current source acceptance inventory is 25 canonical logical routes, 87 acceptance scenarios, 150 API/webhook method/path rows and migrations `0001`-`0077`. Local `check`, lint, full tests, build and deploy dry-runs are necessary but not sufficient for production. The expanded provider lanes, Dodo billing and activation analytics remain source/local contract evidence until remote migrations, fresh protected backup/restore, credential/UAT, pilot, monitoring, rollback and ownership evidence are recorded.

## 1. Delivery discipline

Mỗi phase phải tạo:

- Working code.
- Forward migration nếu cần.
- Unit/integration/smoke tests.
- Documentation/config updates.
- Entry trong `docs/IMPLEMENTATION_STATUS.md`.
- Acceptance evidence bằng command/output hoặc controlled test.

Không đánh dấu phase complete chỉ vì route/UI đã tồn tại.

## Phase 0 — Repository bootstrap

### Deliverables

- Astro 7 + Cloudflare adapter + strict TypeScript.
- `AGENTS.md` dựa trên template.
- Lint, check, test, build, deploy-dry-run scripts.
- Environment config template và secret policy.
- Base security headers/error response/request ID.
- Docs/ADR/status skeleton.

### Acceptance

- Clean install works.
- Background dev server starts/stops.
- Check/test/build pass.
- No production ID/secret hard-coded.

## Phase 1 — Infrastructure provisioning

### Deliverables

- Idempotent Cloudflare doctor/provision scripts.
- D1/R2/KV/Queues bindings.
- Local/staging/production separation.
- Initial migrations and seed.
- CI/deploy dry run.

### Acceptance

- `--dry-run` reports intended actions without mutation.
- Re-running provision creates no duplicate resource.
- Missing credential returns actionable error without printing secret.
- Staging deploy responds on expected host.

## Phase 2 — Tenant, auth and subscription core

### Deliverables

- Seller signup/login/session/CSRF.
- Shop create/slug/reserved list.
- Membership roles.
- Plan/subscription/entitlement guards.
- Platform admin shell and shop suspension.
- Tenant isolation test harness.

### Acceptance

- User creates one shop idempotently.
- Tenant A cannot read/write tenant B.
- Suspended shop cannot receive new checkout.
- Session fixation/CSRF negative tests pass.

## Phase 3 — Catalog, inventory and orders

### Deliverables

- Categories/products/variants CRUD and publish.
- CSV/paste key import with encryption/fingerprint.
- Public catalog projection.
- Cart, quote, checkout and reservation expiry.
- Order access token/customer identity.
- Atomic inventory allocation and concurrency tests.

### Acceptance

- Duplicate key import rejected without echoing plaintext.
- Two concurrent buyers cannot buy one last key twice.
- Price/stock changed after cart is revalidated at checkout.
- Expired unpaid order releases reservation once.

## Phase 4 — PayOS per tenant

### Deliverables

- Encrypted credential connection/rotation.
- Payment link create/recovery.
- Confirm-webhook automation.
- Signed webhook handler.
- Payment decision engine.
- Reconciliation cron/queue.
- Exception inbox.

### Acceptance

- Exact signed payment marks paid and fulfills once.
- Duplicate/replayed webhook has no duplicate side effect.
- Partial/overpaid/late/mismatch do not auto-fulfill.
- Return URL cannot mark paid.
- Cross-tenant credentials/order mapping rejected.

## Phase 5 — Telegram multi-bot

### Deliverables

- Seller bot-token onboarding.
- `getMe`, commands, menu and webhook automation.
- Multi-bot webhook routing and secret verification.
- Telegram catalog/cart/checkout/orders/keys.
- Paid notification outbox.
- Token rotation/disconnect/health.

### Acceptance

- Two shops with two bots remain isolated.
- Duplicate update does not duplicate order.
- Group chat cannot view order/key.
- Paid notification retry does not allocate new key.
- Revoked token surfaces degraded health safely.

## Phase 6 — Storefront and platform subdomain

### Deliverables

- Marketing/pricing.
- `{slug}.selinow.com` tenant routing.
- Branded storefront, product/cart/checkout/status/key reveal.
- Static-first assets and safe cache.
- Turnstile/rate limiting where required.

### Acceptance

- Unknown/reserved hostname cannot map to tenant.
- Tenant cache does not mix content.
- Mobile checkout works.
- Paid website buyer can reveal only own order keys.

## Phase 7 — Custom domains

### Deliverables

- Cloudflare for SaaS setup automation.
- Custom hostname create/poll/delete.
- DNS instruction UX.
- SSL/hostname readiness.
- Primary/canonical domain switching.

### Acceptance

- Domain not active until hostname + SSL + DNS pass.
- Duplicate hostname claim blocked.
- Repeated create/poll is idempotent.
- Domain removal stops routing and purges cache.
- Concurrent create/restore/poll/delete cannot publish stale provider state or emit a false conflict after another request commits the live domain row.
- Active payment-origin snapshots block unsafe domain removal and remain tenant-scoped.

## Phase 8 — Automated onboarding

### Deliverables

- Resumable setup wizard.
- Server-side onboarding task engine with idempotent executors, leases/version guards and safe resume after refresh or provider timeout.
- Dynamic readiness engine derived from selected required capabilities instead of a fixed Telegram/PayOS-only checklist.
- Product/key import onboarding.
- Managed and bring-your-own connection modes; OAuth/one-click consent is preferred and copied credentials are a bounded fallback.
- Telegram/PayOS connection checks through the current adapters, with a connector manifest path for future providers.
- Test-order/health workflow.
- Publish gate and actionable error codes.
- Instant website/subdomain preview that does not require Telegram, a custom domain or production provider credentials.

### Acceptance

- Fresh seller reaches published shop without CLI/support.
- Refresh/retry does not duplicate provider/resource state.
- The seller never constructs webhook URLs, edits Worker configuration, handles infrastructure credentials or needs DNS for the default subdomain.
- An unavoidable provider consent, ownership or review step is classified as `waiting_user` or `waiting_provider` and explained through one precise action; it is not represented as a technical failure.
- Publish cannot bypass critical checks through client manipulation.
- Onboarding profile, step progress and readiness evidence resume from server state and never leak across shops.
- Inventory confirmation requires the matching unexpired preview token; failed, expired or tampered previews write no keys.
- Telegram readiness requires successful private `/start` evidence for the active bot, and PayOS readiness uses a fresh provider health check.
- Test-order mode is controlled and does not allocate a real key, create a real payment or mark an order paid.
- Publish re-runs fresh server checks against the current readiness version instead of trusting cached UI state.
- Acceptance records time to first preview, time to live, support-free completion and blocking-code distribution.

## Phase 9 — Operations, security and platform extensibility hardening

### Phase A — Canonical commerce cutover

#### Requirements

- Website, Telegram and the reusable fake adapter enter commerce through one explicit `CommerceApplicationService` contract; adapters authenticate/normalize input and render/deliver output without owning canonical commerce state.
- The Website storefront buyer-route inventory is exhaustive for cart, quote, checkout, recovery, order, payment, key and private-download handlers. Telegram dispatch/runtime and application ports have separate boundary guards because they are not HTTP storefront routes.
- Website and Telegram delegate order, reservation and fulfillment writes to one provider-neutral checkout transaction. Provider I/O clients receive no D1 binding, and provider roots/route handlers are statically guarded against direct canonical-state writes or low-level state-store imports.
- Signed quote evidence binds tenant/shop, cart, item/product identity, quantity, unit price, product version, variant version, discount/pricing state and bounded expiry. Checkout revalidates the signed evidence against authoritative cart/catalog state inside the guarded flow.
- Replay admission binds tenant, actor/subject, cart proof, normalized channel attribution, connection where applicable, request hash and immutable order-access proof. Same-key/same-payload retries recover one durable winner; changed pricing, discount, catalog version, attribution or payload fails closed.
- Inventory and checkout concurrency preserve tenant isolation, one-last-stock-winner behavior, retry-safe reservation/fulfillment and no partial order state after a losing batch.

#### Acceptance and admission boundary

- Real local-D1 Website and Telegram scenarios must produce equivalent price, discount, reservation, order and fulfillment state for representative free, paid, manual, replay/conflict and last-stock cases.
- The fake adapter must separately pass the same real-D1 commerce parity scenarios before three-adapter parity is accepted. This gate is now met locally: the `fake.third` adapter enters `PrincipalChannelCommercePort` and the shared canonical checkout transaction, and the dedicated real-D1 matrix covers free, paid, manual, discounted, drift, replay/conflict, capability, tenant, rollback, cart-concurrency and last-stock cases. Contract, capability, inbound/outbound and retry tests alone would not satisfy this gate; controlled provider acceptance and staging admission remain separate gates.
- Source guards must find no direct canonical commerce SQL writes or forbidden state-store imports in the enumerated provider roots, Telegram runtime/port and Website buyer-route handlers. This is static boundary evidence, not a claim about unenumerated indirect runtime effects.
- Local source/test acceptance does not authorize staging. Staging migration, seed or deploy remains blocked until the live route inventory, exact account/D1 identity, fresh report-v2 backup and immediate admission rechecks pass; production remains out of scope.

#### Current local evidence (2026-07-30)

- The current fake/real-D1 seam refresh passed `106/106` tests across five focused files; `tests/unit/commerce-channel-parity-real-d1.test.ts` contributes 72 cases. The same run passed canonical Website recovery with and without discounts, order-insensitive retry/recovery, the canonical checkout boundary, fake adapter acceptance, channel registry and normalized attribution coverage.
- Fake orders retain `orders.source_channel='web'` only to satisfy the legacy cart/order storage contract. The authoritative attribution is `order_channel_attributions(channel_code='fake.third', adapter_version=1, connection_id=...)`, scoped to the tenant and exact connection.
- This local evidence does not authorize migrations `0029`-`0077`, a staging deploy, external provider traffic or any continuation production action. Staging remains gated by live route inventory, exact account/D1 identity, fresh report-v2 backup and immediate rechecks.

### Phase B — Global localization foundation

#### Requirements

- English is the global fallback and Vietnamese remains complete; `en` and `vi-VN` use the same commerce state machines and authoritative tenant/order data.
- User-facing Telegram, storefront, dashboard, checkout, order, payment, fulfillment, email and safe-error copy comes from reviewed catalogs. Runtime machine translation is not used.
- Locale resolution is explicit buyer preference, verified channel identity/cookie, request language, shop default, then English. Each persisted preference must be distinguishable from an inferred effective locale.
- Locale input uses bounded BCP47 parsing, HTML roots expose the resolved `lang`/`dir`, and the shared UI is prepared for logical-direction RTL behavior even before an RTL product locale is enabled.
- Currency uses a reviewed ISO 4217 allowlist and authoritative integer minor units. USD/EUR use two minor digits; JPY/VND use zero. Formatting is locale-aware, no exchange-rate conversion is inferred, and an order has one immutable currency matching the admitted shop/catalog contract.
- Merchant and business country use ISO-3166 alpha-2 validation and are configurable through a truthful seller surface when the backend contract exists.
- Missing/extra catalog keys and source references are detected by tests or a build check; runtime fallback remains safe and never exposes an internal translation key.

#### Acceptance and admission boundary

- Paired English/Vietnamese commerce scenarios exercise the same cart, quote, checkout, order, payment-status and fulfillment logic with only presentation differences.
- Telegram has no hard-coded locale formatter and preserves a durable buyer-explicit preference ahead of verified identity, request language and shop default.
- USD, EUR, JPY and VND format with the registered minor units; unsupported currencies and shop/variant/order currency drift fail before order, reservation, payment or fulfillment mutation.
- Unsupported locales fall back to English; missing catalog/source keys fail a local test or build gate.
- Country, locale and currency values are validated at service and D1 boundaries. Seller onboarding/settings country, currency and default-locale controls write the real tenant-scoped shop contract and remain subject to visual review.
- Local acceptance does not authorize staging. Migrations `0031`-`0052` and the related source slices remain staging-pending behind the normal live-route, exact identity and fresh-backup admission; production remains out of scope.

#### Current local evidence and remaining work (2026-07-30)

- Exact catalog parity is present for dashboard (1,296 keys), admin (445), storefront (294), marketing (177), onboarding (388), system (173), common (6) and Telegram (82). Focused tests cover English fallback, Vietnamese aliases, locale-aware money/date rendering, Telegram notification copy and HTML `lang`/`dir` roots.
- The currency registry currently formats USD/EUR with two minor digits and JPY/VND with zero, performs no FX conversion, and D1 guards shop/variant supported-currency matching. ISO country reference and service/D1 validation are covered locally.
- Phase B source/local acceptance is complete. Source-level translation-key and placeholder detection, unified BCP47 validation across commerce/Telegram boundaries, durable Telegram explicit preference, canonical order/shop currency validation and immutability, seller merchant/business-country controls, paired English/Vietnamese commerce evidence and the RTL logical/render gate are closed locally. The authenticated local browser gate passes `7/7` across desktop/mobile and 1440/768/390/320px plus the 200% geometry project; 42 current-source snapshots at 1440x1024 and 390x844 were regenerated and manually reviewed.
- The historical PromptOS route matrix defines 19 routes and 82 route-state pairs. The current rebuild handoff supersedes it with 25 canonical routes, 87 acceptance scenarios and 148 API rows; local visual fixtures cover 21 authenticated and 13 public surface/state IDs (42 and 26 exact-viewport snapshots respectively). Staging hydrated-cart acceptance remains open because the deployed Worker lacks the current selector; no staging baseline was regenerated.

### Phase C — Verified payment-reversal access revocation

#### Requirements

- Migration `0048_payment_reversal_entitlement_revocation.sql` is forward-only and source/local-only. It adds an immutable, tenant-scoped hash-only reversal ledger and must not be treated as applied until the guarded staging migration sequence is admitted.
- Only verified signed-webhook or direct-reconciliation evidence bound to the exact shop, paid attempt, provider, integration, credential version and original paid event may enter the ledger. Return URLs, QR rendering, seller input and unverified provider messages cannot mark a reversal or revoke access.
- Exact full refunds and exact chargebacks atomically set the order to `refunded`, revoke generic pending/active/suspended entitlements and append immutable `payment_reversal` transitions, revoke private active/suspended entitlements and active delivery grants. Sold keys, fulfillment and delivery-consumption history remain retained.
- Partial, amount/currency-mismatched or otherwise non-exact evidence creates an open `manual_review` payment exception and does not revoke access. Same-evidence replays return the durable result; changed evidence, idempotency, provider-reference or tenant bindings fail closed.
- Standard seller export schema version 4 was the historical `0048` reversal-only checkpoint; current schema version 5 through `0052` retains the same safe normalized reversal metadata while adding generated-license lifecycle metadata. Reversal hashes, raw provider references, credential/integration IDs and payloads remain excluded. Backup counts include `payment_reversal_events`, and deletion retains the immutable financial/audit ledger.

#### Acceptance and admission boundary

- Focused migration/service/lifecycle/backup coverage proves exact refund/chargeback revocation, partial/mismatch manual review, unverified rejection, replay/conflict, concurrent one-winner behavior, tenant isolation, access fencing and retained sold-key/fulfillment/consumption evidence. The post-`0048` source/local gate is a historical checkpoint (176 files / 1,287 tests, build, staging build, both deploy dry-runs and an isolated restore through 48 migrations). This evidence still does not authorize staging mutation.
- Staging remains accepted through `0028` with 49 pending source migrations `0029`-`0077`. Apply or deploy only after live route inventory, exact account/D1 identity, fresh report-v2 backup and immediate rechecks pass. Production has the admitted platform handoff and schema through `0052`; continuation migrations, provider activation and commerce traffic remain `NO-GO`.

### Phase C — Generated-license provider execution

#### Requirements

- Migration `0049_generated_license_fulfillment.sql` is forward-only and projects seller-webhook execution onto the generic entitlement graph; v1 permits exactly one generated artifact per entitlement.
- A free grant may create a generated request immediately; a paid request may be created only inside the exact signed/claimed `paid_exact` activation. Return URLs, QR rendering, partial, overpaid, late, mismatched or unverified payment evidence cannot create or fulfill a request.
- Provider adapters are D1-free and receive only a neutral request, decrypted endpoint and credential in memory. They cannot create orders, reserve inventory, mark payment, grant entitlement or reveal an artifact.
- Every request is tenant-bound, idempotent and lease/CAS claimed. Retryable failures are backoff-scheduled; ambiguous acceptance enters reconciliation before any second generate call; permanent or mismatched results become safe dead letters/manual review.
- Successful provider output is encrypted immediately with the inventory KEK and generated-license AAD. Queue, DLQ, audit and export projections contain only request/shop references, versions and safe codes; no provider credential, provider reference, ciphertext, key, artifact plaintext or buyer token is persisted in those payloads.
- Generated orders stay `processing`/`unfulfilled` until every generated request succeeds. Reversal cancels pending work and revokes artifacts; shop deletion waits for live leases, crypto-destroys generated secrets/artifacts and retains immutable request/attempt/snapshot evidence; migration `0051` adds resumable credential/artifact rotation with generated-specific AAD and `0052` hardens request transitions/evidence and scheduler indexes.

#### Acceptance and admission boundary

- Migration, crypto, service, provider-boundary, worker, queue/DLQ, reversal, export, deletion, rotation, request-hardening and backup coverage passes locally. Website, Telegram and `fake.third` free/paid real-D1 parity covers attribution, exact-payment fencing, replay/conflict and cross-tenant isolation. The historical full-repository checkpoint was 188 files / 1,423 tests; the current source gate is recorded in the handoff manifest. The fresh local restore through `0052` remains historical evidence; a current-chain protected backup/restore admission is still required.
- Standard export is schema version 5 with safe generated metadata only. Backup validation includes all eight generated-license tables. Seller configuration remains service-level/source-local, while the existing Website order-key route and Telegram principal fulfillment boundary now reveal generated artifacts under payment, tenant/channel/customer and TTL fences. The historical PromptOS frontend checklist passes 19/19; the authenticated local browser gate passes 7/7 across desktop/mobile and 1440/768/390/320px plus 200% geometry, with 42 authenticated and 26 public current-source snapshots manually reviewed. The active rebuild handoff is 25 routes / 87 acceptance scenarios; staging visual acceptance remains 18/20 because the deployed Worker lacks `[data-cart-variant-id]`.
- Staging has 49 pending source migrations (`0029`-`0077`); no staging migration/deploy is admitted until live route inventory, exact account/D1 identity, fresh report-v2 backup and immediate rechecks pass. Production remains on the admitted `0001`-`0052` baseline; continuation/provider activation evidence is still missing and release remains `NO-GO` for those changes.

### Deliverables

- Structured redacted logs and metrics.
- Queue/outbox DLQ dashboard.
- Backups/restore drill.
- Credential/encryption rotation operator workflow with dry-run and resumable bounded processing.
- Data export/deletion workflow.
- Abuse/suspension tools.
- Incident runbooks.
- Accepted channel-neutral architecture and forward-only migration plan from fixed website/Telegram state.
- Channel connection/capability registry that can represent multiple provider resources per shop without spreading provider types into commerce.
- Shared commerce application service for website, Telegram and a fake third adapter; adapters only verify, normalize, render and deliver.
- Reference-only domain events and per-connection delivery jobs using the existing integration/notification Queues; cron remains a reconciliation fallback.
- Provider-neutral payment port that preserves PayOS-specific signature and credential rules inside the PayOS adapter.
- Additive provider-payment persistence: tenant-scoped connection/capability/currency/method projections, deterministic PayOS backfill, versioned descriptor/policy evidence, cleanup of unverified legacy identity claims, exact legacy PayOS tenant/provider relationship guards and deletion-fenced provider identity release (`0035`-`0037`, `0039`); legacy PayOS tables/runtime remain authoritative.
- Bounded public API foundation: owner-managed one-time-reveal credentials, tenant-derived Bearer authentication, D1-backed rate limiting, `GET /api/v1/shop` (`0038`), `GET /api/v1/catalog` (`0040`), and source/local `inventory:read`/`orders:read` projections (`0068`). Fulfillment, entitlement and outbound webhook subscriptions remain separate follow-up work.
- Semantic design system and constrained tenant theming with contrast, keyboard, responsive and visual-regression gates.

### Acceptance

- Secret/key redaction tests pass.
- Restore drill succeeds in isolated environment.
- Rotation dry-run and one controlled rotation succeed.
- Queue/provider failure produces retry/manual-review state, not silent loss.
- DLQ and incident acknowledge/retry/resolve transitions are bounded, audited, version-guarded and tenant-scoped.
- Standard export never decrypts inventory keys; plaintext-key export requires explicit high-risk acknowledgement and a one-time download token.
- Failed export decryption does not consume the download token, and private export objects never use the public media bucket.
- Shop deletion is resumable, respects payments, grace periods and legal holds, and cannot crypto-shred or finalize from a stale lease.
- Encryption rotation targets the active write version, blocks overlapping family runs, survives replay after old-key retirement and emits aggregate audit evidence.
- Abuse reporting and moderation redact reporter data, preserve evidence and reject cross-shop actions.
- Audit records are immutable and operational logs do not expose secrets, provider payloads or license-key plaintext.
- The same normalized cart/checkout scenarios through website, Telegram and a fake adapter produce equivalent price, discount, reservation, order and fulfillment state.
- Duplicate provider events cannot repeat a commerce command; one `payment.confirmed` or `fulfillment.ready` event can fan out to multiple independent delivery jobs.
- Unsupported capabilities are hidden from projections and rejected server-side; provider grants, plan entitlements and connection health are all enforced.
- Forward-only migration/backfill preserves existing website and Telegram orders, identities, payment attempts and fulfillment references before cutover.
- The payment projection preserves every legacy PayOS integration/credential/attempt/event/exception row, enforces same-tenant links and truthful capability grants, and fails closed on stale health, webhook, identity or descriptor/policy evidence. Source/local verification must include migration tests, conditional preflight checks, a backup schema/count pass and an isolated restore through the current numbered ledger before staging admission.
- API credential management is owner-only and recent-authenticated; issue/revoke mutations are CSRF-protected, idempotent, optimistic-version guarded and audit-once. Plaintext tokens are revealed once, only keyed digests persist, expired credentials do not consume active capacity and revocation races fail closed.
- Public API authentication derives the tenant only from the credential, rejects inactive/expired/wrong-environment tokens, rechecks scope plus shop/subscription state and enforces a D1 authoritative per-credential rate limit. Cross-tenant overrides and public responses containing token/hash material are rejected by contract tests.
- Export, deletion, backup and isolated restore cover safe API credential lifecycle metadata. Acceptance of this foundation includes only the bounded `shop:read` and `catalog:read` projections; it does not claim inventory, order, payment, fulfillment, entitlement or outbound-webhook public APIs.
- Cloudflare Queue payloads contain references only and no credential, customer secret or license-key plaintext.
- Representative dashboard/storefront states pass automated accessibility checks, deterministic desktop/mobile visual regression and manual keyboard review.
- Normal text meets at least 4.5:1 contrast and large text, meaningful icons, focus indicators and applicable UI boundaries meet at least 3:1.

## Phase 10 — Production release

### Deliverables

- Production resources/domain/secrets.
- Migrations with backup/bookmark.
- Controlled seller pilot.
- Controlled low-value payment test.
- Telegram end-to-end test.
- Custom domain test.
- Monitoring/budget alerts and rollback plan.
- Reviewed Phase 9 channel-core migration and rollback evidence; production may still launch with only website and Telegram enabled.

### Acceptance

- At least two isolated pilot shops.
- At least one pilot completes the website/subdomain launch path without CLI, DNS editing, webhook construction or infrastructure credentials; unavoidable merchant/provider consent is the only external action.
- Website + Telegram share same inventory and fulfillment correctly.
- Website and Telegram exercise the same commerce application contract; provider-specific code does not own reservation, payment confirmation or fulfillment allocation.
- Payment-to-key path verified with real signed PayOS event.
- Staging acceptance, production doctor, reviewed release manifest, backup freshness and isolated restore evidence all pass.
- Cloudflare Email Sending delivery and acknowledgement path are verified without exposing magic-link tokens.
- One external custom domain passes hostname, SSL, DNS, tenant-rendering and removal acceptance.
- No critical/high security issue open.
- Monitoring and budget alerts have tested acknowledgement paths.
- Release, data, payment, integration, domain, rollback and support ownership are documented and available for the change window.
- Accessibility and visual-regression release gates pass for the seller onboarding, dashboard, storefront, checkout and order reveal paths.

## Phase 11 — Managed activation and connector proof

### Deliverables

- Managed Selinow channel mode for at least one provider, with tenant routing, per-shop quotas, abuse controls and health isolation.
- A fake third adapter in CI that exercises connection, inbound, commerce, outbound and retry contracts without live credentials.
- Generic connection dashboard and onboarding task projection driven by server manifests.
- Managed DNS connector discovery for the highest-demand supported provider; exact TXT/CNAME fallback remains available.

### Acceptance

- A fresh seller can publish a website/subdomain and activate the managed channel without copying a token, creating a webhook or contacting support.
- Two shops sharing a managed provider resource cannot read or mutate each other's catalog, cart, identity, order, quota or delivery state.
- Connector refresh/retry/disconnect is idempotent and auditable.
- Managed DNS is called one-click only when ownership, routing and verification complete without manual record entry.

## Phase 12 — Messaging and social channel expansion

### Deliverables

- Provider discovery and access gate for Zalo Official Account, Messenger/Instagram and WhatsApp Cloud API.
- Zalo OA pilot prioritized for Vietnamese seller demand, followed by shared Meta primitives for Messenger and Instagram.
- WhatsApp adapter with customer-service window, approved-template and delivery-receipt constraints.
- Provider-specific UX rendering that degrades safely when rich UI, inline fulfillment or proactive messaging is unavailable.

### Acceptance

- Each live adapter passes signature/secret verification, replay, identity-scope, rate-limit, timeout, retry and disconnect tests.
- Messaging windows and template requirements block non-compliant outbound sends before provider calls.
- A provider without safe inline-secret delivery uses an authorized Selinow reveal flow instead of sending plaintext keys.
- Adding the adapter does not introduce provider branches into commerce, inventory, order or fulfillment state transitions.

## Phase 13 — Marketplace commerce track

### Deliverables

- Separate marketplace capabilities for catalog publish/pull, native checkout, order import, status push and fulfillment push.
- TikTok Shop, Shopee and Lazada discovery based on partner access, seller demand and current digital-goods policy eligibility.
- External order identity, immutable provider snapshots, reconciliation and exception handling.
- Inventory synchronization with bounded leases, idempotent change references and conflict/manual-review states.

### Acceptance

- A repeated marketplace event cannot create a second order or allocate a second key.
- External order IDs are unique within the owning connection and never resolve across tenants.
- Marketplace payment state is accepted only from authenticated provider evidence, never from buyer redirects or seller input.
- Fulfillment push retries reuse the existing fulfillment and never allocate new inventory.
- No marketplace launches until legal/product policy confirms the intended digital goods are permitted.

## Phase 14 — Payment and connector ecosystem

### Deliverables

- A second tenant payment adapter only when measured merchant demand and provider access justify it.
- Connector SDK/contract-test harness, versioned manifests and certification checklist.
- Multi-channel attribution, delivery and provider-health analytics without PII or secret material.
- Documented extraction triggers for independently scaling or regulated adapters; the default remains one modular monolith.

### Acceptance

- The second payment adapter reuses provider-neutral attempt, evidence, decision, exception and fulfillment gates.
- Return/cancel URLs remain informational for every provider.
- Connector certification proves tenant isolation, idempotency, bounded payloads, safe error mapping, credential rotation and deletion behavior.
- No service split occurs without measured scaling, compliance, availability or team-ownership evidence.

## Test matrix

### Unit

- Validators/normalizers.
- Money calculation.
- State transitions.
- Signature canonicalization.
- Encryption/AAD/version.
- Plan entitlements.
- Host/slug/domain parsing.

### Database/service integration

- Tenant filters.
- Atomic allocation.
- Idempotency records.
- Order/payment/fulfillment transitions.
- Credential version mapping.
- Domain uniqueness.

### Provider contract tests

- Telegram success/errors/429/timeout.
- PayOS create/status/webhook signature variants.
- Cloudflare custom hostname lifecycle.
- Fake channel adapter capability, normalization, fan-out and retry contracts.
- Provider messaging-window, template and secure-fulfillment constraints where applicable.
- Bounded provider response and malformed JSON.

Provider tests dùng stub/fake server; production credentials không chạy trong CI.

### End-to-end smoke

- Signup -> shop -> product -> keys -> PayOS -> publish.
- Connect bot -> `/start` -> cart -> checkout.
- Connect or provision a channel -> capability discovery -> health -> controlled inbound/outbound test.
- Website checkout -> paid -> reveal.
- Custom domain pending -> active.
- Subscription suspend -> checkout blocked -> export allowed.

### Security

- Cross-tenant object access.
- CSRF/origin/session.
- Webhook forgery/replay.
- Secret/key leakage in responses/logs.
- Rate limit/body size/content type.
- Domain/cache confusion.
- Concurrent fulfillment.

## Required commands

Repository phải có script tương đương:

```json
{
  "scripts": {
    "dev": "astro dev",
    "check": "astro check",
    "lint": "...",
    "test": "...",
    "test:smoke": "...",
    "build": "astro build",
    "platform:doctor": "...",
    "platform:provision": "...",
    "db:migrate": "...",
    "deploy:dry-run": "...",
    "deploy": "..."
  }
}
```

Chọn test/lint runner tối giản phù hợp stack; không thêm framework nặng không cần thiết.

## Definition of done per feature

Một feature chỉ done khi:

- Happy path hoạt động.
- Error/empty/loading/retry state hoạt động.
- Authorization/tenant/plan guard có test.
- Idempotency/concurrency được xem xét.
- Secrets/PII/key không leak.
- Mobile/keyboard/accessibility phù hợp UI.
- Contrast, focus, reduced-motion and deterministic desktop/mobile visual states meet the design-system contract.
- Docs/config/migration cập nhật.
- Build và relevant tests pass.
