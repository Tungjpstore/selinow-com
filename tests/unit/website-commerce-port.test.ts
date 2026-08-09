import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  checkoutCart: vi.fn(),
  consumePrivateDownloadGrant: vi.fn(),
  createCart: vi.fn(),
  getOrder: vi.fn(),
  issuePrivateDownloadGrant: vi.fn(),
  listPrivateDownloads: vi.fn(),
  prepareCheckoutRecovery: vi.fn(),
  quoteCart: vi.fn(),
  recoverCheckout: vi.fn(),
}));

vi.mock("../../src/lib/commerce/store", () => ({
  checkoutCart: dependencies.checkoutCart,
  createCart: dependencies.createCart,
  getOrder: dependencies.getOrder,
  quoteCart: dependencies.quoteCart,
}));
vi.mock("../../src/lib/commerce/private-file-fulfillment", () => ({
  consumeWebsitePrivateDownloadGrant: dependencies.consumePrivateDownloadGrant,
  issueWebsitePrivateDownloadGrant: dependencies.issuePrivateDownloadGrant,
  listWebsitePrivateDownloads: dependencies.listPrivateDownloads,
}));
vi.mock("../../src/lib/commerce/website-checkout-recovery", () => ({
  prepareWebsiteCheckoutRecovery: dependencies.prepareCheckoutRecovery,
  recoverWebsiteCheckout: dependencies.recoverCheckout,
}));

import { CommerceApplicationService } from "../../src/lib/commerce/application";
import { createWebsiteCommerceApplication, WebsiteCommercePort } from "../../src/lib/commerce/website-port";
import type { CommerceContext } from "../../src/lib/commerce/contracts";
import type { AppBindings } from "../../src/lib/platform/bindings";
import type { StorefrontShop } from "../../src/lib/storefront/store";

const shop = { currency: "VND", id: "shop-a" } as StorefrontShop;
const env = {} as AppBindings;
const quoteEvidence = "quote-evidence-123456789012345678901234567890";
const context: CommerceContext = {
  actor: { kind: "anonymous" },
  channel: { code: "website", connectionId: null },
  locale: "vi",
  requestId: "request-web-001",
  shopId: shop.id,
};

beforeEach(() => {
  dependencies.checkoutCart.mockReset();
  dependencies.consumePrivateDownloadGrant.mockReset();
  dependencies.createCart.mockReset();
  dependencies.getOrder.mockReset();
  dependencies.issuePrivateDownloadGrant.mockReset();
  dependencies.listPrivateDownloads.mockReset();
  dependencies.prepareCheckoutRecovery.mockReset();
  dependencies.quoteCart.mockReset();
  dependencies.recoverCheckout.mockReset();
});

describe("WebsiteCommercePort", () => {
  it("maps legacy D1 cart and quote results to the canonical contract", async () => {
    dependencies.createCart.mockResolvedValue({ cartId: "cart-001", cartToken: "cart-token-12345678901234567890", expiresAt: "2026-07-29T01:00:00.000Z" });
    dependencies.quoteCart.mockResolvedValue({
      currency: "VND",
      expiresAt: "2026-07-29T00:05:00.000Z",
      items: [{ productTitle: "License", quantity: 2, unitPriceMinor: 9_000, variantId: "var-paid", variantTitle: "Monthly", variantVersion: 3 }],
      quoteEvidence,
      subtotalMinor: 18_000,
      totalMinor: 18_000,
    });
    const service = createWebsiteCommerceApplication(env, shop);

    const cart = await service.createCart(context, { items: [{ quantity: 2, variantId: "var-paid" }] });
    const quote = await service.quoteCart(context, { cart: { access: cart.access, cartId: cart.cartId } });

    expect(dependencies.createCart).toHaveBeenCalledWith({ env, items: [{ quantity: 2, variantId: "var-paid" }], locale: "vi", shop });
    expect(dependencies.quoteCart).toHaveBeenCalledWith({ cartId: "cart-001", cartToken: "cart-token-12345678901234567890", env, shop });
    expect(cart).toEqual({ access: { kind: "opaque_token", token: "cart-token-12345678901234567890" }, cartId: "cart-001", expiresAt: "2026-07-29T01:00:00.000Z" });
    expect(quote).toEqual({
      currency: "VND",
      discountMinor: 0,
      expiresAt: "2026-07-29T00:05:00.000Z",
      items: [{ lineTotalMinor: 18_000, productTitle: "License", quantity: 2, unitPriceMinor: 9_000, variantId: "var-paid", variantTitle: "Monthly", variantVersion: 3 }],
      quoteEvidence,
      subtotalMinor: 18_000,
      totalMinor: 18_000,
    });
  });

  it("maps checkout access and legacy order fields without exposing provider data", async () => {
    dependencies.checkoutCart.mockResolvedValue({
      expiresAt: "2026-07-29T01:00:00.000Z",
      orderId: "order_11111111-1111-4111-8111-111111111111",
      orderToken: "order-token-12345678901234567890",
      paymentStatus: "unpaid",
      status: "pending_payment",
      totalMinor: 9_000,
    });
    const port = new WebsiteCommercePort(env, shop);
    const view = await port.checkoutCart({
      command: {
        cart: { access: { kind: "opaque_token", token: "cart-token-12345678901234567890" }, cartId: "cart-001" },
        customerEmail: "buyer@example.com",
        expected: [{ quantity: 1, unitPriceMinor: 9_000, variantId: "var-paid", variantVersion: 3 }],
        idempotencyKey: "checkout-website-0001",
        quoteEvidence,
      },
      context,
    });

    expect(view).toEqual({
      access: { kind: "opaque_token", token: "order-token-12345678901234567890" },
      currency: "VND",
      expiresAt: "2026-07-29T01:00:00.000Z",
      fulfillmentStatus: "reserved",
      orderId: "order_11111111-1111-4111-8111-111111111111",
      orderNumber: "111111111111",
      paymentStatus: "unpaid",
      status: "pending_payment",
      totalMinor: 9_000,
    });
  });

  it("routes checkout recovery through the application port with the exact website cart proof", async () => {
    const recoveryEvidence = "recovery-evidence-123456789012345678901234567890";
    dependencies.prepareCheckoutRecovery.mockResolvedValue({ evidence: recoveryEvidence, expiresAt: "2026-07-29T01:00:00.000Z" });
    dependencies.recoverCheckout.mockResolvedValue({
      currency: "VND",
      expiresAt: "2026-07-29T01:00:00.000Z",
      fulfillmentStatus: "reserved",
      orderId: "order_11111111-1111-4111-8111-111111111111",
      orderNumber: "ORDER-RECOVERY-001",
      orderToken: "order-token-12345678901234567890",
      paymentStatus: "unpaid",
      status: "pending_payment",
      totalMinor: 9_000,
    });
    const service = createWebsiteCommerceApplication(env, shop);
    const command = {
      cart: { access: { kind: "opaque_token" as const, token: "cart-token-12345678901234567890" }, cartId: "cart-001" },
      customerEmail: "buyer@example.com",
      expected: [{ quantity: 1, unitPriceMinor: 9_000, variantId: "var-paid", variantVersion: 3 }],
      idempotencyKey: "checkout-recovery-0001",
    };

    await expect(service.prepareCheckoutRecovery(context, { ...command, quoteEvidence })).resolves.toEqual({
      evidence: recoveryEvidence,
      expiresAt: "2026-07-29T01:00:00.000Z",
    });
    await expect(service.recoverCheckout(context, { ...command, recoveryEvidence })).resolves.toMatchObject({
      access: { kind: "opaque_token", token: "order-token-12345678901234567890" },
      orderId: "order_11111111-1111-4111-8111-111111111111",
    });

    expect(dependencies.prepareCheckoutRecovery).toHaveBeenCalledWith({
      cartId: "cart-001",
      cartToken: "cart-token-12345678901234567890",
      customerEmail: "buyer@example.com",
      env,
      expected: command.expected,
      idempotencyKey: "checkout-recovery-0001",
      quoteEvidence,
      shop,
    });
    expect(dependencies.recoverCheckout).toHaveBeenCalledWith({
      cartId: "cart-001",
      cartToken: "cart-token-12345678901234567890",
      customerEmail: "buyer@example.com",
      env,
      expected: command.expected,
      idempotencyKey: "checkout-recovery-0001",
      recoveryEvidence,
      shop,
    });
  });

  it("routes private downloads through opaque website order access and preserves request idempotency", async () => {
    const order = {
      access: { kind: "opaque_token" as const, token: "order-token-12345678901234567890" },
      orderId: "order_11111111-1111-4111-8111-111111111111",
    };
    const assetVersionId = "dav_22222222-2222-4222-8222-222222222222";
    const orderItemId = "oit_33333333-3333-4333-8333-333333333333";
    const grantId = "dgr_44444444-4444-4444-8444-444444444444";
    const grantToken = "delivery-grant-token-12345678901234567890";
    dependencies.listPrivateDownloads.mockResolvedValue([{
      assetVersionId,
      downloadCount: 0,
      entitlementExpiresAt: null,
      entitlementStatus: "active",
      filename: "manual.pdf",
      maxDownloads: 2,
      orderItemId,
      remainingDownloads: 2,
    }]);
    dependencies.issuePrivateDownloadGrant.mockResolvedValue({
      assetVersionId,
      expiresAt: "2026-07-29T01:00:00.000Z",
      grantId,
      grantToken,
      remainingDownloads: 2,
    });
    dependencies.consumePrivateDownloadGrant.mockResolvedValue({
      bytes: new TextEncoder().encode("private-file"),
      contentType: "application/pdf",
      filename: "manual.pdf",
    });
    const service = createWebsiteCommerceApplication(env, shop);

    await expect(service.listPrivateDownloads(context, { order })).resolves.toHaveLength(1);
    await expect(service.issuePrivateDownloadGrant(context, {
      assetVersionId,
      idempotencyKey: "private-download-0001",
      order,
      orderItemId,
    })).resolves.toMatchObject({ grantId, grantToken });
    await expect(service.consumePrivateDownloadGrant(context, { grantId, grantToken, idempotencyKey: "private-download-0001", order })).resolves.toMatchObject({
      contentType: "application/pdf",
      filename: "manual.pdf",
    });

    expect(dependencies.listPrivateDownloads).toHaveBeenCalledWith({ env, orderPublicId: order.orderId, orderToken: order.access.token, shopId: shop.id });
    expect(dependencies.issuePrivateDownloadGrant).toHaveBeenCalledWith({
      assetVersionId,
      env,
      idempotencyKey: "private-download-0001",
      orderItemId,
      orderPublicId: order.orderId,
      orderToken: order.access.token,
      requestId: context.requestId,
      shopId: shop.id,
    });
    expect(dependencies.consumePrivateDownloadGrant).toHaveBeenCalledWith({
      env,
      grantId,
      grantToken,
      idempotencyKey: "private-download-0001",
      orderPublicId: order.orderId,
      orderToken: order.access.token,
      requestId: context.requestId,
      shopId: shop.id,
    });
  });

  it("maps opaque order access without leaking legacy channel fields", async () => {
    dependencies.getOrder.mockResolvedValue({
      currency: "VND",
      expiresAt: "2026-07-29T01:00:00.000Z",
      fulfillmentStatus: "fulfilled",
      items: [{ fulfillmentType: "license_key", lineTotalMinor: 9_000, productTitle: "License", quantity: 1, variantTitle: "Monthly", sku: "SECRET-SKU" }],
      orderNumber: "ORDER-001",
      paymentStatus: "paid",
      sourceChannel: "web",
      status: "completed",
      totalMinor: 9_000,
    });
    const service = createWebsiteCommerceApplication(env, shop);
    const view = await service.getOrder(context, { order: { access: { kind: "opaque_token", token: "order-token-12345678901234567890" }, orderId: "order_11111111-1111-4111-8111-111111111111" } });

    expect(dependencies.getOrder).toHaveBeenCalledWith({ env, orderPublicId: "order_11111111-1111-4111-8111-111111111111", orderToken: "order-token-12345678901234567890", shop });
    expect(view).toEqual({
      currency: "VND",
      expiresAt: "2026-07-29T01:00:00.000Z",
      fulfillmentStatus: "fulfilled",
      items: [{ fulfillmentType: "license_key", lineTotalMinor: 9_000, productTitle: "License", quantity: 1, variantTitle: "Monthly" }],
      orderNumber: "ORDER-001",
      paymentStatus: "paid",
      status: "completed",
      totalMinor: 9_000,
    });
    expect(JSON.stringify(view)).not.toContain("sourceChannel");
    expect(JSON.stringify(view)).not.toContain("SECRET-SKU");
  });

  it("fails closed when website checkout omits signed quote evidence", async () => {
    const port = new WebsiteCommercePort(env, shop);
    await expect(port.checkoutCart({
      command: {
        cart: { access: { kind: "opaque_token", token: "cart-token-12345678901234567890" }, cartId: "cart-001" },
        customerEmail: null,
        expected: [{ quantity: 1, unitPriceMinor: 9_000, variantId: "var-paid", variantVersion: 3 }],
        idempotencyKey: "checkout-website-0002",
      },
      context,
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
    expect(dependencies.checkoutCart).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...context, shopId: "shop-b" }, "shop_id_mismatch"],
    [{ ...context, channel: { code: "telegram", connectionId: "telegram-1" } }, "website_channel_required"],
    [{ ...context, actor: { kind: "customer", customerId: "cus-1" } }, "anonymous_actor_required"],
  ] as const)("rejects a non-website context before touching D1 (%s)", async (invalidContext, issue) => {
    const port = new WebsiteCommercePort(env, shop);
    await expect(port.createCart({ command: { items: [{ quantity: 1, variantId: "var-paid" }] }, context: invalidContext })).rejects.toEqual(
      expect.objectContaining({ code: "commerce_context_mismatch", status: 403, issues: [issue] }),
    );
    expect(dependencies.createCart).not.toHaveBeenCalled();
  });

  it("rejects principal access because anonymous website carts require an opaque token", async () => {
    const port = new WebsiteCommercePort(env, shop);
    await expect(port.quoteCart({ command: { cart: { access: { kind: "principal" }, cartId: "cart-001" } }, context })).rejects.toEqual(
      expect.objectContaining({ code: "commerce_context_mismatch", status: 403 }),
    );
    expect(dependencies.quoteCart).not.toHaveBeenCalled();
  });

  it("keeps application-level context validation in front of the adapter", async () => {
    const service = new CommerceApplicationService(new WebsiteCommercePort(env, shop));
    await expect(service.createCart({ ...context, requestId: "bad request id" }, { items: [{ quantity: 1, variantId: "var-paid" }] })).rejects.toEqual(
      expect.objectContaining({ code: "validation_failed", status: 400 }),
    );
    expect(dependencies.createCart).not.toHaveBeenCalled();
  });
});
