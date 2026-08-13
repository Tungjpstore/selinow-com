# Provider and Release Gate Audit

Status snapshot: 2026-08-04. This is a non-secret release artifact. It records
what the repository proves locally and what still requires provider access,
production evidence, or an explicit owner approval. It does not authorize a
Cloudflare, D1, provider, DNS, or payment mutation.

## Decision

The platform-only production handoff is accepted for public marketing,
platform routes, health checks, and the exact production Worker Domains. The
full commerce/provider release remains **NO-GO**. A connector contract,
provider-pending request, unit test, or canary frontend probe is not evidence
that a provider account, webhook, payment, message, or fulfillment operation
is active.

## Gate matrix

| Gate | Local/source evidence | Current state | Missing release evidence or action |
| --- | --- | --- | --- |
| Release identity | `HEAD` is `4328b3b` (Phase 5 evidence-contract hardening); this completion batch is still uncommitted, while bootstrap evidence remains pinned to its historical platform candidate | **Blocked** | Review all scoped changes, create the final clean execution commit/tree, then regenerate private evidence and the release manifest from that exact tree. |
| Production schema | Bootstrap evidence records `0001`-`0052`; source has the contiguous forward-only chain through `0096`; retained staging D1 validation applies through `0095` | **Blocked** | Fresh production backup, approved mutation window, remote ledger proof through `0096`, integrity/preflight evidence, and post-migration restore drill. Before `0066`, revoke/expire pending OAuth rows without a lookup hash; before applying `0070`-`0096`, validate Dodo, plan/price, billing, activation, account-security, recovery, privacy, platform-admin, PayOS claim-fencing, buyer order recovery, exact-host Turnstile admission, shop-creation admission, Telegram generation-fencing and runtime-rollback-compatibility decisions. |
| Website/platform | Historical canary and post-promotion smoke prove apex/wildcard routing, health, marketing, login, and platform domains; the 2026-08-04 dashboard observation shows current Worker prefix `e2a4bc53` | Platform-only accepted | Reconcile the exact current Worker, routes/domains and candidate-bound smoke before any new release; this does not prove commerce. |
| PayOS | Signed webhook, reconciliation, idempotency, tenant guards, and payment tests exist locally | **Blocked** | Controlled PayOS credentials/channel, signed paid/refund/chargeback events, reconciliation and exception evidence, and provider-backed fulfillment acceptance. |
| Telegram Bot | Token encryption, webhook authentication, replay protection, private-chat commerce, and outbox tests exist locally | **Blocked** | Dedicated test bot, real `/start`, connect/rotate/disconnect, webhook delivery, paid notification, and two-pilot acceptance without logging token values. |
| Telegram Mini App | `initData` verification, tenant-bound session exchange, authenticated catalog projection, channel manifest/request routes and replay/credential-version fences exist | **Blocked** | Bot/Mini App binding, launch/auth and checkout smoke, webhook/delivery evidence, and provider approval/ownership record. |
| Zalo Mini App | Safe manifest, tenant-bound connector request, tenant-bound credential decrypt, canonical signed-event parser and reference-only receipt route exist; stage is `provider_pending` | **Blocked** | Zalo app/OA approval, eligible package, OAuth/webhook setup, capability probe, outbound/inbound acceptance, and seller consent record. |
| Zalo Official Account | OAuth v4/PKCE helper, encrypted credential envelope, tenant-bound one-use state store (`0060`-`0062`) and explicit provider-pending webhook route exist | **Blocked** | Verified OA, eligible package, OAuth/token rotation acceptance, documented webhook proof, capability probe, outbound/inbound acceptance, and seller consent record. |
| WhatsApp Cloud | Safe manifest, messaging-window policy, encrypted app-secret/verify-token context, GET challenge, raw-body HMAC webhook and reference-only receipt claim exist | **Blocked** | Meta app/business verification, WABA/phone, template approval, webhook subscription, billing path, inbound/outbound acceptance, and seller consent record. |
| Discord Bot | Safe manifest, tenant-bound encrypted public-key context, Ed25519 interaction verification, type-correct acknowledgement and reference-only receipt claim exist | **Blocked** | Bot install/OAuth scopes, webhook/interaction setup, private identity, outbound delivery, rate-limit/retry, and seller acceptance evidence. |
| Fulfillment | Website/Telegram/generated-license state machines and local parity tests exist | **Blocked** | Provider-backed generation/delivery, reconciliation of ambiguous attempts, refund/reversal behavior, queue/DLQ evidence, and controlled paid-order fulfillment. |
| Background jobs | `wrangler.jsonc` declares three production queue consumers and a `*/15 * * * *` cron; the 2026-08-04 dashboard observation still shows production queues `0` and no accepted trigger inventory | **Blocked** | Fresh live trigger inventory must prove the integration/notification/DLQ consumers and scheduled handler are actually admitted, or record an approved reason they are intentionally disabled. |
| External domains/Turnstile | Staging custom-hostname lifecycle and platform route contracts are documented | **Blocked** | Fresh production external-host inventory, exact hostname/SSL/DNS readiness, Turnstile hostname admission, tenant-routing smoke, and rollback evidence. |
| Seller pilots | GET-only smoke plan requires two pilot storefronts and one controlled custom domain | **Blocked** | Completed private pilot plan with two distinct sellers, order/payment/fulfillment observations, acceptance timestamps, support owner, and no placeholder hosts. |
| Monitoring and budgets | Canary alert/dashboard acknowledgements cover frontend/route invariants only | **Blocked** | Owned dashboards/alerts for Worker, D1, inventory, payment, providers, queues/DLQ, domains, security, and budgets; thresholds, destinations, acknowledgement test, and 5m/15m/1h/next-day watch records. |
| Backup and restore | Bootstrap empty-baseline backup/drill plus retained candidate-bound staging backup/restore evidence through `0090` are retained | **Blocked** | Staging evidence is not production evidence; capture a fresh protected production backup for the exact `0094` migration target, artifact/checksum/bookmark/age proof, an isolated restore after the continuation ledger, and post-restore credential/key admission. |
| Rollback | Canary/promotion state capture and forward-only rollback runbooks exist | **Blocked** | Current candidate version/state capture, route and Worker rollback rehearsal, D1 forward-fix or controlled restore/cutover plan, and owner acknowledgement. |
| Approvals and operations | Bootstrap names generic release/operations owners | **Blocked** | Named release, data, payment-incident, integration-incident, domain, and support owners plus legal/provider/pilot sign-off. |

## Evidence currently available

- `.wrangler/bootstrap/production-evidence.json` — platform bootstrap only;
  records migration ledger through `0052` and candidate `6ca9c890...`.
- 2026-08-04 read-only Cloudflare dashboard observation — current production
  Worker prefix `e2a4bc53`, four domains, zero queues and nine bindings; staging
  current/previous prefixes `049009b4`/`2d7166ff`, 14 domains, three queues, one
  trigger and nine bindings. This is not a durable release manifest or mutation
  admission report.
- `.wrangler/bootstrap/bootstrap_20260730_first_release/production-smoke.json`
  — public route/health smoke with
  `paymentTelegramFulfillmentActivation: false` and
  `externalCustomDomainActivation: false`.
- `.wrangler/bootstrap/bootstrap_20260730_first_release/production-alert-ack.json`
  and `production-dashboard-ack.json` — canary frontend/route watchdog only.
- `docs/CHANNEL_PROVIDER_RESEARCH.md` — provider access, policy, billing, and
  seller prerequisites remain external gates.
- `docs/CHANNEL_PROVIDER_CONTRACTS.md`, `src/lib/channels/provider-contracts.ts`,
  `src/lib/channels/provider-context.ts`, `src/lib/channels/runtime-admission.ts`,
  `src/lib/channels/ingress.ts`, `src/lib/channels/provider-event-receipts.ts`,
  and the concrete Telegram Mini App/WhatsApp/Discord/Zalo route services —
  local verification, tenant admission, sequencing, bounded parsing and
  payload-free D1 receipt contracts only; they do not prove provider
  credentials, webhook registration, provider identity, outbound delivery or
  production activation.
- `docs/MONITORING_AND_BUDGETS.md` — production monitoring and budget checklist
  remains unchecked until owners and operational evidence are recorded.
- `infra/release/pilot-smoke.production.example.json` — template only; pilot
  hostnames are placeholders and no completed production pilot report exists.

## Minimum path to a full-commerce GO

1. Pin and review a clean commit containing the intended continuation, then
   produce a fresh release manifest.
2. Back up production, apply `0053`-`0094` forward-only through the guarded
   executor, verify the remote ledger and integrity, and complete an isolated
   restore drill. Revoke/expire pre-`0066` pending OAuth rows before the lookup
   migration.
3. Complete Website/PayOS and Telegram acceptance with dedicated test tenants,
   then complete at least two controlled seller pilots.
4. Admit production custom domains/Turnstile only after fresh hostname and
   tenant-routing evidence.
5. Obtain provider-specific evidence for Telegram Mini App, Zalo, WhatsApp,
   and Discord before advertising or enabling their capabilities.
6. Record monitoring, budget, support, incident ownership, rollback rehearsal,
   and post-release watch evidence before declaring GO.
