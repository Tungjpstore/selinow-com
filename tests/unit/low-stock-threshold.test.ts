import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("low-stock threshold write path", () => {
  it("validates and persists the shop threshold without any new migration", async () => {
    const [lib, route, page] = await Promise.all([
      readFile("src/lib/tenants/storefront-settings.ts", "utf8"),
      readFile("src/pages/api/app/shops/[shopPublicId]/settings/low-stock-threshold.ts", "utf8"),
      readFile("src/pages/app/inventory.astro", "utf8"),
    ]);

    // Lib: bounded validation + optimistic version guard on the existing column.
    expect(lib).toContain("export const LOW_STOCK_THRESHOLD_MAX = 1000");
    expect(lib).toContain("export async function updateShopLowStockThreshold");
    expect(lib).toContain("input.threshold < 0 || input.threshold > LOW_STOCK_THRESHOLD_MAX");
    expect(lib).toContain("capability: \"shop:update\"");
    expect(lib).toContain("UPDATE shop_settings SET low_stock_threshold = ?, version = version + 1");
    expect(lib).toContain("settings_version_stale");

    // Route: CSRF session + recent auth + Idempotency-Key + unknown-field rejection.
    expect(route).toContain("requireCsrfSession(request, env)");
    expect(route).toContain("requireRecentAuth(auth)");
    expect(route).toContain('request.headers.get("Idempotency-Key")');
    expect(route).toContain("idempotency_key_required");
    expect(route).toContain('rejectUnknownFields(body, ["expectedVersion", "threshold"])');
    expect(route).toContain("PRIVATE_RESPONSE_HEADERS");

    // UI: inline editor wired to the new endpoint, never a hardcoded threshold.
    expect(page).toContain("data-threshold-editor");
    expect(page).toContain("data-threshold-input");
    expect(page).toContain("data-threshold-save");
    expect(page).toContain("data-threshold-feedback");
    expect(page).toContain("settings/low-stock-threshold");
    expect(page).toContain('t("dashboard.inventory.threshold.edit_label")');
    expect(page).toContain('t("dashboard.inventory.threshold.save")');
    // Contract hooks preserved.
    expect(page).toContain("const thresholdOf =");
    expect(page).toContain("stock <= thresholdOf(variant)");

    // No new migration for the threshold write path: the column already
    // exists in migration 0002. Pins the expected chain tip.
    const migrations = await readdir("migrations");
    const latest = migrations.filter((name) => name.endsWith(".sql")).sort().at(-1);
    expect(latest).toBe("0121_payos_disconnect_projection_repair.sql");
  });
});
