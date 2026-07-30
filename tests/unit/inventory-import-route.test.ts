import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  confirm: vi.fn(),
  env: {},
  recentAuth: vi.fn(),
  requireCsrf: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recentAuth,
}));

vi.mock("../../src/lib/catalog/store", () => ({
  confirmInventoryImport: dependencies.confirm,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

import { POST } from "../../src/pages/api/app/shops/[shopPublicId]/variants/[variantId]/inventory/import";

const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000001";
const VARIANT_ID = "var_00000000-0000-4000-8000-000000000001";
const auth = {
  authenticatedAt: "2026-07-26T00:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Owner",
  email: "owner@example.test",
  sessionId: "session-a",
  userId: "owner-a",
};

function context(body: Record<string, unknown>) {
  return {
    locals: { requestId: "request-inventory-route" },
    params: { shopPublicId: SHOP_PUBLIC_ID, variantId: VARIANT_ID },
    request: new Request(`https://dashboard.test/api/app/shops/${SHOP_PUBLIC_ID}/variants/${VARIANT_ID}/inventory/import`, {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "inventory-route-0001",
      },
      method: "POST",
    }),
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  dependencies.confirm.mockReset();
  dependencies.recentAuth.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.requireCsrf.mockResolvedValue(auth);
});

describe("inventory import route", () => {
  it("rejects a direct import without a preview token before any inventory mutation", async () => {
    const response = await POST(context({ data: "KEY-WITHOUT-PREVIEW", filename: null, source: "paste" }));

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "inventory_preview_invalid", ok: false });
    expect(dependencies.confirm).not.toHaveBeenCalled();
    expect(dependencies.requireCsrf).toHaveBeenCalledOnce();
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth);
  });
});
