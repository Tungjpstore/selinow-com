# Source of truth va traceability

## Thu tu authority

Khi hai tai lieu mau thuan, dung thu tu sau:

1. Security, tenant isolation, payment, fulfillment va authorization dang duoc enforce trong source va test.
2. Migration forward-only va data invariant trong D1.
3. ADR da chap nhan va product boundary cua repository.
4. API/page/service contracts dang ton tai.
5. Tai lieu trang thai implementation moi nhat.
6. Bo frontend rebuild handoff nay.
7. PromptOS, screen spec va component spec cu.
8. Anh tham khao, mockup va visual reference.

Visual reference khong bao gio co quyen tao them business action, field, metric, provider hoac trang thai.

## Pham vi san pham

Repository nay chi la SaaS `selinow.com`. Khong mang branding, data ID, secret, portfolio, blog, CRM ca nhan hoac TungJPStore vao frontend moi. Selinow la nen tang cho seller san pham so, khong phai marketplace tap trung va hien tai khong co buyer account.

## Hop dong traceability

Moi screen phai co mot record gom:

- page route va surface;
- audience va auth requirement;
- SSR loader/service hoac public projection;
- mutation API, HTTP method va service authority;
- role/capability visibility;
- state/error codes can render;
- source file va test lien quan;
- maturity: `live`, `read_only`, `service_only`, `contract_ready`, `provider_pending`, `external_pending`, `roadmap`.

Moi control tuong tac phai tra loi duoc nam cau hoi:

1. Authority nam o dau?
2. Tenant duoc resolve bang gi?
3. Role/capability nao duoc server kiem tra?
4. Idempotency/recent-auth/version guard nao can gui?
5. Ket qua nao la final, ket qua nao chi la waiting/retry/manual review?

Neu khong tra loi duoc, control do khong duoc dua vao ban rebuild.

## Quy tac thay doi contract

- Khong sua migration da co; them migration danh so tiep theo.
- Khong them client field vao payload neu endpoint khong allowlist field do.
- Khong coi response UI hien tai la schema on dinh neu service type/source noi khac.
- Khong mo rong role bang cach chi hien nut; server policy phai duoc thay doi va test truoc.
- Khong tao mock success tren production code. Placeholder chi duoc dung trong Storybook/fixture tach biet va phai gan nhan.
- Neu can API moi, tach thanh backend change request, co tenant/concurrency/security tests, roi moi update handoff.

## Muc do san sang

| Nhan | Nghia |
| --- | --- |
| `live` | Route/service/source ton tai va nam trong runtime production hien tai; khong dong nghia provider ngoai da duoc kich hoat |
| `read_only` | Projection doc ton tai; mutation co chu dich chua co contract |
| `service_only` | Schema/service/test ton tai nhung chua co seller/admin UI day du |
| `contract_ready` | Contract, schema, service/test va safe UI projection da ton tai; provider activation, credential binding hoac delivery van chua duoc chay |
| `provider_pending` | Code contract ton tai nhung can credential, bot/channel hoac controlled provider acceptance |
| `external_pending` | Can DNS, Cloudflare SaaS, Turnstile hostname, legal/ops hoac ben ngoai |
| `roadmap` | Chua co runtime contract; khong duoc mock thanh tinh nang hien huu |

## Quy trinh kiem tra drift

Truoc moi milestone:

```bash
find src/pages -type f | sort
rg -n "export const (GET|POST|PATCH|PUT|DELETE)" src/pages/api src/pages/webhooks
rg -n "ShopCapability|SHOP_ROLES|PlatformAdminRole" src/lib
rg -n "CHECK \\(.*status|status IN" migrations
npm run check
npm run lint
npm run test
npm run build
npm run deploy:dry-run
```

Neu route/API/state khac voi file may-doc trong goi nay, dung source lam authority va cap nhat goi trong cung pull request.
