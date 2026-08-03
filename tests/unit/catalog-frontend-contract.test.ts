import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("seller catalog frontend contract", () => {
  it("creates a product and its initial variant atomically with CSRF and idempotency", async () => {
    const [page, client, route, store] = await Promise.all([
      readFile("src/pages/app/products.astro", "utf8"),
      readFile("src/scripts/dashboard/products.ts", "utf8"),
      readFile("src/pages/api/app/shops/[shopPublicId]/products/index.ts", "utf8"),
      readFile("src/lib/catalog/store.ts", "utf8"),
    ]);

    expect(page).toContain('t("dashboard.products.dialog.product_create.description")');
    expect(client).toContain("initialVariant:");
    expect(client).toContain('"Idempotency-Key": idempotencyKey');
    expect(client).toContain('"X-CSRF-Token": decodeURIComponent(csrf)');
    expect(client).not.toContain("/products/${productId}/variants");
    expect(route).toContain("createProductWithInitialVariant");
    expect(route).toContain('request.headers.get("Idempotency-Key")');
    expect(store).toContain("PLATFORM_DB.batch");
    expect(store).toContain("catalog.product_with_variant.created");
  });

  it("adds variants through the existing tenant-scoped endpoint", async () => {
    const [page, client] = await Promise.all([
      readFile("src/pages/app/products.astro", "utf8"),
      readFile("src/scripts/dashboard/products.ts", "utf8"),
    ]);

    expect(page).toContain("data-new-variant");
    expect(page).toContain('name="newVariantSku"');
    expect(page).toContain('name="newVariantPriceMajor"');
    expect(page).toContain("data-default-currency={shop.currency}");
    expect(client).toContain("/products/${editorProductId}/variants");
    expect(client).toContain('"POST", nextVariant');
    expect(client).toContain("currency: editorDefaultCurrency");
    expect(client).toContain("parseMajorAmountToMinor");
    expect(page).toContain("formatMinorAmountForInput");
    expect(page).toContain("currencyInputStep");
    expect(client).not.toContain('currency: "VND"');
    expect(client).not.toContain('dataset.defaultCurrency ?? "VND"');
    expect(client).toContain("normalizeCurrencyCode(dialog?.dataset.defaultCurrency)");
    expect(client).toContain("normalizeCurrencyCode(editor?.dataset.defaultCurrency)");
    expect(client).toContain("defaultCurrency !== null");
    expect(client).toContain("editorDefaultCurrency !== null");
    expect(client).toContain("currency: editorDefaultCurrency");
    expect(client).not.toContain('fields.get("currency") ?? editorDefaultCurrency');
    expect(page).toContain('t("dashboard.products.filter.out_of_stock")');
    expect(page).toContain('data-product-stock={stock === 0 ? "out_of_stock" : "available"}');
    expect(client).toContain('status === "out_of_stock" ? row.dataset.productStock === "out_of_stock"');
  });

  it("preserves server-owned variant options when saving existing variants", async () => {
    const [page, client] = await Promise.all([
      readFile("src/pages/app/products.astro", "utf8"),
      readFile("src/scripts/dashboard/products.ts", "utf8"),
    ]);

    expect(page).toContain('name="optionsJson"');
    expect(page).toContain('value={String(variant.optionsJson ?? "{}")}');
    expect(client).toContain('options: parseOptions(fields.get("optionsJson"))');
    expect(client).not.toContain("options: {},\n            priceMinor");
  });

  it("updates categories through PUT and requires an explicit archive confirmation", async () => {
    const [page, client] = await Promise.all([
      readFile("src/pages/app/products.astro", "utf8"),
      readFile("src/scripts/dashboard/products.ts", "utf8"),
    ]);

    expect(page).toContain("data-category-manager");
    expect(page).toContain("data-save-category");
    expect(page).toContain("data-confirm-category-archive");
    expect(page).toContain("data-confirm-product-archive");
    expect(page).toContain('aria-expanded="false"');
    expect(page).toContain('disabled={category.status === "archived"}');
    expect(page).toContain('disabled={selectedProduct.status === "archived"}');
    expect(page).toContain('category.status === "archived" && <option value="archived" selected>');
    expect(page).toContain('selectedProduct.status === "archived" && <option value="archived" selected>');
    expect(page).toContain('t("dashboard.products.dialog.variants.field.price", { currency: shop.currency })');
    expect(client).toContain("/categories/${categoryId}");
    expect(client).toContain('method: "PUT"');
    expect(client).toContain('statusOverride ?? value("status")');
    expect(client).toContain("const initialButtonStates = new Map");
    expect(client).toContain("button.disabled = initialButtonStates.get(button) ?? false");
    expect(client).toContain("busy || archiveInitiallyDisabled");
    expect(client).toContain("productArchivePanel.hidden = false");
    expect(client).toContain('requestArchive.setAttribute("aria-expanded", "false")');
    expect(client).toContain('saveProduct("archived")');
  });

  it("renders the PromptOS updated column from the product projection", async () => {
    const [page, store] = await Promise.all([
      readFile("src/pages/app/products.astro", "utf8"),
      readFile("src/lib/catalog/store.ts", "utf8"),
    ]);

    expect(store).toContain("category_id AS categoryId, slug, title, description, status, fulfillment_type AS fulfillmentType, version, created_at AS createdAt, updated_at AS updatedAt FROM products");
    expect(page).toContain('t("dashboard.products.table.updated")');
    expect(page).toContain('const projectedUpdatedAt = typeof product.updatedAt === "string" ? product.updatedAt : ""');
    expect(page).toContain('const updatedAt = projectedUpdatedAt !== "" && !Number.isNaN(updatedDate.getTime()) ? projectedUpdatedAt : ""');
    expect(page).toContain('<time datetime={updatedAt}>{updatedLabel}</time>');
    expect(page).toContain('t("dashboard.products.updated.record")');
  });

  it("keeps inline channel visibility tenant-scoped, versioned, and fail-closed", async () => {
    const [page, client, route] = await Promise.all([
      readFile("src/pages/app/products.astro", "utf8"),
      readFile("src/scripts/dashboard/products.ts", "utf8"),
      readFile("src/pages/api/app/shops/[shopPublicId]/catalog/visibility.ts", "utf8"),
    ]);

    expect(page).toContain("data-channel-visibility-panel");
    expect(page).toContain("data-visibility-toggle");
    expect(page).toContain("data-channel-visibility-retry");
    expect(page).toContain('data-version="0"');
    expect(client).toContain("/catalog/visibility");
    expect(client).toContain('method: "PUT"');
    expect(client).toContain('"Idempotency-Key": idempotencyKey');
    expect(client).toContain('"X-CSRF-Token": decodeURIComponent(csrf)');
    expect(client).toContain("const refreshed = await loadVisibility();");
    expect(client).toContain("button.disabled = !visibilityReady;");
    expect(client).toContain("visibilityRetry?.addEventListener");
    expect(route).toContain("requireCsrfSession");
    expect(route).toContain("requireRecentAuth");
    expect(route).toContain("expectedVersion");
    expect(route).toContain('request.headers.get("Idempotency-Key")');
  });
});
