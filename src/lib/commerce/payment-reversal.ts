import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";

const IDP_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/u;
const PROVIDER_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/u;
const SHA256_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PAYMENT_REVERSAL_KINDS: readonly string[] = ["refund", "chargeback"];
const PAYMENT_REVERSAL_VERIFICATION_METHODS: readonly string[] = ["signed_webhook", "direct_reconciliation"];

export type PaymentReversalKind = "refund" | "chargeback";
export type PaymentReversalVerificationMethod = "signed_webhook" | "direct_reconciliation";
export type PaymentReversalDecision =
  | "full_refund"
  | "chargeback"
  | "partial"
  | "mismatch"
  | "manual_review";

export type ApplyVerifiedPaymentReversalInput = {
  amountMinor: number;
  credentialId: string;
  credentialVersion: number;
  currency: string;
  evidenceHash: string;
  env: AppBindings;
  idempotencyKey: string;
  integrationId: string;
  occurredAt: string;
  orderId: string;
  originalPaymentEventId: string;
  paymentAttemptId: string;
  provider: string;
  providerReference: string;
  requestId: string;
  reversalKind: PaymentReversalKind;
  shopId: string;
  verificationMethod: PaymentReversalVerificationMethod;
  verified: boolean;
};

export type ApplyVerifiedPaymentReversalResult = {
  decision: PaymentReversalDecision;
  duplicate: boolean;
  orderId: string;
  reversalId: string;
  revoked: boolean;
};

type AuthoritativePaymentRow = {
  attemptExpectedAmount: number;
  attemptId: string;
  attemptState: string;
  attemptCurrency: string;
  credentialId: string;
  credentialVersion: number;
  integrationId: string;
  orderCurrency: string;
  orderId: string;
  orderPaymentStatus: string;
  orderStatus: string;
  orderTotal: number;
  originalPaymentEventId: string;
  provider: string;
  shopId: string;
};

type StoredReversalRow = {
  decision: PaymentReversalDecision;
  evidenceHash: string;
  id: string;
  idempotencyKeyHash: string;
  integrationId: string;
  orderId: string;
  originalPaymentEventId: string;
  paymentAttemptId: string;
  provider: string;
  providerReferenceHash: string;
  requestHash: string;
  reversalKind: PaymentReversalKind;
  shopId: string;
};

type GenericEntitlementTarget = {
  id: string;
};

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function assertInput(input: ApplyVerifiedPaymentReversalInput): void {
  if (!input.verified) throw new AppError("payment_reversal_unverified", 403);
  if (!PAYMENT_REVERSAL_KINDS.includes(input.reversalKind)) {
    throw new AppError("validation_failed", 400, ["reversal_kind_invalid"]);
  }
  if (!PAYMENT_REVERSAL_VERIFICATION_METHODS.includes(input.verificationMethod)) {
    throw new AppError("validation_failed", 400, ["verification_method_invalid"]);
  }
  if (!SHA256_BASE64URL_PATTERN.test(input.evidenceHash)) {
    throw new AppError("validation_failed", 400, ["evidence_hash_invalid"]);
  }
  if (!IDP_KEY_PATTERN.test(input.idempotencyKey)) throw new AppError("validation_failed", 400, ["idempotency_key_invalid"]);
  if (!REQUEST_ID_PATTERN.test(input.requestId)) throw new AppError("validation_failed", 400, ["request_id_invalid"]);
  if (!PROVIDER_PATTERN.test(input.provider)) throw new AppError("validation_failed", 400, ["provider_invalid"]);
  if (!CURRENCY_PATTERN.test(input.currency)) throw new AppError("validation_failed", 400, ["currency_invalid"]);
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) throw new AppError("validation_failed", 400, ["amount_invalid"]);
  if (!Number.isSafeInteger(input.credentialVersion) || input.credentialVersion < 1) throw new AppError("validation_failed", 400, ["credential_version_invalid"]);
  if (input.providerReference.length < 1 || input.providerReference.length > 256 || hasControlCharacters(input.providerReference)) {
    throw new AppError("validation_failed", 400, ["provider_reference_invalid"]);
  }
  const occurredAt = new Date(input.occurredAt);
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.toISOString() !== input.occurredAt) {
    throw new AppError("validation_failed", 400, ["occurred_at_invalid"]);
  }
}

function mapStored(row: StoredReversalRow, input: HashedInput): ApplyVerifiedPaymentReversalResult {
  const bindingMatches = row.shopId === input.shopId
    && row.orderId === input.orderId
    && row.paymentAttemptId === input.paymentAttemptId
    && row.integrationId === input.integrationId
    && row.provider === input.provider
    && row.originalPaymentEventId === input.originalPaymentEventId
    && row.reversalKind === input.reversalKind;
  if (!bindingMatches || row.requestHash !== input.__requestHash || row.evidenceHash !== input.evidenceHash) {
    throw new AppError("payment_reversal_conflict", 409);
  }
  return {
    decision: row.decision,
    duplicate: true,
    orderId: row.orderId,
    reversalId: row.id,
    revoked: row.decision === "full_refund" || row.decision === "chargeback",
  };
}

// Internal fields are attached only to the short-lived input object so replay
// checks compare the full normalized request without persisting raw evidence.
type HashedInput = ApplyVerifiedPaymentReversalInput & { __requestHash: string };

async function loadStoredReversal(input: HashedInput, providerReferenceHash: string): Promise<StoredReversalRow | null> {
  const byIdempotency = await input.env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, order_id AS orderId,
      payment_attempt_id AS paymentAttemptId, integration_id AS integrationId,
      original_payment_event_id AS originalPaymentEventId, provider,
      reversal_kind AS reversalKind, decision,
      provider_reference_hash AS providerReferenceHash,
      evidence_hash AS evidenceHash, idempotency_key_hash AS idempotencyKeyHash,
      request_hash AS requestHash
    FROM payment_reversal_events
    WHERE shop_id = ? AND idempotency_key_hash = ?
    LIMIT 1
  `).bind(input.shopId, await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "payment-reversal-idempotency", input.idempotencyKey)).first<StoredReversalRow>();
  if (byIdempotency !== null) return byIdempotency;
  return input.env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, order_id AS orderId,
      payment_attempt_id AS paymentAttemptId, integration_id AS integrationId,
      original_payment_event_id AS originalPaymentEventId, provider,
      reversal_kind AS reversalKind, decision,
      provider_reference_hash AS providerReferenceHash,
      evidence_hash AS evidenceHash, idempotency_key_hash AS idempotencyKeyHash,
      request_hash AS requestHash
    FROM payment_reversal_events
    WHERE shop_id = ? AND integration_id = ? AND provider = ?
      AND provider_reference_hash = ?
    LIMIT 1
  `).bind(input.shopId, input.integrationId, input.provider, providerReferenceHash).first<StoredReversalRow>();
}

async function loadAuthoritativePayment(input: ApplyVerifiedPaymentReversalInput): Promise<AuthoritativePaymentRow | null> {
  return input.env.PLATFORM_DB.prepare(`
    SELECT attempts.id AS attemptId,
      attempts.shop_id AS shopId, attempts.order_id AS orderId,
      attempts.integration_id AS integrationId, attempts.credential_id AS credentialId,
      attempts.provider, attempts.state AS attemptState,
      attempts.expected_amount_minor AS attemptExpectedAmount,
      attempts.currency AS attemptCurrency,
      credentials.version AS credentialVersion,
      orders.total_minor AS orderTotal, orders.currency AS orderCurrency,
      orders.status AS orderStatus, orders.payment_status AS orderPaymentStatus,
      attempts.paid_event_id AS originalPaymentEventId
    FROM payment_attempts AS attempts
    INNER JOIN orders
      ON orders.id = attempts.order_id AND orders.shop_id = attempts.shop_id
    INNER JOIN payment_integrations AS integrations
      ON integrations.id = attempts.integration_id
      AND integrations.shop_id = attempts.shop_id
      AND integrations.provider = attempts.provider
    INNER JOIN payment_credentials AS credentials
      ON credentials.id = attempts.credential_id
      AND credentials.shop_id = attempts.shop_id
      AND credentials.integration_id = attempts.integration_id
      AND credentials.provider = attempts.provider
    INNER JOIN payment_events AS paid_event
      ON paid_event.id = attempts.paid_event_id
      AND paid_event.shop_id = attempts.shop_id
      AND paid_event.payment_attempt_id = attempts.id
      AND paid_event.integration_id = attempts.integration_id
      AND paid_event.provider = attempts.provider
      AND paid_event.signature_verified = 1
      AND paid_event.normalized_state = 'paid_exact'
      AND paid_event.process_result = 'fulfilled'
      AND paid_event.processed_at IS NOT NULL
    WHERE attempts.id = ? AND attempts.shop_id = ? AND attempts.order_id = ?
      AND attempts.integration_id = ? AND attempts.credential_id = ?
      AND attempts.provider = ? AND attempts.paid_event_id = ?
    LIMIT 1
  `).bind(
    input.paymentAttemptId,
    input.shopId,
    input.orderId,
    input.integrationId,
    input.credentialId,
    input.provider,
    input.originalPaymentEventId,
  ).first<AuthoritativePaymentRow>();
}

function deriveDecision(input: ApplyVerifiedPaymentReversalInput, payment: AuthoritativePaymentRow): {
  decision: PaymentReversalDecision;
  reasonCode: string;
} {
  const expectationsAgree = payment.attemptExpectedAmount === payment.orderTotal
    && payment.attemptCurrency === payment.orderCurrency;
  const amountExact = input.amountMinor === payment.attemptExpectedAmount
    && input.amountMinor === payment.orderTotal;
  const currencyExact = input.currency === payment.attemptCurrency
    && input.currency === payment.orderCurrency;
  if (payment.orderPaymentStatus !== "paid" || payment.orderStatus === "canceled" || payment.orderStatus === "expired") {
    return { decision: "manual_review", reasonCode: "payment_reversal_manual_review" };
  }
  if (input.reversalKind === "refund" && expectationsAgree && amountExact && currencyExact) {
    return { decision: "full_refund", reasonCode: "payment_full_refund" };
  }
  if (input.reversalKind === "chargeback" && expectationsAgree && amountExact && currencyExact) {
    return { decision: "chargeback", reasonCode: "payment_chargeback" };
  }
  if (currencyExact && input.amountMinor < payment.attemptExpectedAmount) {
    return { decision: "partial", reasonCode: "payment_reversal_partial" };
  }
  return { decision: "mismatch", reasonCode: "payment_reversal_mismatch" };
}

function safeExceptionEvidence(input: ApplyVerifiedPaymentReversalInput, payment: AuthoritativePaymentRow, reversalId: string, decision: PaymentReversalDecision): string {
  return JSON.stringify({
    amount: input.amountMinor,
    decision,
    expectedAmount: payment.attemptExpectedAmount,
    occurredAt: input.occurredAt,
    reversalId,
    reversalKind: input.reversalKind,
  });
}

function transitionHashes(reversalId: string, entitlementId: string): { idempotency: string; request: string } {
  const idempotency = JSON.stringify({ entitlementId, purpose: "payment-reversal", reversalId });
  const request = JSON.stringify({ entitlementId, reversalId, transition: "revoked" });
  // These values are hashed by the caller's crypto helper before binding.
  return { idempotency, request };
}

async function buildGenericTransitionStatements(input: {
  database: D1Database;
  entitlementIds: readonly GenericEntitlementTarget[];
  nowIso: string;
  reversalId: string;
  shopId: string;
}): Promise<D1PreparedStatement[]> {
  const statements: D1PreparedStatement[] = [];
  for (const target of input.entitlementIds) {
    const hashes = transitionHashes(input.reversalId, target.id);
    statements.push(input.database.prepare(`
      INSERT INTO entitlement_transitions (
        id, shop_id, entitlement_id, requirement_id, resource_id,
        entitlement_version, from_status, to_status, source_grant_id,
        reason_code, idempotency_key_hash, request_hash, actor_kind,
        actor_user_id, occurred_at, created_at
      ) SELECT ?, entitlements.shop_id, entitlements.id,
        entitlements.requirement_id, entitlements.resource_id,
        entitlements.version, previous.to_status, 'revoked', NULL,
        'payment_reversal', ?, ?, 'system', NULL, ?, ?
      FROM entitlements
      INNER JOIN entitlement_transitions AS previous
        ON previous.shop_id = entitlements.shop_id
        AND previous.entitlement_id = entitlements.id
        AND previous.entitlement_version = entitlements.version - 1
      WHERE entitlements.id = ? AND entitlements.shop_id = ?
        AND entitlements.status = 'revoked'
        AND entitlements.revoked_at = ?
        AND NOT EXISTS (
          SELECT 1 FROM entitlement_transitions AS existing
          WHERE existing.shop_id = entitlements.shop_id
            AND existing.entitlement_id = entitlements.id
            AND existing.entitlement_version = entitlements.version
        )
    `).bind(
      createId("etr"),
      await sha256Json(hashes.idempotency),
      await sha256Json(hashes.request),
      input.nowIso,
      input.nowIso,
      target.id,
      input.shopId,
      input.nowIso,
    ));
  }
  return statements;
}

function revokingEventExists(): string {
  return `EXISTS (
    SELECT 1 FROM payment_reversal_events
    WHERE id = ? AND shop_id = ? AND decision IN ('full_refund', 'chargeback')
  )`;
}

export async function applyVerifiedPaymentReversal(input: ApplyVerifiedPaymentReversalInput): Promise<ApplyVerifiedPaymentReversalResult> {
  assertInput(input);
  const providerReferenceHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "payment-reversal-reference", input.providerReference);
  const idempotencyKeyHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "payment-reversal-idempotency", input.idempotencyKey);
  const requestShape = {
    amountMinor: input.amountMinor,
    credentialId: input.credentialId,
    credentialVersion: input.credentialVersion,
    currency: input.currency,
    integrationId: input.integrationId,
    occurredAt: input.occurredAt,
    orderId: input.orderId,
    originalPaymentEventId: input.originalPaymentEventId,
    paymentAttemptId: input.paymentAttemptId,
    provider: input.provider,
    providerReferenceHash,
    reversalKind: input.reversalKind,
    shopId: input.shopId,
    verificationMethod: input.verificationMethod,
  };
  const hashedInput = {
    ...input,
    __requestHash: await sha256Json({ ...requestShape, purpose: "payment-reversal-request" }),
  } satisfies HashedInput;
  const replay = await loadStoredReversal(hashedInput, providerReferenceHash);
  if (replay !== null) return mapStored(replay, hashedInput);

  const payment = await loadAuthoritativePayment(input);
  if (payment === null
    || payment.attemptState !== "paid_exact"
    || payment.credentialVersion !== input.credentialVersion) {
    throw new AppError("payment_reversal_not_admissible", 409);
  }
  const { decision, reasonCode } = deriveDecision(input, payment);
  const reversalId = createId("prev");
  const nowIso = new Date().toISOString();
  const isRevoking = decision === "full_refund" || decision === "chargeback";
  const genericTargets = isRevoking
    ? (await input.env.PLATFORM_DB.prepare(`
        SELECT id FROM entitlements
        WHERE shop_id = ? AND order_id = ?
          AND status IN ('pending', 'active', 'suspended')
        ORDER BY id
      `).bind(input.shopId, input.orderId).all<GenericEntitlementTarget>()).results
    : [];

  const statements: D1PreparedStatement[] = [
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO payment_reversal_events (
        id, shop_id, order_id, payment_attempt_id, integration_id,
        credential_id, credential_version, original_payment_event_id,
        provider, reversal_kind, decision, verification_method,
        evidence_verified, amount_minor, expected_amount_minor,
        currency, expected_currency, provider_reference_hash,
        provider_reference_hash_key_version, evidence_hash,
        idempotency_key_hash, request_hash, reason_code, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?,
        'identifier-hmac-v1', ?, ?, ?, ?, ?, ?)
    `).bind(
      reversalId,
      input.shopId,
      input.orderId,
      input.paymentAttemptId,
      input.integrationId,
      input.credentialId,
      input.credentialVersion,
      input.originalPaymentEventId,
      input.provider,
      input.reversalKind,
      decision,
      input.verificationMethod,
      input.amountMinor,
      payment.attemptExpectedAmount,
      input.currency,
      payment.attemptCurrency,
      providerReferenceHash,
      input.evidenceHash,
      idempotencyKeyHash,
      hashedInput.__requestHash,
      reasonCode,
      input.occurredAt,
      nowIso,
    ),
  ];

  if (!isRevoking) {
    statements.push(input.env.PLATFORM_DB.prepare(`
      INSERT INTO payment_exceptions (
        id, shop_id, order_id, payment_attempt_id, type, status,
        safe_evidence_json, created_at
      ) SELECT ?, ?, ?, ?, 'manual_review', 'open', ?, ?
      WHERE EXISTS (SELECT 1 FROM payment_reversal_events WHERE id = ? AND shop_id = ?)
    `).bind(
      createId("pex"),
      input.shopId,
      input.orderId,
      input.paymentAttemptId,
      safeExceptionEvidence(input, payment, reversalId, decision),
      nowIso,
      reversalId,
      input.shopId,
    ));
  } else {
    const eventFenceValues = [reversalId, input.shopId] as const;
    statements.push(input.env.PLATFORM_DB.prepare(`
      UPDATE orders
      SET payment_status = 'refunded', updated_at = ?
      WHERE id = ? AND shop_id = ? AND payment_status = 'paid'
        AND status IN ('processing', 'completed')
        AND ${revokingEventExists()}
    `).bind(nowIso, input.orderId, input.shopId, ...eventFenceValues));
    statements.push(input.env.PLATFORM_DB.prepare(`
      UPDATE entitlements
      SET status = 'revoked', revoked_at = ?, suspended_at = NULL,
        version = version + 1, updated_at = ?
      WHERE shop_id = ? AND order_id = ?
        AND status IN ('pending', 'active', 'suspended')
        AND ${revokingEventExists()}
    `).bind(nowIso, nowIso, input.shopId, input.orderId, ...eventFenceValues));
    statements.push(input.env.PLATFORM_DB.prepare(`
      UPDATE digital_entitlements
      SET status = 'revoked', revoked_at = ?, version = version + 1, updated_at = ?
      WHERE shop_id = ? AND order_id = ? AND status IN ('active', 'suspended')
        AND ${revokingEventExists()}
    `).bind(nowIso, nowIso, input.shopId, input.orderId, ...eventFenceValues));
    statements.push(input.env.PLATFORM_DB.prepare(`
      UPDATE delivery_grants
      SET status = 'revoked', revoked_at = ?, version = version + 1, updated_at = ?
      WHERE shop_id = ? AND order_id = ? AND status = 'active'
        AND ${revokingEventExists()}
    `).bind(nowIso, nowIso, input.shopId, input.orderId, ...eventFenceValues));
    statements.push(input.env.PLATFORM_DB.prepare(`
      UPDATE generated_license_requests
      SET status = 'canceled', canceled_at = ?, lease_token = NULL,
        lease_expires_at = NULL, last_safe_error_code = 'payment_reversal',
        version = version + 1, updated_at = ?
      WHERE shop_id = ? AND order_id = ?
        AND status IN ('pending', 'retryable', 'processing', 'reconcile_pending')
        AND EXISTS (
          SELECT 1
          FROM entitlements
          INNER JOIN entitlement_resources
            ON entitlement_resources.id = entitlements.resource_id
            AND entitlement_resources.shop_id = entitlements.shop_id
          WHERE entitlements.id = generated_license_requests.entitlement_id
            AND entitlements.shop_id = generated_license_requests.shop_id
            AND entitlements.order_id = generated_license_requests.order_id
            AND entitlements.status = 'revoked'
            AND entitlements.revoked_at = ?
            AND entitlement_resources.resource_type = 'generated_license'
        )
        AND ${revokingEventExists()}
    `).bind(
      nowIso,
      nowIso,
      input.shopId,
      input.orderId,
      nowIso,
      ...eventFenceValues,
    ));
    statements.push(input.env.PLATFORM_DB.prepare(`
      UPDATE generated_license_artifacts
      SET status = 'revoked', revoked_at = ?
      WHERE shop_id = ? AND status = 'active'
        AND EXISTS (
          SELECT 1
          FROM entitlements
          INNER JOIN entitlement_resources
            ON entitlement_resources.id = entitlements.resource_id
            AND entitlement_resources.shop_id = entitlements.shop_id
          WHERE entitlements.id = generated_license_artifacts.entitlement_id
            AND entitlements.shop_id = generated_license_artifacts.shop_id
            AND entitlements.order_id = ?
            AND entitlements.status = 'revoked'
            AND entitlements.revoked_at = ?
            AND entitlement_resources.resource_type = 'generated_license'
        )
        AND ${revokingEventExists()}
    `).bind(
      nowIso,
      input.shopId,
      input.orderId,
      nowIso,
      ...eventFenceValues,
    ));
    // Release physical inventory back to sellable stock. The status predicate
    // keeps the restock idempotent and the tenant-fenced subquery only matches
    // order items of the reversed order, so concurrent checkouts on the same
    // variant are untouched.
    statements.push(input.env.PLATFORM_DB.prepare(`
      UPDATE inventory_keys
      SET status = 'available', sold_order_item_id = NULL, sold_at = NULL
      WHERE shop_id = ? AND status = 'sold'
        AND sold_order_item_id IN (
          SELECT order_items.id
          FROM order_items
          WHERE order_items.order_id = ? AND order_items.shop_id = ?
        )
        AND ${revokingEventExists()}
    `).bind(input.shopId, input.orderId, input.shopId, ...eventFenceValues));
    statements.push(...await buildGenericTransitionStatements({
      database: input.env.PLATFORM_DB,
      entitlementIds: genericTargets,
      nowIso,
      reversalId,
      shopId: input.shopId,
    }));
  }

  statements.push(input.env.PLATFORM_DB.prepare(`
    INSERT INTO audit_logs (
      id, shop_id, actor_type, actor_id, action, resource_type,
      resource_id, safe_metadata_json, request_id, source_kind,
      retention_class, created_at
    ) SELECT ?, ?, 'system', NULL, ?, 'payment_reversal', ?, ?, ?, ?, 'financial', ?
    WHERE EXISTS (SELECT 1 FROM payment_reversal_events WHERE id = ? AND shop_id = ?)
  `).bind(
    createId("aud"),
    input.shopId,
    isRevoking ? "payment_reversal.applied" : "payment_reversal.manual_review",
    reversalId,
    JSON.stringify({
      decision,
      orderId: input.orderId,
      paymentAttemptId: input.paymentAttemptId,
      reversalKind: input.reversalKind,
    }),
    input.requestId,
    input.verificationMethod === "direct_reconciliation" ? "scheduled" : "http",
    nowIso,
    reversalId,
    input.shopId,
  ));

  try {
    const results = await input.env.PLATFORM_DB.batch(statements);
    if (isRevoking && (results[1]?.meta.changes ?? 0) !== 1) {
      throw new AppError("payment_reversal_state_conflict", 409);
    }
    return {
      decision,
      duplicate: false,
      orderId: input.orderId,
      reversalId,
      revoked: isRevoking,
    };
  } catch (error) {
    const raced = await loadStoredReversal(hashedInput, providerReferenceHash);
    if (raced !== null) return mapStored(raced, hashedInput);
    if (error instanceof AppError) throw error;
    const order = await input.env.PLATFORM_DB.prepare(`
      SELECT payment_status AS paymentStatus
      FROM orders WHERE id = ? AND shop_id = ? LIMIT 1
    `).bind(input.orderId, input.shopId).first<{ paymentStatus: string }>();
    if (order?.paymentStatus !== "paid") throw new AppError("payment_reversal_state_conflict", 409);
    throw new AppError("payment_reversal_apply_failed", 500);
  }
}
