import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  authenticate: vi.fn(),
  create: vi.fn(),
  del: vi.fn(),
  env: {},
  get: vi.fn(),
  list: vi.fn(),
  recentAuth: vi.fn(),
  requireCsrf: vi.fn(),
  toggle: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  authenticateRequest: dependencies.authenticate,
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recentAuth,
}));

vi.mock("../../src/lib/automation/rules/service", () => ({
  createAutomationRule: dependencies.create,
  deleteAutomationRule: dependencies.del,
  getAutomationRule: dependencies.get,
  listAutomationRules: dependencies.list,
  toggleAutomationRule: dependencies.toggle,
  updateAutomationRule: dependencies.update,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

import { GET as listRoute, POST as createRoute } from "../../src/pages/api/app/shops/[shopPublicId]/automation/rules/index";
import { DELETE as deleteRoute, GET as getRoute, PATCH as updateRoute } from "../../src/pages/api/app/shops/[shopPublicId]/automation/rules/[ruleId]";
import { POST as toggleRoute } from "../../src/pages/api/app/shops/[shopPublicId]/automation/rules/[ruleId]/toggle";

const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000001";
const RULE_ID = "rule_00000000-0000-4000-8000-000000000002";
const auth = {
  authenticatedAt: "2026-08-16T00:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Owner",
  email: "owner@example.test",
  sessionId: "session-a",
  userId: "user-a",
};
const rule = {
  actions: [{ config: { tag: "vip" }, type: "rule_tag_customer" }],
  conditions: [],
  createdAt: "2026-08-16T00:00:00.000Z",
  createdBy: "user-a",
  enabled: true,
  id: RULE_ID,
  lastRuns: [],
  lastTriggeredAt: null,
  name: "Tag VIP customers",
  triggerType: "order.paid",
  updatedAt: "2026-08-16T00:00:00.000Z",
  updatedBy: "user-a",
  version: 1,
};

function routeContext(input: {
  body?: unknown;
  headers?: Record<string, string>;
  method?: "DELETE" | "GET" | "PATCH" | "POST";
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
    locals: { requestId: "request-rules-route" },
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
  dependencies.create.mockReset();
  dependencies.del.mockReset();
  dependencies.get.mockReset();
  dependencies.list.mockReset();
  dependencies.recentAuth.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.toggle.mockReset();
  dependencies.update.mockReset();

  dependencies.authenticate.mockResolvedValue(auth);
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.create.mockResolvedValue({ replayed: false, rule });
  dependencies.del.mockResolvedValue(undefined);
  dependencies.get.mockResolvedValue({ rule });
  dependencies.list.mockResolvedValue({ rules: [rule] });
  dependencies.toggle.mockResolvedValue({ rule: { ...rule, enabled: false, version: 2 } });
  dependencies.update.mockResolvedValue({ rule: { ...rule, version: 2 } });
});

describe("automation rules read routes", () => {
  it("binds list filters to the authenticated actor and path tenant", async () => {
    const response = await listRoute(routeContext({
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules?enabled=1&limit=25&triggerType=order.paid`,
    }) as never);

    expect(dependencies.authenticate).toHaveBeenCalledWith(expect.any(Request), dependencies.env);
    expect(dependencies.list).toHaveBeenCalledWith({
      enabled: true,
      env: dependencies.env,
      limit: 25,
      shopPublicId: SHOP_PUBLIC_ID,
      triggerType: "order.paid",
      userId: "user-a",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(await json(response)).toMatchObject({ ok: true, requestId: "request-rules-route" });
  });

  it("returns 401 when there is no valid session", async () => {
    dependencies.authenticate.mockRejectedValueOnce(new AppError("session_invalid", 401));
    const response = await listRoute(routeContext({
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules`,
    }) as never);

    expect(response.status).toBe(401);
    expect(dependencies.list).not.toHaveBeenCalled();
  });

  it("rejects unknown, duplicate or invalid list query parameters", async () => {
    const unknown = await listRoute(routeContext({
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules?ownerUserId=user-b`,
    }) as never);
    const duplicate = await listRoute(routeContext({
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules?limit=1&limit=2`,
    }) as never);
    const badLimit = await listRoute(routeContext({
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules?limit=0`,
    }) as never);
    const badTrigger = await listRoute(routeContext({
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules?triggerType=order.shipped`,
    }) as never);
    const badEnabled = await listRoute(routeContext({
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules?enabled=true`,
    }) as never);

    expect(unknown.status).toBe(400);
    expect(duplicate.status).toBe(400);
    expect(badLimit.status).toBe(400);
    expect(badTrigger.status).toBe(400);
    expect(badEnabled.status).toBe(400);
    expect(dependencies.list).not.toHaveBeenCalled();
  });

  it("does not hide tenant authorization failures returned by the service", async () => {
    dependencies.get.mockRejectedValueOnce(new AppError("automation_rule_not_found", 404));
    const response = await getRoute(routeContext({
      params: { ruleId: RULE_ID, shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules/${RULE_ID}`,
    }) as never);

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      code: "automation_rule_not_found",
      ok: false,
      requestId: "request-rules-route",
    });
  });
});

describe("automation rules mutation routes", () => {
  it("requires CSRF and recent auth and forwards create idempotency", async () => {
    const response = await createRoute(routeContext({
      body: { actions: [], conditions: [], name: "Rule", triggerType: "order.paid" },
      headers: { "Idempotency-Key": "rule-create-00000001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules`,
    }) as never);

    expect(dependencies.requireCsrf).toHaveBeenCalledWith(expect.any(Request), dependencies.env);
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth);
    expect(dependencies.create).toHaveBeenCalledWith({
      body: { actions: [], conditions: [], name: "Rule", triggerType: "order.paid" },
      env: dependencies.env,
      idempotencyKey: "rule-create-00000001",
      requestId: "request-rules-route",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "user-a",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
  });

  it("uses 200 for an idempotent create replay", async () => {
    dependencies.create.mockResolvedValueOnce({ replayed: true, rule });
    const response = await createRoute(routeContext({
      body: { actions: [], conditions: [], name: "Rule", triggerType: "order.paid" },
      headers: { "Idempotency-Key": "rule-create-00000001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules`,
    }) as never);

    expect(response.status).toBe(200);
  });

  it("forwards a missing Idempotency-Key as null for the service to reject", async () => {
    dependencies.create.mockRejectedValueOnce(new AppError("validation_failed", 400, ["idempotency_key_invalid"]));
    const response = await createRoute(routeContext({
      body: { actions: [], conditions: [], name: "Rule", triggerType: "order.paid" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules`,
    }) as never);

    expect(dependencies.create).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: null }));
    expect(response.status).toBe(400);
  });

  it("never reaches the service when CSRF or recent auth fails", async () => {
    dependencies.requireCsrf.mockRejectedValueOnce(new AppError("csrf_invalid", 403));
    const csrfResponse = await createRoute(routeContext({
      body: { actions: [], conditions: [], name: "Rule", triggerType: "order.paid" },
      headers: { "Idempotency-Key": "rule-create-00000001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules`,
    }) as never);
    dependencies.requireCsrf.mockResolvedValueOnce(auth);
    dependencies.recentAuth.mockImplementationOnce(() => { throw new AppError("recent_auth_required", 403); });
    const authResponse = await toggleRoute(routeContext({
      body: { enabled: false, expectedVersion: 1 },
      headers: { "Idempotency-Key": "rule-toggle-00000001" },
      method: "POST",
      params: { ruleId: RULE_ID, shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules/${RULE_ID}/toggle`,
    }) as never);

    expect(csrfResponse.status).toBe(403);
    expect(authResponse.status).toBe(403);
    expect(dependencies.create).not.toHaveBeenCalled();
    expect(dependencies.toggle).not.toHaveBeenCalled();
  });

  it("rejects body attempts to override tenant or actor identity", async () => {
    const response = await createRoute(routeContext({
      body: { actions: [], name: "Rule", shopPublicId: "shop_other", triggerType: "order.paid", userId: "user-b" },
      headers: { "Idempotency-Key": "rule-create-00000001" },
      method: "POST",
      params: { shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules`,
    }) as never);

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      code: "validation_failed",
      issues: ["unknown_field:shopPublicId", "unknown_field:userId"],
      ok: false,
      requestId: "request-rules-route",
    });
    expect(dependencies.create).not.toHaveBeenCalled();
  });

  it("forwards PATCH body and expectedVersion to the update service", async () => {
    const response = await updateRoute(routeContext({
      body: { expectedVersion: 1, name: "Renamed" },
      headers: { "Idempotency-Key": "rule-update-00000001" },
      method: "PATCH",
      params: { ruleId: RULE_ID, shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules/${RULE_ID}`,
    }) as never);

    expect(dependencies.update).toHaveBeenCalledWith({
      body: { expectedVersion: 1, name: "Renamed" },
      env: dependencies.env,
      expectedVersion: 1,
      requestId: "request-rules-route",
      ruleId: RULE_ID,
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "user-a",
    });
    expect(response.status).toBe(200);
  });

  it("rejects unknown PATCH fields before reaching the service", async () => {
    const response = await updateRoute(routeContext({
      body: { expectedVersion: 1, enabled: false },
      headers: { "Idempotency-Key": "rule-update-00000001" },
      method: "PATCH",
      params: { ruleId: RULE_ID, shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules/${RULE_ID}`,
    }) as never);

    expect(response.status).toBe(400);
    expect(dependencies.update).not.toHaveBeenCalled();
  });

  it("returns 204 on DELETE and rejects unknown DELETE fields", async () => {
    const ok = await deleteRoute(routeContext({
      body: { expectedVersion: 1 },
      method: "DELETE",
      params: { ruleId: RULE_ID, shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules/${RULE_ID}`,
    }) as never);
    expect(ok.status).toBe(204);
    expect(dependencies.del).toHaveBeenCalledWith({
      env: dependencies.env,
      expectedVersion: 1,
      requestId: "request-rules-route",
      ruleId: RULE_ID,
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "user-a",
    });

    const bad = await deleteRoute(routeContext({
      body: { expectedVersion: 1, reasonCode: "seller_changed_mind" },
      method: "DELETE",
      params: { ruleId: RULE_ID, shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules/${RULE_ID}`,
    }) as never);
    expect(bad.status).toBe(400);
  });

  it("forwards toggle requests and rejects unknown toggle fields", async () => {
    const ok = await toggleRoute(routeContext({
      body: { enabled: false, expectedVersion: 1 },
      headers: { "Idempotency-Key": "rule-toggle-00000001" },
      method: "POST",
      params: { ruleId: RULE_ID, shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules/${RULE_ID}/toggle`,
    }) as never);

    expect(dependencies.toggle).toHaveBeenCalledWith({
      enabled: false,
      env: dependencies.env,
      expectedVersion: 1,
      requestId: "request-rules-route",
      ruleId: RULE_ID,
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "user-a",
    });
    expect(ok.status).toBe(200);

    const bad = await toggleRoute(routeContext({
      body: { enabled: false, expectedVersion: 1, userId: "user-b" },
      headers: { "Idempotency-Key": "rule-toggle-00000002" },
      method: "POST",
      params: { ruleId: RULE_ID, shopPublicId: SHOP_PUBLIC_ID },
      path: `/api/app/shops/${SHOP_PUBLIC_ID}/automation/rules/${RULE_ID}/toggle`,
    }) as never);
    expect(bad.status).toBe(400);
    expect(dependencies.toggle).toHaveBeenCalledTimes(1);
  });
});
