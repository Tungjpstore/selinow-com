import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  admission: vi.fn(),
  authenticate: vi.fn(),
  createShop: vi.fn(),
  env: { PLATFORM_DB: undefined as D1Database | undefined },
  requireCsrf: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  authenticateRequest: dependencies.authenticate,
  requireCsrfSession: dependencies.requireCsrf,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

vi.mock("../../src/lib/tenants/store", () => ({
  createShop: dependencies.createShop,
  getShopCreationAdmission: dependencies.admission,
}));

import { GET, POST } from "../../src/pages/api/app/shops/index";

function routeContext() {
  return {
    locals: { requestId: "request-onboarding-plans" },
    request: new Request("https://app.example.test/api/app/shops"),
  } as unknown as Parameters<typeof GET>[0];
}

describe("onboarding shop route", () => {
  beforeEach(() => {
    dependencies.authenticate.mockReset();
    dependencies.admission.mockReset();
    dependencies.createShop.mockReset();
    dependencies.requireCsrf.mockReset();
    dependencies.authenticate.mockResolvedValue({ userId: "user-a" });
    dependencies.requireCsrf.mockResolvedValue({ userId: "user-a" });
    dependencies.admission.mockResolvedValue({
      allowed: true,
      creationMode: "trial",
      reason: "eligible",
      recoveryShopPublicId: null,
    });

    const plans = [
      { code: "starter", feature_flags_json: "{}", limits_json: "{}", name: "Starter" },
      { code: "pro", feature_flags_json: "{}", limits_json: "{}", name: "Pro" },
    ];
    const offers = [
      { amount_minor: 500, currency: "USD", effective_from: "2026-01-01T00:00:00.000Z", id: "starter-old", interval: "month", market_code: "global", plan_code: "starter", provider_code: "dodo", provider_price_ref: "price_starter_old", version: 1 },
      { amount_minor: 700, currency: "USD", effective_from: "2026-08-01T00:00:00.000Z", id: "starter-new", interval: "month", market_code: "global", plan_code: "starter", provider_code: "dodo", provider_price_ref: "price_starter_new", version: 2 },
      { amount_minor: 900, currency: "VND", effective_from: "2026-07-01T00:00:00.000Z", id: "starter-vn-ready", interval: "month", market_code: "vn", plan_code: "starter", provider_code: "dodo", provider_price_ref: "price_starter_vn", version: 1 },
      { amount_minor: 950, currency: "VND", effective_from: "2026-08-01T00:00:00.000Z", id: "starter-pending", interval: "month", market_code: "vn", plan_code: "starter", provider_code: "dodo", provider_price_ref: "pending:dodo:starter", version: 2 },
      { amount_minor: 8000, currency: "USD", effective_from: "2026-08-01T00:00:00.000Z", id: "starter-year", interval: "year", market_code: "global", plan_code: "starter", provider_code: "dodo", provider_price_ref: "price_starter_year", version: 1 },
      { amount_minor: 1500, currency: "USD", effective_from: "2026-08-01T00:00:00.000Z", id: "pro-wrong-provider", interval: "month", market_code: "global", plan_code: "pro", provider_code: "payos", provider_price_ref: "price_pro_payos", version: 2 },
      { amount_minor: 1700, currency: "USD", effective_from: "2026-08-02T00:00:00.000Z", id: "pro-ready", interval: "month", market_code: "global", plan_code: "pro", provider_code: "dodo", provider_price_ref: "price_pro_ready", version: 3 },
      { amount_minor: 420000, currency: "VND", effective_from: "2026-07-01T00:00:00.000Z", id: "pro-vn-ready", interval: "month", market_code: "vn", plan_code: "pro", provider_code: "dodo", provider_price_ref: "price_pro_vn", version: 1 },
      { amount_minor: 440000, currency: "VND", effective_from: "2026-08-01T00:00:00.000Z", id: "pro-vn-wrong-provider", interval: "month", market_code: "vn", plan_code: "pro", provider_code: "payos", provider_price_ref: "price_pro_vn_payos", version: 2 },
    ];
    dependencies.env.PLATFORM_DB = {
      prepare(sql: string) {
        return {
          bind() { return this; },
          all: () => Promise.resolve({ results: sql.includes("FROM plan_prices") ? offers : plans }),
        } as unknown as D1PreparedStatement;
      },
    } as unknown as D1Database;
  });

  it("returns only the latest activation-ready Dodo offer for each plan market", async () => {
    const response = await GET(routeContext());
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    const body: { plans: Array<{ code: string; offers: unknown[] }> } = await response.json();

    expect(body.plans).toEqual([
      {
        code: "starter",
        features: {},
        limits: {},
        name: "Starter",
        offers: [{ amountMinor: 700, currency: "USD", interval: "month", marketCode: "global" }],
      },
      {
        code: "pro",
        features: {},
        limits: {},
        name: "Pro",
        offers: [{ amountMinor: 1700, currency: "USD", interval: "month", marketCode: "global" }],
      },
    ]);
  });

  it("forwards one-request provisioning fields to createShop (OB-B1)", async () => {
    dependencies.createShop.mockResolvedValue({
      created: true,
      shop: { publicId: "shop_new", slug: "tiem-key" },
    });
    const response = await POST({
      ...routeContext(),
      request: new Request("https://app.example.test/api/app/shops", {
        body: JSON.stringify({
          channels: { customDomainPreference: "later", telegramEnabled: true, websiteEnabled: true },
          currency: "VND",
          defaultLocale: "vi-VN",
          name: "Tiệm Key",
          planCode: "starter",
          slug: "tiem-key",
          templateId: "swift",
          vertical: "physical",
        }),
        headers: { "Content-Type": "application/json", "Idempotency-Key": "shop-create-test-0001" },
        method: "POST",
      }),
    });
    expect(response.status).toBe(201);
    expect(dependencies.createShop).toHaveBeenCalledWith(expect.objectContaining({
      channels: { customDomainPreference: "later", telegramEnabled: true, websiteEnabled: true },
      currency: "VND",
      name: "Tiệm Key",
      planCode: "starter",
      slug: "tiem-key",
      templateId: "swift",
      vertical: "physical",
    }));
  });

  it("still creates shops without the extended provisioning fields", async () => {
    dependencies.createShop.mockResolvedValue({
      created: true,
      shop: { publicId: "shop_plain", slug: "cua-hang" },
    });
    const response = await POST({
      ...routeContext(),
      request: new Request("https://app.example.test/api/app/shops", {
        body: JSON.stringify({ name: "Cửa Hàng", planCode: "starter", slug: "cua-hang" }),
        headers: { "Content-Type": "application/json", "Idempotency-Key": "shop-create-test-0002" },
        method: "POST",
      }),
    });
    expect(response.status).toBe(201);
    const rawCall: unknown = dependencies.createShop.mock.calls[0]?.[0];
    const call = rawCall as { channels?: unknown; templateId?: unknown; vertical?: unknown } | undefined;
    expect(call?.channels).toBeUndefined();
    expect(call?.templateId).toBeUndefined();
    expect(call?.vertical).toBeUndefined();
  });

  it("rejects malformed channel payloads before provisioning", async () => {
    const response = await POST({
      ...routeContext(),
      request: new Request("https://app.example.test/api/app/shops", {
        body: JSON.stringify({
          channels: { telegramEnabled: "yes", websiteEnabled: true },
          name: "Cửa Hàng",
          planCode: "starter",
          slug: "cua-hang",
        }),
        headers: { "Content-Type": "application/json", "Idempotency-Key": "shop-create-test-0003" },
        method: "POST",
      }),
    });
    expect(response.status).toBe(400);
    const body: { issues?: string[] } = await response.json();
    expect(body.issues).toContain("channels_invalid");
    expect(dependencies.createShop).not.toHaveBeenCalled();
  });
});
