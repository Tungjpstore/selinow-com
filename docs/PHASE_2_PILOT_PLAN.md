# Phase 2 Controlled Pilot Plan

Status: proposed plan; no seller or provider evidence recorded

This is a 3-5 seller controlled pilot for the exact reviewed candidate. It is
not production-wide launch, mass acquisition, or provider activation approval.

## Eligibility

- Named owner-approved seller with a real digital product, license-key, or
  private-file use case.
- Seller can provide a safe test product, support contact, policy URLs, and a
  rollback/offboarding acknowledgement.
- Website is the default lane. Telegram is included only when a dedicated seller
  bot and private `/start` acceptance are separately approved.
- No shared bot, marketplace, buyer account, WhatsApp/Zalo/Discord runtime, or
  second payment provider is introduced.

## Environment and credentials

- Use the exact reviewed staging Worker and D1 after explicit mutation approval;
  until then, use only local isolated evidence.
- Credentials are owner-provided through the approved secret/configuration
  boundary. Never place values in this plan, chat, screenshots, logs, or test
  artifacts.
- Allowed provider credentials: the seller's dedicated PayOS test channel and,
  if selected, a dedicated Telegram bot. Dodo billing remains provider-pending
  until merchant and webhook UAT are approved.

## Test product and setup

- One low-value product with one active variant and server-valid shop currency.
- License-key inventory or an explicitly approved manual-fulfillment policy.
- Published policy/support URLs and a platform subdomain; custom domain only as a
  separately approved acceptance case.
- Record only opaque pilot ID, safe request IDs, milestone codes, timestamps,
  status/reason codes, and private evidence references.

## Acceptance sequence

1. Create/select the shop and record `setup_started` and `shop_created`.
2. Create the product and initial variant atomically; verify replay and changed-
   payload idempotency behavior.
3. Preview/import inventory in two steps; verify duplicate/rejected handling,
   recent-auth, pending-action locking, and plaintext cleanup on success,
   cancel, close, shop switch, and error.
4. Configure Website. If Telegram is selected, connect the dedicated bot,
   verify webhook identity, send private `/start`, and keep `waiting_user`/
   `waiting_provider` separate.
5. Configure PayOS with the dedicated test channel and verify fresh signed
   webhook health. QR and return URLs are display/recovery only.
6. Run readiness, then the read-only safe test. The safe test must not create an
   order, payment, inventory reservation, or fulfillment record.
7. Publish through owner/recent-auth/readiness/expected-version guards and verify
   the authoritative reload.
8. Create one exact test order and record independent order, payment, and
   fulfillment states.
9. Send an exact signed payment event, then replay the identical webhook.
10. Verify one payment transition, one inventory allocation, one fulfillment,
    and seller visibility without rendering keys, tokens, or raw provider data.
11. Exercise partial, overpaid, mismatched, and late payment cases; each stops
    automatic fulfillment and enters manual review/exception handling.
12. Replay fulfillment and scheduled retries; verify no duplicate delivery.
13. Exercise billing response-loss/recovery and same-plan recovery only when the
    Dodo test environment has been separately admitted.
14. Capture seller value confirmation and support follow-up using safe references.

## Stop, rollback, and cleanup

Stop immediately for tenant mismatch, ambiguous provider identity, invalid
signature, duplicate transition, partial/overpaid/late/mismatched payment,
stale health, secret leakage, unsupported provider claim, or missing support/legal
owner. Do not bypass a gate to keep a pilot moving.

Rollback means pause new checkout/fulfillment, restore the exact accepted Worker
version or fix forward schema, and reconcile payment/inventory/fulfillment
ledgers. Never run a down migration. Custom-domain rollback returns the seller
to the platform subdomain through the owning service.

Delete or revoke pilot products, test orders, credentials, domains, queues,
objects, webhook registrations, and local artifacts according to the approved
data-retention/offboarding record. Preserve only safe reference-only evidence.

## Proposed acceptance thresholds

These are owner-review targets, not evidence:

- pilot sellers: `3-5`;
- time-to-publish: owner threshold TBD;
- activation rate through `storefront_published`: threshold TBD;
- exact signed payment success: `100%` of approved test cases;
- first paid fulfilled success: `100%` of approved exact-payment cases;
- duplicate replay creates no additional payment, allocation, or fulfillment;
- support burden: threshold TBD minutes/seller;
- trial conversion: threshold TBD;
- critical security incidents: `0`.
