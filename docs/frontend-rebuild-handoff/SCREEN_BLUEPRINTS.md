# Screen blueprints

Day la content/behavior blueprint, khong phai visual prescription. Doi moi tu do thay layout va component neu van giu data/action/state authority.

## Blueprint template

Moi implementation PR cho mot screen phai ghi:

- `Route/surface`.
- `Primary job` cua user.
- `SSR authority` va freshness.
- `Mandatory blocks`.
- `Actions` + exact endpoint/security.
- `States` tu `DOMAIN_STATE_MACHINES.md`.
- `Sensitive fields` va redaction.
- `No-contract controls` bi loai.

## Marketing va auth

### `/` marketing

- Job: hieu Selinow la gi, ban qua Website/Telegram nhu the nao, trust va next step.
- Mandatory: clear product boundary, channel/payment truth, process, capability maturity, runtime CTA/pricing links.
- Data: runtime plans/copy; host classifier.
- Actions: navigation only; no fake signup completion.
- States: ready, plans unavailable, wrong/reserved host 404.
- Anti-drift: khong noi Zalo/Meta/marketplace/second payment provider da ho tro; khong fake GMV/shop count.

### `/pricing`

- Job: so sanh plan bang server-projected feature/limit/price.
- Mandatory: plan cards/table, exact billing unit/currency, feature and limit source, caveat for external providers.
- States: ready, empty/unavailable, wrong host 404.
- Anti-drift: khong hard-code plan limits/price; khong co checkout plan mutation.

### `/login`

- Job: nhan magic link va vao workspace an toan.
- Mandatory: email, optional display name, acceptance/expiry guidance, rate-limit/error, privacy copy.
- Actions: magic-link request; consume route browser navigation; authenticated redirect `/app`.
- States: idle, submitting, accepted, rate-limited, invalid/expired, provider unavailable.
- Security: khong render initiation/token; debug link local-only; page private/noindex.

## Seller shell va overview

### Workspace shell

- Persistent: brand/surface identity, membership-bound shop switcher, role label, navigation, locale, logout.
- Shop switch reset: entity IDs, filters, cursors, hashes, drafts va pending requests cua tenant cu.
- Navigation visibility: role/capability driven; read-only routes can remain visible voi clear boundary.
- States: no shops, session expired, membership changed, role lookup unavailable.

### `/app`

- Job: biet shop nao dang duoc xem, health nao chan ban hang, viec can lam tiep theo, recent orders.
- Mandatory: shop identity/status/subscription, readiness summary with blocker links, order ledger, catalog/integration health only from real projections.
- Actions: navigate to fix; no fabricated quick mutations.
- States: no-shop, ready, individual projection forbidden/unavailable, shop suspended/plan blocked.
- Anti-drift: no fake revenue/conversion; payment va fulfillment in separate columns/badges.

### `/onboarding`

- Job: tao/chon shop va dat readiness de publish.
- Mandatory: durable step rail, selected channels, catalog/inventory, PayOS/Telegram/domain/policy, readiness details, dry-run test, publish consequence.
- Actions: exact shop/profile/channels/settings/catalog/inventory/integration/domain/readiness/publish APIs.
- States: per-step pending/in-progress/complete/blocked/skipped; waiting-user/provider; recent-auth; version conflict.
- Anti-drift: visited step != complete; dry-run test khong tao order; owner gates remain server-side.

## Catalog va inventory

### `/app/products`

- Job: tao va quan ly category/product/variant dung currency/status.
- Mandatory: search/status filters, category ledger, product/variant hierarchy, price/min-max, fulfillment type, publication/moderation status, version/update time.
- Actions: category create/update/archive; atomic product+initial variant; product/variant full update; private-file setup.
- States: empty, filtered empty, draft, active, suspended, archived, validation, idempotency/version conflict, forbidden/unavailable.
- Anti-drift: no hard delete; no hidden/channel visibility; active edit khong imply published snapshot.

### `/app/inventory`

- Job: xem counts va import key ma khong lo plaintext.
- Mandatory: variant identity, available/reserved/delivered, low-stock threshold, last import, two-step preview/import.
- Actions: preview exact paste/CSV; import same payload/token/idempotency.
- States: empty, preview accepted/duplicate/rejected, preview expired/drift, importing, complete/replay, recent-auth, unavailable.
- Security: plaintext khong vao SSR/HTML/log/screenshot/storage; clear input/memory after commit/cancel.

## Orders va customers

### `/app/orders`

- Job: scan recent orders va tach payment problem khoi delivery problem.
- Mandatory: order number, masked customer, amount/currency, channel, order/payment/fulfillment status, timestamps, exception indicator.
- Data: latest 200 only; client filter chi tren loaded set neu khong co server API.
- Actions: open detail; no refund/cancel/edit.
- States: empty, ready, payment-exception projection forbidden/unavailable, whole data unavailable.

### `/app/orders/:id`

- Job: hieu exact order history va action fulfillment hop le.
- Mandatory: immutable item snapshots, amount, order/payment/fulfillment axes, attempts, safe audit, private download counters, fulfillment records.
- Actions: seller-attested manual fulfillment chi khi server policy; reload sau commit.
- States: ready, processing, exception/manual review, completed, expired/canceled/refunded, 403 cross-tenant, 404 missing, unavailable.
- Anti-drift: no order token/key/provider raw; no messages/notes/refund/cancel/retry-delivery controls.

### `/app/customers`

- Job: doc masked customer ledger va order activity.
- Mandatory: masked email/display name, locale, status, order count, last order.
- Actions: optional navigate/filter only.
- States: empty, ready, forbidden/unavailable.
- Anti-drift: no detail/edit/merge/note/delete; khong unmask identity.

## Store va integrations

### `/app/store`

- Job: edit draft storefront, preview an toan, publish khi ready.
- Mandatory: draft/live version, unpublished-change marker, content/theme/SEO fields, stock visibility, narrow published-catalog preview, readiness blocker.
- Actions: PATCH draft with expectedVersion; owner publish with expectedVersion/recent-auth.
- States: never published, published, unpublished changes, blocked, conflict, forbidden/unavailable.
- Anti-drift: preview khong co buyer mutation; draft edit khong update public; logo URL/content fields only within server schema.

### `/app/integrations`

- Job: biet Telegram/PayOS/domain da registered/configured/healthy/ready hay chua, xem kenh mo rong va lam next safe action.
- Mandatory: separate credential/integration/webhook/readiness facts, checked time, safe error/reason, effective capabilities.
- Actions: Telegram connect/replace/disconnect/health; PayOS connect/disconnect/health; issue/list/revoke scoped API credentials; channel expansion catalog plus request/cancel connector intent; links to domains.
- States: disconnected, pending/connecting, waiting-user/provider, active, degraded/mismatch, requested, provider-pending, canceled/rejected, expired/error, credentials-empty/issued/revoked, forbidden.
- Security: secret input one-way; never render token/key/checksum/webhook secret/provider payload.
- API credential token is revealed exactly once after issue, copied only through the explicit action, and never persisted in browser storage or rendered again by list/reload.
- Channel expansion cards show safe capabilities, required seller action and contract-ready/provider-pending stage. They never render credentials, webhook secrets or provider payloads, and a request never implies provider activation or delivery.

### `/app/domains`

- Job: them va dua custom domain qua ownership -> DNS -> hostname -> SSL -> primary/routing.
- Mandatory: platform fallback, per-domain lifecycle rail, DNS instructions, last check/safe error, primary/canonical status, plan/external gate.
- Actions: create, check claim/domain, make primary, delete; owner/recent-auth/version context.
- States: no custom domain, ownership pending/expired/verified, validating, active, failed, suspended, deleted, payment-origin blocked, plan-limited.
- Anti-drift: TLS alone != connected; browser DNS != authority; no update hostname control.

### `/app/automation`

- Job: theo doi durable setup tasks va can thiep khi server cho phep.
- Mandatory: capability, automation level, status, attempts, next attempt, safe error, action URL, version.
- Actions: start only allowed API capabilities; cancel/resume by server projection, expectedVersion/idempotency.
- States: pending, waiting-user, waiting-provider, running, retryable, succeeded, failed, canceled, forbidden/unavailable.
- Anti-drift: no client evidence token; request accepted != external work completed; no cancel live lease.

## Account va data

### `/app/members`

- Job: owner doc active/inactive membership va role.
- Mandatory: masked identity, role, status, created time, clear read-only notice.
- States: empty, ready, forbidden, unavailable.
- Anti-drift: no invite/change role/revoke controls.

### `/app/billing`

- Job: owner hieu plan/subscription period/grace/usage/limits.
- Mandatory: server state, dates, feature flags, limits, usage counters; warning for past_due/grace/suspended.
- States: trialing, active, past_due, grace_period, suspended, canceled, unavailable.
- Anti-drift: no plan change/payment method/upgrade/downgrade/cancel; no inferred entitlement from plan name.

### `/app/data`

- Job: audit, export, deletion va seller moderation mot cach an toan.
- Mandatory sections: safe audit ledger; export list; standard/plaintext risk difference; deletion step ledger/legal hold; abuse reports/moderation eligibility.
- Actions: create/download export; create/cancel/resume deletion; seller product moderation.
- States: empty, export preparing/ready/expired/download-consumed, deletion processing/blocked/hold/failed/completed/canceled, forbidden/unavailable.
- Security: download token one-time; plaintext export no preview; no audit/provider secret metadata.

## Admin shell va screens

### Admin shell

- Persistent: platform role, operational scope, noindex/private, safe navigation, logout.
- Support read-only/triage limitations visible; no hidden privilege escalation.
- No seller impersonation.

### `/admin`

- Job: triage abuse va thuc hien audited risk decision.
- Mandatory: open/unassigned/recent real counts, report safe facts, workflow status, assignee flag, recent immutable action ledger.
- Actions: support received->triaged; owner/risk investigate/dismiss/close and shop/product suspend/restore.
- States: empty, ready, role forbidden, permission lookup unavailable, data unavailable, recent-auth, moderation conflict.
- Security: public IDs/reason codes only; no reporter contact/provider payload/internal shop ID.

### `/admin/operations`

- Job: quan ly incident, DLQ, deletion/legal hold va encryption rotation theo consequence.
- Mandatory: four separate ledgers, version, safe context, attempt/next step, `canOperate`, explicit irreversible/high-risk copy.
- Actions: all active admins acknowledge/resolve incident and acknowledge/request-retry/resolve unlinked DLQ; owner/risk linked replay and legal hold; owner create/process rotation.
- States: empty per section, role-scoped controls, retry_requested/processing/conflict, hold, failed, forbidden/unavailable.
- Anti-drift: requested != completed; queue bodies/credential/key data never render; platform owner-only rotation.

### `/admin/shops`

- Job: tim shop theo public identity/lifecycle/subscription va safe aggregate health.
- Mandatory: query/allowlisted filters, opaque cursor, public ID/slug/name, status/subscription, owner/member/product/channel aggregate, timestamps.
- Actions: filter/search/paginate/read detail only.
- States: empty, filtered empty, ready, next cursor, forbidden/unavailable.
- Anti-drift: no email/member identity, credentials, buyer/payment payload, internal shop ID, impersonation, inline suspend.

## Storefront

### Tenant home `/`

- Job: hieu merchant, tim san pham va bat dau mua.
- Mandatory: tenant brand/content, announcement/support/delivery, published categories/products, price/stock state, semantic links.
- Actions: search/category progressive enhancement, navigate product, add-to-cart only through hydrated validated controls.
- States: live, empty catalog, draft/coming-soon, suspended, missing/unknown host, unavailable.
- No-JS: catalog content va product links van huu dung.

### `/products/:slug`

- Job: chon variant/quantity va them vao cart dung current price/stock.
- Mandatory: merchant/product content, variant options/price/min-max/stock, fulfillment expectation, support/abuse.
- Actions: re-fetch/revalidate public product before add; create/mutate cart.
- States: available, sold-out, product unpublished/missing, shop suspended, catalog/version/price/stock drift.
- Anti-drift: no stale add; no exact stock neu server an; no fake related products/reviews.

### `/cart`

- Job: review items/discount/price changes va lay valid quote.
- Mandatory: line snapshots, changed indicators, subtotal/discount/total, quote expiry, remove/increment, next step.
- Actions: cart mutation idempotent, server quote.
- States: empty, quoting, valid, expired, converted, invalid token, catalog/quantity/price drift, unavailable.
- Security: cart token not URL/log; local amount not authoritative.

### `/checkout`

- Job: cung cap email neu can, confirm authoritative quote va tao order an toan.
- Mandatory: items/total/expiry, customer field, Turnstile/rate-limit state, provider expectation, terms/policy, safe diagnostics.
- Actions: intent/recover/final checkout theo dung idempotency location.
- States: ready, submitting, quote expired/invalid, catalog/checkout changed, inventory/quantity unavailable, provider unavailable, rate-limited, order created.
- Anti-drift: order-created != paid; no optimistic success; retry same logical payload with stable key.

### `/orders/:orderPublicId`

- Job: theo doi payment va nhan fulfillment ma khong can account.
- Mandatory: order number/items/amount, order/payment/fulfillment/entitlement axes, expiry, payment link/QR, delivery list, support.
- Actions: refresh order, create payment link, request key/download grant/consume.
- States: pending/unpaid, provider checking, partial/overpaid/exception, paid+processing, fulfilled, expired/canceled, refunded/revoked/exhausted, missing/token 404.
- Security: order token never URL/log; key/artifact plaintext ephemeral; download token/grant one-time/no-store.

## Aliases

`/app/telegram` va `/app/store/settings` chi redirect 307, preserve selected shop. Khong tao page data/action duplicate.
