# Đề xuất nâng cấp lớn Seller Dashboard

Ngày: 2026-08-21

## 1. Tầm nhìn

Biến seller dashboard từ tập hợp các màn hình CRUD thành một **Seller Control Tower**: seller đăng nhập là biết ngay shop đang ở trạng thái nào, việc gì cần xử lý trước, doanh thu/đơn hàng có vấn đề gì, và có thể hoàn thành tác vụ chính mà không phải đi qua nhiều màn hình.

Đề xuất này giữ nguyên modular monolith, D1 là nguồn dữ liệu authoritative, tenant isolation và các API/mutation contract hiện tại. Thay đổi lớn nằm ở information architecture, orchestration UI, loading/error semantics và cách gom các tác vụ theo mục tiêu kinh doanh.

## 2. Vấn đề cần giải quyết

- Navigation hiện đã chia nhóm nhưng vẫn thiên về tên module; seller phải tự nối `Products -> Inventory -> Store -> Payments -> Orders` thành một quy trình.
- `/app` có nhiều tín hiệu nhưng chưa ưu tiên rõ “việc tiếp theo cần làm”.
- Các màn hình list/detail thường tách rời; thao tác sau khi xem một record dễ tạo context switch.
- Trạng thái `empty`, `unavailable`, `forbidden`, `waiting provider` cần được chuẩn hóa toàn console.
- Quyền được kiểm tra đúng ở backend nhưng UI chưa phải lúc nào cũng trình bày capability và lý do bị giới hạn một cách chủ động.
- Mobile shell đã có nhưng chưa nên chỉ là bản thu nhỏ của desktop; các tác vụ khẩn cấp cần một flow riêng.

## 3. Định hướng trải nghiệm

### 3.1. Mô hình “Today / Workspaces / Records”

Thay vì bắt seller nhớ module, console có ba lớp:

1. **Today**: tình trạng shop, cảnh báo, việc cần làm, đơn mới, readiness.
2. **Workspaces**: Bán hàng, Catalog, Kênh, Tự động hóa, Cài đặt.
3. **Records**: order, product, customer, booking, domain, member và các detail pane.

Navigation cấp cao vẫn tối đa 5 nhóm để giữ Hick’s Law; mỗi nhóm có một landing view, không đẩy seller thẳng vào bảng dữ liệu trống.

### 3.2. Overview mới: “Today cockpit”

Thứ tự đề xuất:

1. **Shop pulse**: active/suspended/trial, storefront availability, payment health, domain health.
2. **Action queue**: các việc có tác động trực tiếp đến khả năng bán, sắp theo severity và deadline.
3. **Commerce pulse**: orders hôm nay, paid/pending/exception, conversion proxy nếu dữ liệu đủ.
4. **Fulfillment watch**: booking sắp tới, đơn chưa giao, inventory low/out.
5. **Recent activity timeline**: ai đã làm gì, trạng thái server nào đã đổi.
6. **Quick actions**: add product, import inventory, open orders, configure PayOS, publish storefront.

Mỗi block phải có source timestamp, trạng thái loading/error và deep link giữ nguyên `shop` context. Không hiển thị số liệu tổng hợp nếu nguồn dữ liệu lỗi.

### 3.3. Record workspace: list + detail trong cùng một ngữ cảnh

Đối với Orders, Products, Customers và Bookings:

- Desktop: bảng bên trái, detail drawer/pane bên phải.
- Mobile: list → full-screen detail, có back giữ nguyên filter/page/search.
- URL là nguồn trạng thái: `shop`, filter, search, sort, page, selected record.
- Action mutation chỉ xuất hiện khi role có capability; nếu không có, hiển thị read-only explanation thay vì button disabled mơ hồ.
- Sau mutation, cập nhật optimistic ở mức an toàn, sau đó reconcile từ server; lỗi phải rollback và có request id.

### 3.4. Launch Center cho onboarding + storefront

Gộp `/onboarding`, readiness và một phần `/app/store` thành một Launch Center:

- Checklist theo điều kiện thật: identity, product, stock, payment, storefront, domain.
- Mỗi item có `blocked`, `ready`, `warning`, `verified` và link tới đúng màn hình sửa.
- Một CTA “Publish store” duy nhất, nhưng chỉ enable khi server xác nhận đủ điều kiện.
- Preview và publish status hiển thị cùng một timeline để giảm nhầm lẫn giữa “đã lưu draft” và “đã public”.

### 3.5. Mobile: “urgent-first”

Bottom navigation giữ 4 điểm vào: Today, Orders, Catalog, More. Trong Today cần:

- action queue dạng swipe-safe list;
- quick action cố định ở vị trí dễ chạm;
- filter chip ngang, không mở modal cho thao tác thường dùng;
- detail mutation có confirm rõ cho cancel, suspend, delete và publish.

Mọi target tương tác tối thiểu 44px, focus/keyboard parity với desktop và có reduced-motion mode.

## 4. Nâng cấp dữ liệu và backend contract

### 4.1. Dashboard read model

Thêm một read service tổng hợp, không tạo nguồn sự thật mới:

```text
getSellerTodaySnapshot(shop_id, user_id)
  -> shop_state
  -> readiness
  -> payment_health
  -> domain_health
  -> order_summary
  -> fulfillment_summary
  -> inventory_summary
  -> action_queue
  -> recent_activity
```

Service chỉ đọc từ các domain hiện hữu, áp dụng tenant-leading queries, trả từng section với `status: ready | empty | unavailable | forbidden` và `requestId` riêng. Một section lỗi không được làm giả thành zero.

### 4.2. Action queue có priority contract

Mỗi action nên có:

- `code` ổn định;
- `severity`: blocking, high, medium, info;
- `source`: readiness, payment, order, inventory, domain;
- `dedupeKey` để không lặp cảnh báo;
- `href` tenant-safe;
- `requiredCapability`;
- `expiresAt` hoặc điều kiện hoàn thành.

### 4.3. Chuẩn hóa state contract

Tất cả seller pages dùng cùng kiểu state:

```ts
type WorkspaceDataState =
  | { status: "ready"; data: unknown }
  | { status: "empty"; data: unknown }
  | { status: "unavailable"; requestId: string }
  | { status: "forbidden"; requiredCapability?: string }
  | { status: "waiting_provider"; provider: string };
```

Không dùng `[]` hoặc `{}` làm fallback ngầm cho lỗi đọc dữ liệu.

## 5. Information architecture đề xuất

| Nhóm | Landing view | Tác vụ chính |
|---|---|---|
| Today | `/app` | xử lý cảnh báo, xem sức khỏe shop, mở tác vụ tiếp theo |
| Sell | `/app/orders` | xử lý đơn, payment exception, fulfillment, customers, bookings |
| Catalog | `/app/products` | product/category/variant, stock và visibility |
| Channels | `/app/store` | storefront, Telegram, PayOS, domains |
| Automate | `/app/automation` | rules, history, retry an toàn |
| Govern | `/app/security` | members, billing, developer, data, audit |

`/app/inventory`, `/app/payments`, `/app/domains`, `/app/members` vẫn giữ deep link trực tiếp; chỉ thay đổi cách được dẫn dắt từ landing view.

## 6. Roadmap triển khai

### Phase 0 — Baseline và instrumentation

- Đo time-to-first-action, time-to-publish, tỷ lệ error state, tỷ lệ mutation 403 từ UI.
- Gắn event không chứa secret/PII: page view, action clicked, mutation result, state transition.
- Chốt snapshot contract và danh sách capability theo role.

**Nghiệm thu:** có dashboard metrics baseline, không log token/license/customer plaintext, các event có shop-scoped opaque id.

### Phase 1 — Shell và state system

- Xây `WorkspaceDataState`, `ActionQueue`, `TodaySnapshot` primitives.
- Chuẩn hóa breadcrumbs, shop context, retry, request id, focus restore, reduced motion.
- Sửa các route còn fallback empty khi read lỗi.

**Nghiệm thu:** mọi seller page có phân biệt rõ `empty` và `unavailable`; focused tests tenant/role/state pass.

### Phase 2 — Today cockpit

- Thay Overview hiện tại bằng snapshot read model và action queue.
- Thêm severity sorting, dedupe, deep link và “dismiss only when server state resolved”.
- Hiển thị freshness timestamp cho từng section.

**Nghiệm thu:** seller nhìn thấy next best action trong một viewport; section lỗi không làm sai KPI; shop switch reset đúng entity state.

### Phase 3 — Record workspaces

- Orders, Products, Customers, Bookings chuyển sang list + detail pane.
- Bổ sung saved filters/views ở client URL trước; chỉ persist server khi có nhu cầu thực.
- Batch actions chỉ mở cho capability tương ứng và có idempotency key.

**Nghiệm thu:** mở detail, sửa, quay lại list không mất filter/page; mobile back giữ context; 403 không xuất hiện như CTA hợp lệ.

### Phase 4 — Launch Center + channel health

- Hợp nhất readiness/onboarding/store publishing.
- Một timeline cho draft save, publish, provider verification và domain DNS.
- Provider errors có remediation path thay vì chỉ trạng thái đỏ.

**Nghiệm thu:** seller mới có thể đi từ empty shop đến published storefront bằng một guided path; return URL không tự xác nhận payment/publish.

### Phase 5 — Mobile và rollout

- Thiết kế mobile urgent-first, không chỉ responsive CSS.
- Canary theo role/shop cohort, feature flag ở read-only trước rồi mutation.
- Đo metrics trước/sau, mở rộng sau khi không có regression tenant/payment.

**Nghiệm thu:** mobile core flows không có horizontal overflow, touch target đạt chuẩn, rollback flag hoạt động trong một request.

## 7. Tiêu chí thành công cấp sản phẩm

- Giảm ít nhất 30% số click từ login đến next best action.
- Giảm ít nhất 25% thời gian từ tạo sản phẩm đến publish storefront.
- 0 UI mutation button hiển thị cho role không có capability tương ứng.
- 0 trường hợp lỗi read bị trình bày thành empty/zero mà không có trạng thái unavailable.
- 95% các action queue item dẫn đến màn hình remediation đúng tenant context.
- Core mobile flows: onboarding, order update, inventory import, publish storefront hoàn thành không cần desktop.

## 8. Rủi ro và cách kiểm soát

- **Snapshot trở thành nguồn sự thật thứ hai:** chỉ xây read projection, không cho snapshot mutation.
- **Overview quá nhiều thông tin:** giới hạn action queue 3–5 item, phần còn lại progressive disclosure.
- **N+1 query / chậm dashboard:** bounded queries, parallel reads, timeout từng section và cache chỉ cho read projection không authoritative.
- **Mutation optimistic sai trạng thái:** chỉ optimistic cho UI-safe transitions; luôn reconcile từ D1.
- **Role leakage:** test capability matrix ở server và DOM contract ở client.
- **Rollout ảnh hưởng seller đang hoạt động:** feature flag theo shop cohort, giữ route cũ làm fallback trong một release cycle.
- **Redesign làm mất affordance quen thuộc:** giữ URL, shortcut, command palette và vocabulary hiện tại trong giai đoạn đầu.

## 9. Không nằm trong phase đầu

- Không tách service riêng khỏi modular monolith.
- Không xây analytics warehouse hoặc BI tự phát.
- Không thay payment provider, inventory vault, credential encryption hoặc order state machine.
- Không thêm chat/CRM đầy đủ khi chưa có use case và data contract rõ.

## 10. Quyết định cần chốt trước khi code

Mặc định đề xuất là triển khai theo 5 phase trên, bắt đầu từ state system + Today cockpit. Chỉ cần chốt thêm nếu roadmap thay đổi materially:

1. Có cần persist saved views theo user/shop ngay phase 3 không, hay giữ URL-only trước?
2. Action queue có cho phép seller dismiss thủ công không, hay chỉ biến mất khi server state resolved?
3. Cohort pilot đầu tiên là owner/manager nội bộ hay một nhóm seller production nhỏ?
