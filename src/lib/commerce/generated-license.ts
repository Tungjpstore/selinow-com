import { tryRecordFirstPaidFulfilled } from "../analytics/activation";
import { constantTimeEqual, hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId, createOpaqueToken } from "../core/ids";
import { resolveActiveEncryptionKey, resolveEncryptionKey } from "../crypto/keyring";
import type { AppBindings } from "../platform/bindings";
import {
  decryptGeneratedLicenseArtifact,
  decryptGeneratedLicenseProviderSecrets,
  encryptGeneratedLicenseArtifact,
  encryptGeneratedLicenseProviderSecrets,
} from "./generated-license-crypto";
import type {
  GeneratedLicenseFormat,
  GeneratedLicenseProviderFailure,
  GeneratedLicenseProviderRequest,
  GeneratedLicenseProviderResult,
  GeneratedLicenseProviderRegistry,
  GeneratedLicenseProviderSuccess,
} from "./generated-license-provider";

export {
  type GeneratedLicenseFormat,
  type GeneratedLicenseProviderAdapter,
  type GeneratedLicenseProviderCall,
  type GeneratedLicenseProviderFailure,
  type GeneratedLicenseProviderRequest,
  type GeneratedLicenseProviderResult,
  GeneratedLicenseProviderRegistry,
  type GeneratedLicenseProviderSuccess,
  SellerWebhookGeneratedLicenseAdapter,
} from "./generated-license-provider";

const MAX_GENERATED_LICENSE_ATTEMPTS = 8;
const GENERATED_LICENSE_LEASE_MS = 5 * 60_000;
const GENERATED_LICENSE_BACKOFF_BASE_SECONDS = 30;

type DatabaseLike = AppBindings["PLATFORM_DB"];

export type GeneratedLicenseQueueEnvelope = Readonly<{
  kind: "integration";
  operationId: "generated_license_dispatch";
  referenceId: string;
  referenceType: "generated_license_request";
  requestId: string;
  shopId: string;
  sourceQueue: "integration";
  version: 1;
}>;

async function hasGeneratedLicenseSchema(database: DatabaseLike): Promise<boolean> {
  const row = await database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'generated_license_requests' LIMIT 1",
  ).bind().first<{ name: string }>();
  return row !== null;
}

function validateSellerWebhookEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("validation_failed", 400, ["generated_license_endpoint_invalid"]);
  }
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
    throw new AppError("validation_failed", 400, ["generated_license_endpoint_invalid"]);
  }
  return url.toString();
}

export async function createGeneratedLicenseProviderConfiguration(input: {
  credential: string;
  endpoint: string;
  env: AppBindings;
  providerCode?: "seller.webhook";
  providerEnvironment: "live" | "sandbox";
  resourceId: string;
  shopId: string;
  userId: string;
}): Promise<{
  bindingId: string;
  connectionId: string;
  credentialVersion: number;
  providerCode: string;
  status: "active";
}> {
  if (!(await hasGeneratedLicenseSchema(input.env.PLATFORM_DB))) {
    throw new AppError("generated_license_schema_unavailable", 503);
  }
  const endpoint = validateSellerWebhookEndpoint(input.endpoint);
  if (input.credential.length < 8 || input.credential.length > 4_096) {
    throw new AppError("validation_failed", 400, ["generated_license_credential_invalid"]);
  }
  const providerCode = input.providerCode ?? "seller.webhook";
  const actor = await input.env.PLATFORM_DB.prepare(`
    SELECT resources.id AS resourceId
    FROM entitlement_resources AS resources
    INNER JOIN shop_members
      ON shop_members.shop_id = resources.shop_id
      AND shop_members.user_id = ?
      AND shop_members.status = 'active'
      AND shop_members.role IN ('owner', 'manager')
    WHERE resources.id = ? AND resources.shop_id = ?
      AND resources.resource_type = 'generated_license'
      AND resources.status = 'active'
    LIMIT 1
  `).bind(input.userId, input.resourceId, input.shopId).first<{ resourceId: string }>();
  if (actor === null) throw new AppError("authorization_denied", 403);

  const connectionId = createId("glc");
  const credentialId = createId("gls");
  const bindingId = createId("glb");
  const key = resolveActiveEncryptionKey(input.env, "credential");
  const encrypted = await encryptGeneratedLicenseProviderSecrets({
    connectionId,
    credential: input.credential,
    credentialId,
    endpoint,
    hmacSecret: input.env.IDENTIFIER_HMAC_SECRET,
    kek: key.kek,
    keyVersion: key.version,
    shopId: input.shopId,
  });
  const existing = await input.env.PLATFORM_DB.prepare(`
    SELECT connection.id AS connectionId, binding.id AS bindingId,
      credential.id AS credentialId, credential.key_version AS keyVersion,
      credential.credential_version AS credentialVersion,
      credential.endpoint_ciphertext_b64 AS endpointCiphertextB64,
      credential.endpoint_iv_b64 AS endpointIvB64,
      credential.credential_ciphertext_b64 AS credentialCiphertextB64,
      credential.credential_iv_b64 AS credentialIvB64,
      credential.endpoint_fingerprint AS endpointFingerprint,
      credential.credential_fingerprint AS credentialFingerprint
    FROM generated_license_resource_bindings AS binding
    INNER JOIN generated_license_provider_connections AS connection
      ON connection.id = binding.connection_id AND connection.shop_id = binding.shop_id
    INNER JOIN generated_license_provider_credentials AS credential
      ON credential.connection_id = connection.id AND credential.shop_id = connection.shop_id
      AND credential.status = 'active'
    WHERE binding.shop_id = ? AND binding.resource_id = ? AND binding.status = 'active'
    LIMIT 1
  `).bind(input.shopId, input.resourceId).first<{
    bindingId: string;
    connectionId: string;
    credentialCiphertextB64: string;
    credentialFingerprint: string;
    credentialId: string;
    credentialIvB64: string;
    credentialVersion: number;
    endpointCiphertextB64: string;
    endpointFingerprint: string;
    endpointIvB64: string;
    keyVersion: string;
  }>();
  if (existing !== null) {
    const existingKey = resolveEncryptionKey(input.env, "credential", existing.keyVersion);
    const existingSecrets = await decryptGeneratedLicenseProviderSecrets({
      credentialCiphertextB64: existing.credentialCiphertextB64,
      credentialFingerprint: existing.credentialFingerprint,
      credentialIvB64: existing.credentialIvB64,
      endpointCiphertextB64: existing.endpointCiphertextB64,
      endpointFingerprint: existing.endpointFingerprint,
      endpointIvB64: existing.endpointIvB64,
      keyVersion: existing.keyVersion,
    }, {
      connectionId: existing.connectionId,
      credentialId: existing.credentialId,
      kek: existingKey.kek,
      keyVersion: existingKey.version,
      shopId: input.shopId,
    });
    if (!constantTimeEqual(existingSecrets.endpoint, endpoint)
      || !constantTimeEqual(existingSecrets.credential, input.credential)) {
      throw new AppError("generated_license_configuration_conflict", 409);
    }
    return {
      bindingId: existing.bindingId,
      connectionId: existing.connectionId,
      credentialVersion: existing.credentialVersion,
      providerCode,
      status: "active",
    };
  }

  const nowIso = new Date().toISOString();
  const requestShapeHash = await sha256Json({
    fields: ["idempotencyKey", "operation", "orderReference", "quantity", "requestReference", "resourceKey", "version"],
    purpose: "generated-license-seller-webhook-shape",
    version: 1,
  });
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO generated_license_provider_connections (
        id, shop_id, provider_code, provider_environment, descriptor_version,
        status, created_by_user_id, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, 'active', ?, 1, ?, ?)
    `).bind(connectionId, input.shopId, providerCode, input.providerEnvironment, input.userId, nowIso, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO generated_license_provider_credentials (
        id, shop_id, connection_id, provider_code, credential_version, status,
        key_version, endpoint_ciphertext_b64, endpoint_iv_b64,
        credential_ciphertext_b64, credential_iv_b64,
        endpoint_fingerprint, credential_fingerprint, created_by_user_id,
        activated_at, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(
      credentialId,
      input.shopId,
      connectionId,
      providerCode,
      encrypted.keyVersion,
      encrypted.endpointCiphertextB64,
      encrypted.endpointIvB64,
      encrypted.credentialCiphertextB64,
      encrypted.credentialIvB64,
      encrypted.endpointFingerprint,
      encrypted.credentialFingerprint,
      input.userId,
      nowIso,
      nowIso,
      nowIso,
    ),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO generated_license_resource_bindings (
        id, shop_id, resource_id, connection_id, provider_code,
        generation_template_version, request_shape_hash, status,
        created_by_user_id, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, 1, ?, 'active', ?, ?, ?, 1)
    `).bind(bindingId, input.shopId, input.resourceId, connectionId, providerCode, requestShapeHash, input.userId, nowIso, nowIso),
  ]);
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new AppError("generated_license_configuration_conflict", 409);
  }
  return { bindingId, connectionId, credentialVersion: 1, providerCode, status: "active" };
}

export async function prepareGeneratedLicenseRequirementStatements(input: {
  database: DatabaseLike;
  entitlementId: string;
  nowIso: string;
  requirementId: string;
  shopId: string;
}): Promise<ReadonlyArray<D1PreparedStatement>> {
  if (!(await hasGeneratedLicenseSchema(input.database))) return [];
  return [input.database.prepare(`
    INSERT INTO generated_license_requirement_snapshots (
      id, shop_id, entitlement_requirement_id, entitlement_id, order_id,
      order_item_id, resource_id, binding_id, connection_id, provider_code,
      generation_template_version, request_shape_hash, requested_quantity, created_at
    )
    SELECT ?, requirement.shop_id, requirement.id, ?, requirement.order_id,
      requirement.order_item_id, requirement.resource_id, binding.id,
      binding.connection_id, binding.provider_code,
      binding.generation_template_version, binding.request_shape_hash, 1, ?
    FROM order_item_entitlement_requirements AS requirement
    INNER JOIN entitlement_resources AS resource
      ON resource.id = requirement.resource_id AND resource.shop_id = requirement.shop_id
    INNER JOIN generated_license_resource_bindings AS binding
      ON binding.resource_id = resource.id AND binding.shop_id = resource.shop_id
    WHERE requirement.id = ? AND requirement.shop_id = ?
      AND requirement.grant_quantity = 1
      AND resource.resource_type = 'generated_license'
      AND resource.status = 'active'
      AND binding.status = 'active'
  `).bind(createId("glr"), input.entitlementId, input.nowIso, input.requirementId, input.shopId)];
}

export async function prepareGeneratedLicenseRequestStatements(input: {
  database: DatabaseLike;
  entitlementGrantId: string;
  entitlementId: string;
  nowIso: string;
  orderId: string;
  requirementId: string;
  shopId: string;
}): Promise<ReadonlyArray<D1PreparedStatement>> {
  if (!(await hasGeneratedLicenseSchema(input.database))) return [];
  const providerIdempotencyKeyHash = await sha256Json({
    entitlementGrantId: input.entitlementGrantId,
    entitlementId: input.entitlementId,
    purpose: "generated-license-provider-idempotency-v1",
    shopId: input.shopId,
    unitOrdinal: 1,
  });
  const requestHash = await sha256Json({
    entitlementGrantId: input.entitlementGrantId,
    entitlementId: input.entitlementId,
    orderId: input.orderId,
    purpose: "generated-license-request-v1",
    requirementId: input.requirementId,
    shopId: input.shopId,
    unitOrdinal: 1,
  });
  return [input.database.prepare(`
    INSERT INTO generated_license_requests (
      id, shop_id, requirement_snapshot_id, entitlement_id,
      entitlement_grant_id, order_id, resource_id, connection_id,
      provider_code, unit_ordinal, provider_idempotency_key_hash,
      request_hash, credential_version, status, attempt_count,
      next_attempt_at, version, created_at, updated_at
    )
    SELECT ?, snapshot.shop_id, snapshot.id, snapshot.entitlement_id,
      ?, snapshot.order_id, snapshot.resource_id, snapshot.connection_id,
      snapshot.provider_code, 1, ?, ?, COALESCE(credential.credential_version, 0),
      'pending', 0, ?, 1, ?, ?
    FROM generated_license_requirement_snapshots AS snapshot
    LEFT JOIN generated_license_provider_credentials AS credential
      ON credential.connection_id = snapshot.connection_id
      AND credential.shop_id = snapshot.shop_id
      AND credential.provider_code = snapshot.provider_code
      AND credential.status = 'active'
    WHERE snapshot.entitlement_id = ?
      AND snapshot.entitlement_requirement_id = ?
      AND snapshot.order_id = ?
      AND snapshot.shop_id = ?
    ON CONFLICT(shop_id, requirement_snapshot_id, unit_ordinal) DO NOTHING
  `).bind(
    createId("glq"),
    input.entitlementGrantId,
    providerIdempotencyKeyHash,
    requestHash,
    input.nowIso,
    input.nowIso,
    input.nowIso,
    input.entitlementId,
    input.requirementId,
    input.orderId,
    input.shopId,
  )];
}

export function createGeneratedLicenseQueueEnvelope(input: {
  requestId: string;
  shopId: string;
}): GeneratedLicenseQueueEnvelope {
  return {
    kind: "integration",
    operationId: "generated_license_dispatch",
    referenceId: input.requestId,
    referenceType: "generated_license_request",
    requestId: input.requestId,
    shopId: input.shopId,
    sourceQueue: "integration",
    version: 1,
  };
}

export function isGeneratedLicenseQueueEnvelope(value: unknown): value is GeneratedLicenseQueueEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expected = ["kind", "operationId", "referenceId", "referenceType", "requestId", "shopId", "sourceQueue", "version"].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && candidate.version === 1
    && candidate.kind === "integration"
    && candidate.sourceQueue === "integration"
    && candidate.operationId === "generated_license_dispatch"
    && candidate.referenceType === "generated_license_request"
    && typeof candidate.referenceId === "string"
    && typeof candidate.requestId === "string"
    && candidate.requestId === candidate.referenceId
    && typeof candidate.shopId === "string";
}

export async function enqueueDueGeneratedLicenseRequests(
  env: AppBindings,
  now: Date,
  limit = 50,
): Promise<{ candidates: number; failed: number; sent: number }> {
  if (!(await hasGeneratedLicenseSchema(env.PLATFORM_DB))) return { candidates: 0, failed: 0, sent: 0 };
  const nowIso = now.toISOString();
  const rows = await env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId
    FROM generated_license_requests
    WHERE (
      status IN ('pending', 'retryable', 'reconcile_pending') AND next_attempt_at <= ?
    ) OR (
      status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    )
    ORDER BY next_attempt_at, id
    LIMIT ?
  `).bind(nowIso, nowIso, Math.min(Math.max(limit, 1), 100)).all<{ id: string; shopId: string }>();
  let sent = 0;
  let failed = 0;
  for (const row of rows.results) {
    try {
      await env.INTEGRATION_QUEUE.send(createGeneratedLicenseQueueEnvelope({ requestId: row.id, shopId: row.shopId }));
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { candidates: rows.results.length, failed, sent };
}

type GeneratedLicenseClaim = {
  attemptNo: number;
  connectionId: string;
  credentialCiphertextB64: string;
  credentialId: string;
  credentialIvB64: string;
  credentialFingerprint: string;
  credentialVersion: number;
  endpointCiphertextB64: string;
  endpointIvB64: string;
  endpointFingerprint: string;
  entitlementId: string;
  priorStatus: string;
  providerCode: string;
  providerIdempotencyKeyHash: string;
  requestHash: string;
  requestId: string;
  resourceKey: string;
  orderPublicId: string;
  orderId: string;
  shopId: string;
  keyVersion: string;
  leaseToken: string;
  version: number;
};

type GeneratedLicenseAction = "generate" | "reconcile";

function generatedLicenseAction(priorStatus: string): GeneratedLicenseAction {
  return priorStatus === "reconcile_pending" || priorStatus === "processing" ? "reconcile" : "generate";
}

function generatedLicenseExceptionFailure(input: {
  action: GeneratedLicenseAction;
  stage: "credential" | "provider" | "registry";
  error: unknown;
}): GeneratedLicenseProviderFailure {
  if (input.stage === "credential") {
    return { errorCode: "generated_license_credential_unavailable", kind: "retryable" };
  }
  if (input.stage === "registry") {
    return {
      errorCode: input.error instanceof AppError && input.error.code === "generated_license_provider_unsupported"
        ? input.error.code
        : "generated_license_provider_unavailable",
      kind: "retryable",
    };
  }
  return {
    errorCode: "generated_license_provider_exception",
    kind: input.action === "generate" ? "ambiguous" : "retryable",
  };
}

async function claimGeneratedLicenseRequest(input: {
  env: AppBindings;
  now: Date;
  requestId: string;
  shopId: string;
}): Promise<GeneratedLicenseClaim | null> {
  const nowIso = input.now.toISOString();
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT request.id, request.shop_id AS shopId, request.status AS priorStatus,
      request.version, request.attempt_count AS attemptCount,
      request.connection_id AS connectionId, request.provider_code AS providerCode,
      request.provider_idempotency_key_hash AS providerIdempotencyKeyHash,
      request.request_hash AS requestHash, request.entitlement_id AS entitlementId,
      resource.resource_key AS resourceKey, orders.id AS orderId,
      orders.public_id AS orderPublicId,
      credential.id AS credentialId, credential.credential_version AS credentialVersion,
      credential.key_version AS keyVersion,
      credential.endpoint_ciphertext_b64 AS endpointCiphertextB64,
      credential.endpoint_iv_b64 AS endpointIvB64,
      credential.credential_ciphertext_b64 AS credentialCiphertextB64,
      credential.credential_iv_b64 AS credentialIvB64,
      credential.endpoint_fingerprint AS endpointFingerprint,
      credential.credential_fingerprint AS credentialFingerprint
    FROM generated_license_requests AS request
    INNER JOIN entitlements AS entitlement
      ON entitlement.id = request.entitlement_id AND entitlement.shop_id = request.shop_id
    INNER JOIN entitlement_resources AS resource
      ON resource.id = request.resource_id AND resource.shop_id = request.shop_id
    INNER JOIN orders
      ON orders.id = request.order_id AND orders.shop_id = request.shop_id
    INNER JOIN generated_license_provider_connections AS connection
      ON connection.id = request.connection_id
      AND connection.shop_id = request.shop_id
      AND connection.provider_code = request.provider_code
      AND connection.status IN ('active', 'degraded')
    INNER JOIN generated_license_provider_credentials AS credential
      ON credential.connection_id = request.connection_id
      AND credential.shop_id = request.shop_id
      AND credential.provider_code = request.provider_code
      AND credential.credential_version = request.credential_version
      AND credential.status IN ('active', 'grace')
    WHERE request.id = ? AND request.shop_id = ?
      AND entitlement.status = 'active'
      AND orders.payment_status = 'paid'
      AND orders.status IN ('processing', 'completed')
      AND (
        (request.status IN ('pending', 'retryable', 'reconcile_pending') AND request.next_attempt_at <= ?)
        OR (request.status = 'processing' AND request.lease_expires_at IS NOT NULL AND request.lease_expires_at <= ?)
      )
    LIMIT 1
  `).bind(input.requestId, input.shopId, nowIso, nowIso).first<{
    attemptCount: number;
    connectionId: string;
    credentialCiphertextB64: string;
    credentialId: string;
    credentialIvB64: string;
    credentialFingerprint: string;
    credentialVersion: number;
    endpointCiphertextB64: string;
    endpointIvB64: string;
    endpointFingerprint: string;
    entitlementId: string;
    orderId: string;
    id: string;
    keyVersion: string;
    orderPublicId: string;
    priorStatus: string;
    providerCode: string;
    providerIdempotencyKeyHash: string;
    requestHash: string;
    resourceKey: string;
    shopId: string;
    version: number;
  }>();
  if (row === null) return null;
  const leaseToken = createOpaqueToken();
  const leaseExpiresAt = new Date(input.now.getTime() + GENERATED_LICENSE_LEASE_MS).toISOString();
  const claimed = await input.env.PLATFORM_DB.prepare(`
    UPDATE generated_license_requests
    SET status = 'processing', attempt_count = attempt_count + 1,
      lease_token = ?, lease_expires_at = ?, version = version + 1, updated_at = ?
    WHERE id = ? AND shop_id = ? AND version = ?
      AND (
        (status IN ('pending', 'retryable', 'reconcile_pending') AND next_attempt_at <= ?)
        OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      )
  `).bind(
    leaseToken,
    leaseExpiresAt,
    nowIso,
    row.id,
    row.shopId,
    row.version,
    nowIso,
    nowIso,
  ).run();
  if (claimed.meta.changes !== 1) return null;
  return {
    attemptNo: row.attemptCount + 1,
    connectionId: row.connectionId,
    credentialCiphertextB64: row.credentialCiphertextB64,
    credentialId: row.credentialId,
    credentialIvB64: row.credentialIvB64,
    credentialFingerprint: row.credentialFingerprint,
    credentialVersion: row.credentialVersion,
    endpointCiphertextB64: row.endpointCiphertextB64,
    endpointIvB64: row.endpointIvB64,
    endpointFingerprint: row.endpointFingerprint,
    entitlementId: row.entitlementId,
    keyVersion: row.keyVersion,
    leaseToken,
    orderPublicId: row.orderPublicId,
    orderId: row.orderId,
    priorStatus: row.priorStatus,
    providerCode: row.providerCode,
    providerIdempotencyKeyHash: row.providerIdempotencyKeyHash,
    requestHash: row.requestHash,
    requestId: row.id,
    resourceKey: row.resourceKey,
    shopId: row.shopId,
    version: row.version + 1,
  };
}

function retryAt(now: Date, attemptNo: number, providerDelay?: number): string {
  const seconds = providerDelay === undefined
    ? Math.min(3_600, GENERATED_LICENSE_BACKOFF_BASE_SECONDS * 2 ** Math.min(attemptNo - 1, 7))
    : Math.min(3_600, Math.max(1, providerDelay));
  return new Date(now.getTime() + seconds * 1_000).toISOString();
}

async function normalizedEvidenceHash(result: GeneratedLicenseProviderResult): Promise<string> {
  if (result.kind === "success") {
    return sha256Json({ evidence: result.evidence, format: result.format, kind: result.kind });
  }
  return sha256Json({ errorCode: result.errorCode, kind: result.kind });
}

async function providerReferenceHash(env: AppBindings, shopId: string, reference: string | undefined): Promise<string | null> {
  if (reference === undefined) return null;
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, `generated-license-provider-reference:${shopId}`, reference);
}

function prepareGeneratedLicenseDeadLetterStatement(input: {
  claim: GeneratedLicenseClaim;
  env: AppBindings;
  failureCode: string;
  now: Date;
}): D1PreparedStatement {
  const nowIso = input.now.toISOString();
  return input.env.PLATFORM_DB.prepare(`
    INSERT INTO generated_license_dead_letters (
      id, shop_id, request_id, failure_code, safe_context_json, status,
      provider_attempts, occurrence_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'open', ?, 1, ?, ?)
    ON CONFLICT(shop_id, request_id) DO UPDATE SET
      failure_code = excluded.failure_code,
      safe_context_json = excluded.safe_context_json,
      status = 'open', provider_attempts = excluded.provider_attempts,
      occurrence_count = generated_license_dead_letters.occurrence_count + 1,
      resolution_code = NULL, resolved_at = NULL, updated_at = excluded.updated_at
  `).bind(
    createId("gld"),
    input.claim.shopId,
    input.claim.requestId,
    input.failureCode,
    JSON.stringify({ providerCode: input.claim.providerCode, requestId: input.claim.requestId }),
    input.claim.attemptNo,
    nowIso,
    nowIso,
  );
}

async function settleGeneratedLicenseFailure(input: {
  claim: GeneratedLicenseClaim;
  env: AppBindings;
  now: Date;
  result: GeneratedLicenseProviderFailure;
}): Promise<"failed" | "reconcile_pending" | "retryable"> {
  const nowIso = input.now.toISOString();
  const providerHash = await providerReferenceHash(input.env, input.claim.shopId, input.result.providerReference);
  const evidenceHash = await normalizedEvidenceHash(input.result);
  const exhausted = input.claim.attemptNo >= MAX_GENERATED_LICENSE_ATTEMPTS;
  const action = generatedLicenseAction(input.claim.priorStatus);
  const status = input.result.kind === "ambiguous" && !exhausted
    ? "reconcile_pending"
    : input.result.kind === "retryable" && !exhausted
      ? action === "reconcile" ? "reconcile_pending" : "retryable"
      : "failed";
  const attemptOutcome = input.result.kind === "ambiguous"
    ? "ambiguous"
    : input.result.kind === "retryable"
      ? "retryable"
      : "rejected";
  const nextAttemptAt = status === "failed"
    ? nowIso
    : retryAt(input.now, input.claim.attemptNo, input.result.retryAfterSeconds);
  const statements: D1PreparedStatement[] = [
    input.env.PLATFORM_DB.prepare(`
      UPDATE generated_license_requests
      SET status = ?, next_attempt_at = ?, lease_token = NULL,
        lease_expires_at = NULL, last_safe_error_code = ?,
        provider_reference_hash = COALESCE(?, provider_reference_hash),
        evidence_hash = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND status = 'processing'
        AND lease_token = ? AND version = ?
    `).bind(
      status,
      nextAttemptAt,
      input.result.errorCode,
      providerHash,
      evidenceHash,
      nowIso,
      input.claim.requestId,
      input.claim.shopId,
      input.claim.leaseToken,
      input.claim.version,
    ),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO generated_license_attempts (
        id, shop_id, request_id, attempt_no, action_kind, credential_version,
        request_hash, provider_reference_hash, evidence_hash, outcome,
        safe_error_code, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      createId("gla"),
      input.claim.shopId,
      input.claim.requestId,
      input.claim.attemptNo,
      action,
      input.claim.credentialVersion,
      input.claim.requestHash,
      providerHash,
      evidenceHash,
      attemptOutcome,
      input.result.errorCode,
      nowIso,
      nowIso,
    ),
  ];
  if (status === "failed") {
    statements.push(prepareGeneratedLicenseDeadLetterStatement({ claim: input.claim, env: input.env, failureCode: input.result.errorCode, now: input.now }));
  }
  const results = await input.env.PLATFORM_DB.batch(statements);
  if (results[0]?.meta.changes !== 1) throw new AppError("generated_license_settlement_conflict", 409);
  return status;
}

async function markReconciliationPending(input: {
  claim: GeneratedLicenseClaim;
  env: AppBindings;
  now: Date;
}): Promise<void> {
  await input.env.PLATFORM_DB.prepare(`
    UPDATE generated_license_requests
    SET status = 'reconcile_pending', next_attempt_at = ?, lease_token = NULL,
      lease_expires_at = NULL, last_safe_error_code = 'generated_license_settlement_uncertain',
      version = version + 1, updated_at = ?
    WHERE id = ? AND shop_id = ? AND status = 'processing'
      AND lease_token = ? AND version = ?
  `).bind(
    input.now.toISOString(),
    input.now.toISOString(),
    input.claim.requestId,
    input.claim.shopId,
    input.claim.leaseToken,
    input.claim.version,
  ).run();
}

async function settleGeneratedLicenseSuccess(input: {
  claim: GeneratedLicenseClaim;
  env: AppBindings;
  now: Date;
  result: GeneratedLicenseProviderSuccess;
}): Promise<void> {
  const artifactId = createId("glk");
  const artifactKey = resolveActiveEncryptionKey(input.env, "inventory");
  const encrypted = await encryptGeneratedLicenseArtifact({
    artifactId,
    format: input.result.format,
    hmacSecret: input.env.IDENTIFIER_HMAC_SECRET,
    kek: artifactKey.kek,
    keyVersion: artifactKey.version,
    plaintext: input.result.artifact,
    requestId: input.claim.requestId,
    shopId: input.claim.shopId,
  });
  const providerHash = await providerReferenceHash(input.env, input.claim.shopId, input.result.providerReference);
  const evidenceHash = await normalizedEvidenceHash(input.result);
  const nowIso = input.now.toISOString();
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE generated_license_requests
      SET status = 'succeeded', next_attempt_at = ?, lease_token = NULL,
        lease_expires_at = NULL, last_safe_error_code = NULL,
        provider_reference_hash = COALESCE(?, provider_reference_hash), evidence_hash = ?, succeeded_at = ?,
        version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND status = 'processing'
        AND lease_token = ? AND version = ?
    `).bind(
      nowIso,
      providerHash,
      evidenceHash,
      nowIso,
      nowIso,
      input.claim.requestId,
      input.claim.shopId,
      input.claim.leaseToken,
      input.claim.version,
    ),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO generated_license_attempts (
        id, shop_id, request_id, attempt_no, action_kind, credential_version,
        request_hash, provider_reference_hash, evidence_hash, outcome,
        safe_error_code, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', NULL, ?, ?)
    `).bind(
      createId("gla"),
      input.claim.shopId,
      input.claim.requestId,
      input.claim.attemptNo,
      generatedLicenseAction(input.claim.priorStatus),
      input.claim.credentialVersion,
      input.claim.requestHash,
      providerHash,
      evidenceHash,
      nowIso,
      nowIso,
    ),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO generated_license_artifacts (
        id, shop_id, request_id, entitlement_id, ordinal, ciphertext_b64,
        iv_b64, key_version, artifact_fingerprint, format, status, created_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'active', ?)
    `).bind(
      artifactId,
      input.claim.shopId,
      input.claim.requestId,
      input.claim.entitlementId,
      encrypted.ciphertextB64,
      encrypted.ivB64,
      encrypted.keyVersion,
      encrypted.artifactFingerprint,
      encrypted.format,
      nowIso,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE orders
      SET status = 'completed', fulfillment_status = 'fulfilled',
        fulfilled_at = COALESCE(fulfilled_at, ?), updated_at = ?
      WHERE id = (
        SELECT order_id FROM generated_license_requests
        WHERE id = ? AND shop_id = ?
      )
        AND shop_id = ?
        AND payment_status = 'paid'
        AND status = 'processing'
        AND NOT EXISTS (
          SELECT 1 FROM generated_license_requests AS pending_request
          WHERE pending_request.order_id = orders.id
            AND pending_request.shop_id = orders.shop_id
            AND pending_request.status != 'succeeded'
        )
        AND NOT EXISTS (
          SELECT 1 FROM order_items AS pending_manual_item
          WHERE pending_manual_item.order_id = orders.id
            AND pending_manual_item.shop_id = orders.shop_id
            AND pending_manual_item.fulfillment_type = 'manual'
            AND (
              EXISTS (
                SELECT 1 FROM order_item_fulfillment_requirements AS private_requirement
                WHERE private_requirement.order_item_id = pending_manual_item.id
                  AND private_requirement.shop_id = pending_manual_item.shop_id
                  AND private_requirement.capability = 'private_file'
              )
              OR NOT EXISTS (
                SELECT 1 FROM order_item_entitlement_requirements AS typed_requirement
                WHERE typed_requirement.order_item_id = pending_manual_item.id
                  AND typed_requirement.shop_id = pending_manual_item.shop_id
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM manual_fulfillment_executions AS completed_execution
              WHERE completed_execution.order_item_id = pending_manual_item.id
                AND completed_execution.shop_id = pending_manual_item.shop_id
                AND completed_execution.state = 'completed'
            )
        )
    `).bind(
      nowIso,
      nowIso,
      input.claim.requestId,
      input.claim.shopId,
      input.claim.shopId,
    ),
  ]);
  if (results[0]?.meta.changes !== 1) throw new AppError("generated_license_settlement_conflict", 409);
  await tryRecordFirstPaidFulfilled({ env: input.env, orderId: input.claim.orderId, shopId: input.claim.shopId });
}

export async function processGeneratedLicenseRequestReference(input: {
  env: AppBindings;
  now?: Date;
  registry: GeneratedLicenseProviderRegistry;
  requestId: string;
  shopId: string;
}): Promise<{ state: "failed" | "not_claimed" | "reconcile_pending" | "retryable" | "succeeded" }> {
  const now = input.now ?? new Date();
  const claim = await claimGeneratedLicenseRequest({ env: input.env, now, requestId: input.requestId, shopId: input.shopId });
  if (claim === null) return { state: "not_claimed" };
  const action = generatedLicenseAction(claim.priorStatus);
  let secrets: Awaited<ReturnType<typeof decryptGeneratedLicenseProviderSecrets>>;
  try {
    const credentialKey = resolveEncryptionKey(input.env, "credential", claim.keyVersion);
    secrets = await decryptGeneratedLicenseProviderSecrets({
      credentialCiphertextB64: claim.credentialCiphertextB64,
      credentialIvB64: claim.credentialIvB64,
      credentialFingerprint: claim.credentialFingerprint,
      endpointCiphertextB64: claim.endpointCiphertextB64,
      endpointIvB64: claim.endpointIvB64,
      endpointFingerprint: claim.endpointFingerprint,
      keyVersion: claim.keyVersion,
    }, {
      connectionId: claim.connectionId,
      credentialId: claim.credentialId,
      kek: credentialKey.kek,
      keyVersion: credentialKey.version,
      shopId: claim.shopId,
    });
  } catch (error) {
    return {
      state: await settleGeneratedLicenseFailure({
        claim,
        env: input.env,
        now,
        result: generatedLicenseExceptionFailure({ action, error, stage: "credential" }),
      }),
    };
  }
  let adapter: ReturnType<GeneratedLicenseProviderRegistry["resolve"]>;
  try {
    adapter = input.registry.resolve(claim.providerCode);
  } catch (error) {
    return {
      state: await settleGeneratedLicenseFailure({
        claim,
        env: input.env,
        now,
        result: generatedLicenseExceptionFailure({ action, error, stage: "registry" }),
      }),
    };
  }
  const providerRequest: GeneratedLicenseProviderRequest = {
    idempotencyKey: claim.providerIdempotencyKeyHash,
    operation: action,
    orderReference: claim.orderPublicId,
    quantity: 1,
    requestReference: claim.requestId,
    resourceKey: claim.resourceKey,
    version: 1,
  };
  let result: GeneratedLicenseProviderResult;
  try {
    result = action === "reconcile"
      ? await adapter.reconcile({ ...secrets, request: providerRequest })
      : await adapter.generate({ ...secrets, request: providerRequest });
  } catch (error) {
    return {
      state: await settleGeneratedLicenseFailure({
        claim,
        env: input.env,
        now,
        result: generatedLicenseExceptionFailure({ action, error, stage: "provider" }),
      }),
    };
  }
  if (result.kind !== "success") {
    return { state: await settleGeneratedLicenseFailure({ claim, env: input.env, now, result }) };
  }
  try {
    await settleGeneratedLicenseSuccess({ claim, env: input.env, now, result });
    return { state: "succeeded" };
  } catch (error) {
    await markReconciliationPending({ claim, env: input.env, now });
    if (error instanceof AppError && error.code === "generated_license_settlement_conflict") throw error;
    return { state: "reconcile_pending" };
  }
}

export async function requestGeneratedLicenseDeadLetterRetry(input: {
  env: AppBindings;
  now?: Date;
  requestId: string;
  shopId: string;
}): Promise<void> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE generated_license_requests
      SET status = 'retryable', next_attempt_at = ?, last_safe_error_code = NULL,
        lease_token = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND status IN ('failed', 'manual_review')
        AND EXISTS (
          SELECT 1 FROM generated_license_dead_letters AS dead_letter
          WHERE dead_letter.request_id = generated_license_requests.id
            AND dead_letter.shop_id = generated_license_requests.shop_id
            AND dead_letter.status IN ('open', 'acknowledged')
        )
    `).bind(nowIso, nowIso, input.requestId, input.shopId),
    input.env.PLATFORM_DB.prepare(`
      UPDATE generated_license_dead_letters
      SET status = 'retry_requested', updated_at = ?
      WHERE request_id = ? AND shop_id = ? AND status IN ('open', 'acknowledged')
    `).bind(nowIso, input.requestId, input.shopId),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new AppError("generated_license_dead_letter_conflict", 409);
  }
  await input.env.INTEGRATION_QUEUE.send(createGeneratedLicenseQueueEnvelope({ requestId: input.requestId, shopId: input.shopId }));
}

export async function revealGeneratedLicenseArtifact(input: {
  env: AppBindings;
  orderPublicId: string;
  orderToken: string;
  shopId: string;
  nowIso?: string;
}): Promise<{ items: readonly { format: GeneratedLicenseFormat; value: string }[]; orderId: string }> {
  const tokenHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "order-access", input.orderToken);
  const nowIso = input.nowIso ?? new Date().toISOString();
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT artifact.id AS artifactId, artifact.request_id AS requestId,
      artifact.ciphertext_b64 AS ciphertextB64, artifact.iv_b64 AS ivB64,
      artifact.key_version AS keyVersion, artifact.artifact_fingerprint AS artifactFingerprint,
      artifact.format
    FROM orders
    INNER JOIN generated_license_requests AS request
      ON request.order_id = orders.id AND request.shop_id = orders.shop_id
      AND request.status = 'succeeded'
    INNER JOIN entitlements AS entitlement
      ON entitlement.id = request.entitlement_id AND entitlement.shop_id = request.shop_id
      AND entitlement.status = 'active'
    INNER JOIN generated_license_artifacts AS artifact
      ON artifact.request_id = request.id AND artifact.shop_id = request.shop_id
      AND artifact.status = 'active'
    WHERE orders.public_id = ? AND orders.shop_id = ?
      AND orders.payment_status = 'paid'
      AND orders.status IN ('processing', 'completed')
      AND (entitlement.access_expires_at IS NULL OR entitlement.access_expires_at > ?)
      AND orders.order_token_hash = ?
    ORDER BY request.id, artifact.ordinal
  `).bind(input.orderPublicId, input.shopId, nowIso, tokenHash).all<{
    artifactId: string;
    artifactFingerprint: string;
    ciphertextB64: string;
    format: GeneratedLicenseFormat;
    ivB64: string;
    keyVersion: string;
    requestId: string;
  }>();
  if (rows.results.length === 0) throw new AppError("order_not_ready", 409);
  const items = await Promise.all(rows.results.map(async (row) => {
    const key = resolveEncryptionKey(input.env, "inventory", row.keyVersion);
    return {
      format: row.format,
      value: await decryptGeneratedLicenseArtifact(row, {
        artifactId: row.artifactId,
        kek: key.kek,
        keyVersion: key.version,
        requestId: row.requestId,
        shopId: input.shopId,
      }),
    };
  }));
  return { items, orderId: input.orderPublicId };
}
