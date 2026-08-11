# Dashboard Information Architecture

Cap nhat: 2026-08-03

Tai lieu nay la contract cho viec lam moi dashboard seller. No mo ta phan vung thong tin, shell, channel lanes va automation UX ma khong thay doi 25 canonical route, 2 redirect alias, API contract, tenant authority hoac trang thai provider. Day la source/local handoff; no khong la bang chung provider da duoc kich hoat.

## Boundary va muc tieu

- Dashboard chay tren `app.selinow.com`, can session + active shop membership, private/no-store/noindex.
- `shopPublicId` chi la public selector cua membership. D1 `shop_id` va role/capability van la authority server.
- Moi card, table, action va badge phai truy duoc ve safe projection/API/service trong `API_ENDPOINT_INDEX.csv`.
- Khong tao route rieng cho tung provider khi backend chi co mot integrations surface. Dung section/anchor va `?focus=` de tach lane trong `/app/integrations`.
- Khong de trang thai `requested`, `provider_pending`, `active` hoac credential `issued` bi hien thanh provider da san sang. UI phai tach `implemented`, `configured` va `activated/accepted`.
- Payment, order, fulfillment, domain va provider health la cac truc doc lap. Khong gop thanh mot KPI hoac mot nut "activate all".

## Workspace shell

Shell co mot context duy nhat va khong duoc dat data cua shop truoc ben canh data cua shop sau khi user switch.

| Vung shell | Noi dung | Authority va han che |
| --- | --- | --- |
| Context bar | Shop switcher, shop status, plan/readiness summary, role, locale, sign out | Active membership + server projection; switch reset entity IDs, filters, cursor, hash, draft va pending action |
| Command | Overview `/app`, Onboarding `/onboarding` | Overview chi hien viec can lam tiep theo va blocker that; khong fake revenue/KPI |
| Commerce | Products, Inventory, Orders, Customers | Catalog/inventory/order/customer projection theo tenant; product/channel visibility is server-owned and fail-closed; payment va fulfillment hien rieng |
| Channels | Integrations `/app/integrations` | Provider lanes, PayOS, domain health, API credentials; action role/capability gated |
| Operations | Automation, Domains, Data | Durable tasks, domain lifecycle, audit/export/deletion; destructive actions recent-auth + versioned |
| Workspace | Store, Members, Billing | Draft/public distinction, membership, subscription projection; khong invent billing settlement |

Navigation visibility is not authorization. Hide an action only for ergonomics; server still returns `401`, `403`, `409` or `503` when the session, capability, tenant or authoritative projection does not permit it.

### Responsive shell rules

- 1440px: persistent rail + context bar + one primary content column; provider lanes may use a two-column card grid only when each card remains independently readable.
- 768px: rail collapses to labeled drawer; context bar retains selected shop and role; no provider card may merge identities.
- 390px and 320px: one column, horizontal scrolling is forbidden, action menus become stacked controls, status text may wrap, and secrets never become visible through overflow.
- Keyboard order is context -> navigation -> page heading -> primary action -> sections. Every collapsed rail/drawer has an accessible name and focus return.

## Integrations page IA

`/app/integrations` is a control plane, not a provider marketplace. It has a stable summary followed by isolated lanes. A lane can be deep-linked with `?focus=<lane>#<anchor>`; the alias `/app/telegram` redirects to the Telegram Bot lane and must not create a duplicate screen.

### Page order

1. **Integration summary** - selected shop, last checked timestamp, readiness blockers and safe request ID. No aggregate health claim when one source is unavailable.
2. **Commerce foundations** - Website storefront and PayOS payment evidence. Website is the baseline channel; PayOS payment status never implies fulfillment.
3. **Telegram** - Telegram Bot and Telegram Mini App are separate lanes sharing a provider family but not identity, launch proof, webhook proof or fulfillment authority.
4. **Zalo** - Zalo Mini App and Zalo Official Account are separate lanes with separate app/OA identity, consent, webhook and outbound evidence.
5. **WhatsApp Cloud** - WABA/phone/app connection, customer-service window/template policy and provider-pending activation.
6. **Discord Bot** - application/public-key installation and interaction acknowledgement; no message delivery or payment claim from an interaction receipt.
7. **Credentials and requests** - API credentials, connector requests and safe audit history. This section never accepts inline provider secrets.

### Provider lane contract

Every lane uses the same visual skeleton, but all values and actions come from that provider's own projection. Never reuse the previous lane's health, credentials, webhook proof, connection ID or capability list.

| Lane | Provider identity | Local maturity | Inbound/outbound boundary | Seller action | External gate before activation |
| --- | --- | --- | --- | --- | --- |
| Website | Active tenant hostname + published snapshot | `live` | Hostname resolves storefront; checkout uses canonical commerce | Publish storefront/readiness | Platform/custom-domain routing, Turnstile and pilot evidence as applicable |
| PayOS | Tenant encrypted credential + payment connection | `provider_pending` | Signed event/reconciliation only; QR/return is not payment evidence | Connect, rotate, health check | Real credentials, signed paid/refund/chargeback UAT, reconciliation and fulfillment pilot |
| Telegram Bot | Tenant bot token + webhook secret | `provider_pending` | Secret-token webhook + update replay; private chat only | Connect/replace/disconnect/health | Dedicated bot, `/start`, rotation, webhook, paid notification and two-pilot evidence |
| Telegram Mini App | Bot-bound Web App launch | `contract_ready` | Server HMAC/freshness `initData`, opaque tenant session, Mini App commerce routes | Request connector; launch after connector/credential/subscription gates | Bot/Web App ownership, launch/checkout smoke, `answerWebAppQuery`/delivery evidence |
| Zalo Mini App | App ID + API key + allowlisted identity | `provider_pending` | `x-zevent-signature` canonical event; access-token profile calls need app proof | Request connector/submit credential through approved path | App approval, package entitlement, webhook, capability probe and outbound/inbound evidence |
| Zalo OA | OA ID + OAuth v4/PKCE grant | `provider_pending` | One-use state + provider callback; webhook proof remains pending | Start OAuth; wait for reviewed callback binding | Verified OA, consent, token rotation, documented webhook proof and capability probe |
| WhatsApp Cloud | WABA + phone number + Meta app | `contract_ready` | Verify-token GET and raw-body HMAC POST; customer-service window/templates | Request connector; complete Meta setup outside browser | App/business verification, WABA/phone, templates, webhook subscription, billing and delivery |
| Discord Bot | Application ID + public key + bot installation | `contract_ready` | Ed25519 interaction proof; acknowledgement is not delivery | Request connector; install bot with approved scopes | Installation, intents, private identity, outbound rate/retry and seller acceptance |

The `local maturity` column is a handoff label only. A lane can render `configured` only when the server projection has a valid tenant-bound credential/connection. It can render `activated/accepted` only when the release evidence contains provider-specific external proof. `provider_pending` and `contract_ready` must retain waiting/blocked copy.

### Lane states and actions

Each lane must expose these independent rows when available:

- **Identity**: provider account/application/OA reference, masked and bounded; never raw token or secret.
- **Connection**: `disconnected`, `requested`, `provider_pending`, `active`, `degraded`, `rejected`, `canceled`, `revoked`.
- **Inbound proof**: webhook challenge/signature/launch verification status and checked time.
- **Outbound capability**: declared capability, policy window/template/intents and evidence freshness.
- **Commerce capability**: catalog/cart/quote/checkout/order/fulfillment support, each independently marked.
- **Next action**: exact server-owned action URL or external prerequisite. No generic `Activate` button.

Mutation controls must use the endpoint's exact CSRF, recent-auth, idempotency and optimistic-version requirements. Connector request cancellation is allowed only for `requested` or `provider_pending`; it records `canceled` and never deletes the immutable D1 row.

## Automation page IA

`/app/automation` is the durable task ledger, not a provider job console. It must make the next safe action obvious without implying that an external provider completed work.

### Task list

Columns/blocks: capability code, scope/shop, status, attempt count, next attempt, safe error code, action URL, continuation marker, `canCancel`, version and updated time. Do not render evidence tokens, lease tokens, provider payloads or credential references.

Group the list into:

1. **Needs seller** - `waiting_user`, `prerequisite_required`, recent-auth or consent steps with one exact action.
2. **Waiting provider** - `provider_pending`, webhook/OAuth review or external delivery; show owner and next check, never success copy.
3. **Running/retryable** - active lease, bounded retry and next attempt; cancel is server-controlled.
4. **Completed/failed/canceled** - immutable terminal projection with safe error and support request ID.

The browser may start only the allowlisted capabilities (`shop.provision`, `domain.platform.provision`) and may cancel/resume through versioned, idempotent APIs. A task request accepted by D1 is not proof of provider execution, payment, message delivery, order completion or fulfillment.

## API and authority map

The dashboard client must use the 156-row `API_ENDPOINT_INDEX.csv` as its only route inventory. Important dashboard seams are:

- `/api/app/shops/:shopPublicId/channels/catalog`, `/channels/requests`, `/channels/requests/:requestPublicId` for safe expansion metadata and durable connector intent.
- `/api/app/shops/:shopPublicId/integrations/telegram` and `/payments/payos` for legacy Telegram/PayOS controls.
- `/api/channels/telegram-mini-app/sessions/:shopPublicId` plus catalog/cart/quote/checkout/orders for Mini App runtime; the session is opaque and short-lived.
- `/webhooks/zalo-mini-app`, `/webhooks/zalo-oa`, `/webhooks/whatsapp`, `/webhooks/discord` for provider ingress only; browser UI cannot claim these routes are active.
- `/api/app/shops/:shopPublicId/automation` and task cancel/resume routes for durable automation.

All channel routes preserve tenant-leading D1 scope, credential/connection lineage, replay/conflict handling and no-secret projections. The current source chain ends at migration `0069` (including `0067` Telegram Mini App plan scope, `0068` public API read scopes and `0069` catalog channel visibility); migrations `0053`-`0069` remain source/local-only until separately admitted.

## Acceptance and external gates

Dashboard acceptance must cover the shell and every provider lane at 1440/768/390/320px, plus keyboard, reduced motion, no horizontal overflow, no stale tenant data after switch and safe unavailable states. The handoff acceptance matrix therefore includes separate scenarios for Telegram Bot, Telegram Mini App, Zalo Mini App, Zalo OA, WhatsApp Cloud, Discord and automation provider-wait states even though the canonical page route remains `/app/integrations` or `/app/automation`.

Local/source gates:

- `tests/unit/integrations-frontend-contract.test.ts` and provider surface tests prove lane wiring and route inventory.
- `tests/unit/provider-runtime-admission.test.ts`, provider ingress/receipt/identity tests prove fail-closed boundaries, not external activation.
- `tests/unit/automation-ui.test.ts` and `tests/unit/automation-orchestrator.test.ts` prove safe task state/action handling.
- Authenticated browser acceptance must verify role visibility, tenant switch reset, lane isolation, responsive overflow and no secret in HTML/storage/screenshots.

External gates before any lane is marketed as active:

- real provider account/credential and owner consent;
- provider-specific webhook/launch/installation proof and outbound delivery acceptance;
- tenant isolation and replay/conflict evidence using a controlled seller;
- payment/fulfillment acceptance where the lane touches commerce;
- monitoring, budget, support and rollback ownership recorded in the release evidence.

## Handoff invariants

- Keep the canonical route inventory at 25 logical routes + 2 aliases. A new provider route requires a reviewed backend contract, source path, API index row, traceability row and acceptance scenarios.
- Keep API inventory at 148 rows until a real source route is added or removed; do not add UI-only pseudo-endpoints.
- Keep production claims limited to the admitted platform baseline (`0001`-`0052`). The current dashboard/channel continuation is source/local-only and cannot be used as activation evidence.
- Regenerate `HANDOFF_MANIFEST.json` and the transfer archive after any handoff doc or checksum changes; pin the reviewed commit before release admission.
