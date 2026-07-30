import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  complete: vi.fn(),
  env: {},
  recent: vi.fn(),
  requireCsrf: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recent,
}));
vi.mock("../../src/lib/commerce/manual-fulfillment", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), completeManualFulfillment: dependencies.complete };
});
vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => dependencies.env }));

import * as route from "../../src/pages/api/app/shops/[shopPublicId]/orders/[orderId]/manual-fulfillments";

const shopPublicId = "shop_00000000-0000-4000-8000-0000000000a1";
const orderPublicId = "order_00000000-0000-4000-8000-0000000000a1";
const orderItemId = "oit_00000000-0000-4000-8000-0000000000a1";
const auth = { userId: "user-manual-a" };

function request(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request(`https://app.example.test/api/app/shops/${shopPublicId}/orders/${orderPublicId}/manual-fulfillments`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
    method: "POST",
  });
}

function context(routeRequest: Request, requestId = "request-manual-route") {
  return {
    locals: { requestId },
    params: { orderId: orderPublicId, shopPublicId },
    request: routeRequest,
  } as never;
}

function validBody(): Record<string, unknown> {
  return {
    executionType: "seller_attested_delivery",
    externalReference: { reference: "TRACKING-REFERENCE-001", type: "delivery_reference" },
    orderItemId,
  };
}

beforeEach(() => {
  dependencies.complete.mockReset();
  dependencies.recent.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.complete.mockResolvedValue({
    execution: {
      completedAt: "2026-07-30T03:00:00.000Z",
      completedQuantity: 1,
      evidence: { recorded: true, type: "delivery_reference" },
      executionId: "mfx-safe-reference",
      executionType: "seller_attested_delivery",
      orderItemId,
      state: "completed",
    },
    replayed: false,
  });
});

describe("manual fulfillment route", () => {
  it("exposes only POST and fails before execution when CSRF authentication fails", async () => {
    expect(route.POST).toBeTypeOf("function");
    expect(Reflect.get(route, "GET")).toBeUndefined();
    dependencies.requireCsrf.mockRejectedValueOnce(new AppError("csrf_invalid", 403));
    const routeRequest = request(validBody(), { "Idempotency-Key": "manual-route-key-0001" });

    const response = await route.POST(context(routeRequest));

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(dependencies.recent).not.toHaveBeenCalled();
    expect(dependencies.complete).not.toHaveBeenCalled();
  });

  it("requires recent authentication before reading or executing the command", async () => {
    dependencies.recent.mockImplementationOnce(() => {
      throw new AppError("recent_auth_required", 403);
    });
    const routeRequest = request(validBody(), { "Idempotency-Key": "manual-route-key-0002" });

    const response = await route.POST(context(routeRequest));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "recent_auth_required", ok: false });
    expect(dependencies.recent).toHaveBeenCalledWith(auth);
    expect(dependencies.complete).not.toHaveBeenCalled();
  });

  it("forwards the typed command and Idempotency-Key without exposing reference evidence", async () => {
    const routeRequest = request(validBody(), { "Idempotency-Key": "manual-route-key-0003" });

    const response = await route.POST(context(routeRequest));

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      execution: {
        completedAt: "2026-07-30T03:00:00.000Z",
        completedQuantity: 1,
        evidence: { recorded: true, type: "delivery_reference" },
        executionId: "mfx-safe-reference",
        executionType: "seller_attested_delivery",
        orderItemId,
        state: "completed",
      },
      ok: true,
      replayed: false,
      requestId: "request-manual-route",
    });
    expect(dependencies.complete).toHaveBeenCalledWith({
      env: dependencies.env,
      execution: {
        executionType: "seller_attested_delivery",
        externalReference: { reference: "TRACKING-REFERENCE-001", type: "delivery_reference" },
        orderItemId,
      },
      idempotencyKey: "manual-route-key-0003",
      orderPublicId,
      requestId: "request-manual-route",
      shopPublicId,
      userId: auth.userId,
    });
  });

  it("returns 200 for a durable replay", async () => {
    dependencies.complete.mockResolvedValueOnce({
      execution: {
        completedAt: "2026-07-30T03:00:00.000Z",
        completedQuantity: 1,
        evidence: null,
        executionId: "mfx-replay",
        executionType: "seller_attested_delivery",
        orderItemId,
        state: "completed",
      },
      replayed: true,
    });
    const routeRequest = request({
      executionType: "seller_attested_delivery",
      externalReference: null,
      orderItemId,
    }, { "Idempotency-Key": "manual-route-key-0004" });

    const response = await route.POST(context(routeRequest, "request-manual-replay"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, replayed: true });
  });

  it("rejects untyped provider payload fields before calling the service", async () => {
    const routeRequest = request({
      ...validBody(),
      providerPayload: { credential: "must-not-be-accepted" },
    }, { "Idempotency-Key": "manual-route-key-0005" });

    const response = await route.POST(context(routeRequest));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "validation_failed",
      issues: ["unknown_field:providerPayload"],
      ok: false,
    });
    expect(dependencies.complete).not.toHaveBeenCalled();
  });
});
