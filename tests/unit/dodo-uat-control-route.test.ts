import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const env: Record<string, unknown> = {};
  return {
    env,
  dodoConfig: { apiBaseUrl: "https://test.dodopayments.com", apiKey: "dodo-test-key-value", environment: "test_mode", webhookSecret: "webhook-test-secret" },
  };
});

vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => state.env }));
vi.mock("../../src/lib/billing/dodo", () => ({ getDodoConfig: () => state.dodoConfig }));

import { hmacToken } from "../../src/lib/core/crypto";
import { POST } from "../../src/pages/api/internal/uat/providers/dodo";

const RELEASE_ID = "stg_20260826T100000Z_aaaaaaaaaaaa";
const WORKER_VERSION = "11111111-1111-4111-8111-111111111111";
const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const MANIFEST_SHA = "c".repeat(64);
const CONTROL_TOKEN = "control-token-value-that-is-long-enough-123456789";

const releaseFields = {
  commitSha: COMMIT_SHA,
  manifestRef: `.wrangler/releases/staging/${RELEASE_ID}/release-manifest.json`,
  manifestSha256: MANIFEST_SHA,
  releaseId: RELEASE_ID,
  treeSha: TREE_SHA,
  workerVersion: WORKER_VERSION,
};

function request(body: Record<string, unknown>, token = CONTROL_TOKEN): Request {
  return new Request("https://staging.selinow.com/api/internal/uat/providers/dodo", {
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    method: "POST",
  });
}

function context(body: Record<string, unknown>, token = CONTROL_TOKEN) {
  return { locals: { requestId: "request-dodo-uat" }, params: {}, request: request(body, token) } as unknown as Parameters<typeof POST>[0];
}

function baseBody(phase: "prepare" | "execute", runId: string | null = null) {
  return { ...releaseFields, phase, provider: "dodo", runId, scenarioId: "plan_catalog_offers", schemaVersion: 1 };
}

beforeEach(() => {
  state.env = {
    APP_ENV: "staging",
    DODO_UAT_COMMIT_SHA: COMMIT_SHA,
    DODO_UAT_CONTROL_TOKEN: CONTROL_TOKEN,
    DODO_UAT_MANIFEST_SHA256: MANIFEST_SHA,
    DODO_UAT_RELEASE_ID: RELEASE_ID,
    DODO_UAT_TREE_SHA: TREE_SHA,
    DODO_UAT_WORKER_VERSION: WORKER_VERSION,
    PLATFORM_DB: { prepare: vi.fn() },
  };
  vi.stubGlobal("fetch", vi.fn());
});

describe("Dodo UAT control route", () => {
  it("rejects missing or invalid control credentials", async () => {
    const missing = await POST(context(baseBody("prepare"), "wrong-token"));
    expect(missing.status).toBe(401);
    state.env.APP_ENV = "production";
    const production = await POST(context(baseBody("prepare")));
    expect(production.status).toBe(409);
  });

  it("creates a candidate-bound run and rejects unsupported scenarios safely", async () => {
    const prepared = await POST(context(baseBody("prepare")));
    expect(prepared.status).toBe(200);
    const preparedBody = await prepared.json<{ runId: string }>();
    expect(preparedBody.runId).toMatch(/^run_/u);
    const unsupported = await POST(context({ ...baseBody("prepare"), scenarioId: "pro_checkout" }));
    expect(unsupported.status).toBe(501);
  });

  it("requires the prepared run signature before executing", async () => {
    const invalid = await POST(context(baseBody("execute", "run_0000000000000_invalid-signature-value")));
    expect(invalid.status).toBe(409);
  });

  it("verifies all four catalog rows against Dodo test mode", async () => {
    const rows = [
      { amountMinor: 99_000, currency: "VND", interval: "month", isActive: 1, marketCode: "vn", planCode: "starter", providerPriceRef: "pdt_starter_vn", taxBehavior: "inclusive" },
      { amountMinor: 299_000, currency: "VND", interval: "month", isActive: 1, marketCode: "vn", planCode: "pro", providerPriceRef: "pdt_pro_vn", taxBehavior: "inclusive" },
      { amountMinor: 500, currency: "USD", interval: "month", isActive: 1, marketCode: "global", planCode: "starter", providerPriceRef: "pdt_starter_global", taxBehavior: "inclusive" },
      { amountMinor: 1_500, currency: "USD", interval: "month", isActive: 1, marketCode: "global", planCode: "pro", providerPriceRef: "pdt_pro_global", taxBehavior: "inclusive" },
    ];
    const prepare = vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: rows }) });
    state.env.PLATFORM_DB = { prepare };
    vi.stubGlobal("fetch", vi.fn((input: string | URL) => {
      const productId = String(input).slice(String(input).lastIndexOf("/") + 1);
      const amount = productId.includes("starter_vn") ? ["VND", 99_000] : productId.includes("pro_vn") ? ["VND", 299_000] : productId.includes("starter_global") ? ["USD", 500] : ["USD", 1_500];
      return Response.json({ is_recurring: true, price: { currency: amount[0], payment_frequency_count: 1, payment_frequency_interval: "month", price: amount[1], tax_inclusive: true, trial_period_days: 0, type: "recurring_price" }, product_id: productId });
    }));
    const prepared = await POST(context(baseBody("prepare")));
    const preparedBody = await prepared.json<{ runId: string }>();
    const executed = await POST(context(baseBody("execute", preparedBody.runId)));
    expect(executed.status).toBe(200);
    await expect(executed.json()).resolves.toMatchObject({ outcome: "catalog_verified", runtimeStatus: 200, scenarioId: "plan_catalog_offers" });
    await expect(hmacToken(CONTROL_TOKEN, "dodo-uat-run:v1", `${RELEASE_ID}:${WORKER_VERSION}:plan_catalog_offers:${String(Date.now())}`)).resolves.toEqual(expect.any(String));
  });
});
