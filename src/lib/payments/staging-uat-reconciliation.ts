import { constantTimeEqual, hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId, createOpaqueToken } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";
import { loadCredentialById } from "./credentials";
import { assertPayOSChannelAdmitted } from "./payos-admission";
import { reconcilePayOSAttemptWithProvider } from "./reconciliation";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const LEASE_TTL_MS = 60_000;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;
const PAYMENT_ATTEMPT_ID_PATTERN = /^pay_[0-9a-f-]{36}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;
const SAFE_STATE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/u;

type AttemptRow = {
  credentialId: string;
  id: string;
  integrationId: string;
  providerIdentityFingerprint: string | null;
  providerOrderCode: number;
  publicId: string;
  shopId: string;
  state: string;
  webhookPublicId: string;
};

type ExistingIdempotency = {
  requestHash: string;
  responseJson: string;
};

export type PayOSStagingReconciliationEvidence = {
  attemptPublicId: string;
  duplicate: boolean;
  eventReference: string;
  processed: boolean;
  provider: "payos";
  providerEnvironment: "production_controlled";
  replayed: boolean;
  requestReference: string;
  state: string;
  verificationMethod: "verified_provider_response";
};

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_required"]);
  }
  return value;
}

function parseStoredEvidence(value: string, attemptPublicId: string): PayOSStagingReconciliationEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new AppError("payment_reconciliation_replay_invalid", 500);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError("payment_reconciliation_replay_invalid", 500);
  }
  const evidence = parsed as Partial<PayOSStagingReconciliationEvidence>;
  if (evidence.attemptPublicId !== attemptPublicId
    || typeof evidence.duplicate !== "boolean"
    || typeof evidence.processed !== "boolean"
    || evidence.provider !== "payos"
    || evidence.providerEnvironment !== "production_controlled"
    || evidence.replayed !== false
    || evidence.verificationMethod !== "verified_provider_response"
    || typeof evidence.eventReference !== "string"
    || !/^event:pev_[0-9a-f-]{36}$/u.test(evidence.eventReference)
    || typeof evidence.requestReference !== "string"
    || !/^request:[A-Za-z0-9._:-]{8,128}$/u.test(evidence.requestReference)
    || typeof evidence.state !== "string"
    || !SAFE_STATE_PATTERN.test(evidence.state)) {
    throw new AppError("payment_reconciliation_replay_invalid", 500);
  }
  return { ...evidence, replayed: true } as PayOSStagingReconciliationEvidence;
}

async function loadReplay(input: {
  actorUserId: string;
  attemptPublicId: string;
  env: AppBindings;
  keyHash: string;
  namespace: string;
  nowIso: string;
  requestHash: string;
}): Promise<PayOSStagingReconciliationEvidence | null> {
  const replay = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash AS requestHash, response_json AS responseJson
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
      AND expires_at > ?
    LIMIT 1
  `).bind(input.actorUserId, input.namespace, input.keyHash, input.nowIso).first<ExistingIdempotency>();
  if (replay === null) return null;
  if (replay.requestHash !== input.requestHash) throw new AppError("idempotency_conflict", 409);
  return parseStoredEvidence(replay.responseJson, input.attemptPublicId);
}

async function assertControlledStagingChannel(input: {
  attempt: AttemptRow;
  env: AppBindings;
}): Promise<void> {
  if (input.env.APP_ENV !== "staging") {
    throw new AppError("payment_provider_environment_not_admitted", 409);
  }
  const expected = input.env.PAYOS_STAGING_CHANNEL_IDENTITY_FINGERPRINT?.trim();
  if (expected === undefined || !FINGERPRINT_PATTERN.test(expected)
    || input.attempt.providerIdentityFingerprint === null
    || !constantTimeEqual(input.attempt.providerIdentityFingerprint, expected)) {
    throw new AppError("payment_provider_environment_not_admitted", 409);
  }
  const credential = await loadCredentialById(input.env, input.attempt.credentialId, input.attempt.shopId);
  if (credential.row.integrationId !== input.attempt.integrationId) {
    throw new AppError("payment_provider_environment_not_admitted", 409);
  }
  await assertPayOSChannelAdmitted(input.env, credential.credentials);
}

export async function reconcilePayOSStagingUatAttempt(input: {
  attemptPublicId: string;
  env: AppBindings;
  fetcher?: typeof fetch;
  idempotencyKey: string | null;
  now?: Date;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<PayOSStagingReconciliationEvidence> {
  if (!PAYMENT_ATTEMPT_ID_PATTERN.test(input.attemptPublicId)) throw new AppError("resource_not_found", 404);
  if (!REQUEST_ID_PATTERN.test(input.requestId)) throw new AppError("validation_failed", 400, ["request_id_invalid"]);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const member = await getShopForMember({
    capability: "payments:manage",
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  const attempt = await input.env.PLATFORM_DB.prepare(`
    SELECT payment_attempts.id, payment_attempts.public_id AS publicId,
      payment_attempts.shop_id AS shopId,
      payment_attempts.integration_id AS integrationId,
      payment_attempts.credential_id AS credentialId,
      payment_attempts.provider_order_code AS providerOrderCode,
      payment_attempts.state,
      payment_integrations.webhook_public_id AS webhookPublicId,
      payment_integrations.provider_identity_fingerprint AS providerIdentityFingerprint
    FROM payment_attempts
    INNER JOIN payment_integrations
      ON payment_integrations.id = payment_attempts.integration_id
      AND payment_integrations.shop_id = payment_attempts.shop_id
      AND payment_integrations.provider = 'payos'
      AND payment_integrations.status = 'active'
      AND payment_integrations.webhook_status = 'verified'
    WHERE payment_attempts.shop_id = ? AND payment_attempts.public_id = ?
      AND payment_attempts.provider = 'payos'
      AND payment_integrations.active_credential_id = payment_attempts.credential_id
    LIMIT 1
  `).bind(member.row.shop_id, input.attemptPublicId).first<AttemptRow>();
  if (attempt === null) throw new AppError("payment_attempt_not_found", 404);
  await assertControlledStagingChannel({ attempt, env: input.env });

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `payos-staging-uat-reconcile.v1:${attempt.shopId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "payos-staging-uat-reconcile-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ attemptPublicId: attempt.publicId, shopId: attempt.shopId });
  const replay = await loadReplay({
    actorUserId: input.userId,
    attemptPublicId: attempt.publicId,
    env: input.env,
    keyHash,
    namespace,
    nowIso,
    requestHash,
  });
  if (replay !== null) return replay;
  if (!new Set(["creating", "error", "pending"]).has(attempt.state)) {
    throw new AppError("payment_reconciliation_not_available", 409);
  }

  const leaseToken = createOpaqueToken(18);
  const claimed = await input.env.PLATFORM_DB.prepare(`
    UPDATE payment_attempts
    SET lease_token = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND shop_id = ? AND provider = 'payos'
      AND state IN ('creating', 'pending', 'error')
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).bind(
    leaseToken,
    new Date(now.getTime() + LEASE_TTL_MS).toISOString(),
    nowIso,
    attempt.id,
    attempt.shopId,
    nowIso,
  ).run();
  if (claimed.meta.changes !== 1) {
    const completedReplay = await loadReplay({
      actorUserId: input.userId,
      attemptPublicId: attempt.publicId,
      env: input.env,
      keyHash,
      namespace,
      nowIso,
      requestHash,
    });
    if (completedReplay !== null) return completedReplay;
    throw new AppError("payment_reconciliation_in_progress", 409);
  }

  try {
    const reconciliation = await reconcilePayOSAttemptWithProvider({
      attempt,
      env: input.env,
      ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    });
    const event = await input.env.PLATFORM_DB.prepare(`
      SELECT id
      FROM payment_events
      WHERE shop_id = ? AND payment_attempt_id = ? AND integration_id = ?
        AND provider = 'payos' AND payload_hash = ? AND signature_verified = 1
      LIMIT 1
    `).bind(attempt.shopId, attempt.id, attempt.integrationId, reconciliation.payloadHash).first<{ id: string }>();
    if (event === null) throw new AppError("payment_reconciliation_evidence_missing", 500);
    const evidence: PayOSStagingReconciliationEvidence = {
      attemptPublicId: attempt.publicId,
      duplicate: reconciliation.result.duplicate,
      eventReference: `event:${event.id}`,
      processed: reconciliation.result.processed,
      provider: "payos",
      providerEnvironment: "production_controlled",
      replayed: false,
      requestReference: `request:${input.requestId}`,
      state: reconciliation.result.state,
      verificationMethod: "verified_provider_response",
    };
    if (!SAFE_STATE_PATTERN.test(evidence.state)) throw new AppError("payment_reconciliation_evidence_invalid", 500);
    const auditId = createId("aud");
    const stored = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        UPDATE payment_attempts
        SET last_reconciled_at = ?,
          next_reconcile_at = CASE WHEN state = 'pending' THEN ? ELSE NULL END,
          reconcile_attempts = reconcile_attempts + 1,
          lease_token = NULL, lease_expires_at = NULL,
          last_safe_error_code = NULL, updated_at = ?
        WHERE id = ? AND shop_id = ? AND lease_token = ?
      `).bind(nowIso, new Date(now.getTime() + 5 * 60_000).toISOString(), nowIso, attempt.id, attempt.shopId, leaseToken),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
          safe_metadata_json, request_id, source_kind, retention_class, created_at
        ) VALUES (?, ?, 'user', ?, 'payos.staging_uat_reconciled',
          'payment_attempt', ?, ?, ?, 'http', 'financial', ?)
      `).bind(
        auditId,
        attempt.shopId,
        input.userId,
        attempt.id,
        JSON.stringify({
          attemptPublicId: attempt.publicId,
          duplicate: evidence.duplicate,
          eventReference: evidence.eventReference,
          processed: evidence.processed,
          providerEnvironment: evidence.providerEnvironment,
          state: evidence.state,
          verificationMethod: evidence.verificationMethod,
        }),
        input.requestId,
        nowIso,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO idempotency_records (
          actor_user_id, namespace, key_hash, request_hash, response_json,
          created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(actor_user_id, namespace, key_hash) DO UPDATE SET
          request_hash = excluded.request_hash,
          response_json = excluded.response_json,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at
        WHERE idempotency_records.expires_at <= excluded.created_at
      `).bind(
        input.userId,
        namespace,
        keyHash,
        requestHash,
        JSON.stringify(evidence),
        nowIso,
        new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
      ),
    ]);
    if (stored.some((result) => result.meta.changes !== 1)) {
      throw new AppError("payment_reconciliation_evidence_failed", 500);
    }
    return evidence;
  } catch (error) {
    const safeErrorCode = error instanceof AppError && error.code === "provider_identity_mismatch"
      ? "provider_identity_mismatch"
      : "provider_reconcile_failed";
    await input.env.PLATFORM_DB.prepare(`
      UPDATE payment_attempts
      SET state = CASE WHEN state = 'creating' THEN 'error' ELSE state END,
        reconcile_attempts = reconcile_attempts + 1,
        next_reconcile_at = ?, lease_token = NULL, lease_expires_at = NULL,
        last_safe_error_code = ?, updated_at = ?
      WHERE id = ? AND shop_id = ? AND lease_token = ?
    `).bind(
      new Date(now.getTime() + 60_000).toISOString(),
      safeErrorCode,
      nowIso,
      attempt.id,
      attempt.shopId,
      leaseToken,
    ).run();
    throw error;
  }
}
