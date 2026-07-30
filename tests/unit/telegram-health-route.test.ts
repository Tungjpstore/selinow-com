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

vi.mock("../../src/lib/telegram/integrations", () => ({
  refreshTelegramHealth: dependencies.refresh,
}));

import { POST } from "../../src/pages/api/app/shops/[shopPublicId]/integrations/telegram/health-checks";

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
    locals: { requestId: "request-telegram-health-route" },
    params: { shopPublicId: SHOP_PUBLIC_ID },
    request: new Request(`https://dashboard.test/api/app/shops/${SHOP_PUBLIC_ID}/integrations/telegram/health-checks`, { method: "POST" }),
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  dependencies.recentAuth.mockReset();
  dependencies.refresh.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.refresh.mockResolvedValue({
    bot: { displayName: "Shop Bot", id: "123456789", username: "shop_bot" },
    connectedAt: "2026-07-26T00:00:00.000Z",
    lastCheckedAt: "2026-07-26T00:00:00.000Z",
    lastHealthUpdateAt: null,
    lastOutboundAt: null,
    lastSafeErrorCode: null,
    lastUpdateAt: null,
    pendingUpdateCount: 0,
    provider: "telegram",
    publicId: "telegram-public-a",
    status: "active",
    webhookStatus: "verified",
  });
});

describe("Telegram health route security", () => {
  it("requires CSRF and recent authentication before retrying with retained credentials", async () => {
    const response = await POST(context());

    expect(dependencies.requireCsrf).toHaveBeenCalledOnce();
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth);
    expect(dependencies.refresh).toHaveBeenCalledWith({
      env: dependencies.env,
      requestId: "request-telegram-health-route",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "owner-a",
    });
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(await response.text()).not.toContain("bot-token");
  });

  it("does not reach the service when recent authentication is stale", async () => {
    dependencies.recentAuth.mockImplementation(() => { throw new AppError("recent_auth_required", 403); });

    const response = await POST(context());

    expect(dependencies.refresh).not.toHaveBeenCalled();
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(403);
  });
});
