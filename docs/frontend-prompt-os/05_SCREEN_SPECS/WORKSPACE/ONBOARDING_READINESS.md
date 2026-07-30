# Onboarding and readiness

## Purpose

Rút ngắn từ create shop đến test/publish, cho phép resume và retry theo server state.

## Layout

Desktop two-pane: 280px readiness rail + task panel. Sticky footer actions. Mobile progress summary + step selector.

## Exact hierarchy

Eight canonical steps:
1. Tạo/chọn cửa hàng.
2. Chọn website, Telegram hoặc cả hai.
3. Tạo sản phẩm và variant đầu tiên.
4. Preview và mã hóa inventory key.
5. Kết nối/health-check Telegram.
6. Kết nối/health-check PayOS.
7. Support và policy URL.
8. Readiness/test/publish.

Each step shows state, owner of next action, last check, and primary action.


## Mandatory states

waiting_user, waiting_provider, blocked, warning, ready, optional skipped, retry failed, forbidden, plan limited.

## Mobile 390px

Progress `4/8`, current status chip, `Mở danh sách bước`. One active step. No horizontal stepper.

## Acceptance criteria

- Progress comes from server.
- Resume after leaving page.
- Website-only does not require Telegram.
- Secret never prefilled.
- Inventory preview shows count only.
- Publish reruns readiness server-side.
