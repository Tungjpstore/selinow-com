import { createId } from "../core/ids";
import { tryRecordActivationMilestone } from "../analytics/activation";
import { AppError } from "../core/errors";
import { parsePlanLimits, PUBLIC_PLAN_CODES } from "../billing/plan-catalog";
import { prepareOrderChannelAttribution, resolveOrderChannelAttribution, type OrderChannelAttribution } from "../channels/attribution";
import { WEBSITE_CHANNEL_CODE } from "../channels/builtins";
import { prepareDomainEventAppend } from "../events/append";
import { isSupportedCurrency } from "../i18n/currency";
import type { AppBindings } from "../platform/bindings";
import { prepareUsageStatements, resolveBillingPeriod } from "../billing/metering";
import {
  genericEntitlementPolicyGuard,
  loadGenericEntitlementPolicies,
  prepareGenericCheckoutEntitlementStatements,
  type GenericEntitlementPolicySnapshot,
  type GenericEntitlementRequirementSnapshot,
} from "./entitlements";
import { prepareCheckoutReservationPlan, prepareReservedFulfillmentItems } from "./reservations";
import { assertSupportedFulfillmentComposition, normalizeCustomerEmail } from "./policy";

async function resolveOrderUsageLimit(database: D1Database, shopId: string): Promise<number | undefined> {
  try {
    const row = await database.prepare(`
      SELECT plans.code, plans.limits_json AS limitsJson
      FROM shop_subscriptions AS subscriptions
      INNER JOIN plans ON plans.id = subscriptions.plan_id
      WHERE subscriptions.shop_id = ? AND subscriptions.state != 'canceled'
      ORDER BY subscriptions.created_at DESC, subscriptions.id DESC
      LIMIT 1
    `).bind(shopId).first<{ code: string; limitsJson: string }>();
    if (row === null || !(PUBLIC_PLAN_CODES as readonly string[]).includes(row.code)) return undefined;
    const limits = parsePlanLimits(row.limitsJson);
    if (!limits.ok) throw new AppError("quota_unavailable", 503, ["orders_created"]);
    return limits.value.orders_created;
  } catch (error) {
    // The direct canonical test harness predates the billing catalog and
    // intentionally omits plans; real tenant databases always have it.
    if (error instanceof AppError) throw error;
    return undefined;
  }
}

/** Immutable catalog data copied into an order item during checkout. */
export type CanonicalCheckoutLine = {
  fulfillmentType: "license_key" | "manual";
  priceMinor: number;
  productId: string;
  productTitle: string;
  productVersion: number;
  quantity: number;
  sku: string;
  title: string;
  variantId: string;
  variantVersion: number;
};

/**
 * Immutable private-file policy values captured at checkout time. The
 * capability remains typed rather than being folded into a free-form payload.
 */
export type PrivateFileRequirementSnapshot = {
  assetVersionId: string;
  entitlementTtlSeconds: number | null;
  grantTtlSeconds: number;
  maxDownloads: number;
  policyId: string;
  policyVersion: number;
};

/** Customer state needed by the transaction, independent of the channel. */
export type CanonicalCheckoutCustomer =
  | { kind: "anonymous"; maskedEmail: null }
  | { kind: "existing"; customerId: string; maskedEmail: string | null }
  | { emailNormalized: string; id: string; kind: "upsert_email"; maskedEmail: string; locale: string };

export type CanonicalCheckoutEffects = {
  /** Statements specific to a channel, appended after attribution and cart conversion. */
  afterCartConversion?: readonly D1PreparedStatement[];
  /** Compatibility work that is only needed for a free checkout. */
  afterFreePayment?: readonly D1PreparedStatement[];
};

export type CanonicalCheckoutTransactionInput = {
  channel: {
    code: string;
    connectionId: string | null;
    /** Explicit attribution is required for non-built-in adapters. */
    attribution?: OrderChannelAttribution;
  };
  checkoutRequestHash: string;
  checkoutSubjectHash: string;
  effects?: CanonicalCheckoutEffects;
  env: AppBindings;
  eventIdempotencyKey: string;
  expiresAt: string;
  fulfillmentIdempotencyPrefix: string;
  locale: string;
  nowIso: string;
  orderId: string;
  orderPublicId: string;
  orderTokenHash: string;
  shopId: string;
  cartId: string;
  cartSnapshot: {
    discountCode: string | null;
  };
  currency: string;
  customer: CanonicalCheckoutCustomer;
  discountMinor: number;
  reservationToken: string;
  lines: readonly CanonicalCheckoutLine[];
  subtotalMinor: number;
  totalMinor: number;
};

export type CanonicalCheckoutTransactionResult = {
  currency: string;
  expiresAt: string;
  fulfillmentStatus: "fulfilled" | "reserved" | "unfulfilled";
  orderId: string;
  orderNumber: string;
  paymentStatus: "paid" | "unpaid";
  status: "completed" | "pending_payment" | "processing";
  totalMinor: number;
};

type CustomerSql = {
  guardBindings: unknown[];
  guardSql: string;
  lookupBindings: unknown[];
  lookupSql: string;
  statement: D1PreparedStatement | null;
  valueBindings: unknown[];
};

function customerSql(input: CanonicalCheckoutTransactionInput): CustomerSql {
  const customer = input.customer;
  if (customer.kind === "anonymous") {
    return {
      guardBindings: [],
      guardSql: "1 = 1",
      lookupBindings: [],
      lookupSql: "NULL",
      statement: null,
      valueBindings: [],
    };
  }
  if (customer.kind === "existing") {
    return {
      guardBindings: [input.shopId, customer.customerId],
      guardSql: "EXISTS (SELECT 1 FROM shop_customers WHERE shop_id = ? AND id = ? AND status = 'active')",
      lookupBindings: [],
      lookupSql: "?",
      statement: null,
      valueBindings: [customer.customerId],
    };
  }
  return {
    guardBindings: [input.shopId, customer.emailNormalized],
    guardSql: "EXISTS (SELECT 1 FROM shop_customers WHERE shop_id = ? AND email_normalized = ? AND status = 'active')",
    lookupBindings: [input.shopId, customer.emailNormalized],
    lookupSql: "(SELECT id FROM shop_customers WHERE shop_id = ? AND email_normalized = ? LIMIT 1)",
    statement: input.env.PLATFORM_DB.prepare("INSERT INTO shop_customers (id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 'active', ?, ?) ON CONFLICT(shop_id, email_normalized) DO UPDATE SET locale = excluded.locale, updated_at = excluded.updated_at WHERE shop_customers.status = 'active'").bind(customer.id, input.shopId, customer.emailNormalized, customer.locale, input.nowIso, input.nowIso),
    valueBindings: [],
  };
}

function resolveChannelAttribution(channel: CanonicalCheckoutTransactionInput["channel"]): OrderChannelAttribution {
  if (channel.attribution !== undefined) return channel.attribution;
  if (channel.code === "telegram" || channel.code === "website") {
    return resolveOrderChannelAttribution(channel.code);
  }
  throw new Error("canonical_checkout_attribution_missing");
}

type PrivateFileRequirementState = {
  available: boolean;
  snapshots: Map<string, PrivateFileRequirementSnapshot>;
};

type GenericEntitlementPolicyState = {
  available: boolean;
  snapshots: Map<string, GenericEntitlementPolicySnapshot[]>;
};

async function loadPrivateFileRequirements(input: CanonicalCheckoutTransactionInput): Promise<PrivateFileRequirementState> {
  const schema = await input.env.PLATFORM_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'product_fulfillment_policies' LIMIT 1").first<{ name: string }>();
  if (schema === null) return { available: false, snapshots: new Map() };
  const productIds = [...new Set(input.lines.filter((line) => line.fulfillmentType === "manual").map((line) => line.productId))];
  if (productIds.length === 0) return { available: true, snapshots: new Map() };
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT policies.product_id AS productId,
      policies.id AS policyId, policies.policy_version AS policyVersion,
      policies.asset_version_id AS assetVersionId,
      policies.max_downloads AS maxDownloads,
      policies.grant_ttl_seconds AS grantTtlSeconds,
      policies.entitlement_ttl_seconds AS entitlementTtlSeconds,
      digital_assets.status AS assetStatus,
      digital_asset_versions.status AS assetVersionStatus
    FROM product_fulfillment_policies AS policies
    INNER JOIN digital_asset_versions
      ON digital_asset_versions.id = policies.asset_version_id
      AND digital_asset_versions.shop_id = policies.shop_id
    INNER JOIN digital_assets
      ON digital_assets.id = digital_asset_versions.asset_id
      AND digital_assets.shop_id = digital_asset_versions.shop_id
    WHERE policies.shop_id = ?
      AND policies.capability = 'private_file'
      AND policies.status = 'active'
      AND policies.product_id IN (${productIds.map(() => "?").join(",")})
  `).bind(input.shopId, ...productIds).all<{
    assetStatus: string;
    assetVersionId: string;
    assetVersionStatus: string;
    entitlementTtlSeconds: number | null;
    grantTtlSeconds: number;
    maxDownloads: number;
    policyId: string;
    policyVersion: number;
    productId: string;
  }>();
  const result = new Map<string, PrivateFileRequirementSnapshot>();
  for (const row of rows.results) {
    if (row.assetStatus !== "active" || row.assetVersionStatus !== "active") throw new Error("canonical_checkout_private_file_policy_invalid");
    if (result.has(row.productId)) throw new Error("canonical_checkout_private_file_policy_ambiguous");
    result.set(row.productId, {
      assetVersionId: row.assetVersionId,
      entitlementTtlSeconds: row.entitlementTtlSeconds,
      grantTtlSeconds: row.grantTtlSeconds,
      maxDownloads: row.maxDownloads,
      policyId: row.policyId,
      policyVersion: row.policyVersion,
    });
  }
  return { available: true, snapshots: result };
}

function privateFilePolicyGuard(input: {
  line: CanonicalCheckoutLine;
  schemaAvailable: boolean;
  snapshot: PrivateFileRequirementSnapshot | undefined;
}): { bindings: unknown[]; sql: string } {
  if (!input.schemaAvailable || input.line.fulfillmentType !== "manual") return { bindings: [], sql: "1 = 1" };
  if (input.snapshot === undefined) {
    return {
      bindings: [],
      sql: `NOT EXISTS (
        SELECT 1 FROM product_fulfillment_policies AS private_policy
        WHERE private_policy.shop_id = product.shop_id
          AND private_policy.capability = 'private_file'
          AND private_policy.product_id = product.id
          AND private_policy.status = 'active'
      )`,
    };
  }
  return {
    bindings: [input.snapshot.policyId, input.snapshot.policyVersion, input.snapshot.assetVersionId, input.snapshot.maxDownloads, input.snapshot.grantTtlSeconds, input.snapshot.entitlementTtlSeconds],
    sql: `EXISTS (
      SELECT 1
      FROM product_fulfillment_policies AS private_policy
      INNER JOIN digital_asset_versions AS private_version
        ON private_version.id = private_policy.asset_version_id
        AND private_version.shop_id = private_policy.shop_id
      INNER JOIN digital_assets AS private_asset
        ON private_asset.id = private_version.asset_id
        AND private_asset.shop_id = private_version.shop_id
      WHERE private_policy.shop_id = product.shop_id
        AND private_policy.product_id = product.id
        AND private_policy.id = ?
        AND private_policy.capability = 'private_file'
        AND private_policy.status = 'active'
        AND private_policy.policy_version = ?
        AND private_policy.asset_version_id = ?
        AND private_policy.max_downloads = ?
        AND private_policy.grant_ttl_seconds = ?
        AND private_policy.entitlement_ttl_seconds IS ?
        AND private_version.status = 'active'
        AND private_asset.status = 'active'
    )`,
  };
}

function cartSnapshotGuard(
  input: CanonicalCheckoutTransactionInput,
  attribution: OrderChannelAttribution,
  privateFileRequirementState: PrivateFileRequirementState,
  genericEntitlementPolicyState: GenericEntitlementPolicyState,
): { bindings: unknown[]; sql: string } {
  const policyGuards = input.lines.map((line) => privateFilePolicyGuard({
    line,
    schemaAvailable: privateFileRequirementState.available,
    snapshot: privateFileRequirementState.snapshots.get(line.productId),
  }));
  const genericPolicyGuards = input.lines.map((line) => genericEntitlementPolicyGuard({
    line,
    schemaAvailable: genericEntitlementPolicyState.available,
    snapshots: genericEntitlementPolicyState.snapshots.get(line.productId),
  }));
  const itemGuards = policyGuards.map((policyGuard, index) => `EXISTS (
    SELECT 1
    FROM cart_items AS cart_item
    INNER JOIN product_variants AS variant
      ON variant.id = cart_item.variant_id AND variant.shop_id = cart_item.shop_id
    INNER JOIN products AS product
      ON product.id = variant.product_id AND product.shop_id = variant.shop_id
    WHERE cart_item.cart_id = ? AND cart_item.shop_id = ?
      AND cart_item.variant_id = ? AND cart_item.quantity = ?
      AND product.id = ? AND product.fulfillment_type = ? AND product.version = ?
      AND variant.status = 'active' AND product.status = 'active'
      AND cart_item.quantity BETWEEN variant.min_per_order AND variant.max_per_order
      AND variant.price_minor = ? AND variant.version = ?
      AND variant.currency = ?
      AND ${policyGuard.sql}
      AND ${genericPolicyGuards[index]?.sql ?? "1 = 1"}
  )`).join(" AND ");
  const bindings: unknown[] = [
    input.cartId,
    input.shopId,
    attribution.legacySourceChannel,
    input.nowIso,
    input.cartSnapshot.discountCode,
    input.currency,
    input.subtotalMinor,
    input.subtotalMinor,
    input.subtotalMinor,
    input.subtotalMinor,
    input.shopId,
    input.cartSnapshot.discountCode,
    input.nowIso,
    input.nowIso,
    input.discountMinor,
    input.cartId,
    input.shopId,
    input.lines.length,
  ];
  for (const [index, line] of input.lines.entries()) {
    bindings.push(
      input.cartId,
      input.shopId,
      line.variantId,
      line.quantity,
      line.productId,
      line.fulfillmentType,
      line.productVersion,
      line.priceMinor,
      line.variantVersion,
      input.currency,
    );
    bindings.push(...(policyGuards[index]?.bindings ?? []));
    bindings.push(...(genericPolicyGuards[index]?.bindings ?? []));
  }
  return {
    bindings,
    sql: `EXISTS (
      SELECT 1 FROM carts
      WHERE id = ? AND shop_id = ? AND channel = ?
        AND state = 'active' AND expires_at > ?
        AND discount_code_normalized IS ?
        AND COALESCE((
          SELECT CASE
            WHEN discount.currency IS NOT NULL AND discount.currency != ? THEN 0
            WHEN ? < discount.minimum_minor THEN 0
            WHEN discount.type = 'percentage' THEN MIN(?, CAST(? * MIN(discount.value, 10000) / 10000 AS INTEGER))
            WHEN discount.type = 'fixed' THEN MIN(?, discount.value)
            ELSE 0
          END
          FROM discounts AS discount
          WHERE discount.shop_id = ? AND discount.code_normalized IS ?
            AND discount.status = 'active'
            AND (discount.starts_at IS NULL OR discount.starts_at <= ?)
            AND (discount.ends_at IS NULL OR discount.ends_at > ?)
          LIMIT 1
        ), 0) = ?
    )
    AND (SELECT COUNT(*) FROM cart_items WHERE cart_id = ? AND shop_id = ?) = ?
    AND ${itemGuards}`,
  };
}

function assertInputInvariants(input: CanonicalCheckoutTransactionInput): void {
  if (input.channel.code === WEBSITE_CHANNEL_CODE) {
    if (input.customer.kind === "anonymous") throw new AppError("validation_failed", 400, ["email_required"]);
    if (input.customer.kind === "upsert_email") {
      const normalizedEmail = normalizeCustomerEmail(input.customer.emailNormalized);
      if (normalizedEmail === null) throw new AppError("validation_failed", 400, ["email_required"]);
      if (normalizedEmail !== input.customer.emailNormalized) throw new AppError("validation_failed", 400, ["email_invalid"]);
    }
  }
  if (input.lines.length === 0 || input.lines.some((line) => !Number.isInteger(line.quantity) || line.quantity <= 0)) throw new Error("canonical_checkout_lines_invalid");
  if (input.lines.some((line) => !Number.isSafeInteger(line.productVersion) || line.productVersion < 1 || !Number.isSafeInteger(line.variantVersion) || line.variantVersion < 1) || new Set(input.lines.map((line) => line.variantId)).size !== input.lines.length) throw new Error("canonical_checkout_lines_invalid");
  const computedSubtotal = input.lines.reduce((sum, line) => sum + line.priceMinor * line.quantity, 0);
  if (computedSubtotal !== input.subtotalMinor || !Number.isInteger(input.discountMinor) || input.discountMinor < 0 || input.discountMinor > input.subtotalMinor || input.totalMinor !== input.subtotalMinor - input.discountMinor) throw new Error("canonical_checkout_amounts_invalid");
  if (input.currency.length === 0 || input.fulfillmentIdempotencyPrefix.length === 0) throw new Error("canonical_checkout_metadata_invalid");
  assertSupportedFulfillmentComposition(input.lines);
}

async function assertCustomerCheckoutAllowed(input: CanonicalCheckoutTransactionInput): Promise<void> {
  if (input.customer.kind === "anonymous") return;
  const row = input.customer.kind === "existing"
    ? await input.env.PLATFORM_DB.prepare("SELECT status FROM shop_customers WHERE shop_id = ? AND id = ? LIMIT 1").bind(input.shopId, input.customer.customerId).first<{ status: string }>()
    : await input.env.PLATFORM_DB.prepare("SELECT status FROM shop_customers WHERE shop_id = ? AND email_normalized = ? LIMIT 1").bind(input.shopId, input.customer.emailNormalized).first<{ status: string }>();
  if (row?.status === "blocked") throw new AppError("customer_blocked", 403, ["checkout_not_available"]);
}

/**
 * Commit one provider-neutral checkout transaction. Adapters must perform
 * admission, quote/snapshot checks, token derivation, replay recovery, and
 * contention classification around this function.
 */
export async function executeCanonicalCheckoutTransaction(input: CanonicalCheckoutTransactionInput): Promise<CanonicalCheckoutTransactionResult> {
  assertInputInvariants(input);
  await assertCustomerCheckoutAllowed(input);
  const database = input.env.PLATFORM_DB;
  // External channel adapters already admit an active subscription. The
  // direct core harness may intentionally omit one, so retain compatibility
  // there while real checkout paths still append an atomic usage event.
  let orderUsageStatements: readonly D1PreparedStatement[] = [];
  try {
    const periodKey = await resolveBillingPeriod({ database, shopId: input.shopId });
    const orderUsageLimit = await resolveOrderUsageLimit(database, input.shopId);
    orderUsageStatements = prepareUsageStatements({
      database,
      delta: 1,
      ...(orderUsageLimit === undefined ? {} : { limit: orderUsageLimit }),
      metric: "orders_created",
      occurredAt: input.nowIso,
      periodKey,
      shopId: input.shopId,
      sourceId: input.orderId,
      sourceKind: "order",
      now: new Date(input.nowIso),
    }).statements;
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "billing_period_unavailable") throw error;
  }
  const attribution = resolveChannelAttribution(input.channel);
  const [privateFileRequirementState, genericEntitlementPolicyState] = await Promise.all([
    loadPrivateFileRequirements(input),
    loadGenericEntitlementPolicies({
      database,
      productIds: input.lines.map((line) => line.productId),
      shopId: input.shopId,
    }),
  ]);
  if (input.channel.code === "telegram" && privateFileRequirementState.snapshots.size > 0) {
    throw new AppError("telegram_private_file_unsupported", 409, ["use_website_checkout"]);
  }
  const customer = customerSql(input);
  const orderItems = input.lines.map((line) => ({ id: createId("oit"), line }));
  const genericEntitlementRequirements = orderItems.flatMap((item) => (
    genericEntitlementPolicyState.snapshots.get(item.line.productId) ?? []
  ).map<GenericEntitlementRequirementSnapshot & { orderItemId: string }>((policy) => ({
    ...policy,
    grantQuantity: item.line.quantity * policy.grantQuantityPerUnit,
    itemQuantity: item.line.quantity,
    orderItemId: item.id,
    productId: item.line.productId,
    requirementId: createId("oer"),
  })));
  const reservationPlan = prepareCheckoutReservationPlan({
    env: input.env,
    expiresAt: input.expiresAt,
    items: orderItems
      .filter((item) => item.line.fulfillmentType === "license_key")
      .map((item) => ({ orderItemId: item.id, quantity: item.line.quantity, variantId: item.line.variantId })),
    reservationToken: input.reservationToken,
    shopId: input.shopId,
  });
  const isFree = input.totalMinor === 0;
  const hasPrivateFileFulfillment = orderItems.some((item) =>
    privateFileRequirementState.snapshots.has(item.line.productId));
  const hasManualFulfillment = orderItems.some((item) => {
    if (item.line.fulfillmentType !== "manual") return false;
    const hasPrivateFilePolicy = privateFileRequirementState.snapshots.has(item.line.productId);
    const hasGenericPolicy = (genericEntitlementPolicyState.snapshots.get(item.line.productId)?.length ?? 0) > 0;
    return !hasPrivateFilePolicy && !hasGenericPolicy;
  });
  const hasGeneratedLicenseFulfillment = orderItems.some((item) =>
    genericEntitlementPolicyState.snapshots.get(item.line.productId)
      ?.some((policy) => policy.resourceType === "generated_license") === true);
  const requiredLicenseKeys = reservationPlan.requiredKeyCount;
  const isAutoFulfilled = isFree
    && !hasManualFulfillment
    && !hasGeneratedLicenseFulfillment
    && (requiredLicenseKeys > 0 || genericEntitlementRequirements.length > 0 || hasPrivateFileFulfillment);
  const orderCreatedEvent = await prepareDomainEventAppend({
    aggregateId: input.orderId,
    aggregateType: "order",
    createdAt: input.nowIso,
    database,
    eventType: "order.created",
    idempotencyKeyHash: input.eventIdempotencyKey,
    occurredAt: input.nowIso,
    shopId: input.shopId,
    sourceConnectionId: input.channel.connectionId,
  });
  const orderPaidEvent = isFree ? await prepareDomainEventAppend({
    aggregateId: input.orderId,
    aggregateType: "order",
    createdAt: input.nowIso,
    database,
    eventType: "order.paid",
    idempotencyKeyHash: `${input.eventIdempotencyKey}:paid`,
    occurredAt: input.nowIso,
    shopId: input.shopId,
    sourceConnectionId: input.channel.connectionId,
  }) : null;
  const digitalFulfillmentId = isFree && requiredLicenseKeys > 0 ? createId("ful") : null;
  const manualFulfillmentId = isFree && hasManualFulfillment ? createId("ful") : null;
  const status = isFree ? (isAutoFulfilled ? "completed" : "processing") : "pending_payment";
  const paymentStatus = isFree ? "paid" : "unpaid";
  const fulfillmentStatus = isFree ? (isAutoFulfilled ? "fulfilled" : "unfulfilled") : "reserved";
  const customerIdBindings = customer.valueBindings;
  const customerLookupBindings = customer.lookupBindings;
  const customerGuardBindings = customer.guardBindings;
  const snapshotGuard = cartSnapshotGuard(input, attribution, privateFileRequirementState, genericEntitlementPolicyState);
  const genericEntitlementStatements = await prepareGenericCheckoutEntitlementStatements({
    database,
    isFree,
    nowIso: input.nowIso,
    orderId: input.orderId,
    orderPublicId: input.orderPublicId,
    orderTokenHash: input.orderTokenHash,
    requestHash: input.checkoutRequestHash,
    requirements: genericEntitlementRequirements,
    shopId: input.shopId,
    sourceIdempotencyHash: input.eventIdempotencyKey,
  });
  const orderInsert = database.prepare(`INSERT INTO orders (id, public_id, shop_id, customer_id, order_number, source_channel, status, payment_status, fulfillment_status, subtotal_minor, discount_minor, total_minor, currency, locale, customer_email_masked, checkout_subject_hash, checkout_request_hash, checkout_cart_id, order_token_hash, expires_at, paid_at, fulfilled_at, created_at, updated_at) SELECT ?, ?, ?, ${customer.lookupSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${snapshotGuard.sql} AND ${customer.guardSql} AND ${reservationPlan.guardSql}`).bind(
    input.orderId,
    input.orderPublicId,
    input.shopId,
    ...customerIdBindings,
    ...customerLookupBindings,
    input.orderPublicId.slice(-12).toUpperCase(),
    attribution.legacySourceChannel,
    status,
    paymentStatus,
    fulfillmentStatus,
    input.subtotalMinor,
    input.discountMinor,
    input.totalMinor,
    input.currency,
    input.locale,
    input.customer.maskedEmail,
    input.checkoutSubjectHash,
    input.checkoutRequestHash,
    input.cartId,
    input.orderTokenHash,
    input.expiresAt,
    isFree ? input.nowIso : null,
    isAutoFulfilled ? input.nowIso : null,
    input.nowIso,
    input.nowIso,
    ...snapshotGuard.bindings,
    ...customerGuardBindings,
    ...reservationPlan.guardBindings,
  );
  const statements: D1PreparedStatement[] = [
    ...(customer.statement === null ? [] : [customer.statement]),
    ...reservationPlan.statements,
    // Keep this FK-backed statement immediately after the guarded order insert:
    // a failed cart/customer/reservation guard aborts the whole D1 batch.
    orderInsert,
    ...orderUsageStatements,
    prepareOrderChannelAttribution({
      attribution,
      connectionId: input.channel.connectionId,
      createdAt: input.nowIso,
      database,
      orderId: input.orderId,
      shopId: input.shopId,
    }),
    ...orderItems.map((item) => database.prepare("INSERT INTO order_items (id, shop_id, order_id, product_id, variant_id, product_title, variant_title, sku, unit_price_minor, quantity, line_total_minor, fulfillment_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(item.id, input.shopId, input.orderId, item.line.productId, item.line.variantId, item.line.productTitle, item.line.title, item.line.sku, item.line.priceMinor, item.line.quantity, item.line.priceMinor * item.line.quantity, item.line.fulfillmentType, input.nowIso)),
    ...orderItems.flatMap((item) => {
      const requirement = privateFileRequirementState.snapshots.get(item.line.productId);
      if (requirement === undefined) return [];
      return [database.prepare(`
        INSERT INTO order_item_fulfillment_requirements (
          id, shop_id, order_id, order_item_id, capability, policy_id,
          policy_version, asset_version_id, max_downloads, grant_ttl_seconds,
          entitlement_ttl_seconds, created_at
        ) VALUES (?, ?, ?, ?, 'private_file', ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        createId("ofr"), input.shopId, input.orderId, item.id,
        requirement.policyId, requirement.policyVersion,
        requirement.assetVersionId, requirement.maxDownloads,
        requirement.grantTtlSeconds, requirement.entitlementTtlSeconds,
        input.nowIso,
      )];
    }),
    ...genericEntitlementRequirements.map((requirement) => database.prepare(`
      INSERT INTO order_item_entitlement_requirements (
        id, shop_id, order_id, order_item_id, policy_id, resource_id,
        policy_version, activation_condition, item_quantity, grant_quantity,
        entitlement_ttl_seconds, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'order_paid', ?, ?, ?, ?)
    `).bind(
      requirement.requirementId,
      input.shopId,
      input.orderId,
      requirement.orderItemId,
      requirement.policyId,
      requirement.resourceId,
      requirement.policyVersion,
      requirement.itemQuantity,
      requirement.grantQuantity,
      requirement.entitlementTtlSeconds,
      input.nowIso,
    )),
    ...genericEntitlementStatements,
    orderCreatedEvent,
    ...(orderPaidEvent === null ? [] : [orderPaidEvent]),
    database.prepare("UPDATE carts SET state = 'converted', updated_at = ? WHERE id = ? AND shop_id = ? AND state = 'active'").bind(input.nowIso, input.cartId, input.shopId),
    ...(input.effects?.afterCartConversion ?? []),
  ];
  if (isFree) {
    statements.push(...(input.effects?.afterFreePayment ?? []));
    if (digitalFulfillmentId !== null) {
      statements.push(
        database.prepare("INSERT INTO fulfillments (id, shop_id, order_id, fulfillment_type, state, idempotency_key, created_at, fulfilled_at) VALUES (?, ?, ?, 'digital_keys', 'fulfilled', ?, ?, ?)").bind(digitalFulfillmentId, input.shopId, input.orderId, `${input.fulfillmentIdempotencyPrefix}:${input.orderId}`, input.nowIso, input.nowIso),
        prepareReservedFulfillmentItems({ createdAt: input.nowIso, deliveredAt: input.nowIso, env: input.env, fulfillmentId: digitalFulfillmentId, reservationToken: input.reservationToken, shopId: input.shopId }),
      );
    }
    if (manualFulfillmentId !== null) statements.push(database.prepare("INSERT INTO fulfillments (id, shop_id, order_id, fulfillment_type, state, idempotency_key, created_at) VALUES (?, ?, ?, 'manual', 'pending', ?, ?)").bind(manualFulfillmentId, input.shopId, input.orderId, `${input.fulfillmentIdempotencyPrefix}:${input.orderId}:manual`, input.nowIso));
    statements.push(database.prepare("UPDATE inventory_keys SET status = 'sold', sold_order_item_id = reserved_order_item_id, sold_at = ?, reservation_token = NULL, reserved_until = NULL WHERE reservation_token = ? AND shop_id = ? AND status = 'reserved'").bind(input.nowIso, input.reservationToken, input.shopId));
  }
  await database.batch(statements);
  const channelProjection = input.channel.code === "web"
    ? "website"
    : input.channel.code === "telegram" ? "telegram" : null;
  const currencyProjection = isSupportedCurrency(input.currency) ? input.currency : null;
  await tryRecordActivationMilestone({
    env: input.env,
    idempotencyKey: "first_order_created",
    milestone: "first_order_created",
    projection: {
      ...(currencyProjection === null ? {} : { currency: currencyProjection }),
      ...(channelProjection === null ? {} : { channel: channelProjection }),
    },
    reason: "created",
    shopId: input.shopId,
    source: "commerce",
  });
  return {
    currency: input.currency,
    expiresAt: input.expiresAt,
    fulfillmentStatus,
    orderId: input.orderPublicId,
    orderNumber: input.orderPublicId.slice(-12).toUpperCase(),
    paymentStatus,
    status,
    totalMinor: input.totalMinor,
  };
}
