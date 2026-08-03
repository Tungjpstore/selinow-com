# Selinow Phase 2 Current State

Last verified: 2026-08-03 (Asia/Tokyo)

This is the short current-state record for the Phase 2 seller-activation and
controlled-pilot candidate. It is not a historical implementation log and does
not authorize a remote mutation.
Maturity values are intentionally specific: `implemented`, `locally_verified`,
`deployed`, `configured`, `provider_accepted`, `pilot_accepted`, `blocked`, or
`not_started`.

## State matrix

| Dimension | Source | Local | Staging | Production | Commercial |
| --- | --- | --- | --- | --- | --- |
| Commit/tree identity | Phase 2 pilot candidate from baseline `4d3081a03a320ea84fdf66c31cf22e97f041a386` | `locally_verified`; exact candidate commit is recorded in R1 after local gates | `blocked` until exact reviewed commit and fresh admission evidence | `deployed` platform handoff at historical Worker `6ca9c890-ed04-44dc-ac32-44b36881f2dc`; current tree not proven deployed | `blocked` pending external acceptance |
| Migration ledger | `0001`-`0079`, contiguous | full source chain exercised by local SQLite-backed tests | `deployed` through `0028`; 51 pending (`0029`-`0079`) | `deployed` through `0052`; 27 pending (`0053`-`0079`) | `blocked` pending guarded migration admission |
| Worker version | Current source only | `locally_verified` build/dry-runs | `deployed` historical staging version; current tree not proven there | `deployed` platform-only handoff; current candidate not proven there | `blocked` |
| Marketing | Phase 1 copy/routes exist in source; Website is current and Telegram is labeled upcoming | `locally_verified` by source/browser gates | `blocked` pending candidate deploy | `deployed` homepage only; current source copy not proven live | `blocked` until truthful claims and routes are deployed |
| Pricing | Starter/Pro D1 catalog and Dodo fail-closed path | `locally_verified`; pending/invalid Dodo references suppress prices, purchase CTA and structured Offers | `blocked` pending `0070`-`0078` | `blocked`; production pricing is not a migrated commercial catalog | `blocked` pending migrated environment and provider setup |
| Auth | Magic-link/session/CSRF controls | `locally_verified` | `deployed` platform baseline; current candidate pending | `deployed` platform login smoke only | `blocked` pending pilot evidence |
| Website storefront | Shared catalog/cart/quote/checkout/order/fulfillment core | `locally_verified` with local browser and commerce tests | `blocked` pending full schema/candidate deploy | `blocked` for current full commerce candidate | `blocked` pending payment and fulfillment UAT |
| PayOS | Seller-owned signed payment/reconciliation adapter | `implemented`, `locally_verified` | `blocked` pending controlled channel/UAT | `blocked`; no provider activation claimed | `blocked` |
| Telegram Bot | Seller-owned encrypted bot and private commerce | `implemented`, `locally_verified` | `blocked` pending dedicated bot UAT | `blocked`; no provider activation claimed | `blocked` |
| Fulfillment | License-key/private-file/generated-license paths share payment authority | `locally_verified` | `blocked` pending provider-backed end-to-end evidence | `blocked` | `blocked` |
| Dodo billing | Scheduled subscription operations, response-loss-safe checkout, owner recovery, direct reconciliation and tenant-bound webhook completion | `implemented`, `locally_verified`; provider references remain pending | `blocked` pending migrations and Dodo test environment | `blocked`; no production IDs/secrets configured | `blocked` pending merchant verification and price/webhook setup |
| Custom domain | Cloudflare for SaaS lifecycle in source | `locally_verified` | `deployed` lifecycle evidence exists | `blocked` pending exact hostname/Turnstile admission | `blocked` |
| Legal/support | Seller storefront policy/abuse mechanics exist; platform surfaces absent | `blocked` pending owner/legal decisions | `blocked` | `blocked`; no placeholder copy may be published | `blocked` |
| Analytics | Billing usage metering plus 12-milestone activation ledger, enum-only projections and rotating deterministic backfill | `locally_verified`; manual-fulfillment inventory readiness recovery and the privacy-safe funnel contract are included | `blocked` pending `0077`-`0079` admission | `blocked` | `blocked` pending retention ownership and pilot evidence |
| Monitoring | Platform canary/route evidence only | `locally_verified` for scripts | `blocked` pending service/provider/budget evidence | `blocked` beyond platform handoff | `blocked` |
| Seller activation | `/app` sellability, readiness blockers, onboarding inventory cleanup, and route-safe next actions | `locally_verified`; source/unit/auth-browser evidence only | `blocked` pending candidate admission and UAT | `blocked` | `blocked` pending pilot evidence |
| Pilot evidence | Phase 2 plan and evidence schema only; no seller/provider observations recorded | `not_started` | `blocked` pending controlled PayOS/Telegram UAT | `not_started` | `blocked` |

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
funnel/unit-economics/pilot artifacts, and a refreshed staging-admission package.
The final exact candidate commit and verification references are recorded in
`docs/PHASE_2_REVIEW_PACKAGE_R1.md`.

## Phase 2 local evidence

- Source migration chain: `0001`-`0079`, contiguous; no migration was added by Phase 2.
- Isolated restore drill: `.wrangler/restore-drills/local/rdr_20260803134132_b8a543d64bc9.json`; integrity `ok`, zero FK violations, zero missing tables/count mismatches, 614 restored items, and exact temporary-target cleanup. The report is mode `0600` and local-only.
- Browser gates: authenticated 7/7 after an intentional mobile `/app` snapshot refresh for the new sellability copy; public 27/27 after review of the current-source mobile marketing baseline. Desktop/mobile, 1440/768/390/320, 200% geometry, accessibility, overflow, console and safe-request checks passed.
- Final repository gates: `check` has 0 errors and 3 existing hints; lint passes; Vitest passes 244 files / 1,760 tests; local/staging builds and deploy dry-runs pass; audit reports 0 vulnerabilities; diff checks pass.
- No staging/production migration, Worker deployment, provider activation, secret update, DNS/route change, webhook, or seller pilot was performed.

## External requirements

The remaining gates require the committed reviewed candidate, fresh protected staging
backup/restore evidence, least-privilege operator tokens, Dodo merchant/product/
price/webhook configuration, controlled PayOS and Telegram credentials/UAT,
privacy/legal decisions, named support/incident owners, monitoring thresholds,
and pilot seller acceptance. Secret values must never be requested or recorded
in this repository or chat.
