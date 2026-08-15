import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("products table server-side contract", () => {
  it("drives the product ledger through the DataTable with server-side URL params", async () => {
    const [page, store] = await Promise.all([
      readFile("src/pages/app/products.astro", "utf8"),
      readFile("src/lib/catalog/store.ts", "utf8"),
    ]);

    // URL contract parsed by the page, never forwarded raw to parsePublicApiPage.
    expect(page).toContain('import DataTable from "../../components/workspace/DataTable.astro"');
    expect(page).toContain('searchParams.get("page")');
    expect(page).toContain('searchParams.get("pageSize")');
    expect(page).toContain('parseSellerProductSort(searchParams.get("sort"))');
    expect(page).toContain('parseSellerProductStatusFilter(searchParams.get("status"))');
    expect(page).toContain("listSellerProductsPage({ env, page: requestedLedgerPage, pageSize: requestedLedgerPageSize");

    // Offset branch is the ledger fetch; the full catalog load stays untouched.
    expect(store).toContain("export async function listSellerProductsPage");
    expect(store).toContain("LIMIT ? OFFSET ?");
    expect(store).toContain("products.shop_id = ?");
    expect(store).toContain("category_id AS categoryId, slug, title, description, status, fulfillment_type AS fulfillmentType, delivery_mode AS deliveryMode, version, created_at AS createdAt, updated_at AS updatedAt FROM products");

    // Low-stock uses the real shop threshold, never a hardcoded 5.
    expect(page).toContain("lowStockThreshold");
    expect(page).not.toContain("< 5");

    // CSV export serializes only the already-fetched page rows client-side.
    expect(page).toContain("data-product-ledger");
    expect(page).toContain("data-product-export");
    expect(page).toContain('t("dashboard.table.export")');
    expect(page).toContain("buildCsv");
    expect(page).toContain("downloadCsv");
    expect(page).toContain('import { buildCsv, downloadCsv } from "../../lib/dashboard/csv-export"');

    // Pagination exposes prev/next plus a page-size selector.
    expect(page).toContain('t("dashboard.table.previous")');
    expect(page).toContain('t("dashboard.table.next")');
    expect(page).toContain('t("dashboard.table.page_info"');
    expect(page).toContain("data-page-size-select");
    expect(page).toContain('name="pageSize"');
  });
});
