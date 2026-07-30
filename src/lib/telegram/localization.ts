import { createTranslator, type TranslationCatalog } from "../i18n/catalog";
import { resolveLocale, type SupportedLocale } from "../i18n/locale";
import { formatMoney } from "../i18n/currency";

/**
 * Telegram keeps one bounded catalog so provider adapters only deliver the
 * already-rendered reply. Unknown locales deliberately resolve to English.
 */
export const TELEGRAM_CATALOG: Readonly<Record<SupportedLocale, TranslationCatalog>> = {
  en: {
    "button.menu": "Menu",
    "button.cart": "Cart",
    "button.checkout": "Checkout",
    "button.addProduct": "Add {product}",
    "button.viewCart": "View cart",
    "button.order": "Order {order}",
    "button.paymentLink": "Get payment link",
    "button.refreshPayment": "Refresh payment",
    "button.orderStatus": "Order status",
    "button.viewKey": "View key",
    "button.viewOrder": "View order",
    "cart.empty": "Your cart is empty.",
    "cart.heading": "Cart for {shop}",
    "cart.line": "{index}. {product} - {variant} x{quantity}: {total}",
    "cart.subtotal": "Subtotal: {total}",
    "cart.discount": "Discount code: {code}",
    "catalog.empty": "{shop} has no products available right now.",
    "catalog.heading": "Products from {shop}",
    "catalog.line": "{index}. {product} - {variant}: {price}",
    "orders.empty": "You have no orders yet.",
    "orders.line": "{order}: {total} - {payment} / {status}",
    "order.heading": "Order {order}",
    "order.total": "Total: {total}",
    "order.payment": "Payment: {status}",
    "order.status": "Status: {status}",
    "order.fulfillment": "Fulfillment: {status}",
    "payment.link": "Payment link: {url}",
    "payment.expires": "Expires: {timestamp}",
    "payment.webhookOnly": "Only a valid PayOS webhook can confirm payment.",
    "key.heading": "Keys for order {order}",
    "key.line": "{index}. {product} - {variant}\n{value}",
    "menu.welcome": "Welcome to {shop}.",
    "menu.help": "Use /products to browse, /cart for your cart, /orders for orders, /keys for purchased keys, and /language to choose a language.",
    "menu.privateOnly": "Transactions are available only in a private chat with the bot.",
    "menu.prompt": "Choose a menu option or send /help for instructions.",
    "keys.empty": "You have no fulfilled keys yet.",
    "error.cart_empty": "Your cart is empty.",
    "error.catalog_changed": "The catalog changed. Please review the product list.",
    "error.discount_invalid": "That discount code is invalid or expired.",
    "error.inventory_unavailable": "That product just sold out. Please choose another product.",
    "error.order_not_found": "We could not find your order.",
    "error.order_not_fulfilled": "Your order is not ready for key delivery.",
    "error.payment_not_configured": "This shop has not configured payments.",
    "error.payment_not_available": "This order is no longer available for payment.",
    "error.payment_currency_unsupported": "This payment method does not support the order currency.",
    "error.provider_unavailable": "The service is busy. Please try again later.",
    "error.quantity_unavailable": "That quantity is not available.",
    "error.generic": "We could not process your request. Please try again.",
    "status.order.pending_payment": "Awaiting payment",
    "status.order.processing": "Processing",
    "status.order.completed": "Completed",
    "status.order.canceled": "Canceled",
    "status.order.expired": "Expired",
    "status.order.exception": "Needs review",
    "status.payment.unpaid": "Unpaid",
    "status.payment.pending": "Verifying",
    "status.payment.paid": "Paid",
    "status.payment.partial": "Partially paid",
    "status.payment.overpaid": "Overpaid",
    "status.payment.failed": "Payment failed",
    "status.payment.expired": "Expired",
    "status.payment.refunded": "Refunded",
    "status.fulfillment.unfulfilled": "Not delivered",
    "status.fulfillment.reserved": "Reserved",
    "status.fulfillment.fulfilled": "Delivered",
    "status.fulfillment.failed": "Delivery failed",
    "status.fulfillment.manual_review": "Needs manual review",
    "status.unknown": "Unknown",
    "notification.orderPaidReady": "Order {order} is paid and ready for delivery. Select View key to receive it in this private chat.",
    "command.start": "Open the shop menu",
    "command.products": "Browse products",
    "command.cart": "View cart",
    "command.discount": "Apply a discount code",
    "command.orders": "View orders",
    "command.keys": "View purchased keys",
    "command.help": "Usage instructions",
    "command.language": "Choose language",
    "language.usage": "Usage: /language en or /language vi",
    "language.invalid": "Supported languages: English (en) and Vietnamese (vi).",
    "language.updated": "Language preference saved: English.",
    "webhook.privateOnly": "For security, purchases and key access work only in a private chat.\n{link}",
    "webhook.openPrivate": "Open a private chat with the bot to continue.",
    "webhook.privateLink": "Open private chat: {url}",
    "webhook.draftConnected": "The bot connected successfully. Finish the remaining steps in the admin page to open your shop.",
    "webhook.callbackPrivate": "Please open a private chat with the bot",
    "webhook.callbackError": "Unable to process this right now",
  },
  "vi-VN": {
    "button.menu": "Menu",
    "button.cart": "Giỏ hàng",
    "button.checkout": "Thanh toán",
    "button.addProduct": "Thêm {product}",
    "button.viewCart": "Xem giỏ hàng",
    "button.order": "Đơn {order}",
    "button.paymentLink": "Lấy link thanh toán",
    "button.refreshPayment": "Làm mới thanh toán",
    "button.orderStatus": "Trạng thái đơn",
    "button.viewKey": "Xem key",
    "button.viewOrder": "Xem đơn",
    "cart.empty": "Giỏ hàng đang trống.",
    "cart.heading": "Giỏ hàng {shop}",
    "cart.line": "{index}. {product} - {variant} x{quantity}: {total}",
    "cart.subtotal": "Tạm tính: {total}",
    "cart.discount": "Mã giảm giá: {code}",
    "catalog.empty": "{shop} chưa có sản phẩm đang bán.",
    "catalog.heading": "Sản phẩm của {shop}",
    "catalog.line": "{index}. {product} - {variant}: {price}",
    "orders.empty": "Bạn chưa có đơn hàng.",
    "orders.line": "{order}: {total} - {payment} / {status}",
    "order.heading": "Đơn {order}",
    "order.total": "Tổng: {total}",
    "order.payment": "Thanh toán: {status}",
    "order.status": "Trạng thái: {status}",
    "order.fulfillment": "Giao hàng: {status}",
    "payment.link": "Link thanh toán: {url}",
    "payment.expires": "Hết hạn: {timestamp}",
    "payment.webhookOnly": "Chỉ webhook PayOS hợp lệ mới xác nhận thanh toán.",
    "key.heading": "Key của đơn {order}",
    "key.line": "{index}. {product} - {variant}\n{value}",
    "menu.welcome": "Chào mừng đến {shop}.",
    "menu.help": "Dùng /products để xem sản phẩm, /cart để xem giỏ, /orders để xem đơn, /keys để xem key đã mua và /language để chọn ngôn ngữ.",
    "menu.privateOnly": "Chỉ giao dịch trong chat riêng với bot.",
    "menu.prompt": "Chọn menu hoặc gõ /help để xem hướng dẫn.",
    "keys.empty": "Bạn chưa có đơn đã giao key.",
    "error.cart_empty": "Giỏ hàng đang trống.",
    "error.catalog_changed": "Sản phẩm đã thay đổi. Vui lòng xem lại danh sách.",
    "error.discount_invalid": "Mã giảm giá không hợp lệ hoặc đã hết hạn.",
    "error.inventory_unavailable": "Sản phẩm vừa hết hàng. Vui lòng thử sản phẩm khác.",
    "error.order_not_found": "Không tìm thấy đơn hàng của bạn.",
    "error.order_not_fulfilled": "Đơn hàng chưa sẵn sàng giao key.",
    "error.payment_not_configured": "Cửa hàng chưa cấu hình thanh toán.",
    "error.payment_not_available": "Đơn hàng không còn khả dụng để thanh toán.",
    "error.payment_currency_unsupported": "Phương thức thanh toán này không hỗ trợ đơn vị tiền của đơn hàng.",
    "error.provider_unavailable": "Dịch vụ đang bận. Vui lòng thử lại sau.",
    "error.quantity_unavailable": "Số lượng không khả dụng.",
    "error.generic": "Không thể xử lý yêu cầu. Vui lòng thử lại.",
    "status.order.pending_payment": "Đang chờ thanh toán",
    "status.order.processing": "Đang xử lý",
    "status.order.completed": "Đã hoàn tất",
    "status.order.canceled": "Đã hủy",
    "status.order.expired": "Đã hết hạn",
    "status.order.exception": "Cần kiểm tra",
    "status.payment.unpaid": "Chưa thanh toán",
    "status.payment.pending": "Đang xác minh",
    "status.payment.paid": "Đã thanh toán",
    "status.payment.partial": "Thanh toán thiếu",
    "status.payment.overpaid": "Thanh toán thừa",
    "status.payment.failed": "Thanh toán thất bại",
    "status.payment.expired": "Đã hết hạn",
    "status.payment.refunded": "Đã hoàn tiền",
    "status.fulfillment.unfulfilled": "Chưa giao",
    "status.fulfillment.reserved": "Đã giữ hàng",
    "status.fulfillment.fulfilled": "Đã giao",
    "status.fulfillment.failed": "Giao hàng thất bại",
    "status.fulfillment.manual_review": "Cần xử lý thủ công",
    "status.unknown": "Không xác định",
    "notification.orderPaidReady": "Đơn {order} đã thanh toán và sẵn sàng giao. Chọn Xem key để nhận key trong chat riêng này.",
    "command.start": "Mở menu cửa hàng",
    "command.products": "Xem sản phẩm",
    "command.cart": "Xem giỏ hàng",
    "command.discount": "Áp dụng mã giảm giá",
    "command.orders": "Xem đơn hàng",
    "command.keys": "Xem key đã mua",
    "command.help": "Hướng dẫn sử dụng",
    "command.language": "Chọn ngôn ngữ",
    "language.usage": "Cú pháp: /language en hoặc /language vi",
    "language.invalid": "Ngôn ngữ hỗ trợ: English (en) và Tiếng Việt (vi).",
    "language.updated": "Đã lưu lựa chọn ngôn ngữ: Tiếng Việt.",
    "webhook.privateOnly": "Vì lý do bảo mật, mua hàng và xem key chỉ hoạt động trong chat riêng.\n{link}",
    "webhook.openPrivate": "Mở chat riêng với bot để tiếp tục.",
    "webhook.privateLink": "Mở chat riêng: {url}",
    "webhook.draftConnected": "Bot đã kết nối thành công. Hoàn tất các bước còn lại trong trang quản trị để mở cửa hàng.",
    "webhook.callbackPrivate": "Hãy mở chat riêng với bot",
    "webhook.callbackError": "Không thể xử lý lúc này",
  },
};

export type TelegramLocalePreferences = {
  explicitPreference?: unknown;
  identityPreference?: unknown;
  requestLanguage?: unknown;
  shopDefaultLocale?: unknown;
};

export function resolveTelegramLocale(input: TelegramLocalePreferences): SupportedLocale {
  return resolveLocale({
    acceptLanguage: typeof input.requestLanguage === "string" ? input.requestLanguage : null,
    cookie: input.identityPreference,
    explicit: input.explicitPreference,
    fallback: input.shopDefaultLocale,
  });
}

export function telegramText(locale: string, key: string, params?: Readonly<Record<string, string | number>>): string {
  return createTranslator(TELEGRAM_CATALOG, locale)(key, params);
}

export function formatTelegramMoney(amountMinor: number, currency: string, locale: string): string {
  return formatMoney(amountMinor, currency, locale);
}

export function formatTelegramTimestamp(timestamp: unknown, locale: string): string | null {
  if (typeof timestamp !== "string" || timestamp.trim().length === 0) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const resolved = resolveTelegramLocale({ explicitPreference: locale });
    return new Intl.DateTimeFormat(resolved, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(date);
  } catch {
    return null;
  }
}

export function telegramStatus(locale: string, kind: "order" | "payment" | "fulfillment", value: string): string {
  const key = `status.${kind}.${value}`;
  // Keep status labels on the same BCP47 normalization path as all other
  // Telegram copy so regional/script variants cannot silently switch to English.
  const resolvedLocale = resolveTelegramLocale({ explicitPreference: locale });
  const catalog = TELEGRAM_CATALOG[resolvedLocale];
  return Object.hasOwn(catalog, key) ? telegramText(resolvedLocale, key) : telegramText(resolvedLocale, "status.unknown");
}

export function telegramCommands(locale: string): Array<{ command: string; description: string }> {
  const resolved = resolveTelegramLocale({ explicitPreference: locale });
  return [
    { command: "start", description: telegramText(resolved, "command.start") },
    { command: "products", description: telegramText(resolved, "command.products") },
    { command: "cart", description: telegramText(resolved, "command.cart") },
    { command: "discount", description: telegramText(resolved, "command.discount") },
    { command: "orders", description: telegramText(resolved, "command.orders") },
    { command: "keys", description: telegramText(resolved, "command.keys") },
    { command: "language", description: telegramText(resolved, "command.language") },
    { command: "help", description: telegramText(resolved, "command.help") },
  ];
}

export function telegramPaidOrderNotification(locale: string, orderNumber: string, orderPublicId: string) {
  const resolved = resolveTelegramLocale({ explicitPreference: locale });
  return {
    keyboard: [
      [{ callback_data: `key:${orderPublicId}`, text: telegramText(resolved, "button.viewKey") }],
      [{ callback_data: `ord:${orderPublicId}`, text: telegramText(resolved, "button.viewOrder") }],
    ],
    text: telegramText(resolved, "notification.orderPaidReady", { order: orderNumber }),
  };
}
