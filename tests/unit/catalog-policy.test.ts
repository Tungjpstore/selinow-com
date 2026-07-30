import { describe, expect, it } from "vitest";

import { parseProductWithInitialVariantInput, parseVariantInput } from "../../src/lib/catalog/http";
import { normalizeCurrency, parseInventoryKeys } from "../../src/lib/catalog/policy";

describe("catalog currency policy", () => {
  it.each(["USD", "EUR", "JPY", "VND"])("normalizes the supported %s currency", (currency) => {
    expect(normalizeCurrency(` ${currency.toLowerCase()} `, "VND")).toBe(currency);
  });

  it("normalizes the fallback and rejects currencies outside the platform allowlist", () => {
    expect(normalizeCurrency(undefined, " eur ")).toBe("EUR");
    expect(() => normalizeCurrency("GBP", "VND"))
      .toThrow(expect.objectContaining({ issues: ["currency_invalid"] }));
    expect(() => normalizeCurrency(undefined, "GBP"))
      .toThrow(expect.objectContaining({ issues: ["currency_invalid"] }));
  });
});

describe("inventory import policy", () => {
  it("normalizes paste and first-column CSV values", () => {
    expect(parseInventoryKeys(" key-a \n\nkey-b\r\n", "paste")).toEqual(["key-a", "key-b"]);
    expect(parseInventoryKeys("key-a,note\nkey-b,other", "csv")).toEqual(["key-a", "key-b"]);
  });

  it("rejects duplicate keys with a generic non-echoing error", () => {
    const plaintext = "DO-NOT-ECHO-ME";
    let caught: unknown;
    try {
      parseInventoryKeys(`${plaintext}\n${plaintext}`, "paste");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "inventory_duplicate", status: 409 });
    expect(JSON.stringify(caught)).not.toContain(plaintext);
  });
});

describe("atomic catalog create input", () => {
  it("leaves an omitted currency for the tenant-scoped service default", () => {
    expect(parseVariantInput({
      priceMinor: 1_000,
      sku: "safe-sku",
      title: "Standard",
    }).currency).toBeUndefined();
  });

  it("normalizes the product and nested initial variant together", () => {
    expect(parseProductWithInitialVariantInput({
      categoryId: null,
      description: " Safe ",
      fulfillmentType: "manual",
      initialVariant: {
        currency: "VND",
        maxPerOrder: 3,
        minPerOrder: 1,
        options: { duration: "lifetime" },
        priceMinor: 199000,
        sku: " safe-sku ",
        status: "active",
        title: " Standard ",
      },
      slug: "safe-product",
      status: "active",
      title: " Safe product ",
    }, "VND")).toMatchObject({
      product: { description: "Safe", slug: "safe-product", title: "Safe product" },
      variant: { optionsJson: '{"duration":"lifetime"}', sku: "SAFE-SKU", title: "Standard" },
    });
  });

  it("requires a nested variant and rejects unknown product fields", () => {
    expect(() => parseProductWithInitialVariantInput({ slug: "safe-product", title: "Safe product" }, "VND"))
      .toThrow(expect.objectContaining({ issues: ["initial_variant_required"] }));
    expect(() => parseProductWithInitialVariantInput({
      initialVariant: {},
      internalShopId: "shop-secret",
      slug: "safe-product",
      title: "Safe product",
    }, "VND")).toThrow(expect.objectContaining({ code: "validation_failed" }));
  });
});
