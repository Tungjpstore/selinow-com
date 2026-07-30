import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  assertCheckout: vi.fn(),
  createApp: vi.fn(),
  createPaymentHandoff: vi.fn(),
  env: {},
  resolveShop: vi.fn(),
  revealFulfillment: vi.fn(),
}));

vi.mock("../../src/lib/commerce/website-port", () => ({
  createWebsiteCommerceApplication: dependencies.createApp,
}));
vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => dependencies.env }));
vi.mock("../../src/lib/storefront/store", () => ({
  assertStorefrontCheckout: dependencies.assertCheckout,
  resolveStorefrontShop: dependencies.resolveShop,
}));

import { POST as paymentLink } from "../../src/pages/api/store/orders/[orderPublicId]/payment-link";
import { GET as keys } from "../../src/pages/api/store/orders/[orderPublicId]/keys";

const orderPublicId = "order_11111111-1111-4111-8111-111111111111";
const orderToken = "order-access-token-1234567890";
const shop = { defaultLocale: "vi", id: "shop-a" };

function request(path: string, method = "GET"): Request {
  return new Request(`https://signal.example.test${path}`, { headers: { "X-Order-Access-Token": orderToken }, method });
}

beforeEach(() => {
  dependencies.assertCheckout.mockReset();
  dependencies.createApp.mockReset();
  dependencies.createPaymentHandoff.mockReset();
  dependencies.resolveShop.mockReset();
  dependencies.revealFulfillment.mockReset();
  dependencies.resolveShop.mockResolvedValue(shop);
  dependencies.createApp.mockReturnValue({
    createPaymentHandoff: dependencies.createPaymentHandoff,
    revealFulfillment: dependencies.revealFulfillment,
  });
});

describe("storefront payment and fulfillment capability routes", () => {
  it("keeps the payment-link wire shape while dispatching the canonical handoff", async () => {
    dependencies.createPaymentHandoff.mockResolvedValue({
      expiresAt: "2026-07-29T02:00:00.000Z",
      handoffId: "pat-internal-1",
      presentation: { kind: "qr", payload: "qr-payload" },
      redirectUrl: "https://pay.example.test/checkout",
      status: "pending",
    });

    const response = await paymentLink({
      locals: { requestId: "request-payment-route" },
      params: { orderPublicId },
      request: request(`/api/store/orders/${orderPublicId}/payment-link`, "POST"),
    } as unknown as Parameters<typeof paymentLink>[0]);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      paymentLink: {
        checkoutUrl: "https://pay.example.test/checkout",
        expiresAt: "2026-07-29T02:00:00.000Z",
        paymentAttemptId: "pat-internal-1",
        qrCode: "qr-payload",
        state: "pending",
      },
      requestId: "request-payment-route",
    });
    expect(dependencies.createPaymentHandoff).toHaveBeenCalledWith({
      actor: { kind: "anonymous" },
      channel: { code: "website", connectionId: null },
      locale: "vi-VN",
      requestId: "request-payment-route",
      shopId: "shop-a",
    }, {
      order: { access: { kind: "opaque_token", token: orderToken }, orderId: orderPublicId },
      origin: "https://signal.example.test",
    });
  });

  it("keeps the key-reveal wire shape while dispatching fulfillment through the gate", async () => {
    dependencies.revealFulfillment.mockResolvedValue({
      items: [{ productTitle: "Editor", value: "LICENSE-ONLY", variantTitle: "Lifetime" }],
      orderId: orderPublicId,
    });

    const response = await keys({
      locals: { requestId: "request-keys-route" },
      params: { orderPublicId },
      request: request(`/api/store/orders/${orderPublicId}/keys`),
    } as unknown as Parameters<typeof keys>[0]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      fulfillment: {
        keys: [{ productTitle: "Editor", value: "LICENSE-ONLY", variantTitle: "Lifetime" }],
        orderId: orderPublicId,
      },
      ok: true,
      requestId: "request-keys-route",
    });
    expect(dependencies.revealFulfillment).toHaveBeenCalledWith({
      actor: { kind: "anonymous" },
      channel: { code: "website", connectionId: null },
      locale: "vi-VN",
      requestId: "request-keys-route",
      shopId: "shop-a",
    }, { order: { access: { kind: "opaque_token", token: orderToken }, orderId: orderPublicId } });
  });

  it("retains the not-found boundary before entering either capability", async () => {
    const response = await paymentLink({
      locals: { requestId: "request-payment-invalid" },
      params: { orderPublicId },
      request: new Request(`https://signal.example.test/api/store/orders/${orderPublicId}/payment-link`, { method: "POST" }),
    } as unknown as Parameters<typeof paymentLink>[0]);

    expect(response.status).toBe(404);
    expect(dependencies.createApp).not.toHaveBeenCalled();
    expect(dependencies.createPaymentHandoff).not.toHaveBeenCalled();
  });
});
