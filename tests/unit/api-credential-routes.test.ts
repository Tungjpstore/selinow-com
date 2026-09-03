import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  authenticateApi: vi.fn(),
  recordPublicApiUsage: vi.fn(),
  authenticateSession: vi.fn(),
  env: {},
  issue: vi.fn(),
  list: vi.fn(),
  parseCreate: vi.fn(),
  parseRevoke: vi.fn(),
  recentAuth: vi.fn(),
  requireCsrf: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  authenticateRequest: dependencies.authenticateSession,
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recentAuth,
}));

vi.mock("../../src/lib/api/credentials", () => ({
  authenticatePublicApiRequest: dependencies.authenticateApi,
  recordPublicApiUsage: dependencies.recordPublicApiUsage,
  issueApiCredential: dependencies.issue,
  listApiCredentials: dependencies.list,
  parseApiCredentialCreateInput: dependencies.parseCreate,
  parseApiCredentialRevokeInput: dependencies.parseRevoke,
  revokeApiCredential: dependencies.revoke,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

import { DELETE as revokeRoute } from "../../src/pages/api/app/shops/[shopPublicId]/api-credentials/[credentialPublicId]";
import { GET as listRoute, POST as issueRoute } from "../../src/pages/api/app/shops/[shopPublicId]/api-credentials";
import { GET as publicShopRoute } from "../../src/pages/api/v1/shop";

const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000001";
const CREDENTIAL_PUBLIC_ID = "akc_00000000-0000-4000-8000-000000000002";
const SENSITIVE_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;
const auth = {
  authenticatedAt: "2026-07-29T06:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Owner",
  email: "owner@example.test",
  sessionId: "session-a",
  userId: "user-owner-a",
};
const credential = {
  createdAt: "2026-07-29T06:00:00.000Z",
  expiresAt: null,
  lastUsedAt: null,
  name: "Warehouse sync",
  publicId: CREDENTIAL_PUBLIC_ID,
  revokedAt: null,
  scopes: ["shop:read"],
  status: "active",
  version: 1,
};

function context(input: {
  body?: unknown;
  headers?: Record<string, string>;
  method?: "DELETE" | "GET" | "POST";
  params?: Record<string, string>;
  path: string;
}) {
  const headers = new Headers(input.headers);
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return {
    locals: { requestId: "request-api-credential-route" },
    params: input.params ?? {},
    request: new Request(`https://api.example.test${input.path}`, {
      ...(body === undefined ? {} : { body }),
      headers,
      method: input.method ?? "GET",
    }),
  };
}

function expectSensitiveResponseHeaders(response: Response): void {
  for (const [name, value] of Object.entries(SENSITIVE_RESPONSE_HEADERS)) {
    expect(response.headers.get(name), name).toBe(value);
  }
}

beforeEach(() => {
  dependencies.authenticateApi.mockReset();
  dependencies.recordPublicApiUsage.mockReset();
  dependencies.authenticateSession.mockReset();
  dependencies.issue.mockReset();
  dependencies.list.mockReset();
  dependencies.parseCreate.mockReset();
  dependencies.parseRevoke.mockReset();
  dependencies.recentAuth.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.revoke.mockReset();
  dependencies.authenticateSession.mockResolvedValue(auth);
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.list.mockResolvedValue([credential]);
  dependencies.parseCreate.mockImplementation((body: Record<string, unknown>) => ({
    expiresAt: body.expiresAt ?? null,
    name: body.name,
    scopes: body.scopes,
  }));
  dependencies.parseRevoke.mockImplementation((body: Record<string, unknown>) => ({
    expectedVersion: body.expectedVersion,
    reasonCode: body.reasonCode,
  }));
  dependencies.issue.mockResolvedValue({
    credential,
    replayed: false,
    token: "sln_local_one-time-token",
    tokenAvailable: true,
  });
  dependencies.revoke.mockResolvedValue({
    ...credential,
    revokedAt: "2026-07-29T06:01:00.000Z",
    status: "revoked",
    version: 2,
  });
  dependencies.authenticateApi.mockResolvedValue({
    credentialPublicId: CREDENTIAL_PUBLIC_ID,
    rateLimit: { limit: 60, remaining: 59, resetAt: "2026-07-29T06:01:00.000Z" },
    shop: {
      currency: "VND",
      defaultLocale: "vi-VN",
      name: "Warehouse",
      publicId: SHOP_PUBLIC_ID,
      status: "active",
      timezone: "Asia/Ho_Chi_Minh",
    },
    shopId: "shop-a",
  });
  dependencies.recordPublicApiUsage.mockResolvedValue(undefined);
});

describe("API credential management routes", () => {
  it("requires recent session authentication even for the security-sensitive list", async () => {
    const response = await listRoute(context({
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/api-credentials`,
    }) as never);
    expect(dependencies.authenticateSession).toHaveBeenCalledWith(expect.any(Request), dependencies.env);
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth, 5);
    expect(dependencies.list).toHaveBeenCalledWith({
      env: dependencies.env,
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "user-owner-a",
    });
    expect(response.status).toBe(200);
    expectSensitiveResponseHeaders(response);
  });

  it("issues only after CSRF/recent auth and binds actor plus tenant from session/path", async () => {
    const response = await issueRoute(context({
      body: { expiresAt: null, name: "Warehouse sync", scopes: ["shop:read"] },
      headers: { "Idempotency-Key": "api-credential-create-001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/api-credentials`,
    }) as never);
    expect(dependencies.requireCsrf).toHaveBeenCalledWith(expect.any(Request), dependencies.env);
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth, 5);
    expect(dependencies.issue).toHaveBeenCalledWith({
      env: dependencies.env,
      expiresAt: null,
      idempotencyKey: "api-credential-create-001",
      name: "Warehouse sync",
      requestId: "request-api-credential-route",
      scopes: ["shop:read"],
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "user-owner-a",
    });
    expect(response.status).toBe(201);
    expectSensitiveResponseHeaders(response);
  });

  it("rejects actor/tenant overrides and does not call issuance", async () => {
    const response = await issueRoute(context({
      body: {
        name: "Warehouse sync",
        scopes: ["shop:read"],
        shopId: "shop-b",
        userId: "user-b",
      },
      headers: { "Idempotency-Key": "api-credential-create-001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/api-credentials`,
    }) as never);
    expect(response.status).toBe(400);
    expectSensitiveResponseHeaders(response);
    expect(dependencies.issue).not.toHaveBeenCalled();
  });

  it("revokes with optimistic version and safe reason after CSRF/recent auth", async () => {
    const response = await revokeRoute(context({
      body: { expectedVersion: 1, reasonCode: "seller_revoked" },
      headers: { "Idempotency-Key": "api-credential-revoke-001" },
      method: "DELETE",
      params: { credentialPublicId: CREDENTIAL_PUBLIC_ID, shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/api-credentials/${CREDENTIAL_PUBLIC_ID}`,
    }) as never);
    expect(dependencies.requireCsrf).toHaveBeenCalledWith(expect.any(Request), dependencies.env);
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth, 5);
    expect(dependencies.revoke).toHaveBeenCalledWith({
      credentialPublicId: CREDENTIAL_PUBLIC_ID,
      env: dependencies.env,
      expectedVersion: 1,
      idempotencyKey: "api-credential-revoke-001",
      reasonCode: "seller_revoked",
      requestId: "request-api-credential-route",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "user-owner-a",
    });
    expect(response.status).toBe(200);
    expectSensitiveResponseHeaders(response);
  });

  it("keeps sensitive headers on caught list, issue and revoke errors", async () => {
    const authenticationError = new AppError("authentication_required", 401);
    dependencies.authenticateSession.mockRejectedValueOnce(authenticationError);
    const listResponse = await listRoute(context({
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/api-credentials`,
    }) as never);

    dependencies.requireCsrf.mockRejectedValueOnce(authenticationError);
    const issueResponse = await issueRoute(context({
      body: { name: "Warehouse sync", scopes: ["shop:read"] },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/api-credentials`,
    }) as never);

    dependencies.requireCsrf.mockRejectedValueOnce(authenticationError);
    const revokeResponse = await revokeRoute(context({
      body: { expectedVersion: 1, reasonCode: "seller_revoked" },
      method: "DELETE",
      params: { credentialPublicId: CREDENTIAL_PUBLIC_ID, shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/api-credentials/${CREDENTIAL_PUBLIC_ID}`,
    }) as never);

    for (const response of [listResponse, issueResponse, revokeResponse]) {
      expect(response.status).toBe(401);
      expectSensitiveResponseHeaders(response);
    }
  });
});

describe("public API v1 route", () => {
  it("derives the response shop from authenticated credential context and sends rate headers", async () => {
    const response = await publicShopRoute(context({
      headers: { Authorization: "Bearer opaque-token" },
      path: "/api/v1/shop?shopPublicId=shop-attacker",
    }) as never);
    expect(dependencies.authenticateApi).toHaveBeenCalledOnce();
    const payload: unknown = await response.json();
    expect(payload).toEqual({
      data: {
        shop: {
          currency: "VND",
          defaultLocale: "vi-VN",
          name: "Warehouse",
          publicId: SHOP_PUBLIC_ID,
          status: "active",
          timezone: "Asia/Ho_Chi_Minh",
        },
      },
      ok: true,
      requestId: "request-api-credential-route",
    });
    expect(response.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("59");
  });

  it("returns retry guidance on fixed-window admission failure", async () => {
    dependencies.authenticateApi.mockRejectedValueOnce(new AppError("rate_limited", 429));
    const response = await publicShopRoute(context({ path: "/api/v1/shop" }) as never);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
  });
});
