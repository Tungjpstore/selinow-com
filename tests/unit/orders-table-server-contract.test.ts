import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("orders table server-side contract", () => {
  it("drives the ledger through the DataTable with server-side URL params", async () => {
    const [page, service] = await Promise.all([
      readFile("src/pages/app/orders.astro", "utf8"),
      readFile("src/lib/commerce/seller-orders.ts", "utf8"),
    ]);

    // URL contract parsed by the page, never forwarded raw to parsePublicApiPage.
    expect(page).toContain('import DataTable from "../../components/workspace/DataTable.astro"');
    expect(page).toContain('searchParams.get("page")');
    expect(page).toContain('searchParams.get("pageSize")');
    expect(page).toContain('searchParams.get("status")');
    expect(page).toContain('parseSellerOrderSort(searchParams.get("sort"))');
    expect(page).toContain("listSellerOrdersPage({ env, page: requestedPage, pageSize: requestedPageSize");

    // Offset branch is the page-mode fetch; keyset branch stays cursor-only.
    expect(service).toContain("if (input.page === undefined)");
    const keysetBranch = service.split("// Search/sort require correctness")[0] ?? "";
    expect(keysetBranch).not.toContain("OFFSET");
    expect(service).toContain("LIMIT ? OFFSET ?");

    // Client-side row filtering is gone; the table is server-rendered.
    expect(page).not.toContain("data-order-filter");
    expect(page).not.toContain("applyFilters");
    expect(page).not.toContain(".sln-button {");
    expect(page).not.toContain(".sln-button-secondary {");
    expect(page).toContain("data-order-ledger");
    expect(page).toContain('data-record-template={t("dashboard.orders.record_count"');

    // CSV export serializes only the already-fetched page rows client-side.
    expect(page).toContain("data-order-export");
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
