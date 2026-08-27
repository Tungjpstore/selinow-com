# Billing Commercial Completion Plan

Date: 2026-08-23
Status: Source implementation complete; provider configuration, staging UAT, and production activation not yet authorized
Owner surface: platform subscription billing only (Dodo Payments)

## 0. Current Completion Boundary

Completed in source on 2026-08-23:

- shared fail-closed sellable catalog across public pricing, onboarding, seller plans, preview, and checkout;
- response-loss-safe Dodo checkout, exact return URL, provider error classification, and tenant-bound status polling;
- durable initial-checkout reconciliation through migration `0113`, including bounded retries, quarantine, and late signed-success convergence;
- explicit provider-terminal release policy: only `failed` or `cancelled` permits a replacement checkout;
- `/app/billing` information architecture and interaction redesign;
- production migration invariant registration and automated billing regression coverage.

Still external and deliberately blocked:

- owner-approved live values for `DODO_STARTER_VN_PRODUCT_ID`, `DODO_PRO_VN_PRODUCT_ID`, `DODO_STARTER_GLOBAL_PRODUCT_ID`, and `DODO_PRO_GLOBAL_PRODUCT_ID`;
- genuine provider-backed staging acceptance and redacted evidence;
- guarded production catalog reconciliation, controlled live smoke, and observation window.

No source implementation can safely substitute for these provider identities or approvals. Until they are supplied and accepted, public sellability and checkout remain fail-closed by design.

## 1. Outcome

Complete the Selinow subscription billing lane so that:

- landing and `/pricing` publish only offers that the authenticated checkout can actually sell;
- Starter and Pro checkout works for the server-selected VN/VND and global/USD markets;
- a paid subscription is activated only by signed provider truth or direct reconciliation;
- checkout, renewal, recovery, plan changes, invoices, and failure states are retry-safe and observable;
- `/app/billing` presents a calm, familiar SaaS billing experience without exposing provider internals;
- production activation is guarded by staging UAT, immutable evidence, rollback checks, and an owner-approved live test.

## 2. Scope

Included:

- Dodo product/catalog reconciliation for four monthly offers;
- public landing/pricing runtime projection;
- authenticated plan admission, checkout, return, webhook, reconciliation, portal, invoices, and plan changes;
- D1 state-machine and forward-only migration changes needed for checkout recovery;
- seller billing information architecture and responsive UI redesign;
- local, staging, and production validation and rollout artifacts.

Excluded:

- seller-order PayOS checkout;
- refunds, annual plans, coupons, seat billing, usage-based platform billing, and additional currencies;
- storing or rendering payment-card details in Selinow;
- changing the approved Starter/Pro price points without a separate commercial decision;
- granting access from a browser return URL or an unsigned provider response.

## 3. Confirmed Production State

Read-only checks on 2026-08-23 established:

- production D1 is migrated through `0112_google_auth_foundation.sql`;
- all four active Dodo offer rows are still `pending:dodo:*` after migration `0108`;
- `platform_settings.dodo_catalog_reconciliation_required` is `true`;
- required production Worker secret names exist, including the Dodo API and webhook keys;
- the affected shop is `VN`, `Pro`, `suspended`, with no provider customer/subscription reference and no checkout/change-request row;
- the observed checkout failure is `provider_not_ready`, not an unsupported country;
- staging has four active, published version-2 Dodo offer rows and is the correct environment for the first full acceptance run.

The immediate production blocker is therefore incomplete catalog reconciliation, not missing migrations or missing merchant country data.

## 4. Root Causes And Contract Gaps

### 4.1 Catalog is deliberately fail-closed

Migration `0108_dodo_billing_reconciliation.sql` reopens the generic migration-0106 references as `pending:dodo:*`. `loadPlanPrice()` correctly rejects those references. Production has not completed the guarded environment-specific catalog reconciliation.

### 4.2 Public and authenticated offer admission disagree

The marketing projection filters unpublished Dodo references, while `listSellerBillingPlans()` currently exposes active price rows without applying the same provider-readiness predicate. The dashboard can therefore advertise an offer that checkout must reject.

Decision: define one shared sellable-offer predicate and use it for landing, pricing, onboarding, billing plans, preview, and checkout.

### 4.3 Error presentation collapses distinct failures

The client maps missing merchant country, missing sellable offer, and unpublished provider catalog to the same "market unsupported" message.

Decision: expose and render separate safe reason codes:

- `billing_country_required`;
- `billing_market_not_offered`;
- `billing_catalog_not_ready`;
- `billing_provider_temporarily_unavailable`;
- `billing_checkout_recovery_required`.

Provider IDs, credentials, and raw provider errors remain server-only.

### 4.4 Checkout recovery is incomplete

The local checkout/session is persisted before calling Dodo. Network ambiguity is intentionally retryable, but a deterministic provider 4xx is currently flattened into the same retryable error. Initial checkout also lacks a direct reconciliation lane if the signed payment webhook is lost.

Decision: classify provider responses, persist bounded failure evidence, and reconcile initial checkout/payment state independently from subscription-change reconciliation.

### 4.5 Return flow is not explicitly configured

The hosted checkout request does not send a billing return URL. The current `billing_return` polling path is therefore not a complete checkout contract.

Decision: send an allowlisted return URL containing only shop and opaque checkout-operation identity. The return page shows "confirming" and polls D1; it never marks payment as successful.

### 4.6 Operation banner is visually incorrect

`.operation-banner { display:flex }` overrides the browser's `[hidden]` rule, so a hidden banner can still render. The page also starts generic operation polling on every load.

Decision: enforce `.operation-banner[hidden] { display:none; }` and poll only an explicit operation or a state-compatible active operation.

## 5. Architecture Decisions

### 5.1 D1 remains authoritative

D1 owns the local subscription, checkout, invoice, event, and reconciliation state. Dodo is authoritative for provider payment and subscription truth. Browser state is never authoritative.

### 5.2 A single offer-readiness service

Create a shared billing catalog projection that returns:

- plan and price display data;
- server-selected market and currency;
- `sellable` boolean;
- safe admission reason;
- an internal provider reference only for server-side checkout.

All public/authenticated surfaces consume the same effective-date, active-row, provider-code, non-pending-reference, market, currency, and interval rules.

### 5.3 Separate checkout intent from provider result

Retain the response-loss-safe local-first checkout intent, but add explicit attempt state:

- `pending_provider`;
- `open`;
- `processing`;
- `completed`;
- `failed_terminal`;
- `expired_unconfirmed`;
- `canceled`.

If changing the existing status constraint is required, add a forward-only migration and preserve old-worker compatibility during rollout.

### 5.4 Reconcile initial checkout truth

Add a scheduled reconciliation path for non-terminal initial checkout sessions with a provider checkout/payment reference. It must:

- retrieve provider checkout/payment/subscription truth;
- apply the same tenant, plan, price, amount, currency, and environment checks as webhooks;
- use the same idempotent transition function as webhook processing;
- never activate from the hosted return alone;
- avoid suspending a locally expired checkout when provider truth says payment succeeded or is still processing.

### 5.5 Provider event policy

Explicitly classify supported Dodo events. At minimum cover:

- `payment.processing`, `payment.succeeded`, `payment.failed`, `payment.cancelled`;
- `subscription.active`, `subscription.updated`, `subscription.renewed`;
- `subscription.on_hold`, `subscription.failed`, `subscription.cancelled`/provider equivalent;
- payment-method update/unpause events required by the configured recovery flow.

Unknown, validly signed events are durably acknowledged as ignored with safe metadata. Actionable events cannot silently fall into the ignored path.

### 5.6 No invented payment-method data

Selinow will not store or display card brand, last four digits, or expiry unless Dodo exposes a reviewed, necessary, non-sensitive projection later. The UI provides a secure "Manage payment method" action through the tenant-bound Dodo portal/update flow.

## 6. Seller Billing UX

The design direction uses the clarity patterns visible in mature SaaS products such as Notion and OpenAI: one obvious current-plan summary, progressive disclosure for comparison, and separate payment/invoice management. It must retain Selinow's own design system and copy.

### 6.1 Page information architecture

Use one `/app/billing` page with four compact sections or tabs:

1. `Overview`
   - current plan, state, price, next billing event;
   - one primary action based on authoritative state;
   - concise warning/recovery message when degraded.
2. `Plans`
   - Starter and Pro only;
   - current plan visibly selected;
   - target price, key differences, and effective timing;
   - review step before leaving for Dodo or submitting a plan change.
3. `Payment`
   - provider name and billing country/currency;
   - secure portal/update action when available;
   - no fabricated card data;
   - recovery guidance for on-hold/past-due/suspended states.
4. `Invoices`
   - date, amount, currency, status, and provider receipt action when supported;
   - empty and unavailable states remain distinct.

Usage belongs below Overview or in its own compact section only if it affects plan decisions. It must not compete with the recovery CTA.

### 6.2 Interaction rules

- Never show more than one primary CTA in the current-plan summary.
- Do not open a modal until the plan catalog is known to be sellable.
- Use a two-step plan flow: select, then review.
- Show the provider-calculated immediate charge for upgrades.
- Show the exact next-cycle date for scheduled downgrades.
- A return from Dodo displays an authoritative confirmation state, not success.
- Long-running operations move to a durable status row with retry/support guidance; they do not spin indefinitely.
- Mobile uses a single-column layout with 44px minimum targets and no horizontally clipped comparison table.

### 6.3 Public pricing funnel

- Landing and pricing show prices only when the full market catalog is sellable.
- VN/global switching remains a display preference, not a payment authority.
- The selected plan may be preserved through login/onboarding.
- A selected public market may be preserved only as a non-authoritative hint.
- Merchant country is confirmed server-side before checkout and determines the final market/currency.
- If the confirmed country differs from the public preview, show the authoritative price before checkout.

## 7. Execution Phases

### Phase A - Contract and UI correctness

1. Add the shared sellable-offer projection and safe admission reason.
2. Make landing, pricing, onboarding, billing plan list, preview, and checkout use it.
3. Separate country, catalog, market, and provider error copy.
4. Fix `[hidden]` CSS and remove unconditional generic operation polling.
5. Add an explicit checkout return URL contract and safe client validation.
6. Redesign `/app/billing` around Overview, Plans, Payment, and Invoices.

Exit criteria:

- a pending or invalid provider reference is never selectable;
- production-like pending fixtures render a truthful catalog-unavailable state;
- no phantom operation banner appears;
- no browser return can grant access.

### Phase B - Checkout state-machine hardening

1. Preserve provider HTTP status/error category without storing sensitive bodies.
2. Mark deterministic provider rejection terminal and release the active-session lock safely.
3. Keep ambiguous network/5xx attempts retryable under the same idempotency key.
4. Add initial checkout reconciliation and a shared webhook/reconciliation transition function.
5. Prevent expiration from suspending a provider-paid or processing checkout.
6. Handle single-use/expired checkout URLs by creating a new safe attempt when provider truth permits it.

Exit criteria:

- provider 4xx, 5xx, timeout, response loss, duplicate request, lost webhook, and late webhook tests pass;
- each successful charge creates at most one paid invoice and one effective subscription transition;
- a failed checkout never changes to an unrelated plan or tenant.

### Phase C - Provider configuration and staging acceptance

1. Inspect the four Dodo test products for price, currency, interval, tax behavior, trial, adaptive-pricing, and environment correctness.
2. Verify the staging API key, products, webhook, and checkout host are all test-mode.
3. Dry-run, then apply guarded staging catalog reconciliation.
4. Verify the registered webhook subscribes to the required event set.
5. Run real staging scenarios and collect redacted evidence.

Required staging scenarios:

- VN Starter first purchase;
- VN Pro first purchase;
- global Starter first purchase;
- global Pro first purchase;
- duplicate checkout submit;
- browser return before webhook;
- signed webhook before browser return;
- lost initial webhook recovered by reconciliation;
- initial payment failure;
- renewal success and failure/on-hold;
- payment-method recovery;
- immediate prorated upgrade;
- scheduled downgrade and undo;
- cancellation and resume;
- late/duplicate/conflicting webhook;
- cross-tenant and mismatched price/amount/currency rejection.

Exit criteria:

- accepted Dodo UAT artifact is bound to the staging release and Worker version;
- D1, Dodo, UI, invoice, and event states agree for every scenario;
- no secrets, checkout bearer URLs, or customer payment data are written to evidence.

### Phase D - Production catalog activation

Prerequisites:

- clean reviewed commit and green quality gates;
- fresh production backup and restore drill;
- owner approval for the four live Dodo product identities;
- live products verified for VND/USD, monthly interval, tax behavior, no provider trial, and correct recovery settings;
- production API key and webhook belong to the same live Dodo business/catalog;
- rollback and observation owners are named.

Sequence:

1. Run production catalog reconciliation in plan-only dry-run mode with the four live product IDs.
2. Run the distinct remote read-only `--inspect` mode and verify classification is exactly `pending`, `already_configured`, `rotation_required`, or `rotated`; reject partial states. Dry-run alone is not inspection and does not query D1.
3. Apply with all production confirmations.
4. Re-run `--inspect` and verify four sellable active offers plus `dodo_catalog_reconciliation_required=false`. The apply SQL may lower that marker only after it proves the exact four-offer publication in the same execution.
5. Smoke landing, `/pricing`, billing plans, and checkout creation without completing a charge.
6. Execute one owner-approved low-blast-radius live subscription purchase.
7. Verify signed webhook, subscription, checkout, invoice, event ledger, entitlements, portal, and cancellation behavior.
8. Observe cron/webhook/provider error metrics for the agreed window before declaring commercial readiness.

Rollback/fail-safe:

- if provider or identity checks fail before a charge, disable public sellability and keep existing subscriptions untouched;
- never rewrite a published provider identity in place; rotate to a new versioned price row;
- if a live charge succeeds but local processing fails, keep the lane fail-closed for new checkout and reconcile the affected session from provider truth;
- code rollback must remain compatible with the forward-only price rows and checkout state written by the new version.

## 8. Validation Matrix

### Automated gates

Run at minimum:

```bash
npm run check
npm run lint
npm run test
npm run build
npm run deploy:dry-run
```

Focused coverage must include:

- catalog projection parity across public and authenticated surfaces;
- migration replay, foreign-key check, and old/new Worker compatibility;
- checkout concurrency and idempotency;
- tenant isolation for every checkout, event, invoice, and reconciliation query;
- webhook signature, ordering, duplicate, conflict, and late-delivery behavior;
- provider error classification and safe logs;
- SSR, client hydration, computed CSS visibility, keyboard flow, reduced motion, and 390px/768px/1440px layouts;
- pricing-to-login-to-onboarding-to-billing funnel consistency.

### Operational checks

- Dodo catalog objects match the configured environment;
- registered webhook URL and signing key match the deployed Worker;
- cron is active and reconciliation counters are observable;
- dashboards/alerts cover checkout pending age, provider error rate, webhook failures, reconciliation failures, suspended-after-payment anomalies, and invoice/subscription divergence;
- support can locate a checkout by safe request/session reference without seeing credentials or payment details.

## 9. Acceptance Criteria

Commercial billing is complete only when all are true:

1. Landing, pricing, and billing display the same two plans and authoritative market prices.
2. No unpublished or environment-mismatched offer is selectable.
3. All four staging offers pass genuine provider-backed purchase and recovery UAT.
4. A successful payment activates exactly one tenant subscription and invoice.
5. A return URL alone never activates a plan.
6. Lost and duplicate webhooks converge through reconciliation without duplicate entitlements or invoices.
7. Failed, partial, late, mismatched, or cross-tenant payments never auto-fulfill or activate.
8. Owners can upgrade, schedule/undo downgrade, cancel/resume, update payment method, and view invoices through clear state-specific UI.
9. Production has four verified live product references and one accepted owner-approved live smoke.
10. Monitoring, rollback, support references, and `docs/IMPLEMENTATION_STATUS.md` reflect the deployed truth.

## 10. External Inputs And Approvals

The following cannot be derived or invented by source code:

- four exact live-mode Dodo product IDs;
- four exact test-mode Dodo product IDs for staging if rotation is required;
- confirmation of Dodo product price, currency, tax, trial, adaptive pricing, and recovery settings;
- owner authorization for catalog mutation and a live subscription charge;
- named rollout, finance, support, and rollback owners;
- legal approval for tax/invoice/refund copy.

These values must be supplied through protected environment/operator channels. They must not be committed, logged, or pasted into general documentation.

## 11. Primary References

- Dodo subscription integration: https://docs.dodopayments.com/developer-resources/subscription-integration-guide
- Dodo checkout sessions: https://docs.dodopayments.com/developer-resources/checkout-session
- Dodo subscription plan changes: https://docs.dodopayments.com/developer-resources/subscription-upgrade-downgrade
- OpenAI pricing information architecture reference: https://chatgpt.com/pricing/
- Notion pricing information architecture reference: https://www.notion.com/pricing
