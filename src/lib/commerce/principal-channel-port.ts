import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { assertSubscriptionAllows } from "../billing/entitlements";
import { createId, createOpaqueToken } from "../core/ids";
import { resolveExternalOrderChannelAttribution, type OrderChannelAttribution } from "../channels/attribution";
import type { ChannelAdapterRegistry } from "../channels/registry";
import { D1ChannelConnectionRepository } from "../channels/store";
import { getProviderRuntimeContract } from "../channels/provider-contracts";
import { assertCheckoutAllowed } from "../tenants/policy";
import type { AppBindings } from "../platform/bindings";
import { CommerceApplicationService } from "./application";
import { applyCanonicalCartMutation, loadCanonicalCartVariant, type CanonicalCartVariant } from "./cart-mutation";
import { createCanonicalCart, findCanonicalActiveCart } from "./cart-creation";
import { executeCanonicalCheckoutTransaction } from "./checkout-transaction";
import { projectCanonicalCartQuote, type CanonicalCartQuoteLine } from "./cart-quote";
import { calculateCartDiscountMinor } from "./pricing";
import { verifyQuoteEvidence } from "./quote-evidence";
import type {
  CommerceApplicationPort,
  CommerceCartMutationCommand,
  CommerceCartMutationView,
  CommerceCheckoutCommand,
  CommerceCheckoutView,
  CommerceContext,
  CommerceCreateCartCommand,
  CommerceCreateCartView,
  CommerceListOrdersCommand,
  CommerceListOrdersView,
  CommerceOrderReference,
  CommerceOrderView,
  CommerceQuoteCommand,
  CommerceQuoteView,
} from "./contracts";
import type { ChannelCapability } from "../channels/types";

/**
 * Principal-facing channel port used by generic adapters during staged
 * cutover. The adapter supplies identity and transport context; this port
 * owns all canonical D1 commerce state and transactions.
 */
export type PrincipalChannelShop = {
  currency: string;
  currentPeriodEnd?: string | null;
  defaultLocale: string;
  graceEndsAt?: string | null;
  id: string;
  orderExpiryMinutes: number;
  status: string;
  subscriptionState: string;
  trialEndsAt?: string | null;
};

export type PrincipalChannelIdentity = {
  customerId: string;
  subjectHash: string;
};

export type PrincipalChannelPortInput = {
  adapterVersion: number;
  channelCode: string;
  connectionId: string;
  env: AppBindings;
  expectedIdempotencyKey?: string;
  identity: PrincipalChannelIdentity;
  legacySourceChannel?: "web";
  planEntitlements: ReadonlySet<ChannelCapability>;
  policyBlockedCapabilities?: ReadonlySet<ChannelCapability>;
  registry: ChannelAdapterRegistry;
  shop: PrincipalChannelShop;
};

type PrincipalCartLine = CanonicalCartVariant & { quantity: number };
type ReplayRow = {
  adapterVersion: number;
  channelCode: string | null;
  connectionId: string | null;
  customerId: string | null;
  currency: string;
  expiresAt: string;
  fulfillmentStatus: string;
  orderId: string;
  orderNumber: string;
  paymentStatus: string;
  requestHash: string | null;
  sourceChannel: string;
  status: string;
  totalMinor: number;
};

function assertCode(value: string): void {
  if (!/^[a-z][a-z0-9._:-]{0,63}$/u.test(value)) throw new AppError("commerce_context_mismatch", 403, ["channel_code_invalid"]);
}

function legacyChannel(input: PrincipalChannelPortInput): "web" {
  return input.legacySourceChannel ?? "web";
}

function attribution(input: PrincipalChannelPortInput): OrderChannelAttribution {
  return resolveExternalOrderChannelAttribution({
    adapterVersion: input.adapterVersion,
    channelCode: input.channelCode,
    legacySourceChannel: legacyChannel(input),
  });
}

async function scopedSubjectHash(input: PrincipalChannelPortInput): Promise<string> {
  return hmacToken(
    input.env.IDENTIFIER_HMAC_SECRET,
    `principal-channel-cart:${input.shop.id}:${input.channelCode}:${input.connectionId}`,
    `${input.identity.customerId}:${input.identity.subjectHash}`,
  );
}

async function checkoutKeyHash(input: PrincipalChannelPortInput, idempotencyKey: string): Promise<string> {
  return hmacToken(
    input.env.IDENTIFIER_HMAC_SECRET,
    `principal-channel-checkout:${input.shop.id}:${input.channelCode}:${input.connectionId}`,
    `${input.identity.customerId}:${input.identity.subjectHash}:${idempotencyKey}`,
  );
}

async function mutationKeyHash(input: PrincipalChannelPortInput, idempotencyKey: string): Promise<string> {
  return hmacToken(
    input.env.IDENTIFIER_HMAC_SECRET,
    `principal-channel-mutation:${input.shop.id}:${input.channelCode}:${input.connectionId}`,
    idempotencyKey,
  );
}

async function assertAdmission(input: PrincipalChannelPortInput, context: CommerceContext, capability: ChannelCapability): Promise<string> {
  assertCode(input.channelCode);
  if (
    context.shopId !== input.shop.id
    || context.channel.code !== input.channelCode
    || context.channel.connectionId !== input.connectionId
    || context.actor.kind !== "customer"
    || context.actor.customerId !== input.identity.customerId
  ) throw new AppError("commerce_context_mismatch", 403, ["principal_channel_required"]);
  const manifest = input.registry.require(input.channelCode);
  if (manifest.version !== input.adapterVersion) throw new AppError("channel_adapter_version_conflict", 409);
  // Expansion manifests are catalog contracts until a provider-specific
  // adapter, identity binding and webhook evidence are admitted. Do not let a
  // manually-created active connection bypass that gate into commerce state.
  if (["telegram.mini_app", "zalo.mini_app", "zalo.oa", "whatsapp.cloud", "discord.bot"].includes(input.channelCode)) {
    const runtime = getProviderRuntimeContract(input.channelCode);
    if (runtime.stage !== "implemented") throw new AppError("channel_provider_pending", 409, [input.channelCode]);
  }
  const projection = await new D1ChannelConnectionRepository(input.env.PLATFORM_DB, input.registry).projectCapabilities({
    connectionId: input.connectionId,
    planEntitlements: input.planEntitlements,
    ...(input.policyBlockedCapabilities === undefined ? {} : { policyBlockedCapabilities: input.policyBlockedCapabilities }),
    shopId: input.shop.id,
  });
  if (
    projection.connection.channelCode !== input.channelCode
    || projection.connection.providerCode !== input.channelCode
    || projection.connection.status !== "active"
  ) throw new AppError("channel_connection_unavailable", 409, ["principal_channel_admission_required"]);
  if (!projection.capabilities.has(capability)) {
    throw new AppError("channel_capability_unavailable", 403, [capability]);
  }
  return scopedSubjectHash(input);
}

async function readCartLines(input: PrincipalChannelPortInput, cartId: string): Promise<{ cartId: string; discountCode: string | null; lines: PrincipalCartLine[] }> {
  const cart = await input.env.PLATFORM_DB.prepare("SELECT discount_code_normalized AS discountCode FROM carts WHERE id = ? AND shop_id = ? AND channel = ? LIMIT 1").bind(cartId, input.shop.id, legacyChannel(input)).first<{ discountCode: string | null }>();
  if (cart === null) throw new AppError("cart_not_found", 404);
  const result = await input.env.PLATFORM_DB.prepare(`
    SELECT cart_items.quantity, product_variants.id AS variantId,
      product_variants.product_id AS productId, product_variants.sku,
      product_variants.title, product_variants.price_minor AS priceMinor,
      product_variants.currency, product_variants.min_per_order AS minPerOrder,
      product_variants.max_per_order AS maxPerOrder, product_variants.status,
      product_variants.version, products.title AS productTitle,
      products.status AS productStatus, products.version AS productVersion,
      products.fulfillment_type AS fulfillmentType,
      products.delivery_mode AS deliveryMode,
      CASE WHEN products.delivery_mode = 'shipping'
        THEN COALESCE((
          SELECT variant_stock_levels.on_hand - variant_stock_levels.reserved
          FROM variant_stock_levels
          WHERE variant_stock_levels.shop_id = product_variants.shop_id
            AND variant_stock_levels.variant_id = product_variants.id
        ), 0)
        ELSE COUNT(CASE WHEN inventory_keys.status = 'available' THEN 1 END)
      END AS availableStock
    FROM cart_items
    INNER JOIN product_variants
      ON product_variants.id = cart_items.variant_id
      AND product_variants.shop_id = cart_items.shop_id
    INNER JOIN products
      ON products.id = product_variants.product_id
      AND products.shop_id = product_variants.shop_id
    LEFT JOIN inventory_keys
      ON inventory_keys.shop_id = product_variants.shop_id
      AND inventory_keys.variant_id = product_variants.id
    WHERE cart_items.cart_id = ? AND cart_items.shop_id = ?
    GROUP BY product_variants.id, cart_items.quantity
    ORDER BY products.created_at, product_variants.created_at
    LIMIT 20
  `).bind(cartId, input.shop.id).all<PrincipalCartLine>();
  return { cartId, discountCode: cart.discountCode, lines: result.results };
}

function quoteLines(lines: readonly PrincipalCartLine[]): CanonicalCartQuoteLine[] {
  return lines.map((line) => line);
}

async function snapshotFingerprint(input: PrincipalChannelPortInput, snapshot: { cartId: string; discountCode: string | null; lines: readonly PrincipalCartLine[] }): Promise<{ discountMinor: number; requestHash: string; subtotalMinor: number; totalMinor: number }> {
  const subtotalMinor = snapshot.lines.reduce((sum, line) => sum + line.priceMinor * line.quantity, 0);
  const discountMinor = await calculateCartDiscountMinor({ code: snapshot.discountCode, env: input.env, shop: input.shop, subtotalMinor });
  const totalMinor = subtotalMinor - discountMinor;
  return {
    discountMinor,
    requestHash: await sha256Json({
      cartId: snapshot.cartId,
      discountCode: snapshot.discountCode,
      discountMinor,
      lines: snapshot.lines.map((line) => ({
        price: line.priceMinor,
        productVersion: line.productVersion,
        quantity: line.quantity,
        variantId: line.variantId,
        version: line.version,
      })),
      totalMinor,
    }),
    subtotalMinor,
    totalMinor,
  };
}

function checkoutView(row: ReplayRow): CommerceCheckoutView {
  return {
    access: { kind: "principal" },
    currency: row.currency,
    expiresAt: row.expiresAt,
    fulfillmentStatus: row.fulfillmentStatus,
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    paymentStatus: row.paymentStatus,
    status: row.status,
    totalMinor: row.totalMinor,
  };
}

export class PrincipalChannelCommercePort implements CommerceApplicationPort {
  private readonly channelAttribution: OrderChannelAttribution;

  constructor(private readonly input: PrincipalChannelPortInput) {
    this.channelAttribution = attribution(input);
  }

  private async assertContext(context: CommerceContext, capability: ChannelCapability): Promise<string> {
    return assertAdmission(this.input, context, capability);
  }

  async createCart(input: { command: CommerceCreateCartCommand; context: CommerceContext }): Promise<CommerceCreateCartView> {
    const subjectHash = await this.assertContext(input.context, "cart.interactive");
    const cart = await createCanonicalCart({
      channel: legacyChannel(this.input),
      env: this.input.env,
      items: [...input.command.items],
      locale: input.context.locale,
      reuseActiveSubject: true,
      shop: this.input.shop,
      subjectHash,
    });
    if (cart.replayed) {
      const snapshot = await readCartLines(this.input, cart.cartId);
      const requested = [...input.command.items].sort((left, right) => left.variantId.localeCompare(right.variantId));
      const stored = snapshot.lines.map((line) => ({ quantity: line.quantity, variantId: line.variantId })).sort((left, right) => left.variantId.localeCompare(right.variantId));
      if (JSON.stringify(requested) !== JSON.stringify(stored)) throw new AppError("idempotency_conflict", 409);
    }
    return { access: { kind: "principal" }, cartId: cart.cartId, expiresAt: cart.expiresAt };
  }

  async mutateCart(input: { command: CommerceCartMutationCommand; context: CommerceContext }): Promise<CommerceCartMutationView> {
    const subjectHash = await this.assertContext(input.context, "cart.interactive");
    if (input.command.cart.access.kind !== "principal" || input.command.cart.cartId !== null) throw new AppError("commerce_context_mismatch", 403, ["principal_cart_required"]);
    const idempotencyKeyHash = await mutationKeyHash(this.input, input.command.idempotencyKey);
    const findReplay = async (requestHash: string) => {
      const replay = await this.input.env.PLATFORM_DB.prepare(`
        SELECT cart_mutations.cart_id AS cartId, cart_mutations.request_hash AS requestHash
        FROM cart_mutations
        INNER JOIN carts
          ON carts.id = cart_mutations.cart_id
          AND carts.shop_id = cart_mutations.shop_id
        WHERE cart_mutations.shop_id = ?
          AND cart_mutations.subject_hash = ?
          AND cart_mutations.idempotency_key_hash = ?
          AND cart_mutations.expires_at > ?
          AND carts.channel = ?
          AND carts.subject_hash = ?
          AND carts.state = 'active'
          AND carts.expires_at > ?
        LIMIT 1
      `).bind(this.input.shop.id, subjectHash, idempotencyKeyHash, new Date().toISOString(), legacyChannel(this.input), subjectHash, new Date().toISOString()).first<{ cartId: string; requestHash: string }>();
      if (replay === null) return null;
      if (replay.requestHash !== requestHash) throw new AppError("idempotency_conflict", 409);
      return replay;
    };
    const active = async () => {
      const cart = await findCanonicalActiveCart({ channel: legacyChannel(this.input), env: this.input.env, shopId: this.input.shop.id, subjectHash });
      if (cart === null) throw new AppError("cart_not_found", 404);
      return { ...cart, subjectHash };
    };
    const result = await applyCanonicalCartMutation({
      env: this.input.env,
      findReplay,
      mutation: input.command.mutation,
      recordReplay: ({ cartId, expiresAt, nowIso, requestHash }) => this.input.env.PLATFORM_DB.prepare(`
        INSERT INTO cart_mutations (id, shop_id, cart_id, subject_hash, idempotency_key_hash, request_hash, created_at, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM carts WHERE id = ? AND shop_id = ? AND channel = ? AND subject_hash = ? AND state = 'active' AND expires_at > ?
        ) AND changes() = 1
      `).bind(createId("cmr"), this.input.shop.id, cartId, subjectHash, idempotencyKeyHash, requestHash, nowIso, expiresAt, cartId, this.input.shop.id, legacyChannel(this.input), subjectHash, nowIso),
      resolveCart: active,
      shop: this.input.shop,
    });
    return { cart: { access: { kind: "principal" }, cartId: result.cartId }, replayed: result.replayed };
  }

  async quoteCart(input: { command: CommerceQuoteCommand; context: CommerceContext }): Promise<CommerceQuoteView> {
    const subjectHash = await this.assertContext(input.context, "catalog.read");
    if (input.command.cart.access.kind !== "principal") throw new AppError("commerce_context_mismatch", 403, ["principal_cart_required"]);
    const cart = await this.input.env.PLATFORM_DB.prepare("SELECT expires_at AS expiresAt FROM carts WHERE id = ? AND shop_id = ? AND channel = ? AND subject_hash = ? AND state = 'active' AND expires_at > ? LIMIT 1").bind(input.command.cart.cartId, this.input.shop.id, legacyChannel(this.input), subjectHash, new Date().toISOString()).first<{ expiresAt: string }>();
    if (cart === null) throw new AppError("cart_not_found", 404);
    const snapshot = await readCartLines(this.input, input.command.cart.cartId);
    return projectCanonicalCartQuote({ cartExpiresAt: cart.expiresAt, cartId: snapshot.cartId, discountCode: snapshot.discountCode, env: this.input.env, lines: quoteLines(snapshot.lines), shop: this.input.shop });
  }

  async checkoutCart(input: { command: CommerceCheckoutCommand; context: CommerceContext }): Promise<CommerceCheckoutView> {
    const subjectHash = await this.assertContext(input.context, "checkout.external_link");
    assertSubscriptionAllows({ currentPeriodEnd: this.input.shop.currentPeriodEnd, graceEndsAt: this.input.shop.graceEndsAt, subscriptionState: this.input.shop.subscriptionState, trialEndsAt: this.input.shop.trialEndsAt });
    assertCheckoutAllowed({ shopStatus: this.input.shop.status, subscriptionState: this.input.shop.subscriptionState });
    const command = input.command;
    if (command.customerEmail !== null || command.cart.access.kind !== "principal" || (this.input.expectedIdempotencyKey !== undefined && command.idempotencyKey !== this.input.expectedIdempotencyKey)) throw new AppError("commerce_context_mismatch", 403, ["principal_checkout_required"]);
    const checkoutSubject = await checkoutKeyHash(this.input, command.idempotencyKey);
    const recoverReplay = async (): Promise<CommerceCheckoutView | null> => {
      const replay = await this.input.env.PLATFORM_DB.prepare(`
        SELECT orders.public_id AS orderId, orders.order_number AS orderNumber,
          orders.status, orders.payment_status AS paymentStatus,
          orders.fulfillment_status AS fulfillmentStatus, orders.total_minor AS totalMinor,
          orders.currency, orders.expires_at AS expiresAt, orders.checkout_request_hash AS requestHash,
          orders.customer_id AS customerId,
          orders.source_channel AS sourceChannel,
          order_channel_attributions.channel_code AS channelCode,
          order_channel_attributions.adapter_version AS adapterVersion,
          order_channel_attributions.connection_id AS connectionId
        FROM orders
        INNER JOIN order_channel_attributions
          ON order_channel_attributions.shop_id = orders.shop_id
          AND order_channel_attributions.order_id = orders.id
        WHERE orders.shop_id = ? AND orders.checkout_subject_hash = ?
        LIMIT 1
      `).bind(this.input.shop.id, checkoutSubject).first<ReplayRow>();
      if (replay === null) return null;
      if (
        replay.sourceChannel !== this.channelAttribution.legacySourceChannel
        || replay.channelCode !== this.channelAttribution.channelCode
        || replay.connectionId !== this.input.connectionId
        || replay.adapterVersion !== this.channelAttribution.adapterVersion
        || replay.customerId !== this.input.identity.customerId
      ) throw new AppError("idempotency_conflict", 409);
      return checkoutView(replay);
    };
    const snapshot = await readCartLines(this.input, command.cart.cartId);
    const cart = await this.input.env.PLATFORM_DB.prepare("SELECT expires_at AS expiresAt FROM carts WHERE id = ? AND shop_id = ? AND channel = ? AND subject_hash = ? LIMIT 1").bind(command.cart.cartId, this.input.shop.id, legacyChannel(this.input), subjectHash).first<{ expiresAt: string }>();
    if (cart === null) {
      const replay = await recoverReplay();
      if (replay !== null) return replay;
      throw new AppError("cart_not_found", 404);
    }
    const expected = command.expected;
    const expectedMatches = expected.length === snapshot.lines.length && !snapshot.lines.some((line) => {
      const item = expected.find((value) => value.variantId === line.variantId);
      return item === undefined || item.quantity !== line.quantity || item.unitPriceMinor !== line.priceMinor || item.variantVersion !== line.version;
    });
    if (command.quoteEvidence === undefined) throw new AppError("quote_invalid", 409);
    const quoteEvidence = command.quoteEvidence;
    const verifySnapshotQuote = async (current: typeof snapshot): Promise<{ discountMinor: number; requestHash: string; subtotalMinor: number; totalMinor: number }> => {
      const fingerprint = await snapshotFingerprint(this.input, current);
      await verifyQuoteEvidence({
        cartId: current.cartId,
        cartExpiresAt: cart.expiresAt,
        catalog: current.lines.map((line) => ({ productVersion: line.productVersion, quantity: line.quantity, unitPriceMinor: line.priceMinor, variantId: line.variantId, variantVersion: line.version })),
        evidence: quoteEvidence,
        expected,
        pricing: { discountCode: current.discountCode, discountMinor: fingerprint.discountMinor, totalMinor: fingerprint.totalMinor },
        requireCatalog: true,
        secret: this.input.env.IDENTIFIER_HMAC_SECRET,
        shopId: this.input.shop.id,
      });
      return fingerprint;
    };
    const requestedFingerprint = await snapshotFingerprint(this.input, snapshot);
    const existing = await recoverReplay();
    if (existing !== null) {
      if (!expectedMatches) throw new AppError("idempotency_conflict", 409);
      const row = await this.input.env.PLATFORM_DB.prepare("SELECT checkout_request_hash AS requestHash FROM orders WHERE shop_id = ? AND checkout_subject_hash = ? LIMIT 1").bind(this.input.shop.id, checkoutSubject).first<{ requestHash: string | null }>();
      if (row?.requestHash !== requestedFingerprint.requestHash) throw new AppError("idempotency_conflict", 409);
      await verifySnapshotQuote(snapshot);
      return existing;
    }
    if (!expectedMatches) throw new AppError("checkout_changed", 409);
    const active = await this.input.env.PLATFORM_DB.prepare("SELECT 1 AS active FROM carts WHERE id = ? AND shop_id = ? AND channel = ? AND subject_hash = ? AND state = 'active' AND expires_at > ? LIMIT 1").bind(command.cart.cartId, this.input.shop.id, legacyChannel(this.input), subjectHash, new Date().toISOString()).first<{ active: number }>();
    if (active === null) throw new AppError("checkout_changed", 409);
    const fingerprint = await verifySnapshotQuote(snapshot);
    for (const line of snapshot.lines) {
      if (line.status !== "active" || line.productStatus !== "active" || line.currency !== this.input.shop.currency || line.quantity < line.minPerOrder || line.quantity > line.maxPerOrder) throw new AppError("catalog_changed", 409);
      if ((line.fulfillmentType === "license_key" || line.deliveryMode === "shipping") && line.availableStock < line.quantity) throw new AppError("inventory_unavailable", 409);
    }
    if (fingerprint.totalMinor > 0 && this.input.shop.currency !== "VND") throw new AppError("payment_currency_unsupported", 409);
    const orderId = createId("ord");
    const orderPublicId = createId("order");
    const reservationToken = createOpaqueToken();
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.input.shop.orderExpiryMinutes * 60_000).toISOString();
    const orderToken = await hmacToken(this.input.env.IDENTIFIER_HMAC_SECRET, `principal-order-token:${this.input.shop.id}:${this.input.channelCode}:${this.input.connectionId}`, command.idempotencyKey);
    const orderTokenHash = await hmacToken(this.input.env.IDENTIFIER_HMAC_SECRET, "order-access", orderToken);
    try {
      const result = await executeCanonicalCheckoutTransaction({
        cartId: command.cart.cartId,
        cartSnapshot: { discountCode: snapshot.discountCode },
        channel: { attribution: this.channelAttribution, code: this.input.channelCode, connectionId: this.input.connectionId },
        checkoutRequestHash: fingerprint.requestHash,
        checkoutSubjectHash: checkoutSubject,
        currency: this.input.shop.currency,
        customer: { customerId: this.input.identity.customerId, kind: "existing", maskedEmail: null },
        discountMinor: fingerprint.discountMinor,
        env: this.input.env,
        eventIdempotencyKey: checkoutSubject,
        expiresAt,
        fulfillmentIdempotencyPrefix: `${this.input.channelCode}-free`,
        lines: snapshot.lines.map((line) => ({ deliveryMode: line.deliveryMode, fulfillmentType: line.fulfillmentType, priceMinor: line.priceMinor, productId: line.productId, productTitle: line.productTitle, productVersion: line.productVersion, quantity: line.quantity, sku: line.sku, title: line.title, variantId: line.variantId, variantVersion: line.version })),
        locale: input.context.locale,
        nowIso,
        orderId,
        orderPublicId,
        orderTokenHash,
        reservationToken,
        shopId: this.input.shop.id,
        subtotalMinor: fingerprint.subtotalMinor,
        totalMinor: fingerprint.totalMinor,
      });
      return { access: { kind: "principal" }, ...result };
    } catch (error) {
      const replay = await recoverReplay();
      if (replay !== null) {
        const row = await this.input.env.PLATFORM_DB.prepare("SELECT checkout_request_hash AS requestHash FROM orders WHERE shop_id = ? AND checkout_subject_hash = ? LIMIT 1").bind(this.input.shop.id, checkoutSubject).first<{ requestHash: string | null }>();
        if (row?.requestHash !== fingerprint.requestHash) throw new AppError("idempotency_conflict", 409);
        return replay;
      }
      if (error instanceof AppError) throw error;
      const cartState = await this.input.env.PLATFORM_DB.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ? LIMIT 1").bind(command.cart.cartId, this.input.shop.id).first<{ state: string }>();
      if (cartState?.state === "active") {
        const current = await readCartLines(this.input, command.cart.cartId);
        if ((await snapshotFingerprint(this.input, current)).requestHash !== fingerprint.requestHash) throw new AppError("checkout_changed", 409);
        for (const line of current.lines) {
          const variant = await loadCanonicalCartVariant(this.input.env, this.input.shop.id, line.variantId);
          if (variant.priceMinor !== line.priceMinor || variant.productVersion !== line.productVersion || variant.version !== line.version) throw new AppError("checkout_changed", 409);
          if ((variant.fulfillmentType === "license_key" || variant.deliveryMode === "shipping") && variant.availableStock < line.quantity) throw new AppError("inventory_unavailable", 409);
        }
      }
      throw new AppError("checkout_failed", 409);
    }
  }

  async getOrder(input: { command: { order: CommerceOrderReference }; context: CommerceContext }): Promise<CommerceOrderView> {
    await this.assertContext(input.context, "orders.status_push");
    if (input.command.order.access.kind !== "principal") throw new AppError("commerce_context_mismatch", 403, ["principal_access_required"]);
    const row = await this.input.env.PLATFORM_DB.prepare(`
      SELECT orders.id, orders.order_number AS orderNumber, orders.status,
        orders.payment_status AS paymentStatus, orders.fulfillment_status AS fulfillmentStatus,
        orders.total_minor AS totalMinor, orders.currency, orders.expires_at AS expiresAt
      FROM orders INNER JOIN order_channel_attributions
        ON order_channel_attributions.shop_id = orders.shop_id AND order_channel_attributions.order_id = orders.id
      WHERE orders.public_id = ? AND orders.shop_id = ? AND orders.customer_id = ?
        AND orders.source_channel = ? AND order_channel_attributions.channel_code = ?
        AND order_channel_attributions.connection_id = ? AND order_channel_attributions.adapter_version = ?
      LIMIT 1
    `).bind(input.command.order.orderId, this.input.shop.id, this.input.identity.customerId, this.channelAttribution.legacySourceChannel, this.channelAttribution.channelCode, this.input.connectionId, this.channelAttribution.adapterVersion).first<{ currency: string; expiresAt: string; fulfillmentStatus: string; id: string; orderNumber: string; paymentStatus: string; status: string; totalMinor: number }>();
    if (row === null) throw new AppError("order_not_found", 404);
    const items = await this.input.env.PLATFORM_DB.prepare("SELECT product_title AS productTitle, variant_title AS variantTitle, quantity, line_total_minor AS lineTotalMinor, fulfillment_type AS fulfillmentType FROM order_items WHERE order_id = ? AND shop_id = ? ORDER BY id").bind(row.id, this.input.shop.id).all<{ fulfillmentType: string; lineTotalMinor: number; productTitle: string; quantity: number; variantTitle: string }>();
    return { currency: row.currency, expiresAt: row.expiresAt, fulfillmentStatus: row.fulfillmentStatus, items: items.results, orderNumber: row.orderNumber, paymentStatus: row.paymentStatus, status: row.status, totalMinor: row.totalMinor };
  }

  async listOrders(input: { command: CommerceListOrdersCommand; context: CommerceContext }): Promise<CommerceListOrdersView> {
    await this.assertContext(input.context, "orders.status_push");
    const result = await this.input.env.PLATFORM_DB.prepare(`
      SELECT orders.public_id AS orderId, orders.order_number AS orderNumber,
        orders.status, orders.payment_status AS paymentStatus,
        orders.fulfillment_status AS fulfillmentStatus, orders.total_minor AS totalMinor,
        orders.currency
      FROM orders INNER JOIN order_channel_attributions
        ON order_channel_attributions.shop_id = orders.shop_id AND order_channel_attributions.order_id = orders.id
      WHERE orders.shop_id = ? AND orders.customer_id = ? AND orders.source_channel = ?
        AND order_channel_attributions.channel_code = ? AND order_channel_attributions.connection_id = ?
        AND order_channel_attributions.adapter_version = ?
      ORDER BY orders.created_at DESC, orders.id DESC LIMIT 10
    `).bind(this.input.shop.id, this.input.identity.customerId, this.channelAttribution.legacySourceChannel, this.channelAttribution.channelCode, this.input.connectionId, this.channelAttribution.adapterVersion).all<CommerceListOrdersView[number]>();
    return result.results;
  }
}

export function createPrincipalChannelCommerceApplication(input: PrincipalChannelPortInput): CommerceApplicationService {
  return new CommerceApplicationService(new PrincipalChannelCommercePort(input));
}
