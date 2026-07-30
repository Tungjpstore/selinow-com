import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getCatalogParity } from "../../src/lib/i18n/catalog";
import { createDashboardTranslator, dashboardCatalogs } from "../../src/lib/i18n/catalogs/dashboard";

const readSource = (path: string): Promise<string> => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

describe("dashboard domain UI localization", () => {
  it("keeps the page, manager, and lifecycle labels on the dashboard catalog", async () => {
    const [page, manager, lifecycle] = await Promise.all([
      readSource("src/pages/app/domains.astro"),
      readSource("src/components/dashboard/DomainManager.astro"),
      readSource("src/components/dashboard/DomainLifecycle.astro"),
    ]);
    const english = createDashboardTranslator("en");
    const vietnamese = createDashboardTranslator("vi-VN");
    const unsupported = createDashboardTranslator("fr-FR");

    expect(getCatalogParity(dashboardCatalogs)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
    expect(english("dashboard.domains.title")).toBe("Domains");
    expect(vietnamese("dashboard.domains.title")).toBe("Tên miền");
    expect(unsupported("dashboard.domains.error.generic")).toBe("The request did not finish. Try again.");
    expect(page).toContain('title={t("dashboard.domains.title")}');
    expect(manager).toContain("createDashboardTranslator");
    expect(manager).toContain('data-locale={locale ?? "en"}');
    expect(lifecycle).toContain('t("dashboard.domains.lifecycle.aria")');
    for (const source of [page, manager, lifecycle]) expect(source).not.toMatch(/[À-ỹ]/u);
  });
});
