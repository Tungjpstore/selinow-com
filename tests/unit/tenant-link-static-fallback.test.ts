import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("seller tenant links without JavaScript", () => {
  it("binds high-risk seller actions to the server-selected shop during SSR", async () => {
    const [overview, catalog, data, store, billing, customers, integrations, inventory, members, orders, orderDetail, onboarding] = await Promise.all([
      readFile("src/pages/app/index.astro", "utf8"),
      readFile("src/pages/app/products.astro", "utf8"),
      readFile("src/pages/app/data.astro", "utf8"),
      readFile("src/pages/app/store.astro", "utf8"),
      readFile("src/pages/app/billing.astro", "utf8"),
      readFile("src/pages/app/customers.astro", "utf8"),
      readFile("src/pages/app/integrations.astro", "utf8"),
      readFile("src/pages/app/inventory.astro", "utf8"),
      readFile("src/pages/app/members.astro", "utf8"),
      readFile("src/pages/app/orders.astro", "utf8"),
      readFile("src/pages/app/orders/[id].astro", "utf8"),
      readFile("src/scripts/dashboard/onboarding.ts", "utf8"),
    ]);

    for (const page of [overview, catalog, data, store, billing, customers, integrations, inventory, members, orders]) {
      expect(page).toContain('import { withSelectedShop } from "../../lib/dashboard/shop-navigation";');
      expect(page).toContain("const workspaceHref = (href: string): string => withSelectedShop(href, shop?.publicId, Astro.url.origin);");
    }
    expect(orderDetail).toContain('import { withSelectedShop } from "../../../lib/dashboard/shop-navigation";');
    expect(orderDetail).toContain("const workspaceHref = (href: string): string => withSelectedShop(href, shop?.publicId, Astro.url.origin);");

    expect(overview).toContain('href={workspaceHref("/onboarding")}');
    expect(overview).toContain('href={workspaceHref("/app/orders")}');
    expect(overview).toContain('href={workspaceHref(`/app/orders/${order.orderId}`)}');
    expect(overview).toContain('href={workspaceHref("/app/products")}');
    expect(catalog).toContain('href={workspaceHref(`/app/products?product=${encodeURIComponent(productId)}`)}');
    expect(data).toContain('href={workspaceHref("/app")}');
    expect(data).toContain('actionHref={workspaceHref("/app/data")}');
    expect(store).toContain('href={previewHost ?? workspaceHref("/onboarding")}');
    expect(store).toContain('href={workspaceHref("/onboarding")}');
    expect(store).toContain('actionHref={workspaceHref(settingsError === "authorization_denied" ? "/app" : "/onboarding")}');
    expect(billing).toContain('actionHref={workspaceHref("/app/billing")}');
    expect(customers).toContain('href={workspaceHref("/app/orders")}');
    expect(customers).toContain('actionHref={workspaceHref("/app/products")}');
    expect(integrations).toContain('href={workspaceHref("/app/domains")}');
    expect(inventory).toContain('actionHref={workspaceHref("/app/products")}');
    expect(members).toContain('actionHref={workspaceHref("/app/members")}');
    expect(orders).toContain('href={workspaceHref("/app/integrations")}');
    expect(orders).toContain('href={workspaceHref(`/app/orders/${order.orderId}`)}');
    expect(orderDetail).toContain('href={workspaceHref("/app/orders")}');
    expect(onboarding).toContain('domainManagementLink.href = shop === null');
    expect(onboarding).toContain('`/app/domains?shop=${encodeURIComponent(shop.publicId)}`');
  });
});
