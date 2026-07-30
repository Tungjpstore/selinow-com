import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  authenticate: vi.fn(),
  cancel: vi.fn(),
  create: vi.fn(),
  env: {},
  get: vi.fn(),
  list: vi.fn(),
  recentAuth: vi.fn(),
  requireCsrf: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  authenticateRequest: dependencies.authenticate,
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recentAuth,
}));

vi.mock("../../src/lib/automation/api-service", () => ({
  cancelAutomationTask: dependencies.cancel,
  createAutomationTask: dependencies.create,
  getAutomationTask: dependencies.get,
  listAutomationTasks: dependencies.list,
  resumeAutomationTask: dependencies.resume,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

import { GET as getTaskRoute } from "../../src/pages/api/app/shops/[shopPublicId]/automation/[taskId]";
import { POST as cancelRoute } from "../../src/pages/api/app/shops/[shopPublicId]/automation/[taskId]/cancel";
import { POST as resumeRoute } from "../../src/pages/api/app/shops/[shopPublicId]/automation/[taskId]/resume";
import { GET as listRoute, POST as createRoute } from "../../src/pages/api/app/shops/[shopPublicId]/automation";

const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000001";
const OTHER_SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000002";
const TASK_ID = "aut_00000000-0000-4000-8000-000000000003";
const auth = {
  authenticatedAt: "2026-07-26T04:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Owner",
  email: "owner@example.test",
  sessionId: "session-a",
  userId: "user-a",
};
const task = {
  actionUrl: "/onboarding",
  attemptCount: 0,
  capabilityCode: "shop.provision",
  canCancel: true,
  continuation: null,
  createdAt: "2026-07-26T04:00:00.000Z",
  id: TASK_ID,
  lastSafeErrorCode: null,
  nextAttemptAt: null,
  status: "queued",
  updatedAt: "2026-07-26T04:00:00.000Z",
  version: 1,
};

function routeContext(input: {
  body?: unknown;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  params?: Record<string, string>;
  path: string;
}) {
  const method = input.method ?? "GET";
  const headers = new Headers(input.headers);
  let body: string | undefined;
  if (input.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(input.body);
  }
  return {
    locals: { requestId: "request-automation-route" },
    params: input.params ?? {},
    request: new Request(`https://app.example.test${input.path}`, {
      ...(body === undefined ? {} : { body }),
      headers,
      method,
    }),
  };
}

async function json(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return body;
}

beforeEach(() => {
  dependencies.authenticate.mockReset();
  dependencies.cancel.mockReset();
  dependencies.create.mockReset();
  dependencies.get.mockReset();
  dependencies.list.mockReset();
  dependencies.recentAuth.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.resume.mockReset();

  dependencies.authenticate.mockResolvedValue(auth);
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.cancel.mockResolvedValue({ replayed: false, task: { ...task, status: "canceled", version: 2 } });
  dependencies.create.mockResolvedValue({ replayed: false, task });
  dependencies.get.mockResolvedValue({ task });
  dependencies.list.mockResolvedValue({ tasks: [task] });
  dependencies.resume.mockResolvedValue({ replayed: false, task: { ...task, version: 2 } });
});

describe("automation read routes", () => {
  it("binds list filters to the authenticated actor and path tenant", async () => {
    const response = await listRoute(routeContext({
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation?capabilityCode=shop.provision&limit=25&status=queued`,
    }) as never);

    expect(dependencies.authenticate).toHaveBeenCalledWith(expect.any(Request), dependencies.env);
    expect(dependencies.list).toHaveBeenCalledWith({
      capabilityCode: "shop.provision",
      env: dependencies.env,
      limit: 25,
      shopPublicId: SHOP_PUBLIC_ID,
      status: "queued",
      userId: "user-a",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
  });

  it("binds detail lookup to the authenticated actor, shop, and task from the route", async () => {
    const response = await getTaskRoute(routeContext({
      params: { shopPublicId: SHOP_PUBLIC_ID, taskId: TASK_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/${TASK_ID}`,
    }) as never);

    expect(dependencies.get).toHaveBeenCalledWith({
      env: dependencies.env,
      shopPublicId: SHOP_PUBLIC_ID,
      taskId: TASK_ID,
      userId: "user-a",
    });
    expect(response.status).toBe(200);
  });

  it("does not hide tenant authorization failures returned by the service", async () => {
    dependencies.get.mockRejectedValueOnce(new AppError("automation_task_not_found", 404));

    const response = await getTaskRoute(routeContext({
      params: { shopPublicId: OTHER_SHOP_PUBLIC_ID, taskId: TASK_ID },
      path: `/api/app/shops/${OTHER_SHOP_PUBLIC_ID}/automation/${TASK_ID}`,
    }) as never);

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      code: "automation_task_not_found",
      ok: false,
      requestId: "request-automation-route",
    });
  });

  it("rejects unknown and duplicate list query parameters before listing tasks", async () => {
    const unknown = await listRoute(routeContext({
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation?ownerUserId=user-b`,
    }) as never);
    const duplicate = await listRoute(routeContext({
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation?limit=1&limit=2`,
    }) as never);

    expect(unknown.status).toBe(400);
    expect(duplicate.status).toBe(400);
    expect(dependencies.list).not.toHaveBeenCalled();
  });
});

describe("automation mutation routes", () => {
  it("requires CSRF and recent auth and forwards create idempotency", async () => {
    const response = await createRoute(routeContext({
      body: { capabilityCode: "shop.provision" },
      headers: { "Idempotency-Key": "automation-create-001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation`,
    }) as never);

    expect(dependencies.requireCsrf).toHaveBeenCalledWith(expect.any(Request), dependencies.env);
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth);
    expect(dependencies.create).toHaveBeenCalledWith({
      capabilityCode: "shop.provision",
      env: dependencies.env,
      idempotencyKey: "automation-create-001",
      requestId: "request-automation-route",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "user-a",
    });
    expect(response.status).toBe(201);
  });

  it("uses 200 for an idempotent create replay", async () => {
    dependencies.create.mockResolvedValueOnce({ replayed: true, task });
    const response = await createRoute(routeContext({
      body: { capabilityCode: "shop.provision" },
      headers: { "Idempotency-Key": "automation-create-001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation`,
    }) as never);

    expect(response.status).toBe(200);
  });

  it("rejects body attempts to override tenant or actor identity", async () => {
    const response = await createRoute(routeContext({
      body: { capabilityCode: "shop.provision", shopPublicId: OTHER_SHOP_PUBLIC_ID, userId: "user-b" },
      headers: { "Idempotency-Key": "automation-create-001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation`,
    }) as never);

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      code: "validation_failed",
      issues: ["unknown_field:shopPublicId", "unknown_field:userId"],
      ok: false,
      requestId: "request-automation-route",
    });
    expect(dependencies.create).not.toHaveBeenCalled();
  });

  it("never reaches a mutation service when CSRF or recent auth fails", async () => {
    dependencies.requireCsrf.mockRejectedValueOnce(new AppError("csrf_invalid", 403));
    const csrfResponse = await createRoute(routeContext({
      body: { capabilityCode: "shop.provision" },
      headers: { "Idempotency-Key": "automation-create-001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation`,
    }) as never);
    dependencies.requireCsrf.mockResolvedValueOnce(auth);
    dependencies.recentAuth.mockImplementationOnce(() => { throw new AppError("recent_auth_required", 403); });
    const authResponse = await cancelRoute(routeContext({
      body: { expectedVersion: 1, reasonCode: "seller_changed_mind" },
      headers: { "Idempotency-Key": "automation-cancel-001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID, taskId: TASK_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/${TASK_ID}/cancel`,
    }) as never);

    expect(csrfResponse.status).toBe(403);
    expect(authResponse.status).toBe(403);
    expect(dependencies.create).not.toHaveBeenCalled();
    expect(dependencies.cancel).not.toHaveBeenCalled();
  });

  it("treats resume POST as approval and never accepts a public evidence token", async () => {
    const rejected = await resumeRoute(routeContext({
      body: { evidenceToken: "client-supplied-token", expectedVersion: 1 },
      headers: { "Idempotency-Key": "automation-resume-001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID, taskId: TASK_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/${TASK_ID}/resume`,
    }) as never);

    expect(rejected.status).toBe(400);
    expect(await json(rejected)).toMatchObject({
      code: "validation_failed",
      issues: ["unknown_field:evidenceToken"],
    });
    expect(dependencies.resume).not.toHaveBeenCalled();

    const accepted = await resumeRoute(routeContext({
      body: { expectedVersion: 1 },
      headers: { "Idempotency-Key": "automation-resume-001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID, taskId: TASK_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/${TASK_ID}/resume`,
    }) as never);

    expect(accepted.status).toBe(200);
    expect(dependencies.resume).toHaveBeenCalledWith({
      env: dependencies.env,
      expectedVersion: 1,
      idempotencyKey: "automation-resume-001",
      requestId: "request-automation-route",
      shopPublicId: SHOP_PUBLIC_ID,
      taskId: TASK_ID,
      userId: "user-a",
    });
  });

  it("validates cancel body and forwards route-bound task guards", async () => {
    const invalid = await cancelRoute(routeContext({
      body: { expectedVersion: 0, reasonCode: 42 },
      headers: { "Idempotency-Key": "automation-cancel-001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID, taskId: TASK_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/${TASK_ID}/cancel`,
    }) as never);
    expect(invalid.status).toBe(400);
    expect(dependencies.cancel).not.toHaveBeenCalled();

    const valid = await cancelRoute(routeContext({
      body: { expectedVersion: 1, reasonCode: "seller_changed_mind" },
      headers: { "Idempotency-Key": "automation-cancel-001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID, taskId: TASK_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/${TASK_ID}/cancel`,
    }) as never);
    expect(valid.status).toBe(200);
    expect(dependencies.cancel).toHaveBeenCalledWith({
      env: dependencies.env,
      expectedVersion: 1,
      idempotencyKey: "automation-cancel-001",
      reasonCode: "seller_changed_mind",
      requestId: "request-automation-route",
      shopPublicId: SHOP_PUBLIC_ID,
      taskId: TASK_ID,
      userId: "user-a",
    });
  });
});
