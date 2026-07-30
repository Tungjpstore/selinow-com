import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getCatalogParity } from "../../src/lib/i18n/catalog";
import { createDashboardTranslator, dashboardCatalogs } from "../../src/lib/i18n/catalogs/dashboard";
import { createStorefrontTranslator, storefrontCatalogs } from "../../src/lib/i18n/catalogs/storefront";

describe("private downloadable fulfillment UI", () => {
  it("uses the existing tenant-scoped seller upload and policy routes without rendering sensitive storage metadata", async () => {
    const [page, script] = await Promise.all([
      readFile("src/pages/app/products.astro", "utf8"),
      readFile("src/scripts/dashboard/products.ts", "utf8"),
    ]);

    expect(page).toContain("data-private-file-controls");
    expect(page).toContain("data-private-file-input");
    expect(page).toContain("data-upload-private-file");
    expect(page).toContain("data-save-private-file-policy");
    expect(page).toContain('hidden={selectedProduct.fulfillmentType !== "manual"}');
    expect(script).toContain("/assets/private-files");
    expect(script).toContain('body: file');
    expect(script).toContain('"X-CSRF-Token": decodeURIComponent(csrf)');
    expect(script).toContain('"X-File-Name": filename');
    expect(script).toContain("/private-file-policy");
    expect(script).toContain("assetVersionId: privateAssetVersionId");
    expect(`${page}\n${script}`).not.toMatch(/objectKey|contentSha256|tokenHash|buyerBindingHash/u);
    expect(script).not.toContain("console.");
  });

  it("keeps delivery grants out of URLs and browser storage while streaming the response into a local download", async () => {
    const [page, script] = await Promise.all([
      readFile("src/pages/orders/[orderPublicId].astro", "utf8"),
      readFile("src/scripts/storefront/order.ts", "utf8"),
    ]);

    expect(page).toContain('id="download-section"');
    expect(page).toContain('id="download-retry"');
    expect(script).toContain("/downloads/${encodeURIComponent(download.assetVersionId)}/grant");
    expect(script).toContain('"Idempotency-Key": downloadIntentKey(download)');
    expect(script).toContain('"X-Order-Item-Id": download.orderItemId');
    expect(script).toContain("/downloads/grants/${encodeURIComponent(grant.grantId)}/consume");
    expect(script).toContain('"X-Delivery-Grant-Token": grant.grantToken');
    expect(script).toContain("URL.createObjectURL(blob)");
    expect(script).toContain("anchor.download = download.filename");
    expect(script).toContain("showDownloadLoadError()");
    expect(script).toContain("private-download:${crypto.randomUUID()}");
    expect(script).not.toMatch(/sessionStorage\.setItem\([^\n]*(?:grantToken|grant\.grantToken)/u);
    expect(script).not.toMatch(/[?&](?:grantToken|orderToken)=/u);
    expect(script).not.toContain("localStorage");
    expect(script).not.toContain("console.");
  });

  it("projects only safe, tenant-bound private download state into seller order items", async () => {
    const [store, page] = await Promise.all([
      readFile("src/lib/commerce/seller-orders.ts", "utf8"),
      readFile("src/pages/app/orders/[id].astro", "utf8"),
    ]);

    expect(store).toContain("FROM sqlite_master");
    expect(store).toContain("requirements.shop_id = ?");
    expect(store).toContain("requirements.order_id = ?");
    expect(store).toContain("requirements.capability = 'private_file'");
    expect(store).toContain("filename_sanitized AS filename");
    expect(store).toContain("remainingDownloads");
    expect(store).not.toMatch(/object_key|token_hash|buyer_binding_hash|content_sha256/u);
    expect(page).toContain("item.privateDownload.filename");
    expect(page).toContain('t("dashboard.order_detail.private_download.remaining"');
  });

  it("keeps the seller and buyer private-download copy in English/Vietnamese parity", () => {
    expect(getCatalogParity(dashboardCatalogs)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
    expect(getCatalogParity(storefrontCatalogs)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
    expect(createDashboardTranslator("en")("dashboard.products.dialog.private_file.title")).toBe("Private downloadable file");
    expect(createDashboardTranslator("vi-VN")("dashboard.products.dialog.private_file.title")).toBe("Tệp tải xuống riêng tư");
    expect(createStorefrontTranslator("en")("storefront.order.downloads.title")).toBe("Secure downloads");
    expect(createStorefrontTranslator("vi-VN")("storefront.order.downloads.title")).toBe("Tệp tải xuống bảo mật");
  });
});
