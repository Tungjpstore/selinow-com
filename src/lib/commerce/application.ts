import { AppError } from "../core/errors";
import { matchSupportedLocale } from "../i18n/locale";
import type {
  CommerceActor,
  CommerceCartAccess,
  CommerceCartItem,
  CommerceCartMutationCommand,
  CommerceCartMutationTarget,
  CommerceCartMutationView,
  CommerceCartReference,
  CommerceChannel,
  CommerceCheckoutCommand,
  CommerceCheckoutRecoveryCommand,
  CommerceCheckoutRecoveryPrepareCommand,
  CommerceCheckoutRecoveryPrepareView,
  CommerceCheckoutRecoveryView,
  CommerceCheckoutView,
  CommerceCommand,
  CommerceContext,
  CommerceCreateCartCommand,
  CommerceCreateCartView,
  CommerceExpectedItem,
  CommerceFulfillmentCommand,
  CommerceFulfillmentEligibilityReason,
  CommerceFulfillmentEligibilityView,
  CommerceFulfillmentView,
  CommerceListOrdersCommand,
  CommerceListOrdersView,
  CommerceOrderAccess,
  CommerceOrderReference,
  CommerceOrderSummaryView,
  CommerceOrderView,
  CommercePaymentFulfillmentApplication,
  CommercePaymentHandoffCommand,
  CommercePaymentHandoffView,
  CommercePrivateDownloadConsumeCommand,
  CommercePrivateDownloadGrantCommand,
  CommercePrivateDownloadGrantView,
  CommercePrivateDownloadListCommand,
  CommercePrivateDownloadPayload,
  CommercePrivateDownloadView,
  CommercePort,
  CommerceQuoteCommand,
  CommerceQuoteItem,
  CommerceQuoteView,
  CommerceView,
} from "./contracts";

/** Public, non-secret marker for the canonical commerce runtime cutover. */
export const CANONICAL_COMMERCE_CONTRACT = "principal-channel-canonical-v1" as const;

const MAX_CART_ITEMS = 20;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;
const CHANNEL_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;

function invalid(issue: string): never {
  throw new AppError("validation_failed", 400, [issue]);
}

function internalContract(issue: string): never {
  throw new AppError("commerce_contract_invalid", 500, [issue]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], issue: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) invalid(issue);
}

function assertIdentifier(value: unknown, issue: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) invalid(issue);
}

function assertInternalIdentifier(value: unknown, issue: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) internalContract(issue);
}

function validateActor(value: unknown): CommerceActor {
  if (!isRecord(value)) invalid("commerce_actor_invalid");
  if (value.kind === "anonymous") {
    assertExactKeys(value, ["kind"], "commerce_actor_invalid");
    return { kind: "anonymous" };
  }
  if (value.kind === "customer") {
    assertExactKeys(value, ["customerId", "kind"], "commerce_actor_invalid");
    assertIdentifier(value.customerId, "commerce_customer_id_invalid");
    return { customerId: value.customerId, kind: "customer" };
  }
  invalid("commerce_actor_invalid");
}

function validateChannel(value: unknown): CommerceChannel {
  if (!isRecord(value)) invalid("commerce_channel_invalid");
  assertExactKeys(value, ["code", "connectionId"], "commerce_channel_invalid");
  if (typeof value.code !== "string" || value.code.length > 64 || !CHANNEL_PATTERN.test(value.code)) invalid("commerce_channel_invalid");
  if (value.connectionId !== null && value.connectionId !== undefined) assertIdentifier(value.connectionId, "commerce_connection_id_invalid");
  return { code: value.code, connectionId: value.connectionId ?? null };
}

function validateContext(value: CommerceContext): CommerceContext {
  if (!isRecord(value)) invalid("commerce_context_invalid");
  assertExactKeys(value, ["actor", "channel", "locale", "requestId", "shopId"], "commerce_context_invalid");
  const actor = validateActor(value.actor);
  const channel = validateChannel(value.channel);
  if (matchSupportedLocale(value.locale) === null) invalid("locale_invalid");
  assertIdentifier(value.requestId, "request_id_invalid");
  assertIdentifier(value.shopId, "shop_id_invalid");
  return { actor, channel, locale: value.locale, requestId: value.requestId, shopId: value.shopId };
}

function validateCartItem(value: unknown): CommerceCartItem {
  if (!isRecord(value)) invalid("cart_item_invalid");
  assertExactKeys(value, ["quantity", "variantId"], "cart_item_invalid");
  assertIdentifier(value.variantId, "variant_id_invalid");
  if (typeof value.quantity !== "number" || !Number.isSafeInteger(value.quantity) || value.quantity < 1 || value.quantity > 1_000) invalid("quantity_invalid");
  return { quantity: value.quantity, variantId: value.variantId };
}

function validateItems(value: unknown): readonly CommerceCartItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CART_ITEMS) invalid("cart_items_invalid");
  const items = value.map(validateCartItem);
  if (new Set(items.map((item) => item.variantId)).size !== items.length) invalid("cart_variant_duplicate");
  return items;
}

function validateCartAccess(value: unknown): CommerceCartAccess {
  if (!isRecord(value)) invalid("cart_access_invalid");
  assertExactKeys(value, ["kind", "token"], "cart_access_invalid");
  if (value.kind === "principal") {
    if (value.token !== undefined) invalid("cart_access_invalid");
    return { kind: "principal" };
  }
  if (value.kind === "opaque_token") {
    if (typeof value.token !== "string" || value.token.length < 20 || value.token.length > 512) invalid("cart_access_invalid");
    return { kind: "opaque_token", token: value.token };
  }
  invalid("cart_access_invalid");
}

function normalizeCartAccess(value: unknown): CommerceCartAccess {
  if (!isRecord(value)) internalContract("cart_access_invalid");
  if (value.kind === "principal") return { kind: "principal" };
  if (value.kind === "opaque_token" && typeof value.token === "string" && value.token.length >= 20 && value.token.length <= 512) {
    return { kind: "opaque_token", token: value.token };
  }
  internalContract("cart_access_invalid");
}

function validateCartReference(value: unknown): CommerceCartReference {
  if (!isRecord(value)) invalid("cart_reference_invalid");
  assertExactKeys(value, ["access", "cartId"], "cart_reference_invalid");
  assertIdentifier(value.cartId, "cart_id_invalid");
  return { access: validateCartAccess(value.access), cartId: value.cartId };
}

function validateOrderAccess(value: unknown): CommerceOrderAccess {
  if (!isRecord(value)) invalid("order_access_invalid");
  assertExactKeys(value, ["kind", "token"], "order_access_invalid");
  if (value.kind === "principal") {
    if (value.token !== undefined) invalid("order_access_invalid");
    return { kind: "principal" };
  }
  if (value.kind === "opaque_token") {
    if (typeof value.token !== "string" || value.token.length < 20 || value.token.length > 512) invalid("order_access_invalid");
    return { kind: "opaque_token", token: value.token };
  }
  invalid("order_access_invalid");
}

function validateOrderReference(value: unknown): CommerceOrderReference {
  if (!isRecord(value)) invalid("order_reference_invalid");
  assertExactKeys(value, ["access", "orderId"], "order_reference_invalid");
  assertIdentifier(value.orderId, "order_id_invalid");
  return { access: validateOrderAccess(value.access), orderId: value.orderId };
}

function validateListOrders(input: CommerceListOrdersCommand): CommerceListOrdersCommand {
  if (!isRecord(input)) invalid("order_list_invalid");
  assertExactKeys(input, [], "order_list_invalid");
  return {};
}

function validatePaymentHandoff(input: CommercePaymentHandoffCommand): CommercePaymentHandoffCommand {
  if (!isRecord(input)) invalid("payment_handoff_invalid");
  assertExactKeys(input, ["order", "origin"], "payment_handoff_invalid");
  if (typeof input.origin !== "string" || input.origin.length === 0) invalid("payment_origin_invalid");
  return { order: validateOrderReference(input.order), origin: input.origin };
}

function validateFulfillment(input: CommerceFulfillmentCommand): CommerceFulfillmentCommand {
  if (!isRecord(input)) invalid("fulfillment_command_invalid");
  assertExactKeys(input, ["order"], "fulfillment_command_invalid");
  return { order: validateOrderReference(input.order) };
}

function validateCreate(input: CommerceCreateCartCommand): CommerceCreateCartCommand {
  if (!isRecord(input)) invalid("cart_create_invalid");
  assertExactKeys(input, ["items"], "cart_create_invalid");
  return { items: validateItems(input.items) };
}

function validateQuote(input: CommerceQuoteCommand): CommerceQuoteCommand {
  if (!isRecord(input)) invalid("cart_quote_invalid");
  assertExactKeys(input, ["cart"], "cart_quote_invalid");
  return { cart: validateCartReference(input.cart) };
}

function validateCartMutationTarget(value: unknown): CommerceCartMutationTarget {
  if (!isRecord(value)) invalid("cart_mutation_target_invalid");
  assertExactKeys(value, ["access", "cartId"], "cart_mutation_target_invalid");
  const access = validateCartAccess(value.access);
  if (access.kind === "principal") {
    if (value.cartId !== null) invalid("cart_mutation_target_invalid");
    return { access, cartId: null };
  }
  assertIdentifier(value.cartId, "cart_id_invalid");
  return { access, cartId: value.cartId };
}

function validateCartMutation(input: CommerceCartMutationCommand): CommerceCartMutationCommand {
  if (!isRecord(input)) invalid("cart_mutation_invalid");
  assertExactKeys(input, ["cart", "idempotencyKey", "mutation"], "cart_mutation_invalid");
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/u.test(input.idempotencyKey)) invalid("idempotency_key_invalid");
  if (!isRecord(input.mutation)) invalid("cart_mutation_invalid");
  const mutation = input.mutation as Record<string, unknown>;
  if (mutation.kind === "item.increment") {
    assertExactKeys(mutation, ["kind", "quantity", "variantId"], "cart_item_mutation_invalid");
    assertIdentifier(mutation.variantId, "variant_id_invalid");
    if (typeof mutation.quantity !== "number" || !Number.isSafeInteger(mutation.quantity) || mutation.quantity < 1 || mutation.quantity > 1_000) invalid("quantity_invalid");
    return { cart: validateCartMutationTarget(input.cart), idempotencyKey: input.idempotencyKey, mutation: { kind: "item.increment", quantity: mutation.quantity, variantId: mutation.variantId } };
  }
  if (mutation.kind === "discount.apply") {
    assertExactKeys(mutation, ["code", "kind"], "discount_mutation_invalid");
    if (typeof mutation.code !== "string" || !/^[A-Z0-9_-]{3,32}$/u.test(mutation.code)) invalid("discount_code_invalid");
    return { cart: validateCartMutationTarget(input.cart), idempotencyKey: input.idempotencyKey, mutation: { code: mutation.code, kind: "discount.apply" } };
  }
  if (mutation.kind === "discount.remove") {
    assertExactKeys(mutation, ["kind"], "discount_mutation_invalid");
    return { cart: validateCartMutationTarget(input.cart), idempotencyKey: input.idempotencyKey, mutation: { kind: "discount.remove" } };
  }
  invalid("cart_mutation_invalid");
}

function validateExpected(value: unknown): readonly CommerceExpectedItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CART_ITEMS) invalid("checkout_expected_invalid");
  const expected = value.map((item) => {
    if (!isRecord(item)) invalid("checkout_expected_invalid");
    assertExactKeys(item, ["quantity", "unitPriceMinor", "variantId", "variantVersion"], "checkout_expected_invalid");
    assertIdentifier(item.variantId, "variant_id_invalid");
    if (typeof item.quantity !== "number" || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 1_000) invalid("quantity_invalid");
    if (typeof item.unitPriceMinor !== "number" || !Number.isSafeInteger(item.unitPriceMinor) || item.unitPriceMinor < 0) invalid("unit_price_invalid");
    if (typeof item.variantVersion !== "number" || !Number.isSafeInteger(item.variantVersion) || item.variantVersion < 1) invalid("variant_version_invalid");
    return {
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      variantId: item.variantId,
      variantVersion: item.variantVersion,
    };
  });
  if (new Set(expected.map((item) => item.variantId)).size !== expected.length) invalid("checkout_expected_duplicate");
  return expected;
}

function validateCheckout(input: CommerceCheckoutCommand): CommerceCheckoutCommand {
  if (!isRecord(input)) invalid("checkout_create_invalid");
  assertExactKeys(input, ["cart", "customerEmail", "expected", "idempotencyKey", "quoteEvidence"], "checkout_create_invalid");
  const cart = validateCartReference(input.cart);
  if (input.customerEmail !== null && typeof input.customerEmail !== "string") invalid("email_invalid");
  if (input.customerEmail !== null && input.customerEmail.length > 254) invalid("email_invalid");
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/u.test(input.idempotencyKey)) invalid("idempotency_key_invalid");
  if (input.quoteEvidence !== undefined && (typeof input.quoteEvidence !== "string" || input.quoteEvidence.length < 40 || input.quoteEvidence.length > 4_096)) invalid("quote_evidence_invalid");
  return { cart, customerEmail: input.customerEmail, expected: validateExpected(input.expected), idempotencyKey: input.idempotencyKey, ...(input.quoteEvidence === undefined ? {} : { quoteEvidence: input.quoteEvidence }) };
}

function validateCheckoutRecoveryPrepare(input: CommerceCheckoutRecoveryPrepareCommand): CommerceCheckoutRecoveryPrepareCommand {
  if (!isRecord(input)) invalid("checkout_recovery_prepare_invalid");
  assertExactKeys(input, ["cart", "customerEmail", "expected", "idempotencyKey", "quoteEvidence"], "checkout_recovery_prepare_invalid");
  const cart = validateCartReference(input.cart);
  if (input.customerEmail !== null && typeof input.customerEmail !== "string") invalid("email_invalid");
  if (input.customerEmail !== null && input.customerEmail.length > 254) invalid("email_invalid");
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/u.test(input.idempotencyKey)) invalid("idempotency_key_invalid");
  if (typeof input.quoteEvidence !== "string" || input.quoteEvidence.length < 40 || input.quoteEvidence.length > 4_096) invalid("quote_evidence_invalid");
  return { cart, customerEmail: input.customerEmail, expected: validateExpected(input.expected), idempotencyKey: input.idempotencyKey, quoteEvidence: input.quoteEvidence };
}

function validateCheckoutRecovery(input: CommerceCheckoutRecoveryCommand): CommerceCheckoutRecoveryCommand {
  if (!isRecord(input)) invalid("checkout_recovery_invalid");
  assertExactKeys(input, ["cart", "customerEmail", "expected", "idempotencyKey", "recoveryEvidence"], "checkout_recovery_invalid");
  const cart = validateCartReference(input.cart);
  if (input.customerEmail !== null && typeof input.customerEmail !== "string") invalid("email_invalid");
  if (input.customerEmail !== null && input.customerEmail.length > 254) invalid("email_invalid");
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/u.test(input.idempotencyKey)) invalid("idempotency_key_invalid");
  if (typeof input.recoveryEvidence !== "string" || input.recoveryEvidence.length < 40 || input.recoveryEvidence.length > 4_096) invalid("checkout_recovery_invalid");
  return { cart, customerEmail: input.customerEmail, expected: validateExpected(input.expected), idempotencyKey: input.idempotencyKey, recoveryEvidence: input.recoveryEvidence };
}

function validatePrivateDownloadList(input: CommercePrivateDownloadListCommand): CommercePrivateDownloadListCommand {
  if (!isRecord(input)) invalid("private_download_list_invalid");
  assertExactKeys(input, ["order"], "private_download_list_invalid");
  return { order: validateOrderReference(input.order) };
}

function validatePrivateDownloadGrant(input: CommercePrivateDownloadGrantCommand): CommercePrivateDownloadGrantCommand {
  if (!isRecord(input)) invalid("private_download_grant_invalid");
  assertExactKeys(input, ["assetVersionId", "idempotencyKey", "order", "orderItemId"], "private_download_grant_invalid");
  assertIdentifier(input.assetVersionId, "asset_version_id_invalid");
  assertIdentifier(input.orderItemId, "order_item_id_invalid");
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/u.test(input.idempotencyKey)) invalid("idempotency_key_invalid");
  return { assetVersionId: input.assetVersionId, idempotencyKey: input.idempotencyKey, order: validateOrderReference(input.order), orderItemId: input.orderItemId };
}

function validatePrivateDownloadConsume(input: CommercePrivateDownloadConsumeCommand): CommercePrivateDownloadConsumeCommand {
  if (!isRecord(input)) invalid("private_download_consume_invalid");
  assertExactKeys(input, ["grantId", "grantToken", "idempotencyKey", "order"], "private_download_consume_invalid");
  assertIdentifier(input.grantId, "grant_id_invalid");
  if (typeof input.grantToken !== "string" || input.grantToken.length < 20 || input.grantToken.length > 512) invalid("grant_token_invalid");
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/u.test(input.idempotencyKey)) invalid("idempotency_key_invalid");
  return { grantId: input.grantId, grantToken: input.grantToken, idempotencyKey: input.idempotencyKey, order: validateOrderReference(input.order) };
}

function validateIsoDate(value: unknown, issue: string): asserts value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) internalContract(issue);
}

function normalizeCreateView(value: CommerceCreateCartView): CommerceCreateCartView {
  if (!isRecord(value)) internalContract("cart_create_view_invalid");
  assertInternalIdentifier(value.cartId, "cart_id_invalid");
  const access = normalizeCartAccess(value.access);
  validateIsoDate(value.expiresAt, "cart_expiry_invalid");
  return { access, cartId: value.cartId, expiresAt: value.expiresAt };
}

function normalizeCartMutationView(value: CommerceCartMutationView): CommerceCartMutationView {
  if (!isRecord(value)) internalContract("cart_mutation_view_invalid");
  if (!isRecord(value.cart)) internalContract("cart_reference_invalid");
  assertInternalIdentifier(value.cart.cartId, "cart_id_invalid");
  const access = normalizeCartAccess(value.cart.access);
  if (typeof value.replayed !== "boolean") internalContract("cart_mutation_replayed_invalid");
  return { cart: { access, cartId: value.cart.cartId }, replayed: value.replayed };
}

function normalizeQuoteItem(value: unknown): CommerceQuoteItem {
  if (!isRecord(value)) internalContract("quote_item_invalid");
  assertInternalIdentifier(value.variantId, "variant_id_invalid");
  if (typeof value.productTitle !== "string" || typeof value.variantTitle !== "string") internalContract("quote_item_invalid");
  if (typeof value.quantity !== "number" || !Number.isSafeInteger(value.quantity) || value.quantity < 1) internalContract("quote_item_invalid");
  if (typeof value.unitPriceMinor !== "number" || !Number.isSafeInteger(value.unitPriceMinor) || value.unitPriceMinor < 0) internalContract("quote_item_invalid");
  if (typeof value.lineTotalMinor !== "number" || !Number.isSafeInteger(value.lineTotalMinor) || value.lineTotalMinor !== value.quantity * value.unitPriceMinor) internalContract("quote_item_invalid");
  if (typeof value.variantVersion !== "number" || !Number.isSafeInteger(value.variantVersion) || value.variantVersion < 1) internalContract("quote_item_invalid");
  return { lineTotalMinor: value.lineTotalMinor, productTitle: value.productTitle, quantity: value.quantity, unitPriceMinor: value.unitPriceMinor, variantId: value.variantId, variantTitle: value.variantTitle, variantVersion: value.variantVersion };
}

function normalizeQuoteView(value: CommerceQuoteView): CommerceQuoteView {
  if (!isRecord(value)) internalContract("quote_view_invalid");
  if (typeof value.currency !== "string" || !/^[A-Z]{3}$/u.test(value.currency)) internalContract("quote_currency_invalid");
  validateIsoDate(value.expiresAt, "quote_expiry_invalid");
  if (!Array.isArray(value.items)) internalContract("quote_items_invalid");
  const items = value.items.map(normalizeQuoteItem);
  if (items.length === 0 || items.length > MAX_CART_ITEMS || new Set(items.map((item) => item.variantId)).size !== items.length) internalContract("quote_items_invalid");
  if (typeof value.discountMinor !== "number" || !Number.isSafeInteger(value.discountMinor) || value.discountMinor < 0) internalContract("quote_discount_invalid");
  if (typeof value.subtotalMinor !== "number" || !Number.isSafeInteger(value.subtotalMinor) || value.subtotalMinor < 0) internalContract("quote_subtotal_invalid");
  if (items.reduce((sum, item) => sum + item.lineTotalMinor, 0) !== value.subtotalMinor) internalContract("quote_subtotal_invalid");
  if (typeof value.totalMinor !== "number" || !Number.isSafeInteger(value.totalMinor) || value.totalMinor < 0 || value.totalMinor !== value.subtotalMinor - value.discountMinor) internalContract("quote_total_invalid");
  if (value.quoteEvidence !== undefined && (typeof value.quoteEvidence !== "string" || value.quoteEvidence.length < 40 || value.quoteEvidence.length > 4_096)) internalContract("quote_evidence_invalid");
  return { currency: value.currency, discountMinor: value.discountMinor, expiresAt: value.expiresAt, items, ...(value.quoteEvidence === undefined ? {} : { quoteEvidence: value.quoteEvidence }), subtotalMinor: value.subtotalMinor, totalMinor: value.totalMinor };
}

function normalizeCheckoutView(value: CommerceCheckoutView): CommerceCheckoutView {
  if (!isRecord(value)) internalContract("checkout_view_invalid");
  if (!isRecord(value.access)) internalContract("order_access_invalid");
  const orderAccess = value.access;
  const accessKind: unknown = orderAccess.kind;
  let access: CommerceCheckoutView["access"];
  if (accessKind === "principal") {
    access = { kind: "principal" };
  } else if (accessKind === "opaque_token" && "token" in orderAccess) {
    if (typeof orderAccess.token !== "string" || orderAccess.token.length < 20 || orderAccess.token.length > 512) internalContract("order_access_invalid");
    access = { kind: "opaque_token", token: orderAccess.token };
  } else {
    internalContract("order_access_invalid");
  }
  assertInternalIdentifier(value.orderId, "order_id_invalid");
  if (value.orderNumber !== null && typeof value.orderNumber !== "string") internalContract("order_number_invalid");
  if (typeof value.currency !== "string" || !/^[A-Z]{3}$/u.test(value.currency)) internalContract("checkout_currency_invalid");
  validateIsoDate(value.expiresAt, "checkout_expiry_invalid");
  for (const field of ["fulfillmentStatus", "paymentStatus", "status"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) internalContract(`checkout_${field}_invalid`);
  }
  if (typeof value.totalMinor !== "number" || !Number.isSafeInteger(value.totalMinor) || value.totalMinor < 0) internalContract("checkout_total_invalid");
  return { access, currency: value.currency, expiresAt: value.expiresAt, fulfillmentStatus: value.fulfillmentStatus, orderId: value.orderId, orderNumber: value.orderNumber, paymentStatus: value.paymentStatus, status: value.status, totalMinor: value.totalMinor };
}

function normalizeCheckoutRecoveryPrepareView(value: CommerceCheckoutRecoveryPrepareView): CommerceCheckoutRecoveryPrepareView {
  if (!isRecord(value) || typeof value.evidence !== "string" || value.evidence.length < 40 || value.evidence.length > 4_096) {
    internalContract("checkout_recovery_prepare_view_invalid");
  }
  validateIsoDate(value.expiresAt, "checkout_recovery_expiry_invalid");
  return { evidence: value.evidence, expiresAt: value.expiresAt };
}

function normalizeCheckoutRecoveryView(value: CommerceCheckoutRecoveryView): CommerceCheckoutRecoveryView {
  const raw: unknown = value;
  if (!isRecord(raw)) internalContract("checkout_recovery_view_invalid");
  const access: unknown = raw.access;
  if (!isRecord(access) || access.kind !== "opaque_token"
    || typeof access.token !== "string" || access.token.length < 20 || access.token.length > 512) {
    internalContract("checkout_recovery_view_invalid");
  }
  assertInternalIdentifier(value.orderId, "order_id_invalid");
  if (typeof value.orderNumber !== "string" || value.orderNumber.length === 0) internalContract("order_number_invalid");
  if (typeof value.currency !== "string" || !/^[A-Z]{3}$/u.test(value.currency)) internalContract("checkout_currency_invalid");
  validateIsoDate(value.expiresAt, "checkout_expiry_invalid");
  for (const field of ["fulfillmentStatus", "paymentStatus", "status"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) internalContract(`checkout_${field}_invalid`);
  }
  if (typeof value.totalMinor !== "number" || !Number.isSafeInteger(value.totalMinor) || value.totalMinor < 0) internalContract("checkout_total_invalid");
  return {
    access: { kind: "opaque_token", token: access.token },
    currency: value.currency,
    expiresAt: value.expiresAt,
    fulfillmentStatus: value.fulfillmentStatus,
    orderId: value.orderId,
    orderNumber: value.orderNumber,
    paymentStatus: value.paymentStatus,
    status: value.status,
    totalMinor: value.totalMinor,
  };
}

function normalizePrivateDownloadView(value: unknown): CommercePrivateDownloadView {
  if (!isRecord(value)) internalContract("private_download_view_invalid");
  assertInternalIdentifier(value.assetVersionId, "asset_version_id_invalid");
  assertInternalIdentifier(value.orderItemId, "order_item_id_invalid");
  if (typeof value.filename !== "string" || value.filename.length === 0) internalContract("private_download_filename_invalid");
  if (value.entitlementExpiresAt !== null) validateIsoDate(value.entitlementExpiresAt, "private_download_expiry_invalid");
  if (value.entitlementStatus !== null && (typeof value.entitlementStatus !== "string" || value.entitlementStatus.length === 0)) internalContract("private_download_status_invalid");
  const downloadCount = value.downloadCount;
  const maxDownloads = value.maxDownloads;
  const remainingDownloads = value.remainingDownloads;
  for (const field of ["downloadCount", "maxDownloads", "remainingDownloads"] as const) {
    if (typeof value[field] !== "number" || !Number.isSafeInteger(value[field]) || value[field] < 0) internalContract("private_download_count_invalid");
  }
  if (typeof downloadCount !== "number" || typeof maxDownloads !== "number" || typeof remainingDownloads !== "number") internalContract("private_download_count_invalid");
  if (downloadCount > maxDownloads || remainingDownloads > maxDownloads) internalContract("private_download_count_invalid");
  return {
    assetVersionId: value.assetVersionId,
    downloadCount,
    entitlementExpiresAt: value.entitlementExpiresAt,
    entitlementStatus: value.entitlementStatus,
    filename: value.filename,
    maxDownloads,
    orderItemId: value.orderItemId,
    remainingDownloads,
  };
}

function normalizePrivateDownloadGrantView(value: CommercePrivateDownloadGrantView): CommercePrivateDownloadGrantView {
  if (!isRecord(value)) internalContract("private_download_grant_view_invalid");
  assertInternalIdentifier(value.assetVersionId, "asset_version_id_invalid");
  assertInternalIdentifier(value.grantId, "grant_id_invalid");
  validateIsoDate(value.expiresAt, "private_download_grant_expiry_invalid");
  if (typeof value.grantToken !== "string" || value.grantToken.length < 20 || value.grantToken.length > 512) internalContract("private_download_grant_token_invalid");
  if (typeof value.remainingDownloads !== "number" || !Number.isSafeInteger(value.remainingDownloads) || value.remainingDownloads < 0) internalContract("private_download_count_invalid");
  return { assetVersionId: value.assetVersionId, expiresAt: value.expiresAt, grantId: value.grantId, grantToken: value.grantToken, remainingDownloads: value.remainingDownloads };
}

function normalizePrivateDownloadPayload(value: CommercePrivateDownloadPayload): CommercePrivateDownloadPayload {
  if (!isRecord(value) || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength < 1
    || typeof value.contentType !== "string" || value.contentType.length === 0
    || typeof value.filename !== "string" || value.filename.length === 0) {
    internalContract("private_download_payload_invalid");
  }
  return { bytes: value.bytes, contentType: value.contentType, filename: value.filename };
}

function normalizeOrderView(value: CommerceOrderView): CommerceOrderView {
  if (!isRecord(value)) internalContract("order_view_invalid");
  if (typeof value.currency !== "string" || !/^[A-Z]{3}$/u.test(value.currency)) internalContract("order_currency_invalid");
  if (typeof value.orderNumber !== "string" || value.orderNumber.length === 0) internalContract("order_number_invalid");
  validateIsoDate(value.expiresAt, "order_expiry_invalid");
  for (const field of ["fulfillmentStatus", "paymentStatus", "status"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) internalContract(`order_${field}_invalid`);
  }
  if (typeof value.totalMinor !== "number" || !Number.isSafeInteger(value.totalMinor) || value.totalMinor < 0) internalContract("order_total_invalid");
  if (!Array.isArray(value.items) || value.items.length > MAX_CART_ITEMS) internalContract("order_items_invalid");
  const items = value.items.map((item) => {
    if (!isRecord(item)) internalContract("order_item_invalid");
    if (typeof item.fulfillmentType !== "string" || item.fulfillmentType.length === 0 || typeof item.productTitle !== "string" || typeof item.variantTitle !== "string") internalContract("order_item_invalid");
    if (typeof item.quantity !== "number" || !Number.isSafeInteger(item.quantity) || item.quantity < 1) internalContract("order_item_invalid");
    if (typeof item.lineTotalMinor !== "number" || !Number.isSafeInteger(item.lineTotalMinor) || item.lineTotalMinor < 0) internalContract("order_item_invalid");
    return { fulfillmentType: item.fulfillmentType, lineTotalMinor: item.lineTotalMinor, productTitle: item.productTitle, quantity: item.quantity, variantTitle: item.variantTitle };
  });
  return { currency: value.currency, expiresAt: value.expiresAt, fulfillmentStatus: value.fulfillmentStatus, items, orderNumber: value.orderNumber, paymentStatus: value.paymentStatus, status: value.status, totalMinor: value.totalMinor };
}

function normalizeOrderSummaryView(value: unknown): CommerceOrderSummaryView {
  if (!isRecord(value)) internalContract("order_summary_invalid");
  assertInternalIdentifier(value.orderId, "order_id_invalid");
  if (typeof value.currency !== "string" || !/^[A-Z]{3}$/u.test(value.currency)) internalContract("order_currency_invalid");
  if (typeof value.orderNumber !== "string" || value.orderNumber.length === 0) internalContract("order_number_invalid");
  const fulfillmentStatus = value.fulfillmentStatus;
  const paymentStatus = value.paymentStatus;
  const status = value.status;
  if (typeof fulfillmentStatus !== "string" || fulfillmentStatus.length === 0) internalContract("order_fulfillmentStatus_invalid");
  if (typeof paymentStatus !== "string" || paymentStatus.length === 0) internalContract("order_paymentStatus_invalid");
  if (typeof status !== "string" || status.length === 0) internalContract("order_status_invalid");
  if (typeof value.totalMinor !== "number" || !Number.isSafeInteger(value.totalMinor) || value.totalMinor < 0) internalContract("order_total_invalid");
  return {
    currency: value.currency,
    fulfillmentStatus,
    orderId: value.orderId,
    orderNumber: value.orderNumber,
    paymentStatus,
    status,
    totalMinor: value.totalMinor,
  };
}

function normalizeListOrdersView(value: CommerceListOrdersView): CommerceListOrdersView {
  if (!Array.isArray(value) || value.length > 50) internalContract("order_list_view_invalid");
  return value.map(normalizeOrderSummaryView);
}

function normalizePaymentHandoffView(value: unknown): CommercePaymentHandoffView {
  if (!isRecord(value)
    || typeof value.expiresAt !== "string" || Number.isNaN(Date.parse(value.expiresAt))
    || typeof value.handoffId !== "string" || value.handoffId.length === 0
    || typeof value.redirectUrl !== "string" || value.redirectUrl.length === 0
    || typeof value.status !== "string" || value.status.length === 0) {
    internalContract("payment_handoff_invalid");
  }
  if (value.presentation !== null) {
    if (!isRecord(value.presentation) || value.presentation.kind !== "qr" || typeof value.presentation.payload !== "string" || value.presentation.payload.length === 0) {
      internalContract("payment_presentation_invalid");
    }
    return {
      expiresAt: value.expiresAt,
      handoffId: value.handoffId,
      presentation: { kind: "qr", payload: value.presentation.payload },
      redirectUrl: value.redirectUrl,
      status: value.status,
    };
  }
  return { expiresAt: value.expiresAt, handoffId: value.handoffId, presentation: null, redirectUrl: value.redirectUrl, status: value.status };
}

function normalizeFulfillmentEligibilityView(value: unknown, orderId: string): CommerceFulfillmentEligibilityView {
  const reasons: CommerceFulfillmentEligibilityReason[] = ["fulfillment_pending", "order_expired", "order_ineligible", "payment_unconfirmed", "ready"];
  if (!isRecord(value) || typeof value.eligible !== "boolean" || value.orderId !== orderId
    || typeof value.reason !== "string" || !reasons.includes(value.reason as CommerceFulfillmentEligibilityReason)) {
    internalContract("fulfillment_eligibility_invalid");
  }
  const reason = value.reason as CommerceFulfillmentEligibilityReason;
  if (value.eligible !== (reason === "ready")) internalContract("fulfillment_eligibility_invalid");
  return { eligible: value.eligible, orderId, reason };
}

function normalizeFulfillmentView(value: unknown, orderId: string): CommerceFulfillmentView {
  if (!isRecord(value) || value.orderId !== orderId || !Array.isArray(value.items)) internalContract("fulfillment_view_invalid");
  return {
    items: value.items.map((item) => {
      if (!isRecord(item)
        || typeof item.productTitle !== "string" || typeof item.variantTitle !== "string" || typeof item.value !== "string") {
        internalContract("fulfillment_item_invalid");
      }
      return { productTitle: item.productTitle, value: item.value, variantTitle: item.variantTitle };
    }),
    orderId,
  };
}

export class CommerceApplicationService {
  constructor(
    private readonly port: CommercePort,
    private readonly paymentFulfillment?: CommercePaymentFulfillmentApplication,
  ) {}

  async createCart(context: CommerceContext, input: CommerceCreateCartCommand): Promise<CommerceCreateCartView> {
    const normalizedContext = validateContext(context);
    const normalizedInput = validateCreate(input);
    if (this.port.createCart === undefined) throw new AppError("commerce_operation_unsupported", 501, ["cart_create"]);
    return normalizeCreateView(await this.port.createCart({ command: normalizedInput, context: normalizedContext }));
  }

  async quoteCart(context: CommerceContext, input: CommerceQuoteCommand): Promise<CommerceQuoteView> {
    const normalizedContext = validateContext(context);
    const normalizedInput = validateQuote(input);
    if (this.port.quoteCart === undefined) throw new AppError("commerce_operation_unsupported", 501, ["cart_quote"]);
    return normalizeQuoteView(await this.port.quoteCart({ command: normalizedInput, context: normalizedContext }));
  }

  async mutateCart(context: CommerceContext, input: CommerceCartMutationCommand): Promise<CommerceCartMutationView> {
    const normalizedContext = validateContext(context);
    const normalizedInput = validateCartMutation(input);
    if (this.port.mutateCart === undefined) throw new AppError("commerce_operation_unsupported", 501, ["cart_mutation"]);
    return normalizeCartMutationView(await this.port.mutateCart({ command: normalizedInput, context: normalizedContext }));
  }

  async checkoutCart(context: CommerceContext, input: CommerceCheckoutCommand): Promise<CommerceCheckoutView> {
    const normalizedContext = validateContext(context);
    const normalizedInput = validateCheckout(input);
    if (this.port.checkoutCart === undefined) throw new AppError("commerce_operation_unsupported", 501, ["checkout_create"]);
    return normalizeCheckoutView(await this.port.checkoutCart({ command: normalizedInput, context: normalizedContext }));
  }

  async prepareCheckoutRecovery(context: CommerceContext, input: CommerceCheckoutRecoveryPrepareCommand): Promise<CommerceCheckoutRecoveryPrepareView> {
    const normalizedContext = validateContext(context);
    const normalizedInput = validateCheckoutRecoveryPrepare(input);
    if (this.port.prepareCheckoutRecovery === undefined) throw new AppError("commerce_operation_unsupported", 501, ["checkout_recovery_prepare"]);
    return normalizeCheckoutRecoveryPrepareView(await this.port.prepareCheckoutRecovery({ command: normalizedInput, context: normalizedContext }));
  }

  async recoverCheckout(context: CommerceContext, input: CommerceCheckoutRecoveryCommand): Promise<CommerceCheckoutRecoveryView> {
    const normalizedContext = validateContext(context);
    const normalizedInput = validateCheckoutRecovery(input);
    if (this.port.recoverCheckout === undefined) throw new AppError("commerce_operation_unsupported", 501, ["checkout_recovery"]);
    return normalizeCheckoutRecoveryView(await this.port.recoverCheckout({ command: normalizedInput, context: normalizedContext }));
  }

  async getOrder(context: CommerceContext, input: { order: CommerceOrderReference }): Promise<CommerceOrderView> {
    const normalizedContext = validateContext(context);
    if (!isRecord(input)) invalid("order_get_invalid");
    assertExactKeys(input, ["order"], "order_get_invalid");
    const normalizedInput = { order: validateOrderReference(input.order) };
    if (this.port.getOrder === undefined) throw new AppError("commerce_operation_unsupported", 501, ["order_get"]);
    return normalizeOrderView(await this.port.getOrder({ command: normalizedInput, context: normalizedContext }));
  }

  async listOrders(context: CommerceContext, input: CommerceListOrdersCommand): Promise<CommerceListOrdersView> {
    const normalizedContext = validateContext(context);
    const normalizedInput = validateListOrders(input);
    if (this.port.listOrders === undefined) throw new AppError("commerce_operation_unsupported", 501, ["order_list"]);
    return normalizeListOrdersView(await this.port.listOrders({ command: normalizedInput, context: normalizedContext }));
  }

  async createPaymentHandoff(context: CommerceContext, input: CommercePaymentHandoffCommand): Promise<CommercePaymentHandoffView> {
    const normalizedContext = validateContext(context);
    const normalizedInput = validatePaymentHandoff(input);
    if (this.paymentFulfillment === undefined) throw new AppError("commerce_operation_unsupported", 501, ["payment_handoff_create"]);
    return normalizePaymentHandoffView(await this.paymentFulfillment.createPaymentHandoff(normalizedContext, normalizedInput));
  }

  async getFulfillmentEligibility(context: CommerceContext, input: CommerceFulfillmentCommand): Promise<CommerceFulfillmentEligibilityView> {
    const normalizedContext = validateContext(context);
    const normalizedInput = validateFulfillment(input);
    if (this.paymentFulfillment === undefined) throw new AppError("commerce_operation_unsupported", 501, ["fulfillment_eligibility_get"]);
    return normalizeFulfillmentEligibilityView(
      await this.paymentFulfillment.getFulfillmentEligibility(normalizedContext, normalizedInput),
      normalizedInput.order.orderId,
    );
  }

  async revealFulfillment(context: CommerceContext, input: CommerceFulfillmentCommand): Promise<CommerceFulfillmentView> {
    const normalizedContext = validateContext(context);
    const normalizedInput = validateFulfillment(input);
    if (this.paymentFulfillment === undefined) throw new AppError("commerce_operation_unsupported", 501, ["fulfillment_reveal"]);
    return normalizeFulfillmentView(
      await this.paymentFulfillment.revealFulfillment(normalizedContext, normalizedInput),
      normalizedInput.order.orderId,
    );
  }

  async listPrivateDownloads(context: CommerceContext, input: CommercePrivateDownloadListCommand): Promise<readonly CommercePrivateDownloadView[]> {
    const normalizedContext = validateContext(context);
    const normalizedInput = validatePrivateDownloadList(input);
    if (this.port.listPrivateDownloads === undefined) throw new AppError("commerce_operation_unsupported", 501, ["private_download_list"]);
    const value = await this.port.listPrivateDownloads({ command: normalizedInput, context: normalizedContext });
    if (!Array.isArray(value) || value.length > MAX_CART_ITEMS) internalContract("private_download_list_invalid");
    return value.map(normalizePrivateDownloadView);
  }

  async issuePrivateDownloadGrant(context: CommerceContext, input: CommercePrivateDownloadGrantCommand): Promise<CommercePrivateDownloadGrantView> {
    const normalizedContext = validateContext(context);
    const normalizedInput = validatePrivateDownloadGrant(input);
    if (this.port.issuePrivateDownloadGrant === undefined) throw new AppError("commerce_operation_unsupported", 501, ["private_download_grant"]);
    return normalizePrivateDownloadGrantView(await this.port.issuePrivateDownloadGrant({ command: normalizedInput, context: normalizedContext }));
  }

  async consumePrivateDownloadGrant(context: CommerceContext, input: CommercePrivateDownloadConsumeCommand): Promise<CommercePrivateDownloadPayload> {
    const normalizedContext = validateContext(context);
    const normalizedInput = validatePrivateDownloadConsume(input);
    if (this.port.consumePrivateDownloadGrant === undefined) throw new AppError("commerce_operation_unsupported", 501, ["private_download_consume"]);
    return normalizePrivateDownloadPayload(await this.port.consumePrivateDownloadGrant({ command: normalizedInput, context: normalizedContext }));
  }

  async execute(context: CommerceContext, command: CommerceCommand): Promise<CommerceView> {
    if (!isRecord(command)) invalid("commerce_command_invalid");
    const kind: unknown = command.kind;
    if (kind === "cart.create") return this.createCart(context, command.input as CommerceCreateCartCommand);
    if (kind === "cart.mutate") return this.mutateCart(context, command.input as CommerceCartMutationCommand);
    if (kind === "cart.quote") return this.quoteCart(context, command.input as CommerceQuoteCommand);
    if (kind === "checkout.create") return this.checkoutCart(context, command.input as CommerceCheckoutCommand);
    if (kind === "checkout.recovery.prepare") return this.prepareCheckoutRecovery(context, command.input as CommerceCheckoutRecoveryPrepareCommand);
    if (kind === "checkout.recovery.recover") return this.recoverCheckout(context, command.input as CommerceCheckoutRecoveryCommand);
    if (kind === "fulfillment.eligibility.get") return this.getFulfillmentEligibility(context, command.input as CommerceFulfillmentCommand);
    if (kind === "fulfillment.reveal") return this.revealFulfillment(context, command.input as CommerceFulfillmentCommand);
    if (kind === "private_download.list") return this.listPrivateDownloads(context, command.input as CommercePrivateDownloadListCommand);
    if (kind === "private_download.grant") return this.issuePrivateDownloadGrant(context, command.input as CommercePrivateDownloadGrantCommand);
    if (kind === "private_download.consume") return this.consumePrivateDownloadGrant(context, command.input as CommercePrivateDownloadConsumeCommand);
    if (kind === "order.get") return this.getOrder(context, command.input as { order: CommerceOrderReference });
    if (kind === "order.list") return this.listOrders(context, command.input as CommerceListOrdersCommand);
    if (kind === "payment.handoff.create") return this.createPaymentHandoff(context, command.input as CommercePaymentHandoffCommand);
    return invalid("commerce_command_invalid");
  }
}
