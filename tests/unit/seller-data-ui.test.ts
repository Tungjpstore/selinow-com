import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { createDashboardTranslator, dashboardCatalogs } from "../../src/lib/i18n/catalogs/dashboard";
import { getCatalogParity } from "../../src/lib/i18n/catalog";

const readSource = (path: string): Promise<string> => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

describe("seller data lifecycle UI", () => {
  it("renders owner-scoped export and deletion state from authoritative services", async () => {
    const page = await readSource("src/pages/app/data.astro");

    expect(page).toContain("listDataExports");
    expect(page).toContain("getShopDeletion");
    expect(page).toContain("listSellerAuditEntries");
    expect(page).toContain("listOwnerAbuseReports");
    expect(page).toContain('shop.role !== "owner"');
    expect(page).toContain("report.ownerRestoreEligible");
    expect(page).toContain('report.targetStatus === "suspended"');
    expect(page).toContain('data-moderation-action={canRestore ? "product_restore" : "product_suspend"}');
    expect(page).toContain('pattern="DELETE SHOP"');
    expect(page).toContain('data-csrf-cookie-name={`${env.SESSION_COOKIE_NAME}_csrf`}');
    expect(page).toContain('t("dashboard.data.deletion.cascade_note")');
    expect(page).not.toContain("ciphertext");
    expect(page).not.toContain("downloadToken");
    expect(page).not.toContain("entry.actorId");
    expect(page).not.toContain("entry.metadata");
    expect(page).not.toContain("reporterContactHash");
  });

  it("keeps one-time export tokens in memory and posts destructive mutations with CSRF", async () => {
    const script = await readSource("src/scripts/dashboard/data-lifecycle.ts");

    expect(script).toContain("let pendingDownload");
    expect(script).toContain('body: JSON.stringify({ token: download.token })');
    expect(script).toContain('"X-CSRF-Token": csrfToken()');
    expect(script).toContain("root.dataset.csrfCookieName");
    expect(script).toContain("encodeURIComponent(csrfCookieName)");
    expect(script).not.toContain('startsWith("selinow_csrf=")');
    expect(script).toContain('idempotencyKey("delete-cancel")');
    expect(script).toContain('actionKind !== "product_suspend" && actionKind !== "product_restore"');
    expect(script).toContain("moderationIdempotencyKey(button, actionKind)");
    expect(script).toContain("recent_auth_required");
    expect(script).toContain("moderation_restore_unavailable");
    expect(script).toContain("moderation_state_conflict");
    expect(script).not.toContain("localStorage");
    expect(script).not.toContain("sessionStorage");
    expect(script).not.toContain("console.");
    expect(script).not.toContain("data-download-token");
  });

  it("keeps the data lifecycle page and client copy localized with an English fallback", async () => {
    const [page, script] = await Promise.all([
      readSource("src/pages/app/data.astro"),
      readSource("src/scripts/dashboard/data-lifecycle.ts"),
    ]);
    const english = createDashboardTranslator("en");
    const vietnamese = createDashboardTranslator("vi-VN");
    const unsupported = createDashboardTranslator("fr-FR");

    expect(getCatalogParity(dashboardCatalogs)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
    expect(english("dashboard.data.title")).toBe("Audit & data");
    expect(vietnamese("dashboard.data.title")).toBe("Audit & dữ liệu");
    expect(unsupported("dashboard.data.title")).toBe("Audit & data");
    expect(unsupported("dashboard.data.client.error.generic")).toBe("The request could not be completed. Try again.");
    expect(page).toContain("createDashboardTranslator");
    expect(page).toContain('data-locale={locale ?? "en"}');
    expect(script).toContain("createDashboardTranslator");
    for (const hardcoded of [
      "Phiên đăng nhập đã hết hạn",
      "Đang tạo export mã hóa",
      "Yêu cầu đã được ghi nhận",
      "Khôi phục sản phẩm này về trạng thái trước",
      "Đang yêu cầu server tiếp tục",
    ]) {
      expect(script).not.toContain(hardcoded);
    }
  });
});

describe("seller payment exception UI", () => {
  it("shows safe exception metadata without rendering provider evidence", async () => {
    const page = await readSource("src/pages/app/orders.astro");

    expect(page).toContain("listPaymentExceptions");
    expect(page).toContain("parsePaymentExceptionEvidence");
    expect(page).toContain('capability: "payments:read"');
    expect(page).toContain('t("dashboard.orders.exceptions.intro")');
    expect(page).toContain('t("dashboard.orders.exceptions.expected_amount")');
    expect(page).toContain('t("dashboard.orders.exceptions.received_amount")');
    expect(page).toContain('t("dashboard.orders.exceptions.occurred_at")');
    expect(page).toContain('t("dashboard.orders.exceptions.expected_keys")');
    expect(page).toContain('t("dashboard.orders.exceptions.reserved_keys")');
    expect(page).toContain('currency={exception.currency}');
    expect(page).toContain("orderPublicId");
    expect(page).toContain('t("dashboard.orders.exceptions.footnote")');
    expect(page).not.toContain("providerPayload");
    expect(page).not.toContain("exception.safeEvidenceJson");
  });

  it("loads exception currency from the authoritative payment attempt", async () => {
    const reconciliation = await readSource("src/lib/payments/reconciliation.ts");

    expect(reconciliation).toContain("payment_attempts.currency");
    expect(reconciliation).toContain("currency: string;");
  });

  it("uses the selected shop locale and timezone for order evidence timestamps", async () => {
    const detail = await readSource("src/pages/app/orders/[id].astro");

    expect(detail).toContain("const locale = Astro.locals.locale;");
    expect(detail).toContain('new Intl.DateTimeFormat(locale ?? "en"');
    expect(detail).toContain('timeZone: shop?.timezone ?? "Asia/Ho_Chi_Minh"');
    expect(detail).toContain("dateFormatter.format(date)");
  });
});
