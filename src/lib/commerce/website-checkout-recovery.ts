import { constantTimeEqual, hmacToken } from "../core/crypto";
import { AppError } from "../core/errors";
import { resolveOrderChannelAttribution } from "../channels/attribution";
import { WEBSITE_CHANNEL_CODE } from "../channels/builtins";
import type { AppBindings } from "../platform/bindings";
import type { StorefrontShop } from "../storefront/store";
import { createCheckoutRecoveryEvidence, verifyCheckoutRecoveryEvidence } from "./checkout-recovery-evidence";
import { verifyQuoteEvidence } from "./quote-evidence";
import { loadWebsiteCheckoutState, websiteCheckoutFingerprint } from "./store";
import type { WebsiteCheckoutExpectedItem } from "./website-checkout-input";

type CartProofRow = {
  discountCode: string | null;
  expiresAt: string;
  state: string;
  subjectHash: string;
};

const WEBSITE_ORDER_ATTRIBUTION = resolveOrderChannelAttribution(WEBSITE_CHANNEL_CODE);

export type RecoveredWebsiteOrder = {
  currency: string;
  expiresAt: string;
  fulfillmentStatus: string;
  orderId: string;
  orderNumber: string;
  orderToken: string;
  paymentStatus: string;
  status: string;
  totalMinor: number;
};

async function readCartProof(input: { cartId: string; env: AppBindings; shopId: string }): Promise<CartProofRow> {
  const row = await input.env.PLATFORM_DB.prepare(
    "SELECT discount_code_normalized AS discountCode, subject_hash AS subjectHash, state, expires_at AS expiresAt FROM carts WHERE id = ? AND shop_id = ? AND channel = 'web' LIMIT 1",
  ).bind(input.cartId, input.shopId).first<CartProofRow>();
  if (row === null) throw new AppError("cart_not_found", 404);
  return row;
}

async function verifyCartToken(input: { cartToken: string; env: AppBindings; shopId: string; subjectHash: string }): Promise<void> {
  const tokenHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, `cart:${input.shopId}`, input.cartToken);
  if (!constantTimeEqual(input.subjectHash, tokenHash)) throw new AppError("cart_not_found", 404);
}

async function checkoutHashes(input: {
  cartId: string;
  customerEmail: string | null;
  discountCode: string | null;
  discountMinor: number;
  env: AppBindings;
  expected: WebsiteCheckoutExpectedItem[];
  idempotencyKey: string;
  shopId: string;
  totalMinor: number;
}): Promise<{ checkoutSubjectHash: string; requestHash: string }> {
  const [checkoutSubjectHash, requestHash] = await Promise.all([
    hmacToken(input.env.IDENTIFIER_HMAC_SECRET, `checkout:${input.shopId}`, input.idempotencyKey),
    websiteCheckoutFingerprint({
      cartId: input.cartId,
      customerEmail: input.customerEmail,
      discountCode: input.discountCode,
      discountMinor: input.discountMinor,
      expected: input.expected,
      totalMinor: input.totalMinor,
    }),
  ]);
  return { checkoutSubjectHash, requestHash };
}

export async function prepareWebsiteCheckoutRecovery(input: {
  cartId: string;
  cartToken: string;
  customerEmail: string | null;
  env: AppBindings;
  expected: WebsiteCheckoutExpectedItem[];
  idempotencyKey: string;
  quoteEvidence: string;
  shop: StorefrontShop;
}): Promise<{ evidence: string; expiresAt: string }> {
  const state = await loadWebsiteCheckoutState({
    cartId: input.cartId,
    cartToken: input.cartToken,
    env: input.env,
    shop: input.shop,
  });
  const cart = state.cart;
  const now = new Date();
  await verifyQuoteEvidence({
    catalog: state.lines.map((line) => ({
      productVersion: line.productVersion,
      quantity: line.quantity,
      unitPriceMinor: line.priceMinor,
      variantId: line.variantId,
      variantVersion: line.version,
    })),
    cartId: input.cartId,
    cartExpiresAt: cart.expiresAt,
    evidence: input.quoteEvidence,
    expected: input.expected,
    now,
    pricing: {
      discountCode: cart.discountCode,
      discountMinor: state.quote.discountMinor,
      totalMinor: state.quote.totalMinor,
    },
    requireCatalog: true,
    secret: input.env.IDENTIFIER_HMAC_SECRET,
    shopId: input.shop.id,
  });
  const hashes = await checkoutHashes({
    ...input,
    discountCode: cart.discountCode,
    discountMinor: state.quote.discountMinor,
    shopId: input.shop.id,
    totalMinor: state.quote.totalMinor,
  });
  return {
    evidence: await createCheckoutRecoveryEvidence({
      cartId: input.cartId,
      checkoutSubjectHash: hashes.checkoutSubjectHash,
      expiresAt: cart.expiresAt,
      issuedAt: now.toISOString(),
      requestHash: hashes.requestHash,
      secret: input.env.IDENTIFIER_HMAC_SECRET,
      shopId: input.shop.id,
    }),
    expiresAt: cart.expiresAt,
  };
}

export async function recoverWebsiteCheckout(input: {
  cartId: string;
  cartToken: string;
  customerEmail: string | null;
  env: AppBindings;
  expected: WebsiteCheckoutExpectedItem[];
  idempotencyKey: string;
  recoveryEvidence: string;
  shop: StorefrontShop;
}): Promise<RecoveredWebsiteOrder> {
  const cart = await readCartProof({ cartId: input.cartId, env: input.env, shopId: input.shop.id });
  await verifyCartToken({ cartToken: input.cartToken, env: input.env, shopId: input.shop.id, subjectHash: cart.subjectHash });
  const checkoutSubjectHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, `checkout:${input.shop.id}`, input.idempotencyKey);
  const order = await input.env.PLATFORM_DB.prepare(`
    SELECT orders.public_id AS orderId, orders.order_number AS orderNumber,
      orders.checkout_cart_id AS checkoutCartId,
      orders.checkout_request_hash AS requestHash,
      orders.expires_at AS expiresAt,
      orders.fulfillment_status AS fulfillmentStatus,
      orders.payment_status AS paymentStatus, orders.status,
      orders.total_minor AS totalMinor, orders.discount_minor AS discountMinor, orders.currency,
      orders.order_token_hash AS orderTokenHash
    FROM orders
    LEFT JOIN order_channel_attributions AS attribution
      ON attribution.shop_id = orders.shop_id AND attribution.order_id = orders.id
    WHERE orders.shop_id = ? AND orders.checkout_subject_hash = ?
      AND orders.source_channel = ?
      AND (
        attribution.order_id IS NULL
        OR (
          attribution.channel_code = ?
          AND attribution.adapter_version = ?
          AND attribution.connection_id IS NULL
        )
      )
    LIMIT 1
  `).bind(
    input.shop.id,
    checkoutSubjectHash,
    WEBSITE_ORDER_ATTRIBUTION.legacySourceChannel,
    WEBSITE_ORDER_ATTRIBUTION.channelCode,
    WEBSITE_ORDER_ATTRIBUTION.adapterVersion,
  ).first<{
    checkoutCartId: string | null;
    currency: string;
    expiresAt: string;
    fulfillmentStatus: string;
    orderId: string;
    orderNumber: string;
    paymentStatus: string;
    orderTokenHash: string;
    requestHash: string | null;
    discountMinor: number;
    totalMinor: number;
    status: string;
  }>();
  if (order === null) throw new AppError("checkout_not_found", 404);
  const requestHash = await websiteCheckoutFingerprint({
    cartId: input.cartId,
    customerEmail: input.customerEmail,
    discountCode: cart.discountCode,
    discountMinor: order.discountMinor,
    expected: input.expected,
    totalMinor: order.totalMinor,
  });
  await verifyCheckoutRecoveryEvidence({
    cartExpiresAt: cart.expiresAt,
    cartId: input.cartId,
    checkoutSubjectHash,
    evidence: input.recoveryEvidence,
    requestHash,
    secret: input.env.IDENTIFIER_HMAC_SECRET,
    shopId: input.shop.id,
  });
  if (order.checkoutCartId !== input.cartId || order.requestHash !== requestHash) {
    throw new AppError("idempotency_conflict", 409);
  }
  const orderToken = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, `order-access-token:${input.shop.id}`, input.idempotencyKey);
  const orderTokenHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "order-access", orderToken);
  if (!constantTimeEqual(order.orderTokenHash, orderTokenHash)) throw new AppError("checkout_recovery_invalid", 409);
  return {
    currency: order.currency,
    expiresAt: order.expiresAt,
    fulfillmentStatus: order.fulfillmentStatus,
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    orderToken,
    paymentStatus: order.paymentStatus,
    status: order.status,
    totalMinor: order.totalMinor,
  };
}
