import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  bindings: { PLATFORM_DB: {} },
  publish: vi.fn(),
  recentAuth: vi.fn(),
  csrfSession: vi.fn(),
}));

vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => dependencies.bindings }));
vi.mock("../../src/lib/tenants/storefront-settings", () => ({ publishSellerStorefrontSettings: dependencies.publish }));
vi.mock("../../src/lib/auth/session", () => ({
  requireCsrfSession: dependencies.csrfSession,
  requireRecentAuth: dependencies.recentAuth,
}));
vi.mock("../../src/lib/catalog/policy", () => ({ requireResourceId: (value: string | undefined) => value ?? "" }));

import { POST } from "../../src/pages/api/app/shops/[shopPublicId]/storefront/publish";

const auth = { userId: "user-a" };

function request(): Request {
  return new Request("https://app.selinow.com/api/app/shops/public-a/storefront/publish", {
    body: JSON.stringify({ expectedVersion: 4 }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

beforeEach(() => {
  dependencies.publish.mockReset();
  dependencies.recentAuth.mockReset();
  dependencies.csrfSession.mockReset();
  dependencies.csrfSession.mockResolvedValue(auth);
  dependencies.publish.mockResolvedValue({
    publicationState: "published",
    publishedVersion: 4,
    version: 4,
  });
});

describe("storefront publication route", () => {
  it("requires cookie CSRF/recent auth and forwards the tenant-bound version", async () => {
    const response = await POST({
      locals: { requestId: "request-publish-route" },
      params: { shopPublicId: "public-a" },
      request: request(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(200);
    expect(dependencies.csrfSession).toHaveBeenCalledWith(expect.any(Request), dependencies.bindings);
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth);
    expect(dependencies.publish).toHaveBeenCalledWith({
      env: dependencies.bindings,
      expectedVersion: 4,
      requestId: "request-publish-route",
      shopPublicId: "public-a",
      userId: "user-a",
    });
  });

  it("fails closed before publication when CSRF validation rejects", async () => {
    dependencies.csrfSession.mockRejectedValue(new AppError("csrf_invalid", 403));
    const response = await POST({
      locals: { requestId: "request-publish-csrf" },
      params: { shopPublicId: "public-a" },
      request: request(),
    } as unknown as Parameters<typeof POST>[0]);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "csrf_invalid", ok: false });
    expect(dependencies.recentAuth).not.toHaveBeenCalled();
    expect(dependencies.publish).not.toHaveBeenCalled();
  });
});
