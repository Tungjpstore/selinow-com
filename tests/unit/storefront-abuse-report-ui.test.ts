import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getCatalogParity } from "../../src/lib/i18n/catalog";
import { storefrontCatalogs } from "../../src/lib/i18n/catalogs/storefront";

describe("public storefront abuse report UI", () => {
  it("uses the existing safe API contract without echoing reporter data", async () => {
    const [layout, productPage, script] = await Promise.all([
      readFile("src/layouts/StorefrontLayout.astro", "utf8"),
      readFile("src/pages/products/[slug].astro", "utf8"),
      readFile("src/scripts/storefront/abuse-report.ts", "utf8"),
    ]);

    expect(layout).toContain("data-abuse-report-form");
    expect(layout).toContain("abuseReportProductSlug");
    expect(layout).not.toContain('Astro.url.pathname.startsWith("/products/")');
    expect(productPage).toContain("abuseReportProductSlug={product?.slug}");
    expect(layout).toContain('data-action="report_abuse"');
    expect(layout).toContain('data-size="flexible"');
    expect(layout).toContain('minlength="20"');
    expect(layout).toContain('t("storefront.report.detail")');
    expect(layout).toContain('data-error-idempotency-conflict={t("storefront.report.error.idempotency_conflict")}');
    expect(script).toContain('fetch("/api/store/abuse-reports"');
    expect(script).toContain('"Idempotency-Key": idempotencyKey');
    expect(script).toContain("crypto.randomUUID()");
    expect(script).toContain('feedback?.dataset.state === "success"');
    expect(script).toContain("control.disabled = false");
    expect(script).toContain("resetTurnstile()");
    expect(script).toContain("form?.dataset.errorRateLimited");
    expect(script).toContain("copy.receivedTracking.replace");
    expect(script).not.toMatch(/[À-ỹĐđ]/u);
    expect(script).not.toContain("reporterContact: payload");
    expect(storefrontCatalogs.en["storefront.report.detail"]).toContain("Do not enter passwords");
    expect(storefrontCatalogs["vi-VN"]["storefront.report.detail"]).toContain("Không nhập mật khẩu");
    expect(getCatalogParity(storefrontCatalogs)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
  });
});
