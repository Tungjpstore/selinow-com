import { AppError } from "../core/errors";
import { assertSubscriptionAllows } from "../billing/entitlements";
import { constantTimeEqual, hmacToken, sha256Json } from "../core/crypto";
import { createId, createOpaqueToken } from "../core/ids";
import { resolveOrderChannelAttribution } from "../channels/attribution";
import { WEBSITE_CHANNEL_CODE } from "../channels/builtins";
import { resolveEncryptionKey } from "../crypto/keyring";
import type { AppBindings } from "../platform/bindings";
import type { StorefrontShop } from "../storefront/store";
import { assertCheckoutAllowed } from "../tenants/policy";
import type { CartItemInput } from "./policy";
import { maskEmail } from "./policy";
import { verifyQuoteEvidence, type QuoteEvidenceCatalogItem } from "./quote-evidence";
import { executeCanonicalCheckoutTransaction } from "./checkout-transaction";
import { calculateCartDiscountMinor } from "./pricing";
import { createCanonicalCart } from "./cart-creation";
import { projectCanonicalCartQuote } from "./cart-quote";
import { isBuyerOrderRecoveryBinding, resolveCurrentBuyerOrderRecoveryToken } from "./buyer-order-recovery";

type PublicShop = StorefrontShop;
type CheckoutVariant = { availableStock: number; currency: string; fulfillmentType: "license_key" | "manual"; maxPerOrder: number; minPerOrder: number; priceMinor: number; productId: string; productStatus: string; productTitle: string; productVersion: number; sku: string; status: string; title: string; variantId: string; version: number };
type CartRow = { cartId: string; discountCode: string | null; expiresAt: string; locale: string; state: string; subjectHash: string };

const WEBSITE_ORDER_ATTRIBUTION = resolveOrderChannelAttribution(WEBSITE_CHANNEL_CODE);

async function loadVariants(env: AppBindings, shopId: string, ids: string[]): Promise<Map<string, CheckoutVariant>> {
  if (ids.length === 0) return new Map();
  const result = await env.PLATFORM_DB.prepare(`SELECT product_variants.id AS variantId, product_variants.product_id AS productId, product_variants.sku, product_variants.title, product_variants.price_minor AS priceMinor, product_variants.currency, product_variants.min_per_order AS minPerOrder, product_variants.max_per_order AS maxPerOrder, product_variants.status, product_variants.version, products.title AS productTitle, products.status AS productStatus, products.version AS productVersion, products.fulfillment_type AS fulfillmentType, COUNT(CASE WHEN inventory_keys.status = 'available' THEN 1 END) AS availableStock FROM product_variants INNER JOIN products ON products.id = product_variants.product_id AND products.shop_id = product_variants.shop_id LEFT JOIN inventory_keys ON inventory_keys.shop_id = product_variants.shop_id AND inventory_keys.variant_id = product_variants.id WHERE product_variants.shop_id = ? AND product_variants.id IN (${ids.map(() => "?").join(",")}) GROUP BY product_variants.id`).bind(shopId, ...ids).all<CheckoutVariant>();
  return new Map(result.results.map((row) => [row.variantId, row]));
}

function assertPurchasable(items: CartItemInput[], variants: Map<string, CheckoutVariant>, currency: string): CheckoutVariant[] {
  return items.map((item) => {
    const variant = variants.get(item.variantId);
    if (variant === undefined || variant.status !== "active" || variant.productStatus !== "active") throw new AppError("catalog_changed", 409);
    if (variant.currency !== currency) throw new AppError("catalog_changed", 409);
    if (item.quantity < variant.minPerOrder || item.quantity > variant.maxPerOrder) throw new AppError("quantity_unavailable", 409);
    if (variant.fulfillmentType === "license_key" && variant.availableStock < item.quantity) throw new AppError("inventory_unavailable", 409);
    return variant;
  });
}

export async function createCart(input: { env: AppBindings; items: CartItemInput[]; locale: string; shop: PublicShop }): Promise<{ cartId: string; cartToken: string; expiresAt: string }> {
  const cartToken = createOpaqueToken();
  const subjectHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, `cart:${input.shop.id}`, cartToken);
  const cart = await createCanonicalCart({ channel: "web", env: input.env, items: input.items, locale: input.locale, shop: input.shop, subjectHash });
  return { cartId: cart.cartId, cartToken, expiresAt: cart.expiresAt };
}

async function getCart(input: { cartId: string; cartToken: string; env: AppBindings; shopId: string }): Promise<{ items: CartItemInput[]; row: CartRow }> {
  const row = await input.env.PLATFORM_DB.prepare("SELECT id AS cartId, discount_code_normalized AS discountCode, subject_hash AS subjectHash, locale, state, expires_at AS expiresAt FROM carts WHERE id = ? AND shop_id = ? AND channel = 'web' LIMIT 1").bind(input.cartId, input.shopId).first<CartRow>();
  if (row === null || row.state !== "active" || row.expiresAt <= new Date().toISOString()) throw new AppError("cart_not_found", 404);
  const tokenHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, `cart:${input.shopId}`, input.cartToken);
  if (!constantTimeEqual(row.subjectHash, tokenHash)) throw new AppError("cart_not_found", 404);
  const result = await input.env.PLATFORM_DB.prepare("SELECT variant_id AS variantId, quantity FROM cart_items WHERE cart_id = ? AND shop_id = ? ORDER BY variant_id").bind(input.cartId, input.shopId).all<CartItemInput>();
  return { items: result.results, row };
}

/**
 * Load the live Website cart/catalog projection used by quote and recovery.
 * Recovery must not sign an intent from cart metadata alone because the
 * canonical checkout hash includes the authoritative discount and total.
 */
export async function loadWebsiteCheckoutState(input: {
  cartId: string;
  cartToken: string;
  env: AppBindings;
  shop: PublicShop;
}): Promise<{
  cart: CartRow;
  lines: Array<CheckoutVariant & { quantity: number }>;
  quote: Awaited<ReturnType<typeof projectCanonicalCartQuote>>;
}> {
  const cart = await getCart({ ...input, shopId: input.shop.id });
  const variants = await loadVariants(input.env, input.shop.id, cart.items.map((item) => item.variantId));
  const lines = cart.items.map((item) => {
    const variant = variants.get(item.variantId);
    if (variant === undefined) throw new AppError("catalog_changed", 409);
    return { ...variant, quantity: item.quantity };
  });
  const quote = await projectCanonicalCartQuote({
    cartExpiresAt: cart.row.expiresAt,
    cartId: input.cartId,
    discountCode: cart.row.discountCode,
    env: input.env,
    lines,
    shop: input.shop,
  });
  return { cart: cart.row, lines, quote };
}

async function verifyReplayProof(input: {
  cartId: string;
  cartToken: string;
  env: AppBindings;
  expected: ExpectedItem[];
  quoteEvidence: string | undefined;
  shopId: string;
}): Promise<void> {
  // Converted carts cannot pass through getCart, but their original token is
  // still required to authorize an idempotent order replay.
  const row = await input.env.PLATFORM_DB.prepare("SELECT subject_hash AS subjectHash, expires_at AS expiresAt FROM carts WHERE id = ? AND shop_id = ? AND channel = 'web' LIMIT 1").bind(input.cartId, input.shopId).first<{ expiresAt: string; subjectHash: string }>();
  if (row === null) throw new AppError("cart_not_found", 404);
  const tokenHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, `cart:${input.shopId}`, input.cartToken);
  if (!constantTimeEqual(row.subjectHash, tokenHash)) throw new AppError("cart_not_found", 404);
  if (input.quoteEvidence === undefined) throw new AppError("quote_invalid", 409);
  await verifyQuoteEvidence({
    cartId: input.cartId,
    cartExpiresAt: row.expiresAt,
    evidence: input.quoteEvidence,
    expected: input.expected,
    secret: input.env.IDENTIFIER_HMAC_SECRET,
    shopId: input.shopId,
  });
}

export async function quoteCart(input: { cartId: string; cartToken: string; env: AppBindings; shop: PublicShop }): Promise<{ currency: string; discountMinor: number; expiresAt: string; items: Array<{ lineTotalMinor: number; productTitle: string; quantity: number; unitPriceMinor: number; variantId: string; variantTitle: string; variantVersion: number }>; quoteEvidence: string; subtotalMinor: number; totalMinor: number }> {
  const { quote } = await loadWebsiteCheckoutState(input);
  if (quote.quoteEvidence === undefined) throw new AppError("commerce_contract_invalid", 500, ["quote_evidence_invalid"]);
  return { ...quote, items: [...quote.items], quoteEvidence: quote.quoteEvidence };
}

type ExpectedItem = { quantity: number; unitPriceMinor: number; variantId: string; variantVersion: number };

function quoteCatalog(expected: readonly ExpectedItem[], variants: readonly CheckoutVariant[]): QuoteEvidenceCatalogItem[] {
  return expected.map((item) => {
    const variant = variants.find((candidate) => candidate.variantId === item.variantId);
    if (variant === undefined) throw new AppError("checkout_changed", 409);
    return { ...item, productVersion: variant.productVersion };
  });
}

export async function websiteCheckoutFingerprint(input: {
  cartId: string;
  customerEmail: string | null;
  discountCode: string | null;
  discountMinor: number;
  expected: readonly ExpectedItem[];
  totalMinor: number;
}): Promise<string> {
  return sha256Json({
    cartId: input.cartId,
    customerEmail: input.customerEmail,
    discountCode: input.discountCode,
    discountMinor: input.discountMinor,
    // Quote evidence is order-insensitive; keep the durable request hash
    // aligned so semantically identical line order cannot conflict on retry.
    expected: [...input.expected].sort((left, right) => left.variantId.localeCompare(right.variantId)),
    totalMinor: input.totalMinor,
  });
}

export async function checkoutCart(input: { cartId: string; cartToken: string; customerEmail: string | null; env: AppBindings; expected: ExpectedItem[]; idempotencyKey: string; quoteEvidence?: string; shop: PublicShop }): Promise<{ currency: string; expiresAt: string; fulfillmentStatus: string; orderId: string; orderNumber: string; orderToken: string; paymentStatus: string; status: string; totalMinor: number }> {
  assertSubscriptionAllows({ graceEndsAt: input.shop.graceEndsAt, subscriptionState: input.shop.subscriptionState, trialEndsAt: input.shop.trialEndsAt });
  assertCheckoutAllowed({ shopStatus: input.shop.status, subscriptionState: input.shop.subscriptionState });
  if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(input.idempotencyKey)) throw new AppError("validation_failed", 400, ["idempotency_key_invalid"]);
  const checkoutHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, `checkout:${input.shop.id}`, input.idempotencyKey);
  // Keep signed proofs out of the business hash, but bind canonical pricing so
  // a same-key retry cannot recover an order created from another discount.
  const hashCart = await input.env.PLATFORM_DB.prepare(
    "SELECT discount_code_normalized AS discountCode FROM carts WHERE id = ? AND shop_id = ? AND channel = 'web' LIMIT 1",
  ).bind(input.cartId, input.shop.id).first<{ discountCode: string | null }>();
  const hashSubtotalMinor = input.expected.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0);
  const hashDiscountMinor = await calculateCartDiscountMinor({ code: hashCart?.discountCode ?? null, env: input.env, shop: input.shop, subtotalMinor: hashSubtotalMinor });
  const requestHash = await websiteCheckoutFingerprint({
    cartId: input.cartId,
    customerEmail: input.customerEmail,
    discountCode: hashCart?.discountCode ?? null,
    discountMinor: hashDiscountMinor,
    expected: input.expected,
    totalMinor: hashSubtotalMinor - hashDiscountMinor,
  });
  const orderToken = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, `order-access-token:${input.shop.id}`, input.idempotencyKey);
  const recoverReplay = async () => {
    const replay = await input.env.PLATFORM_DB.prepare(`
      SELECT orders.id AS internalOrderId,
        orders.public_id AS orderId, orders.order_number AS orderNumber,
        orders.checkout_request_hash AS requestHash,
        orders.expires_at AS expiresAt,
        orders.fulfillment_status AS fulfillmentStatus,
        orders.payment_status AS paymentStatus, orders.status,
        orders.total_minor AS totalMinor, orders.currency,
        orders.order_token_hash AS orderTokenHash,
        orders.source_channel AS sourceChannel,
        order_channel_attributions.channel_code AS channelCode,
        order_channel_attributions.adapter_version AS adapterVersion,
        order_channel_attributions.connection_id AS connectionId
      FROM orders
      LEFT JOIN order_channel_attributions
        ON order_channel_attributions.shop_id = orders.shop_id
        AND order_channel_attributions.order_id = orders.id
      WHERE orders.shop_id = ? AND orders.checkout_subject_hash = ?
      LIMIT 1
    `).bind(input.shop.id, checkoutHash).first<{
      channelCode: string | null;
      adapterVersion: number | null;
      connectionId: string | null;
      currency: string;
      expiresAt: string;
      fulfillmentStatus: string;
      internalOrderId: string;
      orderId: string;
      orderNumber: string;
      orderTokenHash: string;
      paymentStatus: string;
      requestHash: string | null;
      sourceChannel: string;
      status: string;
      totalMinor: number;
    }>();
    if (replay === null) return null;
    await verifyReplayProof({ cartId: input.cartId, cartToken: input.cartToken, env: input.env, expected: input.expected, quoteEvidence: input.quoteEvidence, shopId: input.shop.id });
    if (
      replay.sourceChannel !== WEBSITE_ORDER_ATTRIBUTION.legacySourceChannel
      || (replay.channelCode !== null && (
        replay.channelCode !== WEBSITE_ORDER_ATTRIBUTION.channelCode
        || replay.adapterVersion !== WEBSITE_ORDER_ATTRIBUTION.adapterVersion
        || replay.connectionId !== null
      ))
    ) throw new AppError("idempotency_conflict", 409);
    if (replay.requestHash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const replayTokenHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "order-access", orderToken);
    let responseToken = orderToken;
    if (!constantTimeEqual(replay.orderTokenHash, replayTokenHash)) {
      const bindingMatches = await isBuyerOrderRecoveryBinding({
        candidateBindingHash: replayTokenHash,
        currentOrderTokenHash: replay.orderTokenHash,
        env: input.env,
        orderId: replay.internalOrderId,
        shopId: input.shop.id,
      });
      if (!bindingMatches) throw new AppError("idempotency_conflict", 409);
      const recoveredToken = await resolveCurrentBuyerOrderRecoveryToken({
        currentOrderTokenHash: replay.orderTokenHash,
        env: input.env,
        orderId: replay.internalOrderId,
        shopId: input.shop.id,
      });
      if (recoveredToken === null) throw new AppError("idempotency_conflict", 409);
      responseToken = recoveredToken;
    }
    return { currency: replay.currency, expiresAt: replay.expiresAt, fulfillmentStatus: replay.fulfillmentStatus, orderId: replay.orderId, orderNumber: replay.orderNumber, orderToken: responseToken, paymentStatus: replay.paymentStatus, status: replay.status, totalMinor: replay.totalMinor };
  };
  const existing = await recoverReplay();
  if (existing !== null) return existing;
  let cart: Awaited<ReturnType<typeof getCart>>;
  try {
    cart = await getCart({ ...input, shopId: input.shop.id });
  } catch (error) {
    // A concurrent identical retry may observe the cart after the winner has
    // converted it. Recover the durable order before surfacing cart_not_found.
    const replay = await recoverReplay();
    if (replay !== null) return replay;
    throw error;
  }
  if (input.quoteEvidence !== undefined) {
    await verifyQuoteEvidence({
      cartId: input.cartId,
      cartExpiresAt: cart.row.expiresAt,
      evidence: input.quoteEvidence,
      expected: input.expected,
      secret: input.env.IDENTIFIER_HMAC_SECRET,
      shopId: input.shop.id,
    });
  }
  let ordered: CheckoutVariant[];
  try {
    const variants = await loadVariants(input.env, input.shop.id, cart.items.map((item) => item.variantId));
    ordered = assertPurchasable(cart.items, variants, input.shop.currency);
    if (input.expected.length !== cart.items.length) throw new AppError("checkout_changed", 409);
    for (const [index, variant] of ordered.entries()) {
      const expected = input.expected.find((item) => item.variantId === variant.variantId);
      const cartItem = cart.items[index];
      if (cartItem === undefined || expected === undefined || expected.quantity !== cartItem.quantity || expected.unitPriceMinor !== variant.priceMinor || expected.variantVersion !== variant.version) throw new AppError("checkout_changed", 409);
    }
  } catch (error) {
    const replay = await recoverReplay();
    if (replay !== null) return replay;
    throw error;
  }
  // PayOS is the only payment capability currently wired to checkout, and it
  // accepts VND only. Fail before customer/order/reservation writes for paid
  // carts so unsupported currency cannot leave durable checkout state behind.
  const subtotalMinor = cart.items.reduce((sum, item, index) => {
    const variant = ordered[index];
    if (variant === undefined) throw new AppError("catalog_changed", 409);
    return sum + variant.priceMinor * item.quantity;
  }, 0);
  const discountMinor = await calculateCartDiscountMinor({ code: cart.row.discountCode, env: input.env, shop: input.shop, subtotalMinor });
  const totalMinor = subtotalMinor - discountMinor;
  const authoritativeRequestHash = await websiteCheckoutFingerprint({
    cartId: input.cartId,
    customerEmail: input.customerEmail,
    discountCode: cart.row.discountCode,
    discountMinor,
    expected: input.expected,
    totalMinor,
  });
  if (authoritativeRequestHash !== requestHash) throw new AppError("checkout_changed", 409);
  if (input.quoteEvidence !== undefined) {
    await verifyQuoteEvidence({
      cartId: input.cartId,
      cartExpiresAt: cart.row.expiresAt,
      evidence: input.quoteEvidence,
      catalog: quoteCatalog(input.expected, ordered),
      expected: input.expected,
      pricing: { discountCode: cart.row.discountCode, discountMinor, totalMinor },
      requireCatalog: true,
      secret: input.env.IDENTIFIER_HMAC_SECRET,
      shopId: input.shop.id,
    });
  }
  if (totalMinor > 0 && input.shop.currency !== "VND") throw new AppError("payment_currency_unsupported", 409);
  const orderId = createId("ord");
  const orderPublicId = createId("order");
  const reservationToken = createOpaqueToken();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + input.shop.orderExpiryMinutes * 60_000).toISOString();
  const lines = cart.items.map((item, index) => {
    const variant = ordered[index];
    if (variant === undefined) throw new AppError("catalog_changed", 409);
    return {
      fulfillmentType: variant.fulfillmentType,
      priceMinor: variant.priceMinor,
      productId: variant.productId,
      productTitle: variant.productTitle,
      productVersion: variant.productVersion,
      quantity: item.quantity,
      sku: variant.sku,
      title: variant.title,
      variantId: variant.variantId,
      variantVersion: variant.version,
    };
  });
  try {
    const orderTokenHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "order-access", orderToken);
    const committed = await executeCanonicalCheckoutTransaction({
      cartId: input.cartId,
      cartSnapshot: { discountCode: cart.row.discountCode },
      channel: { code: WEBSITE_CHANNEL_CODE, connectionId: null },
      checkoutRequestHash: requestHash,
      checkoutSubjectHash: checkoutHash,
      currency: input.shop.currency,
      customer: input.customerEmail === null
        ? { kind: "anonymous", maskedEmail: null }
        : { emailNormalized: input.customerEmail, id: createId("cus"), kind: "upsert_email", locale: cart.row.locale, maskedEmail: maskEmail(input.customerEmail) ?? "" },
      discountMinor,
      env: input.env,
      eventIdempotencyKey: checkoutHash,
      expiresAt,
      fulfillmentIdempotencyPrefix: "website-free",
      lines,
      locale: cart.row.locale,
      nowIso,
      orderId,
      orderPublicId,
      orderTokenHash,
      reservationToken,
      shopId: input.shop.id,
      subtotalMinor,
      totalMinor,
    });
    return { ...committed, orderToken };
  } catch (error) {
    const replay = await recoverReplay();
    if (replay !== null) return replay;
    if (error instanceof AppError) throw error;
    const cartState = await input.env.PLATFORM_DB.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ? LIMIT 1").bind(input.cartId, input.shop.id).first<{ state: string }>();
    if (cartState?.state === "active") {
      try {
        const currentCart = await getCart({ ...input, shopId: input.shop.id });
        if (currentCart.row.discountCode !== cart.row.discountCode || currentCart.items.length !== input.expected.length) throw new AppError("checkout_changed", 409);
        const currentVariants = await loadVariants(input.env, input.shop.id, currentCart.items.map((item) => item.variantId));
        const currentOrdered = assertPurchasable(currentCart.items, currentVariants, input.shop.currency);
        for (const [index, variant] of currentOrdered.entries()) {
          const expected = input.expected.find((item) => item.variantId === variant.variantId);
          const cartItem = currentCart.items[index];
          const original = ordered[index];
          if (cartItem === undefined || expected === undefined || original === undefined || expected.quantity !== cartItem.quantity || expected.unitPriceMinor !== variant.priceMinor || expected.variantVersion !== variant.version || variant.productVersion !== original.productVersion) throw new AppError("checkout_changed", 409);
        }
      } catch (availabilityError) {
        if (availabilityError instanceof AppError) throw availabilityError;
      }
    }
    throw new AppError("checkout_failed", 409);
  }
}

type AuthorizedOrder = Record<string, unknown> & { fulfillmentStatus: string; id: string; orderTokenHash: string; paymentStatus: string; sourceChannel: string; status: string };

async function authorizeOrder(input: { env: AppBindings; orderPublicId: string; orderToken: string; shop: PublicShop }): Promise<AuthorizedOrder> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT orders.id, orders.public_id AS orderId,
      orders.order_number AS orderNumber, orders.source_channel AS sourceChannel,
      orders.status, orders.payment_status AS paymentStatus,
      orders.fulfillment_status AS fulfillmentStatus,
      orders.total_minor AS totalMinor, orders.currency,
      orders.customer_email_masked AS customerEmail,
      orders.order_token_hash AS orderTokenHash,
      orders.expires_at AS expiresAt, orders.created_at AS createdAt
    FROM orders
    LEFT JOIN order_channel_attributions AS attribution
      ON attribution.shop_id = orders.shop_id AND attribution.order_id = orders.id
    WHERE orders.public_id = ? AND orders.shop_id = ? AND orders.source_channel = ?
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
    input.orderPublicId,
    input.shop.id,
    WEBSITE_ORDER_ATTRIBUTION.legacySourceChannel,
    WEBSITE_ORDER_ATTRIBUTION.channelCode,
    WEBSITE_ORDER_ATTRIBUTION.adapterVersion,
  ).first<AuthorizedOrder>();
  if (row === null) throw new AppError("order_not_found", 404);
  const hash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "order-access", input.orderToken);
  if (!constantTimeEqual(row.orderTokenHash, hash)) throw new AppError("order_not_found", 404);
  return row;
}

export async function getOrder(input: { env: AppBindings; orderPublicId: string; orderToken: string; shop: PublicShop }): Promise<unknown> {
  const row = await authorizeOrder(input);
  const items = await input.env.PLATFORM_DB.prepare("SELECT id, product_title AS productTitle, variant_title AS variantTitle, sku, unit_price_minor AS unitPriceMinor, quantity, line_total_minor AS lineTotalMinor, fulfillment_type AS fulfillmentType FROM order_items WHERE order_id = ? AND shop_id = ? ORDER BY id").bind(row.id, input.shop.id).all<Record<string, unknown> & { id: string }>();
  const safeOrder: Record<string, unknown> = { ...row };
  delete safeOrder.id;
  delete safeOrder.orderTokenHash;
  return { ...safeOrder, items: items.results };
}

export async function getOrderKeys(input: { env: AppBindings; orderPublicId: string; orderToken: string; shop: PublicShop }): Promise<unknown> {
  const { decryptInventoryKey } = await import("../crypto/inventory");
  const row = await authorizeOrder(input);
  if (row.sourceChannel !== WEBSITE_ORDER_ATTRIBUTION.legacySourceChannel || row.status !== "completed" || row.paymentStatus !== "paid" || row.fulfillmentStatus !== "fulfilled") throw new AppError("order_not_ready", 409);
  const keys = await input.env.PLATFORM_DB.prepare(`
    SELECT order_items.product_title AS productTitle, order_items.variant_title AS variantTitle,
      inventory_keys.ciphertext_b64 AS ciphertextB64, inventory_keys.iv_b64 AS ivB64,
      inventory_keys.key_version AS keyVersion, inventory_keys.variant_id AS variantId
    FROM order_items
    INNER JOIN inventory_keys
      ON inventory_keys.shop_id = order_items.shop_id
      AND inventory_keys.sold_order_item_id = order_items.id
      AND inventory_keys.status = 'sold'
    WHERE order_items.order_id = ? AND order_items.shop_id = ?
    ORDER BY order_items.id, inventory_keys.id
  `).bind(row.id, input.shop.id).all<{ ciphertextB64: string; ivB64: string; keyVersion: string; productTitle: string; variantId: string; variantTitle: string }>();
  return {
    keys: await Promise.all(keys.results.map(async (key) => {
      const encryptionKey = resolveEncryptionKey(input.env, "inventory", key.keyVersion);
      return {
        productTitle: key.productTitle,
        value: await decryptInventoryKey({ ...key, kek: encryptionKey.kek, keyVersion: encryptionKey.version, shopId: input.shop.id }),
        variantTitle: key.variantTitle,
      };
    })),
    orderId: input.orderPublicId,
  };
}

export async function expireUnpaidOrders(env: AppBindings, nowIso = new Date().toISOString()): Promise<number> {
  // Reconcile legacy reservations that predate atomic checkout batching. A
  // valid reservation always points at a tenant-bound immutable order item.
  await env.PLATFORM_DB.prepare(`
    UPDATE inventory_keys
    SET status = 'available', reservation_token = NULL,
      reserved_order_item_id = NULL, reserved_until = NULL
    WHERE id IN (
      SELECT candidate.id
      FROM inventory_keys AS candidate
      WHERE candidate.status = 'reserved'
        AND candidate.reserved_until IS NOT NULL
        AND candidate.reserved_until <= ?
        AND NOT EXISTS (
          SELECT 1 FROM order_items
          WHERE order_items.id = candidate.reserved_order_item_id
            AND order_items.shop_id = candidate.shop_id
        )
      ORDER BY candidate.reserved_until, candidate.id
      LIMIT 100
    )
      AND status = 'reserved' AND reserved_until <= ?
  `).bind(nowIso, nowIso).run();
  const due = await env.PLATFORM_DB.prepare("SELECT id, shop_id AS shopId FROM orders WHERE status = 'pending_payment' AND payment_status = 'unpaid' AND expires_at <= ? ORDER BY expires_at, id LIMIT 100").bind(nowIso).all<{ id: string; shopId: string }>();
  let expired = 0;
  for (const order of due.results) {
    const changed = await env.PLATFORM_DB.prepare("UPDATE orders SET status = 'expired', payment_status = 'expired', fulfillment_status = 'unfulfilled', updated_at = ? WHERE id = ? AND shop_id = ? AND status = 'pending_payment' AND payment_status = 'unpaid' AND expires_at <= ?").bind(nowIso, order.id, order.shopId, nowIso).run();
    if (changed.meta.changes !== 1) continue;
    await env.PLATFORM_DB.prepare(`UPDATE inventory_keys SET status = 'available', reservation_token = NULL, reserved_order_item_id = NULL, reserved_until = NULL WHERE shop_id = ? AND status = 'reserved' AND reserved_order_item_id IN (SELECT id FROM order_items WHERE order_id = ? AND shop_id = ?) AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND shop_id = ? AND status = 'expired' AND payment_status = 'expired')`).bind(order.shopId, order.id, order.shopId, order.id, order.shopId).run();
    expired += 1;
  }
  return expired;
}
