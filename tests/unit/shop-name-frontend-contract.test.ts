import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("seller shop-name frontend contract", () => {
  it("exposes the existing tenant-scoped rename mutation only to owner and manager roles", async () => {
    const [controller, route, store] = await Promise.all([
      readFile("src/scripts/dashboard/onboarding.ts", "utf8"),
      readFile("src/pages/api/app/shops/[shopPublicId].ts", "utf8"),
      readFile("src/lib/tenants/store.ts", "utf8"),
    ]);

    expect(controller).toContain('shop.role === "owner" || shop.role === "manager"');
    expect(controller).toContain('shop.role !== "owner" && shop.role !== "manager"');
    expect(controller).toContain('{ body: payload, method: "PATCH" }');
    expect(controller).toContain("option.textContent = `${optionShop.name} — ${optionShop.slug}`");
    expect(controller).toContain("selectionIsCurrent(state, shop.publicId, selectionEpoch)");
    expect(controller).toContain("if (!isShop(updated))");
    expect(route).toContain("requireCsrfSession(request, env)");
    expect(route).toContain("normalizeShopName(body.name)");
    expect(store).toContain('billingMarketOnly ? "billing:manage" : "shop:update"');
    expect(store).toContain("'shop.updated'");
  });
});
