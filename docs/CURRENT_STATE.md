# Selinow Phase 4 Current State

Last verified: 2026-08-04 (Asia/Tokyo)

P4 completion state: `local_ready_remote_blocked`. The independently reviewed
runtime/test candidate is `8f251e43e9bd6e11e03937160181395202e35ade`
(tree `338587de6d69f354f7d124b78d9b2aa51918dd2d`). Staging database
mutation now fails closed unless the live ledger is an exact ordered prefix of
the reviewed source ledger; staging seed additionally requires the complete
ledger and passing preflight immediately before its sink. The P4 acceptance,
18-scenario UAT, controlled-pilot, incident/rollback, and safe machine-template
contracts are checked in. No remote mutation or seller/provider observation was
authorized or performed; staging, providers, pilot, and production remain NO-GO.

See `docs/PHASE_4_REVIEW_PACKAGE_R0.md`,
`docs/PHASE_4_STAGING_ACCEPTANCE.md`, `docs/PHASE_4_UAT_MATRIX.md`,
`docs/PHASE_4_PILOT_EXECUTION_PLAN.md`, and
`docs/PHASE_4_INCIDENT_AND_ROLLBACK.md`.

P3 local admission hardening was added on 2026-08-04. The current source now
binds staging manifests to exact backup/restore/D1 evidence and requires a
complete migration ledger plus passing database preflight before and after a
staging build. This is local tooling evidence only; no remote mutation or pilot
acceptance is implied. See `docs/PHASE_3_STAGING_PILOT_READINESS.md`,
`docs/PHASE_3_STAGING_READINESS.md`, `docs/PHASE_3_PILOT_SCORECARD.md` and
`docs/PHASE_3_REVIEW_PACKAGE_R0.md`.

Latest P3 local evidence: 249 Vitest files / 1,777 tests; check/lint/TypeScript,
builds, both deploy dry-runs, audit, diff check, and isolated local restore pass.
The restore report is
`.wrangler/restore-drills/local/rdr_20260803200612_4388ccee7295.json` and remains
ignored/private local evidence.

This is the short current-state record for the Phase 3 staging-admission and
controlled-pilot candidate. It is not a historical implementation log and does
not authorize a remote mutation.
Maturity values are intentionally specific: `implemented`, `locally_verified`,
`deployed`, `configured`, `provider_accepted`, `pilot_accepted`, `blocked`, or
`not_started`.

## State matrix

| Dimension | Source | Local | Staging | Production | Commercial |
| --- | --- | --- | --- | --- | --- |
| Commit/tree identity | P3 implementation candidate `ec66a7a909319ac0a4b5b4b8c777836e636e56a5` | `locally_verified`; R0 records the immutable implementation commit and local restore evidence | `blocked`; execution must use a fresh private staging manifest generated from the final clean HEAD | `deployed` platform handoff at historical Worker `6ca9c890-ed04-44dc-ac32-44b36881f2dc`; current tree not proven deployed | `blocked` pending external acceptance |
| Migration ledger | `0001`-`0080`, contiguous | full source chain exercised by local SQLite-backed tests and isolated restore | `deployed` through `0028`; 52 pending (`0029`-`0080`) | `deployed` through `0052`; 28 pending (`0053`-`0080`) | `blocked` pending guarded migration admission |
| Worker version | Current source only | `locally_verified` build/dry-runs | `deployed` historical staging version; current tree not proven there | `deployed` platform-only handoff; current candidate not proven there | `blocked` |
| Marketing | Phase 1 copy/routes exist in source; Website is current and Telegram is labeled upcoming | `locally_verified` by source/browser gates | `blocked` pending candidate deploy | `deployed` homepage only; current source copy not proven live | `blocked` until truthful claims and routes are deployed |
| Pricing | Starter/Pro D1 catalog and Dodo fail-closed path | `locally_verified`; pending/invalid Dodo references suppress prices, purchase CTA and structured Offers | `blocked` pending `0070`-`0080` | `blocked`; production pricing is not a migrated commercial catalog | `blocked` pending migrated environment and provider setup |
| Auth | Magic-link/session/CSRF controls | `locally_verified` | `deployed` platform baseline; current candidate pending | `deployed` platform login smoke only | `blocked` pending pilot evidence |
| Website storefront | Shared catalog/cart/quote/checkout/order/fulfillment core | `locally_verified` with local browser and commerce tests | `blocked` pending full schema/candidate deploy | `blocked` for current full commerce candidate | `blocked` pending payment and fulfillment UAT |
| PayOS | Seller-owned signed payment/reconciliation adapter | `implemented`, `locally_verified` | `blocked` pending controlled channel/UAT | `blocked`; no provider activation claimed | `blocked` |
| Telegram Bot | Seller-owned encrypted bot and private commerce | `implemented`, `locally_verified` | `blocked` pending dedicated bot UAT | `blocked`; no provider activation claimed | `blocked` |
| Fulfillment | License-key/private-file/generated-license paths share payment authority | `locally_verified` | `blocked` pending provider-backed end-to-end evidence | `blocked` | `blocked` |
| Dodo billing | Scheduled subscription operations, response-loss-safe checkout, owner recovery, direct reconciliation and tenant-bound webhook completion | `implemented`, `locally_verified`; provider references remain pending | `blocked` pending migrations and Dodo test environment | `blocked`; no production IDs/secrets configured | `blocked` pending merchant verification and price/webhook setup |
| Custom domain | Cloudflare for SaaS lifecycle in source | `locally_verified` | `deployed` lifecycle evidence exists | `blocked` pending exact hostname/Turnstile admission | `blocked` |
| Legal/support | Seller storefront policy/abuse mechanics exist; platform surfaces absent | `blocked` pending owner/legal decisions | `blocked` | `blocked`; no placeholder copy may be published | `blocked` |
| Analytics | Billing usage metering plus 12-milestone activation ledger, enum-only projections and rotating deterministic backfill | `locally_verified`; inventory readiness now requires active product/variant state and uses durable activation timestamps | `blocked` pending `0077`-`0080` admission | `blocked` | `blocked` pending retention ownership and pilot evidence |
| Monitoring | Concrete threshold, window, role and stop contract | `locally_verified` by artifact contract; no configured remote alert is claimed | `blocked` pending named owners, dashboards, alerts and acknowledgements | `blocked` beyond platform handoff | `blocked` |
| Seller activation | `/app` sellability, readiness blockers, onboarding inventory cleanup, and route-safe next actions | `locally_verified`; source/unit/auth-browser evidence only | `blocked` pending candidate admission and UAT | `blocked` | `blocked` pending pilot evidence |
| Pilot evidence | Phase 3 scorecard, safe evidence allowlist and 14-scenario regression map | `not_started`; local behavior is mapped separately from pilot status | `blocked` pending controlled Website-first and provider UAT | `not_started` | `blocked` |

## Read-only public evidence

Checked 2026-08-03 with no mutation: `https://selinow.com/` and
`/pricing` returned `200`; `/solutions`, all three Phase 1 solution routes,
`/sitemap.xml`, and `/llms.txt` returned `404`; `/robots.txt` and
`/site.webmanifest` returned `200`; `https://api.selinow.com/api/health`
returned `200`. The source contains the missing routes, so the deployed Worker
is stale relative to the current source tree. `/login` returned `200` with
private indexing headers and an unknown route returned `404`.

## Candidate boundary

The Phase 1 source work accumulated across the R0-R3 continuation and includes
the frontend/provider/release artifacts, migrations `0053`-`0079`, billing,
activation, tenant, channel and verification tests already present in the shared
worktree. R3 does not rewrite historical migrations or discard any existing
work. R0, R1 and R2 remain historical snapshots. Phase 2 adds seller-activation
authority fixes, inventory plaintext cleanup, activation backfill recovery,
forward-only migration `0080_catalog_activation_timestamps.sql`, exact staging
release/continuation admission, funnel/unit-economics/pilot artifacts, and a
refreshed staging-admission package. The immutable runtime candidate and current
verification references are recorded in `docs/PHASE_2_REVIEW_PACKAGE_R2.md`.

## Phase 2 local evidence

- Source migration chain: `0001`-`0080`, contiguous; Phase 2 adds only forward-only migration `0080_catalog_activation_timestamps.sql`.
- Candidate-bound isolated restore drill: `.wrangler/restore-drills/local/rdr_20260803145929_b94ce8926be7.json`; reviewed runtime commit `ec50cde50c1ecdc8264a07c3261e2962c7e568d6`, integrity `ok`, zero FK violations, zero missing tables/count mismatches, 614 restored items, exact 80-file ledger, and exact temporary-target cleanup. The report is mode `0600` and local-only.
- The prior authenticated 7/7 and public 27/27 browser runs remain R1 layout/accessibility evidence. R2 changes request lifecycle, activation state, migration, and release tooling; their current evidence is source/unit/integration/build coverage, not a new provider or remote browser acceptance run.
- Final repository gates: `check` has 0 errors and 3 existing hints; lint and `tsc --noEmit` pass; Vitest passes 248 files / 1,770 tests; local/staging builds and deploy dry-runs pass; audit reports 0 vulnerabilities; diff checks pass.
- No staging/production migration, Worker deployment, provider activation, secret update, DNS/route change, webhook, or seller pilot was performed.

## External requirements

The remaining gates require the committed reviewed candidate, fresh protected staging
backup/restore evidence, least-privilege operator tokens, Dodo merchant/product/
price/webhook configuration, controlled PayOS and Telegram credentials/UAT,
privacy/legal decisions, named support/incident owners, monitoring thresholds,
and pilot seller acceptance. Secret values must never be requested or recorded
in this repository or chat.
