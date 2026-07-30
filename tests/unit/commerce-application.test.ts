import { describe, expect, it, vi } from "vitest";

import { CommerceApplicationService } from "../../src/lib/commerce/application";
import { CommercePaymentFulfillmentService, type CommercePaymentFulfillmentPort } from "../../src/lib/commerce/payment-fulfillment";
import { AppError } from "../../src/lib/core/errors";
import type {
  CommerceApplicationPort,
  CommerceCheckoutView,
  CommerceContext,
  CommerceCreateCartView,
  CommerceOrderView,
  CommercePaymentFulfillmentApplication,
  CommerceQuoteView,
} from "../../src/lib/commerce/contracts";

const EXPIRES_AT = "2026-07-27T00:00:00.000Z";

const websiteContext: CommerceContext = {
  actor: { kind: "anonymous" },
  channel: { code: "website", connectionId: null },
  locale: "vi",
  requestId: "request-web-001",
  shopId: "shop-demo",
};

const telegramContext: CommerceContext = {
  actor: { customerId: "cus-telegram-001", kind: "customer" },
  channel: { code: "telegram", connectionId: "conn-telegram-001" },
  locale: "vi",
  requestId: "request-telegram-001",
  shopId: "shop-demo",
};

type Variant = {
  productTitle: string;
  stock: number;
  title: string;
  unitPriceMinor: number;
  version: number;
};

type Cart = {
  access: CommerceCreateCartView["access"];
  items: readonly { quantity: number; variantId: string }[];
  shopId: string;
  state: "active" | "converted";
};

type IdempotencyRecord = {
  requestFingerprint: string;
  view: CommerceCheckoutView;
};

/**
 * A deterministic port lets both existing adapters exercise one contract
 * before either production path is cut over to the application service.
 */
class DeterministicCommercePort implements CommerceApplicationPort {
  private readonly carts = new Map<string, Cart>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly variants = new Map<string, Map<string, Variant>>();
  private sequence = 0;

  constructor() {
    this.seed("shop-demo", "var-paid", { productTitle: "License", stock: 4, title: "Paid", unitPriceMinor: 9_000, version: 1 });
    this.seed("shop-demo", "var-free", { productTitle: "Guide", stock: 1, title: "Free", unitPriceMinor: 0, version: 1 });
    this.seed("shop-stock", "var-last", { productTitle: "Last key", stock: 1, title: "One", unitPriceMinor: 5_000, version: 1 });
    this.seed("shop-other", "var-paid", { productTitle: "Other license", stock: 2, title: "Paid", unitPriceMinor: 9_000, version: 1 });
  }

  seed(shopId: string, variantId: string, variant: Variant): void {
    const shopVariants = this.variants.get(shopId) ?? new Map<string, Variant>();
    shopVariants.set(variantId, variant);
    this.variants.set(shopId, shopVariants);
  }

  createCart(input: Parameters<CommerceApplicationPort["createCart"]>[0]): Promise<CommerceCreateCartView> {
    this.assertCatalog(input.context.shopId, input.command.items);
    const cartId = `cart-${String(++this.sequence).padStart(3, "0")}`;
    const access: CommerceCreateCartView["access"] = input.context.actor.kind === "customer"
      ? { kind: "principal" }
      : { kind: "opaque_token", token: `cart-access-token-${String(this.sequence).padStart(20, "0")}` };
    this.carts.set(this.key(input.context.shopId, cartId), { access, items: input.command.items, shopId: input.context.shopId, state: "active" });
    return Promise.resolve({ access, cartId, expiresAt: EXPIRES_AT });
  }

  getOrder(): Promise<CommerceOrderView> {
    return Promise.resolve({
      currency: "VND",
      expiresAt: EXPIRES_AT,
      fulfillmentStatus: "reserved",
      items: [{ fulfillmentType: "manual", lineTotalMinor: 9_000, productTitle: "License", quantity: 1, variantTitle: "Paid" }],
      orderNumber: "ORDER-001",
      paymentStatus: "unpaid",
      status: "pending_payment",
      totalMinor: 9_000,
    });
  }

  quoteCart(input: Parameters<CommerceApplicationPort["quoteCart"]>[0]): Promise<CommerceQuoteView> {
    const cart = this.loadCart(input.context, input.command.cart.cartId);
    const lines = this.lines(cart);
    const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    return Promise.resolve({ currency: "VND", discountMinor: 0, expiresAt: "2026-07-26T01:00:00.000Z", items: lines, subtotalMinor, totalMinor: subtotalMinor });
  }

  checkoutCart(input: Parameters<CommerceApplicationPort["checkoutCart"]>[0]): Promise<CommerceCheckoutView> {
    const fingerprint = JSON.stringify({ cart: input.command.cart.cartId, customerEmail: input.command.customerEmail, expected: input.command.expected });
    const idempotencyKey = `${input.context.shopId}:${input.command.idempotencyKey}`;
    const existing = this.idempotency.get(idempotencyKey);
    if (existing !== undefined) {
      if (existing.requestFingerprint !== fingerprint) throw new AppError("idempotency_conflict", 409);
      return Promise.resolve(existing.view);
    }
    const cart = this.loadCart(input.context, input.command.cart.cartId);
    const lines = this.lines(cart);
    for (const line of lines) {
      const expected = input.command.expected.find((item) => item.variantId === line.variantId);
      if (expected === undefined || expected.unitPriceMinor !== line.unitPriceMinor || expected.variantVersion !== line.variantVersion) throw new AppError("checkout_changed", 409);
      const variant = this.variants.get(cart.shopId)?.get(line.variantId);
      if (variant === undefined || variant.stock < line.quantity) throw new AppError("inventory_unavailable", 409);
    }
    for (const line of lines) {
      const variant = this.variants.get(cart.shopId)?.get(line.variantId);
      if (variant !== undefined) variant.stock -= line.quantity;
    }
    const totalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    const isFree = totalMinor === 0;
    const view: CommerceCheckoutView = {
      access: input.context.actor.kind === "customer" ? { kind: "principal" } : { kind: "opaque_token", token: `order-access-token-${String(this.sequence).padStart(20, "0")}` },
      currency: "VND",
      expiresAt: EXPIRES_AT,
      fulfillmentStatus: isFree ? "fulfilled" : "reserved",
      orderId: `order-${String(this.sequence).padStart(3, "0")}`,
      orderNumber: `ORDER-${String(this.sequence).padStart(3, "0")}`,
      paymentStatus: isFree ? "paid" : "unpaid",
      status: isFree ? "completed" : "pending_payment",
      totalMinor,
    };
    cart.state = "converted";
    this.idempotency.set(idempotencyKey, { requestFingerprint: fingerprint, view });
    return Promise.resolve(view);
  }

  private assertCatalog(shopId: string, items: readonly { quantity: number; variantId: string }[]): void {
    for (const item of items) {
      const variant = this.variants.get(shopId)?.get(item.variantId);
      if (variant === undefined) throw new AppError("catalog_changed", 409);
      if (variant.stock < item.quantity) throw new AppError("inventory_unavailable", 409);
    }
  }

  private key(shopId: string, cartId: string): string {
    return `${shopId}:${cartId}`;
  }

  private loadCart(context: CommerceContext, cartId: string): Cart {
    const cart = this.carts.get(this.key(context.shopId, cartId));
    if (cart === undefined || cart.state !== "active") throw new AppError("cart_not_found", 404);
    return cart;
  }

  private lines(cart: Cart): CommerceQuoteView["items"] {
    const variants = this.variants.get(cart.shopId);
    if (variants === undefined) throw new AppError("catalog_changed", 409);
    return cart.items.map((item) => {
      const variant = variants.get(item.variantId);
      if (variant === undefined) throw new AppError("catalog_changed", 409);
      return {
        lineTotalMinor: variant.unitPriceMinor * item.quantity,
        productTitle: variant.productTitle,
        quantity: item.quantity,
        unitPriceMinor: variant.unitPriceMinor,
        variantId: item.variantId,
        variantTitle: variant.title,
        variantVersion: variant.version,
      };
    });
  }
}

function createService(): { port: DeterministicCommercePort; service: CommerceApplicationService } {
  const port = new DeterministicCommercePort();
  return { port, service: new CommerceApplicationService(port) };
}

describe("CommerceApplicationService canonical contract", () => {
  it.each([
    ["website", websiteContext],
    ["telegram", telegramContext],
  ] as const)("runs create -> quote -> checkout through one %s command contract", async (_channel, context) => {
    const { service } = createService();
    const variantId = "var-paid";
    const create = await service.createCart(context, { items: [{ quantity: 1, variantId }] });
    const quote = await service.quoteCart(context, { cart: { access: create.access, cartId: create.cartId } });
    const checkout = await service.checkoutCart(context, {
      cart: { access: create.access, cartId: create.cartId },
      customerEmail: context.actor.kind === "anonymous" ? "buyer@example.com" : null,
      expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: `checkout-${context.channel.code}-0001`,
    });

    expect(quote).toMatchObject({ currency: "VND", subtotalMinor: 9_000, totalMinor: 9_000 });
    expect(checkout).toMatchObject({ currency: "VND", fulfillmentStatus: "reserved", paymentStatus: "unpaid", status: "pending_payment", totalMinor: 9_000 });
  });

  it("keeps order access inside the canonical application boundary", async () => {
    const { service } = createService();
    await expect(service.getOrder(websiteContext, {
      order: { access: { kind: "opaque_token", token: "order-access-token-1234567890" }, orderId: "order-001" },
    })).resolves.toMatchObject({ orderNumber: "ORDER-001", paymentStatus: "unpaid", status: "pending_payment" });
  });

  it("keeps provider presentation and external identity out of canonical views", async () => {
    const { service } = createService();
    const quote = await service.quoteCart(telegramContext, {
      cart: { access: { kind: "principal" }, cartId: (await service.createCart(telegramContext, { items: [{ quantity: 1, variantId: "var-paid" }] })).cartId },
    });
    expect(Object.keys(quote.items[0] ?? {}).sort()).toEqual(["lineTotalMinor", "productTitle", "quantity", "unitPriceMinor", "variantId", "variantTitle", "variantVersion"].sort());
    expect(JSON.stringify(quote)).not.toContain("provider");
    expect(JSON.stringify(quote)).not.toContain("chatId");
  });

  it("supports free fulfillment and paid reservation outcomes", async () => {
    const { service } = createService();
    const freeCart = await service.createCart(telegramContext, { items: [{ quantity: 1, variantId: "var-free" }] });
    const freeQuote = await service.quoteCart(telegramContext, { cart: { access: freeCart.access, cartId: freeCart.cartId } });
    const freeOrder = await service.checkoutCart(telegramContext, {
      cart: { access: freeCart.access, cartId: freeCart.cartId },
      customerEmail: null,
      expected: freeQuote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: "checkout-free-000001",
    });
    expect(freeOrder).toMatchObject({ fulfillmentStatus: "fulfilled", paymentStatus: "paid", status: "completed", totalMinor: 0 });
  });

  it("scopes idempotency by shop, replays identical requests, and rejects conflicts", async () => {
    const { service } = createService();
    const cart = await service.createCart(websiteContext, { items: [{ quantity: 1, variantId: "var-paid" }] });
    const quote = await service.quoteCart(websiteContext, { cart: { access: cart.access, cartId: cart.cartId } });
    const command = {
      cart: { access: cart.access, cartId: cart.cartId },
      customerEmail: "buyer@example.com",
      expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: "checkout-replay-0001",
    } as const;
    const first = await service.checkoutCart(websiteContext, command);
    await expect(service.checkoutCart(websiteContext, command)).resolves.toEqual(first);

    const secondCart = await service.createCart(websiteContext, { items: [{ quantity: 1, variantId: "var-paid" }] });
    const secondQuote = await service.quoteCart(websiteContext, { cart: { access: secondCart.access, cartId: secondCart.cartId } });
    await expect(service.checkoutCart(websiteContext, {
      ...command,
      cart: { access: secondCart.access, cartId: secondCart.cartId },
      expected: secondQuote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });

    const otherShop = { ...websiteContext, shopId: "shop-other" };
    const otherCart = await service.createCart(otherShop, { items: [{ quantity: 1, variantId: "var-paid" }] });
    const otherQuote = await service.quoteCart(otherShop, { cart: { access: otherCart.access, cartId: otherCart.cartId } });
    await expect(service.checkoutCart(otherShop, {
      ...command,
      cart: { access: otherCart.access, cartId: otherCart.cartId },
      expected: otherQuote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
    })).resolves.toMatchObject({ status: "pending_payment" });
  });

  it("enforces one shared last-stock boundary across website and Telegram contexts", async () => {
    const { service } = createService();
    const website = { ...websiteContext, shopId: "shop-stock" };
    const telegram = { ...telegramContext, shopId: "shop-stock" };
    const websiteCart = await service.createCart(website, { items: [{ quantity: 1, variantId: "var-last" }] });
    const telegramCart = await service.createCart(telegram, { items: [{ quantity: 1, variantId: "var-last" }] });
    const websiteQuote = await service.quoteCart(website, { cart: { access: websiteCart.access, cartId: websiteCart.cartId } });
    const telegramQuote = await service.quoteCart(telegram, { cart: { access: telegramCart.access, cartId: telegramCart.cartId } });
    const checkoutInput = (cart: typeof websiteCart, quote: CommerceQuoteView) => ({
      cart: { access: cart.access, cartId: cart.cartId },
      customerEmail: null,
      expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: `checkout-stock-${cart.cartId}-0001`,
    });
    await expect(service.checkoutCart(website, checkoutInput(websiteCart, websiteQuote))).resolves.toMatchObject({ status: "pending_payment" });
    await expect(service.checkoutCart(telegram, checkoutInput(telegramCart, telegramQuote))).rejects.toMatchObject({ code: "inventory_unavailable", status: 409 });
  });

  it("does not allow a cart from one shop to be read through another shop context", async () => {
    const { service } = createService();
    const cart = await service.createCart(websiteContext, { items: [{ quantity: 1, variantId: "var-paid" }] });
    await expect(service.quoteCart({ ...websiteContext, shopId: "shop-other" }, { cart: { access: cart.access, cartId: cart.cartId } })).rejects.toMatchObject({ code: "cart_not_found", status: 404 });
  });

  it("rejects provider-specific identity fields before the port runs", async () => {
    const { service } = createService();
    await expect(service.createCart({
      ...websiteContext,
      actor: { kind: "anonymous", telegramUserId: "123" } as never,
    }, { items: [{ quantity: 1, variantId: "var-paid" }] })).rejects.toMatchObject({ code: "validation_failed", status: 400 });
  });

  it("accepts the same generic channel-code grammar as the adapter registry", async () => {
    const { service } = createService();
    const genericContext: CommerceContext = {
      ...telegramContext,
      channel: { code: "fake:third", connectionId: "conn-fake-third" },
    };
    const view = await service.createCart(genericContext, { items: [{ quantity: 1, variantId: "var-paid" }] });
    expect(view.cartId).toMatch(/^cart-/u);
  });

  it.each(["EN-us", "vi-Latn-VN", "en-US-u-nu-latn"])("accepts supported BCP47 locale hint %s at the canonical boundary", async (locale) => {
    const listOrders = vi.fn(() => Promise.resolve([]));
    const service = new CommerceApplicationService({ listOrders });
    const context = { ...telegramContext, locale };

    await expect(service.listOrders(context, {})).resolves.toEqual([]);
    expect(listOrders).toHaveBeenCalledWith({ command: {}, context });
  });

  it.each(["fr-FR", "vi_VN", "not a locale"])("rejects unsupported or malformed locale hint %s before the port runs", async (locale) => {
    const listOrders = vi.fn(() => Promise.resolve([]));
    const service = new CommerceApplicationService({ listOrders });

    await expect(service.listOrders({ ...telegramContext, locale }, {}))
      .rejects.toMatchObject({ code: "validation_failed", issues: ["locale_invalid"], status: 400 });
    expect(listOrders).not.toHaveBeenCalled();
  });

  it("fails closed for unknown commands and incomplete checkout evidence", async () => {
    const { service } = createService();
    await expect(service.execute(websiteContext, { kind: "provider.send", input: {} } as never))
      .rejects.toMatchObject({ code: "validation_failed", status: 400 });
    const cart = await service.createCart(websiteContext, { items: [{ quantity: 1, variantId: "var-paid" }] });
    await expect(service.checkoutCart(websiteContext, {
      cart: { access: cart.access, cartId: cart.cartId },
      customerEmail: null,
      expected: [],
      idempotencyKey: "checkout-empty-0001",
    })).rejects.toMatchObject({ code: "validation_failed", status: 400 });
  });

  it("rejects ambiguous duplicate checkout evidence before the port runs", async () => {
    const { service } = createService();
    const cart = await service.createCart(websiteContext, { items: [{ quantity: 1, variantId: "var-paid" }] });
    const quote = await service.quoteCart(websiteContext, { cart: { access: cart.access, cartId: cart.cartId } });
    const expected = quote.items.map((item) => ({
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      variantId: item.variantId,
      variantVersion: item.variantVersion,
    }));

    await expect(service.checkoutCart(websiteContext, {
      cart: { access: cart.access, cartId: cart.cartId },
      customerEmail: "buyer@example.com",
      expected: [...expected, ...expected],
      idempotencyKey: "checkout-duplicate-0001",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["checkout_expected_duplicate"], status: 400 });
  });

  it("keeps stale quote evidence from crossing the checkout boundary", async () => {
    const { port, service } = createService();
    const cart = await service.createCart(websiteContext, { items: [{ quantity: 1, variantId: "var-paid" }] });
    const quote = await service.quoteCart(websiteContext, { cart: { access: cart.access, cartId: cart.cartId } });

    port.seed("shop-demo", "var-paid", {
      productTitle: "License",
      stock: 4,
      title: "Paid",
      unitPriceMinor: 9_500,
      version: 2,
    });

    await expect(service.checkoutCart(websiteContext, {
      cart: { access: cart.access, cartId: cart.cartId },
      customerEmail: "buyer@example.com",
      expected: quote.items.map((item) => ({
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        variantId: item.variantId,
        variantVersion: item.variantVersion,
      })),
      idempotencyKey: "checkout-stale-quote-001",
    })).rejects.toMatchObject({ code: "checkout_changed", status: 409 });
  });

  it("requires checkout quantity at the canonical boundary", async () => {
    const { service } = createService();
    const cart = await service.createCart(websiteContext, { items: [{ quantity: 1, variantId: "var-paid" }] });

    await expect(service.checkoutCart(websiteContext, {
      cart: { access: cart.access, cartId: cart.cartId },
      customerEmail: null,
      expected: [{ unitPriceMinor: 9_000, variantId: "var-paid", variantVersion: 1 }],
      idempotencyKey: "checkout-quantity-0001",
    } as never)).rejects.toMatchObject({ code: "validation_failed", issues: ["quantity_invalid"], status: 400 });
  });

  it("routes order listing through the canonical port and normalizes summaries", async () => {
    const listOrders = vi.fn(() => Promise.resolve([{
      currency: "VND",
      fulfillmentStatus: "reserved",
      internalOrderId: "must-not-leak",
      orderId: "order-telegram-001",
      orderNumber: "ORDER-TELEGRAM-001",
      paymentStatus: "unpaid",
      status: "pending_payment",
      totalMinor: 9_000,
    }] as never));
    const service = new CommerceApplicationService({ listOrders });

    await expect(service.listOrders(telegramContext, {})).resolves.toEqual([{
      currency: "VND",
      fulfillmentStatus: "reserved",
      orderId: "order-telegram-001",
      orderNumber: "ORDER-TELEGRAM-001",
      paymentStatus: "unpaid",
      status: "pending_payment",
      totalMinor: 9_000,
    }]);
    expect(listOrders).toHaveBeenCalledWith({ command: {}, context: telegramContext });
    await expect(service.listOrders(telegramContext, { providerUserId: "123" } as never))
      .rejects.toMatchObject({ code: "validation_failed", issues: ["order_list_invalid"], status: 400 });
  });

  it("composes payment and fulfillment methods without leaking provider fields", async () => {
    const paymentFulfillment: CommercePaymentFulfillmentApplication = {
      createPaymentHandoff: vi.fn<CommercePaymentFulfillmentApplication["createPaymentHandoff"]>(() => Promise.resolve({
        expiresAt: EXPIRES_AT,
        handoffId: "payment-handoff-001",
        presentation: { kind: "qr", payload: "qr-payload" },
        providerPaymentLinkId: "must-not-leak",
        redirectUrl: "https://pay.example.test/checkout",
        status: "pending",
      } as never)),
      getFulfillmentEligibility: vi.fn<CommercePaymentFulfillmentApplication["getFulfillmentEligibility"]>((_context, command) => Promise.resolve({ eligible: true, orderId: command.order.orderId, reason: "ready" })),
      revealFulfillment: vi.fn<CommercePaymentFulfillmentApplication["revealFulfillment"]>((_context, command) => Promise.resolve({
        items: [{ productTitle: "License", providerReference: "must-not-leak", value: "LICENSE-ONLY", variantTitle: "Lifetime" }],
        orderId: command.order.orderId,
      } as never)),
    };
    const service = new CommerceApplicationService({}, paymentFulfillment);
    const order = { access: { kind: "principal" as const }, orderId: "order-telegram-001" };

    await expect(service.createPaymentHandoff(telegramContext, { order, origin: "https://shop.example.test" })).resolves.toEqual({
      expiresAt: EXPIRES_AT,
      handoffId: "payment-handoff-001",
      presentation: { kind: "qr", payload: "qr-payload" },
      redirectUrl: "https://pay.example.test/checkout",
      status: "pending",
    });
    await expect(service.getFulfillmentEligibility(telegramContext, { order })).resolves.toEqual({ eligible: true, orderId: order.orderId, reason: "ready" });
    await expect(service.revealFulfillment(telegramContext, { order })).resolves.toEqual({
      items: [{ productTitle: "License", value: "LICENSE-ONLY", variantTitle: "Lifetime" }],
      orderId: order.orderId,
    });
    await expect(service.execute(telegramContext, { kind: "payment.handoff.create", input: { order, origin: "https://shop.example.test" } }))
      .resolves.toMatchObject({ handoffId: "payment-handoff-001" });
  });

  it("preserves the compatibility fulfillment gate when composed into the application", async () => {
    const revealFulfillment = vi.fn<CommercePaymentFulfillmentPort["revealFulfillment"]>(() => Promise.resolve({
      items: [{ productTitle: "License", value: "LICENSE-ONLY", variantTitle: "Lifetime" }],
      orderId: "order-telegram-001",
    }));
    const compatibilityService = new CommercePaymentFulfillmentService({
      createPaymentHandoff: vi.fn(() => Promise.reject(new Error("not_used"))),
      getFulfillmentEligibility: vi.fn<CommercePaymentFulfillmentPort["getFulfillmentEligibility"]>(() => Promise.resolve({ eligible: false, orderId: "order-telegram-001", reason: "payment_unconfirmed" })),
      revealFulfillment,
    });
    const service = new CommerceApplicationService({}, compatibilityService);

    await expect(service.revealFulfillment(telegramContext, {
      order: { access: { kind: "principal" }, orderId: "order-telegram-001" },
    })).rejects.toMatchObject({ code: "order_not_ready", status: 409 });
    expect(revealFulfillment).not.toHaveBeenCalled();
  });

  it("fails closed when optional list or payment capabilities are absent", async () => {
    const service = new CommerceApplicationService({});
    const order = { access: { kind: "principal" as const }, orderId: "order-telegram-001" };

    await expect(service.listOrders(telegramContext, {})).rejects.toMatchObject({ code: "commerce_operation_unsupported", issues: ["order_list"], status: 501 });
    await expect(service.createPaymentHandoff(telegramContext, { order, origin: "https://shop.example.test" }))
      .rejects.toMatchObject({ code: "commerce_operation_unsupported", issues: ["payment_handoff_create"], status: 501 });
  });
});
