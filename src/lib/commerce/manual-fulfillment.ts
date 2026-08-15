import { tryRecordFirstPaidFulfilled } from "../analytics/activation";
import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";

const EXECUTION_TYPE = "seller_attested_delivery" as const;
const REFERENCE_HASH_KEY_VERSION = "identifier-hmac-v1" as const;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/u;
const RESOURCE_ID_PATTERN = /^oit_[0-9a-f-]{36}$/u;

export const MANUAL_FULFILLMENT_REFERENCE_TYPES = [
  "merchant_reference",
  "delivery_reference",
  "support_ticket",
  "other",
] as const;

export type ManualFulfillmentReferenceType = typeof MANUAL_FULFILLMENT_REFERENCE_TYPES[number];

export type ManualFulfillmentExecutionInput = {
  executionType: typeof EXECUTION_TYPE;
  externalReference: {
    reference: string;
    type: ManualFulfillmentReferenceType;
  } | null;
  orderItemId: string;
};

export type ManualFulfillmentExecutionView = {
  completedAt: string;
  completedQuantity: number;
  evidence: { recorded: true; type: ManualFulfillmentReferenceType } | null;
  executionId: string;
  executionType: typeof EXECUTION_TYPE;
  orderItemId: string;
  state: "completed";
};

type ExecutionRow = {
  completedAt: string;
  completedQuantity: number;
  executionId: string;
  executionType: typeof EXECUTION_TYPE;
  orderItemId: string;
  referenceType: ManualFulfillmentReferenceType | null;
  requestHash: string;
  state: "completed";
};

type TargetRow = {
  fulfillmentId: string | null;
  fulfillmentState: string | null;
  fulfillmentType: string | null;
  hasGenericEntitlementRequirement: number;
  hasPrivateFileRequirement: number;
  itemFulfillmentType: string;
  orderId: string;
  orderStatus: string;
  paidAt: string | null;
  paymentStatus: string;
  quantity: number;
  shopStatus: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], issue: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new AppError("validation_failed", 400, [`${issue}:${unknown}`]);
}

function parseReferenceType(value: unknown): ManualFulfillmentReferenceType {
  if (typeof value !== "string" || !MANUAL_FULFILLMENT_REFERENCE_TYPES.includes(value as ManualFulfillmentReferenceType)) {
    throw new AppError("validation_failed", 400, ["external_reference_type_invalid"]);
  }
  return value as ManualFulfillmentReferenceType;
}

function normalizeExternalReference(value: unknown): ManualFulfillmentExecutionInput["externalReference"] {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new AppError("validation_failed", 400, ["external_reference_invalid"]);
  assertExactKeys(value, ["reference", "type"], "unknown_external_reference_field");
  const type = parseReferenceType(value.type);
  if (typeof value.reference !== "string") {
    throw new AppError("validation_failed", 400, ["external_reference_required"]);
  }
  const reference = value.reference.trim();
  const byteLength = new TextEncoder().encode(reference).byteLength;
  let hasControlCharacter = false;
  for (let index = 0; index < reference.length; index += 1) {
    const codeUnit = reference.charCodeAt(index);
    if (codeUnit < 32 || codeUnit === 127) {
      hasControlCharacter = true;
      break;
    }
  }
  if (reference.length === 0 || byteLength > 512 || hasControlCharacter) {
    throw new AppError("validation_failed", 400, ["external_reference_invalid"]);
  }
  return { reference, type };
}

export function parseManualFulfillmentExecutionInput(value: Record<string, unknown>): ManualFulfillmentExecutionInput {
  assertExactKeys(value, ["executionType", "externalReference", "orderItemId"], "unknown_field");
  if (value.executionType !== EXECUTION_TYPE) {
    throw new AppError("validation_failed", 400, ["execution_type_invalid"]);
  }
  if (typeof value.orderItemId !== "string" || !RESOURCE_ID_PATTERN.test(value.orderItemId)) {
    throw new AppError("validation_failed", 400, ["order_item_id_invalid"]);
  }
  return {
    executionType: EXECUTION_TYPE,
    externalReference: normalizeExternalReference(value.externalReference),
    orderItemId: value.orderItemId,
  };
}

function normalizeExecution(value: unknown): ManualFulfillmentExecutionInput {
  if (!isRecord(value)) throw new AppError("validation_failed", 400, ["manual_fulfillment_execution_invalid"]);
  return parseManualFulfillmentExecutionInput(value);
}

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !IDEMPOTENCY_PATTERN.test(value)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_invalid"]);
  }
  return value;
}

function mapExecution(row: ExecutionRow): ManualFulfillmentExecutionView {
  return {
    completedAt: row.completedAt,
    completedQuantity: row.completedQuantity,
    evidence: row.referenceType === null ? null : { recorded: true, type: row.referenceType },
    executionId: row.executionId,
    executionType: row.executionType,
    orderItemId: row.orderItemId,
    state: row.state,
  };
}

async function findByIdempotency(input: {
  env: AppBindings;
  idempotencyKeyHash: string;
  requestHash: string;
  shopId: string;
}): Promise<{ execution: ManualFulfillmentExecutionView; replayed: true } | null> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT executions.id AS executionId,
      executions.order_item_id AS orderItemId,
      executions.execution_type AS executionType,
      executions.state,
      executions.completed_quantity AS completedQuantity,
      executions.completed_at AS completedAt,
      executions.request_hash AS requestHash,
      references_table.reference_type AS referenceType
    FROM manual_fulfillment_executions AS executions
    LEFT JOIN external_fulfillment_references AS references_table
      ON references_table.shop_id = executions.shop_id
      AND references_table.execution_id = executions.id
    WHERE executions.shop_id = ? AND executions.idempotency_key_hash = ?
    LIMIT 1
  `).bind(input.shopId, input.idempotencyKeyHash).first<ExecutionRow>();
  if (row === null) return null;
  if (row.requestHash !== input.requestHash) throw new AppError("idempotency_conflict", 409);
  return { execution: mapExecution(row), replayed: true };
}

async function findByOrderItem(input: {
  env: AppBindings;
  orderItemId: string;
  shopId: string;
}): Promise<ExecutionRow | null> {
  return input.env.PLATFORM_DB.prepare(`
    SELECT executions.id AS executionId,
      executions.order_item_id AS orderItemId,
      executions.execution_type AS executionType,
      executions.state,
      executions.completed_quantity AS completedQuantity,
      executions.completed_at AS completedAt,
      executions.request_hash AS requestHash,
      references_table.reference_type AS referenceType
    FROM manual_fulfillment_executions AS executions
    LEFT JOIN external_fulfillment_references AS references_table
      ON references_table.shop_id = executions.shop_id
      AND references_table.execution_id = executions.id
    WHERE executions.shop_id = ? AND executions.order_item_id = ?
    LIMIT 1
  `).bind(input.shopId, input.orderItemId).first<ExecutionRow>();
}

async function findOrderIdByIdempotency(input: {
  env: AppBindings;
  idempotencyKeyHash: string;
  shopId: string;
}): Promise<string | null> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT order_id AS orderId
    FROM manual_fulfillment_executions
    WHERE shop_id = ? AND idempotency_key_hash = ?
    LIMIT 1
  `).bind(input.shopId, input.idempotencyKeyHash).first<{ orderId: string }>();
  return row?.orderId ?? null;
}

async function recordReplayMilestone(input: {
  env: AppBindings;
  idempotencyKeyHash: string;
  replay: { execution: ManualFulfillmentExecutionView; replayed: true };
  shopId: string;
}): Promise<{ execution: ManualFulfillmentExecutionView; replayed: true }> {
  try {
    const orderId = await findOrderIdByIdempotency(input);
    if (orderId !== null) {
      await tryRecordFirstPaidFulfilled({ env: input.env, orderId, shopId: input.shopId });
    }
  } catch {
    // Analytics recovery must not change an idempotent fulfillment response.
  }
  return input.replay;
}

async function loadTarget(input: {
  env: AppBindings;
  orderItemId: string;
  orderPublicId: string;
  shopId: string;
}): Promise<TargetRow | null> {
  const genericSchema = await input.env.PLATFORM_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'order_item_entitlement_requirements' LIMIT 1",
  ).first<{ name: string }>();
  const genericRequirementProjection = genericSchema === null
    ? "0 AS hasGenericEntitlementRequirement"
    : `EXISTS (
        SELECT 1 FROM order_item_entitlement_requirements AS generic_requirement
        WHERE generic_requirement.shop_id = order_items.shop_id
          AND generic_requirement.order_item_id = order_items.id
      ) AS hasGenericEntitlementRequirement`;
  return input.env.PLATFORM_DB.prepare(`
    SELECT orders.id AS orderId,
      orders.status AS orderStatus,
      orders.payment_status AS paymentStatus,
      orders.paid_at AS paidAt,
      shops.status AS shopStatus,
      order_items.quantity,
      order_items.fulfillment_type AS itemFulfillmentType,
      EXISTS (
        SELECT 1 FROM order_item_fulfillment_requirements AS typed_requirement
        WHERE typed_requirement.shop_id = order_items.shop_id
          AND typed_requirement.order_item_id = order_items.id
          AND typed_requirement.capability = 'private_file'
      ) AS hasPrivateFileRequirement,
      ${genericRequirementProjection},
      fulfillments.id AS fulfillmentId,
      fulfillments.fulfillment_type AS fulfillmentType,
      fulfillments.state AS fulfillmentState
    FROM orders
    INNER JOIN shops ON shops.id = orders.shop_id
    INNER JOIN order_items
      ON order_items.shop_id = orders.shop_id
      AND order_items.order_id = orders.id
    LEFT JOIN fulfillments
      ON fulfillments.shop_id = orders.shop_id
      AND fulfillments.order_id = orders.id
      AND fulfillments.fulfillment_type = 'manual'
    WHERE orders.shop_id = ? AND orders.public_id = ? AND order_items.id = ?
    LIMIT 1
  `).bind(input.shopId, input.orderPublicId, input.orderItemId).first<TargetRow>();
}

function assertTargetReady(target: TargetRow | null): asserts target is TargetRow & { fulfillmentId: string } {
  if (target === null) throw new AppError("manual_fulfillment_item_not_found", 404);
  if (target.shopStatus !== "active") throw new AppError("shop_inactive", 409);
  if (target.itemFulfillmentType !== "manual") throw new AppError("manual_fulfillment_item_ineligible", 409);
  if (target.hasPrivateFileRequirement === 1) throw new AppError("manual_fulfillment_item_ineligible", 409);
  if (target.hasGenericEntitlementRequirement === 1) throw new AppError("manual_fulfillment_item_ineligible", 409);
  if (target.paymentStatus !== "paid" || target.paidAt === null
    || (target.orderStatus !== "processing" && target.orderStatus !== "completed")) {
    throw new AppError("manual_fulfillment_not_ready", 409);
  }
  if (target.fulfillmentId === null || target.fulfillmentType !== "manual") {
    throw new AppError("manual_fulfillment_not_ready", 409);
  }
  if (target.fulfillmentState === "fulfilled") throw new AppError("manual_fulfillment_already_completed", 409);
  if (target.fulfillmentState !== "pending" && target.fulfillmentState !== "manual_review") {
    throw new AppError("manual_fulfillment_not_ready", 409);
  }
}

async function deterministicId(env: AppBindings, prefix: string, purpose: string, value: string): Promise<string> {
  return `${prefix}_${await hmacToken(env.SESSION_SECRET, purpose, value)}`;
}

export async function completeManualFulfillment(input: {
  env: AppBindings;
  execution: ManualFulfillmentExecutionInput;
  idempotencyKey: string | null;
  orderPublicId: string;
  requestId: string;
  runtime?: { now?: Date };
  shopPublicId: string;
  userId: string;
}): Promise<{ execution: ManualFulfillmentExecutionView; replayed: boolean }> {
  const member = await getShopForMember({
    capability: "fulfillment:manage",
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  const shopId = member.row.shop_id;
  const execution = normalizeExecution(input.execution);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const idempotencyKeyHash = await hmacToken(
    input.env.SESSION_SECRET,
    "manual-fulfillment-idempotency:v1",
    `${shopId}:${idempotencyKey}`,
  );
  const externalReferenceHash = execution.externalReference === null
    ? null
    : await hmacToken(
      input.env.IDENTIFIER_HMAC_SECRET,
      `manual-fulfillment-reference:v1:${shopId}:${execution.externalReference.type}`,
      execution.externalReference.reference,
    );
  const requestHash = await sha256Json({
    executionType: execution.executionType,
    externalReference: execution.externalReference === null ? null : {
      hash: externalReferenceHash,
      type: execution.externalReference.type,
    },
    orderItemId: execution.orderItemId,
    orderPublicId: input.orderPublicId,
  });

  const replay = await findByIdempotency({ env: input.env, idempotencyKeyHash, requestHash, shopId });
  if (replay !== null) {
    return recordReplayMilestone({ env: input.env, idempotencyKeyHash, replay, shopId });
  }

  let target = await loadTarget({
    env: input.env,
    orderItemId: execution.orderItemId,
    orderPublicId: input.orderPublicId,
    shopId,
  });
  try {
    assertTargetReady(target);
  } catch (error) {
    const racedReplay = await findByIdempotency({ env: input.env, idempotencyKeyHash, requestHash, shopId });
    if (racedReplay !== null) {
      return recordReplayMilestone({ env: input.env, idempotencyKeyHash, replay: racedReplay, shopId });
    }
    throw error;
  }

  const now = input.runtime?.now ?? new Date();
  const nowIso = now.toISOString();
  const executionId = await deterministicId(input.env, "mfx", "manual-fulfillment-execution:v1", `${shopId}:${idempotencyKey}`);
  const externalReferenceId = await deterministicId(input.env, "efr", "manual-fulfillment-reference-row:v1", executionId);
  const auditId = await deterministicId(input.env, "aud", "manual-fulfillment-audit:v1", executionId);
  const safeAuditMetadata = JSON.stringify({
    evidenceType: execution.externalReference?.type ?? null,
    executionType: execution.executionType,
    orderItemId: execution.orderItemId,
  });
  let generatedCompletionGuard = "";
  try {
    const generatedSchema = await input.env.PLATFORM_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('generated_license_requests', 'generated_license_requirement_snapshots')",
    ).all<{ name: string }>();
    if (generatedSchema.results.length === 2) {
      generatedCompletionGuard = `
        AND NOT EXISTS (
          SELECT 1
          FROM order_item_entitlement_requirements AS generated_requirement
          INNER JOIN entitlement_resources AS generated_resource
            ON generated_resource.id = generated_requirement.resource_id
            AND generated_resource.shop_id = generated_requirement.shop_id
            AND generated_resource.resource_type = 'generated_license'
          WHERE generated_requirement.shop_id = orders.shop_id
            AND generated_requirement.order_id = orders.id
            AND NOT EXISTS (
              SELECT 1
              FROM generated_license_requirement_snapshots AS generated_snapshot
              INNER JOIN generated_license_requests AS generated_request
                ON generated_request.requirement_snapshot_id = generated_snapshot.id
                AND generated_request.shop_id = generated_snapshot.shop_id
                AND generated_request.status = 'succeeded'
              INNER JOIN generated_license_artifacts AS generated_artifact
                ON generated_artifact.request_id = generated_request.id
                AND generated_artifact.shop_id = generated_request.shop_id
                AND generated_artifact.status = 'active'
              WHERE generated_snapshot.shop_id = generated_requirement.shop_id
                AND generated_snapshot.entitlement_requirement_id = generated_requirement.id
            )
        )`;
    }
  } catch {
    // Pre-0049 databases have no generated-license projection to fence.
  }

  const statements: D1PreparedStatement[] = [
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO manual_fulfillment_executions (
        id, shop_id, order_id, order_item_id, fulfillment_id, execution_type,
        state, completed_quantity, actor_user_id, idempotency_key_hash,
        request_hash, request_id, completed_at, created_at
      )
      SELECT ?, shops.id, orders.id, order_items.id, fulfillments.id,
        'seller_attested_delivery', 'completed', order_items.quantity, ?, ?, ?, ?, ?, ?
      FROM shops
      INNER JOIN orders ON orders.shop_id = shops.id
      INNER JOIN order_items
        ON order_items.shop_id = orders.shop_id
        AND order_items.order_id = orders.id
      INNER JOIN fulfillments
        ON fulfillments.shop_id = orders.shop_id
        AND fulfillments.order_id = orders.id
        AND fulfillments.fulfillment_type = 'manual'
      INNER JOIN shop_members
        ON shop_members.shop_id = shops.id
        AND shop_members.user_id = ?
      WHERE shops.id = ? AND shops.status = 'active'
        AND orders.id = ? AND orders.public_id = ?
        AND orders.payment_status = 'paid' AND orders.paid_at IS NOT NULL
        AND orders.status IN ('processing', 'completed')
        AND order_items.id = ? AND order_items.fulfillment_type = 'manual'
        AND NOT EXISTS (
          SELECT 1 FROM order_item_fulfillment_requirements AS typed_requirement
          WHERE typed_requirement.shop_id = order_items.shop_id
            AND typed_requirement.order_item_id = order_items.id
            AND typed_requirement.capability = 'private_file'
        )
        AND fulfillments.id = ? AND fulfillments.state IN ('pending', 'manual_review')
        AND shop_members.status = 'active' AND shop_members.role IN ('owner', 'manager')
      ON CONFLICT DO NOTHING
    `).bind(
      executionId,
      input.userId,
      idempotencyKeyHash,
      requestHash,
      input.requestId,
      nowIso,
      nowIso,
      input.userId,
      shopId,
      target.orderId,
      input.orderPublicId,
      execution.orderItemId,
      target.fulfillmentId,
    ),
  ];

  if (execution.externalReference !== null && externalReferenceHash !== null) {
    statements.push(input.env.PLATFORM_DB.prepare(`
      INSERT OR IGNORE INTO external_fulfillment_references (
        id, shop_id, execution_id, reference_type, reference_hash,
        hash_key_version, created_at
      )
      SELECT ?, executions.shop_id, executions.id, ?, ?, ?, ?
      FROM manual_fulfillment_executions AS executions
      WHERE executions.id = ? AND executions.shop_id = ?
        AND executions.request_hash = ?
    `).bind(
      externalReferenceId,
      execution.externalReference.type,
      externalReferenceHash,
      REFERENCE_HASH_KEY_VERSION,
      nowIso,
      executionId,
      shopId,
      requestHash,
    ));
  }

  statements.push(
    input.env.PLATFORM_DB.prepare(`
      UPDATE fulfillments
      SET state = 'fulfilled', fulfilled_at = ?
      WHERE id = ? AND shop_id = ? AND order_id = ?
        AND fulfillment_type = 'manual' AND state IN ('pending', 'manual_review')
        AND EXISTS (
          SELECT 1 FROM manual_fulfillment_executions AS current_execution
          WHERE current_execution.id = ?
            AND current_execution.shop_id = fulfillments.shop_id
            AND current_execution.request_hash = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM order_items AS required_item
          WHERE required_item.shop_id = fulfillments.shop_id
            AND required_item.order_id = fulfillments.order_id
            AND required_item.fulfillment_type = 'manual'
            AND NOT EXISTS (
              SELECT 1 FROM order_item_fulfillment_requirements AS typed_requirement
              WHERE typed_requirement.shop_id = required_item.shop_id
                AND typed_requirement.order_item_id = required_item.id
                AND typed_requirement.capability = 'private_file'
            )
            AND NOT EXISTS (
              SELECT 1 FROM manual_fulfillment_executions AS completed_execution
              WHERE completed_execution.shop_id = required_item.shop_id
                AND completed_execution.order_item_id = required_item.id
            )
        )
    `).bind(nowIso, target.fulfillmentId, shopId, target.orderId, executionId, requestHash),
    input.env.PLATFORM_DB.prepare(`
      UPDATE orders
      SET status = CASE WHEN status = 'processing' THEN 'completed' ELSE status END,
        fulfillment_status = 'fulfilled',
        fulfilled_at = COALESCE(fulfilled_at, ?),
        updated_at = ?
      WHERE id = ? AND shop_id = ? AND public_id = ?
        AND payment_status = 'paid' AND status IN ('processing', 'completed')
        AND EXISTS (
          SELECT 1 FROM manual_fulfillment_executions AS current_execution
          WHERE current_execution.id = ?
            AND current_execution.shop_id = orders.shop_id
            AND current_execution.request_hash = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM order_items AS required_item
          WHERE required_item.shop_id = orders.shop_id
            AND required_item.order_id = orders.id
            AND required_item.fulfillment_type = 'manual'
            AND NOT EXISTS (
              SELECT 1 FROM order_item_fulfillment_requirements AS typed_requirement
              WHERE typed_requirement.shop_id = required_item.shop_id
                AND typed_requirement.order_item_id = required_item.id
                AND typed_requirement.capability = 'private_file'
            )
            AND NOT EXISTS (
              SELECT 1 FROM manual_fulfillment_executions AS completed_execution
              WHERE completed_execution.shop_id = required_item.shop_id
                AND completed_execution.order_item_id = required_item.id
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM fulfillments AS required_fulfillment
          WHERE required_fulfillment.shop_id = orders.shop_id
            AND required_fulfillment.order_id = orders.id
            AND required_fulfillment.state != 'fulfilled'
        )
        ${generatedCompletionGuard}
    `).bind(nowIso, nowIso, target.orderId, shopId, input.orderPublicId, executionId, requestHash),
    input.env.PLATFORM_DB.prepare(`
      INSERT OR IGNORE INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      )
      SELECT ?, executions.shop_id, 'user', ?, 'manual_fulfillment.completed',
        'manual_fulfillment_execution', executions.id, ?, ?, ?
      FROM manual_fulfillment_executions AS executions
      WHERE executions.id = ? AND executions.shop_id = ?
        AND executions.request_hash = ?
    `).bind(
      auditId,
      input.userId,
      safeAuditMetadata,
      input.requestId,
      nowIso,
      executionId,
      shopId,
      requestHash,
    ),
  );

  try {
    const results = await input.env.PLATFORM_DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) === 1) {
      const created = await findByIdempotency({ env: input.env, idempotencyKeyHash, requestHash, shopId });
      if (created === null) throw new AppError("manual_fulfillment_execution_failed", 500);
      await tryRecordFirstPaidFulfilled({ env: input.env, orderId: target.orderId, shopId });
      return { ...created, replayed: false };
    }
  } catch (error) {
    const racedReplay = await findByIdempotency({ env: input.env, idempotencyKeyHash, requestHash, shopId });
    if (racedReplay !== null) {
      return recordReplayMilestone({ env: input.env, idempotencyKeyHash, replay: racedReplay, shopId });
    }
    const completedItem = await findByOrderItem({ env: input.env, orderItemId: execution.orderItemId, shopId });
    if (completedItem !== null) throw new AppError("manual_fulfillment_already_completed", 409);
    throw error;
  }

  const racedReplay = await findByIdempotency({ env: input.env, idempotencyKeyHash, requestHash, shopId });
  if (racedReplay !== null) {
    return recordReplayMilestone({ env: input.env, idempotencyKeyHash, replay: racedReplay, shopId });
  }
  const completedItem = await findByOrderItem({ env: input.env, orderItemId: execution.orderItemId, shopId });
  if (completedItem !== null) throw new AppError("manual_fulfillment_already_completed", 409);

  await getShopForMember({ capability: "fulfillment:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  target = await loadTarget({ env: input.env, orderItemId: execution.orderItemId, orderPublicId: input.orderPublicId, shopId });
  assertTargetReady(target);
  throw new AppError("manual_fulfillment_execution_failed", 409);
}

export const executeManualFulfillment = completeManualFulfillment;
