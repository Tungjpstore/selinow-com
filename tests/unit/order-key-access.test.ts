import { describe, expect, it } from "vitest";

import { getOrderKeys } from "../../src/lib/commerce/store";
import { hmacToken } from "../../src/lib/core/crypto";
import { encryptInventoryKey } from "../../src/lib/crypto/inventory";
import type { AppBindings } from "../../src/lib/platform/bindings";
import type { StorefrontShop } from "../../src/lib/storefront/store";
import { FALLBACK_STOREFRONT_TEMPLATE } from "../../src/lib/storefront/templates";

const shop: StorefrontShop = {
  access: "live",
  canonicalHostname: "signal.localhost",
  content: { announcement: null, deliveryText: "Giao sau xác minh", description: "", footerText: "", headline: "", seoDescription: "", seoTitle: "", showExactStock: false, supportText: "", templateId: null },
  currency: "VND",
  currentHostname: "signal.localhost",
  defaultLocale: "vi",
  id: "shp_11111111-1111-4111-8111-111111111111",
  lowStockThreshold: 5,
  name: "Signal",
  orderExpiryMinutes: 30,
  publicId: "shop_11111111-1111-4111-8111-111111111111",
  publicDetails: {
    deliveryText: "Giao sau xác minh",
    privacyUrl: null,
    refundPolicyUrl: null,
    support: { href: null, label: "Liên hệ cửa hàng" },
    termsUrl: null,
  },
  settingsVersion: 1,
  slug: "signal",
  status: "active",
  subscriptionState: "active",
  timezone: "Asia/Ho_Chi_Minh",
  template: FALLBACK_STOREFRONT_TEMPLATE,
  theme: { accent: "#E9A62F", accentInk: "#102824", brand: "#176B5B", brandInk: "#FFF9EA", logoUrl: null },
};

const identifierSecret = "identifier-secret-for-order-tests";
const inventorySecret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function fakeEnvironment(orderToken: string): Promise<{ env: AppBindings; keyQueries: () => number }> {
  const orderTokenHash = await hmacToken(identifierSecret, "order-access", orderToken);
  const encrypted = await encryptInventoryKey({ hmacSecret: identifierSecret, keyVersion: "v1", kek: inventorySecret, plaintext: "SIGNAL-KEY-ONLY", shopId: shop.id, variantId: "var_11111111-1111-4111-8111-111111111111" });
  let keyQueryCount = 0;
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            all() {
              if (!sql.includes("INNER JOIN inventory_keys")) return Promise.resolve({ results: [] });
              keyQueryCount += 1;
              expect(values).toEqual(["ord_internal_signal", shop.id]);
              return Promise.resolve({ results: [{ ciphertextB64: encrypted.ciphertextB64, ivB64: encrypted.ivB64, keyVersion: encrypted.keyVersion, productTitle: "Signal Editor", variantId: "var_11111111-1111-4111-8111-111111111111", variantTitle: "Lifetime" }] });
            },
            first() {
              if (!sql.includes("FROM orders")) return Promise.resolve(null);
              return Promise.resolve(values[0] === "order_11111111-1111-4111-8111-111111111111" && values[1] === shop.id
                ? { fulfillmentStatus: "fulfilled", id: "ord_internal_signal", orderTokenHash, paymentStatus: "paid", sourceChannel: "web", status: "completed" }
                : null);
            },
          };
        },
      };
    },
  };
  return {
    env: { IDENTIFIER_HMAC_SECRET: identifierSecret, INVENTORY_KEK_V1: inventorySecret, PLATFORM_DB: database } as unknown as AppBindings,
    keyQueries: () => keyQueryCount,
  };
}

describe("website order key reveal", () => {
  it("reveals only sold keys joined to the authorized paid web order", async () => {
    const orderToken = "valid-private-order-token-123456";
    const { env, keyQueries } = await fakeEnvironment(orderToken);
    await expect(getOrderKeys({ env, orderPublicId: "order_11111111-1111-4111-8111-111111111111", orderToken, shop })).resolves.toEqual({
      keys: [{ productTitle: "Signal Editor", value: "SIGNAL-KEY-ONLY", variantTitle: "Lifetime" }],
      orderId: "order_11111111-1111-4111-8111-111111111111",
    });
    expect(keyQueries()).toBe(1);
  });

  it("returns the same not-found boundary for an invalid token before reading keys", async () => {
    const { env, keyQueries } = await fakeEnvironment("valid-private-order-token-123456");
    await expect(getOrderKeys({ env, orderPublicId: "order_11111111-1111-4111-8111-111111111111", orderToken: "wrong-private-order-token-123456", shop })).rejects.toMatchObject({ code: "order_not_found", status: 404 });
    expect(keyQueries()).toBe(0);
  });
});
