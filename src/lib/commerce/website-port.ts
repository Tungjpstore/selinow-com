import { AppError } from "../core/errors";
import { WEBSITE_CHANNEL_CODE } from "../channels/builtins";
import type { AppBindings } from "../platform/bindings";
import type { StorefrontShop } from "../storefront/store";
import { CommerceApplicationService } from "./application";
import type {
  CommerceApplicationPort,
  CommerceCartAccess,
  CommerceCartMutationCommand,
  CommerceCartMutationView,
  CommerceCheckoutCommand,
  CommerceCheckoutRecoveryCommand,
  CommerceCheckoutRecoveryPrepareCommand,
  CommerceCheckoutRecoveryPrepareView,
  CommerceCheckoutRecoveryView,
  CommerceCheckoutView,
  CommerceContext,
  CommerceCreateCartCommand,
  CommerceCreateCartView,
  CommerceOrderReference,
  CommerceOrderView,
  CommercePrivateDownloadConsumeCommand,
  CommercePrivateDownloadGrantCommand,
  CommercePrivateDownloadGrantView,
  CommercePrivateDownloadListCommand,
  CommercePrivateDownloadPayload,
  CommercePrivateDownloadView,
  CommerceQuoteCommand,
  CommerceQuoteItem,
  CommerceQuoteView,
} from "./contracts";
import { checkoutCart, createCart, getOrder, quoteCart } from "./store";
import { applyWebsiteCartMutation } from "./cart-mutation";
import {
  consumeWebsitePrivateDownloadGrant,
  issueWebsitePrivateDownloadGrant,
  listWebsitePrivateDownloads,
} from "./private-file-fulfillment";
import { prepareWebsiteCheckoutRecovery, recoverWebsiteCheckout } from "./website-checkout-recovery";
import { createWebsitePaymentFulfillmentApplication } from "./payment-fulfillment";

function assertWebsiteContext(context: CommerceContext, shop: StorefrontShop): void {
  if (context.shopId !== shop.id) throw new AppError("commerce_context_mismatch", 403, ["shop_id_mismatch"]);
  if (context.channel.code !== WEBSITE_CHANNEL_CODE || context.channel.connectionId !== null) {
    throw new AppError("commerce_context_mismatch", 403, ["website_channel_required"]);
  }
  if (context.actor.kind !== "anonymous") throw new AppError("commerce_context_mismatch", 403, ["anonymous_actor_required"]);
}

function opaqueToken(access: CommerceCartAccess): string {
  if (access.kind !== "opaque_token") throw new AppError("commerce_context_mismatch", 403, ["opaque_access_required"]);
  return access.token;
}

function quoteItem(value: unknown): CommerceQuoteItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppError("commerce_contract_invalid", 500, ["quote_item_invalid"]);
  const item = value as Record<string, unknown>;
  if (
    typeof item.productTitle !== "string"
    || typeof item.variantTitle !== "string"
    || typeof item.variantId !== "string"
    || typeof item.quantity !== "number"
    || typeof item.unitPriceMinor !== "number"
    || typeof item.variantVersion !== "number"
  ) {
    throw new AppError("commerce_contract_invalid", 500, ["quote_item_invalid"]);
  }
  const lineTotalMinor = typeof item.lineTotalMinor === "number" ? item.lineTotalMinor : item.quantity * item.unitPriceMinor;
  return {
    lineTotalMinor,
    productTitle: item.productTitle,
    quantity: item.quantity,
    unitPriceMinor: item.unitPriceMinor,
    variantId: item.variantId,
    variantTitle: item.variantTitle,
    variantVersion: item.variantVersion,
  };
}

function requiredQuoteEvidence(value: unknown): string {
  if (typeof value !== "string" || value.length < 40 || value.length > 4_096) throw new AppError("commerce_contract_invalid", 500, ["quote_evidence_invalid"]);
  return value;
}

/**
 * Website's legacy store functions remain the D1-backed implementation while
 * this port gives them the channel-neutral application contract.
 */
export class WebsiteCommercePort implements CommerceApplicationPort {
  constructor(private readonly env: AppBindings, private readonly shop: StorefrontShop) {}

  async createCart(input: { command: CommerceCreateCartCommand; context: CommerceContext }): Promise<CommerceCreateCartView> {
    assertWebsiteContext(input.context, this.shop);
    const cart = await createCart({ env: this.env, items: [...input.command.items], locale: input.context.locale, shop: this.shop });
    return { access: { kind: "opaque_token", token: cart.cartToken }, cartId: cart.cartId, expiresAt: cart.expiresAt };
  }

  async quoteCart(input: { command: CommerceQuoteCommand; context: CommerceContext }): Promise<CommerceQuoteView> {
    assertWebsiteContext(input.context, this.shop);
    const quote = await quoteCart({
      cartId: input.command.cart.cartId,
      cartToken: opaqueToken(input.command.cart.access),
      env: this.env,
      ...(input.command.shippingMethodId === undefined ? {} : { shippingMethodId: input.command.shippingMethodId }),
      shop: this.shop,
    });
    const items = quote.items.map(quoteItem);
    const subtotalMinor = quote.subtotalMinor;
    const discountMinor = "discountMinor" in quote && typeof quote.discountMinor === "number" ? quote.discountMinor : 0;
    return {
      currency: quote.currency,
      discountMinor,
      expiresAt: quote.expiresAt,
      items,
      quoteEvidence: requiredQuoteEvidence(quote.quoteEvidence),
      ...(quote.shipping === undefined ? {} : {
        shipping: {
          feeMinor: quote.shipping.feeMinor,
          methodId: quote.shipping.methodId,
          methods: [...quote.shipping.methods],
        },
      }),
      subtotalMinor,
      totalMinor: typeof quote.totalMinor === "number" ? quote.totalMinor : subtotalMinor - discountMinor,
    };
  }

  async mutateCart(input: { command: CommerceCartMutationCommand; context: CommerceContext }): Promise<CommerceCartMutationView> {
    assertWebsiteContext(input.context, this.shop);
    if (input.command.cart.access.kind !== "opaque_token" || input.command.cart.cartId === null) {
      throw new AppError("commerce_context_mismatch", 403, ["opaque_access_required"]);
    }
    const result = await applyWebsiteCartMutation({
      cartId: input.command.cart.cartId,
      cartToken: input.command.cart.access.token,
      env: this.env,
      idempotencyKey: input.command.idempotencyKey,
      mutation: input.command.mutation,
      shop: this.shop,
    });
    return { cart: { access: { kind: "opaque_token", token: input.command.cart.access.token }, cartId: result.cartId }, replayed: result.replayed };
  }

  async checkoutCart(input: { command: CommerceCheckoutCommand; context: CommerceContext }): Promise<CommerceCheckoutView> {
    assertWebsiteContext(input.context, this.shop);
    if (input.command.quoteEvidence === undefined) throw new AppError("quote_invalid", 409);
    const order = await checkoutCart({
      cartId: input.command.cart.cartId,
      cartToken: opaqueToken(input.command.cart.access),
      customerEmail: input.command.customerEmail,
      env: this.env,
      expected: [...input.command.expected],
      idempotencyKey: input.command.idempotencyKey,
      quoteEvidence: input.command.quoteEvidence,
      ...(input.command.shipping === undefined ? {} : { shipping: input.command.shipping }),
      shop: this.shop,
    });
    const orderRecord = order as unknown as Record<string, unknown>;
    const fulfillmentStatus = typeof orderRecord.fulfillmentStatus === "string"
      ? orderRecord.fulfillmentStatus
      : order.status === "completed" ? "fulfilled" : "reserved";
    const currency = typeof orderRecord.currency === "string" ? orderRecord.currency : this.shop.currency;
    const orderNumber = typeof orderRecord.orderNumber === "string" ? orderRecord.orderNumber : order.orderId.slice(-12).toUpperCase();
    return {
      access: { kind: "opaque_token", token: order.orderToken },
      currency,
      expiresAt: order.expiresAt,
      fulfillmentStatus,
      orderId: order.orderId,
      orderNumber,
      paymentStatus: order.paymentStatus,
      status: order.status,
      totalMinor: order.totalMinor,
    };
  }

  async prepareCheckoutRecovery(input: { command: CommerceCheckoutRecoveryPrepareCommand; context: CommerceContext }): Promise<CommerceCheckoutRecoveryPrepareView> {
    assertWebsiteContext(input.context, this.shop);
    const cartToken = opaqueToken(input.command.cart.access);
    return prepareWebsiteCheckoutRecovery({
      cartId: input.command.cart.cartId,
      cartToken,
      customerEmail: input.command.customerEmail,
      env: this.env,
      expected: [...input.command.expected],
      idempotencyKey: input.command.idempotencyKey,
      quoteEvidence: input.command.quoteEvidence,
      shop: this.shop,
    });
  }

  async recoverCheckout(input: { command: CommerceCheckoutRecoveryCommand; context: CommerceContext }): Promise<CommerceCheckoutRecoveryView> {
    assertWebsiteContext(input.context, this.shop);
    const cartToken = opaqueToken(input.command.cart.access);
    const order = await recoverWebsiteCheckout({
      cartId: input.command.cart.cartId,
      cartToken,
      customerEmail: input.command.customerEmail,
      env: this.env,
      expected: [...input.command.expected],
      idempotencyKey: input.command.idempotencyKey,
      recoveryEvidence: input.command.recoveryEvidence,
      shop: this.shop,
    });
    return {
      access: { kind: "opaque_token", token: order.orderToken },
      currency: order.currency,
      expiresAt: order.expiresAt,
      fulfillmentStatus: order.fulfillmentStatus,
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      paymentStatus: order.paymentStatus,
      status: order.status,
      totalMinor: order.totalMinor,
    };
  }

  async getOrder(input: { command: { order: CommerceOrderReference }; context: CommerceContext }): Promise<CommerceOrderView> {
    assertWebsiteContext(input.context, this.shop);
    if (input.command.order.access.kind !== "opaque_token" || typeof input.command.order.access.token !== "string") {
      throw new AppError("commerce_context_mismatch", 403, ["opaque_access_required"]);
    }
    const order = await getOrder({ env: this.env, orderPublicId: input.command.order.orderId, orderToken: input.command.order.access.token, shop: this.shop });
    if (typeof order !== "object" || order === null || Array.isArray(order)) throw new AppError("commerce_contract_invalid", 500, ["order_view_invalid"]);
    const value = order as Record<string, unknown>;
    if (typeof value.currency !== "string" || typeof value.expiresAt !== "string" || typeof value.fulfillmentStatus !== "string" || typeof value.orderNumber !== "string" || typeof value.paymentStatus !== "string" || typeof value.status !== "string" || typeof value.totalMinor !== "number" || !Array.isArray(value.items)) throw new AppError("commerce_contract_invalid", 500, ["order_view_invalid"]);
    return {
      currency: value.currency,
      expiresAt: value.expiresAt,
      fulfillmentStatus: value.fulfillmentStatus,
      items: value.items.map((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) throw new AppError("commerce_contract_invalid", 500, ["order_item_invalid"]);
        const row = item as Record<string, unknown>;
        if (typeof row.fulfillmentType !== "string" || typeof row.lineTotalMinor !== "number" || typeof row.productTitle !== "string" || typeof row.quantity !== "number" || typeof row.variantTitle !== "string") throw new AppError("commerce_contract_invalid", 500, ["order_item_invalid"]);
        return { fulfillmentType: row.fulfillmentType, lineTotalMinor: row.lineTotalMinor, productTitle: row.productTitle, quantity: row.quantity, variantTitle: row.variantTitle };
      }),
      orderNumber: value.orderNumber,
      paymentStatus: value.paymentStatus,
      status: value.status,
      totalMinor: value.totalMinor,
    };
  }

  async listPrivateDownloads(input: { command: CommercePrivateDownloadListCommand; context: CommerceContext }): Promise<readonly CommercePrivateDownloadView[]> {
    assertWebsiteContext(input.context, this.shop);
    return listWebsitePrivateDownloads({
      env: this.env,
      orderPublicId: input.command.order.orderId,
      orderToken: opaqueToken(input.command.order.access),
      shopId: this.shop.id,
    });
  }

  async issuePrivateDownloadGrant(input: { command: CommercePrivateDownloadGrantCommand; context: CommerceContext }): Promise<CommercePrivateDownloadGrantView> {
    assertWebsiteContext(input.context, this.shop);
    return issueWebsitePrivateDownloadGrant({
      assetVersionId: input.command.assetVersionId,
      env: this.env,
      idempotencyKey: input.command.idempotencyKey,
      orderItemId: input.command.orderItemId,
      orderPublicId: input.command.order.orderId,
      orderToken: opaqueToken(input.command.order.access),
      requestId: input.context.requestId,
      shopId: this.shop.id,
    });
  }

  async consumePrivateDownloadGrant(input: { command: CommercePrivateDownloadConsumeCommand; context: CommerceContext }): Promise<CommercePrivateDownloadPayload> {
    assertWebsiteContext(input.context, this.shop);
    return consumeWebsitePrivateDownloadGrant({
      env: this.env,
      grantId: input.command.grantId,
      grantToken: input.command.grantToken,
      idempotencyKey: input.command.idempotencyKey,
      orderPublicId: input.command.order.orderId,
      orderToken: opaqueToken(input.command.order.access),
      requestId: input.context.requestId,
      shopId: this.shop.id,
    });
  }
}

export function createWebsiteCommerceApplication(env: AppBindings, shop: StorefrontShop): CommerceApplicationService {
  return new CommerceApplicationService(
    new WebsiteCommercePort(env, shop),
    createWebsitePaymentFulfillmentApplication(env, shop),
  );
}
