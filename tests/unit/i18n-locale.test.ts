import { describe, expect, it } from "vitest";

import { normalizeLocale } from "../../src/lib/commerce/policy";
import {
  DEFAULT_LOCALE,
  canonicalizeLocale,
  directionForLocale,
  matchSupportedLocale,
  parseAcceptLanguage,
  resolveLocale,
  resolveLocaleWithSource,
  resolveRequestLocaleHint,
} from "../../src/lib/i18n/locale";
import { normalizeStorefrontLocale } from "../../src/lib/storefront/routing";

describe("locale core", () => {
  it("validates and canonicalizes BCP47 tags", () => {
    expect(canonicalizeLocale(" VI-vn ")).toBe("vi-VN");
    expect(canonicalizeLocale("en-us-u-ca-gregory")).toBe("en-US-u-ca-gregory");
    expect(canonicalizeLocale("vi_VN")).toBeNull();
    expect(canonicalizeLocale("not a locale")).toBeNull();
    expect(canonicalizeLocale(null)).toBeNull();
  });

  it("maps supported language variants to en and vi-VN only", () => {
    expect(matchSupportedLocale("en")).toBe("en");
    expect(matchSupportedLocale("en-GB")).toBe("en");
    expect(matchSupportedLocale("vi")).toBe("vi-VN");
    expect(matchSupportedLocale("vi-VN-u-nu-latn")).toBe("vi-VN");
    expect(matchSupportedLocale("fr-FR")).toBeNull();
  });

  it("derives document direction from canonical primary language tags", () => {
    expect(directionForLocale("en")).toBe("ltr");
    expect(directionForLocale("en-US")).toBe("ltr");
    expect(directionForLocale("vi")).toBe("ltr");
    expect(directionForLocale("vi-VN")).toBe("ltr");
    expect(directionForLocale("ar-SA")).toBe("rtl");
    expect(directionForLocale("he-IL")).toBe("rtl");
    expect(directionForLocale("fa-AF")).toBe("rtl");
    expect(directionForLocale("ur-PK")).toBe("rtl");
    expect(directionForLocale("not a locale")).toBe("ltr");
    expect(directionForLocale(null)).toBe("ltr");
  });

  it("honors Accept-Language quality and excludes malformed or refused ranges", () => {
    expect(parseAcceptLanguage("fr-FR, vi;q=0.8, en-US;q=0.9, de;q=0")).toEqual([
      "fr-FR",
      "en-US",
      "vi",
    ]);
    expect(parseAcceptLanguage("vi;q=bogus, en;q=0.7")).toEqual(["en"]);
  });

  it("resolves explicit, cookie, geo, browser, configured fallback, then English", () => {
    expect(resolveLocaleWithSource({
      acceptLanguage: "en-US",
      cookie: "vi",
      explicit: "en-GB",
      fallback: "vi",
    })).toEqual({ locale: "en", source: "explicit" });
    expect(resolveLocaleWithSource({ acceptLanguage: "en-US", cookie: "vi", fallback: "en" }))
      .toEqual({ locale: "vi-VN", source: "cookie" });
    expect(resolveLocaleWithSource({ acceptLanguage: "fr-FR, vi;q=0.8", fallback: "en" }))
      .toEqual({ locale: "vi-VN", source: "accept-language" });
    expect(resolveLocaleWithSource({ acceptLanguage: "fr-FR", fallback: "vi" }))
      .toEqual({ locale: "vi-VN", source: "fallback" });
    expect(resolveLocaleWithSource({ explicit: "zz", fallback: "also-invalid" }))
      .toEqual({ locale: DEFAULT_LOCALE, source: "default" });
  });

  it("applies geo detection after explicit choice and cookie, before Accept-Language", () => {
    expect(resolveLocaleWithSource({ acceptLanguage: "en-US", explicit: "en", geoCountry: "VN" }))
      .toEqual({ locale: "en", source: "explicit" });
    expect(resolveLocaleWithSource({ acceptLanguage: "en-US", cookie: "en", geoCountry: "VN" }))
      .toEqual({ locale: "en", source: "cookie" });
    expect(resolveLocaleWithSource({ acceptLanguage: "en-US", geoCountry: "vn" }))
      .toEqual({ locale: "vi-VN", source: "geo" });
    expect(resolveLocaleWithSource({ acceptLanguage: "en-US", fallback: "en", geoCountry: "JP" }))
      .toEqual({ locale: "en", source: "accept-language" });
    expect(resolveLocaleWithSource({ geoCountry: "NOT-A-COUNTRY" }))
      .toEqual({ locale: DEFAULT_LOCALE, source: "default" });
    expect(resolveLocaleWithSource({ geoCountry: 84 }))
      .toEqual({ locale: DEFAULT_LOCALE, source: "default" });
  });

  it("normalizes storefront header hints and commerce API input through one allowlist", () => {
    expect(normalizeStorefrontLocale("fr-FR, vi;q=0.9", "en")).toBe("vi-VN");
    expect(normalizeStorefrontLocale("fr-FR", "invalid")).toBe("en");
    expect(normalizeLocale("en-US", "vi")).toBe("en");
    expect(normalizeLocale(undefined, "vi")).toBe("vi-VN");
    expect(() => normalizeLocale("fr-FR", "vi")).toThrow(expect.objectContaining({
      code: "validation_failed",
      issues: ["locale_invalid"],
      status: 400,
    }));
  });

  it("uses English as the stable default when no input is available", () => {
    expect(resolveLocale()).toBe("en");
  });

  it("leaves tenant fallback unresolved when no supported request hint exists", () => {
    expect(resolveRequestLocaleHint()).toBeUndefined();
    expect(resolveRequestLocaleHint({ acceptLanguage: "fr-FR" })).toBeUndefined();
    expect(resolveRequestLocaleHint({ acceptLanguage: "vi-VN" })).toBe("vi-VN");
    expect(resolveRequestLocaleHint({ explicit: "en-US", acceptLanguage: "vi" })).toBe("en");
  });
});
