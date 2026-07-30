import { sha256Json } from "../core/crypto";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import {
  prepareGeneratedLicenseRequestStatements,
  prepareGeneratedLicenseRequirementStatements,
} from "./generated-license";

export type GenericEntitlementPolicySnapshot = {
  entitlementTtlSeconds: number | null;
  grantQuantityPerUnit: number;
  policyId: string;
  policyVersion: number;
  resourceId: string;
  resourceType?: "community_access" | "device_activation" | "generated_license" | "membership" | "provider_access" | "seat";
};

export type GenericEntitlementRequirementSnapshot = GenericEntitlementPolicySnapshot & {
  grantQuantity: number;
  itemQuantity: number;
  productId: string;
  requirementId: string;
};

type DatabaseLike = AppBindings["PLATFORM_DB"];

function addSeconds(nowIso: string, seconds: number | null): string | null {
  if (seconds === null) return null;
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) throw new Error("entitlement_activation_time_invalid");
  return new Date(now + seconds * 1000).toISOString();
}

async function hasGenericEntitlementSchema(database: DatabaseLike): Promise<boolean> {
  const row = await database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'product_entitlement_policies' LIMIT 1",
  ).first<{ name: string }>();
  return row !== null;
}

export async function loadGenericEntitlementPolicies(input: {
  database: DatabaseLike;
  productIds: readonly string[];
  shopId: string;
}): Promise<{ available: boolean; snapshots: Map<string, GenericEntitlementPolicySnapshot[]> }> {
  const available = await hasGenericEntitlementSchema(input.database);
  if (!available || input.productIds.length === 0) return { available, snapshots: new Map() };
  const ids = [...new Set(input.productIds)];
  const rows = await input.database.prepare(`
    SELECT policies.product_id AS productId,
      policies.id AS policyId,
      policies.policy_version AS policyVersion,
      policies.resource_id AS resourceId,
      policies.grant_quantity_per_unit AS grantQuantityPerUnit,
      policies.entitlement_ttl_seconds AS entitlementTtlSeconds,
      resources.resource_type AS resourceType,
      resources.status AS resourceStatus
    FROM product_entitlement_policies AS policies
    INNER JOIN entitlement_resources AS resources
      ON resources.id = policies.resource_id
      AND resources.shop_id = policies.shop_id
    WHERE policies.shop_id = ?
      AND policies.status = 'active'
      AND resources.status = 'active'
      AND policies.product_id IN (${ids.map(() => "?").join(",")})
    ORDER BY policies.product_id, policies.resource_id, policies.id
  `).bind(input.shopId, ...ids).all<{
    entitlementTtlSeconds: number | null;
    grantQuantityPerUnit: number;
    policyId: string;
    policyVersion: number;
    productId: string;
    resourceId: string;
    resourceStatus: string;
    resourceType: NonNullable<GenericEntitlementPolicySnapshot["resourceType"]>;
  }>();
  const snapshots = new Map<string, GenericEntitlementPolicySnapshot[]>();
  for (const row of rows.results) {
    if (row.resourceStatus !== "active") throw new Error("entitlement_resource_ineligible");
    const list = snapshots.get(row.productId) ?? [];
    list.push({
      entitlementTtlSeconds: row.entitlementTtlSeconds,
      grantQuantityPerUnit: row.grantQuantityPerUnit,
      policyId: row.policyId,
      policyVersion: row.policyVersion,
      resourceId: row.resourceId,
      resourceType: row.resourceType,
    });
    snapshots.set(row.productId, list);
  }
  return { available, snapshots };
}

/** Guard one catalog line against policy drift, including added policies. */
export function genericEntitlementPolicyGuard(input: {
  line: { productId: string };
  schemaAvailable: boolean;
  snapshots: readonly GenericEntitlementPolicySnapshot[] | undefined;
}): { bindings: unknown[]; sql: string } {
  if (!input.schemaAvailable) return { bindings: [], sql: "1 = 1" };
  const snapshots = input.snapshots ?? [];
  if (snapshots.length === 0) {
    return {
      bindings: [],
      sql: `NOT EXISTS (
        SELECT 1 FROM product_entitlement_policies AS generic_policy
        WHERE generic_policy.shop_id = product.shop_id
          AND generic_policy.product_id = product.id
          AND generic_policy.status = 'active'
      )`,
    };
  }
  const bindings: unknown[] = [snapshots.length];
  const clauses = snapshots.map((snapshot) => {
    bindings.push(snapshot.policyId, snapshot.policyVersion, snapshot.resourceId, snapshot.grantQuantityPerUnit, snapshot.entitlementTtlSeconds);
    return `EXISTS (
      SELECT 1
      FROM product_entitlement_policies AS generic_policy
      INNER JOIN entitlement_resources AS generic_resource
        ON generic_resource.id = generic_policy.resource_id
        AND generic_resource.shop_id = generic_policy.shop_id
      WHERE generic_policy.shop_id = product.shop_id
        AND generic_policy.product_id = product.id
        AND generic_policy.id = ?
        AND generic_policy.policy_version = ?
        AND generic_policy.resource_id = ?
        AND generic_policy.grant_quantity_per_unit = ?
        AND generic_policy.entitlement_ttl_seconds IS ?
        AND generic_policy.status = 'active'
        AND generic_resource.status = 'active'
    )`;
  });
  return {
    bindings,
    sql: `(SELECT COUNT(*) FROM product_entitlement_policies AS generic_count
      WHERE generic_count.shop_id = product.shop_id
        AND generic_count.product_id = product.id
        AND generic_count.status = 'active') = ? AND ${clauses.join(" AND ")}`,
  };
}

type CheckoutRequirementInput = GenericEntitlementRequirementSnapshot & {
  orderItemId: string;
};

async function deriveActivationHashes(input: {
  baseIdempotencyHash: string;
  baseRequestHash: string;
  requirementId: string;
}): Promise<{ idempotencyKeyHash: string; requestHash: string }> {
  const [idempotencyKeyHash, requestHash] = await Promise.all([
    sha256Json({ base: input.baseIdempotencyHash, purpose: "generic-entitlement-grant", requirementId: input.requirementId }),
    sha256Json({ base: input.baseRequestHash, purpose: "generic-entitlement-grant-request", requirementId: input.requirementId }),
  ]);
  return { idempotencyKeyHash, requestHash };
}

/**
 * Materializes a requirement's pending/active entitlement in the same checkout
 * batch. Paid orders deliberately receive no grant until exact payment.
 */
export async function prepareGenericCheckoutEntitlementStatements(input: {
  database: DatabaseLike;
  isFree: boolean;
  nowIso: string;
  orderId: string;
  orderPublicId: string;
  orderTokenHash: string;
  requestHash: string;
  requirements: readonly CheckoutRequirementInput[];
  shopId: string;
  sourceIdempotencyHash: string;
}): Promise<ReadonlyArray<D1PreparedStatement>> {
  const statements: D1PreparedStatement[] = [];
  for (const requirement of input.requirements) {
    const hashes = await deriveActivationHashes({
      baseIdempotencyHash: input.sourceIdempotencyHash,
      baseRequestHash: input.requestHash,
      requirementId: requirement.requirementId,
    });
    const entitlementId = createId("ent");
    const transitionId = createId("etr");
    const grantId = input.isFree ? createId("egr") : null;
    const activatedAt = input.isFree ? input.nowIso : null;
    const expiresAt = input.isFree ? addSeconds(input.nowIso, requirement.entitlementTtlSeconds) : null;
    statements.push(input.database.prepare(`
      INSERT INTO entitlements (
        id, shop_id, order_id, order_item_id, requirement_id, resource_id,
        customer_id, buyer_binding_hash, status, grant_quantity,
        entitlement_ttl_seconds, access_expires_at, activated_at,
        version, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, orders.customer_id, orders.order_token_hash,
        ?, ?, ?, ?, ?, 1, ?, ?
      FROM orders
      WHERE orders.id = ? AND orders.shop_id = ?
    `).bind(
      entitlementId,
      input.shopId,
      input.orderId,
      requirement.orderItemId,
      requirement.requirementId,
      requirement.resourceId,
      input.isFree ? "active" : "pending",
      requirement.grantQuantity,
      requirement.entitlementTtlSeconds,
      expiresAt,
      activatedAt,
      input.nowIso,
      input.nowIso,
      input.orderId,
      input.shopId,
    ));
    statements.push(...await prepareGeneratedLicenseRequirementStatements({
      database: input.database,
      entitlementId,
      nowIso: input.nowIso,
      requirementId: requirement.requirementId,
      shopId: input.shopId,
    }));
    if (input.isFree && grantId !== null) {
      statements.push(input.database.prepare(`
        INSERT INTO entitlement_grants (
          id, shop_id, entitlement_id, requirement_id, order_id, resource_id,
          source_kind, source_payment_event_id, idempotency_key_hash,
          request_hash, request_id, granted_quantity, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'free_checkout', NULL, ?, ?, ?, ?, ?)
      `).bind(
        grantId,
        input.shopId,
        entitlementId,
        requirement.requirementId,
        input.orderId,
        requirement.resourceId,
        hashes.idempotencyKeyHash,
        hashes.requestHash,
        input.orderPublicId,
        requirement.grantQuantity,
        input.nowIso,
      ));
    }
    statements.push(input.database.prepare(`
      INSERT INTO entitlement_transitions (
        id, shop_id, entitlement_id, requirement_id, resource_id,
        entitlement_version, from_status, to_status, source_grant_id,
        reason_code, idempotency_key_hash, request_hash, actor_kind,
        actor_user_id, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, 'system', NULL, ?, ?)
    `).bind(
      transitionId,
      input.shopId,
      entitlementId,
      requirement.requirementId,
      requirement.resourceId,
      input.isFree ? "active" : "pending",
      grantId,
      input.isFree ? "free_checkout_activated" : "checkout_pending",
      hashes.idempotencyKeyHash,
      hashes.requestHash,
      input.nowIso,
      input.nowIso,
    ));
    if (input.isFree && grantId !== null) {
      statements.push(...await prepareGeneratedLicenseRequestStatements({
        database: input.database,
        entitlementGrantId: grantId,
        entitlementId,
        nowIso: input.nowIso,
        orderId: input.orderId,
        requirementId: requirement.requirementId,
        shopId: input.shopId,
      }));
    }
  }
  return statements;
}

export async function prepareGenericPaidActivationStatements(input: {
  database: DatabaseLike;
  eventId: string;
  nowIso: string;
  orderId: string;
  requestHash: string;
  shopId: string;
  sourceIdempotencyHash: string;
}): Promise<ReadonlyArray<D1PreparedStatement>> {
  if (!(await hasGenericEntitlementSchema(input.database))) return [];
  const rows = await input.database.prepare(`
    SELECT entitlements.id AS entitlementId,
      entitlements.requirement_id AS requirementId,
      entitlements.resource_id AS resourceId,
      entitlements.grant_quantity AS grantQuantity,
      entitlements.entitlement_ttl_seconds AS entitlementTtlSeconds,
      entitlements.version AS version,
      requirements.order_item_id AS orderItemId
    FROM entitlements
    INNER JOIN order_item_entitlement_requirements AS requirements
      ON requirements.id = entitlements.requirement_id
      AND requirements.shop_id = entitlements.shop_id
    WHERE entitlements.shop_id = ?
      AND entitlements.order_id = ?
      AND entitlements.status = 'pending'
    ORDER BY entitlements.id
  `).bind(input.shopId, input.orderId).all<{
    entitlementId: string;
    entitlementTtlSeconds: number | null;
    grantQuantity: number;
    orderItemId: string;
    requirementId: string;
    resourceId: string;
    version: number;
  }>();
  const statements: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    const hashes = await deriveActivationHashes({
      baseIdempotencyHash: input.sourceIdempotencyHash,
      baseRequestHash: input.requestHash,
      requirementId: row.requirementId,
    });
    const grantId = createId("egr");
    const transitionId = createId("etr");
    const expiresAt = addSeconds(input.nowIso, row.entitlementTtlSeconds);
    const eventFence = `
      EXISTS (
        SELECT 1
        FROM payment_events AS claimed_event
        INNER JOIN payment_attempts AS claimed_attempt
          ON claimed_attempt.id = claimed_event.payment_attempt_id
          AND claimed_attempt.shop_id = claimed_event.shop_id
        WHERE claimed_event.id = ?
          AND claimed_event.shop_id = ?
          AND claimed_event.processing_token IS NOT NULL
          AND claimed_event.processed_at IS NULL
          AND claimed_event.signature_verified = 1
          AND claimed_attempt.order_id = ?
          AND claimed_attempt.state = 'paid_exact'
          AND claimed_attempt.paid_event_id = claimed_event.id
      )`;
    statements.push(input.database.prepare(`
      UPDATE entitlements
      SET status = 'active', activated_at = ?, access_expires_at = ?,
        version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND status = 'pending' AND version = ?
        AND EXISTS (
          SELECT 1 FROM orders
          WHERE orders.id = entitlements.order_id
            AND orders.shop_id = entitlements.shop_id
            AND orders.payment_status = 'paid'
            AND orders.status IN ('processing', 'completed')
        )
        AND ${eventFence}
    `).bind(
      input.nowIso,
      expiresAt,
      input.nowIso,
      row.entitlementId,
      input.shopId,
      row.version,
      input.eventId,
      input.shopId,
      input.orderId,
    ));
    statements.push(input.database.prepare(`
      INSERT INTO entitlement_grants (
        id, shop_id, entitlement_id, requirement_id, order_id, resource_id,
        source_kind, source_payment_event_id, idempotency_key_hash,
        request_hash, request_id, granted_quantity, created_at
      ) SELECT ?, ?, ?, ?, ?, ?, 'payment_exact', ?, ?, ?, ?, ?, ?
      WHERE ${eventFence}
    `).bind(
      grantId,
      input.shopId,
      row.entitlementId,
      row.requirementId,
      input.orderId,
      row.resourceId,
      input.eventId,
      hashes.idempotencyKeyHash,
      hashes.requestHash,
      input.eventId,
      row.grantQuantity,
      input.nowIso,
      input.eventId,
      input.shopId,
      input.orderId,
    ));
    statements.push(input.database.prepare(`
      INSERT INTO entitlement_transitions (
        id, shop_id, entitlement_id, requirement_id, resource_id,
        entitlement_version, from_status, to_status, source_grant_id,
        reason_code, idempotency_key_hash, request_hash, actor_kind,
        actor_user_id, occurred_at, created_at
      ) SELECT ?, ?, ?, ?, ?, ?, 'pending', 'active', ?,
        'payment_exact_activated', ?, ?, 'system', NULL, ?, ?
      WHERE ${eventFence}
    `).bind(
      transitionId,
      input.shopId,
      row.entitlementId,
      row.requirementId,
      row.resourceId,
      row.version + 1,
      grantId,
      hashes.idempotencyKeyHash,
      hashes.requestHash,
      input.nowIso,
      input.nowIso,
      input.eventId,
      input.shopId,
      input.orderId,
    ));
    statements.push(...await prepareGeneratedLicenseRequestStatements({
      database: input.database,
      entitlementGrantId: grantId,
      entitlementId: row.entitlementId,
      nowIso: input.nowIso,
      orderId: input.orderId,
      requirementId: row.requirementId,
      shopId: input.shopId,
    }));
  }
  return statements;
}

export async function expireGenericEntitlements(input: {
  env: AppBindings;
  limit?: number;
  nowIso: string;
  shopId: string;
}): Promise<number> {
  try {
    if (!(await hasGenericEntitlementSchema(input.env.PLATFORM_DB))) return 0;
  } catch {
    return 0;
  }
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id, requirement_id AS requirementId, resource_id AS resourceId,
      status, version
    FROM entitlements
    WHERE shop_id = ?
      AND status IN ('active', 'suspended')
      AND access_expires_at IS NOT NULL
      AND access_expires_at <= ?
    ORDER BY access_expires_at, id
    LIMIT ?
  `).bind(input.shopId, input.nowIso, limit).all<{
    id: string;
    requirementId: string;
    resourceId: string;
    status: "active" | "suspended";
    version: number;
  }>();
  let expired = 0;
  for (const row of rows.results) {
    const keyHash = await sha256Json({ entitlementId: row.id, purpose: "generic-entitlement-expiry", shopId: input.shopId });
    const requestHash = await sha256Json({ entitlementId: row.id, nowIso: input.nowIso, purpose: "generic-entitlement-expiry" });
    const transitionId = createId("etr");
    const result = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        UPDATE entitlements
        SET status = 'expired', expired_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND shop_id = ? AND status = ? AND version = ?
          AND access_expires_at IS NOT NULL AND access_expires_at <= ?
      `).bind(input.nowIso, input.nowIso, row.id, input.shopId, row.status, row.version, input.nowIso),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO entitlement_transitions (
          id, shop_id, entitlement_id, requirement_id, resource_id,
          entitlement_version, from_status, to_status, source_grant_id,
          reason_code, idempotency_key_hash, request_hash, actor_kind,
          actor_user_id, occurred_at, created_at
        ) SELECT ?, ?, id, requirement_id, resource_id, version, ?, 'expired',
          NULL, 'ttl_expired', ?, ?, 'system', NULL, ?, ?
        FROM entitlements
        WHERE id = ? AND shop_id = ? AND status = 'expired' AND expired_at = ?
      `).bind(
        transitionId,
        input.shopId,
        row.status,
        keyHash,
        requestHash,
        input.nowIso,
        input.nowIso,
        row.id,
        input.shopId,
        input.nowIso,
      ),
    ]);
    if ((result[0]?.meta.changes ?? 0) === 1) expired += 1;
  }
  return expired;
}

/** Runs the bounded entitlement-expiry sweep for every tenant in one cron tick. */
export async function expireDueGenericEntitlements(input: {
  env: AppBindings;
  limitPerShop?: number;
  nowIso: string;
}): Promise<number> {
  try {
    if (!(await hasGenericEntitlementSchema(input.env.PLATFORM_DB))) return 0;
  } catch {
    return 0;
  }
  let rows: { id: string }[];
  try {
    rows = (await input.env.PLATFORM_DB.prepare(
      "SELECT id FROM shops WHERE status IN ('draft', 'active') ORDER BY id LIMIT 1000",
    ).all<{ id: string }>()).results;
  } catch {
    return 0;
  }
  let expired = 0;
  for (const row of rows) {
    const expiryInput: { env: AppBindings; limit?: number; nowIso: string; shopId: string } = {
      env: input.env,
      nowIso: input.nowIso,
      shopId: row.id,
    };
    if (input.limitPerShop !== undefined) expiryInput.limit = input.limitPerShop;
    expired += await expireGenericEntitlements(expiryInput);
  }
  return expired;
}
