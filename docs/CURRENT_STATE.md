# Selinow Phase 1 Current State

Last verified: 2026-08-03 (Asia/Tokyo)

This is the short current-state record for the Phase 1 launch candidate. It is
not a historical implementation log and does not authorize a remote mutation.
Maturity values are intentionally specific: `implemented`, `locally_verified`,
`deployed`, `configured`, `provider_accepted`, `pilot_accepted`, `blocked`, or
`not_started`.

## State matrix

| Dimension | Source | Local | Staging | Production | Commercial |
| --- | --- | --- | --- | --- | --- |
| Commit/tree identity | Phase 1 R3 completion candidate | `locally_verified`; committed candidate required before remote admission | `blocked` until exact reviewed commit is admitted | `deployed` platform handoff at historical Worker `6ca9c890-ed04-44dc-ac32-44b36881f2dc`; current tree not proven deployed | `blocked` pending external acceptance |
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
| Analytics | Billing usage metering plus 12-milestone activation ledger, enum-only projections and rotating deterministic backfill | `locally_verified`; tenant-scoped emitters do not block commerce and missing evidence is recoverable from D1 | `blocked` pending `0077`-`0079` admission | `blocked` | `blocked` pending retention ownership and pilot evidence |
| Monitoring | Platform canary/route evidence only | `locally_verified` for scripts | `blocked` pending service/provider/budget evidence | `blocked` beyond platform handoff | `blocked` |
| Pilot evidence | Templates/runbook only | `not_started` | `blocked` pending controlled PayOS/Telegram UAT | `not_started` | `blocked` |

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
work. R0, R1 and R2 remain historical snapshots; the current state above reflects
the additive R3 completion candidate.

## External requirements

The remaining gates require the committed reviewed candidate, fresh protected staging
backup/restore evidence, least-privilege operator tokens, Dodo merchant/product/
price/webhook configuration, controlled PayOS and Telegram credentials/UAT,
privacy/legal decisions, named support/incident owners, monitoring thresholds,
and pilot seller acceptance. Secret values must never be requested or recorded
in this repository or chat.
