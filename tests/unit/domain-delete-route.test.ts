import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  deleteDomain: vi.fn(),
  env: {},
  recentAuth: vi.fn(),
  requireCsrf: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recentAuth,
}));

vi.mock("../../src/lib/domains/store", () => ({
  deleteCustomDomain: dependencies.deleteDomain,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

import { DELETE } from "../../src/pages/api/app/shops/[shopPublicId]/domains/[domainId]";

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
    locals: { requestId: "request-domain-delete-route" },
    params: { domainId, shopPublicId: SHOP_PUBLIC_ID },
    request: new Request(`https://dashboard.test/api/app/shops/${SHOP_PUBLIC_ID}/domains/${domainId}`, {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "DELETE",
    }),
  } as unknown as Parameters<typeof DELETE>[0];
}

beforeEach(() => {
  dependencies.deleteDomain.mockReset();
  dependencies.recentAuth.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.deleteDomain.mockResolvedValue(undefined);
});

describe("custom-domain delete route", () => {
  it.each([CLAIM_ID, DOMAIN_ID])("accepts supported target %s", async (domainId) => {
    const response = await DELETE(context(domainId));

    expect(dependencies.deleteDomain).toHaveBeenCalledWith({
      domainId,
      env: dependencies.env,
      requestId: "request-domain-delete-route",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "owner-a",
    });
    expect(response.status).toBe(204);
  });

  it("rejects unsupported resource prefixes before reaching the domain store", async () => {
    const response = await DELETE(context("cat_00000000-0000-4000-8000-000000000004"));

    expect(dependencies.deleteDomain).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
  });
});
