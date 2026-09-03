import { describe, expect, it } from "vitest";

import { shopSwitchHref, withSelectedShop } from "../../src/lib/dashboard/shop-navigation";
import { selectShopForMember, type ShopView } from "../../src/lib/tenants/store";

const shop = (publicId: string): ShopView => ({
  businessCountry: null,
  currency: "VND",
  defaultLocale: "vi",
  featureFlags: {},
  limits: {},
  merchantCountry: null,
  name: publicId,
  planCode: "starter",
  publicId,
  role: "owner",
  slug: publicId,
  status: "active",
  subscriptionState: "active",
  timezone: "Asia/Ho_Chi_Minh",
  vertical: "digital",
});

describe("member shop selection", () => {
  const shops = [shop("shop_a"), shop("shop_b")];

  it("uses the first authorized shop when the URL has no selection", () => {
    expect(selectShopForMember(shops, null)?.publicId).toBe("shop_a");
  });

  it("selects an explicitly requested member shop", () => {
    expect(selectShopForMember(shops, "shop_b")?.publicId).toBe("shop_b");
  });

  it("falls back to the first authorized shop when the requested ID is stale or unauthorized", () => {
    expect(selectShopForMember(shops, "shop_other_tenant")?.publicId).toBe("shop_a");
  });

  it("does not invent a selection when the membership projection is empty", () => {
    expect(selectShopForMember([], "shop_other_tenant")).toBeUndefined();
  });
});

describe("selected shop workspace links", () => {
  const origin = "https://app.selinow.test";

  it("adds the selected shop while preserving query parameters and fragments", () => {
    expect(withSelectedShop("/app/products?product=prd_1#editor", "shop_b", origin))
      .toBe("/app/products?product=prd_1&shop=shop_b#editor");
    expect(withSelectedShop("/onboarding#readiness", "shop_b", origin))
      .toBe("/onboarding?shop=shop_b#readiness");
  });

  it("preserves explicit shop selections and ignores external or public links", () => {
    expect(withSelectedShop("/app/orders?shop=shop_a", "shop_b", origin)).toBe("/app/orders?shop=shop_a");
    expect(withSelectedShop("https://example.test/app/orders", "shop_b", origin)).toBe("https://example.test/app/orders");
    expect(withSelectedShop("/pricing", "shop_b", origin)).toBe("/pricing");
  });

  it("drops tenant-bound entity state when switching shops", () => {
    expect(shopSwitchHref(new URL("https://app.selinow.test/app/products?shop=shop_a&product=prd_a#editor"), "shop_b"))
      .toBe("/app/products?shop=shop_b");
    expect(shopSwitchHref(new URL("https://app.selinow.test/app/orders/order_a?shop=shop_a#payment"), "shop_b"))
      .toBe("/app/orders?shop=shop_b");
    expect(shopSwitchHref(new URL("https://app.selinow.test/onboarding?shop=shop_a&step=payos#readiness"), "shop_b"))
      .toBe("/onboarding?shop=shop_b");
  });
});
