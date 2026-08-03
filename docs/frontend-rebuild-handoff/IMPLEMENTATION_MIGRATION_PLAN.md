# Ke hoach xay va migrate frontend moi

## Nguyen tac cutover

Khong big-bang replace. Xay theo vertical slice, giu route/API contract, so sanh parity va co rollback bang deploy version. Khong sua backend chi de lam UI de hon neu chua co change request/test rieng.

## Giai doan 0 - Contract freeze

- Chot commit SHA lam baseline.
- Chay route/API/state inventory va cap nhat file may-doc.
- Danh dau moi capability theo `live/read_only/service_only/provider_pending/external_pending/roadmap`.
- Tao danh sach route khong duoc regression va error code bat buoc.
- Chot analytics/telemetry toi thieu ma khong ghi PII/secret.

Exit: 100% control trong wireframe co source authority hoac bi loai.

## Giai doan 1 - Foundations

- Tao token, typography, spacing, layout, focus, status va form primitives moi.
- Tao surface shell rieng cho marketing, workspace, storefront, admin.
- Dung `DASHBOARD_INFORMATION_ARCHITECTURE.md` de chia workspace thanh
  Command/Commerce/Channels/Operations/Workspace va tach provider lanes trong
  `/app/integrations` ma khong tao route ao.
- Tao safe API client pattern cho CSRF/idempotency/request ID/error mapping.
- Tao fixture tu safe projections, khong dung production data/secrets.
- Dat a11y/overflow/browser test harness truoc khi lam feature.

Exit: component primitives pass keyboard, axe, 320/390/768/1440 va reduced motion.

## Giai doan 2 - Public va auth

- Marketing `/`, `/pricing`, `/login`.
- Tenant storefront `/`, `/products/:slug` voi SSR/no-JS utility.
- Cart, checkout, order status theo server quote/order-token contract.
- Abuse report va safe errors.

Exit: public browser gate; khong mutation khi GET/HEAD; tenant hostname isolation; stale quote/stock drift fail closed.

## Giai doan 3 - Seller core

- Workspace shell, shop switch, `/app`, onboarding.
- Products, inventory, orders, order detail.
- Customers/members/billing doc dung projection va role-scoped mutation boundary: owner/manager customer detail operations, owner member operations, and audited provider-pending billing request intents.
- Store builder/draft/publish, integrations/Telegram, domains, automation, data/audit.
- Tich hop provider lanes theo tung identity: Telegram Bot, Telegram Mini App,
  Zalo Mini App, Zalo OA, WhatsApp Cloud va Discord; khong dung health/credential
  state cua lane nay cho lane khac. Automation doc task theo seller/provider wait
  va terminal projection.

Exit: role matrix, tenant switch reset, secret handling, state coverage,
provider-lane isolation, 1440/768/390/320 browser gate va authenticated browser gate.

## Giai doan 3.5 - Channel expansion contracts

- Wire the safe channel-expansion catalog and tenant-bound connector request API from
  migrations `0055`-`0069` before adding or enabling provider-specific execution. Migration
  `0057` adds only a tenant-bound, short-lived Telegram Mini App session boundary; it does
  not activate a provider or permit external delivery. Migration `0058` adds only the
  D1 reference receipt/replay/conflict boundary for verified ingress; migration `0059`
  adds only the tenant-bound provider customer identity hash projection and idempotent
  server-side upsert, without altering legacy Telegram identity tables.
- Migration `0065` binds provider-verification evidence to the exact credential version
  and makes channel-connection identity immutable. Migration `0066` adds a blind HMAC
  lookup value for the public Zalo OA callback without storing raw state; expire/revoke
  all pre-`0066` pending OAuth rows or provide an explicitly reviewed legacy-resolution
  path before applying it remotely.
- Render `requested`, `provider_pending`, `rejected` and `canceled` states as durable
  workflow states; never present them as connected, healthy, delivered, paid or fulfilled.
- Keep Telegram Mini App identity verification server-side (HMAC, freshness, tamper and
  bounded user projection), WhatsApp customer-service window/template policy, Zalo group
  restrictions and authorized-reveal-only secret handling in backend contracts.
- Use the exact catalog/request rows in `API_ENDPOINT_INDEX.csv`; no inline secret input,
  provider payload echo, external webhook assertion or provider-completion mock is allowed.

Exit: dashboard IA and channel catalog/request client tests pass with tenant isolation, idempotent create,
optimistic cancel, no-secret projections and explicit provider-pending/unavailable UI.

## Giai doan 4 - Admin

- Abuse/moderation overview.
- Shop directory read-only.
- Operations: deletion/legal hold, incident, DLQ, rotation theo exact role/version/recent-auth contract.

Exit: support/risk/owner matrix; destructive confirmations; no impersonation; safe evidence only.

## Giai doan 5 - Parallel run va cutover

- Chay full gates tren commit canary.
- So sanh route/status/header/cache/no-JS output giua old/new.
- Chay controlled canary chi frontend surface; khong tu kich hoat PayOS, Telegram, queue, fulfillment hoac external domain.
- Theo doi 4xx/5xx, CSP, JS console, request ID va business transition counts.
- Promote khi acceptance matrix pass; giu previous Worker version/asset build de rollback.

## Rollback triggers

Rollback ngay neu co mot trong cac dau hieu:

- cross-tenant data/route bleed;
- client co the danh dau paid/fulfilled hoac bypass signed evidence;
- secret/token/plaintext xuat hien trong HTML/log/storage/screenshot;
- checkout tao duplicate order/reservation do sai idempotency;
- 403/503 fallback thanh data/action cua role cu;
- public catalog mat SSR/no-JS utility;
- critical route 5xx, CSP block bundle, overflow/ngat action tren 320/390;
- provider/payment/domain activation bi thay doi ngoai ke hoach frontend.

## Verification gate

```bash
npm run check
npm run lint
npm run test
npm run build
npm run deploy:dry-run
```

Them browser gates phu hop route da thay. Production deploy can theo `docs/PRODUCTION_RELEASE.md` va guarded release scripts, khong goi Wrangler truc tiep de bo qua admission.
