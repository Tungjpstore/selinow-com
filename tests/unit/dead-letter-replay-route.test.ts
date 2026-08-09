import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  env: {},
  isAdmin: vi.fn(),
  role: vi.fn(),
  replay: vi.fn(),
  requestRetry: vi.fn(),
  requireCsrf: vi.fn(),
  requireRecentAuth: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.requireRecentAuth,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

vi.mock("../../src/lib/tenants/store", () => ({
  getPlatformAdminRole: dependencies.role,
  isPlatformAdmin: dependencies.isAdmin,
}));

vi.mock("../../src/lib/operations/dead-letters", () => ({
  acknowledgeDeadLetter: dependencies.acknowledge,
  requestDeadLetterRetry: dependencies.requestRetry,
  requestGenericDeadLetterReplay: dependencies.replay,
  resolveDeadLetter: dependencies.resolve,
}));

import { POST } from "../../src/pages/api/admin/operations/dead-letters/[deadLetterId]";

const auth = {
  authenticatedAt: "2026-07-27T00:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Risk Operator",
  email: "risk@example.test",
  sessionId: "session-risk",
  userId: "admin-risk",
};

function context(request: Request) {
  return {
    locals: { requestId: "request-dead-letter-route" },
    params: { deadLetterId: "dlq_route_test" },
    request,
  } as never;
}

beforeEach(() => {
  for (const dependency of [
    dependencies.acknowledge,
    dependencies.isAdmin,
    dependencies.role,
    dependencies.replay,
    dependencies.requestRetry,
    dependencies.requireCsrf,
    dependencies.requireRecentAuth,
    dependencies.resolve,
  ]) dependency.mockReset();
  dependencies.isAdmin.mockResolvedValue(true);
  dependencies.role.mockResolvedValue("risk");
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.replay.mockResolvedValue({
    deadLetter: { id: "dlq_route_test", status: "retry_requested" },
    operationId: "dlr_route_operation",
    replayed: false,
  });
});

describe("dead-letter replay route", () => {
  it("requires CSRF/recent auth and forwards the Idempotency-Key to guarded replay", async () => {
    const response = await POST(context(new Request(
      "https://app.test/api/admin/operations/dead-letters/dlq_route_test",
      {
        body: JSON.stringify({
          action: "replay",
          expectedVersion: 3,
          resolutionCode: "",
          shopId: "shop-route-test",
        }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "dead-letter-route-replay-0001",
        },
        method: "POST",
      },
    )));

    expect(dependencies.requireRecentAuth).toHaveBeenCalledWith(auth);
    expect(dependencies.replay).toHaveBeenCalledWith({
      actorUserId: "admin-risk",
      env: dependencies.env,
      expectedVersion: 3,
      id: "dlq_route_test",
      idempotencyKey: "dead-letter-route-replay-0001",
      requestId: "request-dead-letter-route",
      shopId: "shop-route-test",
    });
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(202);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      operationId: "dlr_route_operation",
      replayed: false,
    });
  });

  it("returns an idempotent replay as 200 and rejects a missing tenant scope before service", async () => {
    dependencies.replay.mockResolvedValueOnce({
      deadLetter: { id: "dlq_route_test", status: "retry_requested" },
      operationId: "dlr_route_operation",
      replayed: true,
    });
    const replay = await POST(context(new Request(
      "https://app.test/api/admin/operations/dead-letters/dlq_route_test",
      {
        body: JSON.stringify({ action: "replay", expectedVersion: 3, shopId: "shop-route-test" }),
        headers: { "Content-Type": "application/json", "Idempotency-Key": "dead-letter-route-replay-0001" },
        method: "POST",
      },
    )));
    expect(replay).toBeInstanceOf(Response);
    if (!(replay instanceof Response)) throw new Error("response_missing");
    expect(replay.status).toBe(200);

    const missingScope = await POST(context(new Request(
      "https://app.test/api/admin/operations/dead-letters/dlq_route_test",
      {
        body: JSON.stringify({ action: "replay", expectedVersion: 3, shopId: null }),
        headers: { "Content-Type": "application/json", "Idempotency-Key": "dead-letter-route-replay-0002" },
        method: "POST",
      },
    )));
    expect(missingScope).toBeInstanceOf(Response);
    if (!(missingScope instanceof Response)) throw new Error("response_missing");
    expect(missingScope.status).toBe(400);
    expect(dependencies.replay).toHaveBeenCalledTimes(1);
  });

  it("denies replay to support admins while preserving acknowledgement access", async () => {
    dependencies.role.mockResolvedValue("support");
    dependencies.acknowledge.mockResolvedValueOnce({ id: "dlq_route_test", status: "acknowledged" });

    const replay = await POST(context(new Request(
      "https://app.test/api/admin/operations/dead-letters/dlq_route_test",
      {
        body: JSON.stringify({ action: "replay", expectedVersion: 3, shopId: "shop-route-test" }),
        headers: { "Content-Type": "application/json", "Idempotency-Key": "dead-letter-route-support-replay" },
        method: "POST",
      },
    )));
    expect(replay).toBeInstanceOf(Response);
    if (!(replay instanceof Response)) throw new Error("response_missing");
    expect(replay.status).toBe(403);
    await expect(replay.json()).resolves.toMatchObject({
      code: "authorization_denied",
      requestId: "request-dead-letter-route",
    });
    expect(dependencies.replay).not.toHaveBeenCalled();

    const acknowledge = await POST(context(new Request(
      "https://app.test/api/admin/operations/dead-letters/dlq_route_test",
      {
        body: JSON.stringify({ action: "acknowledge", expectedVersion: 3, shopId: "shop-route-test" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    )));
    expect(acknowledge).toBeInstanceOf(Response);
    if (!(acknowledge instanceof Response)) throw new Error("response_missing");
    expect(acknowledge.status).toBe(200);
    expect(dependencies.acknowledge).toHaveBeenCalledOnce();
  });
});
