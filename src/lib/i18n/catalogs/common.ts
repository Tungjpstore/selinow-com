import type { TranslationCatalogs } from "../catalog";

/** Shared labels used by adapters while feature-specific catalogs evolve. */
export const commonCatalogs = {
  en: {
    "common.cancel": "Cancel",
    "common.continue": "Continue",
    "common.retry": "Try again",
    "common.unavailable": "Temporarily unavailable",
    "commerce.cart.empty": "Your cart is empty.",
    "commerce.checkout.changed": "The cart changed. Review the latest quote and try again.",
  },
  "vi-VN": {
    "common.cancel": "Hủy",
    "common.continue": "Tiếp tục",
    "common.retry": "Thử lại",
    "common.unavailable": "Tạm thời không khả dụng",
    "commerce.cart.empty": "Giỏ hàng đang trống.",
    "commerce.checkout.changed": "Giỏ hàng đã thay đổi. Hãy xem lại báo giá mới nhất rồi thử lại.",
  },
} as const satisfies TranslationCatalogs;
