# Telegram Multi-Bot Integration Contract

## 1. Ownership model

- Mỗi shop dùng một bot do seller tạo và sở hữu.
- Nền tảng không tạo bot hàng loạt bằng một BotFather account chung.
- Một bot token chỉ được active ở một shop trong platform.
- Seller có thể disconnect/rotate token; disconnect không xóa order/customer history.

## 2. Manual input duy nhất

UI hướng dẫn seller:

1. Mở `@BotFather`.
2. Chạy `/newbot`.
3. Chọn display name và username kết thúc bằng `bot`.
4. Copy token và dán vào dashboard qua HTTPS.

Không yêu cầu seller tự gọi `setWebhook`, nhập webhook secret hoặc cấu hình command.

## 3. Credential storage

Tenant secrets:

- `bot_token`
- `webhook_secret`

Token và webhook secret được mã hóa trong `shop_credentials`. Bot ID, username và display name có thể lưu dạng metadata đã sanitize.

Không dùng một Cloudflare Worker Secret cho mỗi bot vì không mở rộng được và khó rotate tự phục vụ.

Credential fingerprint dùng keyed HMAC của token để phát hiện token đã kết nối shop khác. Lưu thêm keyed HMAC digest của webhook secret để request verification không phải decrypt secret trên mọi update; bản encrypted vẫn cần cho retry `setWebhook` và rotation. Không dùng plain SHA-256 làm cơ chế bảo vệ secret có entropy không chắc chắn.

## 4. Webhook URL

Mẫu chuẩn:

```text
POST https://api.selinow.com/webhooks/telegram/{telegramWebhookPublicId}
```

`telegramWebhookPublicId` là opaque random ID, không phải shop ID/slug/bot username.

Khi gọi `setWebhook`:

- `url`: URL trên.
- `secret_token`: random URL-safe secret theo Telegram contract.
- `allowed_updates`: chỉ `message` và `callback_query` trong MVP.
- `drop_pending_updates`: mặc định `false`; chỉ `true` trong explicit reset flow có cảnh báo.
- `max_connections`: dùng giá trị hợp lý theo tài liệu hiện hành; không hard-code dựa trên phỏng đoán tải.

Telegram hiện gửi secret trong header `X-Telegram-Bot-Api-Secret-Token`. Xác minh header trước khi parse JSON lớn hoặc thực hiện business action.

## 5. Onboarding call order

1. `getMe` để xác minh token và lấy bot identity.
2. Kiểm tra bot username/ID không bị dùng bởi integration active khác.
3. Lưu pending encrypted credentials.
4. `setMyCommands` cho command mặc định và locale hỗ trợ.
5. `setChatMenuButton` nếu storefront/menu flow cần.
6. `setWebhook` cuối cùng.
7. `getWebhookInfo` để xác nhận URL, pending update count và error gần nhất.
8. Mark active.

Nếu token sai: không lưu active credential. Nếu command setup lỗi: không gọi webhook cho tới khi retry hoặc có policy cho phép degraded mode.

## 6. Provider client rules

Mọi Telegram API call:

- Chỉ tới `https://api.telegram.org`.
- Token nằm trong URL theo Telegram API nhưng URL không bao giờ được log.
- Timeout riêng, response-size cap và JSON parser bounded.
- Parse `ok`, `error_code`, `description`, `parameters.retry_after`.
- Map lỗi thành safe code như `telegram_unauthorized`, `telegram_rate_limited`, `telegram_webhook_failed`.
- Không trả provider description thô chứa dữ liệu nhạy cảm cho buyer.
- Tôn trọng `retry_after` và không retry tight loop.

## 7. Webhook request handling

Order xử lý bắt buộc:

1. Validate method/path/public ID.
2. Resolve bot integration bằng public ID.
3. Reject inactive/suspended shop hoặc integration theo policy.
4. HMAC header value bằng global verification key và so sánh constant-time với stored digest.
5. Enforce content type/body size, parse UTF-8 JSON.
6. Validate minimal Telegram Update shape.
7. Dedupe bằng `(bot_integration_id, update_id)` và payload hash.
8. Enqueue/process idempotently.
9. Return 2xx nhanh sau khi durable acceptance thành công.

Nếu cùng `update_id` nhưng payload hash khác, ghi security event và không xử lý lại.

## 8. Identity and privacy

- Identity buyer là `(shop_id, telegram_user_id)`.
- Chỉ private chat được checkout, xem orders hoặc reveal keys.
- Group/supergroup/channel chỉ nhận thông báo mở private chat với bot.
- Không dùng username làm identity vì username có thể đổi.
- Telegram `language_code` chỉ là hint locale.
- Synthetic email nếu schema cần phải dùng reserved invalid domain, ví dụ `tg-{id}@telegram.invalid`; không gửi email tới địa chỉ này.
- Chat ID hoặc Telegram user ID nhạy cảm có thể mã hóa/pseudonymize tùy use case; không public/log raw không cần thiết.

## 9. Commands

Command tối thiểu:

| Command | Behavior |
| --- | --- |
| `/start` | Menu và shop identity |
| `/shop`, `/products` | Catalog/category/product |
| `/cart` | Cart lines, quantity, discount, checkout |
| `/discount CODE` | Apply discount server-side |
| `/orders`, `/order` | Recent owned orders/status |
| `/keys` | Paid fulfilled orders và reveal action |
| `/help` | Safe help |

Command description được localize. Không đưa URL dashboard/admin hoặc internal ID vào buyer messages.

## 10. Callback data

- Telegram callback data có giới hạn nhỏ; giữ token ngắn và allowlist.
- Không nhét giá, amount, shop ID, credential hoặc serialized JSON vào callback.
- Ví dụ namespace: `cat:`, `pd:`, `qty:`, `cart`, `buy:`, `rf:`, `ord:`, `key:`, `menu`.
- Callback chỉ là intent/reference; server luôn load lại giá, stock, ownership và state.
- Luôn gọi `answerCallbackQuery` để kết thúc loading, nhưng không để lỗi answer làm lặp business mutation.

## 11. Telegram cart and checkout

- Cart key: `(shop_id, telegram_user_id)` hoặc subject hash tương ứng.
- Có TTL, line/quantity limits và server-side validation.
- Mỗi callback mutation có idempotency/dedupe từ update ID.
- Checkout dùng price/discount/stock snapshot mới; không tin message cũ.
- `source_channel='telegram'`.
- Order gắn customer identity Telegram.
- Payment response gửi QR/link và nút refresh.
- Nếu Telegram gửi cùng update lại, trả/render trạng thái order hiện có, không tạo order mới.

## 12. Key delivery

- Payment event tạo fulfillment/outbox reference một lần.
- Paid notification có nút “Xem key”.
- Reveal keys kiểm tra shop, Telegram identity, order ownership, paid và fulfillment state.
- Dùng `protect_content=true` khi gửi message chứa key nếu API hỗ trợ phù hợp.
- Với nhiều key, chunk an toàn theo Telegram message limits.
- Không lưu plaintext key trong outbox hoặc Telegram update table.
- Retry message delivery không allocate key mới; rehydrate cùng fulfillment allocation.
- Có thể giới hạn số lần reveal hoặc luôn cho buyer xem lại allocation cũ theo policy.

## 13. Telegram message outbox

Outbox payload chỉ chứa:

```json
{
  "shopId": "...",
  "integrationId": "...",
  "kind": "paid_notification",
  "orderId": "..."
}
```

Consumer load bot token/chat target/order state ở thời điểm gửi. Lease fencing ngăn hai worker gửi cùng job. Lỗi retryable và terminal phải phân loại:

- Retryable: 429, timeout, 5xx.
- Terminal/deactivate candidate: token revoked/401.
- Recipient unavailable: bot blocked/chat not found; mark safe failure, không retry vô hạn.

## 14. Rotation and disconnect

### Rotate token

1. Seller nhập token mới.
2. `getMe` xác minh expected bot hoặc explicit replace bot flow.
3. Cài commands/webhook bằng token mới.
4. Atomic switch active credential version.
5. Revoke old encrypted credential record.
6. Audit, không log token.

### Disconnect

- Gọi `deleteWebhook` nếu token còn dùng được và user xác nhận.
- Mark integration disabled.
- Giữ identity/order/audit.
- Chặn new Telegram checkout.

## 15. Health checks

- `getWebhookInfo` định kỳ hoặc khi seller mở integration page.
- Last update received.
- Last outbound success/failure.
- Pending updates và provider last error đã sanitize.
- Bot token authorization check có rate limit.
- Shop subscription/status.

Health không được decrypt token hàng loạt mỗi phút cho mọi bot. Dùng adaptive checks: active traffic, recent error và sampled polling.

## 16. Telegram tests

Tối thiểu:

- Wrong/missing secret header rejected before body processing.
- Duplicate update does not duplicate cart/order.
- Same update ID with different hash is rejected/audited.
- Private chat can buy; group cannot view order/key.
- Callback IDs cannot access another shop/product/order.
- Revoked token marks integration degraded without exposing token.
- 429 honors retry-after.
- Paid notification retry sends no new key allocation.
- Token rotation keeps webhook operational.
- Suspended subscription blocks new checkout but preserves order history.

## 17. Official contract check

Trước implementation, kiểm tra Telegram Bot API hiện hành cho:

- `getMe`
- `setWebhook`, `getWebhookInfo`, `deleteWebhook`
- `secret_token` format
- `allowed_updates`
- `setMyCommands`
- `setChatMenuButton`
- message/callback size limits
- rate-limit response and `retry_after`

Nguồn: https://core.telegram.org/bots/api
