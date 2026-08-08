import { hmacToken } from "../core/crypto";
import { subscriptionAllows } from "../billing/entitlements";
import { CommerceApplicationService } from "../commerce/application";
import { createTelegramCartProjectionPort, type CommerceCartProjection } from "../commerce/cart-projection";
import type { CommerceContext, CommercePaymentFulfillmentApplication } from "../commerce/contracts";
import { CommercePaymentFulfillmentService, createTelegramPaymentFulfillmentApplication, PrincipalPaymentFulfillmentPort } from "../commerce/payment-fulfillment";
import {
  createTelegramCheckoutApplication,
  createTelegramCheckoutApplicationKey,
  createTelegramCartMutationApplicationKey,
  loadTelegramQuoteAction,
  persistTelegramQuoteAction,
  resolveTelegramCheckoutSnapshot,
  TelegramCartMutationPort,
} from "../commerce/telegram-port";
import { resolveActiveEncryptionKey } from "../crypto/keyring";
import { builtInChannelRegistry, TELEGRAM_CHANNEL_CODE } from "../channels/builtins";
import { D1ChannelConnectionRepository } from "../channels/store";
import type { ChannelCapability } from "../channels/types";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import { isSupportedCurrency } from "../i18n/currency";
import { matchSupportedLocale, type SupportedLocale } from "../i18n/locale";
import { createOrRecoverPrincipalPaymentHandoff } from "../payments/store";
import type { AppBindings } from "../platform/bindings";
import { assertCheckoutAllowed, hasFeature } from "../tenants/policy";
import { encryptTelegramChatId } from "./crypto";
import { normalizeDiscountCode } from "./policy";
import type { TelegramInlineKeyboard, TelegramUpdate, TelegramUser } from "./types";
import { formatTelegramMoney, formatTelegramTimestamp, resolveTelegramLocale, telegramStatus, telegramText, TELEGRAM_CATALOG } from "./localization";

export type TelegramShop = {
  currency: string;
  defaultLocale: string;
  id: string;
  name: string;
  orderExpiryMinutes: number;
  origin: string;
  status: string;
  subscriptionState: string;
  trialEndsAt?: string | null;
  graceEndsAt?: string | null;
};

export type TelegramIdentity = {
  chatId: string;
  customerId: string;
  identityId: string;
  subjectHash: string;
};

type StoredTelegramIdentity = {
  customerId: string;
  identityId: string;
  languageCode: string | null;
  preferredLocale: string | null;
  verifiedAt: string | null;
};

export type TelegramOrderSummary = { currency: string; fulfillmentStatus: string; orderId: string; orderNumber: string; paymentStatus: string; status: string; totalMinor: number };
type OrderSummary = TelegramOrderSummary;

async function resolveTelegramConnectionId(
  env: AppBindings,
  integrationId: string,
  shopId: string,
): Promise<string | null> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT telegram_integrations.channel_connection_id AS linkedConnectionId,
      channel_connections.id AS connectionId
    FROM telegram_integrations
    LEFT JOIN channel_connections
      ON channel_connections.id = telegram_integrations.channel_connection_id
      AND channel_connections.shop_id = telegram_integrations.shop_id
      AND channel_connections.provider_code = 'telegram'
      AND channel_connections.status IN ('active', 'degraded')
    WHERE telegram_integrations.id = ? AND telegram_integrations.shop_id = ?
    LIMIT 1
  `).bind(integrationId, shopId).first<{ connectionId?: string | null; linkedConnectionId?: string | null }>();
  if (row === null) throw new AppError("telegram_not_configured", 409);
  if (row.linkedConnectionId !== null && row.linkedConnectionId !== undefined && (row.connectionId === null || row.connectionId === undefined)) {
    throw new AppError("telegram_not_configured", 409);
  }
  return row.connectionId ?? null;
}

const TELEGRAM_BASE_CAPABILITIES = [
  "conversation.inbound",
  "conversation.outbound",
  "identity.private",
  "message.rich_ui",
] as const satisfies readonly ChannelCapability[];

function requiredTelegramCapabilities(update: TelegramUpdate): readonly ChannelCapability[] {
  const required = new Set<ChannelCapability>(TELEGRAM_BASE_CAPABILITIES);
  if (update.kind === "unsupported_callback_query") return [...required];
  if (update.kind === "callback_query") {
    if (update.data.startsWith("add:") || update.data === "cart" || update.data === "buy" || update.data.startsWith("buy:")) {
      required.add("cart.interactive");
    }
    if (update.data.startsWith("buy:") || update.data.startsWith("pay:")) {
      required.add("checkout.external_link");
    }
    if (update.data.startsWith("key:")) required.add("fulfillment.inline_secret");
    return [...required];
  }

  const [rawCommand = ""] = update.text.trim().split(/\s+/u);
  const command = rawCommand.toLowerCase().replace(/@[a-z0-9_]+$/u, "");
  if (command === "/products" || command === "/shop") required.add("catalog.read");
  if (command === "/cart" || command === "/discount") required.add("cart.interactive");
  if (command === "/keys") required.add("fulfillment.inline_secret");
  return [...required];
}

async function loadTelegramEffectiveCapabilities(input: {
  env: AppBindings;
  connectionId: string | null;
  shopId: string;
}): Promise<ReadonlySet<ChannelCapability>> {
  // A linked Telegram integration without a live generic connection is not
  // eligible for commerce. This preserves the legacy lifecycle gate while
  // making the normalized projection authoritative for command access.
  if (input.connectionId === null) throw new AppError("telegram_not_configured", 409);

  const plan = await input.env.PLATFORM_DB.prepare(`
    SELECT plans.feature_flags_json AS featureFlagsJson,
      plans.is_active AS planActive,
      shop_subscriptions.state AS subscriptionState,
      shop_subscriptions.trial_ends_at AS trialEndsAt,
      shop_subscriptions.grace_ends_at AS graceEndsAt
    FROM shop_subscriptions
    INNER JOIN plans ON plans.id = shop_subscriptions.plan_id
    WHERE shop_subscriptions.shop_id = ?
      AND shop_subscriptions.id = (
        SELECT latest.id
        FROM shop_subscriptions AS latest
        WHERE latest.shop_id = shop_subscriptions.shop_id
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT 1
      )
    LIMIT 1
  `).bind(input.shopId).first<{ featureFlagsJson: string; graceEndsAt: string | null; planActive: number; subscriptionState: string; trialEndsAt: string | null }>();
  const adapterCapabilities = new Set<ChannelCapability>(builtInChannelRegistry.require(TELEGRAM_CHANNEL_CODE).capabilities);
  const planEntitlements = plan !== null && hasFeature(plan.featureFlagsJson, "telegram")
    ? adapterCapabilities
    : new Set<ChannelCapability>();
  const policyAllowsCommerce = plan !== null
    && plan.planActive === 1
    && subscriptionAllows({ graceEndsAt: plan.graceEndsAt, subscriptionState: plan.subscriptionState, trialEndsAt: plan.trialEndsAt });
  const projection = await new D1ChannelConnectionRepository(input.env.PLATFORM_DB, builtInChannelRegistry).projectCapabilities({
    connectionId: input.connectionId,
    planEntitlements,
    policyBlockedCapabilities: policyAllowsCommerce ? new Set<ChannelCapability>() : adapterCapabilities,
    shopId: input.shopId,
  });
  return projection.capabilities;
}

function requireTelegramCapabilities(
  capabilities: ReadonlySet<ChannelCapability>,
  required: readonly ChannelCapability[],
): void {
  for (const capability of required) {
    if (!capabilities.has(capability)) {
      throw new AppError("channel_capability_unavailable", 403, [capability]);
    }
  }
}

export type TelegramReply = {
  keyboard?: TelegramInlineKeyboard;
  protectContent?: boolean;
  text: string;
};

function displayHandle(user: TelegramUser): string {
  if (user.username !== null) return `@${user.username}`;
  return `${user.firstName}${user.lastName === null ? "" : ` ${user.lastName}`}`.slice(0, 120);
}

export async function loadTelegramShop(env: AppBindings, shopId: string): Promise<TelegramShop> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT shops.id, shops.name, shops.status, shops.default_locale AS defaultLocale, shops.currency,
      shop_settings.order_expiry_minutes AS orderExpiryMinutes,
      shop_subscriptions.state AS subscriptionState,
      shop_subscriptions.trial_ends_at AS trialEndsAt,
      shop_subscriptions.grace_ends_at AS graceEndsAt,
      canonical_domain.hostname_normalized AS hostname
    FROM shops
    INNER JOIN shop_settings ON shop_settings.shop_id = shops.id
    INNER JOIN shop_subscriptions ON shop_subscriptions.shop_id = shops.id AND shop_subscriptions.state != 'canceled'
    INNER JOIN plans ON plans.id = shop_subscriptions.plan_id
    INNER JOIN shop_domains AS canonical_domain
      ON canonical_domain.id = shops.canonical_domain_id
      AND canonical_domain.shop_id = shops.id
      AND canonical_domain.status = 'active'
      AND (
        canonical_domain.type = 'platform_subdomain'
        OR canonical_domain.ownership_verified_at IS NOT NULL
      )
    WHERE shops.id = ?
    LIMIT 1
  `).bind(shopId).first<Omit<TelegramShop, "origin"> & { hostname: string }>();
  if (row === null) throw new AppError("tenant_not_found", 404);
  if (!subscriptionAllows({ graceEndsAt: row.graceEndsAt, subscriptionState: row.subscriptionState, trialEndsAt: row.trialEndsAt })) {
    throw new AppError("subscription_required", 402);
  }
  assertCheckoutAllowed({ shopStatus: row.status, subscriptionState: row.subscriptionState });
  return { ...row, origin: `https://${row.hostname}` };
}

async function findStoredIdentity(input: { env: AppBindings; shopId: string; subjectHash: string }): Promise<StoredTelegramIdentity | null> {
  return input.env.PLATFORM_DB.prepare(`
    SELECT customer_identities.id AS identityId,
      customer_identities.customer_id AS customerId,
      customer_identities.language_code AS languageCode,
      customer_identities.verified_at AS verifiedAt,
      shop_customers.preferred_locale AS preferredLocale
    FROM customer_identities
    INNER JOIN shop_customers
      ON shop_customers.id = customer_identities.customer_id
      AND shop_customers.shop_id = customer_identities.shop_id
    WHERE customer_identities.shop_id = ?
      AND customer_identities.provider = 'telegram'
      AND customer_identities.external_subject = ?
    LIMIT 1
  `).bind(input.shopId, input.subjectHash).first<StoredTelegramIdentity>();
}

async function loadStoredIdentity(input: { env: AppBindings; shopId: string; userId: number }): Promise<{ identity: StoredTelegramIdentity | null; subjectHash: string }> {
  const subjectHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, `telegram-user:${input.shopId}`, String(input.userId));
  const identity = await findStoredIdentity({ env: input.env, shopId: input.shopId, subjectHash });
  return { identity, subjectHash };
}

async function ensureIdentity(input: {
  chatId: number;
  env: AppBindings;
  identityHint: StoredTelegramIdentity | null;
  integrationId: string;
  locale: SupportedLocale;
  observedLanguage: SupportedLocale | null;
  shop: TelegramShop;
  subjectHash: string;
  user: TelegramUser;
}): Promise<TelegramIdentity> {
  let identity = input.identityHint;
  const now = new Date().toISOString();
  if (identity === null) {
    const customerId = createId("cus");
    const identityId = createId("cid");
    try {
      await input.env.PLATFORM_DB.batch([
        input.env.PLATFORM_DB.prepare(`INSERT INTO shop_customers (id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, 'active', ?, ?)`).bind(customerId, input.shop.id, displayHandle(input.user), input.locale, now, now),
        input.env.PLATFORM_DB.prepare(`INSERT INTO customer_identities (id, shop_id, customer_id, provider, external_subject, display_handle_sanitized, language_code, verified_at, created_at, updated_at) VALUES (?, ?, ?, 'telegram', ?, ?, ?, ?, ?, ?)`).bind(identityId, input.shop.id, customerId, input.subjectHash, displayHandle(input.user), input.observedLanguage, now, now, now),
      ]);
      identity = { customerId, identityId, languageCode: input.observedLanguage, preferredLocale: null, verifiedAt: now };
    } catch {
      identity = await findStoredIdentity({ env: input.env, shopId: input.shop.id, subjectHash: input.subjectHash });
      if (identity === null) throw new AppError("telegram_identity_failed", 409);
    }
  }
  const activeKey = resolveActiveEncryptionKey(input.env, "credential");
  const encrypted = await encryptTelegramChatId({ chatId: String(input.chatId), hmacSecret: input.env.IDENTIFIER_HMAC_SECRET, identityId: identity.identityId, integrationId: input.integrationId, kek: activeKey.kek, keyVersion: activeKey.version, shopId: input.shop.id });
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE shop_customers SET locale = ?, updated_at = ? WHERE id = ? AND shop_id = ?").bind(input.locale, now, identity.customerId, input.shop.id),
    input.env.PLATFORM_DB.prepare("UPDATE customer_identities SET display_handle_sanitized = ?, language_code = COALESCE(?, language_code), verified_at = ?, updated_at = ? WHERE id = ? AND shop_id = ?").bind(displayHandle(input.user), input.observedLanguage, now, now, identity.identityId, input.shop.id),
    input.env.PLATFORM_DB.prepare(`INSERT INTO telegram_recipients (id, shop_id, integration_id, customer_identity_id, key_version, chat_id_ciphertext_b64, chat_id_iv_b64, status, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?) ON CONFLICT(integration_id, customer_identity_id) DO UPDATE SET key_version = excluded.key_version, chat_id_ciphertext_b64 = excluded.chat_id_ciphertext_b64, chat_id_iv_b64 = excluded.chat_id_iv_b64, status = 'active', last_safe_error_code = NULL, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`).bind(createId("tgr"), input.shop.id, input.integrationId, identity.identityId, activeKey.version, encrypted.ciphertextB64, encrypted.ivB64, now, now, now),
  ]);
  return { chatId: String(input.chatId), customerId: identity.customerId, identityId: identity.identityId, subjectHash: input.subjectHash };
}

async function persistTelegramLocalePreference(input: {
  customerId: string;
  env: AppBindings;
  locale: SupportedLocale;
  shopId: string;
}): Promise<void> {
  const result = await input.env.PLATFORM_DB.prepare(`
    UPDATE shop_customers
    SET preferred_locale = ?, locale = ?, updated_at = ?
    WHERE id = ? AND shop_id = ?
  `).bind(input.locale, input.locale, new Date().toISOString(), input.customerId, input.shopId).run();
  if (result.meta.changes !== 1) throw new AppError("telegram_identity_failed", 409);
}

async function loadCartLines(env: AppBindings, shop: TelegramShop, identity: TelegramIdentity): Promise<CommerceCartProjection> {
  return createTelegramCartProjectionPort({ env, identity, shop }).readCart();
}

async function cartReply(application: CommerceApplicationService, context: CommerceContext, env: AppBindings, shop: TelegramShop, identity: TelegramIdentity, integrationId: string, updateId: number, locale: SupportedLocale): Promise<TelegramReply> {
  const cart = await loadCartLines(env, shop, identity);
  if (cart.cartId === null || cart.itemCount === 0) return { keyboard: [[{ callback_data: "menu", text: telegramText(locale, "button.menu") }]], text: telegramText(locale, "cart.empty") };
  const quote = await application.quoteCart(context, { cart: { access: { kind: "principal" }, cartId: cart.cartId } });
  await persistTelegramQuoteAction({ cartId: cart.cartId, discountCode: cart.discountCode, env, identity, integrationId, quote, shop, updateId });
  const lines = quote.items.map((line, index) => telegramText(locale, "cart.line", {
    index: index + 1,
    product: line.productTitle,
    quantity: line.quantity,
    total: formatTelegramMoney(line.lineTotalMinor, quote.currency, locale),
    variant: line.variantTitle,
  }));
  const checkoutCallback = `buy:${String(updateId)}`;
  if (checkoutCallback.length > 64) throw new AppError("telegram_callback_too_large", 500);
  return {
    keyboard: [[{ callback_data: checkoutCallback, text: telegramText(locale, "button.checkout") }], [{ callback_data: "menu", text: telegramText(locale, "button.menu") }]],
    text: [
      telegramText(locale, "cart.heading", { shop: shop.name }),
      ...lines,
      telegramText(locale, "cart.subtotal", { total: formatTelegramMoney(quote.subtotalMinor, quote.currency, locale) }),
      ...(cart.discountCode === null ? [] : [telegramText(locale, "cart.discount", { code: cart.discountCode })]),
    ].join("\n"),
  };
}

async function catalogReply(env: AppBindings, shop: TelegramShop, locale: SupportedLocale): Promise<TelegramReply> {
  const privateFileSchema = await env.PLATFORM_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'product_fulfillment_policies' LIMIT 1").first<{ name: string }>();
  const privateFileGuard = privateFileSchema === null ? "" : "AND NOT EXISTS (SELECT 1 FROM product_fulfillment_policies AS private_policy WHERE private_policy.shop_id = products.shop_id AND private_policy.product_id = products.id AND private_policy.capability = 'private_file' AND private_policy.status = 'active')";
  const result = await env.PLATFORM_DB.prepare(`SELECT products.title AS productTitle, product_variants.id AS variantId, product_variants.title AS variantTitle, product_variants.price_minor AS priceMinor, product_variants.currency, products.fulfillment_type AS fulfillmentType, COUNT(CASE WHEN inventory_keys.status = 'available' THEN 1 END) AS availableStock FROM products INNER JOIN catalog_channel_visibility ON catalog_channel_visibility.shop_id = products.shop_id AND catalog_channel_visibility.product_id = products.id AND catalog_channel_visibility.channel_code = 'telegram' AND catalog_channel_visibility.status = 'visible' INNER JOIN product_variants ON product_variants.product_id = products.id AND product_variants.shop_id = products.shop_id AND product_variants.status = 'active' LEFT JOIN inventory_keys ON inventory_keys.shop_id = product_variants.shop_id AND inventory_keys.variant_id = product_variants.id WHERE products.shop_id = ? AND products.status = 'active' AND product_variants.currency = ? ${privateFileGuard} GROUP BY product_variants.id ORDER BY products.created_at, product_variants.created_at LIMIT 12`).bind(shop.id, shop.currency).all<{ availableStock: number; currency: string; fulfillmentType: string; priceMinor: number; productTitle: string; variantId: string; variantTitle: string }>();
  // Do not render legacy/invalid currencies even if a shop row predates the
  // supported-currency guard; formatting an unknown currency would throw from
  // the webhook boundary.
  const available = result.results.filter((row) => isSupportedCurrency(row.currency) && (row.fulfillmentType !== "license_key" || row.availableStock > 0));
  if (available.length === 0) return { keyboard: [[{ callback_data: "menu", text: telegramText(locale, "button.menu") }]], text: telegramText(locale, "catalog.empty", { shop: shop.name }) };
  return {
    keyboard: [...available.map((row) => [{ callback_data: `add:${row.variantId}`, text: telegramText(locale, "button.addProduct", { product: row.productTitle.slice(0, 28) }) }]), [{ callback_data: "cart", text: telegramText(locale, "button.viewCart") }]],
    text: [telegramText(locale, "catalog.heading", { shop: shop.name }), ...available.map((row, index) => telegramText(locale, "catalog.line", {
      index: index + 1,
      price: formatTelegramMoney(row.priceMinor, row.currency, locale),
      product: row.productTitle,
      variant: row.variantTitle,
    }))].join("\n"),
  };
}

async function createTelegramCartApplication(input: { connectionId: string | null; env: AppBindings; identity: TelegramIdentity; integrationId: string; shop: TelegramShop; updateId: number }): Promise<{ application: CommerceApplicationService; context: CommerceContext; idempotencyKey: string }> {
  const idempotencyKey = await createTelegramCartMutationApplicationKey(input.env, input.shop.id, input.integrationId, input.updateId);
  const context: CommerceContext = {
    actor: { customerId: input.identity.customerId, kind: "customer" },
    channel: { code: TELEGRAM_CHANNEL_CODE, connectionId: input.connectionId },
    locale: input.shop.defaultLocale,
    requestId: idempotencyKey,
    shopId: input.shop.id,
  };
  return {
    application: new CommerceApplicationService(new TelegramCartMutationPort({ ...input, expectedIdempotencyKey: idempotencyKey })),
    context,
    idempotencyKey,
  };
}

function createTelegramPaymentApplication(input: { env: AppBindings; fetcher?: typeof fetch; shopId: string }): CommercePaymentFulfillmentService {
  const fetcher = input.fetcher;
  if (fetcher === undefined) return createTelegramPaymentFulfillmentApplication(input.env, input.shopId);
  const dependencies = { createPaymentHandoff: (handoff: Parameters<typeof createOrRecoverPrincipalPaymentHandoff>[0]) => createOrRecoverPrincipalPaymentHandoff({ ...handoff, fetcher }) };
  return new CommercePaymentFulfillmentService(new PrincipalPaymentFulfillmentPort(input.env, input.shopId, "telegram", dependencies));
}

function principalOrder(orderPublicId: string): { access: { kind: "principal" }; orderId: string } {
  return { access: { kind: "principal" }, orderId: orderPublicId };
}

export async function checkoutTelegramCart(input: { env: AppBindings; identity: TelegramIdentity; integrationId: string; quoteUpdateId: number; shop: TelegramShop; updateId: number }): Promise<OrderSummary> {
  const checkoutKey = await createTelegramCheckoutApplicationKey(input.env, input.shop.id, input.integrationId, input.updateId);
  const connectionId = await resolveTelegramConnectionId(input.env, input.integrationId, input.shop.id);
  const quoteAction = await loadTelegramQuoteAction({ env: input.env, identity: input.identity, integrationId: input.integrationId, shopId: input.shop.id, updateId: input.quoteUpdateId });
  const snapshot = await resolveTelegramCheckoutSnapshot({ checkoutKey, connectionId, env: input.env, identity: input.identity, quotedCartId: quoteAction.cartId, shop: input.shop });
  if (snapshot === null || snapshot.lines.length === 0) throw new AppError("cart_empty", 409);
  const application = createTelegramCheckoutApplication({
    connectionId,
    env: input.env,
    expectedIdempotencyKey: checkoutKey,
    identity: { ...input.identity, integrationId: input.integrationId },
    requestedSnapshot: snapshot,
    shop: input.shop,
    updateId: input.updateId,
  });
  const view = await application.checkoutCart({
    actor: { customerId: input.identity.customerId, kind: "customer" },
    channel: { code: TELEGRAM_CHANNEL_CODE, connectionId },
    locale: input.shop.defaultLocale,
    requestId: checkoutKey,
    shopId: input.shop.id,
  }, {
    cart: { access: { kind: "principal" }, cartId: snapshot.cartId },
    customerEmail: null,
    expected: snapshot.lines.map((line) => ({ quantity: line.quantity, unitPriceMinor: line.priceMinor, variantId: line.variantId, variantVersion: line.version })),
    idempotencyKey: checkoutKey,
    quoteEvidence: quoteAction.quoteEvidence,
  });
  return {
    currency: view.currency,
    fulfillmentStatus: view.fulfillmentStatus,
    orderId: view.orderId,
    orderNumber: view.orderNumber ?? view.orderId.slice(-12).toUpperCase(),
    paymentStatus: view.paymentStatus,
    status: view.status,
    totalMinor: view.totalMinor,
  };
}
function ordersReply(orders: readonly OrderSummary[], locale: SupportedLocale): TelegramReply {
  if (orders.length === 0) return { keyboard: [[{ callback_data: "menu", text: telegramText(locale, "button.menu") }]], text: telegramText(locale, "orders.empty") };
  return {
    keyboard: [...orders.slice(0, 6).map((order) => [{ callback_data: `ord:${order.orderId}`, text: telegramText(locale, "button.order", { order: order.orderNumber }) }]), [{ callback_data: "menu", text: telegramText(locale, "button.menu") }]],
    text: orders.map((order) => telegramText(locale, "orders.line", {
      order: order.orderNumber,
      payment: telegramStatus(locale, "payment", order.paymentStatus),
      status: telegramStatus(locale, "order", order.status),
      total: formatTelegramMoney(order.totalMinor, order.currency, locale),
    })).join("\n"),
  };
}

async function orderReply(application: CommerceApplicationService, context: CommerceContext, orderPublicId: string, knownEligibility?: boolean): Promise<TelegramReply> {
  const locale = resolveTelegramLocale({ explicitPreference: context.locale });
  const order = await application.getOrder(context, { order: principalOrder(orderPublicId) });
  const keyboard: TelegramInlineKeyboard = [];
  if (order.paymentStatus === "unpaid" && order.status === "pending_payment") keyboard.push([{ callback_data: `pay:${orderPublicId}`, text: telegramText(locale, "button.paymentLink") }]);
  const eligible = knownEligibility ?? (order.paymentStatus === "paid" && (await application.getFulfillmentEligibility(context, { order: principalOrder(orderPublicId) })).eligible);
  if (eligible) keyboard.push([{ callback_data: `key:${orderPublicId}`, text: telegramText(locale, "button.viewKey") }]);
  keyboard.push([{ callback_data: "menu", text: telegramText(locale, "button.menu") }]);
  return {
    keyboard,
    text: [
      telegramText(locale, "order.heading", { order: order.orderNumber }),
      telegramText(locale, "order.total", { total: formatTelegramMoney(order.totalMinor, order.currency, locale) }),
      telegramText(locale, "order.payment", { status: telegramStatus(locale, "payment", order.paymentStatus) }),
      telegramText(locale, "order.status", { status: telegramStatus(locale, "order", order.status) }),
      telegramText(locale, "order.fulfillment", { status: telegramStatus(locale, "fulfillment", order.fulfillmentStatus) }),
    ].join("\n"),
  };
}

async function paymentReply(input: { application: CommercePaymentFulfillmentApplication; context: CommerceContext; orderPublicId: string; origin: string }): Promise<TelegramReply> {
  const locale = resolveTelegramLocale({ explicitPreference: input.context.locale });
  const link = await input.application.createPaymentHandoff(input.context, { order: principalOrder(input.orderPublicId), origin: input.origin });
  const expiresAt = formatTelegramTimestamp(link.expiresAt, locale);
  return {
    keyboard: [[{ callback_data: `pay:${input.orderPublicId}`, text: telegramText(locale, "button.refreshPayment") }], [{ callback_data: `ord:${input.orderPublicId}`, text: telegramText(locale, "button.orderStatus") }]],
    text: [
      telegramText(locale, "payment.link", { url: link.redirectUrl }),
      ...(expiresAt === null ? [] : [telegramText(locale, "payment.expires", { timestamp: expiresAt })]),
      telegramText(locale, "payment.webhookOnly"),
    ].join("\n"),
  };
}

async function keyReply(input: { application: CommercePaymentFulfillmentApplication; context: CommerceContext; orderApplication: CommerceApplicationService; orderPublicId: string }): Promise<TelegramReply> {
  const locale = resolveTelegramLocale({ explicitPreference: input.context.locale });
  const order = await input.orderApplication.getOrder(input.context, { order: principalOrder(input.orderPublicId) });
  let fulfillment;
  try {
    fulfillment = await input.application.revealFulfillment(input.context, { order: principalOrder(input.orderPublicId) });
  } catch (error) {
    if (error instanceof AppError && error.code === "order_not_ready") throw new AppError("order_not_fulfilled", 409);
    throw error;
  }
  const text = [telegramText(locale, "key.heading", { order: order.orderNumber }), ...fulfillment.items.map((row, index) => telegramText(locale, "key.line", {
    index: index + 1,
    product: row.productTitle,
    value: row.value,
    variant: row.variantTitle,
  }))].join("\n\n");
  if (text.length > 3900) throw new AppError("telegram_key_message_too_large", 409);
  return { keyboard: [[{ callback_data: `ord:${input.orderPublicId}`, text: telegramText(locale, "button.viewOrder") }]], protectContent: true, text };
}

export async function renderTelegramCheckoutResult(input: {
  context: CommerceContext;
  order: TelegramOrderSummary;
  orderApplication: CommerceApplicationService;
  origin: string;
  paymentApplication: CommercePaymentFulfillmentApplication;
}): Promise<TelegramReply> {
  if (input.order.paymentStatus !== "paid") return paymentReply({ application: input.paymentApplication, context: input.context, orderPublicId: input.order.orderId, origin: input.origin });
  const eligibility = await input.paymentApplication.getFulfillmentEligibility(input.context, { order: principalOrder(input.order.orderId) });
  return eligibility.eligible
    ? keyReply({ application: input.paymentApplication, context: input.context, orderApplication: input.orderApplication, orderPublicId: input.order.orderId })
    : orderReply(input.orderApplication, input.context, input.order.orderId, false);
}

function menuReply(shop: TelegramShop, locale: SupportedLocale): TelegramReply {
  return {
    keyboard: [[{ callback_data: "menu", text: telegramText(locale, "button.menu") }, { callback_data: "cart", text: telegramText(locale, "button.cart") }]],
    text: [
      telegramText(locale, "menu.welcome", { shop: shop.name }),
      telegramText(locale, "menu.help"),
      telegramText(locale, "menu.privateOnly"),
      telegramText(locale, "menu.prompt"),
    ].join("\n"),
  };
}

function safeErrorReply(error: AppError, locale: SupportedLocale): TelegramReply {
  const key = `error.${error.code}`;
  const catalog = TELEGRAM_CATALOG[locale];
  const message = Object.hasOwn(catalog, key) ? telegramText(locale, key) : telegramText(locale, "error.generic");
  return { keyboard: [[{ callback_data: "menu", text: telegramText(locale, "button.menu") }]], text: message };
}

export async function handleTelegramCommerce(input: { env: AppBindings; fetcher?: typeof fetch; integrationId: string; shopId: string; update: TelegramUpdate }): Promise<{ identity: TelegramIdentity; reply: TelegramReply; resultCode: string }> {
  if (input.update.kind === "unsupported_callback_query") throw new AppError("telegram_update_unsupported", 400);
  const shop = await loadTelegramShop(input.env, input.shopId);
  // Resolve the normalized projection before creating buyer, recipient or
  // commerce state. Missing, expired, unentitled or policy-disabled grants
  // therefore fail closed without changing replay or tenant binding rules.
  const connectionId = await resolveTelegramConnectionId(input.env, input.integrationId, shop.id);
  const effectiveCapabilities = await loadTelegramEffectiveCapabilities({ connectionId, env: input.env, shopId: shop.id });
  requireTelegramCapabilities(effectiveCapabilities, requiredTelegramCapabilities(input.update));
  const messageCommand = input.update.kind === "message"
    ? (() => {
        const [rawCommand = "", ...argumentsList] = input.update.text.trim().split(/\s+/u);
        return { argumentsList, command: rawCommand.toLowerCase().replace(/@[a-z0-9_]+$/u, "") };
      })()
    : null;
  const requestedLocalePreference = messageCommand?.command === "/language" && messageCommand.argumentsList.length === 1
    ? matchSupportedLocale(messageCommand.argumentsList[0])
    : null;
  const stored = await loadStoredIdentity({ env: input.env, shopId: shop.id, userId: input.update.user.id });
  const observedLanguage = matchSupportedLocale(input.update.user.languageCode);
  const identityPreference = stored.identity !== null && stored.identity.verifiedAt !== null
    ? matchSupportedLocale(stored.identity.languageCode)
    : null;
  const locale = resolveTelegramLocale({
    explicitPreference: requestedLocalePreference ?? stored.identity?.preferredLocale,
    identityPreference,
    requestLanguage: input.update.user.languageCode,
    shopDefaultLocale: shop.defaultLocale,
  });
  // Carry the resolved buyer locale through the canonical commerce context and
  // cart/order snapshot so rendering and persisted order locale stay aligned.
  const localizedShop = { ...shop, defaultLocale: locale };
  // Bind the provider integration to the tenant before creating any buyer
  // identity or recipient rows. The webhook path normally supplies a matching
  // pair, but this boundary must fail closed for direct callers too.
  const identity = await ensureIdentity({
    chatId: input.update.chat.id,
    env: input.env,
    identityHint: stored.identity,
    integrationId: input.integrationId,
    locale,
    observedLanguage,
    shop: localizedShop,
    subjectHash: stored.subjectHash,
    user: input.update.user,
  });
  if (messageCommand?.command === "/language") {
    if (messageCommand.argumentsList.length === 0) {
      return { identity, reply: { text: telegramText(locale, "language.usage") }, resultCode: "language_usage" };
    }
    if (requestedLocalePreference === null) {
      return { identity, reply: { text: telegramText(locale, "language.invalid") }, resultCode: "language_invalid" };
    }
    await persistTelegramLocalePreference({ customerId: identity.customerId, env: input.env, locale: requestedLocalePreference, shopId: shop.id });
    return { identity, reply: { text: telegramText(requestedLocalePreference, "language.updated") }, resultCode: "language_updated" };
  }
  const cartApplication = await createTelegramCartApplication({ connectionId, env: input.env, identity, integrationId: input.integrationId, shop: localizedShop, updateId: input.update.updateId });
  const checkoutKey = await createTelegramCheckoutApplicationKey(input.env, shop.id, input.integrationId, input.update.updateId);
  const paymentApplication = createTelegramPaymentApplication({ env: input.env, ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }), shopId: shop.id });
  const orderApplication = createTelegramCheckoutApplication({
    connectionId,
    env: input.env,
    expectedIdempotencyKey: checkoutKey,
    identity: { customerId: identity.customerId, integrationId: input.integrationId, subjectHash: identity.subjectHash },
    paymentFulfillment: paymentApplication,
    requestedSnapshot: null,
    shop: localizedShop,
    updateId: input.update.updateId,
  });
  try {
    if (input.update.kind === "callback_query") {
      if (input.update.data.startsWith("add:")) {
        const variantId = input.update.data.slice(4);
        await cartApplication.application.createCart(cartApplication.context, { items: [{ quantity: 1, variantId }] });
        return { identity, reply: await cartReply(cartApplication.application, cartApplication.context, input.env, localizedShop, identity, input.integrationId, input.update.updateId, locale), resultCode: "cart_updated" };
      }
      if (input.update.data === "cart") return { identity, reply: await cartReply(cartApplication.application, cartApplication.context, input.env, localizedShop, identity, input.integrationId, input.update.updateId, locale), resultCode: "cart_rendered" };
      if (input.update.data === "buy") {
        return { identity, reply: await cartReply(cartApplication.application, cartApplication.context, input.env, localizedShop, identity, input.integrationId, input.update.updateId, locale), resultCode: "cart_rendered" };
      }
      if (input.update.data.startsWith("buy:")) {
        const quoteUpdateText = input.update.data.slice(4);
        if (!/^(0|[1-9][0-9]*)$/u.test(quoteUpdateText)) {
          return { identity, reply: await cartReply(cartApplication.application, cartApplication.context, input.env, localizedShop, identity, input.integrationId, input.update.updateId, locale), resultCode: "cart_rendered" };
        }
        const quoteUpdateId = Number(quoteUpdateText);
        if (!Number.isSafeInteger(quoteUpdateId)) throw new AppError("quote_invalid", 409);
        const order = await checkoutTelegramCart({ env: input.env, identity, integrationId: input.integrationId, quoteUpdateId, shop: localizedShop, updateId: input.update.updateId });
        const reply = await renderTelegramCheckoutResult({ context: cartApplication.context, order, orderApplication, origin: localizedShop.origin, paymentApplication: orderApplication });
        return { identity, reply, resultCode: "checkout_completed" };
      }
      if (input.update.data.startsWith("pay:")) return { identity, reply: await paymentReply({ application: orderApplication, context: cartApplication.context, orderPublicId: input.update.data.slice(4), origin: localizedShop.origin }), resultCode: "payment_rendered" };
      if (input.update.data.startsWith("ord:")) return { identity, reply: await orderReply(orderApplication, cartApplication.context, input.update.data.slice(4)), resultCode: "order_rendered" };
      if (input.update.data.startsWith("key:")) return { identity, reply: await keyReply({ application: orderApplication, context: cartApplication.context, orderApplication, orderPublicId: input.update.data.slice(4) }), resultCode: "keys_rendered" };
      return { identity, reply: menuReply(localizedShop, locale), resultCode: "menu_rendered" };
    }

    const { argumentsList, command } = messageCommand ?? { argumentsList: [], command: "" };
    if (command === "/products" || command === "/shop") return { identity, reply: await catalogReply(input.env, localizedShop, locale), resultCode: "catalog_rendered" };
    if (command === "/cart") return { identity, reply: await cartReply(cartApplication.application, cartApplication.context, input.env, localizedShop, identity, input.integrationId, input.update.updateId, locale), resultCode: "cart_rendered" };
    if (command === "/discount") {
      await cartApplication.application.mutateCart(cartApplication.context, {
        cart: { access: { kind: "principal" }, cartId: null },
        idempotencyKey: cartApplication.idempotencyKey,
        mutation: { code: normalizeDiscountCode(argumentsList.join("")), kind: "discount.apply" },
      });
      return { identity, reply: await cartReply(cartApplication.application, cartApplication.context, input.env, localizedShop, identity, input.integrationId, input.update.updateId, locale), resultCode: "discount_applied" };
    }
    if (command === "/orders" || command === "/order") {
      const orders = await orderApplication.listOrders(cartApplication.context, {});
      return { identity, reply: ordersReply(orders, locale), resultCode: "orders_rendered" };
    }
    if (command === "/keys") {
      const orders = await orderApplication.listOrders(cartApplication.context, {});
      let eligibleOrder: OrderSummary | undefined;
      for (const order of orders.filter((candidate) => candidate.paymentStatus === "paid")) {
        if ((await orderApplication.getFulfillmentEligibility(cartApplication.context, { order: principalOrder(order.orderId) })).eligible) {
          eligibleOrder = order;
          break;
        }
      }
      return eligibleOrder === undefined
        ? { identity, reply: { keyboard: [[{ callback_data: "menu", text: telegramText(locale, "button.menu") }]], text: telegramText(locale, "keys.empty") }, resultCode: "keys_empty" }
        : { identity, reply: await keyReply({ application: orderApplication, context: cartApplication.context, orderApplication, orderPublicId: eligibleOrder.orderId }), resultCode: "keys_rendered" };
    }
    return { identity, reply: menuReply(localizedShop, locale), resultCode: command === "/start" ? "started" : "help_rendered" };
  } catch (error) {
    if (error instanceof AppError && error.status < 500) return { identity, reply: safeErrorReply(error, locale), resultCode: error.code };
    throw error;
  }
}
