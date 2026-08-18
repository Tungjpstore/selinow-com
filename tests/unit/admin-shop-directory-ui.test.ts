import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getCatalogParity } from "../../src/lib/i18n/catalog";
import { adminCatalogs, createAdminTranslator } from "../../src/lib/i18n/catalogs/admin";

describe("admin Sellers & Shops PromptOS surface", () => {
  it("promotes the directory into protected admin navigation", async () => {
    const shell = await readFile("src/layouts/AdminLayout.astro", "utf8");
    expect(shell).toContain('t("admin.layout.nav.shops")');
    expect(shell).toContain('path: "/admin/shops"');
    expect(adminCatalogs.en["admin.layout.nav.detail.directory"]).toBe("Safe read-only directory");
    expect(adminCatalogs["vi-VN"]["admin.layout.nav.detail.directory"]).toBe("Danh bạ chỉ đọc an toàn");
  });

  it("localizes the shared admin brand, navigation, and topbar shell", async () => {
    const shell = await readFile("src/layouts/AdminLayout.astro", "utf8");
    const english = createAdminTranslator("en");
    const vietnamese = createAdminTranslator("vi-VN");

    expect(shell).toContain('aria-label={t("admin.layout.brand_aria")}');
    expect(shell).toContain('{t("admin.layout.brand_label")}');
    expect(shell).toContain('aria-label={t("admin.layout.nav_aria")}');
    expect(shell).toContain('{t("admin.layout.topbar_scope")}');
    expect(shell).not.toContain('aria-label="Selinow Admin Operations"');
    expect(shell).not.toContain("<span>Admin</span>");
    expect(shell).not.toContain('aria-label="Platform operations"');
    expect(shell).not.toContain("<small>Platform operations</small>");

    expect(english("admin.layout.brand_aria")).toBe("Selinow admin operations");
    expect(english("admin.layout.brand_label")).toBe("Admin");
    expect(vietnamese("admin.layout.brand_aria")).toBe("Vận hành quản trị Selinow");
    expect(vietnamese("admin.layout.brand_label")).toBe("Quản trị");
    expect(getCatalogParity(adminCatalogs)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
  });

  it("uses the safe server projection and truthful read-only states", async () => {
    const [page, service, css] = await Promise.all([
      readFile("src/pages/admin/shops.astro", "utf8"),
      readFile("src/lib/operations/admin-shop-directory.ts", "utf8"),
      readFile("src/styles/admin.css", "utf8"),
    ]);

    expect(page).toContain('import AdminLayout from "../../layouts/AdminLayout.astro"');
    expect(page).toContain("listAdminShopDirectory");
    expect(page).toContain('method="get"');
    expect(page).toContain('t("admin.shops.pagination.cursor")');
    expect(page).toContain("admin.shops.detail.readonly");
    expect(page).toContain("authorization_denied");
    expect(page).toContain("validation_failed");
    expect(page).not.toMatch(/name="(?:email|contact|token|credential|key|shopId)"/iu);
    expect(page).not.toContain("data-action-kind");

    expect(service).toContain("getPlatformAdminRole");
    expect(service).toContain("LIMIT ?");
    expect(service).toContain("limit + 1");
    expect(service).toContain("shops.public_id LIKE ? ESCAPE");
    expect(service).not.toMatch(/FROM\s+(?:platform_users|shop_credentials|inventory_keys|payment_events)/iu);
    expect(service).not.toMatch(/external_account_id|display_name_sanitized|safe_evidence_json/iu);

    expect(css).toContain(".admin-directory-filters");
    expect(css).toContain(".admin-pagination");
    expect(css).toContain("@media (max-width: 520px)");
  });

  it("covers the pending_payment subscription state in filter, labels, and catalogs", async () => {
    const [page, service] = await Promise.all([
      readFile("src/pages/admin/shops.astro", "utf8"),
      readFile("src/lib/operations/admin-shop-directory.ts", "utf8"),
    ]);

    // Regression: the filter enum, label map, select option and i18n keys
    // all omitted pending_payment, causing 400 filters and 500 renders.
    expect(service).toContain('"pending_payment"');
    expect(page).toContain('pending_payment: { label: t("admin.shops.subscription.pending_payment"), tone: "warning" }');
    expect(page).toContain('<option value="pending_payment" selected={subscriptionValue === "pending_payment"}>');
    expect(adminCatalogs.en["admin.shops.subscription.pending_payment"]).toBe("Payment pending");
    expect(adminCatalogs["vi-VN"]["admin.shops.subscription.pending_payment"]).toBe("Chờ thanh toán");
  });

  it("exposes a GET-only private API boundary", async () => {
    const route = await readFile("src/pages/api/admin/shops/index.ts", "utf8");
    expect(route).toContain("export const GET");
    expect(route).not.toContain("export const POST");
    expect(route).toContain("authenticateRequest");
    expect(route).toContain("listAdminShopDirectory");
    expect(route).toContain('"Cache-Control": "private, no-store, max-age=0"');
    expect(route).toContain("parseAdminShopStatus");
    expect(route).toContain("parseAdminSubscriptionState");
  });
});
