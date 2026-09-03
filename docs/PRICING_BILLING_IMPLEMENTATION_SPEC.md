# Pricing and Billing Implementation Specification

Status: implemented in source and locally verified; production/staging admission pending
Date: 2026-08-03

This document converts ADR 0022 into an implementation contract. It is
deliberately additive: existing migrations are not edited and no production
provider is activated by this document.

## 1. Scope

### In scope

- Paid-only `starter` and `pro` plan catalog.
- Vietnam and global monthly prices.
- Dodo-backed VN and global platform subscription flow.
- Seven-day `trialing`, `pending_payment`, active, past-due/grace, suspended and
  canceled behavior.
- Server-authoritative plan feature and quota evaluation.
- Fine-grained shop capabilities for owner, manager, support and viewer.
- Idempotent usage metering and billing-period quota enforcement.
- Pricing, billing and role-aware UI projections.

### Out of scope for v1

- Permanent free plan, trial extension or repeat evaluation.
- Annual billing, coupons, add-ons or overage charges.
- Buyer subscription products.
- Seller PayOS credential migration.
- Zalo, WhatsApp, Discord or Telegram Mini App provider activation.
- Currency conversion or cross-currency revenue aggregation.

## 2. Commercial catalog

Plan identity is separate from commercial offer:

| Plan code | VN amount minor | Global amount minor | Interval |
| --- | ---: | ---: | --- |
| `starter` | 99000 VND | 500 USD cents | month |
| `pro` | 299000 VND | 1500 USD cents | month |

`amount_minor` is authoritative. Prices must also carry `market_code`,
`currency`, `tax_behavior`, `provider_code`, `provider_price_ref`, effective
dates, version and active status. A request cannot choose a price reference
directly; the server resolves it from the merchant market and requested plan.

The merchant market is selected from the shop's normalized merchant country:

- `VN` -> `vn`, `VND`.
- Other supported countries -> `global`, `USD`.
- Unknown or invalid country -> billing setup is blocked until corrected.

After the first paid invoice, changing merchant country requires an audited
billing migration or cancellation/re-subscription. It must not silently switch
currency mid-period.

## 3. Subscription lifecycle

Subscription cancellation and plan changes use a durable request state machine:
`requested -> provider_pending -> completed|rejected|canceled`. Dodo change-plan
uses the official subscription endpoint with a stable server HMAC idempotency
key; Starter upgrades apply immediately and Pro downgrades schedule for the
next billing date. Cancellation uses Dodo's official subscription patch with
`cancel_at_next_billing_date`. Local state is completed only after a signed
provider event or direct reconciliation. Missing provider configuration or
subscription references fail closed and leave the request retryable.

```text
trialing -> active
trialing -> suspended (trial expiry without verified payment)
pending_payment -> active
active -> past_due -> grace_period -> suspended
active -> cancel_scheduled -> canceled
active -> upgrade_pending -> active
active -> downgrade_scheduled -> active -> downgraded_at_renewal
```

`trialing` is valid for new shops only when `trial_ends_at` is exactly seven
days after creation. An expired trial cannot publish, checkout or activate a
provider and must be transitioned to `suspended` by the request-time guard or
scheduled reconciliation.

| State | Dashboard | Provider setup | Publish/checkout |
| --- | --- | --- | --- |
| `trialing` | setup and plan-limited operation | according to readiness | yes until `trial_ends_at` |
| `pending_payment` | draft setup (catalog, storefront draft, profile) and conversion checkout | no new provider setup | no |
| `active` | full plan/role policy | according to plan/provider | yes |
| `past_due` | full read and operational work | no new high-risk setup | yes until grace deadline |
| `grace_period` | full read and operational work | no new high-risk setup | yes until `grace_ends_at` |
| `suspended` | owner billing/read-only | no | no |
| `canceled` | retention-window read-only | no | no |

Enforcement must use the current timestamp against `grace_ends_at`; a stale
subscription state cannot keep checkout open after the three-day deadline.

## 4. Authorization contract

Every route has two independent checks:

1. `capability`: what the member role is allowed to do.
2. `entitlement`: what the subscription plan and current state allow.

Examples:

- Owner + Starter + custom domain -> denied by plan limit.
- Manager + Pro + billing change -> denied by role.
- Owner + Pro + suspended subscription + catalog read -> allowed read-only.
- Owner + Pro + pending payment + public checkout -> denied by state.

Stable reason codes:

- `authorization_denied`
- `plan_feature_unavailable`
- `plan_limit_reached`
- `subscription_payment_required`
- `subscription_grace_expired`
- `provider_not_ready`
- `shop_not_publishable`
- `quota_over_limit`

Frontend action policy must expose `visible`, `enabled`, `reasonCode`,
`requiresRecentAuth`, `requiresConfirmation` and `expectedVersion`; it must not
infer these values from plan names or badge colors.

## 5. Quota semantics

- Products count all non-archived products, including drafts, to prevent draft
  accumulation from bypassing the limit.
- Orders quota counts the first authoritative order insert. Cart, quote,
  payment-link retry and idempotent replay do not create extra usage.
- Member seats count active non-owner memberships plus pending, unexpired
  invitations. Revoked/expired invitations do not consume capacity.
- Custom-domain capacity is reserved when a non-deleted domain request is
  created, preventing concurrent requests from bypassing the limit.
- Upgrade changes the effective limit immediately after verified payment but
  carries existing usage forward.
- Downgrade applies at renewal. If usage exceeds the new limit, existing data
  remains intact and affected create/update actions fail with `quota_over_limit`.
- No quota path may use KV as authority.

## 6. Metering contract

Add an immutable, tenant-leading usage event boundary:

```text
usage_event:
  id
  shop_id
  metric
  period_key
  source_kind
  source_id
  delta
  occurred_at
  created_at
```

The unique identity is `(shop_id, metric, period_key, source_kind, source_id)`.
The event insert and `usage_counters` increment occur in one D1 transaction.
Negative deltas are not used for order/product/member quota correction; a
reviewed compensating event is required so the ledger remains auditable.

Quota period keys use the subscription ID, period start and period kind
(`trial` or `paid`). Trial usage is bounded independently and does not reduce
the first paid period's allowance. Analytics may also write a calendar period
projection, but calendar metrics are not quota authority.

## 7. Database migration sequence

The additive migration sequence is now implemented locally. It is source-only
until the production continuation admission, backup and provider gates pass.

### `0070_paid_plan_catalog.sql`

- Add `starter` and `pro` plan snapshots.
- Add plan visibility/assignability/schema-version fields if absent.
- Add/retain `trialing` and `pending_payment` in subscription state constraints;
  enforce the seven-day `trial_ends_at` invariant in the service and database
  boundaries. Migration `0074` rebinds post-rename subscription guards.
- Mark legacy plans non-public and non-assignable.
- Preserve existing subscription rows.

### `0071_plan_prices.sql`

Create `plan_prices` with:

- `plan_id`, `market_code`, `currency`, `amount_minor`, `interval`.
- `tax_behavior`, `provider_code`, `provider_price_ref`.
- `effective_from`, `effective_to`, `version`, `is_active`.
- Unique active offer guard for plan/market/currency/interval.

### `0072_platform_billing.sql`

Add billing account, checkout session, invoice/payment reference and immutable
provider event tables. Store provider IDs, hashes and bounded references only;
never store Dodo secret material or raw credential values.

Extend subscription projections with provider, market, currency, price snapshot,
external subscription reference and grace deadline where necessary.

### `0073_usage_metering.sql`

Add the usage event ledger, dedupe indexes, billing-period indexes and any
missing tenant-leading counter indexes. Counters and events distinguish
`trial` and `billing` period kinds.

### `0074_rebind_post_0070_subscription_guards.sql`

Rebinds channel/session scope triggers that SQLite rewrites while the
subscription table is rebuilt. This migration is required for the complete
`0001`-`0076` local source chain.

### `0075_paddle_platform_price_provider.sql`

This historical migration rebinds the seeded VN Starter/Pro subscription offers
from the legacy seller PayOS provider marker to the former platform provider.
The filename is retained because applied migrations are immutable; it must not
be edited.

### `0076_dodo_platform_price_provider.sql`

Rebuilds the provider-constrained billing tables forward-only so `dodo` is the
platform subscription provider marker in VN and global markets. Existing
subscription, checkout, invoice, event and price rows are copied without
changing amounts, currencies, effective dates, versions or tenant keys.
Historical `paddle` markers and pending references are normalized to `dodo`
(`pending:dodo:*`); PayOS remains reserved for seller order payments. Checkout
stays fail-closed until each environment has real Dodo product/price IDs.

### `0077_activation_milestone_ledger.sql` through `0079_phase1_completion_hardening.sql`

Add the activation ledger, Dodo identity/request hardening, scheduled execution
metadata, active-checkout uniqueness, enum-only activation projection guards and
the rotating activation-backfill checkpoint. Provider response loss remains
retryable with the same HMAC idempotency key, and subscription-change completion
requires signed webhook evidence or direct provider reconciliation.

No migration may mutate or delete an already-applied migration. Production
admission remains blocked until the `0053`-`0079` continuation gate is reviewed,
backed up and admitted.

## 8. API contract

Implemented endpoints:

- `GET /api/app/shops/:shopPublicId/billing`: current subscription, market,
  price, period, grace, usage, limits and pending request status.
- `GET /api/app/shops/:shopPublicId/billing/plans`: active assignable offers,
  including prices for the shop market.
- `POST /api/app/shops/:shopPublicId/billing/checkout`: owner-only,
  CSRF/recent-auth/idempotency protected; creates a Dodo checkout reference.
- `POST /api/app/shops/:shopPublicId/billing/requests`: owner-only intent for
  cancel/downgrade, never direct state mutation.
- `POST /api/webhooks/billing/dodo/:webhookPublicId`: raw-body signature
  verification, event dedupe and subscription state transition.

Every seller query remains tenant-leading. The client cannot supply the shop,
market, currency, amount or provider price as authority.

## 9. Implementation order

1. Add ADR/spec and update the implementation status.
2. Add catalog/price/state migrations and seed validation.
3. Implement typed plan catalog and central entitlement evaluator.
4. Split role capabilities and update route guards.
5. Implement usage event metering and quota tests.
6. Implement Dodo adapter, checkout reference and verified webhook path.
7. Update pricing and billing UI from server projections.
8. Run local fake-provider tests, staging migration/acceptance and release gates.

## 10. Exit criteria

- No new shop can receive a permanent free entitlement; every trial has a
  seven-day expiry and a separate usage period.
- Only Starter/Pro appear in public or assignable plan lists.
- Prices are D1-backed and market-correct.
- Dodo return/checkout cannot activate a subscription without verified event
  evidence.
- Duplicate/conflicting webhook behavior is deterministic and audited.
- All role/plan/state combinations have backend tests.
- Quota counters survive concurrency and replay tests.
- No raw provider credential, token or secret appears in logs, events or exports.
- `npm run check`, `npm run lint`, `npm run test`, `npm run build` and
  `npm run deploy:dry-run` pass before any remote migration or provider rollout.
- Local SQLite verification applies all 79 migrations with zero integrity or
  foreign-key violations. This evidence does not replace protected production
  backup/restore admission.

## 11. External requirements

- Dodo merchant verification, product/price IDs and webhook signing secret per
  environment.
- Confirmed Dodo VND support/merchant account and tax policy for Vietnam.
- Dodo tax/invoice/refund configuration.
- Approved customer-facing copy for payment failure and three-day grace.
- Production continuation migration admission for the current source chain.
