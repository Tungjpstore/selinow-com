import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { isBillingRecentAuthFailure, readBillingApiFailure } from "../../src/lib/dashboard/billing-api-error";
import { subscriptionStatePresentation } from "../../src/lib/dashboard/billing-ui";
import { getBillingCheckoutAdmission } from "../../src/lib/dashboard/billing-checkout";
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
    expect(source).toContain('new BillingApiError({ code: "checkout_provider_invalid", requestId })');
    expect(source).not.toMatch(/paddle/iu);
  });

  it("reuses one in-memory checkout key after response loss and rotates it at terminal boundaries", async () => {
    vi.stubGlobal("document", { querySelector: () => null });
    const billingModule = await import("../../src/scripts/dashboard/billing");
    vi.unstubAllGlobals();
    const Tracker = (billingModule as unknown as {
      BillingCheckoutAttemptTracker: new (createKey: () => string) => {
        begin: (input: { planCode: string; recovery: boolean; shopPublicId: string }) => { idempotencyKey: string };
        fail: (attempt: { idempotencyKey: string }, terminalResponse: boolean) => void;
        finish: (attempt: { idempotencyKey: string }) => void;
      };
    }).BillingCheckoutAttemptTracker;
    const isTerminalFailure = (billingModule as unknown as {
      isBillingCheckoutTerminalFailure: (error: unknown) => boolean;
    }).isBillingCheckoutTerminalFailure;
    expect(Tracker).toBeTypeOf("function");
    expect(isTerminalFailure).toBeTypeOf("function");
    expect(isTerminalFailure({ code: "billing_provider_unavailable", terminalResponse: true })).toBe(false);
    expect(isTerminalFailure({ code: "plan_price_unavailable", terminalResponse: true })).toBe(true);

    const generatedKeys = ["checkout-key-1", "checkout-key-2", "checkout-key-3", "checkout-key-4", "checkout-key-5"];
    const tracker = new Tracker(() => generatedKeys.shift() ?? "unexpected-key");
    const first = tracker.begin({ planCode: "starter", recovery: false, shopPublicId: "shop-a" });
    tracker.fail(first, false);
    expect(tracker.begin({ planCode: "starter", recovery: false, shopPublicId: "shop-a" }).idempotencyKey).toBe("checkout-key-1");

    const changedPlan = tracker.begin({ planCode: "pro", recovery: false, shopPublicId: "shop-a" });
    expect(changedPlan.idempotencyKey).toBe("checkout-key-2");
    tracker.fail(changedPlan, true);
    expect(tracker.begin({ planCode: "pro", recovery: false, shopPublicId: "shop-a" }).idempotencyKey).toBe("checkout-key-3");

    const changedShop = tracker.begin({ planCode: "pro", recovery: false, shopPublicId: "shop-b" });
    expect(changedShop.idempotencyKey).toBe("checkout-key-4");
    tracker.finish(changedShop);
    expect(tracker.begin({ planCode: "pro", recovery: false, shopPublicId: "shop-b" }).idempotencyKey).toBe("checkout-key-5");

    const source = readFileSync("src/scripts/dashboard/billing.ts", "utf8");
    expect(source).not.toMatch(/(?:local|session)Storage/u);
    expect(source).toContain("if (pending || shopPublicId === undefined");
  });

  it("explains that a missing merchant country blocks paid plan projection", () => {
    expect(getBillingCheckoutAdmission({
      billingState: "trialing",
      currentPlanCode: "business",
      marketReady: false,
      plans: [{ code: "starter", prices: [{ amountMinor: 99_000 }] }, { code: "pro", prices: [{ amountMinor: 299_000 }] }],
    })).toEqual({ eligible: [], reasonCode: "billing_market_unavailable" });
  });

  it("projects only paid plans after the server-selected market is ready", () => {
    expect(getBillingCheckoutAdmission({
      billingState: "trialing",
      currentPlanCode: "business",
      marketReady: true,
      plans: [{ code: "business", prices: [{ amountMinor: 1 }] }, { code: "starter", prices: [{ amountMinor: 99_000 }] }, { code: "pro", prices: [{ amountMinor: 299_000 }] }],
    }).eligible.map((plan) => plan.code)).toEqual(["starter", "pro"]);
  });

  it("links an unknown billing market to the tenant settings flow", () => {
    const page = readFileSync("src/pages/app/billing.astro", "utf8");
    const controller = readFileSync("src/scripts/dashboard/billing.ts", "utf8");
    expect(page).toContain("data-billing-market-ready");
    expect(page).toContain('workspaceHref("/onboarding#settings")');
    expect(controller).toContain("getBillingCheckoutAdmission");
    for (const locale of ["en", "vi-VN"] as const) {
      const translate = createDashboardTranslator(locale);
      expect(translate("dashboard.billing.checkout.market_required").length).toBeGreaterThan(20);
      expect(translate("dashboard.billing.checkout.market_action").length).toBeGreaterThan(5);
    }
  });

  it("retains safe API error codes and request IDs for checkout support", () => {
    expect(readBillingApiFailure({ code: "recent_auth_required", requestId: "request-checkout-001" }, 403)).toEqual({
      code: "recent_auth_required",
      requestId: "request-checkout-001",
    });
    expect(readBillingApiFailure({ code: "provider_not_ready", requestId: "unsafe request id" }, 503)).toEqual({
      code: "provider_not_ready",
      requestId: null,
    });
  });

  it("recognizes current and compatibility recent-auth error codes", () => {
    expect(isBillingRecentAuthFailure("recent_auth_required")).toBe(true);
    expect(isBillingRecentAuthFailure("authentication_recent_required")).toBe(true);
    expect(isBillingRecentAuthFailure("authentication_required")).toBe(false);
  });

  it("renders a localized reauthentication action and request reference", () => {
    const page = readFileSync("src/pages/app/billing.astro", "utf8");
    const controller = readFileSync("src/scripts/dashboard/billing.ts", "utf8");
    expect(page).toContain("data-billing-recent-auth-action");
    expect(controller).toContain("BillingApiError");
    expect(controller).toContain("readBillingApiFailure");
    expect(controller).toContain("checkoutErrorCode");
    expect(controller).toContain("checkoutRequestId");
    for (const locale of ["en", "vi-VN"] as const) {
      const translate = createDashboardTranslator(locale);
      expect(translate("dashboard.billing.checkout.recent_auth_required").length).toBeGreaterThan(20);
      expect(translate("dashboard.billing.checkout.recent_auth_action").length).toBeGreaterThan(10);
      expect(translate("dashboard.billing.checkout.error_code", { code: "provider_not_ready" })).toContain("provider_not_ready");
      expect(translate("dashboard.billing.checkout.request_id", { requestId: "request-checkout-001" })).toContain("request-checkout-001");
    }
  });
});
