import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  assertCheckout: vi.fn(),
  checkoutCart: vi.fn(),
  createCart: vi.fn(),
  getOrder: vi.fn(),
  env: {},
  guardCheckout: vi.fn(),
  quoteCart: vi.fn(),
  resolveShop: vi.fn(),
}));

vi.mock("../../src/lib/commerce/store", () => ({
  checkoutCart: dependencies.checkoutCart,
  createCart: dependencies.createCart,
  getOrder: dependencies.getOrder,
  quoteCart: dependencies.quoteCart,
}));
vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => dependencies.env }));
vi.mock("../../src/lib/storefront/abuse", () => ({ guardAnonymousCheckout: dependencies.guardCheckout }));
vi.mock("../../src/lib/storefront/store", () => ({
  assertStorefrontCheckout: dependencies.assertCheckout,
  resolveStorefrontShop: dependencies.resolveShop,
}));

import { POST as checkout } from "../../src/pages/api/store/checkout";
import { POST as quote } from "../../src/pages/api/store/quote";
import { GET as order } from "../../src/pages/api/store/orders/[orderPublicId]";

const cartId = "cart_11111111-1111-4111-8111-111111111111";
const cartToken = "cart-token-12345678901234567890";
const quoteEvidence = "quote-evidence-123456789012345678901234567890";
const variantId = "var_22222222-2222-4222-8222-222222222222";
const shop = { currency: "VND", defaultLocale: "vi", id: "shop-a" };

function jsonRequest(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request(`https://signal.example.test${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

beforeEach(() => {
  dependencies.assertCheckout.mockReset();
  dependencies.checkoutCart.mockReset();
  dependencies.createCart.mockReset();
  dependencies.getOrder.mockReset();
  dependencies.guardCheckout.mockReset();
  dependencies.quoteCart.mockReset();
  dependencies.resolveShop.mockReset();
  dependencies.resolveShop.mockResolvedValue(shop);
});

describe("storefront quote route", () => {
  it("preserves the public quote shape through the canonical website adapter", async () => {
    dependencies.quoteCart.mockResolvedValue({
      currency: "VND",
      expiresAt: "2026-07-29T01:00:00.000Z",
      items: [{
        productTitle: "License",
        quantity: 2,
        unitPriceMinor: 9_000,
        variantId,
        variantTitle: "Monthly",
        variantVersion: 3,
      }],
      quoteEvidence,
      subtotalMinor: 18_000,
      totalMinor: 18_000,
    });

    const response = await quote({
      locals: { requestId: "request-quote-canonical" },
      request: jsonRequest("/api/store/quote", { cartId, cartToken }),
    } as Parameters<typeof quote>[0]);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      quote: {
        currency: "VND",
        discountMinor: 0,
        expiresAt: "2026-07-29T01:00:00.000Z",
        items: [{
          lineTotalMinor: 18_000,
          productTitle: "License",
          quantity: 2,
          unitPriceMinor: 9_000,
          variantId,
          variantTitle: "Monthly",
          variantVersion: 3,
        }],
        quoteEvidence,
        subtotalMinor: 18_000,
        totalMinor: 18_000,
      },
      requestId: "request-quote-canonical",
    });
    expect(dependencies.quoteCart).toHaveBeenCalledWith({ cartId, cartToken, env: dependencies.env, shop });
  });

  it("rejects provider-specific fields before dispatching commerce", async () => {
    const response = await quote({
      locals: { requestId: "request-quote-provider" },
      request: jsonRequest("/api/store/quote", { cartId, cartToken, providerOrderId: "provider-1" }),
    } as Parameters<typeof quote>[0]);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "validation_failed",
      issues: ["unknown_field:providerOrderId"],
      ok: false,
      requestId: "request-quote-provider",
    });
    expect(dependencies.quoteCart).not.toHaveBeenCalled();
  });
});

describe("storefront checkout route", () => {
  it("preserves the opaque order-token wire shape through the canonical website adapter", async () => {
    dependencies.checkoutCart.mockResolvedValue({
      currency: "VND",
      expiresAt: "2026-07-29T01:00:00.000Z",
      fulfillmentStatus: "reserved",
      orderId: "order_33333333-3333-4333-8333-333333333333",
      orderNumber: "SO-2026-0001",
      orderToken: "order-token-12345678901234567890",
      paymentStatus: "unpaid",
      status: "pending_payment",
      totalMinor: 9_000,
    });
    const request = jsonRequest("/api/store/checkout", {
      cartId,
      cartToken,
      customerEmail: " Buyer@Example.COM ",
      expected: [{ quantity: 1, unitPriceMinor: 9_000, variantId, variantVersion: 3 }],
      quoteEvidence,
      turnstileToken: "turnstile-token-0001",
    }, { "Idempotency-Key": "checkout-route-0001" });

    const response = await checkout({
      locals: { requestId: "request-checkout-canonical" },
      request,
    } as Parameters<typeof checkout>[0]);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      order: {
        currency: "VND",
        expiresAt: "2026-07-29T01:00:00.000Z",
        fulfillmentStatus: "reserved",
        orderId: "order_33333333-3333-4333-8333-333333333333",
        orderNumber: "SO-2026-0001",
        orderToken: "order-token-12345678901234567890",
        paymentStatus: "unpaid",
        status: "pending_payment",
        totalMinor: 9_000,
      },
      requestId: "request-checkout-canonical",
    });
    expect(dependencies.guardCheckout).toHaveBeenCalledWith({
      env: dependencies.env,
      request,
      shop,
      turnstileToken: "turnstile-token-0001",
    });
    expect(dependencies.checkoutCart).toHaveBeenCalledWith({
      cartId,
      cartToken,
      customerEmail: "buyer@example.com",
      env: dependencies.env,
      expected: [{ quantity: 1, unitPriceMinor: 9_000, variantId, variantVersion: 3 }],
      idempotencyKey: "checkout-route-0001",
      quoteEvidence,
      shop,
    });
  });

  it("returns the abuse guard error before validating or disclosing cart state", async () => {
    dependencies.guardCheckout.mockRejectedValue(new AppError("rate_limited", 429));
    const response = await checkout({
      locals: { requestId: "request-checkout-rate-limit" },
      request: jsonRequest("/api/store/checkout", {
        cartId: "not-a-cart",
        cartToken: "short",
        expected: [],
      }),
    } as Parameters<typeof checkout>[0]);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      code: "rate_limited",
      ok: false,
      requestId: "request-checkout-rate-limit",
    });
    expect(dependencies.guardCheckout).toHaveBeenCalledOnce();
    expect(dependencies.checkoutCart).not.toHaveBeenCalled();
  });

  it("rejects checkout without signed quote evidence", async () => {
    const response = await checkout({
      locals: { requestId: "request-checkout-quote-missing" },
      request: jsonRequest("/api/store/checkout", {
        cartId,
        cartToken,
        expected: [{ unitPriceMinor: 9_000, variantId, variantVersion: 3 }],
      }, { "Idempotency-Key": "checkout-route-quote-missing" }),
    } as Parameters<typeof checkout>[0]);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "quote_invalid",
      ok: false,
      requestId: "request-checkout-quote-missing",
    });
    expect(dependencies.checkoutCart).not.toHaveBeenCalled();
  });

  it("rejects unknown fields before spending the anonymous checkout allowance", async () => {
    const response = await checkout({
      locals: { requestId: "request-checkout-provider" },
      request: jsonRequest("/api/store/checkout", {
        cartId,
        cartToken,
        expected: [{ unitPriceMinor: 9_000, variantId, variantVersion: 3 }],
        providerOrderId: "provider-1",
      }),
    } as Parameters<typeof checkout>[0]);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "validation_failed",
      issues: ["unknown_field:providerOrderId"],
      ok: false,
      requestId: "request-checkout-provider",
    });
    expect(dependencies.guardCheckout).not.toHaveBeenCalled();
    expect(dependencies.checkoutCart).not.toHaveBeenCalled();
  });
});

describe("storefront order access route", () => {
  it("uses the canonical website order-access seam and keeps the response safe", async () => {
    dependencies.getOrder.mockResolvedValue({
      currency: "VND",
      expiresAt: "2026-07-29T01:00:00.000Z",
      fulfillmentStatus: "fulfilled",
      items: [{ fulfillmentType: "license_key", lineTotalMinor: 9_000, productTitle: "License", quantity: 1, variantTitle: "Monthly", sku: "provider-secret" }],
      orderNumber: "SO-2026-0001",
      paymentStatus: "paid",
      sourceChannel: "web",
      status: "completed",
      totalMinor: 9_000,
    });
    const orderId = "order_33333333-3333-4333-8333-333333333333";
    const request = new Request(`https://signal.example.test/api/store/orders/${orderId}`, { headers: { "X-Order-Access-Token": cartToken } });
    const response = await order({
      locals: { requestId: "request-order-canonical" },
      params: { orderPublicId: orderId },
      request,
    } as unknown as Parameters<typeof order>[0]);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      order: {
        currency: "VND",
        expiresAt: "2026-07-29T01:00:00.000Z",
        fulfillmentStatus: "fulfilled",
        items: [{ fulfillmentType: "license_key", lineTotalMinor: 9_000, productTitle: "License", quantity: 1, variantTitle: "Monthly" }],
        orderNumber: "SO-2026-0001",
        paymentStatus: "paid",
        status: "completed",
        totalMinor: 9_000,
      },
      requestId: "request-order-canonical",
    });
    expect(dependencies.getOrder).toHaveBeenCalledWith({ env: dependencies.env, orderPublicId: orderId, orderToken: cartToken, shop });
  });
});
