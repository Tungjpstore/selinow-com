# Phase 3 Staging Readiness

Status: `local_ready_remote_blocked` (2026-08-04, Asia/Tokyo)

This is the fail-closed admission and observation contract for the first
controlled Phase 3 staging window. It records local proof and the exact remote
evidence still required. It does not authorize a backup, migration, deploy,
provider call, secret change, route change, order, or seller pilot.

## Candidate and environment admission

| Gate | Local/source result | Required staging evidence | Current decision |
| --- | --- | --- | --- |
| Candidate identity | Clean commit, tree, ordered `0001`-`0080` ledger and schema-2 manifest are enforced | Private manifest generated from the final clean HEAD | `blocked` |
| D1 identity | Account, database name and UUID are manifest-bound | Fresh read-only inventory matching the staging target | `blocked` |
| Backup | Report-v2 checksum, size, snapshot and freshness are manifest-bound | Fresh protected, non-empty staging backup no older than 60 minutes | `blocked` |
| Restore | Candidate, target, integrity, FK and ledger evidence are manifest-bound | Isolated staging restore drill for the exact candidate | `blocked` |
| Migrations | Complete ordered ledger and database preflight run before and after build | Approved forward-only `0029`-`0080` window and pre-`0066` OAuth decision | `blocked` |
| Worker | Build and dry-run are local-only | Exact previous/candidate Worker versions and reviewed deploy window | `blocked` |
| Providers | Website-first boundary and provider fail-closed runtime exist | Dedicated PayOS test channel; Telegram bot only if separately approved | `waiting_provider` |
| Pilot | Safe scorecard and local regression map exist | Named eligible sellers, support/legal owners and private observations | `not_started` |

Any identity, ledger, evidence, or preflight drift invalidates the admission. A
new manifest and new review are required; an operator must never edit evidence to
make a stale candidate pass.

## Monitoring contract

The thresholds below are candidate admission defaults. Named people and private
notification destinations must be recorded outside source control before the
window. A missing owner or acknowledgement path is a stop condition.

| Signal | Warning threshold | Stop threshold | Evaluation window | Accountable role |
| --- | --- | --- | --- | --- |
| Candidate/D1/migration drift | none | any mismatch or incomplete preflight | continuous and immediately before every mutation | release owner + data owner |
| Worker availability | 5xx rate `>1%` | 5xx rate `>2%` or any repeated commerce 5xx | rolling 5 minutes | release owner |
| Worker latency | p95 `>1500 ms` | p95 `>3000 ms` | rolling 5 minutes | release owner |
| D1 mutation health | any retry/error | any failed or ambiguous commerce mutation | per request and rolling 5 minutes | data owner |
| Tenant isolation | none | any cross-shop read, write, cache, event, or evidence reference | per request, continuous | security owner + data owner |
| Exact payment | completion exceeds 60 seconds | wrong amount/currency/tenant, more than one transition, or no authoritative result after 120 seconds | per approved test case | payment incident owner |
| Payment exceptions | any new exception requires acknowledgement | any partial, overpaid, late, or mismatched payment auto-fulfills | per event and rolling 5 minutes | payment incident owner |
| Inventory | reservation age `>15 min` | negative stock, oversell, cross-tenant allocation, or unexplained reservation age `>30 min` | per checkout and rolling 5 minutes | data owner |
| Fulfillment | exact paid fulfillment lag `>5 min` | duplicate delivery, plaintext leakage, or lag `>15 min` | per order | integration incident owner |
| Queue/DLQ | oldest message age `>5 min` | DLQ growth `>0` or oldest age `>15 min` | rolling 5 minutes | integration incident owner |
| Provider health | one retryable outage | invalid identity/signature accepted, stale health used, or provider ambiguity | per request and rolling 5 minutes | payment/integration owner |
| Support | first response exceeds 10 minutes | support owner unavailable or Sev-1 acknowledgement exceeds 15 minutes | active watch | support owner |
| Budget | `>=80%` of an approved private limit | `>=100%` or no configured budget alert | hourly and daily | finance/budget owner |

The absolute financial limits and notification destinations may be sensitive and
remain in the private operations record. The ratio thresholds and stop behavior
are part of this reviewed contract.

## Observation windows

| Window | Required observation | Exit rule |
| --- | --- | --- |
| `T-30m` to deploy | Identity, backup, restore, ledger, preflight, owner availability and dashboards | Every gate passes for the exact candidate |
| `T+0` to `T+15m` | Continuous Worker, D1, tenant, queue, payment and provider watch | No stop threshold; owners acknowledge at `T+5m` and `T+15m` |
| `T+15m` to `T+60m` | Controlled pilot cases only; no traffic expansion | All executed cases are reconciled or passed |
| Per seller/case | Observe through authoritative payment, inventory and fulfillment settlement | Independent order/payment/fulfillment states agree |
| `T+24h` | Queue/DLQ, exceptions, support, budget, stale reservations and cleanup review | No unresolved critical item; otherwise keep the pilot stopped |

Readiness must be re-read from the authoritative service immediately before
publish and before the first paid checkout. A projection older than five minutes,
unavailable, role-forbidden, or for another selected shop cannot admit a pilot
action.

## Stop and rollback conditions

Stop new checkout and fulfillment immediately for any P0/P1 security issue,
tenant mismatch, candidate or D1 drift, ambiguous payment, duplicate state
transition/delivery, exception auto-fulfillment, negative/oversold stock, secret
or buyer-data leakage, stale readiness, unexplained DLQ growth, unavailable owner,
or any stop threshold above.

Runtime rollback uses only the exact captured previous staging Worker version.
D1 remains forward-only: fix forward where possible, otherwise follow a
separately approved protected restore/cutover plan; never run a down migration.
Provider work is paused through its owning service, and payment, inventory,
fulfillment, queue and audit ledgers are reconciled before resuming. Cleanup must
remove or revoke only the exact pilot resources recorded in the private plan and
must preserve reference-only audit evidence.

## Approval record required before remote work

- Named release, data, security, payment, integration, support, pilot and
  finance/budget owners with tested acknowledgement paths.
- Exact staging account/D1/Worker/resource inventory and least-privilege operator
  authorization.
- Fresh backup/restore evidence, migration/OAuth decision, rollback target and
  approved continuation window.
- Monitoring dashboards and alerts configured to the contract above.
- Pilot seller eligibility, legal/support decisions, provider acceptance and the
  private scorecard initialized from `docs/PHASE_3_PILOT_SCORECARD.md`.
