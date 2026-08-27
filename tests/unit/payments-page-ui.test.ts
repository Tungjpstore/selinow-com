import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { safeErrorMessage } from "../../src/lib/dashboard/integrations-view";
import { createDashboardTranslator } from "../../src/lib/i18n";

describe("payments page subscription admission", () => {
  const page = readFileSync("src/pages/app/payments.astro", "utf8");
  const controller = readFileSync("src/scripts/dashboard/payments.ts", "utf8");

  it("replaces PayOS setup with a billing recovery action when provider setup is not entitled", () => {
    expect(page).toContain('action: "provider_setup"');
    expect(page).toContain("data-can-configure-payos");
    expect(page).toContain("data-provider-setup-gate");
    expect(page).toContain('data-reason-code={providerSetupReasonCode}');
    expect(page).toContain('workspaceHref("/app/billing")');
    expect(page).toContain('canConfigurePayos ? (');
    expect(page).toContain('{canConfigurePayos && (');
    expect(controller).toContain('root.dataset.canConfigurePayos === "true"');
    expect(controller).toContain("if (!canConfigurePayos || configPanel === null");
    expect(controller).toContain("if (!canConfigurePayos || shopPublicId === undefined");
  });

  it.each([
    "subscription_payment_required",
    "subscription_grace_expired",
    "provider_not_ready",
  ])("shows safe localized guidance for %s", (code) => {
    expect(safeErrorMessage(code, undefined, "en")).not.toBe("The request could not be completed. Try again.");
    expect(safeErrorMessage(code, undefined, "vi-VN")).not.toBe("Yêu cầu chưa hoàn tất. Vui lòng thử lại.");
  });

  it("provides localized billing recovery copy without exposing machine codes", () => {
    for (const locale of ["en", "vi-VN"] as const) {
      const t = createDashboardTranslator(locale);
      expect(t("dashboard.integrations.payos.subscription_payment_required")).not.toContain("subscription_payment_required");
      expect(t("dashboard.integrations.payos.subscription_grace_expired")).not.toContain("subscription_grace_expired");
      expect(t("dashboard.integrations.payos.provider_not_ready")).not.toContain("provider_not_ready");
      expect(t("dashboard.integrations.payos.billing_action").length).toBeGreaterThan(5);
      expect(t("dashboard.integrations.payos.setup_unavailable").length).toBeGreaterThan(20);
    }
  });
});
