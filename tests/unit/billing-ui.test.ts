import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { subscriptionStatePresentation } from "../../src/lib/dashboard/billing-ui";
import { createDashboardTranslator } from "../../src/lib/i18n/catalogs/dashboard";

describe("subscription state presentation", () => {
  it("does not present blocked or degraded subscriptions as success", () => {
    expect(subscriptionStatePresentation("active", "vi-VN").tone).toBe("success");
    expect(subscriptionStatePresentation("past_due", "vi-VN").tone).toBe("warning");
    expect(subscriptionStatePresentation("suspended", "vi-VN")).toMatchObject({
      label: "Đã tạm ngưng",
      tone: "danger",
    });
    expect(subscriptionStatePresentation("cancel_scheduled", "vi-VN")).toMatchObject({
      label: "Đã lên lịch hủy",
      tone: "success",
    });
    expect(subscriptionStatePresentation("upgrade_pending", "vi-VN")).toMatchObject({
      label: "Đang chờ nâng gói",
      tone: "info",
    });
    expect(subscriptionStatePresentation("canceled", "vi-VN").tone).toBe("neutral");
  });

  it("fails closed for an unknown server state", () => {
    expect(subscriptionStatePresentation("provider_transitioning", "vi-VN")).toEqual({
      impact: "Server trả về một trạng thái subscription chưa được nhận diện; không giả định shop đang hoạt động.",
      label: "Chưa xác định",
      tone: "neutral",
    });
  });

  it("names Dodo Payments as the checkout provider in both supported locales", () => {
    for (const locale of ["en", "vi-VN"] as const) {
      const translate = createDashboardTranslator(locale);
      expect(translate("dashboard.billing.checkout.description")).toContain("Dodo Payments");
      expect(translate("dashboard.billing.checkout.submit")).toContain("Dodo Payments");
      expect(translate("dashboard.billing.checkout.provider")).toContain("Dodo Payments");
      expect(translate("dashboard.billing.checkout.description").toLowerCase()).not.toContain("paddle");
      expect(translate("dashboard.billing.checkout.submit").toLowerCase()).not.toContain("paddle");
      expect(translate("dashboard.billing.checkout.provider").toLowerCase()).not.toContain("paddle");
    }
  });

  it("fails closed if the checkout response is not explicitly Dodo", () => {
    const source = readFileSync("src/scripts/dashboard/billing.ts", "utf8");
    expect(source).toContain('provider !== "dodo"');
    expect(source).toContain('throw new Error("checkout_provider_invalid")');
    expect(source).not.toMatch(/paddle/iu);
  });
});
