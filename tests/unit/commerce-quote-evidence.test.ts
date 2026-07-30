import { describe, expect, it } from "vitest";

import { createQuoteEvidence, verifyQuoteEvidence } from "../../src/lib/commerce/quote-evidence";

const secret = "quote-evidence-test-secret";
const expected = [{ quantity: 1, unitPriceMinor: 1_000, variantId: "var-a", variantVersion: 3 }];
const expectedItem = expected[0] as (typeof expected)[number];

describe("commerce quote evidence", () => {
  it("binds the cart, shop, expected prices and expiry to a signed token", async () => {
    const evidence = await createQuoteEvidence({
      cartId: "cart-a",
      expected,
      expiresAt: "2026-07-29T00:05:00.000Z",
      issuedAt: "2026-07-29T00:00:00.000Z",
      secret,
      shopId: "shop-a",
    });

    await expect(verifyQuoteEvidence({
      cartId: "cart-a",
      evidence,
      expected: [...expected].reverse(),
      now: new Date("2026-07-29T00:04:59.999Z"),
      secret,
      shopId: "shop-a",
    })).resolves.toBeUndefined();
    await expect(verifyQuoteEvidence({
      cartId: "cart-other",
      evidence,
      expected,
      now: new Date("2026-07-29T00:04:00.000Z"),
      secret,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
    await expect(verifyQuoteEvidence({
      cartId: "cart-a",
      evidence,
      expected,
      now: new Date("2026-07-29T00:04:00.000Z"),
      secret,
      shopId: "shop-other",
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
    await expect(verifyQuoteEvidence({
      cartId: "cart-a",
      evidence,
      expected: [{ ...expectedItem, unitPriceMinor: 1_001 }],
      now: new Date("2026-07-29T00:04:00.000Z"),
      secret,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
    await expect(verifyQuoteEvidence({
      cartId: "cart-a",
      evidence,
      expected: [{ ...expectedItem, variantVersion: expectedItem.variantVersion + 1 }],
      now: new Date("2026-07-29T00:04:00.000Z"),
      secret,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
    await expect(verifyQuoteEvidence({
      cartId: "cart-a",
      evidence,
      expected: [{ ...expectedItem, quantity: 2 }],
      now: new Date("2026-07-29T00:04:00.000Z"),
      secret,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
  });

  it("rejects tampering and expiry even when the catalog evidence is unchanged", async () => {
    const evidence = await createQuoteEvidence({
      cartId: "cart-a",
      expected,
      expiresAt: "2026-07-29T00:05:00.000Z",
      issuedAt: "2026-07-29T00:00:00.000Z",
      secret,
      shopId: "shop-a",
    });
    const [claims, signature] = evidence.split(".");
    if (claims === undefined || signature === undefined) throw new Error("evidence_shape_invalid");
    const tampered = `${claims}.${signature.slice(0, -1)}${signature.endsWith("a") ? "b" : "a"}`;

    await expect(verifyQuoteEvidence({
      cartId: "cart-a",
      evidence: tampered,
      expected,
      now: new Date("2026-07-29T00:04:00.000Z"),
      secret,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
    await expect(verifyQuoteEvidence({
      cartId: "cart-a",
      evidence,
      expected,
      now: new Date("2026-07-29T00:05:00.000Z"),
      secret,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "quote_expired", status: 409 });
  });

  it("binds discount state for newly issued website quotes", async () => {
    const evidence = await createQuoteEvidence({
      cartId: "cart-a",
      expected,
      expiresAt: "2026-07-29T00:05:00.000Z",
      issuedAt: "2026-07-29T00:00:00.000Z",
      pricing: { discountCode: "WELCOME10", discountMinor: 100, totalMinor: 900 },
      secret,
      shopId: "shop-a",
    });
    await expect(verifyQuoteEvidence({
      cartId: "cart-a",
      evidence,
      expected,
      now: new Date("2026-07-29T00:04:00.000Z"),
      pricing: { discountCode: "WELCOME10", discountMinor: 100, totalMinor: 900 },
      secret,
      shopId: "shop-a",
    })).resolves.toBeUndefined();
    await expect(verifyQuoteEvidence({
      cartId: "cart-a",
      evidence,
      expected,
      now: new Date("2026-07-29T00:04:00.000Z"),
      pricing: { discountCode: "FLASH20", discountMinor: 200, totalMinor: 800 },
      secret,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
  });

  it("binds the product version used to project the displayed catalog line", async () => {
    const catalog = [{ ...expectedItem, productVersion: 7 }];
    const catalogItem = catalog[0];
    if (catalogItem === undefined) throw new Error("catalog_item_missing");
    const evidence = await createQuoteEvidence({
      catalog,
      cartId: "cart-a",
      expected,
      expiresAt: "2026-07-29T00:05:00.000Z",
      issuedAt: "2026-07-29T00:00:00.000Z",
      secret,
      shopId: "shop-a",
    });

    await expect(verifyQuoteEvidence({
      catalog,
      cartId: "cart-a",
      evidence,
      expected,
      now: new Date("2026-07-29T00:04:00.000Z"),
      requireCatalog: true,
      secret,
      shopId: "shop-a",
    })).resolves.toBeUndefined();
    await expect(verifyQuoteEvidence({
      catalog: [{ ...catalogItem, productVersion: 8 }],
      cartId: "cart-a",
      evidence,
      expected,
      now: new Date("2026-07-29T00:04:00.000Z"),
      requireCatalog: true,
      secret,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
  });

  it("rejects future-issued and excessively long-lived evidence", async () => {
    const now = new Date("2026-07-29T00:00:00.000Z");
    const futureIssued = await createQuoteEvidence({
      cartId: "cart-a",
      expected,
      expiresAt: "2026-07-29T00:06:00.000Z",
      issuedAt: "2026-07-29T00:02:00.000Z",
      secret,
      shopId: "shop-a",
    });
    await expect(verifyQuoteEvidence({
      cartId: "cart-a",
      evidence: futureIssued,
      expected,
      now,
      secret,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });

    const overlong = await createQuoteEvidence({
      cartId: "cart-a",
      expected,
      expiresAt: "2026-07-29T00:05:00.001Z",
      issuedAt: "2026-07-29T00:00:00.000Z",
      secret,
      shopId: "shop-a",
    });
    await expect(verifyQuoteEvidence({
      cartId: "cart-a",
      evidence: overlong,
      expected,
      now,
      secret,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
  });

  it("caps evidence expiry at the cart expiry and enforces that cap", async () => {
    const evidence = await createQuoteEvidence({
      cartId: "cart-a",
      cartExpiresAt: "2026-07-29T00:02:00.000Z",
      expected,
      expiresAt: "2026-07-29T00:05:00.000Z",
      issuedAt: "2026-07-29T00:00:00.000Z",
      secret,
      shopId: "shop-a",
    });

    await expect(verifyQuoteEvidence({
      cartId: "cart-a",
      cartExpiresAt: "2026-07-29T00:02:00.000Z",
      evidence,
      expected,
      now: new Date("2026-07-29T00:01:59.999Z"),
      secret,
      shopId: "shop-a",
    })).resolves.toBeUndefined();
    await expect(verifyQuoteEvidence({
      cartId: "cart-a",
      cartExpiresAt: "2026-07-29T00:01:59.000Z",
      evidence,
      expected,
      now: new Date("2026-07-29T00:01:00.000Z"),
      secret,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
    await expect(verifyQuoteEvidence({
      cartId: "cart-a",
      cartExpiresAt: "2026-07-29T00:02:00.000Z",
      evidence,
      expected,
      now: new Date("2026-07-29T00:02:00.000Z"),
      secret,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "quote_expired", status: 409 });
  });
});
