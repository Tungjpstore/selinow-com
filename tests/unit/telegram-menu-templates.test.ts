import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  env: { PLATFORM_DB: {} },
  getTelegramIntegration: vi.fn(),
  requireCsrf: vi.fn(),
  updateTelegramMenuConfig: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  authenticateRequest: dependencies.authenticateRequest,
  requireCsrfSession: dependencies.requireCsrf,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

vi.mock("../../src/lib/telegram/integrations", () => ({
  getTelegramIntegration: dependencies.getTelegramIntegration,
  updateTelegramMenuConfig: dependencies.updateTelegramMenuConfig,
}));

import { GET, POST } from "../../src/pages/api/app/shops/[shopPublicId]/integrations/telegram/menu";

const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000001";
const auth = {
  authenticatedAt: "2026-07-26T00:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Owner",
  email: "owner@example.test",
  sessionId: "session-a",
  userId: "owner-a",
};

function getContext() {
  return {
    locals: { requestId: "request-telegram-menu-get" },
    params: { shopPublicId: SHOP_PUBLIC_ID },
    request: new Request(`https://dashboard.test/api/app/shops/${SHOP_PUBLIC_ID}/integrations/telegram/menu`, { method: "GET" }),
  } as unknown as Parameters<typeof GET>[0];
}

function postContext(body: Record<string, unknown>) {
  return {
    locals: { requestId: "request-telegram-menu-post" },
    params: { shopPublicId: SHOP_PUBLIC_ID },
    request: new Request(`https://dashboard.test/api/app/shops/${SHOP_PUBLIC_ID}/integrations/telegram/menu`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  } as unknown as Parameters<typeof POST>[0];
}

describe("Telegram menu templates API route", () => {
  beforeEach(() => {
    dependencies.authenticateRequest.mockReset();
    dependencies.getTelegramIntegration.mockReset();
    dependencies.requireCsrf.mockReset();
    dependencies.updateTelegramMenuConfig.mockReset();

    dependencies.authenticateRequest.mockResolvedValue(auth);
    dependencies.requireCsrf.mockResolvedValue(auth);
  });

  it("returns 404 when telegram is not configured on GET", async () => {
    dependencies.getTelegramIntegration.mockResolvedValue(null);

    const response = await GET(getContext());
    expect(response.status).toBe(404);
  });

  it("returns current template configuration on GET", async () => {
    dependencies.getTelegramIntegration.mockResolvedValue({
      menuConfigJson: null,
      supportHandle: "@admin_gamer",
      templatePreset: "gaming_topup",
      welcomeMessageCustom: "Chào game thủ!",
    });

    const response = await GET(getContext());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      menuConfig: {
        supportHandle: "@admin_gamer",
        templatePreset: "gaming_topup",
        welcomeMessageCustom: "Chào game thủ!",
      },
    });
  });

  it("updates template configuration on POST", async () => {
    dependencies.updateTelegramMenuConfig.mockResolvedValue({
      publicId: "tg-int-1",
      supportHandle: "@support_slot",
      templatePreset: "subscription_slots",
      welcomeMessageCustom: "Chào bạn đến với shop Netflix!",
    });

    const response = await POST(
      postContext({
        supportHandle: "@support_slot",
        templatePreset: "subscription_slots",
        welcomeMessageCustom: "Chào bạn đến với shop Netflix!",
      })
    );

    expect(response.status).toBe(200);
    expect(dependencies.updateTelegramMenuConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        shopPublicId: SHOP_PUBLIC_ID,
        supportHandle: "@support_slot",
        templatePreset: "subscription_slots",
        userId: "owner-a",
        welcomeMessageCustom: "Chào bạn đến với shop Netflix!",
      })
    );
  });
});
