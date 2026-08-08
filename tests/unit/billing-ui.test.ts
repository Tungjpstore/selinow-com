import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { isBillingRecentAuthFailure, readBillingApiFailure } from "../../src/lib/dashboard/billing-api-error";
import { subscriptionStatePresentation } from "../../src/lib/dashboard/billing-ui";
import { getBillingCheckoutAdmission } from "../../src/lib/dashboard/billing-checkout";
import { createDashboardTranslator } from "../../src/lib/i18n/catalogs/dashboard";

type Attempt = { idempotencyKey: string; planCode: string; recovery: boolean; shopPublicId: string };
type AttemptStorage = {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
};
type AttemptTracker = {
  begin: (input: { planCode: string; recovery: boolean; shopPublicId: string }) => Attempt;
  fail: (attempt: Pick<Attempt, "idempotencyKey">, terminalResponse: boolean) => void;
  finish: (attempt: Pick<Attempt, "idempotencyKey">) => void;
};
type BillingScriptModule = {
  acceptBillingCheckoutResponse: (payload: Record<string, unknown> | null, attempt: Attempt, tracker: AttemptTracker) => string;
  BillingCheckoutAttemptTracker: new (input: { createKey: () => string; now: () => number; storage: AttemptStorage; ttlMs?: number }) => AttemptTracker;
  isBillingCheckoutTerminalFailure: (error: unknown) => boolean;
};

function memoryStorage(): AttemptStorage & { value: (key: string) => string | null } {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
    value: (key) => values.get(key) ?? null,
  };
}

async function loadBillingScript(): Promise<BillingScriptModule> {
  vi.stubGlobal("document", { querySelector: () => null });
  try {
    return await import("../../src/scripts/dashboard/billing") as unknown as BillingScriptModule;
  } finally {
    vi.unstubAllGlobals();
  }
}

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

  it("reuses a scoped checkout key after reload without persisting credentials", async () => {
    const billingModule = await loadBillingScript();
    const Tracker = billingModule.BillingCheckoutAttemptTracker;
    const acceptResponse = billingModule.acceptBillingCheckoutResponse;
    const isTerminalFailure = billingModule.isBillingCheckoutTerminalFailure;
    expect(Tracker).toBeTypeOf("function");
    expect(acceptResponse).toBeTypeOf("function");
    expect(isTerminalFailure).toBeTypeOf("function");
    expect(isTerminalFailure({ code: "billing_provider_unavailable", terminalResponse: true })).toBe(false);
    expect(isTerminalFailure({ code: "plan_price_unavailable", terminalResponse: true })).toBe(true);

    const storage = memoryStorage();
    const firstTracker = new Tracker({ createKey: () => "checkout-key-1", now: () => 1_000, storage });
    const first = firstTracker.begin({ planCode: "starter", recovery: false, shopPublicId: "shop-a" });
    firstTracker.fail(first, false);
    const reloadKeys = ["checkout-key-2", "checkout-key-3", "checkout-key-4"];
    const reloadedTracker = new Tracker({ createKey: () => reloadKeys.shift() ?? "unexpected-key", now: () => 2_000, storage });
    expect(reloadedTracker.begin({ planCode: "starter", recovery: false, shopPublicId: "shop-a" }).idempotencyKey).toBe("checkout-key-1");
    const persisted = storage.value("selinow.billing.checkout-attempt.v1");
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted ?? "null")).toEqual({
      expiresAt: 1_801_000,
      idempotencyKey: "checkout-key-1",
      planCode: "starter",
      recovery: false,
      shopPublicId: "shop-a",
      version: 1,
    });
    expect(persisted).not.toMatch(/csrf|credential|secret|token/iu);

    const changedPlan = reloadedTracker.begin({ planCode: "pro", recovery: false, shopPublicId: "shop-a" });
    expect(changedPlan.idempotencyKey).toBe("checkout-key-2");
    expect(JSON.parse(storage.value("selinow.billing.checkout-attempt.v1") ?? "null")).toMatchObject({ idempotencyKey: "checkout-key-2", planCode: "pro" });
    const changedRecovery = reloadedTracker.begin({ planCode: "pro", recovery: true, shopPublicId: "shop-a" });
    expect(changedRecovery.idempotencyKey).toBe("checkout-key-3");
    const changedShop = reloadedTracker.begin({ planCode: "pro", recovery: true, shopPublicId: "shop-b" });
    expect(changedShop.idempotencyKey).toBe("checkout-key-4");
    reloadedTracker.fail(changedShop, true);
    expect(storage.value("selinow.billing.checkout-attempt.v1")).toBeNull();

    const source = readFileSync("src/scripts/dashboard/billing.ts", "utf8");
    expect(source).toContain("window.sessionStorage");
    expect(source).not.toMatch(/localStorage/u);
    expect(source).toContain("if (pending || shopPublicId === undefined");
  });

  it("retains the persisted key until a successful checkout response is fully validated", async () => {
    const billingModule = await loadBillingScript();
    const storage = memoryStorage();
    const tracker = new billingModule.BillingCheckoutAttemptTracker({ createKey: () => "checkout-key-malformed", now: () => 1_000, storage });
    const attempt = tracker.begin({ planCode: "pro", recovery: false, shopPublicId: "shop-a" });

    expect(() => billingModule.acceptBillingCheckoutResponse({ checkout: { checkoutUrl: "https://", provider: "dodo" }, requestId: "request-malformed-001" }, attempt, tracker)).toThrow();
    expect(() => billingModule.acceptBillingCheckoutResponse({ checkout: { checkoutUrl: "https://checkout.example.test/session/wrong", provider: "other" } }, attempt, tracker)).toThrow();
    const reloadedTracker = new billingModule.BillingCheckoutAttemptTracker({ createKey: () => "checkout-key-replacement", now: () => 2_000, storage });
    const reloadedAttempt = reloadedTracker.begin({ planCode: "pro", recovery: false, shopPublicId: "shop-a" });
    expect(reloadedAttempt.idempotencyKey).toBe("checkout-key-malformed");

    expect(billingModule.acceptBillingCheckoutResponse({ checkout: { checkoutUrl: "https://checkout.example.test/session/ok", provider: "dodo" } }, reloadedAttempt, reloadedTracker)).toBe("https://checkout.example.test/session/ok");
    expect(storage.value("selinow.billing.checkout-attempt.v1")).toBeNull();
  });

  it("rotates an expired persisted checkout key", async () => {
    const billingModule = await loadBillingScript();
    const storage = memoryStorage();
    const firstTracker = new billingModule.BillingCheckoutAttemptTracker({ createKey: () => "checkout-key-expiring", now: () => 1_000, storage, ttlMs: 1_000 });
    firstTracker.begin({ planCode: "starter", recovery: false, shopPublicId: "shop-a" });

    const afterExpiry = new billingModule.BillingCheckoutAttemptTracker({ createKey: () => "checkout-key-fresh", now: () => 2_000, storage, ttlMs: 1_000 });
    expect(afterExpiry.begin({ planCode: "starter", recovery: false, shopPublicId: "shop-a" }).idempotencyKey).toBe("checkout-key-fresh");
    expect(JSON.parse(storage.value("selinow.billing.checkout-attempt.v1") ?? "null")).toMatchObject({ expiresAt: 3_000, idempotencyKey: "checkout-key-fresh" });

    storage.setItem("selinow.billing.checkout-attempt.v1", JSON.stringify({
      expiresAt: 100_000,
      idempotencyKey: "checkout-key-unbounded",
      planCode: "starter",
      recovery: false,
      shopPublicId: "shop-a",
      version: 1,
    }));
    const boundedExpiry = new billingModule.BillingCheckoutAttemptTracker({ createKey: () => "checkout-key-bounded", now: () => 4_000, storage, ttlMs: 1_000 });
    expect(boundedExpiry.begin({ planCode: "starter", recovery: false, shopPublicId: "shop-a" }).idempotencyKey).toBe("checkout-key-bounded");
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
