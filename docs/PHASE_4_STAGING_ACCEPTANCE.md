# Phase 4 Staging Acceptance

Status: `local_ready_remote_blocked`

Candidate: `bff69f9d26a04b1318fd9862afa6eaffb8c003f4`

This is an executable evidence contract, not staging evidence. No remote mutation
is authorized by this file. The P4 task contains no explicit staging-mutation
approval, operator credential, named owner roster, provider acceptance, or
private monitoring acknowledgement path.

## Admission sequence

The only permitted future mutation order is: clean reviewed candidate; fresh
read-only identity/resource inventory; protected non-empty report-v2 backup;
checksum/size/freshness verification; candidate-bound isolated restore; private
schema-3 manifest with a non-empty live ledger baseline; exact baseline and
preflight; forward-only migrations; repeated complete ledger/integrity/FK/preflight;
credential-free build; repeated admission;
candidate deploy; smoke; monitoring; Website-first UAT; confirm or captured-version
rollback; reconciliation; exact cleanup.

Manifest creation captures the live `d1_migrations` rows as a non-empty exact
ordered prefix of `0001`-`0080` after read-only account/D1 admission. Migration
requires database preflight to pass and the live ledger to equal that exact
manifest-bound baseline before Wrangler; after Wrangler it requires the complete
ordered source ledger and another passing preflight. Seed and deploy require the
complete ordered ledger and passing database preflight. Missing, empty, extra,
duplicated, out-of-order, reset, or changed baseline rows stop closed.

## Required private evidence

The release owner must record the exact commit/tree/release ID, account ID, D1
name and UUID, protected backup report/checksum/size/snapshot, isolated restore
report/target, complete ledger, pre-`0066` OAuth-row disposition, prior Worker
version, owner roster, acknowledgement paths, window approval, dashboard/alert
references, smoke/UAT observations, reconciliation, rollback or confirmation,
and cleanup. Evidence files remain mode `0600` outside Git.

## Monitoring contract

"Configured" is prohibited until private remote proof exists.

| Signal | Metric/source | Warning threshold | Stop threshold | Window | Owner | Notification/ack reference | Stop/rollback/reconciliation action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Worker availability | Cloudflare Worker request status | 5xx `>1%` | 5xx `>2%` or repeated commerce 5xx | rolling 5m | release owner | private alert + ack ref | pause checkout; captured-version rollback |
| Worker latency | Cloudflare Worker p95 duration | p95 `>1500ms` | p95 `>3000ms` | rolling 5m | release owner | private dashboard + ack ref | pause traffic; rollback or fix forward |
| D1 ambiguity | D1 errors, mutation result, request ref | any retry/error | any failed or ambiguous commerce mutation | per request + rolling 5m | data owner | private incident ref | stop retries; read-only reconcile ledger/state |
| Tenant isolation | auth/audit tenant mismatch counter | none | any cross-shop read/write/cache/event/evidence | continuous | security + data owners | Sev-1 ack ref | stop pilot; isolate traffic; investigate and reconcile |
| Exact payment | payment/order transition ledger | over 60s | identity/tenant/currency/amount mismatch, duplicate transition, or over 120s | per case | payment owner | payment incident ack ref | pause fulfillment; direct tenant-bound reconciliation |
| Payment exceptions | payment exception inbox | any unacknowledged exception | partial/overpaid/late/mismatch auto-fulfills | per event + rolling 5m | payment owner | exception ack ref | stop checkout/fulfillment; reconcile |
| Inventory | reservation/stock/allocation ledger | reservation over 15m | negative stock, oversell, cross-shop allocation, or over 30m | per checkout + rolling 5m | data owner | inventory ack ref | stop checkout; reconcile reservations/allocations |
| Fulfillment | paid-to-delivery lag and delivery dedupe | lag over 5m | duplicate delivery, plaintext leakage, or lag over 15m | per order | integration owner | fulfillment ack ref | pause fulfillment; revoke exact grants if approved; reconcile |
| Queue/DLQ | queue oldest age and DLQ count | oldest over 5m | DLQ growth or oldest over 15m | rolling 5m | integration owner | queue alert + ack ref | pause consumers; bounded replay after reconciliation |
| Provider health | provider adapter safe status/retry code | one retryable outage | invalid identity/signature accepted or ambiguous provider result | per request + rolling 5m | payment/integration owners | provider ack ref | stop affected lane; read-only reconcile before retry |
| Secret/PII leakage | redacted log/evidence scanner | any suspected match | any confirmed credential, PII, key, payload, or private object ref | continuous | security owner | Sev-1 ack ref | stop pilot; contain/revoke; preserve reference-only audit |
| Support acknowledgement | incident roster timer | response over 10m | owner unavailable or Sev-1 ack over 15m | active watch | support owner | tested private acknowledgement ref | stop pilot and escalate to rollback owner |
| Infrastructure budget | Cloudflare/provider spend ratio | at least 80% | at least 100% or missing alert | hourly + daily | finance owner | budget alert + ack ref | stop expansion; disable approved pilot traffic |

## Decision

Staging remains blocked. A local GET-only dry-run or local restore cannot satisfy
backup, provider, monitoring, payment, fulfillment, or owner evidence.
