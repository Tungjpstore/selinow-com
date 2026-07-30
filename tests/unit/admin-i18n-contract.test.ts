import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createAdminTranslator, adminCatalogs } from "../../src/lib/i18n/catalogs/admin";
import { getCatalogParity } from "../../src/lib/i18n/catalog";

const ADMIN_SURFACES = [
  "src/components/admin/AdminState.astro",
  "src/layouts/AdminLayout.astro",
  "src/pages/admin/index.astro",
  "src/pages/admin/operations.astro",
  "src/pages/admin/shops.astro",
] as const;

const ADMIN_SHOP_DISPLAY_KEYS = [
  "admin.shops.column.channels",
  "admin.shops.column.products",
  "admin.shops.column.sellers",
  "admin.shops.column.shop",
  "admin.shops.column.state",
  "admin.shops.column.subscription",
  "admin.shops.column.updated",
  "admin.shops.detail.created",
  "admin.shops.detail.locale_currency",
  "admin.shops.detail.public_id",
  "admin.shops.detail.storefront_slug",
  "admin.shops.detail.updated",
  "admin.shops.filter.subscription",
  "admin.shops.forbidden.eyebrow",
  "admin.shops.header.eyebrow",
  "admin.shops.pagination.cursor",
  "admin.shops.products.active",
  "admin.shops.sellers.count",
  "admin.shops.subscription.active",
  "admin.shops.subscription.canceled",
  "admin.shops.subscription.grace_period",
  "admin.shops.subscription.past_due",
  "admin.shops.subscription.suspended",
  "admin.shops.subscription.trialing",
  "admin.shops.summary.active",
  "admin.shops.title",
] as const;

describe("admin localization contract", () => {
  it("keeps English and Vietnamese admin catalogs in parity", () => {
    expect(getCatalogParity(adminCatalogs)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
  });

  it("selects locale-specific admin state and preserves interpolation", () => {
    const english = createAdminTranslator("en");
    const vietnamese = createAdminTranslator("vi-VN");

    expect(english("admin.overview.reports.actions_aria", { reportId: "report-1" })).toBe("Actions for report report-1");
    expect(vietnamese("admin.overview.reports.actions_aria", { reportId: "report-1" })).toBe("Thao tác cho báo cáo report-1");
    expect(english("admin.overview.reports.limit", { count: 30 })).toBe("30 max");
    expect(vietnamese("admin.overview.reports.limit", { count: 30 })).toBe("tối đa 30");
    expect(english("admin.operations.records", { count: 3 })).toBe("3 records need attention");
    expect(vietnamese("admin.operations.records", { count: 3 })).toBe("3 bản ghi cần theo dõi");
  });

  it("catalogizes every static user-facing label on the admin overview", () => {
    const source = readFileSync(join(process.cwd(), "src/pages/admin/index.astro"), "utf8");
    const overviewKeys = [
      "admin.common.platform",
      "admin.overview.coverage.missing_surfaces",
      "admin.overview.coverage.operations",
      "admin.overview.eyebrow",
      "admin.overview.forbidden.eyebrow",
      "admin.overview.ledger.title",
      "admin.overview.manual.label.shop_public_id",
      "admin.overview.manual.placeholder.product_id",
      "admin.overview.manual.placeholder.shop_public_id",
      "admin.overview.reports.assignee",
      "admin.overview.reports.column.age",
      "admin.overview.reports.column.entity",
      "admin.overview.reports.column.evidence",
      "admin.overview.reports.column.safe_code",
      "admin.overview.reports.column.severity",
      "admin.overview.reports.column.state",
      "admin.overview.reports.limit",
      "admin.overview.reports.title",
    ] as const;

    for (const key of overviewKeys) expect(source).toContain(`t("${key}"`);
    expect(source).not.toMatch(/>(?:Abuse & Reports|Audit Logs|Dead letters, incidents, and encryption rotation|Selinow \/ Trust operations)</u);
    expect(source).not.toMatch(/<small class="admin-cell-label">(?:Age|Assignee|Entity|Evidence|Safe code|Severity|State)<\/small>/u);
  });

  it("does not leave Vietnamese user-facing literals in admin Astro surfaces", () => {
    for (const relativePath of ADMIN_SURFACES) {
      const source = readFileSync(join(process.cwd(), relativePath), "utf8");
      expect(source, relativePath).not.toMatch(/[À-ỹĐđ]/u);
    }
  });

  it("keeps every literal admin translation reference backed by the catalog", () => {
    const referencedKeys = new Set<string>();
    for (const relativePath of ADMIN_SURFACES) {
      const source = readFileSync(join(process.cwd(), relativePath), "utf8");
      for (const match of source.matchAll(/\bt\("([^"]+)"/gu)) {
        const key = match[1];
        if (key !== undefined) referencedKeys.add(key);
      }
    }

    const englishCatalog = adminCatalogs.en as Readonly<Record<string, string>>;
    expect([...referencedKeys].filter((key) => englishCatalog[key] === undefined)).toEqual([]);
  });

  it("catalogizes admin shop labels and aggregate copy for both locales", () => {
    const source = readFileSync(join(process.cwd(), "src/pages/admin/shops.astro"), "utf8");
    const english = createAdminTranslator("en");
    const vietnamese = createAdminTranslator("vi-VN");

    for (const key of ADMIN_SHOP_DISPLAY_KEYS) {
      expect(source, key).toContain(`t("${key}"`);
    }

    expect(english("admin.shops.sellers.count", { active: 4, owners: 1 })).toBe("4 active · 1 owner");
    expect(vietnamese("admin.shops.sellers.count", { active: 4, owners: 1 })).toBe("4 đang hoạt động · 1 chủ sở hữu");
    expect(english("admin.shops.subscription.grace_period")).toBe("Grace period");
    expect(vietnamese("admin.shops.subscription.grace_period")).toBe("Thời gian ân hạn");
    expect(source).not.toContain('eyebrow="Forbidden"');
    expect(source).not.toContain("<h1>Sellers & Shops</h1>");
    expect(source).not.toContain("<span>Cursor pagination</span>");
  });

  it("catalogizes the remaining admin operations copy and mixed-language details", () => {
    const source = readFileSync(join(process.cwd(), "src/pages/admin/operations.astro"), "utf8");
    const english = createAdminTranslator("en");
    const vietnamese = createAdminTranslator("vi-VN");
    const requiredKeys = [
      "admin.operations.column.action",
      "admin.operations.column.age",
      "admin.operations.column.assignee",
      "admin.operations.column.class",
      "admin.operations.column.control",
      "admin.operations.column.entity",
      "admin.operations.column.errors",
      "admin.operations.column.evidence",
      "admin.operations.column.impact",
      "admin.operations.column.key_family",
      "admin.operations.column.message",
      "admin.operations.column.progress",
      "admin.operations.column.safe_code",
      "admin.operations.column.scope",
      "admin.operations.column.severity",
      "admin.operations.column.shop",
      "admin.operations.column.state",
      "admin.operations.dead_letter.occurrence_summary",
      "admin.operations.dead_letter.resolve",
      "admin.operations.dead_letter.title",
      "admin.operations.deletion.detail.lifecycle_values",
      "admin.operations.deletion.form.impact_confirmation",
      "admin.operations.deletion.high_risk",
      "admin.operations.deletion.title",
      "admin.operations.field.occurrences",
      "admin.operations.field.version",
      "admin.operations.forbidden.eyebrow",
      "admin.operations.header.eyebrow",
      "admin.operations.incident.resolve",
      "admin.operations.incident.title",
      "admin.operations.rotation.details",
      "admin.operations.rotation.form.key_family",
      "admin.operations.rotation.key_family.generated_license_artifacts",
      "admin.operations.rotation.key_family.generated_license_credentials",
      "admin.operations.rotation.key_family.inventory",
      "admin.operations.rotation.process_resume",
      "admin.operations.rotation.title",
      "admin.operations.status.legal_hold",
      "admin.operations.summary.dead_letter",
      "admin.operations.summary.deletion_active",
      "admin.operations.summary.incident",
    ] as const;

    for (const key of requiredKeys) expect(source, key).toContain(`t("${key}"`);

    expect(english("admin.operations.rotation.details")).toBe("View run details");
    expect(vietnamese("admin.operations.rotation.details")).toBe("Xem chi tiết run");
    expect(english("admin.operations.dead_letter.occurrence_summary", { attempts: 2, count: 3 })).toBe("3 · provider attempts 2");
    expect(vietnamese("admin.operations.dead_letter.occurrence_summary", { attempts: 2, count: 3 })).toBe("3 lần · 2 lần thử provider");
    expect(source).not.toMatch(/>(?:Active incidents|Encryption rotation|Queue dead letters|Shop deletion & legal hold|Systems & Integrations|Xem run details)</u);
    expect(source).not.toMatch(/<small class="admin-cell-label">(?:Action|Age|Assignee|Class|Control|Entity|Errors|Evidence|Impact|Key family|Message|Progress|Safe code|Scope|Severity|Shop|State)<\/small>/u);
    expect(source).not.toMatch(/<label>(?:Batch size|Evidence reference|Global confirmation|Hold until|Impact confirmation|Key family|Live confirmation|Mode|Reason code|Resolution code|Scope|Shop public ID|Source version|Target version)/u);
    expect(source).not.toContain('eyebrow="Forbidden"');
    expect(source).not.toContain('aria-label="Active incidents"');
    expect(source).not.toContain('aria-label="Encryption rotation runs"');
    expect(source).not.toContain('aria-label="Queue dead letters"');
  });
});
