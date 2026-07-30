import { describe, expect, it } from "vitest";

import { createTranslator, getCatalogParity, type TranslationCatalogs } from "../../src/lib/i18n/catalog";
import { commonCatalogs } from "../../src/lib/i18n/catalogs/common";
import { stockLabel } from "../../src/lib/storefront/view";

describe("translation catalogs", () => {
  it("keeps the shipped English and Vietnamese catalogs in key parity", () => {
    expect(getCatalogParity(commonCatalogs)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
  });

  it("reports missing and extra locale keys against English", () => {
    const catalogs = {
      en: { "cart.count": "{count} items", "cart.empty": "Empty" },
      "vi-VN": { "cart.count": "{count} sản phẩm", "cart.legacy": "Cũ" },
    } satisfies TranslationCatalogs;

    expect(getCatalogParity(catalogs)).toEqual({
      extra: { en: [], "vi-VN": ["cart.legacy"] },
      missing: { en: [], "vi-VN": ["cart.empty"] },
    });
  });

  it("falls back to English for missing Vietnamese keys and interpolates values", () => {
    const catalogs = {
      en: { "cart.count": "{count} items", "cart.empty": "Your cart is empty." },
      "vi-VN": { "cart.count": "{count} sản phẩm" },
    } satisfies TranslationCatalogs;
    const translate = createTranslator(catalogs, "vi");

    expect(translate("cart.count", { count: 3 })).toBe("3 sản phẩm");
    expect(translate("cart.empty")).toBe("Your cart is empty.");
    expect(translate("cart.unknown")).toBe("");
    expect(createTranslator(catalogs, "vi", { missingTranslation: "Unavailable" })("cart.unknown")).toBe("Unavailable");
  });

  it("falls back to English when the requested locale is unsupported", () => {
    const translate = createTranslator(commonCatalogs, "fr-FR");
    expect(translate("common.continue")).toBe("Continue");
  });

  it("uses English for storefront stock labels when no locale is supplied", () => {
    expect(stockLabel("available")).toBe("Ready for delivery");
    expect(stockLabel("low_stock", undefined, "vi-VN")).toBe("Sắp hết hàng");
  });
});
