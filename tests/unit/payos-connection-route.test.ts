import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  connect: vi.fn(),
  env: {},
  recentAuth: vi.fn(),
  requireCsrf: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  authenticateRequest: vi.fn(),
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recentAuth,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

vi.mock("../../src/lib/payments/integrations", () => ({
  connectPayOS: dependencies.connect,
  disconnectPayOS: vi.fn(),
  getPaymentIntegration: vi.fn(),
}));

import { PUT } from "../../src/pages/api/app/shops/[shopPublicId]/payments/payos";

const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "request-payos-connect";
const credentials = {
  apiKey: "api-key-test-value",
  checksumKey: "checksum-key-test-value",
  clientId: "client-id-test-value",
};
const auth = {
  authenticatedAt: "2026-08-09T00:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Owner",
  email: "owner@example.test",
  sessionId: "session-a",
  userId: "owner-a",
};

function context() {
  return {
    locals: { requestId: REQUEST_ID },
    params: { shopPublicId: SHOP_PUBLIC_ID },
    request: new Request(`https://dashboard.test/api/app/shops/${SHOP_PUBLIC_ID}/payments/payos`, {
      body: JSON.stringify(credentials),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    }),
  } as unknown as Parameters<typeof PUT>[0];
}

beforeEach(() => {
  dependencies.connect.mockReset();
  dependencies.recentAuth.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.requireCsrf.mockResolvedValue(auth);
});

describe("PayOS connection route", () => {
  it.each([
    ["subscription_payment_required", 402],
    ["subscription_grace_expired", 402],
    ["provider_not_ready", 402],
  ])("preserves the safe entitlement failure %s", async (code, status) => {
    dependencies.connect.mockRejectedValue(new AppError(code, status));

    const response = await PUT(context());
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");

    const body = await response.text();
    expect(response.status).toBe(status);
    expect(JSON.parse(body)).toEqual({ code, ok: false, requestId: REQUEST_ID });
    expect(body).not.toContain(credentials.clientId);
    expect(body).not.toContain(credentials.apiKey);
    expect(body).not.toContain(credentials.checksumKey);
  });

  it("returns the safe staging admission code and request ID without reflecting credentials", async () => {
    dependencies.connect.mockRejectedValue(new AppError("payment_provider_environment_not_admitted", 409));

    const response = await PUT(context());
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");

    const body = await response.text();
    expect(response.status).toBe(409);
    expect(JSON.parse(body)).toEqual({
      code: "payment_provider_environment_not_admitted",
      ok: false,
      requestId: REQUEST_ID,
    });
    expect(body).not.toContain(credentials.clientId);
    expect(body).not.toContain(credentials.apiKey);
    expect(body).not.toContain(credentials.checksumKey);
  });
});
