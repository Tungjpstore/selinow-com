import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getCatalogParity } from "../../src/lib/i18n/catalog";
import {
  createDashboardTranslator,
  dashboardCatalogs,
} from "../../src/lib/i18n/catalogs/dashboard";
import { createSystemTranslator } from "../../src/lib/i18n/catalogs/system";

describe("dashboard shell and shared state localization", () => {
  it("keeps English and Vietnamese dashboard catalogs in exact key parity", () => {
    expect(getCatalogParity(dashboardCatalogs)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
  });

  it("uses English as the safe fallback and interpolates localized shell metadata", () => {
    expect(createDashboardTranslator(undefined)("dashboard.nav.overview")).toBe("Overview");
    expect(createDashboardTranslator("fr-FR")("dashboard.state.loading.title")).toBe("Loading data…");
    expect(createDashboardTranslator("vi")("dashboard.nav.overview")).toBe("Tổng quan");
    expect(createDashboardTranslator("vi-VN")("dashboard.shell.current_shop_role", { role: "Chủ shop" }))
      .toBe("Cửa hàng hiện tại · Chủ shop");
  });

  it("keeps commerce dashboard copy on the same English-fallback catalog", () => {
    expect(createDashboardTranslator(undefined)("dashboard.orders.title")).toBe("Orders");
    expect(createDashboardTranslator("fr-FR")("dashboard.customers.title")).toBe("Customers");
    expect(createDashboardTranslator("vi")("dashboard.billing.title")).toBe("Gói dịch vụ");
    expect(createDashboardTranslator("en")("dashboard.order_detail.order_title", { number: "S-1042" }))
      .toBe("Order S-1042");
  });

  it("keeps the selected dashboard locale ahead of the shop default for order status badges", async () => {
    const source = await readFile("src/pages/app/index.astro", "utf8");

    expect(source).toContain("<PaymentState locale={locale ?? shop.defaultLocale}");
    expect(source).toContain("<FulfillmentState locale={locale ?? shop.defaultLocale}");
    expect(source).not.toContain("<PaymentState locale={shop.defaultLocale}");
    expect(source).not.toContain("<FulfillmentState locale={shop.defaultLocale}");
    expect(createSystemTranslator("en")("status.payment.paid")).toBe("Payment confirmed");
    expect(createSystemTranslator("vi-VN")("status.payment.paid")).toBe("Đã xác nhận thanh toán");
    expect(createSystemTranslator("en")("status.fulfillment.fulfilled")).toBe("Delivered");
    expect(createSystemTranslator("vi-VN")("status.fulfillment.fulfilled")).toBe("Đã giao hàng");
  });

  it("resolves the app shell from request locale and passes localized client labels through safe data attributes", async () => {
    const source = await readFile("src/layouts/AppLayout.astro", "utf8");

    expect(source).toContain("const locale = Astro.locals.locale;");
    expect(source).toContain("const t = createDashboardTranslator(locale);");
    expect(source).toContain('<html lang={locale ?? "en"} dir={directionForLocale(locale)}>');
    expect(source).toContain('aria-label={t("dashboard.shell.workspace_nav_aria")}');
    expect(source).toContain('aria-label={t("dashboard.shell.mobile.nav_aria")}');
    expect(source).toContain('data-logout-pending={t("dashboard.shell.account.logging_out")}');
    expect(source).toContain("shell?.dataset.logoutFailed");
    expect(source).not.toContain("menuTitleChannels");
    expect(source).not.toContain('<html lang="vi">');
    expect(source).not.toContain("Chuyển đến nội dung");
    expect(source).not.toContain("Đang đăng xuất…");
  });

  it("localizes shared defaults while preserving explicit prop overrides", async () => {
    const files = [
      "PermissionState.astro",
      "PlanLimitState.astro",
      "StatePanel.astro",
      "SuspendedState.astro",
      "WorkspaceState.astro",
    ];
    const sources = await Promise.all(files.map((file) => readFile(`src/components/states/${file}`, "utf8")));
    const combined = sources.join("\n");

    for (const source of sources) {
      expect(source).toContain("createDashboardTranslator(Astro.locals.locale)");
    }
    expect(combined).toContain('eyebrow = t("dashboard.state.eyebrow")');
    expect(combined).toContain('title = t("dashboard.state.suspended.title")');
    expect(combined).toContain("actionLabel={actionLabel}");
    expect(combined).toContain("description={description}");
    expect(combined).toContain("title={title}");
    expect(combined).not.toContain("Không thể hoàn tất yêu cầu");
    expect(combined).not.toContain("Selinow đang lấy dữ liệu mới nhất.");
    expect(combined).not.toContain("Vai trò hiện tại: {roleLabel}");
  });

  it("localizes seller order, customer, and billing surfaces including client-side labels", async () => {
    const files = [
      "src/pages/app/orders.astro",
      "src/pages/app/orders/[id].astro",
      "src/pages/app/customers.astro",
      "src/pages/app/billing.astro",
    ];
    const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const combined = sources.join("\n");

    for (const source of sources) {
      expect(source).toContain("createDashboardTranslator");
      expect(source).toContain("const t = createDashboardTranslator(locale);");
    }
    expect(sources[0]).toContain('data-record-template={t("dashboard.orders.record_count"');
    expect(sources[0]).toContain('toLocaleLowerCase(ledger?.dataset.locale ?? "en")');
    expect(sources[2]).toContain('toLocaleLowerCase(panel?.dataset.locale ?? "en")');
    for (const hardcoded of [
      "Chưa có đơn hàng",
      "Không tìm thấy đơn hàng",
      "Khách chưa đặt tên",
      "Chưa thể tải gói dịch vụ",
    ]) {
      expect(combined).not.toContain(hardcoded);
    }
  });

  it("localizes seller catalog and inventory pages plus client feedback", async () => {
    const files = [
      "src/pages/app/products.astro",
      "src/pages/app/inventory.astro",
      "src/scripts/dashboard/products.ts",
      "src/scripts/dashboard/inventory.ts",
    ];
    const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));

    for (const source of sources) expect(source).toContain("createDashboardTranslator");
    expect(sources[0]).toContain('const t = createDashboardTranslator(locale);');
    expect(sources[0]).toContain('new Intl.DateTimeFormat(locale ?? "en"');
    expect(sources[1]).toContain('toLocaleString(locale ?? "en")');
    expect(sources[2]).toContain('createDashboardTranslator(document.documentElement.lang || "en")');
    expect(sources[3]).toContain('t("dashboard.inventory.client.error.recent_auth_required")');

    const combined = sources.join("\n");
    for (const hardcoded of [
      "Đang lưu product và variant…",
      "Không thể xác nhận phiên làm việc",
      "Dữ liệu đã thay đổi. Hãy preview lại",
      "Backend hiện chỉ cấp ledger kho",
    ]) {
      expect(combined).not.toContain(hardcoded);
    }
  });

  it("localizes integrations and store builder SSR plus browser feedback", async () => {
    const files = [
      "src/pages/app/integrations.astro",
      "src/pages/app/store.astro",
      "src/components/storefront/StorefrontPreviewCard.astro",
      "src/scripts/dashboard/integrations.ts",
      "src/scripts/dashboard/store-builder.ts",
    ];
    const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const [integrationsPage, storePage, previewCard, integrationsScript, storeScript] = sources;

    expect(integrationsPage).toContain("createDashboardTranslator");
    expect(integrationsPage).toContain('data-copy={JSON.stringify(integrationClientCopy)}');
    expect(integrationsPage).toContain('t("dashboard.integrations.title")');
    expect(storePage).toContain("createDashboardTranslator");
    expect(storePage).toContain('data-copy={JSON.stringify(storeBuilderClientCopy)}');
    expect(storePage).toContain('t("dashboard.store_builder.title")');
    expect(previewCard).toContain("createStorefrontTranslator");
    expect(integrationsScript).toContain("JSON.parse(root.dataset.copy");
    expect(storeScript).toContain("JSON.parse(builder.dataset.copy");

    const combined = sources.join("\n");
    for (const hardcoded of [
      "Làm mới trạng thái",
      "Không tải được catalog preview",
      "Tương phản chưa đạt",
      "Draft đã thay đổi ở phiên khác",
    ]) {
      expect(combined).not.toContain(hardcoded);
    }
  });
});
