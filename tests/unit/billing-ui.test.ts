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
  finishSession: (checkoutSessionId: string) => void;
  opened: (attempt: Pick<Attempt, "idempotencyKey">, checkoutSessionId: string) => void;
};
type OperationAttempt = { action: "cancel" | "cancel_scheduled_plan_change" | "change_plan" | "resume"; expectedSubscriptionVersion: number; idempotencyKey: string; requestedPlanCode: string | null; shopPublicId: string };
type OperationAttemptTracker = {
  begin: (input: Omit<OperationAttempt, "idempotencyKey">) => OperationAttempt;
  fail: (attempt: Pick<OperationAttempt, "idempotencyKey">, terminalResponse: boolean) => void;
  finish: (attempt: Pick<OperationAttempt, "idempotencyKey">) => void;
};
type BillingScriptModule = {
  acceptBillingCheckoutResponse: (payload: Record<string, unknown> | null, attempt: Attempt, tracker: AttemptTracker) => string;
  acceptBillingPortalResponse: (payload: Record<string, unknown> | null) => string;
  BillingCheckoutAttemptTracker: new (input: { createKey: () => string; now: () => number; storage: AttemptStorage; ttlMs?: number }) => AttemptTracker;
  BillingOperationAttemptTracker: new (input: { createKey: () => string; now: () => number; storage: AttemptStorage; ttlMs?: number }) => OperationAttemptTracker;
  isBillingCheckoutTerminalFailure: (error: unknown) => boolean;
  billingPlanChangeDirection: (current: { amountMinor: number; currency: string; interval: string; marketCode: string } | null, target: { amountMinor: number; currency: string; interval: string; marketCode: string } | undefined) => "downgrade" | "unknown" | "upgrade";
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

  it("accepts only a safe Dodo customer portal URL", async () => {
    const billingModule = await loadBillingScript();
    expect(billingModule.acceptBillingPortalResponse({ portal: { provider: "dodo", portalUrl: "https://billing.dodopayments.com/session/abc" } })).toBe("https://billing.dodopayments.com/session/abc");
    expect(() => billingModule.acceptBillingPortalResponse({ portal: { provider: "stripe", portalUrl: "https://billing.dodopayments.com/session/abc" } })).toThrow();
    expect(() => billingModule.acceptBillingPortalResponse({ portal: { provider: "dodo", portalUrl: "http://billing.dodopayments.com/session/abc" } })).toThrow();
    expect(() => billingModule.acceptBillingPortalResponse({ portal: { provider: "dodo", portalUrl: "https://user:pass@billing.dodopayments.com/session/abc" } })).toThrow();
    expect(() => billingModule.acceptBillingPortalResponse({ portal: { provider: "dodo", portalUrl: "https://billing.example.test/session/abc" } })).toThrow();
  });

  it("reuses a scoped checkout key after reload without persisting credentials", async () => {
    const billingModule = await loadBillingScript();
    const Tracker = billingModule.BillingCheckoutAttemptTracker;
    const acceptResponse = billingModule.acceptBillingCheckoutResponse;
    const isTerminalFailure = billingModule.isBillingCheckoutTerminalFailure;
    expect(Tracker).toBeTypeOf("function");
    expect(acceptResponse).toBeTypeOf("function");
    expect(isTerminalFailure).toBeTypeOf("function");
    expect(billingModule.billingPlanChangeDirection).toBeTypeOf("function");
    expect(isTerminalFailure({ code: "billing_provider_unavailable", terminalResponse: true })).toBe(false);
    expect(isTerminalFailure({ code: "billing_provider_invalid", terminalResponse: true })).toBe(false);
    expect(isTerminalFailure({ code: "billing_checkout_persistence_conflict", terminalResponse: true })).toBe(false);
    expect(isTerminalFailure({ code: "http_502", terminalResponse: true })).toBe(false);
    expect(isTerminalFailure({ code: "billing_provider_request_rejected", terminalResponse: true })).toBe(true);
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
      checkoutSessionId: null,
      expiresAt: 86_701_000,
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

  it("classifies plan changes from the server-selected price, not plan names", async () => {
    const billingModule = await loadBillingScript();
    const current = { amountMinor: 299_000, currency: "VND", interval: "month", marketCode: "vn" };
    expect(billingModule.billingPlanChangeDirection(current, { ...current, amountMinor: 399_000 })).toBe("upgrade");
    expect(billingModule.billingPlanChangeDirection(current, { ...current, amountMinor: 99_000 })).toBe("downgrade");
    expect(billingModule.billingPlanChangeDirection(current, { ...current, currency: "USD", amountMinor: 999 })).toBe("unknown");
    expect(billingModule.billingPlanChangeDirection(null, { ...current })).toBe("unknown");
  });

  it("retains the persisted key until the bound checkout reaches a terminal state", async () => {
    const billingModule = await loadBillingScript();
    const storage = memoryStorage();
    const tracker = new billingModule.BillingCheckoutAttemptTracker({ createKey: () => "checkout-key-malformed", now: () => 1_000, storage });
    const attempt = tracker.begin({ planCode: "pro", recovery: false, shopPublicId: "shop-a" });

    expect(() => billingModule.acceptBillingCheckoutResponse({ checkout: { checkoutUrl: "https://", provider: "dodo" }, requestId: "request-malformed-001" }, attempt, tracker)).toThrow();
    expect(() => billingModule.acceptBillingCheckoutResponse({ checkout: { checkoutUrl: "https://checkout.example.test/session/wrong", provider: "other" } }, attempt, tracker)).toThrow();
    const reloadedTracker = new billingModule.BillingCheckoutAttemptTracker({ createKey: () => "checkout-key-replacement", now: () => 2_000, storage });
    const reloadedAttempt = reloadedTracker.begin({ planCode: "pro", recovery: false, shopPublicId: "shop-a" });
    expect(reloadedAttempt.idempotencyKey).toBe("checkout-key-malformed");

    const checkoutSessionId = "bchk_00000000-0000-4000-8000-000000000001";
    expect(() => billingModule.acceptBillingCheckoutResponse({ checkout: { checkoutUrl: "https://checkout.example.test/session/missing-id", provider: "dodo" } }, reloadedAttempt, reloadedTracker)).toThrow();
    expect(billingModule.acceptBillingCheckoutResponse({ checkout: { checkoutUrl: "https://checkout.example.test/session/ok", provider: "dodo", sessionId: checkoutSessionId } }, reloadedAttempt, reloadedTracker)).toBe("https://checkout.example.test/session/ok");
    expect(JSON.parse(storage.value("selinow.billing.checkout-attempt.v1") ?? "null")).toMatchObject({
      checkoutSessionId,
      idempotencyKey: "checkout-key-malformed",
    });

    const afterHostedCheckout = new billingModule.BillingCheckoutAttemptTracker({ createKey: () => "checkout-key-unexpected", now: () => 3_000, storage });
    expect(afterHostedCheckout.begin({ planCode: "pro", recovery: false, shopPublicId: "shop-a" }).idempotencyKey).toBe("checkout-key-malformed");
    afterHostedCheckout.finishSession("bchk_00000000-0000-4000-8000-000000000002");
    expect(storage.value("selinow.billing.checkout-attempt.v1")).not.toBeNull();
    afterHostedCheckout.finishSession(checkoutSessionId);
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

  it("reuses a scoped subscription-operation key after a lost response", async () => {
    const billingModule = await loadBillingScript();
    const storage = memoryStorage();
    const firstTracker = new billingModule.BillingOperationAttemptTracker({ createKey: () => "operation-key-1", now: () => 1_000, storage });
    const first = firstTracker.begin({ action: "change_plan", expectedSubscriptionVersion: 7, requestedPlanCode: "pro", shopPublicId: "shop-a" });
    firstTracker.fail(first, false);

    const keys = ["operation-key-2", "operation-key-3"];
    const reloaded = new billingModule.BillingOperationAttemptTracker({ createKey: () => keys.shift() ?? "unexpected-key", now: () => 2_000, storage });
    expect(reloaded.begin({ action: "change_plan", expectedSubscriptionVersion: 7, requestedPlanCode: "pro", shopPublicId: "shop-a" }).idempotencyKey).toBe("operation-key-1");
    expect(JSON.parse(storage.value("selinow.billing.operation-attempt.v1") ?? "null")).toMatchObject({
      action: "change_plan",
      expectedSubscriptionVersion: 7,
      idempotencyKey: "operation-key-1",
      requestedPlanCode: "pro",
      shopPublicId: "shop-a",
    });

    expect(reloaded.begin({ action: "cancel", expectedSubscriptionVersion: 7, requestedPlanCode: null, shopPublicId: "shop-a" }).idempotencyKey).toBe("operation-key-2");
    reloaded.finish({ idempotencyKey: "operation-key-2" });
    expect(storage.value("selinow.billing.operation-attempt.v1")).toBeNull();
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

  it("offers only the current plan for canceled subscription recovery", () => {
    expect(getBillingCheckoutAdmission({
      billingState: "canceled",
      currentPlanCode: "pro",
      marketReady: true,
      plans: [{ code: "starter", prices: [{ amountMinor: 500 }] }, { code: "pro", prices: [{ amountMinor: 1500 }] }],
    }).eligible.map((plan) => plan.code)).toEqual(["pro"]);

    const page = readFileSync("src/pages/app/billing.astro", "utf8");
    const controller = readFileSync("src/scripts/dashboard/billing.ts", "utf8");
    expect(page).toContain('billing.state === "canceled"');
    expect(controller).toContain('billingState === "suspended" || billingState === "canceled"');
    expect(controller).not.toContain('|| billingState === "canceled") return;');
  });

  it("shows an active current plan without turning a same-plan pricing target into a downgrade", () => {
    const page = readFileSync("src/pages/app/billing.astro", "utf8");
    const controller = readFileSync("src/scripts/dashboard/billing.ts", "utf8");
    expect(page).toContain("plansCurrentHint");
    expect(controller).toContain('const visiblePlans = (): Plan[] =>');
    expect(controller).toContain('button.dataset.currentPlan = "true"');
    expect(controller).toContain('button.setAttribute("aria-disabled", "true")');
    expect(controller).toContain('target?.dataset.currentPlan === "true"');
  });

  it("provides a guarded merchant-country recovery form when the billing market is unknown", () => {
    const page = readFileSync("src/pages/app/billing.astro", "utf8");
    const controller = readFileSync("src/scripts/dashboard/billing.ts", "utf8");
    expect(page).toContain("data-billing-market-ready");
    expect(page).toContain("data-billing-market-form");
    expect(page).toContain('name="merchantCountry"');
    expect(page).not.toContain("/onboarding#settings");
    expect(controller).toContain('const marketForm = root.querySelector<HTMLFormElement>("[data-billing-market-form]");');
    expect(controller).toContain('requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}`, {');
    expect(controller).toContain('JSON.stringify({ merchantCountry: value.trim().toUpperCase() })');
    expect(controller).toContain('method: "PATCH"');
    expect(controller).toContain('showFeedback(text("checkoutMarketSaved"), "success")');
    expect(controller).toContain("getBillingCheckoutAdmission");
    for (const locale of ["en", "vi-VN"] as const) {
      const translate = createDashboardTranslator(locale);
      expect(translate("dashboard.billing.checkout.market_required").length).toBeGreaterThan(20);
      expect(translate("dashboard.billing.checkout.market_action").length).toBeGreaterThan(5);
    }
  });

  it("uses a state-driven preview and hides the internal request ledger", () => {
    const page = readFileSync("src/pages/app/billing.astro", "utf8");
    const controller = readFileSync("src/scripts/dashboard/billing.ts", "utf8");
    expect(page).toContain("data-plan-dialog");
    expect(page).toContain("data-plan-stage=\"review\"");
    expect(page).toContain("data-open-cancel-dialog");
    expect(page).toContain("data-billing-resume");
    expect(page).not.toContain("data-billing-request-ledger");
    expect(page).not.toContain('name="reasonCode"');
    expect(controller).toContain("/billing/operations");
    expect(controller).toContain("pollOperation");
    expect(controller).toContain("BillingOperationAttemptTracker");
    expect(controller).toContain("previewReady = false");
    expect(controller).toContain("sequence !== previewSequence");
    expect(controller).toContain("if (selectedPlan === null || !previewReady || pending) return;");
    expect(controller).toContain("if (!checkout) {");
    expect(controller).not.toContain("if (upgrade && !checkout)");
    expect(controller).toContain('effectiveAt !== "immediately" && effectiveAt !== "next_billing_date"');
    expect(controller).toContain('effectiveAt === "immediately" ? text("effectiveNow")');
    expect(controller).toContain("pollBillingReturn");
    expect(controller).toContain('const checkoutSessionId = urlState.get("checkout")');
    expect(controller).toContain('const targetPlanCode = new URL(window.location.href).searchParams.get("target")');
    expect(controller).toContain('const target = root.querySelector<HTMLButtonElement>(`[data-plan-choice="${targetPlanCode}"]`)');
    expect(controller).toContain('target?.dataset.currentPlan === "true"');
    expect(controller).toContain('/billing/checkouts/${encodeURIComponent(checkoutSessionId)}');
    expect(controller).toContain("void pollBillingReturn(checkoutSessionId)");
    expect(controller).not.toContain('if (hasBillingReturn) setUrlState("billing_return", null)');
    expect(controller).toContain('typeof subscription.planCode === "string" && subscription.planCode !== currentPlanCode');
    expect(controller).toContain("subscription.version !== subscriptionVersion");
    expect(page).toContain('data-review-title tabindex="-1"');
    expect(page).toContain("data-review-announcement");
    expect(page).toContain("data-review-provider-note");
    expect(page).toContain("data-plan-confirm disabled");
    expect(page).not.toContain("data-plan-continue");
    expect(page).toContain("date(cancelEffectiveAt)");
    expect(page).toContain('data-billing-operation aria-labelledby="operation-title" role="status" aria-live="polite" hidden=');
    expect(page.match(/data-focus-billing-market/gu)).toHaveLength(1);
    expect(page.match(/data-open-plan-dialog/gu)).toHaveLength(1);
    expect(page.match(/data-open-cancel-dialog/gu)).toHaveLength(1);
    expect(page.match(/data-dialog-feedback/gu)).toHaveLength(1);
    expect(page.match(/data-cancel-feedback/gu)).toHaveLength(1);
    expect(page.match(/data-billing-recent-auth-action/gu)).toHaveLength(3);
    expect(page).toContain('autocomplete="off"');
    expect(page).toContain('merchantCountryPlaceholder: "US"');
    expect(page).toContain("Gói chỉ được kích hoạt sau khi Dodo Payments xác nhận thanh toán.");
    expect(page).toContain("Hạ gói đã được lên lịch cho kỳ gia hạn tiếp theo.");
    expect(controller).not.toContain("renderRequests");
    expect(controller).not.toContain("planContinue");
    expect(controller).toContain("void reviewPlan();");
    expect(controller).toContain('showFeedback(text("operationRejected"), "danger")');
    expect(controller).toContain("handleFailure(error);\n          return;");
    expect(controller).toContain("billingPlanChangeDirection");
    expect(controller).not.toContain('currentPlanCode === "starter" && plan.code === "pro"');
    expect(controller).toContain('failure.code === "billing_provider_request_rejected"');
    expect(page).toContain("invoicesDescription");
    expect(page).not.toContain('class="billing-section-nav"');
    expect(page).toContain('data-billing-disclosure="usage"');
    expect(page).toContain('data-billing-disclosure="invoices"');
    expect(page).toContain('class="billing-disclosure-summary"');
    expect(page).toContain("metric_orders_created");
    expect(page).toContain("billing.scheduledPlanName");
    expect(page).toContain("type BillingPrimaryAction =");
    expect(page).toContain("const primaryAction: BillingPrimaryAction =");
    expect(page).toContain("canManagePayment && !canOpenPortal");
    expect(page).toContain('billing.billingProviderCode === "dodo" ? "Dodo Payments" : pageCopy.paymentNotConfigured');
    expect(page).toContain('role="status" aria-live="polite"');
    expect(page).toContain("Đăng xuất để xác thực lại");
    expect(page).not.toContain("Checkout chưa sẵn sàng");
    expect(page).not.toContain("Subscription không bị thay đổi");
    const operationsRoute = readFileSync("src/pages/api/app/shops/[shopPublicId]/billing/operations.ts", "utf8");
    expect(operationsRoute).toContain("scheduledEffectiveAt: billing.scheduledEffectiveAt");
    expect(operationsRoute).toContain("scheduledPlanCode: billing.scheduledPlanCode");
    expect(operationsRoute).toContain('"cancel_scheduled_plan_change"');
    const portalRoute = readFileSync("src/pages/api/app/shops/[shopPublicId]/billing/portal.ts", "utf8");
    expect(portalRoute).toContain("requireRecentAuth");
    expect(portalRoute).toContain("createTenantBillingPortalSession");
    expect(portalRoute).toContain('const returnUrl = new URL("/app/billing", request.url)');
    expect(portalRoute).toContain('returnUrl.searchParams.set("shop", shopPublicId)');
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
    expect(controller).toContain('querySelectorAll<HTMLButtonElement>("[data-billing-recent-auth-action]")');
    for (const locale of ["en", "vi-VN"] as const) {
      const translate = createDashboardTranslator(locale);
      expect(translate("dashboard.billing.checkout.recent_auth_required").length).toBeGreaterThan(20);
      expect(translate("dashboard.billing.checkout.recent_auth_action").length).toBeGreaterThan(10);
      expect(translate("dashboard.billing.checkout.error_code", { code: "provider_not_ready" })).toContain("provider_not_ready");
      expect(translate("dashboard.billing.checkout.request_id", { requestId: "request-checkout-001" })).toContain("request-checkout-001");
    }
  });
});
