# Phase 5 UAT Results

Overall status: `not_started`

No scenario was executed against a provider or staging commerce mutation path.
Local tests remain source-behavior evidence only and are not staging acceptance.

| Scenario | Status | Reason |
| --- | --- | --- |
| `exact_payment` | `not_started` | provider/staging mutation not authorized |
| `duplicate_webhook` | `not_started` | provider/staging mutation not authorized |
| `partial_payment` | `not_started` | provider/staging mutation not authorized |
| `overpaid_payment` | `not_started` | provider/staging mutation not authorized |
| `late_payment` | `not_started` | provider/staging mutation not authorized |
| `mismatched_payment` | `not_started` | provider/staging mutation not authorized |
| `inventory_race` | `not_started` | staging commerce mutation not authorized |
| `fulfillment_replay` | `not_started` | staging fulfillment mutation not authorized |
| `provider_outage` | `waiting_provider` | no approved provider test lane or owner |
| `stale_readiness` | `not_started` | exact candidate not deployed |
| `shop_switch_inventory_request` | `not_started` | exact candidate not deployed |
| `billing_response_loss` | `waiting_provider` | no approved Dodo test lane or owner |
| `support_escalation` | `pending_user` | roster and acknowledgement path absent |
| `rollback_cleanup` | `pending_user` | previous Worker version and rehearsal approval absent |
| `tenant_isolation` | `not_started` | staging commerce mutation not authorized |
| `migration_retry` | `pending_user` | Gate B and protected evidence absent |
| `deploy_response_ambiguity` | `pending_user` | Gate B and version inventory absent |
| `monitoring_acknowledgement_loss` | `pending_user` | remote alerts and acknowledgement path unproven |

Score: 0 passed, 0 failed, 11 not started, 2 waiting provider, and 5 pending
user. No scenario is represented as accepted or reconciled.
