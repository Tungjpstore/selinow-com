import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({ execute: vi.fn(), recent: false }));

vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => ({}) }));
vi.mock("../../src/lib/auth/session", () => ({
    requireCsrfSession: () => Promise.resolve({
      authenticatedAt: dependencies.recent ? new Date().toISOString() : "2020-01-01T00:00:00.000Z",
      csrfTokenHash: "hash",
      displayName: "Owner",
      email: "owner@example.test",
      sessionId: "session-id",
      userId: "owner-id",
    }),
    requireRecentAuth: (auth: { authenticatedAt: string }) => {
      if (Date.now() - Date.parse(auth.authenticatedAt) > 15 * 60_000) throw new AppError("recent_auth_required", 403);
    },
}));
vi.mock("../../src/lib/tenants/customer-management", () => ({
  executeBuyerPrivacyRequest: dependencies.execute,
}));

import { POST } from "../../src/pages/api/app/shops/[shopPublicId]/customers/[customerPublicId]/privacy";

function context() {
  return {
    locals: { requestId: "privacy-route-request" },
    params: {
      customerPublicId: "cus_00000000-0000-4000-8000-000000000001",
      shopPublicId: "shop_00000000-0000-4000-8000-000000000001",
    },
    request: new Request("https://app.example.test/privacy", {
      body: JSON.stringify({ kind: "export" }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": "privacy-route-key" },
      method: "POST",
    }),
  } as unknown as Parameters<typeof POST>[0];
}

describe("buyer privacy route", () => {
  it("requires recent authentication before privacy mutations", async () => {
    dependencies.recent = false;
    dependencies.execute.mockReset();
    const response = await POST(context());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "recent_auth_required", requestId: "privacy-route-request" });
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it("returns only safe application errors with the request ID", async () => {
    dependencies.recent = true;
    dependencies.execute.mockRejectedValueOnce(new AppError("privacy_request_conflict", 409));
    const response = await POST(context());
    expect(await response.json()).toEqual({ code: "privacy_request_conflict", ok: false, requestId: "privacy-route-request" });
  });
});
