# Phase 1 Pilot Readiness Runbook

This runbook is for 3–5 controlled seller pilots. It is not production-wide
acceptance and contains no credentials or buyer PII.

## Pilot record

- Pilot identifier: opaque owner-assigned ID
- Seller type/product type: `TBD`
- Website/Telegram selection: `TBD`
- PayOS readiness/UAT evidence: `TBD`
- Catalog and inventory type/count: `TBD`
- Platform subdomain or custom-domain choice: `TBD`
- Support owner/start date: `TBD`
- Success criteria and known limitations acknowledged: `TBD`

## Controlled sequence

1. Create shop and record `shop_created`.
2. Create/publish a digital product and inventory; verify no plaintext key in
   logs, screenshots, exports, analytics, queues, or support tickets.
3. Connect PayOS and verify fresh signed webhook health.
4. Connect Telegram only when selected; verify private `/start` evidence and
   webhook health without group-chat buyer data.
5. Confirm `preview_ready` and run the read-only safe test.
6. Confirm `live_ready`, publish, and create one controlled order.
7. Verify exact signed payment, one payment transition, one inventory allocation,
   one fulfillment, buyer reveal, and seller order visibility.
8. Replay the provider event and confirm no duplicate order/payment/fulfillment.
9. Record only safe request IDs, milestone codes, timestamps, and blocker codes.
10. Capture seller value confirmation and support follow-up using safe references.

## Exit criteria

- At least one controlled real order completes with exact signed payment and
  fulfillment evidence.
- Website-only sellers are not blocked by Telegram; Telegram-selected sellers
  pass the additional health gate.
- No secret, raw provider payload, buyer token, customer contact, or license-key
  plaintext appears in evidence.
- Rollback/offboarding path is tested and the seller acknowledges limitations.

## Stop conditions

Stop and escalate on partial/overpaid/late/mismatched payment, ambiguous provider
identity, duplicate transition, tenant mismatch, stale health evidence, secret
leakage, unsupported provider claim, or missing support/legal owner. Do not
auto-fulfill or bypass a gate to keep a pilot moving.
