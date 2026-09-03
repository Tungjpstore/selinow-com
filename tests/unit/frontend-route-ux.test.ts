import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { MIN_STOREFRONT_CONTRAST, validateStorefrontContrast } from "../../src/scripts/dashboard/store-builder-contrast";

describe("bounded frontend route UX", () => {
  it("uses server-consistent ink selection to block sub-AA storefront colors", () => {
    const valid = validateStorefrontContrast("#5B5CEB", "#F6C344");
    const invalid = validateStorefrontContrast("#777777", "#F6C344");

    expect(valid.valid).toBe(true);
    expect(invalid.valid).toBe(false);
    expect(invalid.brand.ratio).toBeLessThan(MIN_STOREFRONT_CONTRAST);
  });

  it("exposes an explicit mobile settings and preview view switch", async () => {
    const [page, client] = await Promise.all([
      readFile("src/pages/app/store.astro", "utf8"),
      readFile("src/scripts/dashboard/store-builder.ts", "utf8"),
    ]);

    expect(page).toContain('data-builder-view-tab="settings"');
    expect(page).toContain('data-builder-view-tab="preview"');
    expect(page).toContain('.builder[data-mobile-view="settings"] .preview-pane');
    expect(client).toContain('setMobileView("settings")');
    expect(client).toContain('setState("invalid_contrast")');
  });

  it("renders customer search no-results and omits fake order datetimes", async () => {
    const page = await readFile("src/pages/app/customers.astro", "utf8");

    expect(page).toContain("data-customer-no-results");
    expect(page).toContain("customer.lastOrderAt === null");
    expect(page).not.toContain("customer.lastOrderAt ?? customer.createdAt");
  });

  it("keeps booking mutations behind the fulfillment role boundary", async () => {
    const [page, client] = await Promise.all([
      readFile("src/pages/app/bookings.astro", "utf8"),
      readFile("src/scripts/dashboard/bookings.ts", "utf8"),
    ]);

    expect(page).toContain('data-can-manage={shop.role === "owner" || shop.role === "manager" ? "true" : "false"}');
    expect(client).toContain('const canManage = panel.dataset.canManage === "true";');
    expect(client).toContain("if (canManage) {");
  });

  it("does not turn catalog read failures into empty seller workspaces", async () => {
    const [products, inventory] = await Promise.all([
      readFile("src/pages/app/products.astro", "utf8"),
      readFile("src/pages/app/inventory.astro", "utf8"),
    ]);

    expect(products).toContain("let catalogLoadFailed = false;");
    expect(products).toContain('t("dashboard.products.unavailable.title")');
    expect(inventory).toContain("let catalogLoadFailed = false;");
    expect(inventory).toContain('t("dashboard.inventory.unavailable.title")');
  });

  it("makes the seller overview an honest today cockpit", async () => {
    const page = await readFile("src/pages/app/index.astro", "utf8");

    expect(page).toContain('aria-labelledby="console-cockpit-title"');
    expect(page).toContain('t("dashboard.overview.cockpit.title")');
    expect(page).toContain('ordersState === "unavailable"');
    expect(page).toContain('catalogState === "unavailable"');
    expect(page).toContain('readinessState === "unavailable"');
    expect(page).toContain("actionItems.sort");
    expect(page).toContain('t("dashboard.overview.cockpit.unavailable_value")');
    expect(page).toContain("prefers-reduced-motion: reduce");
  });

  it("uses the tenant-safe catalog projection in the store builder preview", async () => {
    const [page, preview, card] = await Promise.all([
      readFile("src/pages/app/store.astro", "utf8"),
      readFile("src/lib/storefront/preview.ts", "utf8"),
      readFile("src/components/storefront/StorefrontPreviewCard.astro", "utf8"),
    ]);

    expect(page).toContain("getSellerStorefrontPreviewCatalog");
    expect(page).toContain('t("dashboard.store_builder.preview.catalog_empty.title")');
    expect(page).toContain('t("dashboard.store_builder.preview.catalog_empty.description")');
    expect(page).not.toContain("Featured product");
    expect(page).not.toContain("Sản phẩm đầu tiên của bạn");
    expect(preview).toContain('capability: "shop:read"');
    expect(preview).toContain("products.status = 'active'");
    expect(preview).not.toContain("optionsJson");
    expect(preview).not.toContain("encrypted_payload");
    expect(card).not.toContain("data-cart-add");
    expect(card).not.toContain('href={`/products/${product.slug}`}');
  });

  it("keeps the store-builder preview on semantic color tokens", async () => {
    const [page, card, tokens] = await Promise.all([
      readFile("src/pages/app/store.astro", "utf8"),
      readFile("src/components/storefront/StorefrontPreviewCard.astro", "utf8"),
      readFile("src/styles/selinow-tokens.css", "utf8"),
    ]);
    const rawColor = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu;

    expect(page, "store builder must consume semantic preview tokens").not.toMatch(rawColor);
    expect(card, "preview cards must consume semantic preview tokens").not.toMatch(rawColor);
    for (const token of [
      "--sln-preview-canvas",
      "--sln-preview-surface",
      "--sln-preview-border-subtle",
      "--sln-preview-text-primary",
      "--sln-preview-stock-success",
      "--sln-preview-stock-warning",
      "--sln-preview-stock-danger",
    ]) expect(tokens).toContain(`${token}:`);
    expect(page).toContain("--preview-canvas: var(--sln-preview-canvas)");
    expect(card).toContain("var(--preview-border-subtle, var(--sln-preview-border-subtle))");
  });
});
