# Prompt mở task mới

Sao chép nguyên khối dưới đây vào task Codex mới sau khi mở task trong repository dành riêng cho `selinow.com`:

```text
Bạn đang triển khai một sản phẩm mới và độc lập tên selinow.com.

Trước khi làm bất kỳ thay đổi nào, hãy đọc đầy đủ:
/Users/tunbee27/Documents/Selinow.com/00_MASTER_PROMPT.md

Sau đó đọc toàn bộ các file mà master prompt yêu cầu, theo đúng thứ tự. Hãy coi prompt kit là product, architecture, integration, security, automation và acceptance contract của dự án.

Yêu cầu thực thi:
- Làm việc trong repository/cwd hiện tại dành riêng cho selinow.com.
- Không sửa portfolio tại /Users/tunbee27/Documents/Profile và không sửa prompt kit, trừ khi tôi yêu cầu riêng.
- Nếu cwd hiện tại là portfolio hoặc không phải repository của selinow.com, hãy dừng và báo đúng blocker trước khi viết code.
- Không dừng sau khi lập kế hoạch. Triển khai theo phase, kiểm thử và cập nhật docs/IMPLEMENTATION_STATUS.md.
- Không yêu cầu tôi chọn các chi tiết kỹ thuật đã được prompt kit chốt.
- Không dùng credential production giả và không ghi secret vào source/log.
- Tối ưu để seller hoàn tất setup bằng browser/Telegram, không cần CLI hoặc hỗ trợ kỹ thuật trong happy path.

Bắt đầu bằng việc kiểm tra cwd/repository và đọc prompt kit. Nếu repository trống, tạo kế hoạch phase và triển khai Phase 0 theo acceptance criteria. Nếu repository đã có implementation, đọc docs/IMPLEMENTATION_STATUS.md, xác minh artifact hiện có và tiếp tục phase chưa hoàn tất đầu tiên; không làm lại phase đã hoàn thành nếu không có regression. Chỉ dừng khi có blocker thực sự cần credential, quyền bên ngoài hoặc phê duyệt production riêng.
```

Nên mở task mới trong một thư mục như:

```text
/Users/tunbee27/Documents/Selinow.com
```

Không mở task triển khai trong repository portfolio hiện tại vì hai sản phẩm phải có code, database, deployment và secrets độc lập.
