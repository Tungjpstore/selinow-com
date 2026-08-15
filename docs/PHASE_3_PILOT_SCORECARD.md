# Phase 3 Controlled Pilot Scorecard

Overall pilot status: `not_started`

This scorecard is a schema and operating contract, not completed pilot evidence.
It is Website-first and may include Telegram or Dodo only after separate provider
acceptance. One private scorecard is required per reviewed candidate and pilot;
checked-in examples must never identify sellers, buyers, credentials or live
provider resources.

## Status vocabulary

Only these statuses are valid:

| Status | Meaning |
| --- | --- |
| `not_started` | No approved remote observation has begun |
| `pending_user` | A named seller/owner action or decision is required |
| `waiting_provider` | Provider configuration, review or response is required |
| `projection_unavailable` | Authoritative state cannot be read; never infer success |
| `passed` | The approved case met every expected authoritative state |
| `failed` | The case completed with a verified acceptance failure |
| `stopped` | A stop condition paused the pilot before acceptance |
| `reconciled` | An ambiguous/failed case was resolved against authoritative ledgers; this does not erase the original failure |

`passed` and `reconciled` require an observation timestamp and private evidence
reference. A scorecard cannot become globally `passed` while any required case is
`not_started`, `pending_user`, `waiting_provider`, `projection_unavailable`,
`failed`, or `stopped`.

## Evidence allowlist

Allowed checked-in or private scorecard fields are limited to the candidate and
release IDs, opaque pilot/shop IDs, scenario and milestone codes, safe request or
event references, booleans, bounded counts, canonical timestamps, safe reason
codes, accountable role references, and private report paths.

Never record seller/buyer names, email, phone, address, order-access tokens,
session/CSRF tokens, bot tokens, API keys, webhook secrets/signatures/bodies,
PayOS/Dodo credentials, QR/payment URLs, license-key plaintext, private object
keys, inventory plaintext, customer tokens, or provider credential ciphertext.
Screenshots and logs must follow the same rule.

## Scorecard template

The JSON below is a non-evidence template. `null` means no observation exists.

```json
{
  "schema": "phase_3_pilot_scorecard",
  "schemaVersion": 1,
  "candidateCommit": null,
  "environment": "staging",
  "overallStatus": "not_started",
  "pilot": {
    "pilotId": null,
    "sellerCount": null,
    "supportOwnerRef": null,
    "legalOwnerRef": null,
    "releaseOwnerRef": null
  },
  "scenarios": {
    "exact_payment": { "status": "not_started", "observedAt": null, "reasonCodes": [], "safeRequestRefs": [], "evidenceRefs": [] },
    "duplicate_webhook": { "status": "not_started", "observedAt": null, "reasonCodes": [], "safeRequestRefs": [], "evidenceRefs": [] },
    "partial_payment": { "status": "not_started", "observedAt": null, "reasonCodes": [], "safeRequestRefs": [], "evidenceRefs": [] },
    "overpaid_payment": { "status": "not_started", "observedAt": null, "reasonCodes": [], "safeRequestRefs": [], "evidenceRefs": [] },
    "late_payment": { "status": "not_started", "observedAt": null, "reasonCodes": [], "safeRequestRefs": [], "evidenceRefs": [] },
    "mismatched_payment": { "status": "not_started", "observedAt": null, "reasonCodes": [], "safeRequestRefs": [], "evidenceRefs": [] },
    "inventory_race": { "status": "not_started", "observedAt": null, "reasonCodes": [], "safeRequestRefs": [], "evidenceRefs": [] },
    "fulfillment_replay": { "status": "not_started", "observedAt": null, "reasonCodes": [], "safeRequestRefs": [], "evidenceRefs": [] },
    "provider_outage": { "status": "not_started", "observedAt": null, "reasonCodes": [], "safeRequestRefs": [], "evidenceRefs": [] },
    "stale_readiness": { "status": "not_started", "observedAt": null, "reasonCodes": [], "safeRequestRefs": [], "evidenceRefs": [] },
    "shop_switch_inventory_request": { "status": "not_started", "observedAt": null, "reasonCodes": [], "safeRequestRefs": [], "evidenceRefs": [] },
    "billing_response_loss": { "status": "waiting_provider", "observedAt": null, "reasonCodes": [], "safeRequestRefs": [], "evidenceRefs": [] },
    "support_escalation": { "status": "pending_user", "observedAt": null, "reasonCodes": [], "safeRequestRefs": [], "evidenceRefs": [] },
    "rollback_cleanup": { "status": "pending_user", "observedAt": null, "reasonCodes": [], "safeRequestRefs": [], "evidenceRefs": [] }
  },
  "monitoring": {
    "status": "pending_user",
    "observedAt": null,
    "alertsEvidenceRef": null,
    "dashboardEvidenceRef": null,
    "acknowledgementRefs": []
  },
  "notes": "Template only; no seller, buyer, provider or commercial observation is recorded."
}
```

## Local regression and remote evidence matrix

Local tests prove fail-closed behavior; they do not prove a provider or seller
observation. Every remote row therefore starts `not_started`, `pending_user`, or
`waiting_provider` even when local regression coverage passes.

| Scenario ID | Expected authoritative outcome | Local regression evidence | Local status | Initial pilot status |
| --- | --- | --- | --- | --- |
| `exact_payment` | One paid transition, one allocation and one fulfillment | `tests/unit/payment-webhook-credentials.test.ts`; `tests/unit/commerce-channel-parity-real-d1.test.ts` | `locally_verified` | `not_started` |
| `duplicate_webhook` | Replay creates no second payment event, allocation or fulfillment | `tests/unit/payment-webhook-credentials.test.ts` | `locally_verified` | `not_started` |
| `partial_payment` | Exception/manual review; never auto-fulfill | `tests/unit/payment-webhook-credentials.test.ts` | `locally_verified` | `not_started` |
| `overpaid_payment` | Exception/manual review; never auto-fulfill | `tests/unit/payment-webhook-credentials.test.ts` | `locally_verified` | `not_started` |
| `late_payment` | Exception/manual review and reconciliation; never auto-fulfill | `tests/unit/payment-webhook-credentials.test.ts`; `tests/unit/payment-reconciliation.test.ts` | `locally_verified` | `not_started` |
| `mismatched_payment` | Identity/amount/currency mismatch fails closed | `tests/unit/payment-webhook-credentials.test.ts` | `locally_verified` | `not_started` |
| `inventory_race` | Exactly one winner for the final stock item; no negative stock | `tests/unit/commerce-channel-parity-real-d1.test.ts`; `tests/unit/commerce-payment-fulfillment.test.ts` | `locally_verified` | `not_started` |
| `fulfillment_replay` | Stable replay returns the durable result without duplicate delivery | `tests/unit/private-file-fulfillment.test.ts`; `tests/unit/generated-license-fulfillment.test.ts` | `locally_verified` | `not_started` |
| `provider_outage` | Retry/backoff or exception state; no false success | `tests/unit/payment-store.test.ts`; `tests/unit/telegram-generic-delivery.test.ts` | `locally_verified` | `not_started` |
| `stale_readiness` | Publish/checkout remains blocked until a fresh authoritative projection | `tests/unit/readiness.test.ts`; `tests/unit/overview-ui.test.ts` | `locally_verified` | `not_started` |
| `shop_switch_inventory_request` | Abort stale request and erase object plus serialized plaintext references | `tests/unit/inventory-frontend-contract.test.ts` | `locally_verified` | `not_started` |
| `billing_response_loss` | Retry the same provider idempotency key and converge on one checkout | `tests/unit/dodo-billing.test.ts` | `locally_verified` | `waiting_provider` |
| `support_escalation` | Named support owner acknowledges, records safe reason/evidence and follows the stop policy | `docs/PHASE_3_STAGING_READINESS.md`; `docs/PHASE_2_PILOT_PLAN.md` | `contract_only` | `pending_user` |
| `rollback_cleanup` | Restore exact runtime or fix forward, reconcile ledgers, remove only exact pilot resources | `tests/unit/production-canary.test.ts`; `tests/unit/data-lifecycle.test.ts`; `docs/PHASE_3_STAGING_READINESS.md` | `locally_verified` | `pending_user` |

## Completion rule

The pilot may be reviewed for acceptance only when every required scenario has a
terminal `passed`, `failed`, `stopped`, or `reconciled` record, every failure is
explicitly dispositioned, monitoring covers the full observation windows, owner
acknowledgements exist, cleanup is complete, and no secret/PII field is present.
Commercial metrics remain observations rather than projections; do not infer
conversion, margin, CAC, churn or support cost from local tests.
