import { describe, expect, it } from "vitest";

import {
  CURRENCY_METADATA,
  currencyInputStep,
  formatMinorAmountForInput,
  formatMoney,
  getCurrencyMetadata,
  isSupportedCurrency,
  minorUnitFor,
  normalizeCurrencyCode,
  parseMajorAmountToMinor,
} from "../../src/lib/i18n/currency";

describe("provider-neutral currency metadata", () => {
  it("declares ISO numeric codes and minor units for supported currencies", () => {
    expect(CURRENCY_METADATA).toEqual({
      EUR: { code: "EUR", minorUnit: 2, numericCode: "978" },
      JPY: { code: "JPY", minorUnit: 0, numericCode: "392" },
      USD: { code: "USD", minorUnit: 2, numericCode: "840" },
      VND: { code: "VND", minorUnit: 0, numericCode: "704" },
    });
    expect(minorUnitFor("USD")).toBe(2);
    expect(minorUnitFor("JPY")).toBe(0);
  });

  it("normalizes supported codes without treating unknown codes as supported", () => {
    expect(normalizeCurrencyCode(" usd ")).toBe("USD");
    expect(isSupportedCurrency("EUR")).toBe(true);
    expect(isSupportedCurrency("GBP")).toBe(false);
    expect(() => getCurrencyMetadata("GBP")).toThrow("unsupported_currency");
  });

  it("converts seller major-unit input without floating-point rounding", () => {
    expect(parseMajorAmountToMinor("12.34", "USD")).toBe(1_234);
    expect(parseMajorAmountToMinor(".5", "EUR")).toBe(50);
    expect(parseMajorAmountToMinor("1234", "JPY")).toBe(1_234);
    expect(parseMajorAmountToMinor("199000", "VND")).toBe(199_000);
    expect(parseMajorAmountToMinor("12.345", "USD")).toBeNull();
    expect(parseMajorAmountToMinor("1.00", "JPY")).toBeNull();
    expect(parseMajorAmountToMinor("1e3", "USD")).toBeNull();
  });

  it("derives input values and steps from ISO minor-unit metadata", () => {
    expect(currencyInputStep("USD")).toBe("0.01");
    expect(currencyInputStep("JPY")).toBe("1");
    expect(formatMinorAmountForInput(1_234, "USD")).toBe("12.34");
    expect(formatMinorAmountForInput(1_234, "JPY")).toBe("1234");
  });
});

describe("minor-unit money formatting", () => {
  it.each([
    ["USD", "en-US", "$1,234.56"],
    ["EUR", "vi-VN", "1.234,56\u00a0€"],
    ["JPY", "en-US", "¥123,456"],
    ["VND", "vi-VN", "123.456\u00a0₫"],
  ])("formats %s using its ISO minor unit in %s", (currency, locale, expected) => {
    expect(formatMoney(123_456, currency, locale)).toBe(expected);
  });

  it("falls back to English for an unsupported locale", () => {
    expect(formatMoney(12_345, "USD", "fr-FR")).toBe("$123.45");
    expect(formatMoney(12_345, "USD", "zz-ZZ")).toBe("$123.45");
    expect(formatMoney(12_345, "USD", "not a locale")).toBe("$123.45");
  });

  it("accepts the repository's short Vietnamese locale", () => {
    expect(formatMoney(123_456, "VND", "vi")).toBe("123.456\u00a0₫");
  });

  it("does not apply an exchange rate between currencies", () => {
    expect(formatMoney(12_345, "USD", "en-US")).toBe("$123.45");
    expect(formatMoney(12_345, "EUR", "en-US")).toBe("€123.45");
    expect(formatMoney(12_345, "JPY", "en-US")).toBe("¥12,345");
  });

  it("rejects non-integer minor amounts", () => {
    expect(() => formatMoney(1.5, "USD")).toThrow("minor_amount_invalid");
  });
});
