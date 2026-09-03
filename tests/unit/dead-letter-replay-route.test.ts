import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  env: {},
  generatedRetry: vi.fn(),
  rateGuard: vi.fn(),
  replay: vi.fn(),
  requestRetry: vi.fn(),
  requireAccess: vi.fn(),
  requireCsrf: vi.fn(),
  requireRecentAuth: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.requireRecentAuth,
}));

vi.mock("../../src/lib/http/admin-rate-limit", () => ({
  guardAdminMutationRate: dependencies.rateGuard,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

vi.mock("../../src/lib/tenants/store", () => ({
  requirePlatformAdminApiAccess: dependencies.requireAccess,
}));

vi.mock("../../src/lib/operations/dead-letters", () => ({
  acknowledgeDeadLetter: dependencies.acknowledge,
  requestDeadLetterRetry: dependencies.requestRetry,
  requestGeneratedLicenseDeadLetterRetry: dependencies.generatedRetry,
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

function context(request: Request, deadLetterId = "dlq_route_test") {
  return {
    locals: { requestId: "request-dead-letter-route" },
    params: { deadLetterId },
    request,
  } as never;
}

beforeEach(() => {
  for (const dependency of [
    dependencies.acknowledge,
    dependencies.generatedRetry,
    dependencies.rateGuard,
    dependencies.replay,
    dependencies.requestRetry,
    dependencies.requireAccess,
    dependencies.requireCsrf,
    dependencies.requireRecentAuth,
    dependencies.resolve,
  ]) dependency.mockReset();
  dependencies.rateGuard.mockResolvedValue(undefined);
  dependencies.requireAccess.mockResolvedValue("risk");
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.replay.mockResolvedValue({
    deadLetter: { id: "dlq_route_test", status: "retry_requested" },
    operationId: "dlr_route_operation",
    replayed: false,
  });
  dependencies.generatedRetry.mockResolvedValue({
    deadLetter: { id: "gld_route_test", status: "retry_requested" },
    operationId: "gld_route_operation",
    replayed: false,
  });
});

describe("dead-letter replay route", () => {
  it("forwards generated-license retry requests through the owner/risk guarded service", async () => {
    const response = await POST(context(new Request(
      "https://app.test/api/admin/operations/dead-letters/gld_route_test",
      {
        body: JSON.stringify({
          action: "retry_generated_license",
          shopId: "shop-route-test",
        }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "generated-license-route-retry-0001",
        },
        method: "POST",
      },
    ), "gld_route_test"));

    expect(dependencies.generatedRetry).toHaveBeenCalledWith({
      actorUserId: "admin-risk",
      env: dependencies.env,
      id: "gld_route_test",
      idempotencyKey: "generated-license-route-retry-0001",
      requestId: "request-dead-letter-route",
      shopId: "shop-route-test",
    });
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      operationId: "gld_route_operation",
      replayed: false,
    });
  });

  it("rejects generated-license retry without a shop scope or for support admins", async () => {
    const missingScope = await POST(context(new Request(
      "https://app.test/api/admin/operations/dead-letters/gld_route_test",
      {
        body: JSON.stringify({ action: "retry_generated_license", shopId: null }),
        headers: { "Content-Type": "application/json", "Idempotency-Key": "generated-license-route-retry-0002" },
        method: "POST",
      },
    ), "gld_route_test"));
    expect(missingScope).toBeInstanceOf(Response);
    if (!(missingScope instanceof Response)) throw new Error("response_missing");
    expect(missingScope.status).toBe(400);
    expect(dependencies.generatedRetry).not.toHaveBeenCalled();

    dependencies.requireAccess.mockResolvedValue("support");
    const denied = await POST(context(new Request(
      "https://app.test/api/admin/operations/dead-letters/gld_route_test",
      {
        body: JSON.stringify({ action: "retry_generated_license", shopId: "shop-route-test" }),
        headers: { "Content-Type": "application/json", "Idempotency-Key": "generated-license-route-retry-0003" },
        method: "POST",
      },
    ), "gld_route_test"));
    expect(denied).toBeInstanceOf(Response);
    if (!(denied instanceof Response)) throw new Error("response_missing");
    expect(denied.status).toBe(403);
    expect(dependencies.generatedRetry).not.toHaveBeenCalled();
  });

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

    expect(dependencies.requireRecentAuth).toHaveBeenCalledWith(auth, 5);
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
    dependencies.requireAccess.mockResolvedValue("support");
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

  it("surfaces admin_two_factor_required when the 2FA-aware guard rejects an un-enrolled admin", async () => {
    dependencies.requireAccess.mockRejectedValueOnce(new AppError("admin_two_factor_required", 403));
    const response = await POST(context(new Request(
      "https://app.test/api/admin/operations/dead-letters/dlq_route_test",
      {
        body: JSON.stringify({ action: "acknowledge", expectedVersion: 3, shopId: "shop-route-test" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    )));
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "admin_two_factor_required",
      requestId: "request-dead-letter-route",
    });
    expect(dependencies.acknowledge).not.toHaveBeenCalled();
  });
});
