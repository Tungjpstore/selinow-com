import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  env: {},
  recentAuth: vi.fn(),
  refresh: vi.fn(),
  requireCsrf: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recentAuth,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

vi.mock("../../src/lib/payments/integrations", () => ({
  refreshPayOSHealth: dependencies.refresh,
}));

import { POST } from "../../src/pages/api/app/shops/[shopPublicId]/payments/payos/health-checks";

const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000001";

const auth = {
  authenticatedAt: "2026-07-26T00:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Owner",
  email: "owner@example.test",
  sessionId: "session-a",
  userId: "owner-a",
};

function context() {
  return {
    locals: { requestId: "request-health-route" },
    params: { shopPublicId: SHOP_PUBLIC_ID },
    request: new Request(`https://dashboard.test/api/app/shops/${SHOP_PUBLIC_ID}/payments/payos/health-checks`, { method: "POST" }),
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  dependencies.recentAuth.mockReset();
  dependencies.refresh.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.refresh.mockResolvedValue({
    connectedAt: "2026-07-25T00:00:00.000Z",
    lastCheckedAt: "2026-07-26T00:00:00.000Z",
    lastSafeErrorCode: null,
    lastWebhookVerifiedAt: "2026-07-26T00:00:00.000Z",
    provider: "payos",
    publicId: "payos-public-a",
    status: "active",
    webhookStatus: "verified",
  });
});

describe("PayOS health route security", () => {
  it("requires CSRF session and recent authentication before refreshing", async () => {
    const response = await POST(context());

    expect(dependencies.requireCsrf).toHaveBeenCalledOnce();
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth);
    expect(dependencies.refresh).toHaveBeenCalledWith({
      env: dependencies.env,
      requestId: "request-health-route",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "owner-a",
    });
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
  });

  it("does not reach the provider service when CSRF validation fails", async () => {
    dependencies.requireCsrf.mockRejectedValue(new AppError("csrf_invalid", 403));

    const response = await POST(context());

    expect(dependencies.recentAuth).not.toHaveBeenCalled();
    expect(dependencies.refresh).not.toHaveBeenCalled();
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(403);
  });

  it("does not reach the provider service when recent authentication is stale", async () => {
    dependencies.recentAuth.mockImplementation(() => { throw new AppError("recent_auth_required", 403); });

    const response = await POST(context());

    expect(dependencies.refresh).not.toHaveBeenCalled();
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(403);
  });
});
