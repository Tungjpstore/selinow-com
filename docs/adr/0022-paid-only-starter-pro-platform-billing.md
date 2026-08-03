# ADR 0022: Paid-only Starter/Pro pricing and Dodo platform billing

## Status

Accepted

## Date

2026-08-03

## Context

Selinow currently has runtime plan flags and limits, but the public catalog still
uses the legacy `bot`, `store` and `business` plans. Prices are not modeled by
market, new shops enter a 14-day `trialing` state, usage counters do not yet
have a complete idempotent metering boundary, and billing change requests remain
provider-pending intents.

The product decision is to sell only two paid monthly plans:

| Plan | Vietnam | Global |
| --- | ---: | ---: |
| Starter | 99,000 VND/month | 5 USD/month |
| Pro | 299,000 VND/month | 15 USD/month |

The product has a seven-day public evaluation trial but no permanent free plan,
Dodo is the platform billing provider for both VN and global markets, and the
payment-failure grace period is three days. Existing seller PayOS
credentials and platform subscription billing are separate trust boundaries.

## Decision

- Publish only `starter` and `pro` as assignable plans. Keep `bot`, `store` and
  `business` as hidden legacy plans for existing subscriptions; never silently
  downgrade or delete their historical entitlements.
- Store commercial prices in a market-specific price table, not in feature or
  limit JSON. The authoritative lookup key is `(plan, market, currency,
  interval)`, where the interval is monthly in this release.
- Determine the billing market from the shop merchant country. Locale, browser
  language, IP address and client-provided currency are display hints only.
- New shops use a seven-day `trialing` subscription. Trial entitlements are
  time-bounded and use a separate trial usage period; they are not a free plan.
  At trial expiry, a shop without verified paid activation becomes `suspended`
  immediately. `pending_payment` is used for an in-flight conversion checkout.
- During a valid trial, draft setup and the same Starter/Pro limits are
  available, while publication, checkout and provider activation follow the
  existing readiness/provider gates. A verified paid subscription is required
  before the trial expiry deadline to continue after the trial.
- Dodo is the platform provider for both markets. Dodo checkout return URLs are
  informational; only a verified, tenant-bound, amount/currency/price-matched
  Dodo event or direct reconciliation can activate or renew a subscription.
- Keep the existing provider-neutral payment boundary. Platform billing
  credentials, seller PayOS credentials, buyer order tokens and channel webhook
  secrets cannot be reused across trust boundaries.
- Use a three-day grace window after a renewal failure. During grace, the shop
  retains its current effective entitlements but cannot add high-risk provider
  configuration. At grace expiry it becomes `suspended`; no customer order,
  fulfillment or financial history is deleted by subscription enforcement.
- Effective authorization is the intersection of active membership, role
  capability, plan feature, quota, subscription state, shop state, provider
  readiness and platform policy. UI visibility is only a projection of this
  server decision.
- Meter quota usage with an idempotent D1 usage-event boundary and update the
  authoritative counter in the same transaction. Usage periods are bound to
  the subscription period; upgrade raises the limit without resetting usage,
  while downgrade preserves data and blocks affected writes when over limit.

## Plan baseline

The initial published limits are:

| Capability/limit | Starter | Pro |
| --- | ---: | ---: |
| Website storefront and Telegram | yes | yes |
| Products, including unarchived drafts | 50 | 500 |
| Orders created per subscription period | 500 | 5,000 |
| Customers | 1,000 | 10,000 |
| Active non-owner member seats | 1 | 5 |
| Custom domains | 0 | 1 |
| Automation rules | 3 | 20 |
| Automation runs per subscription period | 1,000 | 10,000 |
| Read API requests per subscription period | 0 | 50,000 |
| Exports per calendar month | 2 | 10 |
| Private downloads per subscription period | 500 | 10,000 |
| Storage | 1 GB | 10 GB |
| Audit retention | 90 days | 365 days |
| Analytics | basic | advanced |

Zalo, WhatsApp, Discord and Telegram Mini App remain unavailable for public
plan marketing until their provider activation gates are complete. A future
plan entitlement may exist in the catalog without implying provider readiness.

## Trade-offs

- A normalized price table adds a join, but prevents prices from being mixed
  with runtime feature flags and permits market/provider changes without plan
  identity churn.
- Keeping legacy plans hidden requires grandfathered support and makes the
  public catalog slightly more complex, but avoids destructive entitlement
  changes for existing shops.
- Dodo provides the platform checkout/subscription boundary for both markets,
  but introduces provider-specific webhook, customer and invoice evidence that
  must remain behind the provider-neutral billing port.
- A seven-day trial improves conversion, but adds expiry, abuse and trial-to-paid
  state handling. Trial periods are bounded to one evaluation per shop/account
  policy, have their own usage key, and never become a permanent free tier.
- Three-day grace protects short payment interruptions while still producing a
  deterministic suspension boundary; it requires a scheduled reconciliation
  job and clear seller messaging.

## Consequences

- Pricing UI and billing APIs must return prices from D1 and never hard-code
  market amounts or hidden limits.
- `trialing` is valid for new shops only while `trial_ends_at` is in the future;
  no path may create a trial without an explicit seven-day expiry.
- Billing activation, renewal, cancellation and downgrade completion require
  immutable provider evidence, idempotency and tenant-leading queries.
- Role policy must split credential/payment management from operational reads;
  Manager cannot manage billing, team, domains or provider secrets.
- Quota blocks are fail-closed and non-destructive: existing records remain
  readable, while new writes that exceed a hard limit are rejected with a
  stable plan/quota reason code.
- Production rollout is blocked until the continuation migrations through
  `0076` are admitted and Dodo merchant/webhook evidence is available in the
  correct environment. Local fake-provider tests do not prove production
  billing readiness.

## Revisit triggers

Revisit this decision before adding annual pricing, overage billing, trial
extensions or repeated evaluations, a second global billing provider, platform-held seller funds, FX-based
cross-market reporting, or a plan with materially different entitlement
semantics.
