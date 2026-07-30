import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  assertCheckout: vi.fn(),
  createCart: vi.fn(),
  env: {},
  guardCart: vi.fn(),
  mutateCart: vi.fn(),
  resolveShop: vi.fn(),
}));

vi.mock("../../src/lib/commerce/store", () => ({ createCart: dependencies.createCart }));
vi.mock("../../src/lib/commerce/cart-mutation", () => ({ applyWebsiteCartMutation: dependencies.mutateCart }));
vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => dependencies.env }));
vi.mock("../../src/lib/storefront/abuse", () => ({ guardAnonymousCart: dependencies.guardCart }));
vi.mock("../../src/lib/storefront/store", () => ({
  assertStorefrontCheckout: dependencies.assertCheckout,
  resolveStorefrontShop: dependencies.resolveShop,
}));

import { POST } from "../../src/pages/api/store/cart";

beforeEach(() => {
  dependencies.assertCheckout.mockReset();
  dependencies.createCart.mockReset();
  dependencies.guardCart.mockReset();
  dependencies.mutateCart.mockReset();
  dependencies.resolveShop.mockReset();
  dependencies.resolveShop.mockResolvedValue({ currency: "VND", defaultLocale: "vi", id: "shop-a" });
});

describe("storefront cart route", () => {
  it("does not create a cart after the anonymous limit rejects the request", async () => {
    dependencies.guardCart.mockRejectedValue(new AppError("rate_limited", 429));
    const response = await POST({
      locals: { requestId: "request-cart-rate-limit" },
      request: new Request("https://signal.example.test/api/store/cart", { method: "POST" }),
    } as Parameters<typeof POST>[0]);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: "rate_limited", ok: false });
    expect(dependencies.createCart).not.toHaveBeenCalled();
  });

  it("preserves the public cart wire shape through the canonical application service", async () => {
    dependencies.createCart.mockResolvedValue({
      cartId: "cart_11111111-1111-4111-8111-111111111111",
      cartToken: "cart-token-12345678901234567890",
      expiresAt: "2026-07-29T01:00:00.000Z",
    });
    const response = await POST({
      locals: { requestId: "request-cart-canonical" },
      request: new Request("https://signal.example.test/api/store/cart", {
        body: JSON.stringify({ items: [{ quantity: 1, variantId: "var_11111111-1111-4111-8111-111111111111" }] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    } as Parameters<typeof POST>[0]);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      cartId: "cart_11111111-1111-4111-8111-111111111111",
      cartToken: "cart-token-12345678901234567890",
      expiresAt: "2026-07-29T01:00:00.000Z",
      ok: true,
      requestId: "request-cart-canonical",
    });
    expect(dependencies.createCart).toHaveBeenCalledWith({
      env: dependencies.env,
      items: [{ quantity: 1, variantId: "var_11111111-1111-4111-8111-111111111111" }],
      locale: "vi-VN",
      shop: { currency: "VND", defaultLocale: "vi", id: "shop-a" },
    });
  });

  it.each([
    {
      label: "increment",
      mutation: { kind: "item.increment", quantity: 2, variantId: "var_22222222-2222-4222-8222-222222222222" },
      replayed: false,
    },
    {
      label: "discount",
      mutation: { code: "WELCOME10", kind: "discount.apply" },
      replayed: true,
    },
  ])("routes a website $label mutation through the canonical application port", async ({ mutation, replayed }) => {
    dependencies.mutateCart.mockResolvedValue({
      cartId: "cart_11111111-1111-4111-8111-111111111111",
      replayed,
    });
    const response = await POST({
      locals: { locale: "en", requestId: "request-cart-mutation" },
      request: new Request("https://signal.example.test/api/store/cart", {
        body: JSON.stringify({
          cartId: "cart_11111111-1111-4111-8111-111111111111",
          cartToken: "cart-token-12345678901234567890",
          mutation,
        }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "website-cart-mutation-0001",
        },
        method: "POST",
      }),
    } as Parameters<typeof POST>[0]);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cartId: "cart_11111111-1111-4111-8111-111111111111",
      cartToken: "cart-token-12345678901234567890",
      ok: true,
      replayed,
      requestId: "request-cart-mutation",
    });
    expect(dependencies.mutateCart).toHaveBeenCalledWith({
      cartId: "cart_11111111-1111-4111-8111-111111111111",
      cartToken: "cart-token-12345678901234567890",
      env: dependencies.env,
      idempotencyKey: "website-cart-mutation-0001",
      mutation,
      shop: { currency: "VND", defaultLocale: "vi", id: "shop-a" },
    });
    expect(dependencies.createCart).not.toHaveBeenCalled();
  });

  it("rejects malformed mutation requests before the website mutation store", async () => {
    const response = await POST({
      locals: { requestId: "request-cart-mutation-invalid" },
      request: new Request("https://signal.example.test/api/store/cart", {
        body: JSON.stringify({
          cartId: "cart_11111111-1111-4111-8111-111111111111",
          cartToken: "cart-token-12345678901234567890",
          mutation: { kind: "item.increment", quantity: 1, variantId: "var_22222222-2222-4222-8222-222222222222" },
          unexpected: true,
        }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "website-cart-mutation-0002",
        },
        method: "POST",
      }),
    } as Parameters<typeof POST>[0]);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("response_missing");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "validation_failed",
      issues: ["unknown_field:unexpected"],
      ok: false,
      requestId: "request-cart-mutation-invalid",
    });
    expect(dependencies.mutateCart).not.toHaveBeenCalled();
  });
});
