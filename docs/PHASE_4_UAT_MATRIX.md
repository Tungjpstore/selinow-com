# Phase 4 UAT Matrix

P5 execution note (2026-08-04): no scenario was executed. Current reference-safe
results are recorded in `docs/PHASE_5_UAT_RESULTS.md`; this contract is unchanged.

Status: `local_ready_remote_blocked`. Local tests are evidence of source behavior
only. Every staging observation below is unexecuted.

| Scenario | Authority | Setup/action | Expected state | Prohibited state | Local test | Staging observation/evidence | Owner | Stop/reconciliation | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `exact_payment` | D1 order/payment/allocation/fulfillment ledgers | exact Website order; valid tenant-bound signed event | one paid transition/allocation/fulfillment | return/QR success or duplicate delivery | `tests/unit/payment-webhook-credentials.test.ts` | private request/event refs; not observed | payment owner | pause fulfillment; direct reconcile | `not_started` |
| `duplicate_webhook` | D1 payment event/idempotency ledgers | replay identical valid event | stable prior result | second allocation/fulfillment | `tests/unit/payment-webhook-credentials.test.ts` | private replay refs; not observed | payment owner | stop lane; reconcile dedupe | `not_started` |
| `partial_payment` | D1 exception inbox | signed amount below exact order | exception/manual review | paid or fulfilled | `tests/unit/payment-webhook-credentials.test.ts` | private exception ref; not observed | payment owner | pause order; reconcile | `not_started` |
| `overpaid_payment` | D1 exception inbox | signed amount above exact order | exception/manual review | auto-fulfill | `tests/unit/payment-webhook-credentials.test.ts` | private exception ref; not observed | payment owner | pause order; reconcile | `not_started` |
| `late_payment` | D1 order/payment ledgers | valid payment after expiry | exception/reconciliation | auto-fulfill expired order | `tests/unit/payment-reconciliation.test.ts` | private event ref; not observed | payment owner | hold fulfillment; reconcile | `not_started` |
| `mismatched_payment` | tenant credential + D1 mapping | wrong tenant/currency/order identity | rejected/exception | paid transition | `tests/unit/payment-webhook-credentials.test.ts` | private safe refs; not observed | payment + security owners | stop lane; investigate | `not_started` |
| `inventory_race` | D1 stock/reservation/allocation | concurrent final-item checkouts | one winner, non-negative stock | oversell/cross-shop allocation | `tests/unit/commerce-channel-parity-real-d1.test.ts` | private order refs; not observed | data owner | stop checkout; reconcile | `not_started` |
| `fulfillment_replay` | D1 fulfillment execution/grant | replay paid fulfillment | durable same result | repeated key/file delivery | `tests/unit/private-file-fulfillment.test.ts` | private execution refs; not observed | integration owner | pause worker; reconcile grants | `not_started` |
| `provider_outage` | provider adapter + durable D1 state | approved provider outage/recovery | safe retry/exception | false success or lost idempotency | `tests/unit/payment-store.test.ts` | provider evidence required | integration owner | stop provider lane; reconcile | `waiting_provider` |
| `stale_readiness` | authoritative readiness service | unavailable/forbidden/older than 5m projection | publish/checkout blocked | client state admits action | `tests/unit/readiness.test.ts` | private projection ref; not observed | release owner | stop seller action; refresh authority | `not_started` |
| `shop_switch_inventory_request` | selected-shop server projection | switch shop during preview/import | abort stale request and erase object/body plaintext | shop A result shown for B | `tests/unit/inventory-frontend-contract.test.ts` | safe client trace; not observed | security owner | stop session; inspect isolation | `not_started` |
| `billing_response_loss` | D1 billing session/idempotency + Dodo | lose approved provider response and retry | same provider identity; one checkout | duplicate session/subscription | `tests/unit/dodo-billing.test.ts` | Dodo test evidence required | billing owner | stop billing; direct reconcile | `waiting_provider` |
| `support_escalation` | incident roster/ack system | trigger approved Sev-1 drill | ack within threshold | silent/unowned incident | `tests/unit/phase-4-artifacts.test.ts` | private ack ref required | support owner | stop pilot; escalate rollback owner | `pending_user` |
| `rollback_cleanup` | captured Worker/resource state + D1 ledgers | approved rehearsal or rollback | exact version/resources restored or fix-forward reconciled | down migration/broad deletion | `tests/unit/production-canary.test.ts` | private rollback/cleanup refs required | rollback owner | keep pilot stopped until reconciled | `pending_user` |
| `tenant_isolation` | authz + D1 `shop_id` + audit | cross-shop reads/mutations for pilot shops | forbidden/no state change | any cross-shop data/evidence | `tests/unit/commerce-channel-parity-real-d1.test.ts` | private opaque shop refs; not observed | security + data owners | Sev-1 stop; reconcile all ledgers | `not_started` |
| `migration_retry` | D1 migration ledger | retry after known safe failure/response | exact ordered prefix then one forward apply | extra/out-of-order/partial dangerous state | `tests/unit/staging-release-admission.test.ts` | protected ledger refs required | data owner | no blind retry; inventory and reconcile | `pending_user` |
| `deploy_response_ambiguity` | Worker versions/deployments + captured prior version | simulate/observe ambiguous deploy response | read-only inventory resolves exact version | blind redeploy or guessed rollback | `tests/unit/deploy-guard.test.ts` | private version/inventory refs required | release owner | stop; reconcile; captured rollback only | `pending_user` |
| `monitoring_acknowledgement_loss` | alert delivery + incident roster | suppress/lose primary acknowledgement | secondary escalation and pilot stop | continued traffic without owner | `tests/unit/phase-4-artifacts.test.ts` | private alert/ack refs required | support + release owners | stop pilot; escalate/rollback | `pending_user` |

Website is first. Telegram and Dodo cases remain excluded until their dedicated
test resources and owners are explicitly admitted. Required observation windows
are `T+15m`, `T+60m`, and `T+24h`; GET-only smoke never substitutes for payment,
inventory, fulfillment, support, or rollback UAT.
