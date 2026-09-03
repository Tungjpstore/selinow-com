import { sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import { tryRecordFirstPaidFulfilled } from "../analytics/activation";
import { fireAutomationTriggers } from "../automation/rules/dispatcher";
import { sha256Hex } from "../events/append";
import type { AppBindings } from "../platform/bindings";
import { prepareGenericPaidActivationStatements } from "./entitlements";

/**
 * Provider-neutral payment attempt fields required to apply verified evidence.
 * Provider adapters resolve and authenticate these values before calling this
 * capability.
 */
export type CommercePaymentAttempt = {
  id: string;
  integrationId: string;
  orderId: string;
  shopId: string;
  state: string;
};

export type CommercePaymentDecision =
  | "identity_mismatch"
  | "inconsistent"
  | "late"
  | "overpaid"
  | "paid_exact"
  | "partial"
  | "pending"
  | "terminal_unpaid";

export type CommercePaymentEventEvidence = {
  amount: number;
  expectedAmount: number;
  occurredAt: string;
  reference: string;
  referenceConflict?: boolean;
};

export type ApplyCommercePaymentEventInput = {
  attempt: CommercePaymentAttempt;
  claimToken: string;
  decision: CommercePaymentDecision;
  env: AppBindings;
  eventId: string;
  evidence: CommercePaymentEventEvidence;
  integrationId: string;
};

export type ApplyCommercePaymentEventResult = { processed: boolean; state: string };

function claimedEventGuard(allowReferenceConflict = false): string {
  return `EXISTS (
    SELECT 1
    FROM payment_events AS claimed_event
    WHERE claimed_event.id = ?
      AND claimed_event.integration_id = ?
      AND claimed_event.processing_token = ?
      AND claimed_event.processed_at IS NULL
      AND claimed_event.shop_id = ?
      AND claimed_event.payment_attempt_id = ?
      AND EXISTS (
        SELECT 1
        FROM payment_attempts AS bound_attempt
        WHERE bound_attempt.id = claimed_event.payment_attempt_id
          AND bound_attempt.shop_id = claimed_event.shop_id
          AND bound_attempt.integration_id = claimed_event.integration_id
          AND bound_attempt.order_id = ?
      )
      ${allowReferenceConflict ? "" : `AND NOT EXISTS (
        SELECT 1
        FROM payment_events AS conflicting_event
        WHERE conflicting_event.integration_id = claimed_event.integration_id
          AND conflicting_event.provider_event_reference = claimed_event.provider_event_reference
          AND conflicting_event.payload_hash <> claimed_event.payload_hash
      )`}
  )`;
}

function claimedEventBindings(
  attempt: CommercePaymentAttempt,
  eventId: string,
  claimToken: string,
): readonly [string, string, string, string, string, string] {
  return [eventId, attempt.integrationId, claimToken, attempt.shopId, attempt.id, attempt.orderId];
}

async function assertClaimedEventBinding(
  env: AppBindings,
  attempt: CommercePaymentAttempt,
  eventId: string,
  claimToken: string,
): Promise<void> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT 1 AS bound
    FROM payment_events AS event
    INNER JOIN payment_attempts AS bound_attempt
      ON bound_attempt.id = event.payment_attempt_id
      AND bound_attempt.shop_id = event.shop_id
      AND bound_attempt.integration_id = event.integration_id
    WHERE event.id = ?
      AND event.integration_id = ?
      AND event.processing_token = ?
      AND event.shop_id = ?
      AND event.payment_attempt_id = ?
      AND event.processed_at IS NULL
      AND bound_attempt.order_id = ?
    LIMIT 1
  `).bind(...claimedEventBindings(attempt, eventId, claimToken)).first<{ bound: number }>();
  if (row?.bound !== 1) throw new AppError("payment_event_claim_invalid", 500);
}

async function hasClaimedReferenceConflict(
  env: AppBindings,
  attempt: CommercePaymentAttempt,
  eventId: string,
  claimToken: string,
): Promise<boolean> {
  const row = await env.PLATFORM_DB.prepare(`SELECT EXISTS (
    SELECT 1
    FROM payment_events AS claimed_event
    WHERE claimed_event.id = ?
      AND claimed_event.shop_id = ?
      AND claimed_event.payment_attempt_id = ?
      AND claimed_event.integration_id = ?
      AND claimed_event.processing_token = ?
      AND claimed_event.processed_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM payment_events AS conflicting_event
        WHERE conflicting_event.integration_id = claimed_event.integration_id
          AND conflicting_event.provider_event_reference = claimed_event.provider_event_reference
          AND conflicting_event.payload_hash <> claimed_event.payload_hash
      )
  ) AS referenceConflict`).bind(eventId, attempt.shopId, attempt.id, attempt.integrationId, claimToken).first<{ referenceConflict: number }>();
  return row?.referenceConflict === 1;
}

async function markException(
  env: AppBindings,
  attempt: CommercePaymentAttempt,
  decision: Exclude<CommercePaymentDecision, "paid_exact" | "pending" | "terminal_unpaid">,
  eventId: string,
  claimToken: string,
  evidence: Record<string, unknown>,
): Promise<string> {
  const now = new Date().toISOString();
  const paymentStatus = decision === "partial" ? "partial" : decision === "overpaid" ? "overpaid" : "failed";
  const results = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(`UPDATE payment_attempts SET state = ?, last_safe_error_code = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND state IN ('creating', 'pending', 'error') AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND shop_id = ? AND payment_status IN ('unpaid', 'pending')) AND ${claimedEventGuard(decision === "inconsistent")}`).bind(decision, `payment_${decision}`, now, attempt.id, attempt.shopId, attempt.orderId, attempt.shopId, ...claimedEventBindings(attempt, eventId, claimToken)),
    env.PLATFORM_DB.prepare("UPDATE orders SET status = 'exception', payment_status = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND payment_status IN ('unpaid', 'pending') AND EXISTS (SELECT 1 FROM payment_attempts WHERE id = ? AND shop_id = ? AND state = ?) AND EXISTS (SELECT 1 FROM payment_events WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL)").bind(paymentStatus, now, attempt.orderId, attempt.shopId, attempt.id, attempt.shopId, decision, eventId, attempt.integrationId, claimToken),
    env.PLATFORM_DB.prepare("INSERT INTO payment_exceptions (id, shop_id, order_id, payment_attempt_id, type, status, safe_evidence_json, created_at) SELECT ?, ?, ?, ?, ?, 'open', ?, ? WHERE EXISTS (SELECT 1 FROM payment_attempts INNER JOIN orders ON orders.id = payment_attempts.order_id AND orders.shop_id = payment_attempts.shop_id WHERE payment_attempts.id = ? AND payment_attempts.shop_id = ? AND payment_attempts.state = ? AND orders.payment_status = ?) AND EXISTS (SELECT 1 FROM payment_events WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL)").bind(createId("pex"), attempt.shopId, attempt.orderId, attempt.id, decision, JSON.stringify(evidence), now, attempt.id, attempt.shopId, decision, paymentStatus, eventId, attempt.integrationId, claimToken),
    env.PLATFORM_DB.prepare("INSERT OR IGNORE INTO outbox_jobs (id, shop_id, kind, aggregate_type, aggregate_id, status, attempts, next_attempt_at, created_at, updated_at) SELECT ?, ?, 'payment_exception', 'payment_attempt', ?, 'pending', 0, ?, ?, ? WHERE EXISTS (SELECT 1 FROM payment_attempts INNER JOIN orders ON orders.id = payment_attempts.order_id AND orders.shop_id = payment_attempts.shop_id WHERE payment_attempts.id = ? AND payment_attempts.shop_id = ? AND payment_attempts.state = ? AND orders.payment_status = ?) AND EXISTS (SELECT 1 FROM payment_events WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL)").bind(createId("job"), attempt.shopId, attempt.id, now, now, now, attempt.id, attempt.shopId, decision, paymentStatus, eventId, attempt.integrationId, claimToken),
    env.PLATFORM_DB.prepare("UPDATE payment_events SET normalized_state = ?, process_result = 'exception_created', processing_token = NULL, processing_started_at = NULL, processed_at = ? WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL AND EXISTS (SELECT 1 FROM payment_attempts INNER JOIN orders ON orders.id = payment_attempts.order_id AND orders.shop_id = payment_attempts.shop_id WHERE payment_attempts.id = ? AND payment_attempts.shop_id = ? AND payment_attempts.state = ? AND orders.payment_status = ?)").bind(decision, now, eventId, attempt.integrationId, claimToken, attempt.id, attempt.shopId, decision, paymentStatus),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1) return decision;
  if (decision !== "inconsistent" && await hasClaimedReferenceConflict(env, attempt, eventId, claimToken)) {
    return markException(env, attempt, "inconsistent", eventId, claimToken, { ...evidence, referenceConflict: true });
  }
  const authoritative = await env.PLATFORM_DB.prepare("SELECT state FROM payment_attempts WHERE id = ? AND shop_id = ? LIMIT 1").bind(attempt.id, attempt.shopId).first<{ state: string }>();
  const state = authoritative?.state ?? attempt.state;
  await env.PLATFORM_DB.prepare("UPDATE payment_events SET normalized_state = ?, process_result = 'state_conflict', processing_token = NULL, processing_started_at = NULL, processed_at = ? WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL").bind(state, new Date().toISOString(), eventId, attempt.integrationId, claimToken).run();
  return state;
}

async function fulfillExactPayment(
  env: AppBindings,
  attempt: CommercePaymentAttempt,
  eventId: string,
  claimToken: string,
  evidence: CommercePaymentEventEvidence,
): Promise<ApplyCommercePaymentEventResult> {
  if (attempt.state === "paid_exact") {
    await env.PLATFORM_DB.prepare("UPDATE payment_events SET normalized_state = 'paid_exact', process_result = 'already_fulfilled', processing_token = NULL, processing_started_at = NULL, processed_at = ? WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL").bind(new Date().toISOString(), eventId, attempt.integrationId, claimToken).run();
    return { processed: false, state: "paid_exact" };
  }
  if (!new Set(["creating", "pending", "error"]).has(attempt.state)) {
    await env.PLATFORM_DB.prepare("UPDATE payment_events SET normalized_state = ?, process_result = 'state_conflict', processing_token = NULL, processing_started_at = NULL, processed_at = ? WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL").bind(attempt.state, new Date().toISOString(), eventId, attempt.integrationId, claimToken).run();
    return { processed: false, state: attempt.state };
  }
  const typedSchemas = await env.PLATFORM_DB.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('order_item_fulfillment_requirements', 'order_item_entitlement_requirements', 'entitlement_resources')
  `).all<{ name: string }>();
  const schemaNames = new Set(typedSchemas.results.map((row) => row.name));
  const privateRequirementProjection = schemaNames.has("order_item_fulfillment_requirements")
    ? `EXISTS (
        SELECT 1 FROM order_item_fulfillment_requirements AS private_requirement
        WHERE private_requirement.shop_id = order_items.shop_id
          AND private_requirement.order_item_id = order_items.id
          AND private_requirement.capability = 'private_file'
      ) AS hasPrivateRequirement`
    : "0 AS hasPrivateRequirement";
  const genericRequirementProjection = schemaNames.has("order_item_entitlement_requirements")
    ? `EXISTS (
        SELECT 1 FROM order_item_entitlement_requirements AS generic_requirement
        WHERE generic_requirement.shop_id = order_items.shop_id
          AND generic_requirement.order_item_id = order_items.id
      ) AS hasGenericRequirement`
    : "0 AS hasGenericRequirement";
  const generatedLicenseRequirementProjection = schemaNames.has("order_item_entitlement_requirements")
    && schemaNames.has("entitlement_resources")
    ? `EXISTS (
        SELECT 1
        FROM order_item_entitlement_requirements AS generated_requirement
        INNER JOIN entitlement_resources AS generated_resource
          ON generated_resource.id = generated_requirement.resource_id
          AND generated_resource.shop_id = generated_requirement.shop_id
        WHERE generated_requirement.shop_id = order_items.shop_id
          AND generated_requirement.order_item_id = order_items.id
          AND generated_resource.resource_type = 'generated_license'
      ) AS hasGeneratedLicenseRequirement`
    : "0 AS hasGeneratedLicenseRequirement";
  const orderItems = await env.PLATFORM_DB.prepare(`
    SELECT id, fulfillment_type AS fulfillmentType, quantity,
      ${privateRequirementProjection}, ${genericRequirementProjection},
      ${generatedLicenseRequirementProjection}
    FROM order_items
    WHERE order_id = ? AND shop_id = ?
    ORDER BY id
  `).bind(attempt.orderId, attempt.shopId).all<{
    fulfillmentType: "license_key" | "manual";
    hasGeneratedLicenseRequirement: number;
    hasGenericRequirement: number;
    hasPrivateRequirement: number;
    id: string;
    quantity: number;
  }>();
  const reserved = await env.PLATFORM_DB.prepare("SELECT inventory_keys.id AS inventoryKeyId, inventory_keys.reserved_order_item_id AS orderItemId FROM inventory_keys INNER JOIN order_items ON order_items.id = inventory_keys.reserved_order_item_id AND order_items.order_id = ? AND order_items.shop_id = inventory_keys.shop_id WHERE inventory_keys.shop_id = ? AND inventory_keys.status = 'reserved' ORDER BY inventory_keys.id").bind(attempt.orderId, attempt.shopId).all<{ inventoryKeyId: string; orderItemId: string }>();
  const expectedKeys = orderItems.results.filter((item) => item.fulfillmentType === "license_key").reduce((total, item) => total + item.quantity, 0);
  if (reserved.results.length !== expectedKeys) {
    const state = await markException(env, attempt, "inconsistent", eventId, claimToken, { expectedKeys, reservedKeys: reserved.results.length });
    return { processed: false, state };
  }
  const now = new Date().toISOString();
  const hasManual = orderItems.results.some((item) => item.fulfillmentType === "manual"
    && item.hasPrivateRequirement !== 1
    && item.hasGenericRequirement !== 1);
  const hasGeneratedLicense = orderItems.results.some((item) => item.hasGeneratedLicenseRequirement === 1);
  const hasAsyncFulfillment = hasManual || hasGeneratedLicense;
  const digitalFulfillmentId = expectedKeys > 0 ? createId("ful") : null;
  const manualFulfillmentId = hasManual ? createId("ful") : null;
  const orderPaidEventId = createId("evt");
  const orderPaidIdempotencyHash = await sha256Hex(`${attempt.shopId}:order.paid:${eventId}`);
  const genericEntitlementStatements = await prepareGenericPaidActivationStatements({
    database: env.PLATFORM_DB,
    eventId,
    nowIso: now,
    orderId: attempt.orderId,
    requestHash: await sha256Json({ evidence, eventId, paymentAttemptId: attempt.id }),
    shopId: attempt.shopId,
    sourceIdempotencyHash: await sha256Json({ eventId, paymentAttemptId: attempt.id, purpose: "generic-entitlement-payment" }),
  });
  const statements: D1PreparedStatement[] = [
    env.PLATFORM_DB.prepare(`UPDATE payment_attempts SET state = 'paid_exact', paid_event_id = ?, provider_status = 'PAID', last_safe_error_code = NULL, updated_at = ? WHERE id = ? AND shop_id = ? AND state IN ('creating', 'pending', 'error') AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND shop_id = ? AND payment_status IN ('unpaid', 'pending')) AND (SELECT COUNT(*) FROM inventory_keys INNER JOIN order_items ON order_items.id = inventory_keys.reserved_order_item_id AND order_items.shop_id = inventory_keys.shop_id WHERE order_items.order_id = ? AND order_items.shop_id = ? AND inventory_keys.status = 'reserved') = ? AND ${claimedEventGuard()}`).bind(eventId, now, attempt.id, attempt.shopId, attempt.orderId, attempt.shopId, attempt.orderId, attempt.shopId, expectedKeys, ...claimedEventBindings(attempt, eventId, claimToken)),
    env.PLATFORM_DB.prepare("UPDATE orders SET status = ?, payment_status = 'paid', fulfillment_status = ?, paid_at = ?, fulfilled_at = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND payment_status IN ('unpaid', 'pending') AND EXISTS (SELECT 1 FROM payment_attempts WHERE id = ? AND shop_id = ? AND state = 'paid_exact' AND paid_event_id = ?) AND EXISTS (SELECT 1 FROM payment_events WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL)").bind(hasAsyncFulfillment ? "processing" : "completed", hasAsyncFulfillment ? "unfulfilled" : "fulfilled", evidence.occurredAt, hasAsyncFulfillment ? null : now, now, attempt.orderId, attempt.shopId, attempt.id, attempt.shopId, eventId, eventId, attempt.integrationId, claimToken),
    env.PLATFORM_DB.prepare("UPDATE inventory_keys SET status = 'sold', sold_order_item_id = reserved_order_item_id, sold_at = ?, reservation_token = NULL, reserved_until = NULL WHERE shop_id = ? AND status = 'reserved' AND reserved_order_item_id IN (SELECT id FROM order_items WHERE order_id = ? AND shop_id = ?) AND EXISTS (SELECT 1 FROM payment_attempts INNER JOIN orders ON orders.id = payment_attempts.order_id AND orders.shop_id = payment_attempts.shop_id WHERE payment_attempts.id = ? AND payment_attempts.shop_id = ? AND payment_attempts.state = 'paid_exact' AND payment_attempts.paid_event_id = ? AND orders.payment_status = 'paid') AND EXISTS (SELECT 1 FROM payment_events WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL)").bind(now, attempt.shopId, attempt.orderId, attempt.shopId, attempt.id, attempt.shopId, eventId, eventId, attempt.integrationId, claimToken),
  ];
  if (digitalFulfillmentId !== null) {
    statements.push(env.PLATFORM_DB.prepare("INSERT INTO fulfillments (id, shop_id, order_id, fulfillment_type, state, idempotency_key, created_at, fulfilled_at) SELECT ?, ?, ?, 'digital_keys', 'fulfilled', ?, ?, ? WHERE EXISTS (SELECT 1 FROM payment_attempts INNER JOIN orders ON orders.id = payment_attempts.order_id AND orders.shop_id = payment_attempts.shop_id WHERE payment_attempts.id = ? AND payment_attempts.shop_id = ? AND payment_attempts.state = 'paid_exact' AND payment_attempts.paid_event_id = ? AND orders.payment_status = 'paid') AND EXISTS (SELECT 1 FROM payment_events WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL)").bind(digitalFulfillmentId, attempt.shopId, attempt.orderId, `payment:${attempt.id}:digital`, now, now, attempt.id, attempt.shopId, eventId, eventId, attempt.integrationId, claimToken));
    for (const item of reserved.results) {
      statements.push(env.PLATFORM_DB.prepare("INSERT INTO fulfillment_items (id, shop_id, fulfillment_id, order_item_id, inventory_key_id, delivered_at, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM payment_attempts INNER JOIN orders ON orders.id = payment_attempts.order_id AND orders.shop_id = payment_attempts.shop_id WHERE payment_attempts.id = ? AND payment_attempts.shop_id = ? AND payment_attempts.state = 'paid_exact' AND payment_attempts.paid_event_id = ? AND orders.payment_status = 'paid') AND EXISTS (SELECT 1 FROM payment_events WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL)").bind(createId("fit"), attempt.shopId, digitalFulfillmentId, item.orderItemId, item.inventoryKeyId, now, now, attempt.id, attempt.shopId, eventId, eventId, attempt.integrationId, claimToken));
    }
  }
  if (manualFulfillmentId !== null) statements.push(env.PLATFORM_DB.prepare("INSERT INTO fulfillments (id, shop_id, order_id, fulfillment_type, state, idempotency_key, created_at) SELECT ?, ?, ?, 'manual', 'pending', ?, ? WHERE EXISTS (SELECT 1 FROM payment_attempts INNER JOIN orders ON orders.id = payment_attempts.order_id AND orders.shop_id = payment_attempts.shop_id WHERE payment_attempts.id = ? AND payment_attempts.shop_id = ? AND payment_attempts.state = 'paid_exact' AND payment_attempts.paid_event_id = ? AND orders.payment_status = 'paid') AND EXISTS (SELECT 1 FROM payment_events WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL)").bind(manualFulfillmentId, attempt.shopId, attempt.orderId, `payment:${attempt.id}:manual`, now, attempt.id, attempt.shopId, eventId, eventId, attempt.integrationId, claimToken));
  statements.push(...genericEntitlementStatements);
  statements.push(env.PLATFORM_DB.prepare("INSERT INTO domain_events (id, shop_id, event_type, aggregate_type, aggregate_id, schema_version, idempotency_key_hash, source_connection_id, status, attempts, next_attempt_at, occurred_at, created_at, updated_at) SELECT ?, ?, 'order.paid', 'order', ?, 1, ?, NULL, 'pending', 0, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM payment_attempts INNER JOIN orders ON orders.id = payment_attempts.order_id AND orders.shop_id = payment_attempts.shop_id WHERE payment_attempts.id = ? AND payment_attempts.shop_id = ? AND payment_attempts.state = 'paid_exact' AND payment_attempts.paid_event_id = ? AND orders.id = ? AND orders.payment_status = 'paid') AND EXISTS (SELECT 1 FROM payment_events WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL)").bind(orderPaidEventId, attempt.shopId, attempt.orderId, orderPaidIdempotencyHash, now, evidence.occurredAt, now, now, attempt.id, attempt.shopId, eventId, attempt.orderId, eventId, attempt.integrationId, claimToken));
  statements.push(env.PLATFORM_DB.prepare("UPDATE payment_events SET normalized_state = 'paid_exact', process_result = 'fulfilled', processing_token = NULL, processing_started_at = NULL, processed_at = ? WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL AND EXISTS (SELECT 1 FROM payment_attempts INNER JOIN orders ON orders.id = payment_attempts.order_id AND orders.shop_id = payment_attempts.shop_id WHERE payment_attempts.id = ? AND payment_attempts.shop_id = ? AND payment_attempts.state = 'paid_exact' AND payment_attempts.paid_event_id = ? AND orders.payment_status = 'paid')").bind(now, eventId, attempt.integrationId, claimToken, attempt.id, attempt.shopId, eventId));
  try {
    const results = await env.PLATFORM_DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1) return { processed: true, state: "paid_exact" };
    if (await hasClaimedReferenceConflict(env, attempt, eventId, claimToken)) {
      const state = await markException(env, attempt, "inconsistent", eventId, claimToken, { ...evidence, referenceConflict: true });
      return { processed: state === "inconsistent", state };
    }
    const authoritative = await env.PLATFORM_DB.prepare("SELECT state FROM payment_attempts WHERE id = ? AND shop_id = ? LIMIT 1").bind(attempt.id, attempt.shopId).first<{ state: string }>();
    const state = authoritative?.state ?? attempt.state;
    await env.PLATFORM_DB.prepare("UPDATE payment_events SET normalized_state = ?, process_result = 'state_conflict', processing_token = NULL, processing_started_at = NULL, processed_at = ? WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL").bind(state, new Date().toISOString(), eventId, attempt.integrationId, claimToken).run();
    return { processed: false, state };
  } catch {
    const paid = await env.PLATFORM_DB.prepare("SELECT state, paid_event_id AS paidEventId FROM payment_attempts WHERE id = ? AND shop_id = ? LIMIT 1").bind(attempt.id, attempt.shopId).first<{ paidEventId: string | null; state: string }>();
    if (paid?.state === "paid_exact" && paid.paidEventId === eventId) return { processed: false, state: "paid_exact" };
    throw new AppError("payment_fulfillment_failed", 500);
  }
}

/** Applies already verified and claimed payment evidence atomically. */
export async function applyCommercePaymentEvent(input: ApplyCommercePaymentEventInput): Promise<ApplyCommercePaymentEventResult> {
  const { attempt, claimToken, decision, env, eventId, evidence } = input;
  if (input.integrationId !== attempt.integrationId) throw new AppError("payment_event_claim_invalid", 500);
  await assertClaimedEventBinding(env, attempt, eventId, claimToken);
  if (decision === "paid_exact") {
    const result = await fulfillExactPayment(env, attempt, eventId, claimToken, evidence);
    if (result.state === "paid_exact") await tryRecordFirstPaidFulfilled({ env, orderId: attempt.orderId, shopId: attempt.shopId });
    if (result.processed && result.state === "paid_exact") void fireAutomationTriggers(env, { aggregateReference: `order:${attempt.orderId}`, refs: { orderId: attempt.orderId }, shopId: attempt.shopId, triggerType: "order.paid" }).catch(() => {});
    return result;
  }
  if (decision === "pending" || decision === "terminal_unpaid") {
    const now = new Date().toISOString();
    // Unpaid provider observations may advance only a transient attempt. Once
    // an exception or terminal outcome wins, a late/stale observation must not
    // reopen the attempt and make a later exact payment look fulfillable.
    const results = await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(`UPDATE payment_attempts SET state = ?, provider_status = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND (state IN ('creating', 'pending', 'error') OR (state = 'terminal_unpaid' AND ? = 'terminal_unpaid')) AND ${claimedEventGuard()}`).bind(decision, decision === "terminal_unpaid" ? "FAILED" : "PENDING", now, attempt.id, attempt.shopId, decision, ...claimedEventBindings(attempt, eventId, claimToken)),
      env.PLATFORM_DB.prepare(`UPDATE payment_events SET normalized_state = ?, process_result = 'no_fulfillment', processing_token = NULL, processing_started_at = NULL, processed_at = ? WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL AND EXISTS (SELECT 1 FROM payment_attempts WHERE id = ? AND shop_id = ? AND state = ?) AND ${claimedEventGuard()}`).bind(decision, now, eventId, attempt.integrationId, claimToken, attempt.id, attempt.shopId, decision, ...claimedEventBindings(attempt, eventId, claimToken)),
    ]);
    if (decision === "terminal_unpaid" && (results[0]?.meta.changes ?? 0) === 1) void fireAutomationTriggers(env, { aggregateReference: `order:${attempt.orderId}`, refs: { orderId: attempt.orderId, reason: "terminal_unpaid" }, shopId: attempt.shopId, triggerType: "payment.failed" }).catch(() => {});
    if ((results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1) return { processed: true, state: decision };
    if (await hasClaimedReferenceConflict(env, attempt, eventId, claimToken)) {
      const state = await markException(env, attempt, "inconsistent", eventId, claimToken, { ...evidence, referenceConflict: true });
      return { processed: state === "inconsistent", state };
    }
    const authoritative = await env.PLATFORM_DB.prepare("SELECT state FROM payment_attempts WHERE id = ? AND shop_id = ? LIMIT 1").bind(attempt.id, attempt.shopId).first<{ state: string }>();
    const state = authoritative?.state ?? attempt.state;
    await env.PLATFORM_DB.prepare("UPDATE payment_events SET normalized_state = ?, process_result = 'state_conflict', processing_token = NULL, processing_started_at = NULL, processed_at = ? WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL").bind(state, new Date().toISOString(), eventId, attempt.integrationId, claimToken).run();
    return { processed: false, state };
  }
  const state = await markException(env, attempt, decision, eventId, claimToken, evidence);
  if (state === decision) void fireAutomationTriggers(env, { aggregateReference: `order:${attempt.orderId}`, refs: { orderId: attempt.orderId, reason: decision }, shopId: attempt.shopId, triggerType: "payment.failed" }).catch(() => {});
  return { processed: state === decision, state };
}
