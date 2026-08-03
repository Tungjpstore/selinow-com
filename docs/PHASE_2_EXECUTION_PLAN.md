# Phase 2 Execution Plan

Status: local gates passed; candidate commit and R1 evidence binding pending

Baseline: `4d3081a03a320ea84fdf66c31cf22e97f041a386`

## Objective

Turn the Phase 1 local launch candidate into a seller-activation and controlled-
pilot candidate without mutating staging, production, Cloudflare resources, or
external providers.

## Safety boundary

- Keep D1 authoritative for tenant, catalog, inventory, order, payment,
  fulfillment, subscription, readiness, and activation state.
- Preserve `shop_id` isolation and server-derived membership/capability checks.
- Never infer payment, fulfillment, subscription, or provider completion from a
  browser return, request acceptance, QR display, or connector intent.
- Keep inventory plaintext and credentials out of SSR, storage, logs, snapshots,
  queues, audit payloads, and committed evidence.
- Do not run remote migrations, deploy Workers, update secrets, DNS, routes,
  custom hostnames, queues, PayOS, Dodo, or Telegram resources.

## Workstreams

1. Review the bounded seller critical path and record findings in
   `docs/PHASE_2_REVIEW_PACKAGE_R0.md` before changing behavior.
2. Make `/app` derive sellability from authoritative readiness instead of shop
   lifecycle alone, and keep unavailable/forbidden projections distinct from a
   clean result.
3. Clear inventory plaintext after every preview/import terminal path and retain
   replay/version/recent-auth safety.
4. Repair activation milestone recovery for manual-fulfillment sellers and add
   tenant-safe regression coverage.
5. Produce the activation funnel, unit-economics model, controlled-pilot plan,
   evidence example, and current staging-admission package without inventing
   operational or commercial evidence.
6. Run a fresh isolated local backup/restore drill, schema/FK checks, repository
   quality gates, both local browser gates, audit, secret scan, and Git diff
   checks sequentially.
7. Record final evidence and remaining external gates in R1, commit only Phase 2
   files as `feat: complete phase 2 pilot candidate`, and verify a clean tree.

## Acceptance interpretation

Local PASS means the exact committed tree has local evidence for seller
activation and a complete request package for staging admission. It does not
mean staging deployment, provider acceptance, pilot acceptance, production
activation, or commercial validation.
