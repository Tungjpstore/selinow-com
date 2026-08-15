# PayOS Multi-Tenant Integration Contract

## Current continuation overlay (2026-08-03)

PayOS remains the seller-order payment provider and its signed event/reconciliation rules remain authoritative for seller checkout. Platform subscription billing uses the separate Dodo adapter and trust boundary. The channel expansion work does not infer payment from QR/return URLs, and does not permit WhatsApp, Zalo or Discord messages to mark an order paid. Provider/channel activation and payment settlement remain separate gates.

## 1. Payment ownership

- Mỗi shop kết nối payment channel PayOS của chính seller.
- Tiền đi trực tiếp về tài khoản/kênh PayOS của seller.
- `selinow.com` không gom tiền rồi payout trong MVP.
- Platform subscription billing must use Dodo's platform namespace and code path;
  it must never reuse seller PayOS credentials or webhook evidence.

## 2. Seller-provided credentials

Mỗi shop nhập:

- `PAYOS_CLIENT_ID`
- `PAYOS_API_KEY`
- `PAYOS_CHECKSUM_KEY`

Trong multi-tenant implementation, đây là credential record trong database đã mã hóa, không phải Worker environment variable theo từng shop.

Tên biến trên chỉ dùng trong UI/docs để seller nhận biết field tương ứng. Không hiển thị lại value sau khi lưu.

## 3. Credential security

- Nhận qua HTTPS dashboard endpoint có session, CSRF và recent-auth requirement.
- Giới hạn body và reject control characters/oversized input.
- Mã hóa ngay bằng credential KEK version hiện hành.
- Lưu fingerprint HMAC để phát hiện bộ credential nhập lại nếu cần.
- UI chỉ hiển thị status, connected time, channel/account identity đã sanitize và nút rotate/disconnect.
- Logs/audit chỉ ghi `payos_credentials_connected`, không ghi field/value/fingerprint.

## 4. Provider client

Base URL hiện hành cần kiểm tra lại từ tài liệu PayOS trước khi code. Adapter phải hỗ trợ:

- Tạo payment link.
- Lấy payment request/status theo order code hoặc provider ID.
- Hủy payment link nếu business flow cần.
- Xác nhận/đăng ký webhook qua `confirm-webhook` nếu PayOS API hiện hành hỗ trợ.

Headers merchant API thường gồm `x-client-id` và `x-api-key`; không log request headers hoặc URL chứa dữ liệu nhạy cảm.

Mọi call:

- Timeout 5–10 giây tùy operation.
- Response size cap.
- JSON validation và allowlist field.
- Safe provider error mapping.
- Circuit/degraded health signal sau lỗi lặp.
- Không retry POST tạo payment link mù nếu chưa có idempotency/recovery strategy.

## 5. PayOS webhook URL

Mẫu chuẩn:

```text
POST https://api.selinow.com/webhooks/payos/{payosWebhookPublicId}
```

Public ID là random opaque ID. Không dùng slug/shop ID.

Khi seller connect hoặc rotate credentials, platform gọi PayOS confirm-webhook với URL này nếu API/channel cho phép. Sau đó lưu trạng thái registration và thời điểm xác minh.

Nếu một PayOS channel chỉ hỗ trợ một webhook URL, UI phải cảnh báo rằng kết nối channel đó vào shop sẽ thay webhook đang có ở hệ thống khác.

## 6. Credential verification/onboarding

Flow:

1. Nhận credentials và giữ trong request memory.
2. Gọi một operation PayOS an toàn để xác minh.
3. Đăng ký webhook tự động.
4. Xác minh response/provider code/signature theo contract hiện hành.
5. Mã hóa/lưu active credentials và sanitized identity.
6. Nếu bất kỳ bước nào lỗi, lưu pending/error state nhưng không coi integration ready.

Không tạo payment tiền thật tự động mà seller không xác nhận. Controlled test link phải ghi rõ amount, expiry và cleanup.

## 7. Payment link creation

Input domain đã được server tính:

- `shopId`
- `orderId`
- unique positive `orderCode`
- exact amount minor units; với VND amount là integer đồng theo PayOS contract
- deterministic short description phù hợp giới hạn provider
- seller-specific credentials
- return/cancel URL dùng canonical shop origin nhưng không mang authority
- expiry

Request signature phải được tạo đúng canonicalization trong tài liệu PayOS hiện hành. Không tự sáng tạo thứ tự field.

Sau create thành công, lưu normalized:

- Provider payment link ID.
- Provider order code.
- Checkout URL.
- QR data/URL nếu cần.
- BIN/account number/account name đã normalize hoặc masked theo nhu cầu.
- Amount, description, currency, expiry.
- Provider response payload hash.

Nếu provider create thành công nhưng local response bị mất, reconciliation phải có thể recover bằng unique order code; không tạo link mới với order code khác mà chưa kiểm tra link cũ.

## 8. Order code allocation

`orderCode` phải:

- Positive integer trong giới hạn PayOS/JavaScript safe integer hiện hành.
- Globally unique trong platform, không chỉ unique theo shop.
- Không tiết lộ trực tiếp số user/shop.
- Không tái sử dụng sau cancel/expiry trong retention period.

Dùng sequence allocator có guard hoặc timestamp/random scheme đã kiểm tra collision. Database unique constraint là lớp cuối.

## 9. Webhook verification

Webhook handler:

1. Resolve integration bằng path public ID.
2. Enforce body size/content type.
3. Parse bounded JSON.
4. Decrypt checksum key cho đúng shop.
5. Verify PayOS signature constant-time theo canonicalization chính thức.
6. Chỉ sau signature hợp lệ mới tin provider data.
7. Resolve payment attempt bằng provider order code/link ID và cùng `shop_id`.
8. Dedupe provider event/reference + payload hash.
9. Normalize event và enqueue/process state transition.
10. Trả response theo contract PayOS đủ nhanh để tránh retry không cần thiết.

Nếu path shop và signed data không map tới cùng payment attempt, ghi `identity_mismatch`, không fallback tìm ở shop khác.

## 10. Paid decision

Một order chỉ được paid tự động khi tất cả điều kiện phù hợp:

- Webhook signature valid hoặc status được fetch trực tiếp từ PayOS bằng credential đúng tenant.
- Provider order code khớp payment attempt.
- Payment link/provider ID khớp khi field có mặt.
- Exact expected amount.
- Currency expected.
- Expected transfer description/reference.
- Destination account/channel identity không mâu thuẫn.
- Payment occurred trước/within allowed expiry policy.
- State chưa terminal incompatible.

Classification tối thiểu:

```text
pending
paid_exact
partial
overpaid
late
identity_mismatch
inconsistent
terminal_unpaid
```

Chỉ `paid_exact` kích hoạt auto-fulfillment.

## 11. Idempotency and fulfillment

- Duplicate webhook hợp lệ trả success nhưng không lặp transition.
- Payment transition dùng conditional update.
- Fulfillment có unique guard theo order.
- Inventory key đã sold/allocated không được cấp lần hai.
- Telegram/email notification là outbox riêng; lỗi notification không rollback paid state.
- Reveal lại key trả allocation cũ, không tạo allocation mới.

## 12. Return/cancel URL

- Return URL chỉ đưa buyer về order-status page.
- Page luôn query local state và có thể trigger bounded reconciliation.
- Query param từ PayOS/browser không được trực tiếp mark paid.
- Cancel URL không tự cancel order nếu provider status chưa xác nhận; dùng intent và reconciliation.

## 13. Reconciliation

Cron/queue:

- Chọn payment attempt pending sắp/đã expiry theo indexed cursor.
- Claim lease để tránh nhiều worker reconcile cùng record.
- Gọi PayOS status với concurrency bounded và provider rate awareness.
- Apply cùng decision engine với webhook.
- Exponential backoff + jitter.
- Sau ngưỡng lỗi, mark degraded/exception và thông báo seller.
- Không scan toàn bảng mỗi cron.

Reconciliation là fallback khi webhook mất/chậm, không phải lý do bỏ signature verification.

## 14. Exceptions

Seller dashboard có inbox:

- Partial payment.
- Overpayment.
- Late payment.
- Mismatched description/account/link.
- Provider inconsistency.
- Paid nhưng fulfillment thiếu stock do invariant breach.

Manual resolution cần role phù hợp, recent authentication, confirmation và audit. Không cho staff tự gõ “paid” không có reason/evidence metadata.

## 15. Credential rotation/disconnect

### Rotate

1. Nhận credential mới.
2. Verify/register webhook bằng credential mới.
3. Atomic activate new credential version.
4. Credential cũ giữ encrypted trong grace ngắn nếu cần verify webhook đang bay, sau đó revoke.
5. Pending payment attempt phải biết credential version/channel identity dùng khi tạo để reconciliation không dùng nhầm.

### Disconnect

- Chặn checkout mới.
- Không xóa payment/order history.
- Pending attempts chuyển manual review hoặc tiếp tục reconcile trong grace theo credential retention policy.
- Audit rõ tác động.

## 16. PayOS tests

- Invalid signature rejected.
- Valid duplicate webhook is idempotent.
- Same provider event with different payload hash is flagged.
- Cross-tenant webhook path/order code mismatch rejected.
- Exact payment fulfills once.
- Partial/overpaid/late never auto-fulfill.
- Return URL cannot mark paid.
- Create timeout recovery reuses/fetches existing order code.
- Credential rotation preserves old pending reconciliation safely.
- Provider timeout/5xx maps to retry without exposing credentials.
- Suspended shop behavior follows explicit policy for existing pending orders.

## 17. Official contract check

Trước implementation, kiểm tra tài liệu PayOS hiện hành cho:

- Merchant base URL và API version.
- Required headers.
- Create/get/cancel payment request.
- `confirm-webhook` contract.
- Request/response signature canonicalization.
- Webhook response acknowledgement.
- Field lengths và `orderCode` constraints.
- Test environment/provider limitations.

Nguồn: https://payos.vn/docs/
