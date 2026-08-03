# Domain state machines va UI obligations

## Bat bien chung

- D1 va tenant-scoped services la authority. Browser, cache, queue receipt, provider page, return URL, QR va optimistic UI khong tao business truth.
- Order, payment, fulfillment, entitlement va provider health la cac truc doc lap.
- Moi transition do server thuc hien. UI chi gui command hop le, hien pending, sau do reload projection.
- Mutation giu capability, CSRF/recent-auth, idempotency va expected version. `409` -> reload, khong ep client transition.
- Khong expose credential, key/artifact plaintext, provider payload, buyer token/hash, queue body/object key/replay hash.

## Shop, subscription, onboarding va publication

### Shop lifecycle

```text
draft -> active
active -> suspended -> active
draft|active|suspended -> archived
```

- `draft -> active` chi qua fresh readiness + owner publication.
- Moderation/deletion co the suspend.
- Deletion initiation suspend va remove canonical routing.
- `archived` operationally terminal.

UI: tach shop lifecycle khoi subscription, readiness va publication. Suspended/archived khong duoc co live-routing indicator.

### Subscription

```text
trialing | active | past_due | grace_period | suspended | canceled
```

Checkout/publication policy hien cho `trialing`, `active`, `past_due`; `past_due` can warning. `grace_period` khong tu dong duoc phep theo policy hien tai. Deletion final -> `canceled`.

UI: dung feature flags/limits server; billing renders the authoritative projection and owner-only audited plan-change/cancel request intents. A request remains `provider_pending` and never implies upgrade/downgrade/payment-method/settlement completion.

### Onboarding steps

```text
account_ready -> shop_created -> channel_selected -> catalog_ready
-> inventory_ready -> telegram_ready -> payos_ready -> domain_ready
-> readiness_passed -> published
```

Per-step status:

```text
pending | in_progress | complete | blocked | skipped
```

Day khong phai linear truth: Telegram disable co the `skipped`, re-enable quay lai `pending`; completed step khong chung minh current readiness.

UI: render server state/blocker, cho re-entry/regression, khong complete theo visited route.

### Readiness

Server compute cac check `pass|warning|fail` voi `required`, freshness va action URL. Publication can shop/subscription publishable, selected entitled channel, platform domain, active catalog, fulfillment availability, fresh PayOS/webhook, Telegram neu selected, policy/attestation va khong critical integration error. Custom domain requested nhung chua ready co the warning neu platform subdomain fallback ready.

UI: hien tat ca checks; khong tu tinh aggregate; refresh sau integration/catalog/inventory/policy/domain change.

### Storefront publication

```text
never_published | published | unpublished_changes
```

Draft edit khong thay live snapshot. Publish atomically promotes current draft neu version/readiness hop le. Edit tiep -> `unpublished_changes`.

UI: tach draft/live, hien published version/pending changes, gui exact version, conflict thi reload.

## Catalog va inventory

### Category/product/variant

```text
category: draft | active | archived
product:  draft | active | suspended | archived
variant:          active | suspended | archived
```

Public catalog can active product + active variant trong published projection. Archived giu historical evidence; suspended co the do moderation va seller edit khong bypass.

UI: khong hard delete; tach draft/live/moderation; edit khong imply publish.

### Inventory key

```text
available -> reserved -> sold
reserved  -> available       # unpaid expiry/release
available -> revoked
reserved  -> revoked
```

Cam `sold -> available/reserved` va `revoked -> available`. Reservation atomic exact quantity; exact paid settlement sells; expired unpaid release. Counts chi la projection, khong guarantee allocation.

UI: khong optimistic decrement; khong render key rows/plaintext; requote truoc checkout; stock/catalog drift can review.

## Cart, quote va checkout

### Cart

```text
active -> converted
active -> expired
```

Local cart chi presentation/cache. Expired/converted khong resurrect.

### Quote

Client presentation co the la:

```text
ready | price_changed | item_changed | expired | invalid
```

Authority la signed evidence, catalog/version evidence va server checkout validation. UI hien changed lines va requote; khong cho snapshot cu override.

### Checkout initial outcomes

```text
payable:
  order=pending_payment, payment=unpaid, fulfillment=reserved

free synchronous:
  order=completed, payment=paid, fulfillment=fulfilled

free async/manual/generated:
  order=processing, payment=paid, fulfillment=unfulfilled
```

## Order va payment

### Order

```text
pending_payment | processing | completed | canceled | expired | exception
```

- Exact paid -> `processing` hoac `completed` tuy fulfillment.
- Unpaid expiration chi tu pending/unpaid.
- Partial/overpaid/late/identity mismatch/inconsistent -> `exception`.
- Cancel/expire khong chung minh refund.

### Payment

```text
unpaid | pending | paid | partial | overpaid | failed | expired | refunded
```

Paid can exact authenticated evidence dung tenant/provider credential/order. Partial/overpaid/late/mismatch khong fulfill. Exact verified refund/chargeback -> refunded va revoke future access, nhung khong rewrite sold/consumed history.

### Payment attempt decision

```text
creating | pending | paid_exact | partial | overpaid | late
| identity_mismatch | inconsistent | terminal_unpaid | error
```

Chi `paid_exact` authorize settlement. Return/cancel URL, QR create/display, browser provider success khong confirm payment.

UI: luon render order/payment/fulfillment rieng; sau provider return hien "dang kiem tra" va reload; partial/overpaid la manual review, khong success.

## Fulfillment va access

### Legacy/order projection

```text
fulfillment row: pending | fulfilled | failed | manual_review
order projection: unfulfilled | reserved | fulfilled | failed | manual_review
```

Exact payment atomically fulfills pooled keys. Manual ledger chi ghi immutable completed evidence, can paid order + owner/manager + exact item + active shop + idempotency + no conflicting typed requirement. Order completed chi khi moi required path xong, gom generated-license guard.

UI: manual action theo server policy; reload order sau success; history immutable.

### Private file

```text
asset: active -> revoked -> deleted
       active ----------> deleted
policy: active -> retired
entitlement: active -> suspended|expired|revoked|exhausted
             suspended -> active|expired|revoked
grant: active -> consumed|expired|revoked
```

Download can paid order + active/unexpired entitlement + active asset + quota + issued grant. Grant short-lived/single-purpose; Worker stream, khong permanent R2 URL.

### Generic entitlement

```text
resource/policy: active -> retired
entitlement: pending -> active|revoked
             active -> suspended|expired|revoked
             suspended -> active|expired|revoked
```

Free checkout tao active entitlement + immutable grant. Paid checkout tao pending; exact claimed signed payment activates. TTL/reversal/deletion append immutable transitions.

UI: paid != access active; show TTL/status server; khong edit transition history.

### Generated license

```text
provider connection: active | degraded | disabled -> retired
credential: active | grace -> revoked -> destroyed
binding: active -> retired

request:
  pending -> processing|canceled
  processing -> retryable|reconcile_pending|succeeded|failed|manual_review|canceled
  retryable -> processing|canceled
  reconcile_pending -> processing|canceled
  failed|manual_review -> retryable
  terminal: succeeded|canceled

artifact: active -> revoked -> destroyed
DLQ: open -> acknowledged -> retry_requested -> resolved
```

Ambiguous network/malformed success -> `reconcile_pending`; reconcile truoc second generate. Succeeded can immutable evidence + active artifact. Reversal/deletion cancel nonterminal va revoke artifact khong provider I/O.

UI: tach queued/processing/retry/reconcile/manual-review/failed/canceled/ready. Browser khong re-trigger generate, khong gui provider evidence, khong reveal neu payment/entitlement/artifact/buyer-channel fences chua pass. Provider setup hien service-only/provider-pending.

## Integrations va payment provider health

### Generic channel

```text
shop channel: pending | enabled | disabled
connection: pending -> active|degraded|disconnected
            active <-> degraded
            active|degraded -> disconnected
credential: pending|active|grace|error -> revoked
connector request: requested -> provider_pending -> active|rejected
                   requested|provider_pending -> canceled
```

Effective capability = adapter support x provider grants x plan entitlement x platform policy x expiry x health.

`connector request` is the durable seller intent from migrations `0055`-`0056`; it is not a
connection or credential. `active` requires reviewer evidence and a hashed provider
reference, while `canceled`, `rejected` and `active` rows are immutable. The browser
can create or self-cancel only with idempotency and expected-version guards.

UI: tach configured/connected/healthy/capability-enabled; show requested/provider-pending/
rejected/canceled connector states separately; disconnected row terminal, reconnect tao
connection moi. Never infer provider activation, webhook verification or message delivery
from a connector request status.

### Telegram

```text
integration: pending | active | degraded | disabled | error
webhook: pending | verified | mismatch | disabled | error
credential: pending | active | revoked | error
recipient: active | blocked | unavailable
```

UI: khong gop mot badge; readiness can fresh health; token/secret never returned.

### Payment provider

```text
legacy integration: pending | active | error | disconnected
webhook: pending | verified | error | disconnected
provider-neutral connection: pending | active | degraded | disconnected
```

Safe readiness co registered/configured/ready/freshness/effective capabilities/currencies/methods/reasons. UI khong equate registered/configured/active/webhook verified/ready.

## Domains

Persisted:

```text
pending | validating | active | failed | suspended | deleted
```

Ownership/pipeline:

```text
ownership_pending -> ownership_verified
-> provider/DNS checking -> validating -> active
```

Active chi khi hostname + SSL + DNS active. Primary/canonical routing la state rieng. Chi active/verified/ready custom domain duoc primary. Khi primary fail readiness, service demote va promote active platform-subdomain fallback. Delete suspend/remove routing truoc, provider reconcile roi `deleted`; live payment origin co the block.

UI: lifecycle rail rieng cho ownership, hostname, DNS, SSL, primary, routing; khong "Connected" tu TLS/poll don le; luon hien platform fallback; reload version sau action.

## Automation

Automation level:

```text
automatic | approval_required | external_action | unsupported
```

Initial task:

```text
automatic -> pending
approval_required -> waiting_user
external_action -> waiting_provider
unsupported -> canceled
```

Task:

```text
pending|waiting_user|waiting_provider|retryable -> running
running -> succeeded|retryable|failed
pending|waiting_user|waiting_provider|retryable -> canceled
```

Live running lease khong cancel; terminal khong reopen. Continuation evidence do server issue/verify, UI button khong la authority.

UI: show level, state, next attempt, safe error, canCancel/continuation/version; conflict reload; action requested != external completed.

## Deletion va legal hold

Request:

```text
processing | blocked | retention_hold | failed | completed | canceled
```

Ordered steps:

```text
checkout_block -> routing_remove -> active_payment_drain -> grace_wait
-> custom_domain_cleanup -> telegram_cleanup -> payment_cleanup
-> crypto_shred -> finalize
```

Step:

```text
pending | processing | blocked | completed | failed | skipped
```

Request block checkout/remove routing immediately. Payment, grace, legal hold co the block. Provider cleanup failure resumable. Legal hold blocks cleanup/crypto-shred/finalize. Cancel chi truoc irreversible work, no live lease/hold, exact version/idempotency; remaining reversible steps -> skipped. Completion archives shop/cancels subscription/revokes access va giu required financial/audit evidence.

UI: ordered immutable ledger, blocker/deadline/attempt/irreversible boundary; khong skip/reorder; resume requested != completed.

## Incidents, DLQ, events va delivery

```text
incident: open -> acknowledged -> resolved
DLQ: open -> acknowledged -> retry_requested -> resolved
     open|acknowledged -----------------------> resolved
domain event: pending|retryable -> processing -> published|retryable|failed
delivery job: pending|retryable -> processing -> delivered|retryable|failed|dead_letter
```

Repeated active incident co the reopen/escalate; recurrence sau resolved tao incident moi. Failed/dead-letter chi retry qua linked audited request. `retry_requested` chi la intent, khong prove enqueue/process/delivery.

UI: tach requested/enqueued/processing/completed/failed; safe refs/counts/severity/version/resolution only; reload canonical state after action.

## Maturity boundary

Backend/schema/test da co: canonical checkout/payment, catalog/inventory, pooled/manual/private/generic/generated fulfillment graphs, domains, onboarding/readiness/publication, automation, deletion/legal hold, incidents/DLQ.

Provider/config hoac intentional pending: production PayOS seller channel UAT, Telegram bot and Mini App activation, Zalo/WhatsApp/Discord provider execution, external customer custom domains, generated-license provider configuration, billing settlement/proration, seller order override/retry/message delivery and provider-backed catalog rollout. Migration `0069` now supplies the tenant-bound product/channel visibility contract; seller GET/PUT is source/local-only and the products UI exposes inline controls with fail-closed hydration and version-conflict reloads. Migrations `0055`-`0056` connector catalog/request state, migration `0057` Mini App session exchange, migration `0058` provider-event receipts, migration `0059` customer-identity references, migrations `0060`-`0062` Zalo OA OAuth state/retry hardening, migration `0063` enabled-channel scope repair, migration `0064` provider-verification evidence, migration `0065` credential-lineage/connection-identity guards, migration `0066` blind Zalo OA state lookup and migration `0067` Mini App active-plan scope guard are contract-ready but do not activate a provider. Pre-`0066` pending OAuth rows require an explicit cutover policy.
