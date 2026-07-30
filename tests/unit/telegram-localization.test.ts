import { describe, expect, it } from "vitest";

import { getCatalogParity } from "../../src/lib/i18n/catalog";
import {
  formatTelegramMoney,
  formatTelegramTimestamp,
  resolveTelegramLocale,
  telegramCommands,
  telegramPaidOrderNotification,
  telegramStatus,
  telegramText,
  TELEGRAM_CATALOG,
} from "../../src/lib/telegram/localization";

describe("Telegram localization", () => {
  it("resolves preferences in buyer, identity, request, shop, English order", () => {
    expect(resolveTelegramLocale({ explicitPreference: "en-US", identityPreference: "vi", requestLanguage: "vi", shopDefaultLocale: "vi" })).toBe("en");
    expect(resolveTelegramLocale({ explicitPreference: "fr-FR", identityPreference: "vi", requestLanguage: "en-US", shopDefaultLocale: "en" })).toBe("vi-VN");
    expect(resolveTelegramLocale({ identityPreference: "fr-FR", requestLanguage: "vi-VN", shopDefaultLocale: "en" })).toBe("vi-VN");
    expect(resolveTelegramLocale({ requestLanguage: "fr-FR", shopDefaultLocale: "vi" })).toBe("vi-VN");
    expect(resolveTelegramLocale({ requestLanguage: "fr-FR", shopDefaultLocale: "de-DE" })).toBe("en");
    expect(resolveTelegramLocale({ explicitPreference: "vi-VN", identityPreference: "en", requestLanguage: "en", shopDefaultLocale: "en" })).toBe("vi-VN");
    expect(resolveTelegramLocale({ identityPreference: "vi-VN", requestLanguage: "en", shopDefaultLocale: "en" })).toBe("vi-VN");
    expect(resolveTelegramLocale({ requestLanguage: "vi", shopDefaultLocale: "en" })).toBe("vi-VN");
    expect(resolveTelegramLocale({ requestLanguage: "fr-FR", shopDefaultLocale: "vi" })).toBe("vi-VN");
    expect(resolveTelegramLocale({ requestLanguage: "fr-FR", shopDefaultLocale: "fr-FR" })).toBe("en");
  });

  it("formats minor-unit amounts with the resolved locale and currency metadata", () => {
    expect(formatTelegramMoney(12_345, "USD", "en")).toBe("$123.45");
    expect(formatTelegramMoney(12_345, "VND", "vi-VN")).toBe("12.345 ₫");
    expect(formatTelegramMoney(12_345, "JPY", "en")).toBe("¥12,345");
    expect(formatTelegramMoney(12_345, "EUR", "vi-VN")).toBe("123,45 €");
  });

  it("formats payment expiry timestamps with the resolved locale and a deterministic timezone", () => {
    const timestamp = "2026-07-29T02:00:00.000Z";
    expect(formatTelegramTimestamp(timestamp, "en-US")).toBe(new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(timestamp)));
    expect(formatTelegramTimestamp(timestamp, "vi")).toBe(new Intl.DateTimeFormat("vi-VN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(timestamp)));
    expect(formatTelegramTimestamp("not-a-timestamp", "en")).toBeNull();
    expect(formatTelegramTimestamp(null, "vi")).toBeNull();
  });

  it("keeps English and Vietnamese catalogs in parity with safe fallbacks", () => {
    expect(getCatalogParity(TELEGRAM_CATALOG)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
    expect(telegramText("fr-FR", "cart.empty")).toBe("Your cart is empty.");
    expect(telegramStatus("fr-FR", "payment", "future_state")).toBe("Unknown");
    expect(telegramStatus("vi-VN-u-nu-latn", "payment", "paid")).toBe("Đã thanh toán");
  });

  it("publishes English default commands and full Vietnamese command labels", () => {
    expect(telegramCommands("en")[0]).toEqual({ command: "start", description: "Open the shop menu" });
    expect(telegramCommands("vi-VN")[0]).toEqual({ command: "start", description: "Mở menu cửa hàng" });
  });

  it("renders paid notifications from the persisted recipient locale", () => {
    expect(telegramPaidOrderNotification("en", "ORDER-1", "order-1")).toEqual({
      keyboard: [
        [{ callback_data: "key:order-1", text: "View key" }],
        [{ callback_data: "ord:order-1", text: "View order" }],
      ],
      text: "Order ORDER-1 is paid and ready for delivery. Select View key to receive it in this private chat.",
    });
    expect(telegramPaidOrderNotification("vi", "ORDER-1", "order-1").text).toContain("Đơn ORDER-1 đã thanh toán");
  });
});
