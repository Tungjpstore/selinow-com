# Master brief cho doi xay frontend moi

Ban dang xay lai frontend cho Selinow, mot SaaS multi-tenant ban san pham so. Ban co the thay doi hoan toan visual language va component architecture, nhung phai giu nguyen backend/business/security contracts trong repository.

## Tai lieu bat buoc

Doc toan bo `docs/frontend-rebuild-handoff/` theo thu tu trong `README.md`. Source va tests co authority cao hon mockup. Neu mockup co control khong co API/service authority, loai control hoac gan nhan roadmap; khong gia lap.

## Muc tieu

- Tao bon surface co ban sac ro: marketing, seller workspace, tenant storefront, platform admin.
- Mobile-first cho storefront va workflow seller, toi thieu 320 px.
- SSR/HTML-first; public catalog huu dung khong JavaScript.
- WCAG 2.2 AA; keyboard, focus, screen reader, reduced motion, zoom 200%.
- State-rich: loading, empty, success, warning, blocked, waiting-user, waiting-provider, retry/error, forbidden, plan-limited, suspended.
- UI phai trung thuc ve capability maturity va external/provider pending.

## Bat bien he thong

- Astro 7 strict TypeScript tren Cloudflare Worker modular monolith.
- D1 authoritative cho tenant, catalog, inventory, order, payment, fulfillment, entitlement, subscription, audit.
- Tenant storefront tu hostname active, khong tu browser `shop_id`.
- Seller authority tu session + active membership + server capability.
- Website va Telegram dung cung commerce/payment/inventory/fulfillment services.
- Gia, stock, payment, fulfillment, role, readiness va plan limit do server quyet dinh.
- Payment va fulfillment la hai status rieng.
- Return URL/QR/page success khong bao gio danh dau paid.
- Partial/overpaid/late/mismatched payment khong auto-fulfill.
- Khong co buyer account trong MVP hien tai; order access dung opaque token.
- Khong expose secret, credential, provider payload, internal shop ID, inventory-key plaintext hoac order token.
- Mutation phai giu CSRF, origin, recent-auth, idempotency, optimistic version va tenant fences theo endpoint.

## Cach thuc hien

1. Inventory route/API/service/state tai commit baseline; so sanh voi `route-contracts.yaml`.
2. Lam information architecture va wireframe cho tat ca route, co state variants.
3. Trinh bay tung control cung authority/API/role/state; khong chi trinh bay hinh anh.
4. Xay design primitives va surface shells.
5. Trien khai theo vertical slices trong `IMPLEMENTATION_MIGRATION_PLAN.md`.
6. Them/giu tests cho tenant isolation, role visibility, stale state, duplicate mutation, no-JS, accessibility va responsive.
7. Cap nhat docs/acceptance matrix trong cung pull request khi source contract thay doi.

## Definition of done

- Tat ca page route trong inventory co UI hoac intentional redirect/alias.
- Tat ca action co exact endpoint/method/security/error mapping.
- Khong co fake metric/action/provider/plan.
- Role va suspended/plan/provider state hien dung va fail closed.
- Browser test pass tai 1440/768/390/320 va zoom 200%, khong overflow.
- `check`, `lint`, `test`, `build`, `deploy:dry-run` pass.
- Cutover co canary, monitoring va rollback; khong kich hoat external provider/resource ngoai scope frontend.
