import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import type { StorefrontShop } from "../../src/lib/storefront/store";

const dependencies = vi.hoisted(() => ({
  consume: vi.fn(),
  env: {} as AppBindings,
  request: vi.fn(),
  shop: { currentHostname: "shop.example.test", id: "shop-a" } as StorefrontShop,
  waitUntil: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ waitUntil: dependencies.waitUntil }));
vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => dependencies.env }));
vi.mock("../../src/lib/storefront/store", () => ({ resolveStorefrontShop: () => Promise.resolve(dependencies.shop) }));
vi.mock("../../src/lib/commerce/buyer-order-recovery", () => ({
  consumeBuyerOrderRecovery: dependencies.consume,
  requestBuyerOrderRecovery: dependencies.request,
}));

import { POST as consumeRoute } from "../../src/pages/api/store/orders/[orderPublicId]/recovery/consume";
import { POST as requestRoute } from "../../src/pages/api/store/orders/[orderPublicId]/recovery";

const ORDER_ID = "order_11111111-1111-4111-8111-111111111111";

function context(request: Request): never {
  return {
    locals: { requestId: "request-route-0001" },
    params: { orderPublicId: ORDER_ID },
    request,
  } as never;
}

function recoveryRequest(path: string, body: object, origin?: string): Request {
  const headers = new Headers({
    "CF-Connecting-IP": "198.51.100.44",
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "same-origin",
  });
  if (origin !== undefined) headers.set("Origin", origin);
  return new Request(`https://shop.example.test${path}`, {
    body: JSON.stringify(body),
    headers,
    method: "POST",
  });
}

beforeEach(() => {
  dependencies.consume.mockReset().mockResolvedValue({ orderId: ORDER_ID, orderToken: "new-order-token" });
  dependencies.request.mockReset().mockResolvedValue(undefined);
  dependencies.waitUntil.mockReset();
});

describe("buyer order recovery routes", () => {
  it("requires an exact non-null same-origin header for request and consume", async () => {
    const requestWithoutOrigin = await requestRoute(context(recoveryRequest(
      `/api/store/orders/${ORDER_ID}/recovery`,
      { email: "buyer@example.test" },
    )));
    const consumeWithoutOrigin = await consumeRoute(context(recoveryRequest(
      `/api/store/orders/${ORDER_ID}/recovery/consume`,
      { token: "signed-recovery-token" },
    )));
    const crossOrigin = await requestRoute(context(recoveryRequest(
      `/api/store/orders/${ORDER_ID}/recovery`,
      { email: "buyer@example.test" },
      "https://attacker.example",
    )));

    expect(requestWithoutOrigin.status).toBe(403);
    expect(consumeWithoutOrigin.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(dependencies.request).not.toHaveBeenCalled();
    expect(dependencies.consume).not.toHaveBeenCalled();
  });

  it("passes the requester address into admission and returns a generic private response", async () => {
    const response = await requestRoute(context(recoveryRequest(
      `/api/store/orders/${ORDER_ID}/recovery`,
      { email: "buyer@example.test" },
      "https://shop.example.test",
    )));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true, ok: true, requestId: "request-route-0001" });
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(dependencies.request).toHaveBeenCalledWith(expect.objectContaining({
      requesterAddress: "198.51.100.44",
      requestId: "request-route-0001",
    }));
  });

  it("returns the rotated opaque token only after same-origin consumption", async () => {
    const response = await consumeRoute(context(recoveryRequest(
      `/api/store/orders/${ORDER_ID}/recovery/consume`,
      { token: "signed-recovery-token" },
      "https://shop.example.test",
    )));

    expect(response.status).toBe(200);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      order: { orderId: ORDER_ID, orderToken: "new-order-token" },
      requestId: "request-route-0001",
    });
  });
});
