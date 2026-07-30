import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  authenticate: vi.fn(),
  create: vi.fn(),
  env: {},
  list: vi.fn(),
  process: vi.fn(),
  recentAuth: vi.fn(),
  requireCsrf: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  authenticateRequest: dependencies.authenticate,
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recentAuth,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

vi.mock("../../src/lib/operations/rotation-operator", () => ({
  createOperatorEncryptionRotation: dependencies.create,
  listEncryptionRotationRuns: dependencies.list,
  parseRotationKeyFamily: (value: unknown) => value,
  parseRotationLimit: (value: unknown) => value,
  parseRotationScope: (value: unknown) => value,
  parseRotationVersion: (value: unknown) => value,
  processOperatorEncryptionRotation: dependencies.process,
}));

import { GET, POST as CREATE } from "../../src/pages/api/admin/operations/rotations/index";
import { POST as PROCESS } from "../../src/pages/api/admin/operations/rotations/[runId]/process";

const auth = {
  authenticatedAt: "2026-07-26T00:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Owner",
  email: "owner@example.test",
  sessionId: "session-a",
  userId: "admin-owner",
};

function context(request: Request, params: Record<string, string> = {}) {
  return { locals: { requestId: "request-rotation-route" }, params, request } as never;
}

beforeEach(() => {
  for (const dependency of [
    dependencies.authenticate,
    dependencies.create,
    dependencies.list,
    dependencies.process,
    dependencies.recentAuth,
    dependencies.requireCsrf,
  ]) dependency.mockReset();
  dependencies.authenticate.mockResolvedValue(auth);
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.list.mockResolvedValue({ canOperate: true, runs: [] });
  dependencies.create.mockResolvedValue({ completed: true, failedItems: 0, oldVersionRows: 0, processedItems: 0, runId: "rot_test", status: "completed", totalItems: 0 });
  dependencies.process.mockResolvedValue({ completed: true, failedItems: 0, oldVersionRows: 0, processedItems: 0, runId: "rot_test", status: "completed", totalItems: 0 });
});

describe("rotation operator routes", () => {
  it("lists only through authenticated admin service with no-store caching", async () => {
    const response = await GET(context(new Request("https://app.test/api/admin/operations/rotations")));

    expect(dependencies.authenticate).toHaveBeenCalledOnce();
    expect(dependencies.list).toHaveBeenCalledWith({ env: dependencies.env, userId: "admin-owner" });
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
  });

  it("requires CSRF/recent-auth and forwards idempotency plus explicit scope controls", async () => {
    const response = await CREATE(context(new Request("https://app.test/api/admin/operations/rotations", {
      body: JSON.stringify({
        dryRun: false,
        globalConfirmation: "ROTATE_GLOBAL",
        keyFamily: "inventory",
        liveConfirmation: "ROTATE_LIVE",
        scope: "global",
        shopPublicId: null,
        sourceKeyVersion: "v1",
        targetKeyVersion: "v2",
      }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": "rotation-route-0001" },
      method: "POST",
    })));

    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth);
    expect(dependencies.create).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-owner",
      globalConfirmation: "ROTATE_GLOBAL",
      idempotencyKey: "rotation-route-0001",
      liveConfirmation: "ROTATE_LIVE",
      scope: "global",
    }));
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(201);
  });

  it("processes only a bounded batch and stops before service when CSRF fails", async () => {
    const request = new Request("https://app.test/api/admin/operations/rotations/rot_test/process", {
      body: JSON.stringify({ limit: 25 }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": "rotation-route-0002" },
      method: "POST",
    });
    await PROCESS(context(request, { runId: "rot_test" }));
    expect(dependencies.process).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "rotation-route-0002",
      limit: 25,
      runId: "rot_test",
    }));

    dependencies.requireCsrf.mockRejectedValueOnce(new AppError("csrf_invalid", 403));
    const deniedRequest = new Request("https://app.test/api/admin/operations/rotations/rot_test/process", {
      body: JSON.stringify({ limit: 25 }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": "rotation-route-0002" },
      method: "POST",
    });
    const denied = await PROCESS(context(deniedRequest, { runId: "rot_test" }));
    expect(denied).toBeInstanceOf(Response);
    if (!(denied instanceof Response)) throw new Error("response_missing");
    expect(denied.status).toBe(403);
    expect(dependencies.process).toHaveBeenCalledTimes(1);
  });
});
