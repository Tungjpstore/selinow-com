import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  check: vi.fn(),
  env: {},
  recentAuth: vi.fn(),
  requireCsrf: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recentAuth,
}));

vi.mock("../../src/lib/domains/store", () => ({
  checkCustomDomain: dependencies.check,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

import { POST } from "../../src/pages/api/app/shops/[shopPublicId]/domains/[domainId]/checks";

const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000001";
const CLAIM_ID = "dcl_00000000-0000-4000-8000-000000000002";
const DOMAIN_ID = "dom_00000000-0000-4000-8000-000000000003";
const auth = {
  authenticatedAt: "2026-07-26T00:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Owner",
  email: "owner@example.test",
  sessionId: "session-a",
  userId: "owner-a",
};

function context(domainId: string) {
  return {
    locals: { requestId: "request-domain-check-route" },
    params: { domainId, shopPublicId: SHOP_PUBLIC_ID },
    request: new Request(`https://dashboard.test/api/app/shops/${SHOP_PUBLIC_ID}/domains/${domainId}/checks`, {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  dependencies.check.mockReset();
  dependencies.recentAuth.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.check.mockResolvedValue({ id: DOMAIN_ID, status: "pending_validation" });
});

describe("custom-domain check route", () => {
  it.each([CLAIM_ID, DOMAIN_ID])("passes supported check target %s to the domain store", async (domainId) => {
    const response = await POST(context(domainId));

    expect(dependencies.check).toHaveBeenCalledWith({
      domainId,
      env: dependencies.env,
      requestId: "request-domain-check-route",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "owner-a",
    });
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(200);
  });

  it("rejects unsupported resource prefixes before reaching the domain store", async () => {
    const response = await POST(context("cat_00000000-0000-4000-8000-000000000004"));

    expect(dependencies.check).not.toHaveBeenCalled();
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(404);
  });
});
