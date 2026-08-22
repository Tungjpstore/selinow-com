# Selinow Frontend Rebuild Handoff

Cap nhat: 2026-08-02

Day la bo tai lieu nguon-that de mot doi khac xay lai toan bo frontend Selinow ma khong lam lech tenant, gia, ton kho, payment, fulfillment, quyen truy cap hoac trang thai van hanh. Bo nay thay the viec dung `docs/frontend-prompt-os/` lam contract duy nhat: PromptOS cu van la tai lieu tham khao thiet ke, nhung route va capability trong do khong con day du so voi source hien tai.

## Bat dau trong 5 phut

1. Mo `QUICK_START.md` va pin dung baseline source.
2. Doc `SOURCE_OF_TRUTH.md` truoc khi sua UI hoac tao API client.
3. Dung `MASTER_REBUILD_PROMPT.md` lam brief goc cho agency/AI.
4. Dung `route-contracts.yaml`, `API_ENDPOINT_INDEX.csv`, `TRACEABILITY_MATRIX.csv` va `ACCEPTANCE_MATRIX.csv` lam scope va definition of done.

## Cach doc bat buoc

1. Doc `SOURCE_OF_TRUTH.md` de biet tai lieu nao co quyen uu tien khi mau thuan.
2. Doc `SYSTEM_ARCHITECTURE.md`, `ROLES_PERMISSIONS_AND_VISIBILITY.md` va `DATA_API_AND_SECURITY_CONTRACTS.md` truoc khi tao component hoac client state.
3. Dung `DASHBOARD_INFORMATION_ARCHITECTURE.md`, `SURFACES_ROUTES_AND_NAVIGATION.md` va `SCREEN_BLUEPRINTS.md` lam pham vi shell, phan vung dashboard va man hinh.
4. Dung `DOMAIN_STATE_MACHINES.md` de thiet ke status, transition va error/recovery UI.
5. Dung `PRODUCT_CAPABILITY_CATALOG.md` de phan biet tinh nang dang hoat dong, read-only, service-only, provider-pending va roadmap.
6. Dung `route-contracts.yaml` va `ACCEPTANCE_MATRIX.csv` lam checklist co the doc bang may.
7. Dung `API_ENDPOINT_INDEX.csv` de map moi method/path dang co sang source file, tenant boundary, security gate, capability, authority va contract section. Khong tao client method cho route khong co trong index.
8. Chay theo `IMPLEMENTATION_MIGRATION_PLAN.md`; khong thay toan bo giao dien trong mot lan deploy.
9. Neu giao viec cho AI/agency, bat dau bang `MASTER_REBUILD_PROMPT.md` va dinh kem ca thu muc nay.

## Nguyen tac khong duoc pha vo

- Co the thay doi hoan toan visual language, information architecture cap trinh bay, component system va motion.
- Khong duoc thay doi y nghia business state, tu tao API, tu tao metric/limit, hoac cho client tu quyet dinh gia, stock, payment, fulfillment, role, readiness.
- Storefront tenant duoc resolve tu hostname da active; khong nhan `shop_id` tu browser lam authority.
- Payment va fulfillment la hai truc rieng. Return URL, QR hoac man hinh thanh cong khong bao gio danh dau paid.
- Moi mutation dashboard/admin phai giu nguyen auth, CSRF, role/capability, recent-auth, idempotency va optimistic-version contract neu endpoint yeu cau.
- Khong render hoac log secrets, order access token, bot token, PayOS credentials, inventory-key plaintext, provider payload hoac internal tenant ID.
- Trang public catalog phai van huu dung khi JavaScript khong chay. Cart/checkout co the progressive-enhance nhung phai fail closed khi quote hoac state drift.
- Moi man hinh lien quan phai co thiet ke co chu dich cho loading, empty, success, warning, blocked, waiting-user, waiting-provider, retry/error, forbidden, plan-limited va suspended khi trang thai do co the xay ra.

## Dau ra duoc coi la dat

Frontend moi chi duoc coi la dung contract khi:

- khong co route hoac action nao duoc them bang suy doan;
- moi action co API/service authority va error mapping ro rang;
- role visibility khop voi server capability, khong chi an nut bang CSS;
- storefront, workspace va admin khong chia se nham tenant context;
- test tai 1440, 768, 390 va 320 px khong overflow ngang;
- keyboard, focus, screen reader name, reduced motion va contrast dat WCAG 2.2 AA;
- check, lint, unit/integration, build, dry-run va browser acceptance deu qua.

## Tai lieu trong goi

| File | Muc dich |
| --- | --- |
| `SOURCE_OF_TRUTH.md` | Thu tu authority, quy tac traceability va xu ly mau thuan |
| `QUICK_START.md` | Khoi dong repository va verify baseline trong vai phut |
| `SYSTEM_ARCHITECTURE.md` | Runtime, host/surface, module, data authority va request flow |
| `DASHBOARD_INFORMATION_ARCHITECTURE.md` | Dashboard shell, nav groups, provider-isolated lanes, automation IA va external gates |
| `PRODUCT_CAPABILITY_CATALOG.md` | Danh muc tinh nang va muc do san sang |
| `SURFACES_ROUTES_AND_NAVIGATION.md` | Toan bo page route, audience, dieu huong va alias |
| `ROLES_PERMISSIONS_AND_VISIBILITY.md` | Role/capability va quy tac render action |
| `DATA_API_AND_SECURITY_CONTRACTS.md` | API usage, auth, CSRF, idempotency, tokens va safe errors |
| `DOMAIN_STATE_MACHINES.md` | State machine business va UI obligations |
| `SCREEN_BLUEPRINTS.md` | Blueprint noi dung, data, action va states cho tung screen |
| `DESIGN_AND_INTERACTION_REQUIREMENTS.md` | Yeu cau UX/UI, responsive, accessibility va motion |
| `IMPLEMENTATION_MIGRATION_PLAN.md` | Cach xay, parity, cutover va rollback |
| `MASTER_REBUILD_PROMPT.md` | Brief hoan chinh de giao cho doi/agent trien khai |
| `route-contracts.yaml` | Route contract may-doc |
| `API_ENDPOINT_INDEX.csv` | 210 method/path rows mapped to source, tenant boundary, security gate, capability, authority and contract reference |
| `ACCEPTANCE_MATRIX.csv` | Ma tran nghiem thu theo route/state/viewport |
| `TRACEABILITY_MATRIX.csv` | Lien ket screen -> page -> API/service -> test |
| `HANDOFF_MANIFEST.json` | Baseline, file inventory, counts va checksum cua goi |

Ban cap nhat 2026-08-03 da bao gom UI credentials API va channel catalog/request controls trong `/app/integrations`, cung voi `DASHBOARD_INFORMATION_ARCHITECTURE.md` de tach rieng Website/PayOS, Telegram Bot, Telegram Mini App, Zalo Mini App, Zalo OA, WhatsApp Cloud va Discord Bot tren cung mot canonical integrations route. Seller operations migration `0053`, backend gap workflows migration `0054`, channel expansion migrations `0055`-`0056`, Telegram Mini App session migration `0057`, provider-event receipt migration `0058`, channel customer-identity migration `0059` va Zalo OA OAuth state/retry migrations `0060`-`0062`, enabled-channel scope repair `0063`, provider verification ledger `0064`, credential-lineage guards `0065`, blind OAuth state lookup `0066`, Mini App active-plan scope guard `0067`, public API read scopes `0068` va catalog channel visibility `0069` deu duoc ghi ro la source/local-only. UI credential token moi chi hien mot lan va khong duoc luu trong browser; integrations UI chi hien thi safe projections va provider-pending states, con provider execution/activation remains pending.

Trong `API_ENDPOINT_INDEX.csv`, `contract_ref` la ID on dinh de tim den heading tuong ung trong `DATA_API_AND_SECURITY_CONTRACTS.md`; cac tien to `auth.*`, `store.*`, `app.*`, `external.*`, `webhooks.*` va `admin` khong phai URL moi.

## Nguon lien quan

- Kien truc tong: `docs/ARCHITECTURE.md`
- Trang thai runtime: `docs/IMPLEMENTATION_STATUS.md`
- Gap backend/UI hien tai: `docs/frontend-redesign/BACKEND_UI_GAP_REPORT.md`
- ADR: `docs/adr/0001` den `docs/adr/0021`
- Source page/API: `src/pages/**`
- Service va policy: `src/lib/**`
- Schema source: `migrations/0001` den `migrations/0069`; production remains on the previously admitted `0001`-`0052` ledger until approved migrations.
- Test: `tests/**`
