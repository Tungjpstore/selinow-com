# Phase 2 Activation Funnel

Status: local measurement contract; no pilot or commercial evidence recorded

## Authority and privacy

The activation milestone ledger in D1 is the only event authority. It accepts
the fixed milestone enum, tenant-scoped idempotency, bounded source/reason
dimensions, and enum-only projections. Missing best-effort writes are recovered
from authoritative shop, catalog, inventory/fulfillment, provider, readiness,
storefront, order, and subscription rows by the scheduled backfill.

The ledger never stores or derives a seller/customer identity for analytics.
Do not collect email, customer identity, order access tokens, provider IDs,
credential references, URLs containing tokens, inventory keys, raw provider
payloads, or arbitrary JSON.

## Milestones

`setup_started`, `shop_created`, `product_created`, `inventory_ready`,
`payos_connected`, `telegram_connected`, `readiness_passed`, `safe_test_passed`,
`storefront_published`, `first_order_created`, `first_paid_fulfilled`, and
`trial_converted` are the only funnel milestones.

`inventory_ready` means either an accepted inventory batch or an active manual-
fulfillment product. `payos_connected` and `telegram_connected` require the
authoritative active/verified connection state; a submitted credential or
connector request is not an event.

## Funnel formulas

For a pilot cohort `C` and milestone `m`:

```text
eligible(C) = shops created in the cohort with a valid tenant membership
reached(C, m) = distinct shops in C with the first durable event for m
activation_rate(C, m) = reached(C, m) / eligible(C)
step_rate(C, m) = reached(C, m) / reached(C, previous_milestone)
```

The denominator is always stated beside a rate. A missing event is not silently
counted as an abandonment when the source authority was unavailable; it is
reported as `projection_unavailable` and excluded from the denominator until
backfill/reconciliation completes.

`setup_started` is tenant-scoped and currently begins when the shop transaction
creates the tenant. It does not measure an anonymous login or a pre-shop wizard
visit. Any future user-level entry metric requires an explicitly approved,
privacy-reviewed authority and is out of this phase.

## Timing and abandonment

- `time_to_milestone(m)` is the earliest `occurred_at(m)` minus the cohort
  `setup_started.occurred_at` for the same shop.
- Use medians and p90 values only when at least the owner-approved minimum cohort
  size is met; otherwise report `insufficient_sample`.
- An abandonment point is the first required milestone not reached after the
  owner-approved observation window, provided all preceding authority reads are
  available.
- Provider waits are split into `waiting_user` and `waiting_provider`; neither
  is counted as a completion or a seller failure until the observation window
  closes.

## Retry, replay, and backfill

- Same tenant/milestone idempotency key and same payload returns the original
  event; a changed payload is `idempotency_conflict`.
- Concurrent writes race on the tenant-scoped unique key and recover the durable
  winner.
- Scheduled backfill rotates across all shops using the D1 checkpoint and is
  safe to run repeatedly.
- Backfill derives the first authoritative occurrence and never rewrites an
  existing event or invents a provider result.
- Retention is an owner decision; purge must use an explicit tenant and cutoff.

## Cohorts and reporting

Keep pilot cohorts separate by owner-approved, non-identifying dimensions such
as pilot batch, selected channel (`website` or `telegram`), fulfillment type
(`license_key` or `manual`), currency (`VND`, `USD`, `EUR`, or `JPY`), and
activation source. Never join analytics to customer or provider identity.

Report these states distinctly:

- `not_occurred`: authority was available and no durable milestone exists;
- `projection_unavailable`: the relevant tenant query was forbidden or failed;
- `pending_user` / `waiting_provider`: a durable task is waiting and its
  completion authority is not yet present;
- `reconciled`: backfill created or replayed the durable milestone.

No dashboard is added in this phase. Safe queries/services must be approved and
tenant-bounded before any UI projection is introduced.
