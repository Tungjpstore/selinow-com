# Quick start cho doi frontend moi

Muc tieu cua quy trinh nay la dua mot engineer/agency tu repository rong den baseline da verify ma khong cham production resource.

## 1. Pin baseline

Baseline source cua goi handoff:

```text
1144ae7b7021e6d6828cfebfb68f403fc6a2c2b0
```

Truoc khi bat dau, xac nhan source code van o baseline nay hoac lap mot change log ro rang cho moi commit moi hon. Neu source da thay doi route/API/state, cap nhat bo handoff truoc khi implement UI.

```bash
git rev-parse HEAD
git status --short
```

Khong reset, checkout hoac xoa thay doi cua nguoi khac de ep repository ve baseline.

## 2. Cai dung runtime

Repository yeu cau:

```text
Node.js >=22.12.0 <26
npm >=11
```

```bash
node --version
npm --version
npm ci
```

Khong doi package version neu chua co change request va verification rieng.

## 3. Doc contract theo thu tu

1. `SOURCE_OF_TRUTH.md`
2. `SYSTEM_ARCHITECTURE.md`
3. `ROLES_PERMISSIONS_AND_VISIBILITY.md`
4. `DATA_API_AND_SECURITY_CONTRACTS.md`
5. `DOMAIN_STATE_MACHINES.md`
6. `DASHBOARD_INFORMATION_ARCHITECTURE.md`
7. `SURFACES_ROUTES_AND_NAVIGATION.md`
8. `SCREEN_BLUEPRINTS.md`
9. `DESIGN_AND_INTERACTION_REQUIREMENTS.md`
10. `IMPLEMENTATION_MIGRATION_PLAN.md`

Sau do mo `MASTER_REBUILD_PROMPT.md`, `route-contracts.yaml`, `API_ENDPOINT_INDEX.csv`, `TRACEABILITY_MATRIX.csv` va `ACCEPTANCE_MATRIX.csv` de lap backlog.

## 4. Verify inventory

```bash
find src/pages -type f | sort
rg -n "export const (GET|POST|PATCH|PUT|DELETE)" src/pages/api src/pages/webhooks
rg -n "ShopCapability|SHOP_ROLES|PlatformAdminRole" src/lib
rg -n "CHECK \\(.*status|status IN" migrations
```

Expected baseline:

- 25 canonical logical frontend routes.
- 2 redirect aliases.
- 156 API/webhook method/path rows in `API_ENDPOINT_INDEX.csv`, including buyer order recovery, catalog channel visibility, explicit provider-pending boundaries and the `inventory:read`/`orders:read` public projections.
- 87 acceptance scenarios, including provider-lane and automation-wait cases inside the canonical dashboard routes.
- 28 traceability records gom canonical screens va aliases.
- Migrations `0001` den `0069` trong source; production remains at `0052` until approved.

Compare the exported method/path inventory with `API_ENDPOINT_INDEX.csv`; the index must remain source-accurate whenever a route is added, removed or changes security semantics.

## 5. Chay local an toan

Chi dung local bindings va local D1/R2/KV/queues. Khong tro local development vao production resources, provider credentials, Telegram bot, PayOS channel hoac custom-hostname resource.

```bash
npx astro dev --background
npx astro dev status
npx astro dev logs
```

Khi xong:

```bash
npx astro dev stop
```

## 6. Quality gate truoc moi handoff

```bash
npm run check
npm run lint
npm run test
npm run build
npm run deploy:dry-run
```

Them browser acceptance cho cac route/state da thay doi tai 1440, 768, 390 va 320 px; kiem tra keyboard, axe, zoom 200%, reduced motion, console va horizontal overflow.

## 7. Dieu khong duoc lam

- Khong deploy production de "xem thu" khi chua qua migration/canary/release plan.
- Khong kich hoat PayOS, Telegram, queue consumer, fulfillment hoac external custom domain trong frontend task.
- Khong tao mock success cho API/tinh nang chua ton tai.
- Khong log hoac snapshot secret/token/plaintext key.
- Khong dung client-provided `shop_id`, role, price, stock, paid hoac fulfilled state lam authority.
- Khong thay doi migration da co.

## 8. Bat dau implementation

Bat dau bang foundations va mot vertical slice nho theo `IMPLEMENTATION_MIGRATION_PLAN.md`. Moi pull request phai cap nhat traceability/acceptance neu no thay doi route, action, state hoac capability maturity.
