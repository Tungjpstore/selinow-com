import { hmacToken, sha256Json } from "../core/crypto";
import { assertSubscriptionAllows } from "../billing/entitlements";
import { CommerceApplicationService } from "./application";
import { AppError } from "../core/errors";
import { createId, createOpaqueToken } from "../core/ids";
import { resolveOrderChannelAttribution } from "../channels/attribution";
import { TELEGRAM_CHANNEL_CODE } from "../channels/builtins";
import type { AppBindings } from "../platform/bindings";
import type {
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
  CommercePaymentFulfillmentApplication,
  CommercePort,
  CommerceQuoteCommand,
  CommerceQuoteView,
} from "./contracts";
import { assertCheckoutAllowed } from "../tenants/policy";
import { executeCanonicalCheckoutTransaction } from "./checkout-transaction";
import { applyCanonicalCartMutation, loadCanonicalCartVariant } from "./cart-mutation";
import { createCanonicalCart, findCanonicalActiveCart } from "./cart-creation";
import { projectCanonicalCartQuote } from "./cart-quote";
import { calculateCartDiscountMinor } from "./pricing";
import { verifyQuoteEvidence } from "./quote-evidence";

export type TelegramCartShop = {
  currency: string;
  defaultLocale: string;
  id: string;
};

export type TelegramCheckoutShop = TelegramCartShop & {
  currentPeriodEnd?: string | null;
  graceEndsAt?: string | null;
  orderExpiryMinutes: number;
  status: string;
  subscriptionState: string;
  trialEndsAt?: string | null;
};

export type TelegramCartIdentity = {
  customerId: string;
  subjectHash: string;
};

export type TelegramCheckoutIdentity = TelegramCartIdentity & {
  integrationId: string;
};

export type TelegramCartLine = {
  availableStock: number;
  currency: string;
  fulfillmentType: "license_key" | "manual";
  maxPerOrder: number;
  minPerOrder: number;
  priceMinor: number;
  productId: string;
  productStatus: string;
  productTitle: string;
  productVersion: number;
  sku: string;
  status: string;
  title: string;
  variantId: string;
  version: number;
  quantity: number;
};

export type TelegramCartSnapshot = {
  cartId: string;
  discountCode: string | null;
  lines: TelegramCartLine[];
};

const TELEGRAM_ORDER_ATTRIBUTION = resolveOrderChannelAttribution(TELEGRAM_CHANNEL_CODE);

type TelegramOrderSummary = {
  currency: string;
  fulfillmentStatus: string;
  orderId: string;
  orderNumber: string;
  paymentStatus: string;
  status: string;
  totalMinor: number;
};

async function getActiveTelegramCart(env: AppBindings, shop: TelegramCartShop, subjectHash: string, locale = shop.defaultLocale): Promise<string> {
  return (await createCanonicalCart({ channel: "telegram", env, items: [], locale, reuseActiveSubject: true, shop, subjectHash })).cartId;
}

async function loadVariant(env: AppBindings, shopId: string, variantId: string): Promise<Omit<TelegramCartLine, "quantity">> {
  return loadCanonicalCartVariant(env, shopId, variantId);
}

export async function readTelegramCartLines(env: AppBindings, shop: TelegramCartShop, cartId: string): Promise<TelegramCartSnapshot> {
  const cart = await env.PLATFORM_DB.prepare("SELECT discount_code_normalized AS discountCode FROM carts WHERE id = ? AND shop_id = ? LIMIT 1").bind(cartId, shop.id).first<{ discountCode: string | null }>();
  const result = await env.PLATFORM_DB.prepare(`SELECT cart_items.quantity, product_variants.id AS variantId, product_variants.product_id AS productId, product_variants.sku, product_variants.title, product_variants.price_minor AS priceMinor, product_variants.currency, product_variants.min_per_order AS minPerOrder, product_variants.max_per_order AS maxPerOrder, product_variants.status, product_variants.version, products.title AS productTitle, products.status AS productStatus, products.version AS productVersion, products.fulfillment_type AS fulfillmentType, COUNT(CASE WHEN inventory_keys.status = 'available' THEN 1 END) AS availableStock FROM cart_items INNER JOIN product_variants ON product_variants.id = cart_items.variant_id AND product_variants.shop_id = cart_items.shop_id INNER JOIN products ON products.id = product_variants.product_id AND products.shop_id = product_variants.shop_id LEFT JOIN inventory_keys ON inventory_keys.shop_id = product_variants.shop_id AND inventory_keys.variant_id = product_variants.id WHERE cart_items.cart_id = ? AND cart_items.shop_id = ? GROUP BY product_variants.id, cart_items.quantity ORDER BY products.created_at, product_variants.created_at LIMIT 20`).bind(cartId, shop.id).all<TelegramCartLine>();
  return { cartId, discountCode: cart?.discountCode ?? null, lines: result.results };
}

async function loadTelegramCartLines(env: AppBindings, shop: TelegramCartShop, identity: TelegramCartIdentity): Promise<TelegramCartSnapshot> {
  return readTelegramCartLines(env, shop, await getActiveTelegramCart(env, shop, identity.subjectHash));
}

type TelegramAction = { resultReference: string | null };

const TELEGRAM_QUOTE_ACTION_KIND = "cart_quote:v1";

export type TelegramQuoteActionReference = {
  cartId: string;
  customerId: string;
  quoteEvidence: string;
  quoteHash: string;
  subjectHash: string;
};

async function findAction(env: AppBindings, shopId: string, integrationId: string, updateId: number, kind: string): Promise<TelegramAction | null> {
  // Update IDs may be reused after a credential rotation. Only the active
  // generation can own an idempotency receipt for a live commerce request.
  try {
    return await env.PLATFORM_DB.prepare(`
      SELECT telegram_actions.result_reference AS resultReference
      FROM telegram_actions
      INNER JOIN telegram_integrations
        ON telegram_integrations.id = telegram_actions.integration_id
        AND telegram_integrations.shop_id = telegram_actions.shop_id
        AND telegram_integrations.integration_generation = telegram_actions.integration_generation
        AND telegram_integrations.generation_state = 'active'
        AND telegram_integrations.status IN ('active', 'degraded')
      WHERE telegram_actions.shop_id = ?
        AND telegram_actions.integration_id = ?
        AND telegram_actions.update_id = ?
        AND telegram_actions.action_kind = ?
      LIMIT 1
    `).bind(shopId, integrationId, updateId, kind).first<TelegramAction>();
  } catch {
    // During a rolling migration the old schema has no generation columns;
    // preserve its tenant-bound replay behavior until 0097 is admitted.
    return await env.PLATFORM_DB.prepare("SELECT result_reference AS resultReference FROM telegram_actions WHERE shop_id = ? AND integration_id = ? AND update_id = ? AND action_kind = ? LIMIT 1").bind(shopId, integrationId, updateId, kind).first<TelegramAction>();
  }
}

/**
 * The legacy action table has independent shop/integration foreign keys, so
 * adapter entrypoints must enforce their tenant relationship explicitly.
 */
async function assertTelegramIntegrationTenant(input: { env: AppBindings; integrationId: string; shopId: string }): Promise<void> {
  const row = await input.env.PLATFORM_DB.prepare(
    "SELECT 1 AS found FROM telegram_integrations WHERE id = ? AND shop_id = ? LIMIT 1",
  ).bind(input.integrationId, input.shopId).first<{ found: number }>();
  if (row === null) throw new AppError("commerce_context_mismatch", 403, ["telegram_integration_required"]);
}

function parseMutationReference(value: string | null): { cartId: string; requestHash: string | null } | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const row = parsed as Record<string, unknown>;
      if (typeof row.cartId === "string" && (row.requestHash === null || typeof row.requestHash === "string")) return { cartId: row.cartId, requestHash: row.requestHash };
    }
  } catch {
    // Older action rows stored the cart ID directly; preserve replay behavior.
  }
  return /^[A-Za-z0-9._:-]{1,160}$/u.test(value) ? { cartId: value, requestHash: null } : null;
}

function mutationActionKind(idempotencyKey: string): string {
  return `cart_mutation:${idempotencyKey}`;
}

function mutationReference(cartId: string, requestHash: string): string {
  return JSON.stringify({ cartId, requestHash });
}

function parseQuoteReference(value: string | null): TelegramQuoteActionReference | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (
      typeof row.cartId !== "string"
      || typeof row.customerId !== "string"
      || typeof row.quoteEvidence !== "string"
      || typeof row.quoteHash !== "string"
      || typeof row.subjectHash !== "string"
    ) return null;
    return {
      cartId: row.cartId,
      customerId: row.customerId,
      quoteEvidence: row.quoteEvidence,
      quoteHash: row.quoteHash,
      subjectHash: row.subjectHash,
    };
  } catch {
    return null;
  }
}

/** Persist a short-lived quote without allowing a Telegram update to be replaced. */
export async function persistTelegramQuoteAction(input: {
  cartId: string;
  discountCode: string | null;
  env: AppBindings;
  identity: TelegramCartIdentity;
  integrationId: string;
  quote: CommerceQuoteView;
  shop: TelegramCartShop;
  updateId: number;
}): Promise<TelegramQuoteActionReference> {
  await assertTelegramIntegrationTenant({ env: input.env, integrationId: input.integrationId, shopId: input.shop.id });
  if (input.quote.quoteEvidence === undefined) throw new AppError("quote_invalid", 409);
  const quoteHash = await sha256Json({
    currency: input.quote.currency,
    discountCode: input.discountCode,
    discountMinor: input.quote.discountMinor,
    items: input.quote.items,
    subtotalMinor: input.quote.subtotalMinor,
    totalMinor: input.quote.totalMinor,
  });
  const proposed: TelegramQuoteActionReference = {
    cartId: input.cartId,
    customerId: input.identity.customerId,
    quoteEvidence: input.quote.quoteEvidence,
    quoteHash,
    subjectHash: input.identity.subjectHash,
  };
  const nowIso = new Date().toISOString();
  await input.env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO telegram_actions (id, shop_id, integration_id, update_id, action_kind, result_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(createId("tga"), input.shop.id, input.integrationId, input.updateId, TELEGRAM_QUOTE_ACTION_KIND, JSON.stringify(proposed), nowIso).run();
  const stored = parseQuoteReference((await findAction(
    input.env,
    input.shop.id,
    input.integrationId,
    input.updateId,
    TELEGRAM_QUOTE_ACTION_KIND,
  ))?.resultReference ?? null);
  if (stored === null) throw new AppError("quote_invalid", 409);
  if (
    stored.cartId !== proposed.cartId
    || stored.customerId !== proposed.customerId
    || stored.quoteHash !== proposed.quoteHash
    || stored.subjectHash !== proposed.subjectHash
  ) throw new AppError("idempotency_conflict", 409);
  return stored;
}

export async function loadTelegramQuoteAction(input: {
  env: AppBindings;
  identity: TelegramCartIdentity;
  integrationId: string;
  shopId: string;
  updateId: number;
}): Promise<TelegramQuoteActionReference> {
  await assertTelegramIntegrationTenant({ env: input.env, integrationId: input.integrationId, shopId: input.shopId });
  const stored = parseQuoteReference((await findAction(
    input.env,
    input.shopId,
    input.integrationId,
    input.updateId,
    TELEGRAM_QUOTE_ACTION_KIND,
  ))?.resultReference ?? null);
  if (stored === null) throw new AppError("quote_invalid", 409);
  if (stored.customerId !== input.identity.customerId || stored.subjectHash !== input.identity.subjectHash) {
    throw new AppError("quote_invalid", 409);
  }
  return stored;
}

async function requireActiveTelegramReplayCart(input: {
  cartId: string;
  env: AppBindings;
  shopId: string;
  subjectHash: string;
}): Promise<{ expiresAt: string }> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT expires_at AS expiresAt
    FROM carts
    WHERE id = ? AND shop_id = ? AND channel = 'telegram'
      AND subject_hash = ? AND state = 'active' AND expires_at > ?
    LIMIT 1
  `).bind(
    input.cartId,
    input.shopId,
    input.subjectHash,
    new Date().toISOString(),
  ).first<{ expiresAt: string }>();
  if (row === null) throw new AppError("cart_not_found", 404);
  return row;
}

async function addVariant(input: { env: AppBindings; identity: TelegramCartIdentity; idempotencyKey: string; integrationId: string; quantity: number; shop: TelegramCartShop; updateId: number; variantId: string }): Promise<{ cartId: string; replayed: boolean }> {
  return applyTelegramCartMutation({ ...input, mutation: { kind: "item.increment", quantity: input.quantity, variantId: input.variantId } });
}

async function applyDiscount(input: { code: string; env: AppBindings; identity: TelegramCartIdentity; idempotencyKey: string; integrationId: string; shop: TelegramCartShop; updateId: number }): Promise<{ cartId: string; replayed: boolean }> {
  return applyTelegramCartMutation({ ...input, mutation: { code: input.code, kind: "discount.apply" } });
}

async function applyTelegramCartMutation(input: { env: AppBindings; identity: TelegramCartIdentity; idempotencyKey: string; integrationId: string; mutation: { code: string; kind: "discount.apply" } | { kind: "item.increment"; quantity: number; variantId: string }; shop: TelegramCartShop; updateId: number }): Promise<{ cartId: string; replayed: boolean }> {
  const actionKind = mutationActionKind(input.idempotencyKey);
  const findReplay = async (requestHash: string) => {
    const existingAction = await findAction(input.env, input.shop.id, input.integrationId, input.updateId, actionKind);
    if (existingAction === null) return null;
    const replay = parseMutationReference(existingAction.resultReference);
    if (replay === null) throw new AppError("cart_failed", 409);
    if (replay.requestHash !== null && replay.requestHash !== requestHash) throw new AppError("idempotency_conflict", 409);
    await requireActiveTelegramReplayCart({ cartId: replay.cartId, env: input.env, shopId: input.shop.id, subjectHash: input.identity.subjectHash });
    return replay;
  };
  return applyCanonicalCartMutation({
    env: input.env,
    findReplay,
    mutation: input.mutation,
    recordReplay: ({ cartId, nowIso, requestHash }) => input.env.PLATFORM_DB.prepare("INSERT INTO telegram_actions (id, shop_id, integration_id, update_id, action_kind, result_reference, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM carts WHERE id = ? AND shop_id = ? AND channel = 'telegram' AND state = 'active' AND expires_at > ?) AND changes() = 1").bind(createId("tga"), input.shop.id, input.integrationId, input.updateId, actionKind, mutationReference(cartId, requestHash), nowIso, cartId, input.shop.id, nowIso),
    resolveCart: async () => {
      const cartId = await getActiveTelegramCart(input.env, input.shop, input.identity.subjectHash);
      const row = await input.env.PLATFORM_DB.prepare("SELECT expires_at AS expiresAt, subject_hash AS subjectHash FROM carts WHERE id = ? AND shop_id = ? AND channel = 'telegram' AND state = 'active' LIMIT 1").bind(cartId, input.shop.id).first<{ expiresAt: string; subjectHash: string }>();
      if (row === null) throw new AppError("cart_not_found", 404);
      return { cartId, expiresAt: row.expiresAt, subjectHash: row.subjectHash };
    },
    shop: input.shop,
  });
}

export class TelegramCartMutationPort implements Required<Pick<CommercePort, "createCart" | "mutateCart" | "quoteCart">> {
  constructor(private readonly input: {
    connectionId: string | null;
    env: AppBindings;
    expectedIdempotencyKey: string;
    identity: TelegramCartIdentity;
    integrationId: string;
    shop: TelegramCartShop;
    updateId: number;
  }) {}

  async createCart(input: { command: CommerceCreateCartCommand; context: CommerceContext }): Promise<CommerceCreateCartView> {
    if (input.context.shopId !== this.input.shop.id || input.context.channel.connectionId !== this.input.connectionId || input.context.channel.code !== TELEGRAM_CHANNEL_CODE) throw new AppError("commerce_context_mismatch", 403, ["telegram_channel_required"]);
    if (input.context.actor.kind !== "customer" || input.context.actor.customerId !== this.input.identity.customerId) throw new AppError("commerce_context_mismatch", 403, ["telegram_customer_required"]);
    await assertTelegramIntegrationTenant({ env: this.input.env, integrationId: this.input.integrationId, shopId: this.input.shop.id });
    if (input.context.requestId !== this.input.expectedIdempotencyKey || input.command.items.length !== 1) throw new AppError("commerce_context_mismatch", 403, ["telegram_cart_create_required"]);
    const item = input.command.items[0];
    if (item === undefined) throw new AppError("commerce_context_mismatch", 403, ["telegram_cart_create_required"]);
    const mutation = { kind: "item.increment" as const, quantity: item.quantity, variantId: item.variantId };
    const requestHash = await sha256Json(mutation);
    const actionKind = mutationActionKind(this.input.expectedIdempotencyKey);
    const recoverReplay = async (): Promise<CommerceCreateCartView | null> => {
      const action = await findAction(this.input.env, this.input.shop.id, this.input.integrationId, this.input.updateId, actionKind);
      if (action === null) return null;
      const replay = parseMutationReference(action.resultReference);
      if (replay === null) throw new AppError("cart_failed", 409);
      if (replay.requestHash !== null && replay.requestHash !== requestHash) throw new AppError("idempotency_conflict", 409);
      const row = await requireActiveTelegramReplayCart({ cartId: replay.cartId, env: this.input.env, shopId: this.input.shop.id, subjectHash: this.input.identity.subjectHash });
      return { access: { kind: "principal" }, cartId: replay.cartId, expiresAt: row.expiresAt };
    };
    const replay = await recoverReplay();
    if (replay !== null) return replay;
    const active = await findCanonicalActiveCart({ channel: "telegram", env: this.input.env, shopId: this.input.shop.id, subjectHash: this.input.identity.subjectHash });
    if (active !== null) {
      const result = await addVariant({ env: this.input.env, identity: this.input.identity, idempotencyKey: this.input.expectedIdempotencyKey, integrationId: this.input.integrationId, quantity: item.quantity, shop: this.input.shop, updateId: this.input.updateId, variantId: item.variantId });
      return { access: { kind: "principal" }, cartId: result.cartId, expiresAt: active.expiresAt };
    }
    try {
      const cart = await createCanonicalCart({ channel: "telegram",
        additionalStatements: ({ cartId, nowIso }) => [this.input.env.PLATFORM_DB.prepare("INSERT INTO telegram_actions (id, shop_id, integration_id, update_id, action_kind, result_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(createId("tga"), this.input.shop.id, this.input.integrationId, this.input.updateId, actionKind, mutationReference(cartId, requestHash), nowIso)],
        env: this.input.env,
        items: input.command.items,
        locale: input.context.locale,
        shop: this.input.shop,
        subjectHash: this.input.identity.subjectHash,
      });
      return { access: { kind: "principal" }, cartId: cart.cartId, expiresAt: cart.expiresAt };
    } catch (error) {
      const concurrentReplay = await recoverReplay();
      if (concurrentReplay !== null) return concurrentReplay;
      throw error;
    }
  }

  async mutateCart(input: { command: CommerceCartMutationCommand; context: CommerceContext }): Promise<CommerceCartMutationView> {
    if (input.context.shopId !== this.input.shop.id || input.context.channel.connectionId !== this.input.connectionId || input.context.channel.code !== "telegram") throw new AppError("commerce_context_mismatch", 403, ["telegram_channel_required"]);
    if (input.context.actor.kind !== "customer" || input.context.actor.customerId !== this.input.identity.customerId) throw new AppError("commerce_context_mismatch", 403, ["telegram_customer_required"]);
    await assertTelegramIntegrationTenant({ env: this.input.env, integrationId: this.input.integrationId, shopId: this.input.shop.id });
    if (input.command.cart.access.kind !== "principal" || input.command.cart.cartId !== null) throw new AppError("commerce_context_mismatch", 403, ["principal_cart_required"]);
    if (input.command.idempotencyKey !== this.input.expectedIdempotencyKey) throw new AppError("commerce_context_mismatch", 403, ["idempotency_key_mismatch"]);
    const result = input.command.mutation.kind === "item.increment"
      ? await addVariant({ env: this.input.env, identity: this.input.identity, idempotencyKey: input.command.idempotencyKey, integrationId: this.input.integrationId, quantity: input.command.mutation.quantity, shop: this.input.shop, updateId: this.input.updateId, variantId: input.command.mutation.variantId })
      : await applyDiscount({ code: input.command.mutation.code, env: this.input.env, identity: this.input.identity, idempotencyKey: input.command.idempotencyKey, integrationId: this.input.integrationId, shop: this.input.shop, updateId: this.input.updateId });
    return { cart: { access: { kind: "principal" }, cartId: result.cartId }, replayed: result.replayed };
  }

  async quoteCart(input: { command: CommerceQuoteCommand; context: CommerceContext }): Promise<CommerceQuoteView> {
    if (input.context.shopId !== this.input.shop.id || input.context.channel.connectionId !== this.input.connectionId || input.context.channel.code !== TELEGRAM_CHANNEL_CODE) throw new AppError("commerce_context_mismatch", 403, ["telegram_channel_required"]);
    if (input.context.actor.kind !== "customer" || input.context.actor.customerId !== this.input.identity.customerId) throw new AppError("commerce_context_mismatch", 403, ["telegram_customer_required"]);
    await assertTelegramIntegrationTenant({ env: this.input.env, integrationId: this.input.integrationId, shopId: this.input.shop.id });
    if (input.command.cart.access.kind !== "principal") throw new AppError("commerce_context_mismatch", 403, ["principal_cart_required"]);
    const now = new Date();
    const cart = await this.input.env.PLATFORM_DB.prepare("SELECT expires_at AS expiresAt FROM carts WHERE id = ? AND shop_id = ? AND channel = 'telegram' AND subject_hash = ? AND state = 'active' AND expires_at > ? LIMIT 1").bind(input.command.cart.cartId, this.input.shop.id, this.input.identity.subjectHash, now.toISOString()).first<{ expiresAt: string }>();
    if (cart === null) throw new AppError("cart_not_found", 404);
    const snapshot = await readTelegramCartLines(this.input.env, this.input.shop, input.command.cart.cartId);
    return projectCanonicalCartQuote({ cartExpiresAt: cart.expiresAt, cartId: snapshot.cartId, discountCode: snapshot.discountCode, env: this.input.env, lines: snapshot.lines, shop: this.input.shop });
  }
}

export async function createTelegramCartMutationApplicationKey(env: AppBindings, shopId: string, integrationId: string, updateId: number): Promise<string> {
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, `telegram-cart-action:${shopId}`, `${integrationId}:${String(updateId)}`);
}

export async function createTelegramCheckoutApplicationKey(env: AppBindings, shopId: string, integrationId: string, updateId: number): Promise<string> {
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, `telegram-checkout:${shopId}`, `${integrationId}:${String(updateId)}`);
}

async function checkoutSnapshotFingerprint(env: AppBindings, shop: TelegramCheckoutShop, snapshot: TelegramCartSnapshot): Promise<{
  discountMinor: number;
  requestHash: string;
  subtotalMinor: number;
  totalMinor: number;
}> {
  const subtotalMinor = snapshot.lines.reduce((total, line) => total + line.priceMinor * line.quantity, 0);
  const discountMinor = await calculateTelegramDiscount(env, shop, snapshot.discountCode, subtotalMinor);
  const totalMinor = subtotalMinor - discountMinor;
  const requestHash = await sha256Json({
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
  });
  return { discountMinor, requestHash, subtotalMinor, totalMinor };
}

/** Resolve the immutable cart snapshot used by checkout and replay. */
export async function resolveTelegramCheckoutSnapshot(input: {
  connectionId: string | null;
  env: AppBindings;
  identity: TelegramCartIdentity;
  quotedCartId?: string;
  shop: TelegramCheckoutShop;
  checkoutKey: string;
}): Promise<TelegramCartSnapshot | null> {
  const existing = await input.env.PLATFORM_DB.prepare(`
    SELECT orders.checkout_cart_id AS checkoutCartId,
      orders.checkout_request_hash AS checkoutRequestHash,
      orders.customer_id AS customerId,
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
  `).bind(input.shop.id, input.checkoutKey).first<{
    channelCode: string | null;
    adapterVersion: number | null;
    checkoutCartId: string | null;
    checkoutRequestHash: string | null;
    connectionId: string | null;
    customerId: string | null;
    sourceChannel: string;
  }>();
  if (existing !== null) {
    if (
      existing.customerId !== input.identity.customerId
      || existing.sourceChannel !== TELEGRAM_ORDER_ATTRIBUTION.legacySourceChannel
      || existing.channelCode !== TELEGRAM_ORDER_ATTRIBUTION.channelCode
      || existing.adapterVersion !== TELEGRAM_ORDER_ATTRIBUTION.adapterVersion
      || existing.connectionId !== input.connectionId
    ) throw new AppError("idempotency_conflict", 409);
    if (existing.checkoutCartId !== null) return readTelegramCartLines(input.env, input.shop, existing.checkoutCartId);
    if (existing.checkoutRequestHash === null) return null;
    const legacyCarts = await input.env.PLATFORM_DB.prepare("SELECT id FROM carts WHERE shop_id = ? AND channel = 'telegram' AND subject_hash = ? AND state = 'converted' ORDER BY updated_at DESC, id DESC LIMIT 20").bind(input.shop.id, input.identity.subjectHash).all<{ id: string }>();
    for (const legacy of legacyCarts.results) {
      const snapshot = await readTelegramCartLines(input.env, input.shop, legacy.id);
      if ((await checkoutSnapshotFingerprint(input.env, input.shop, snapshot)).requestHash === existing.checkoutRequestHash) return snapshot;
    }
    return null;
  }
  if (input.quotedCartId !== undefined) {
    const quotedCart = await input.env.PLATFORM_DB.prepare(`
      SELECT 1 AS found
      FROM carts
      WHERE id = ? AND shop_id = ? AND channel = 'telegram' AND subject_hash = ?
      LIMIT 1
    `).bind(input.quotedCartId, input.shop.id, input.identity.subjectHash).first<{ found: number }>();
    return quotedCart === null ? null : readTelegramCartLines(input.env, input.shop, input.quotedCartId);
  }
  return loadTelegramCartLines(input.env, input.shop, input.identity);
}

function assertTelegramCheckoutContext(context: CommerceContext, input: { customerId: string; connectionId: string | null; shop: TelegramCheckoutShop }): void {
  if (context.shopId !== input.shop.id || context.channel.code !== TELEGRAM_CHANNEL_CODE || context.channel.connectionId !== input.connectionId) throw new AppError("commerce_context_mismatch", 403, ["telegram_channel_required"]);
  if (context.actor.kind !== "customer" || context.actor.customerId !== input.customerId) throw new AppError("commerce_context_mismatch", 403, ["telegram_customer_required"]);
}

async function calculateTelegramDiscount(env: AppBindings, shop: TelegramCheckoutShop, code: string | null, subtotal: number): Promise<number> {
  return calculateCartDiscountMinor({ code, env, shop, subtotalMinor: subtotal });
}

export class TelegramCheckoutOrderPort implements CommercePort {
  constructor(private readonly input: {
    connectionId: string | null;
    env: AppBindings;
    expectedIdempotencyKey: string;
    identity: TelegramCheckoutIdentity;
    requestedSnapshot: TelegramCartSnapshot | null;
    shop: TelegramCheckoutShop;
    updateId: number;
  }) {}

  async checkoutCart(input: { command: CommerceCheckoutCommand; context: CommerceContext }): Promise<CommerceCheckoutView> {
    assertTelegramCheckoutContext(input.context, { connectionId: this.input.connectionId, customerId: this.input.identity.customerId, shop: this.input.shop });
    assertSubscriptionAllows({ currentPeriodEnd: this.input.shop.currentPeriodEnd, graceEndsAt: this.input.shop.graceEndsAt, subscriptionState: this.input.shop.subscriptionState, trialEndsAt: this.input.shop.trialEndsAt });
    assertCheckoutAllowed({ shopStatus: this.input.shop.status, subscriptionState: this.input.shop.subscriptionState });
    const command = input.command;
    let snapshot = this.input.requestedSnapshot;
    if (snapshot === null) throw new AppError("cart_empty", 409);
    if (command.customerEmail !== null || command.cart.access.kind !== "principal" || command.cart.cartId !== snapshot.cartId || command.idempotencyKey !== this.input.expectedIdempotencyKey) {
      throw new AppError("commerce_context_mismatch", 403, ["telegram_checkout_required"]);
    }
    if (command.expected.length !== snapshot.lines.length || snapshot.lines.some((line) => {
      const expected = command.expected.find((item) => item.variantId === line.variantId);
      return expected === undefined || expected.quantity !== line.quantity || expected.unitPriceMinor !== line.priceMinor || expected.variantVersion !== line.version;
    })) throw new AppError("checkout_changed", 409);
    if (snapshot.lines.length === 0) throw new AppError("cart_empty", 409);
    if (command.quoteEvidence === undefined) throw new AppError("quote_invalid", 409);
    const quoteEvidence = command.quoteEvidence;
    let fingerprint = await checkoutSnapshotFingerprint(this.input.env, this.input.shop, snapshot);
    const requestHash = fingerprint.requestHash;
    const cart = await this.input.env.PLATFORM_DB.prepare("SELECT expires_at AS expiresAt FROM carts WHERE id = ? AND shop_id = ? AND channel = 'telegram' AND subject_hash = ? LIMIT 1").bind(snapshot.cartId, this.input.shop.id, this.input.identity.subjectHash).first<{ expiresAt: string }>();
    if (cart === null) throw new AppError("cart_not_found", 404);
    const verifySnapshotQuote = async (currentSnapshot: TelegramCartSnapshot): Promise<void> => {
      const currentFingerprint = await checkoutSnapshotFingerprint(this.input.env, this.input.shop, currentSnapshot);
      await verifyQuoteEvidence({
        cartId: currentSnapshot.cartId,
        cartExpiresAt: cart.expiresAt,
        catalog: currentSnapshot.lines.map((line) => ({
          productVersion: line.productVersion,
          quantity: line.quantity,
          unitPriceMinor: line.priceMinor,
          variantId: line.variantId,
          variantVersion: line.version,
        })),
        evidence: quoteEvidence,
        expected: command.expected,
        pricing: { discountCode: currentSnapshot.discountCode, discountMinor: currentFingerprint.discountMinor, totalMinor: currentFingerprint.totalMinor },
        requireCatalog: true,
        secret: this.input.env.IDENTIFIER_HMAC_SECRET,
        shopId: this.input.shop.id,
      });
    };
    const recoverReplay = async (): Promise<CommerceCheckoutView | null> => {
      const replay = await this.input.env.PLATFORM_DB.prepare(`
        SELECT orders.public_id AS orderId, orders.order_number AS orderNumber,
          orders.status, orders.payment_status AS paymentStatus,
          orders.fulfillment_status AS fulfillmentStatus,
          orders.total_minor AS totalMinor, orders.currency,
          orders.expires_at AS expiresAt,
          orders.checkout_request_hash AS requestHash,
          orders.customer_id AS customerId,
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
      `).bind(this.input.shop.id, this.input.expectedIdempotencyKey).first<{
        channelCode: string | null;
        adapterVersion: number | null;
        connectionId: string | null;
        currency: string;
        customerId: string | null;
        expiresAt: string;
        fulfillmentStatus: string;
        orderId: string;
        orderNumber: string;
        paymentStatus: string;
        requestHash: string | null;
        sourceChannel: string;
        status: string;
        totalMinor: number;
      }>();
      if (replay === null) return null;
      if (
        replay.customerId !== this.input.identity.customerId
        || replay.sourceChannel !== TELEGRAM_ORDER_ATTRIBUTION.legacySourceChannel
        || replay.channelCode !== TELEGRAM_ORDER_ATTRIBUTION.channelCode
        || replay.adapterVersion !== TELEGRAM_ORDER_ATTRIBUTION.adapterVersion
        || replay.connectionId !== this.input.connectionId
      ) throw new AppError("idempotency_conflict", 409);
      if (replay.requestHash !== requestHash) throw new AppError("idempotency_conflict", 409);
      return { access: { kind: "principal" }, currency: replay.currency, expiresAt: replay.expiresAt, fulfillmentStatus: replay.fulfillmentStatus, orderId: replay.orderId, orderNumber: replay.orderNumber, paymentStatus: replay.paymentStatus, status: replay.status, totalMinor: replay.totalMinor };
    };
    const existing = await recoverReplay();
    if (existing !== null) return existing;
    // Durable replay wins before quote freshness checks. A converted cart can
    // no longer reproduce the original catalog rows, but an identical
    // idempotency request must still recover its already-created order.
    await verifySnapshotQuote(snapshot);
    const activeCart = await this.input.env.PLATFORM_DB.prepare("SELECT 1 AS active FROM carts WHERE id = ? AND shop_id = ? AND channel = 'telegram' AND subject_hash = ? AND state = 'active' AND expires_at > ? LIMIT 1").bind(snapshot.cartId, this.input.shop.id, this.input.identity.subjectHash, new Date().toISOString()).first<{ active: number }>();
    if (activeCart === null) {
      const replay = await recoverReplay();
      if (replay !== null) return replay;
      throw new AppError("checkout_changed", 409);
    }
    const currentSnapshot = await readTelegramCartLines(this.input.env, this.input.shop, snapshot.cartId);
    const currentFingerprint = await checkoutSnapshotFingerprint(this.input.env, this.input.shop, currentSnapshot);
    if (currentFingerprint.requestHash !== requestHash) {
      const replay = await recoverReplay();
      if (replay !== null) return replay;
      throw new AppError("checkout_changed", 409);
    }
    snapshot = currentSnapshot;
    fingerprint = currentFingerprint;
    await verifySnapshotQuote(snapshot);
    try {
      for (const line of snapshot.lines) {
        if (line.status !== "active" || line.productStatus !== "active" || line.currency !== this.input.shop.currency || line.quantity < line.minPerOrder || line.quantity > line.maxPerOrder) throw new AppError("catalog_changed", 409);
        if (line.fulfillmentType === "license_key" && line.availableStock < line.quantity) throw new AppError("inventory_unavailable", 409);
      }
    } catch (error) {
      const replay = await recoverReplay();
      if (replay !== null) return replay;
      throw error;
    }
    const subtotal = fingerprint.subtotalMinor;
    const discount = fingerprint.discountMinor;
    const total = fingerprint.totalMinor;
    // Keep unsupported paid currencies out of orders and inventory. Free
    // checkouts remain provider-independent and may proceed.
    if (total > 0 && this.input.shop.currency !== "VND") throw new AppError("payment_currency_unsupported", 409);
    const orderId = createId("ord");
    const orderPublicId = createId("order");
    const reservationToken = createOpaqueToken();
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.input.shop.orderExpiryMinutes * 60_000).toISOString();
    const orderToken = await hmacToken(this.input.env.IDENTIFIER_HMAC_SECRET, `telegram-order-token:${this.input.shop.id}`, `${this.input.identity.integrationId}:${String(this.input.updateId)}`);
    const orderTokenHash = await hmacToken(this.input.env.IDENTIFIER_HMAC_SECRET, "order-access", orderToken);
    try {
      const result = await executeCanonicalCheckoutTransaction({
        cartId: snapshot.cartId,
        cartSnapshot: { discountCode: snapshot.discountCode },
        channel: { code: TELEGRAM_CHANNEL_CODE, connectionId: this.input.connectionId },
        checkoutRequestHash: requestHash,
        checkoutSubjectHash: this.input.expectedIdempotencyKey,
        currency: this.input.shop.currency,
        customer: { customerId: this.input.identity.customerId, kind: "existing", maskedEmail: null },
        discountMinor: discount,
        effects: {
          afterCartConversion: [this.input.env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO telegram_actions (id, shop_id, integration_id, update_id, action_kind, result_reference, created_at) VALUES (?, ?, ?, ?, 'checkout', ?, ?)").bind(createId("tga"), this.input.shop.id, this.input.identity.integrationId, this.input.updateId, orderId, nowIso)],
          // `order.paid` is delivered by the domain delivery queue. Keep one
          // notification authority and do not enqueue the legacy outbox.
        },
        env: this.input.env,
        eventIdempotencyKey: this.input.expectedIdempotencyKey,
        expiresAt,
        fulfillmentIdempotencyPrefix: "telegram-free",
        lines: snapshot.lines.map((line) => ({
          fulfillmentType: line.fulfillmentType,
          priceMinor: line.priceMinor,
          productId: line.productId,
          productTitle: line.productTitle,
          productVersion: line.productVersion,
          quantity: line.quantity,
          sku: line.sku,
          title: line.title,
          variantId: line.variantId,
          variantVersion: line.version,
        })),
        locale: this.input.shop.defaultLocale,
        nowIso,
        orderId,
        orderPublicId,
        orderTokenHash,
        reservationToken,
        shopId: this.input.shop.id,
        subtotalMinor: subtotal,
        totalMinor: total,
      });
      return { access: { kind: "principal" }, ...result };
    } catch (error) {
      const replay = await recoverReplay();
      if (replay !== null) return replay;
      if (error instanceof AppError) throw error;
      const cartState = await this.input.env.PLATFORM_DB.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ? LIMIT 1").bind(snapshot.cartId, this.input.shop.id).first<{ state: string }>();
      if (cartState?.state === "active") {
        try {
          const currentSnapshot = await readTelegramCartLines(this.input.env, this.input.shop, snapshot.cartId);
          if ((await checkoutSnapshotFingerprint(this.input.env, this.input.shop, currentSnapshot)).requestHash !== requestHash) throw new AppError("checkout_changed", 409);
          for (const line of snapshot.lines) {
            const current = await loadVariant(this.input.env, this.input.shop.id, line.variantId);
            if (current.currency !== this.input.shop.currency || line.quantity < current.minPerOrder || line.quantity > current.maxPerOrder) throw new AppError("catalog_changed", 409);
            if (current.priceMinor !== line.priceMinor || current.productVersion !== line.productVersion || current.version !== line.version) throw new AppError("checkout_changed", 409);
            if (current.fulfillmentType === "license_key" && current.availableStock < line.quantity) throw new AppError("inventory_unavailable", 409);
          }
        } catch (availabilityError) {
          if (availabilityError instanceof AppError) throw availabilityError;
        }
      }
      throw new AppError("checkout_failed", 409);
    }
  }

  async getOrder(input: { command: { order: CommerceOrderReference }; context: CommerceContext }): Promise<CommerceOrderView> {
    assertTelegramCheckoutContext(input.context, { connectionId: this.input.connectionId, customerId: this.input.identity.customerId, shop: this.input.shop });
    if (input.command.order.access.kind !== "principal") throw new AppError("commerce_context_mismatch", 403, ["principal_access_required"]);
    const row = await this.input.env.PLATFORM_DB.prepare(`
      SELECT orders.id, orders.public_id AS orderId,
        orders.order_number AS orderNumber, orders.status,
        orders.payment_status AS paymentStatus,
        orders.fulfillment_status AS fulfillmentStatus,
        orders.total_minor AS totalMinor, orders.currency,
        orders.expires_at AS expiresAt
      FROM orders
      INNER JOIN order_channel_attributions
        ON order_channel_attributions.shop_id = orders.shop_id
        AND order_channel_attributions.order_id = orders.id
        AND order_channel_attributions.channel_code = ?
        AND order_channel_attributions.adapter_version = ?
        AND order_channel_attributions.connection_id IS ?
      WHERE orders.public_id = ? AND orders.shop_id = ?
        AND orders.customer_id = ? AND orders.source_channel = ?
      LIMIT 1
    `).bind(
      TELEGRAM_ORDER_ATTRIBUTION.channelCode,
      TELEGRAM_ORDER_ATTRIBUTION.adapterVersion,
      this.input.connectionId,
      input.command.order.orderId,
      this.input.shop.id,
      this.input.identity.customerId,
      TELEGRAM_ORDER_ATTRIBUTION.legacySourceChannel,
    ).first<{ currency: string; expiresAt: string; fulfillmentStatus: string; id: string; orderNumber: string; paymentStatus: string; status: string; totalMinor: number }>();
    if (row === null) throw new AppError("order_not_found", 404);
    const items = await this.input.env.PLATFORM_DB.prepare("SELECT product_title AS productTitle, variant_title AS variantTitle, quantity, line_total_minor AS lineTotalMinor, fulfillment_type AS fulfillmentType FROM order_items WHERE order_id = ? AND shop_id = ? ORDER BY id").bind(row.id, this.input.shop.id).all<{ fulfillmentType: string; lineTotalMinor: number; productTitle: string; quantity: number; variantTitle: string }>();
    return { currency: row.currency, expiresAt: row.expiresAt, fulfillmentStatus: row.fulfillmentStatus, items: items.results, orderNumber: row.orderNumber, paymentStatus: row.paymentStatus, status: row.status, totalMinor: row.totalMinor };
  }

  async listOrders(input: { command: CommerceListOrdersCommand; context: CommerceContext }): Promise<CommerceListOrdersView> {
    assertTelegramCheckoutContext(input.context, { connectionId: this.input.connectionId, customerId: this.input.identity.customerId, shop: this.input.shop });
    return listTelegramOrders(this.input.env, this.input.shop.id, this.input.identity.customerId, this.input.connectionId);
  }
}

export function createTelegramCheckoutApplication(input: {
  connectionId: string | null;
  env: AppBindings;
  expectedIdempotencyKey: string;
  identity: TelegramCheckoutIdentity;
  paymentFulfillment?: CommercePaymentFulfillmentApplication;
  requestedSnapshot: TelegramCartSnapshot | null;
  shop: TelegramCheckoutShop;
  updateId: number;
}): CommerceApplicationService {
  return new CommerceApplicationService(new TelegramCheckoutOrderPort(input), input.paymentFulfillment);
}

export function createTelegramOrderApplication(input: {
  connectionId: string | null;
  env: AppBindings;
  identity: TelegramCheckoutIdentity;
  paymentFulfillment?: CommercePaymentFulfillmentApplication;
  shop: TelegramCheckoutShop;
  updateId: number;
}): CommerceApplicationService {
  return new CommerceApplicationService(new TelegramCheckoutOrderPort({ ...input, expectedIdempotencyKey: "telegram-order-access-0001", requestedSnapshot: null }), input.paymentFulfillment);
}

export async function listTelegramOrders(env: AppBindings, shopId: string, customerId: string, connectionId: string | null): Promise<TelegramOrderSummary[]> {
  const result = await env.PLATFORM_DB.prepare(`
    SELECT orders.public_id AS orderId, orders.order_number AS orderNumber,
      orders.status, orders.payment_status AS paymentStatus,
      orders.fulfillment_status AS fulfillmentStatus,
      orders.total_minor AS totalMinor, orders.currency
    FROM orders
    INNER JOIN order_channel_attributions
      ON order_channel_attributions.shop_id = orders.shop_id
      AND order_channel_attributions.order_id = orders.id
      AND order_channel_attributions.channel_code = ?
      AND order_channel_attributions.adapter_version = ?
      AND order_channel_attributions.connection_id IS ?
    WHERE orders.shop_id = ? AND orders.customer_id = ?
      AND orders.source_channel = ?
    ORDER BY orders.created_at DESC, orders.id DESC
    LIMIT 10
  `).bind(
    TELEGRAM_ORDER_ATTRIBUTION.channelCode,
    TELEGRAM_ORDER_ATTRIBUTION.adapterVersion,
    connectionId,
    shopId,
    customerId,
    TELEGRAM_ORDER_ATTRIBUTION.legacySourceChannel,
  ).all<TelegramOrderSummary>();
  return result.results;
}
