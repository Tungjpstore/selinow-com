# PRODUCTION_MUTATION_REVIEW_PACKAGE

Status: `prepared_only` — separate approval required; never reuse staging
approval.

## Decision requested

Review and approve or reject a future production continuation release for the
exact clean candidate. This document is planning evidence only and does not
authorize production backup, migration, deploy, route, DNS, provider, or secret
changes.

## Release identity

- Clean reviewed commit/tree: `TBD after R3 and final review`
- Release manifest/checksum: `TBD`
- Current Worker/version: platform-only handoff is historical; fresh inventory
  required
- Current D1 ledger: `0001`-`0052` must be rechecked live
- Exact pending migrations: `0053`-`0077`, subject to live ledger

## Production scope

- Fresh protected backup and restore drill: `TBD`
- Migration cutover policy for pre-`0066` OAuth rows: `TBD`
- Dodo merchant/product/price/webhook configuration and tax treatment: `TBD`
- PayOS controlled seller channel/UAT: `TBD`
- Telegram production test tenant/bot/UAT: `TBD`
- Custom-domain and Turnstile hostname admission: `TBD`
- Queue consumers, cron, monitoring and budget thresholds: `TBD`
- Pilot sellers, support owner, incident owners and legal approval: `TBD`

## Explicit mutation list

Every intended mutation must be enumerated with command, resource, operator,
expected result and evidence path: backup, D1 migration, Worker version upload/
deploy, route handoff, Worker Domains, provider registration, secret changes,
DNS/hostname changes, queue/cron changes, seed/data correction, and pilot
traffic. Anything not listed is out of scope.

## Safety and rollback

- Reconcile account, zone, D1 UUID/name, Worker, routes, domains, queues, cron,
  and secrets immediately before each sink.
- Runtime rollback uses the exact captured Worker version and route IDs.
- Database recovery uses a reviewed forward fix or the exact fresh backup/restore
  plan; no destructive direct SQL or migration edits.
- Monitor at 5m, 15m, 1h and next day with named owners and stop conditions.

## Required evidence

Clean candidate diff, full local gates, staging acceptance, protected backup,
isolated restore, migration ledger, PayOS/Telegram UAT, end-to-end signed payment
and fulfillment, pilot acceptance, monitoring/alert acknowledgement, legal and
support ownership, rollback readiness, and exact deployed version.

## Approval gate

Stop here until a reviewer separately accepts this package in writing. Never
request or record secret values in chat or committed artifacts.
