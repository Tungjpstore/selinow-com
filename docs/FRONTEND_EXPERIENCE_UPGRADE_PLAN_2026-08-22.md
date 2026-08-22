# Kế hoạch nâng cấp toàn diện Experience Platform 2.0 (EX program)

Ngày: 2026-08-22 · Trạng thái: **CHỜ DUYỆT OWNER** (kèm các điểm chốt ownership với luồng song song ở §13)
Phạm vi: **big upgrade** toàn bộ trải nghiệm — console (seller dashboard), marketing, onboarding,
auth, storefront power features, hệ thống design-token/motion thống nhất, và **nối mọi UI vào
backend vận hành thật** (read-model, metrics thật, mutation chuẩn hóa). Không phải gói sửa lặt vặt:
mỗi phase là một tầng năng lực mới có contract, có gate, có acceptance riêng.

Quan hệ với các plan đã có:
- `docs/storefront-templates/TEMPLATE_COMPLETION_DESIGN_PLAN_2026-08-22.md` (CD0–CD5): **đã xong**,
  EX chỉ đụng storefront ở phần "power features" còn nợ (EX4) — không làm lại.
- `docs/SELLER_DASHBOARD_UPGRADE_PROPOSAL.md` (Control Tower, Phase 0–5): EX **thừa hưởng và mở
  rộng** — EX1 ≈ Phase 2 (cockpit thật), EX2 ≈ Phase 3 (record workspaces), EX5 chứa Phase 4
  (Launch Center). EX không thay thế proposal mà cụ thể hóa thành spec thi công + nối backend.
- Chuỗi P0/P0.1x "Selinow Soft" (đã commit): EX0 nâng Soft thành token spine chính thức.

---

## 1. Mục tiêu & định nghĩa "xong" của chương trình

Người bán trên Selinow hôm nay phải mở 6 màn hình mới biết shop mình khỏe hay ốm; biểu đồ doanh
thu trên Overview là **số bịa** đặt cạnh các giá trị "không có dữ liệu" trung thực; palette lệch
3 tông giữa marketing / auth / console; motion tồn tại lẻ tẻ ở onboarding nhưng marketing chết
đứng; một nửa primitive UX (Drawer, Toast, Skeleton, ActionQueue…) đã viết rồi bỏ không nối;
backend có sẵn API seller gần như **chưa ai gọi**.

Sau EX:
1. **Mọi con số trên UI đều thật** — không còn dữ liệu bịa; chỗ nào chưa có read-model thì làm
   read-model (EX1/EX3), không vẽ trang trí thay số liệu.
2. **Mọi mutation một phác đồ duy nhất** — optimistic + toast + rollback, CSRF/recent-auth/
   Idempotency-Key tự động, không còn `location.reload()` sau thao tác.
3. **Một ngôn ngữ thị giác + motion** — Soft #7C6AF0 xuyên suốt 4 surface, motion token tiêu thụ
   100%, reduced-motion trọn vẹn.
4. **Console là Control Tower thật** — Today cockpit tự làm mới theo freshness protocol, action
   queue + activity feed từ audit/domain-events thật, record workspace list+detail, command
   palette tìm được bản ghi và chạy được action.
5. **Gate chất lượng bao cả console** — visual regression + axe cho /app, i18n vi/en parity,
   motion contract, perf budget.

**Non-goals:** không tách service khỏi monolith; không đổi state-machine tiền hàng/thanh toán;
không nhúng AI copilot (2026 trend nhưng ngoài đạo quân của kiến trúc hiện tại — ghi §15); không
full page-transition framework (SSR thuần, lý do §10.6); không web font mới (CSP giữ nguyên).

---

## 2. Hiện trạng audit (2026-08-22, working tree)

### 2.1 Console (`/app`, 19 route)

| Hạng mục | Hiện trạng | Vấn đề then chốt |
|---|---|---|
| Overview | 4 health card + MetricStrip + sparkline + action queue + 6 đơn gần nhất, SSR 1 lần | **Sparkline bịa** (frontmatter nhân % cố định); 3 read ad-hoc không read-model; không tự làm mới; không requestId theo section; LiveActivityRadar topbar là **nút trang trí cứng success** |
| Primitive chết | `Drawer`, `ToastRegion`, `Skeleton`, `ActionQueue`, `HealthRail`, `ReadinessRail`, `ActivityLedger`, `LaunchChecklist` đã viết, **0 import** | index.astro viết lại markup trùng; record detail không có drawer nào dùng |
| Workspace mạnh | orders/[id] (3 mutation thật), products (editor 7 endpoint), store builder, customers (panel + privacy), inventory | dispatch/shipping xong là `reload()`; import key xong `reload()`; feedback = dòng `role=status` |
| Workspace yếu | **bookings = `<ul>` trần**, cửa sổ 14 ngày cứng, không lịch/agenda, không filter; members/billing/data/developer read-mostly | bookings là workspace tệ nhất dù backend là calendar feed sẵn |
| Command palette | ⌘K hoạt động, 16 mục điều hướng, hardcoded tiếng Việt, `innerHTML` | Không tìm bản ghi, không chạy action |
| i18n | dashboard.ts 3.984 key, **~46% giá trị tiếng Việt nằm dưới `en`**, không có catalog `vi`; ~35–40 chuỗi hardcode (palette, shell, onboarding-quickstart) | Sập cấu trúc — mọi tinh chỉnh copy sau này đều nợ |
| Polling | chỉ domains (DNS) + security (2FA) | Không freshness protocol chung |

### 2.2 Marketing / onboarding / auth

- Marketing v5.2 sáng — tĩnh — vận hành (opérationnel): **0 keyframe**, hook `data-reveal` chết (đặt attr không
  ai tiêu thụ), HeroFlowSim tĩnh, `--mk-brand #6552E8` (indigo cũ) **lệch** với Soft `#7C6AF0` của
  console/auth; 2 lớp CSS chồng nhau (`platform.css` 2198 dòng legacy + `marketing/*.css`).
- Onboarding 5 bước, motion giàu nhất hệ thống (stepEnter/Exit spring) nhưng: **không persist
  `shops.vertical` + `templateId`** (chỉ filter UI), preset sản phẩm tất cả là digital,
  `OnboardingCelebration` + `OnboardingLivePreview` mồ côi, gradient cũ `#6552E8→#3B82F6` còn
  sót progress bar, Soft hex hardcode rải trong `<style>` từng component.
- Auth 3 trang (login mode-tab + 2FA inline + magic-link + Turnstile thích ứng; register 2 bước;
  forgot-password 3 bước) — chồng 3 lớp token (sln + marketing + auth-soft shim), register/forgot
  có keyframe còn login thì không.

### 2.3 Design system & motion

- Token motion **tồn tại** (`--sln-duration-fast/default/panel/marketing`, ease chuẩn, spring/
  bounce định nghĩa trong console.css nhưng **chưa ai dùng**); MOTION.md cho phép
  reveal/flow-trace marketing — **không tồn tại trong code**; docs token (frontend-prompt-os)
  stale màu (chưa biết Soft).

### 2.4 Backend: cái có mà UI chưa dùng vs cái phải xây mới

**Có sẵn, UI chưa nối (wire trực tiếp):**
- Toàn bộ GET seller API (orders cursor, catalog, customers, bookings range + transition,
  automation tasks/rules + cancel/resume, readiness re-run, exports, audit) — trang SSR đang gọi
  lib thẳng, tầng API gần như bỏ không.
- `discount.apply` mutation + quote + **re-validate nguyên tử khi INSERT order** — luồng mã giảm
  giá chạy được ngay, chỉ thiếu ô nhập ở checkout.
- Bookings range query chính là calendar feed (comment trong code nói vậy).

**Phải xây mới (backend thật):**
1. Endpoint **metrics** (SQL `GROUP BY date(paid_at)` theo tenant) — thay sparkline bịa.
2. Read-model **`getSellerTodaySnapshot`** + endpoint `GET /today` (health/metrics/queue/
   activity/recentOrders theo section, kèm state + requestId + fetchedAt).
3. **Bookings resources/schedules GET** (+CRUD nhẹ) cho agenda theo resource.
4. **Seller discounts CRUD** (bảng `discounts` đã có; cần API + panel) + mutation
   `discount.remove`.
5. Audit feed: **cursor + chính sách role** (hiện owner-only, không filter).
6. `domain_events` mở rộng event types (hiện chỉ `order.created/paid`) để activity feed có nhịp
   sống; action-queue aggregate gộp vào today snapshot (không làm endpoint riêng).
7. Orders API: **wire 5 dòng** search/sort/status params (lib đã hỗ trợ).
8. Freshness: poll protocol + ETag/If-None-Match cho `GET /today` (đang không có conditional
   GET nào trong hệ).

---

## 3. Hiến pháp trải nghiệm (bắt buộc xuyên suốt EX)

1. **No fabricated data** — mọi chỉ số render phải truy được về SQL/read-model; placeholder
   trang trí nơi dữ liệu thiếu là `unavailable` state chuẩn, không phải số giả trang trí.
2. **WorkspaceDataState chính thức** (type chia sẻ client/server):
   `{ state: "ready"|"empty"|"unavailable"|"forbidden"|"waiting_provider"|"waiting_user", requestId?, fetchedAt? }`
   — mọi khối dữ liệu trên console render qua đúng 6 state này; fail-đọc **không bao giờ** hiển
   thị như rỗng/0 (đã là audit finding, giờ thành contract có test).
3. **Một phác đồ mutation** client duy nhất `mutate()` (§5.4): CSRF + Idempotency-Key tự động,
   optimistic + rollback, toast kết quả, `recent_auth_required` → hộp thoại tái xác thực chuẩn,
   cấm `location.reload()` sau mutation (diệt nốt 2 chỗ còn lại).
4. **Token spine đơn** — Soft `#7C6AF0` là accent duy nhất mọi surface; hex cấm nằm rải trong
   component `<style>` (test contract quét); storefront giữ token merchant riêng như CD.
5. **Motion theo token** — ký tự duration/easing literal ngoài `--sln-duration-*`/`--sln-ease-*`
   (allowlist ngoại lệ ghi rõ); mọi animation có nhánh `prefers-reduced-motion` thật (không chỉ
   clamp 1ms toàn cục).
6. **URL-as-state** — filter/sort/page/tab/selected-record sống trên URL (back/shareable); modal
   record dùng `?record=<id>` như product editor đang làm (chuẩn hóa cho orders/customers).
7. **i18n thật** — catalog `vi` + `en` parity đầy đủ cho dashboard; không chuỗi tiếng Việt
   hardcode trong TS/Astro (palette, shell…); test parity chặn hồi quy.
8. **A11y là gate chứ không phải phúc lợi** — axe (wcag2aa) chạy trong browser-gate cho cả
   storefront (đã có) lẫn `/app` (mới); focus management cho drawer/toast/palette theo pattern
   đã có trong CommandPalette.

---

## 4. EX0 — Nền tảng trải nghiệm (làm trước, mọi phase ăn theo)

### 4.1 Token spine v2
- Nâng Soft lên `selinow-tokens.css`: thêm nhóm `--sln-accent-soft: #7C6AF0` (+ tint/ink clamp sẵn
  AA), thống nhất marketing `--mk-brand`, retire `auth-soft.css` (3 trang auth import token spine
  mới), xóa hex Soft rải rác trong onboarding component → biến token. Sửa gradient sót
  `OnboardingShell`. Đồng bộ docs `selinow-frontend-tokens.css` + `COLOR_AND_SURFACES.md`.
- **Contract test**: quét 4 surface không còn `#7C6AF0|#6552E8` literal ngoài file token (allowlist
  storefront sheets — đó là template theme data như CD4 đã chuẩn).

### 4.2 Thư viện client dùng chung `src/scripts/lib/` (bundle, CSP-safe)
1. `data-state.ts` — type WorkspaceDataState + helper `sectionState(result)` map AppError→state.
2. `mutation.ts` — `mutate<T>({url, body, optimistic?, rollback?, toast?})`: đọc CSRF cookie,
   tự sinh `Idempotency-Key`, bắn sự kiện toast, xử lý `recent_auth_required` (mở ReauthDialog
   chuẩn), trả discriminated union `{ok, replayed}`.
3. `toast.ts` — điều khiển `ToastRegion` (primitive đã có, chỉ cần mount ở AppLayout +
   PlatformLayout marketing CTA events) — stack tối đa 3, auto-dismiss 4s, danger giữ tới đóng.
4. `drawer.ts` — hành vi Drawer: focus trap, Escape, `?record=` sync, restore focus.
5. `reveal.ts` — IntersectionObserver cho `[data-reveal]` (một observer chung, stagger bằng
   `--reveal-i`), tắt hoàn toàn dưới reduced-motion; **wire hook `data-reveal` đang chết** của
   marketing + dùng cho cockpit/list.
6. `poll.ts` — freshness protocol: `poll(fn, {intervalMs, maxHiddenMs})` — pause khi tab hidden,
   resume với fetch ngay, backoff khi 2 lần liên tiếp lỗi, `data-fresh-at` gắn lên UI (thay
   LiveActivityRadar trang trí bằng chỉ báo thật).
7. `countup.ts` — number ticker (tabular-nums, respects reduced-motion).

### 4.3 Wire primitive chết
- `ToastRegion` → AppLayout (console) + dùng cho mọi mutation rời `role=status`.
- `Skeleton` → mọi surface client-fetch (bookings, palette records, drawer body, today sections).
- `Drawer` → record detail EX2.
- `ActionQueue`/`HealthRail` → EX1 thay markup tay của index.astro.
- Xóa hoặc nối `OnboardingCelebration`/`OnboardingLivePreview` (EX5).

### 4.4 i18n tái cấu trúc (workstream dài, chia đợt)
- Tách `dashboard.ts`: giá trị VN dưới `en` → chuyển sang catalog `vi` mới; dịch `en` chuẩn theo
  từng domain (orders, inventory, store, onboarding…) — 6–8 đợt nhỏ, mỗi đợt một domain để review
  nổi. Bổ sung `vi` cho storefront/marketing/catalog còn thiếu nếu có.
- Chuỗi hardcode (palette 16 mục, shell topbar, onboarding-quickstart ~15) → key hóa.
- Parity test: 2 catalog bằng key-set; không value VN dưới `en` (detector regex tiếng Việt);
  `i18n-call-site-contract` cập nhật theo (file này đang fail do luồng khác — thu hồi trong EX7).

**Acceptance EX0:** contract test token + motion pass; demo mutate() trên 1 mutation thật
(low-stock threshold) có optimistic + toast + rollback; skeleton/toast/drawer/reveal/poll được
ít nhất 1 nơi dùng thật; catalog vi khởi tạo với 1 domain hoàn chỉnh (orders).

---

## 5. EX1 — Today Cockpit thật (kế thừa Proposal Phase 2, nối backend thật)

### 5.1 Read-model `getSellerTodaySnapshot`
`src/lib/dashboard/today-snapshot.ts` — gọi 1 lần từ SSR lẫn API:
```
TodaySnapshot {
  fetchedAt, requestId,
  health:  Section<HealthCard[]>        // bán hàng / đơn / catalog / readiness (tái dùng logic hiện tại)
  metrics: Section<Metrics>             // needsAction, paidOrders, revenue, fulfillmentRate, products + revenueByDay[7] THẬT
  queue:   Section<ActionQueueItem[]>   // readiness fails/warns + payment/fulfillment exceptions + license stockouts + automation waiting_user
  activity:Section<ActivityEntry[]>     // audit_logs (cursor) ∪ domain_events gần nhất, đã sort + dedupe
  recentOrders: Section<OrderSummary[]> // 6 đơn mới nhất
}
Section<T> = { state, requestId?, data? }  // đủ 6 state §3.2
```
Endpoint `GET /api/app/shops/[id]/today` (private no-store + ETag/If-None-Match — nền freshness).

### 5.2 Metrics thật (backend EX3.1 tiêu thụ ở đây)
`lib/dashboard/metrics.ts`: SQL tenant-leading `SUM(total_minor) GROUP BY date(paid_at), currency`
7/30 ngày (tôn trọng order-currency invariants — không cộng lệch tiền tệ, hiển thị theo currency
chính của shop); index mới nếu cần (migration tiếp theo chuỗi = **0108**). Sparkline bịa bị xóa —
thay bằng `RevenueSparkline` thật + countup + draw-in motion (EX6).

### 5.3 Cockpit sống lại
- index.astro dựng từ `ActionQueue` + `HealthRail` + section skeletons; mọi section tự poll riêng
  qua `poll.ts` (metrics 60s, queue 45s, activity 90s; pause hidden; chỉ báo `data-fresh-at`).
- LiveActivityRadar → **FreshnessBeacon thật**: tone theo kết quả poll cuối (ok/stale/error) +
  số task đang `waiting_user`; bấm mở panel activity.
- Quick actions trên cockpit: "Tạo sản phẩm" (mở dialog products), "Chạy kiểm tra sẵn sàng"
  (readiness re-run API có sẵn), "Sao chép link cửa hàng", "Xuất CSV hôm nay".
- Action queue item có action thật: deep-link kèm `shop` context (giữ) + nút hành động inline
  (vd. "Nhập key" trỏ thẳng dialog import, "Duyệt tác vụ" gọi automation resume).

**Acceptance EX1:** tắt mọi nguồn dữ liệu (stub lỗi) → cockpit render đúng 6 state/không số 0;
bật lại → số khớp SQL; sparkline truy được về `metrics` endpoint; poll dừng khi tab hidden
(test); không còn markup trùng giữa index và primitive.

---

## 6. EX2 — Record workspaces + Command palette v2 (Proposal Phase 3)

### 6.1 Orders workspace (mẫu chuẩn cho mọi record)
- Layout 2 pane: danh sách (DataTable, filter/sort/search theo URL — lib sẵn, API wire §8.7) +
  **Drawer chi tiết** (nạp `getSellerOrder` JSON qua API có sẵn, skeleton trong drawer, focus
  trap, `?order=<id>` trên URL, back/forward hoạt động).
- Timeline thanh toán/giao hàng trong drawer tái dùng component hiện tại của trang detail; trang
  detail riêng vẫn giữ (deep-link/preview) nhưng console hàng ngày sống trên list+drawer.
- Batch selection: xuất CSV đã chọn + copy danh sách mã đơn ( KHÔNG làm bulk state-change — giữ
  nguyên tắc không override tiền hàng).
- Mutation shipping/manual-fulfillment/remediation chuyển sang `mutate()`: optimistic row state,
  toast, hết reload.

### 6.2 Bookings workspace (nâng từ `<ul>` trần thành agenda)
- Thanh công cụ: dải 7/14/30 ngày, filter resource (EX3.3) + status, toggle "Hôm nay".
- Giao diện: nhóm theo ngày (agenda) + lưới tuần (CSS grid thuần, không thêm lib); mỗi booking =
  card giờ-dịch_vụ-khách-resource + nút transition (optimistic qua mutate()).
- Ẩn/hiện "quá khứ" (mặc định ẩn); đếm slot trống theo ngày (từ schedule EX3.3) cho resource.
- Mobile: agenda 1 cột, transition thành swipe-action? — không, giữ nút to (thumb zone), đủ.

### 6.3 Customers & Products
- Customers: panel inline hiện tại → **Drawer** + tab (Tổng quan / Ghi chú / Đơn hàng / Riêng tư
  — privacy giữ ConfirmDialog), timeline từ audit theo `resource_id` (EX3.5).
- Products: editor dialog giữ, **bổ sung editor `attributes`** (cột 0107 đã có, API đã nhận —
  đúng nợ CD); multi-image reorder (drag trong dialog, `sort_order` API có sẵn? — nếu chưa có
  endpoint reorder thì thêm PATCH nhỏ trong EX3); presets tạo nhanh theo vertical (dùng chung
  nguồn với onboarding EX5).

### 6.4 Command palette v2
- 3 nhóm: **Điều hướng** (16 mục, i18n) · **Bản ghi** (gõ `#` tìm đơn theo mã/id, `@` sản phẩm,
  `!` khách — gọi API q= tương ứng, hiện skeleton, Enter mở drawer/trang) · **Hành động** (Tạo
  sản phẩm/danh mục, Chạy readiness, Xuất CSV hôm nay, Mở storefront, Copy link).
- Fuzzy match client (danh sách nhỏ) + server search cho records; lịch sử gần nhất 5 lệnh;
  thay `innerHTML` bằng DOM API (an toàn + a11y listbox đúng như hiện tại).

**Acceptance EX2:** chọn đơn → drawer mở <200ms (skeleton rồi data), URL đổi, back đóng drawer;
mutation shipping không reload, rollback khi lỗi; bookings agenda 30 ngày < 50 node DOM/ngày;
palette tìm thấy đơn theo mã với 3 ký tự; mọi chuỗi palette qua i18n.

---

## 7. EX4 — Storefront power features (đóng nợ CD, nối backend sẵn)

1. **Ô nhập mã giảm giá tại checkout** (backend `discount.apply` + quote đã chạy nguyên tử —
   chỉ làm UI): input + nút áp dụng trong summary; states `discount_invalid` (chip danger chuẩn
   protected), áp dụng thành công → dòng "-giảm" + tổng mới + quote re-render; nút xóa mã
   (EX3.4 `discount.remove`); Bustle voucher chip giờ bấm là **điền sẵn** ô này.
2. **Seller discount manager**: tab "Khuyến mãi" trong Store Builder (EX3.4 API): danh sách mã,
   tạo (percentage/fixed, min, start/end, currency), bật/tắt, sao chép mã; countdown/voucher
   storefront (đã có từ CD) tự sống theo dữ liệu này.
3. **Attributes editor** (nếu luồng dashboard chưa làm trong EX2.3 — cùng file products.astro,
   chốt ownership §13).
4. Swatch **đa chiều** color×size (ma trận chọn, fallback list như CD); `.ics` cho booking trên
   trang đơn (client-side, quyết định mở §15 CD); LP2 thumbnail mini-render trong builder
   (scope: chỉ nếu rẻ — preview pane đã mang ngôn ngữ thật).
5. **Media reorder UI** (drag ảnh trong editor) + hiển thị thứ tự ảnh ở gallery storefront.

**Acceptance EX4:** E2E playwright (mock PayOS): thêm hàng → nhập mã sai (báo chuẩn) → nhập mã
đúng (tổng giảm, evidence có discount) → checkout idempotent; seller tạo mã → thấy countdown/
voucher xuất hiện trên storefront fixture.

---

## 8. EX3 — Backend vận hành thật (danh mục xây mới, mỗi mục theo release-guard checklist)

| # | Việc | Chi tiết | Guard |
|---|---|---|---|
| 1 | `GET .../metrics/range?days=` + lib SQL | GROUP BY ngày, tenant-leading index nếu plan explain cần (chuỗi migration tiếp = 0108) | migration 0108 → registry + chain-tip; test tenant-isolated |
| 2 | `getSellerTodaySnapshot` + `GET /today` (+ETag) | read-model thuần, không nguồn chân lý mới | API inventory CSV 195→196; no-store; capability theo section (viewer thấy ít hơn) |
| 3 | Bookings resources/schedules GET (+CRUD nhẹ) | list/create/archive resource; schedules upsert đã có POST | tenant test; audit |
| 4 | Seller discounts CRUD + `discount.remove` mutation | validate giống normalize hiện hành; status active/disabled; không xóa cứng | API inventory; quote re-validate đã có — test idempotent |
| 5 | Audit feed: cursor + role policy (manager/support đọc được bản thân hành động?) + filter `resource_type` | chính sách: owner toàn bộ; manager/support thấy audit của mình + tài nguyên mình chạm | test role matrix |
| 6 | `domain_events` mở rộng: `booking.transitioned`, `fulfillment.shipped/delivered`, `product.created/updated`, `discount.applied` | writer `prepareDomainEventAppend` có sẵn; consumer thêm: activity feed | outbox không đổi schema; test delivery không vỡ |
| 7 | Orders API wire search/sort/status | lib sẵn, route nhận thêm params | 5 dòng + test |
| 8 | Freshness: ETag cho `/today` (If-None-Match) | đáp 304 | test conditional |

Nguyên tắc: mọi endpoint mới theo pattern chuẩn §2.4.7 (CSRF/recent-auth/idempotency đúng chỗ);
**không** thêm rate limit seller API (giữ như hiện tại — đã sau auth).

---

## 9. EX5 — Marketing / Onboarding / Auth thống nhất (gồm Launch Center = Proposal Phase 4)

### 9.1 Marketing sống dậy (đúng allowlist MOTION.md, không phá khí hậu "tĩnh, vận hành")
- `reveal.ts` (EX0) wire `data-reveal` đang chết: fade+rise 240ms, stagger 40ms cho section
  Pricing/FAQ/Solutions; tắt hẳn reduced-motion.
- **HeroFlowSim thành flow-trace thật**: 3frame staged (chip giao dịch → thẻ đơn → dòng ledger)
  keyframe 2.8s rồi dừng (không loop — MOTION.md cấm loop ở mặt tiền); hover tooltip giải thích
  từng bước.
- Countup số liệu hero/pricing khi reveal; connector CommerceFlowRail vẽ nét khi vào viewport
  (stroke-dashoffset 400ms); FAQ chevron micro-rotate.
- Gộp màu: `--mk-brand` → Soft accent; **arch `platform.css`**: di nốt các trang satellites
  (solutions/support/legal/privacy + pricing phần cũ) sang lớp `mk-*` rồi xóa 2198 dòng legacy
  (giảm ~40% CSS marketing).

### 9.2 Onboarding nối thật
- Persist `sellingVertical` → `shops.vertical` + `templateId` trong payload tạo shop (API tạo shop
  mở rộng nhận 2 trường — cột đã có từ 0102; storefront templateId qua settings flow sẵn).
- Preset sản phẩm bước 2 theo vertical (digital keys / physical cóDeliveryMode shipping + stock /
  booking có durationMinutes) — dùng chung bảng preset với products quick-create (EX2.3).
- Wire `OnboardingLivePreview` vào preview drawer (thay wireframe) hoặc xóa; `Celebration` wire ở
  bước 5 hoặc xóa; reduced-motion pass toàn wizard (audit đang ghi nợ).

### 9.3 Auth + Launch Center
- Auth: về 1 lớp token spine (retire auth-soft), login có cùng motion enter nhẹ như register;
  kiểm tra focus flow 2FA inline (axe).
- **Launch Center v1**: tab "Phát hành" trong Store Builder gộp LaunchChecklist (primitive chết)
  + readiness (API re-run) + publish thành 1 timeline dọc — cầu nối Proposal Phase 4 mà không
  đụng IA lớn; `/onboarding` giữ cho luồng tạo shop đầu tiên.

**Acceptance EX5:** Lighthouse motion không có animation chạy >3s; shop mới tạo qua onboarding có
`vertical` + `template` đúng trong DB (test); 0 hex Soft ngoài token file; platform.css bị xóa
không vỡ trang satellite (visual gate).

---

## 10. EX6 — Bảng đặc tả motion (phần tử → trigger → token → reduced-motion)

| Phần tử | Trigger | Thời lượng/Easing (token) | Reduced-motion |
|---|---|---|---|
| Section reveal (marketing + cockpit cards) | vào viewport 1 lần | 240ms `--sln-duration-panel` ease-standard, rise 8px | tắt (hiện ngay) |
| List stagger (bảng đơn/queue/agenda) | data load/reveal | 120ms/40ms step, fade only | tắt |
| Drawer mở/đóng | click record / Esc | 240ms spring `--sln-ease-spring` (dùng token đang chết), translateX 24px | opacity 0→1 120ms |
| Toast vào/ra | sự kiện mutate | 180ms default, slide 12px + fade | fade only |
| Skeleton shimmer | loading | 1.2s loop gradient (đã có `sln-skeleton`) | shimmer tắt, giữ khối xám tĩnh |
| Nút nhấn | active | scale .98 120ms + đổi màu | chỉ đổi màu |
| Chart draw-in (RevenueSparkline) | data mới | 400ms `--sln-duration-marketing` vẽ stroke | hiện full |
| Countup số liệu | reveal | 400ms, tabular-nums, bước 8 frame | đặt giá trị luôn |
| HeroFlowSim staged | mount 1 lần | 2.8s tổng, mỗi bước 240–400ms rồi **dừng** | frame cuối tĩnh |
| FreshnessBeacon pulse | poll ok | 2s opacity loop nhẹ (duy nhất được loop — status) | tắt pulse |
| Booking transition chip | mutate | 180ms đổi màu chip protected | đổi màu tức thì |
| Page transition | — | **không làm** (SSR toàn trang; fade-in body 120ms tối đa nếu muốn) | — |

Contract test EX6: lint custom quét `transition|animation` chứa giá trị ms/s literal ngoài
`var(--sln-*)` (allowlist: skeleton, beacon, hero staged, reduced-motion blocks).

---

## 11. EX7 — Gates chất lượng mở rộng

1. **Console visual regression**: mở rộng `local-auth-browser-gate` thêm spec `/app` (login →
   overview → orders → store builder) 2 viewport; baseline chốt máy như CD5.
2. **Axe trên /app**: cùng gate, tags wcag2aa, fail chặn.
3. **i18n parity gate**: key-set vi≡en; không giá trị VN dưới en; không chuỗi hardcode trong
   danh sách file guarded (palette, shell, quickstart).
4. **Motion contract** (§10) + **token spine contract** (§4.1).
5. **Perf budget**: dùng cloudflare:web-perf đo staging marketing + fixture storefront; budget
   LCP <2.5s / INP <200ms / CLS <0.1 ghi vào release checklist; EX5 xóa platform.css phải đạt
   budget CSS < 150KB tổng.
6. **E2E happy paths** (playwright, mock PayOS/Turnstile local): (a) mua kèm mã giảm giá, (b)
   seller tạo sản phẩm có attributes + mã giảm giá → publish → thấy trên storefront, (c) booking
   đặt slot → seller agenda transition.
7. Mỗi milestone EX: gate chuẩn AGENTS (`check/lint/test/build/deploy:dry-run`) + docs
   IMPLEMENTATION_STATUS cập nhật.

---

## 12. Ma trận màn hình chính × phase chịu trách nhiệm

| Màn hình | EX0 | EX1 | EX2 | EX3 | EX4 | EX5 | EX6 | EX7 |
|---|---|---|---|---|---|---|---|---|
| /app (cockpit) | token/toast/poll | **làm chính** | palette records | snapshot+metrics API | — | — | reveal/stagger/countup | VR+axe |
| /app/orders (+[id]) | mutate lib | queue deep-links | **làm chính** | API params | — | — | drawer/stagger | VR |
| /app/bookings | mutate lib | — | **agenda thật** | resources GET | — | — | stagger | — |
| /app/products | — | quick-create | attributes editor | reorder API | dùng | presets chung | — | — |
| /app/customers | — | — | drawer + timeline | audit cursor | — | — | drawer | — |
| /app/store | — | — | — | discounts API | **tab khuyến mãi** | Launch Center | — | VR |
| Storefront checkout | — | — | — | discount.remove | **ô mã** | — | chip transition | E2E |
| Marketing | reveal lib | — | — | — | — | **làm chính** | flow-trace/countup | perf |
| Onboarding/Auth | token spine | — | — | — | — | **persist vertical + Launch Center** | reduced-motion pass | axe |
| Command palette | toast lib | — | **v2 records+actions** | — | — | i18n | — | — |

---

## 13. Thứ tự triển khai, ước lượng, phối hợp song song

```
EX0 (2–3 phiên)  ──┬─→ EX3 nhóm "nhanh" #7,#8 (song song, 0.5 phiên)
                   ├─→ EX1 (2 phiên, cần EX3.1/#2)
                   │    └─→ EX2 (3 phiên; bookings có thể song song với orders)
                   ├─→ EX4 (1.5–2 phiên, cần EX3.4)
                   └─→ EX5 (2 phiên, độc lập backend) → sau đó EX6 pass riêng (1 phiên)
EX7: cài ngay sau EX0 (gate i18n/motion/token) và mở rộng sau mỗi milestone (VR console sau EX2,
E2E sau EX4); tổng ~13–17 phiên.
```

**Điểm chốt ownership với luồng song song (bắt buộc trước khi mở phase):**
1. `src/pages/app/*` + `scripts/dashboard/*` + `dashboard.ts` — luồng dashboard đang giữ tree dơ
   trên chính nhánh này; EX1/EX2 chỉ mở khi họ commit/giao file (đặc biệt index.astro,
   products.astro cho attributes editor).
2. Proposal Control Tower Phase 2–4 — EX1/EX2/EX5.3 chính là bản thi công của nó; xác nhận với
   owner proposal để không hai đầu cùng làm cockpit.
3. Migration mới nhất hiện là 0107 (CD); EX3.1 nếu cần index sẽ là **0108** theo chuỗi.
4. Không `git add -A` (nhánh chung, rule memory); mỗi phase tự commit chọn lọc file.

**Rủi ro chính:** (a) đụng độ file với luồng dashboard — giảm bằng thứ tự trên + chốt ownership;
(b) i18n 3.984 key là workstream dài — chia domain, không big-bang; (c) platform.css arch có
nguy cơ vỡ trang satellite — có visual gate chặn trước khi xóa; (d) ETag/poll làm sẵn nhưng nếu
D1 read tốn thì giới hạn poll chỉ khi tab visible (đã thiết kế trong poll.ts); (e) palette ghi
`innerHTML` — thay bằng DOM API có test a11y.

---

## 14. Acceptance toàn chương trình ("định nghĩa xong của EX")

1. Trên console, **không còn** — số liệu bịa, reload sau mutation, markup trùng primitive chết,
   hex ngoài token, duration/easing literal, chuỗi hardcode, `<ul>` bookings trần.
2. Mọi section dữ liệu 6-state chuẩn; mọi mutation qua `mutate()`; mọi record mở được từ palette
   và drawer; mọi filter sống trên URL.
3. Backend: metrics/today/discounts/bookings-resources/audit-cursor lên production có E2E xanh;
   sparkline truy về SQL.
4. Motion: bảng §10 áp đủ; contract test xanh; reduced-motion không còn gì phụ thuộc clamp toàn cục.
5. Gates §11 tất cả xanh trên máy capture chuẩn; docs (frontend-prompt-os + IMPLEMENTATION_STATUS)
    đồng bộ Soft + EX.

---

## 15. Quyết định mở (chờ owner)

1. Palette records search prefix (`#` `@` `!`) hay search box thường với scope switch?
2. Bookings: có làm lưới tuần (grid) ở v1 hay chỉ agenda list (đề xuất: agenda trước, grid sau
   khi có feedback)?
3. Audit role policy: manager/support đọc được đến đâu (đề xuất: audit của chính mình + tài
   nguyên mình chạm)?
4. `.ics` booking: làm ở EX4 (client-side) hay để ra roadmap sau?
5. Passkey/WebAuthn cho login: mở nghiên cứu hay ngoài phạm vi EX?
6. AI copilot nêu trong trend 2026: **đề xuất ngoài phạm vi** — quay lại khi có model gateway
   riêng; ghi nhận để không "FOMO trend".

---

## 16. Nguồn xu hướng đã tham khảo (2026-08-22)

- [Orbix — 9 SaaS Product Design Trends 2026](https://www.orbix.studio/blogs/saas-product-design-trends) — micro-interactions là trụ trend
- [Tubik — 7 UI Design Trends of 2026](https://tubikstudio.com/blog/ui-design-trends-2026/) — "past decoration toward intent": motion có mục đích
- [SaaSUI — 7 SaaS UI Trends 2026](https://www.saasui.design/blog/7-saas-ui-design-trends-2026) · [UXPatterns — Command Palette](https://uxpatterns.dev/patterns/advanced/command-palette) · [Solomon — Designing Command Palettes](https://solomon.io/designing-command-palettes/) — Cmd+K là table stakes, mở rộng ra record/action
- [SaaSFrame — Anatomy of High-Performance Dashboards 2026](https://www.saasframe.io/blog/the-anatomy-of-high-performance-saas-dashboard-design-2026-trends-patterns) — modular + global filter
- [Flowmaze — SaaS Dashboard Best Practices 2026](https://flowmazeux.com/saas-dashboard-design-best-practices/) · [Pencil & Paper — Data Dashboards UX](https://www.pencilandpaper.io/articles/ux-pattern-analysis-data-dashboards) — progressive disclosure, giảm cognitive load
- [Userpilot — 12 Micro-Interaction Examples](https://userpilot.com/blog/micro-interaction-examples/) — trigger/feedback/timing/consistency
