import { constantTimeEqual, hmacToken } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId, createOpaqueToken } from "../core/ids";
import { assertQuotaAvailable, recordUsage } from "../billing/metering";
import { customDomainTurnstileAdmissionSql } from "../domains/readiness";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";
import { assertRoleCapability, type ShopCapability, type ShopRole } from "../tenants/policy";
import { createD1AutomationTaskRepository } from "./d1-repository";
import { createAutomationExecutors } from "./executors";
import { createAutomationOrchestrator } from "./orchestrator";
import { assertAutomationEvidenceToken, assertAutomationTaskId } from "./policy";
import { defaultAutomationCapabilityRegistry } from "./registry";
import { AUTOMATION_TASK_STATUSES } from "./types";
import type {
  AutomationContinuation,
  AutomationTask,
  AutomationTaskStatus,
} from "./types";

const encoder = new TextEncoder();
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const SAFE_REASON_CODE = /^[a-z][a-z0-9._:-]{2,63}$/u;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const EVIDENCE_TTL_MS = 10 * 60_000;
const CONSUMED_EVIDENCE_GRACE_MS = 30_000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60_000;
const PAYOS_EVIDENCE_TTL_MS = 24 * 60 * 60_000;
const TELEGRAM_EVIDENCE_TTL_MS = 30 * 24 * 60 * 60_000;
const DOMAIN_EVIDENCE_TTL_MS = 24 * 60 * 60_000;

const API_START_CAPABILITIES = new Set([
  "domain.platform.provision",
  "shop.provision",
]);

const ACTION_URLS: Readonly<Record<string, string>> = {
  "domain.custom.domain_connect": "/app/domains",
  "domain.custom.manual_dns": "/app/domains",
  "domain.platform.provision": "/app/domains",
  "payments.payos.channel_create": "/onboarding#payos",
  "rule_create_task": "/app/automation",
  "shop.provision": "/onboarding",
  "telegram.bot.create": "/onboarding#telegram",
};

const TELEGRAM_REFERENCE = /^d1:telegram-integration\/([A-Za-z0-9][A-Za-z0-9._:-]{2,127})$/u;
const PAYMENT_REFERENCE = /^d1:payment-integration\/([A-Za-z0-9][A-Za-z0-9._:-]{2,127})$/u;
const DOMAIN_REFERENCE = /^d1:domain\/([A-Za-z0-9][A-Za-z0-9._:-]{2,127})$/u;

type EvidenceKind = "approval_granted" | "external_action_completed";
type MutationKind = "cancel" | "resume";

type ApiRuntime = {
  now?: () => Date;
};

type PublicAutomationTask = {
  actionUrl: string;
  attemptCount: number;
  capabilityCode: string;
  canCancel: boolean;
  continuation: null | {
    kind: "approval_granted" | "provider_check";
  };
  createdAt: string;
  id: string;
  lastSafeErrorCode: string | null;
  nextAttemptAt: string | null;
  status: AutomationTaskStatus;
  updatedAt: string;
  version: number;
};

type ProcessingMutation = {
  auditId: string;
  challengeId: string | null;
  expectedVersion: number;
  state: "processing";
  taskId: string;
};

type CompletedMutation = {
  state: "completed";
  task: PublicAutomationTask;
};

type StoredMutation = {
  requestHash: string;
  responseJson: string;
};

type MutationReservation = {
  completedTask: PublicAutomationTask | null;
  processing: ProcessingMutation;
  replayed: boolean;
  state: "completed" | "processing";
};

type ProviderEvidence = {
  reference: string;
};

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value)));
  return bytesToHex(new Uint8Array(digest));
}

async function sha256TextHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !IDEMPOTENCY_KEY.test(value)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_invalid"]);
  }
  return value;
}

function requireExpectedVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  }
  return value;
}

function requireReasonCode(value: string): string {
  if (!SAFE_REASON_CODE.test(value)) {
    throw new AppError("validation_failed", 400, ["reason_code_invalid"]);
  }
  return value;
}

function requireListLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new AppError("validation_failed", 400, ["limit_invalid"]);
  }
  return limit;
}

function requireTaskStatus(value: string | undefined): AutomationTaskStatus | undefined {
  if (value === undefined) return undefined;
  if (!AUTOMATION_TASK_STATUSES.includes(value as AutomationTaskStatus)) {
    throw new AppError("validation_failed", 400, ["status_invalid"]);
  }
  return value as AutomationTaskStatus;
}

function nowFrom(runtime: ApiRuntime | undefined): Date {
  return runtime?.now?.() ?? new Date();
}

function actionUrl(task: AutomationTask): string {
  return ACTION_URLS[task.capabilityCode] ?? "/onboarding";
}

function publicTask(task: AutomationTask, now: Date): PublicAutomationTask {
  const leaseActive = task.status === "running"
    && task.leaseExpiresAt !== null
    && task.leaseExpiresAt > now.toISOString();
  const continuation = task.status === "waiting_user"
    ? { kind: "approval_granted" as const }
    : task.status === "waiting_provider"
      ? { kind: "provider_check" as const }
      : null;
  return {
    actionUrl: actionUrl(task),
    attemptCount: task.attemptCount,
    capabilityCode: task.capabilityCode,
    canCancel: !new Set(["canceled", "failed", "succeeded"]).has(task.status) && !leaseActive,
    continuation,
    createdAt: task.createdAt,
    id: task.id,
    lastSafeErrorCode: task.lastSafeErrorCode,
    nextAttemptAt: task.nextAttemptAt,
    status: task.status,
    updatedAt: task.updatedAt,
    version: task.version,
  };
}

type MemberContext = {
  limits: Record<string, unknown>;
  role: ShopRole;
  shopId: string;
};

async function requireMember(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}, capability: ShopCapability): Promise<MemberContext> {
  const member = await getShopForMember({
    capability,
    env: input.env,
    shopPublicId: input.shopPublicId,
    userId: input.userId,
  });
  return { limits: member.shop.limits, role: member.row.role, shopId: member.row.shop_id };
}

function capabilityPermission(capabilityCode: string): ShopCapability {
  if (capabilityCode.startsWith("domain.")) return "domains:manage";
  if (capabilityCode.startsWith("payments.")) return "payments:manage";
  if (capabilityCode.startsWith("telegram.")) return "integrations:manage";
  return "automation:manage";
}

async function requireAutomationMutationMember(input: {
  capabilityCode: string;
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<{ limits: Record<string, unknown>; shopId: string }> {
  const member = await requireMember(input, capabilityPermission(input.capabilityCode));
  return { limits: member.limits, shopId: member.shopId };
}

function planLimit(limits: Record<string, unknown>, metric: string): number | null {
  const value = limits[metric];
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AppError("quota_unavailable", 503);
  return value as number;
}

async function meterAutomationTask(input: { database: D1Database; limit: number | null; now: Date; shopId: string; taskId: string }): Promise<void> {
  if (input.limit === null) return;
  await recordUsage({
    database: input.database,
    delta: 1,
    limit: input.limit,
    metric: "automation_runs",
    occurredAt: input.now.toISOString(),
    now: input.now,
    shopId: input.shopId,
    sourceId: input.taskId,
    sourceKind: "automation",
  });
}

async function loadTask(env: AppBindings, shopId: string, taskId: string): Promise<AutomationTask> {
  const task = await createD1AutomationTaskRepository(env.PLATFORM_DB).get({ shopId, taskId });
  if (task === null) throw new AppError("automation_task_not_found", 404);
  return task;
}

async function findTaskByCreateIdempotency(input: {
  env: AppBindings;
  idempotencyKeyHash: string;
  shopId: string;
}): Promise<AutomationTask | null> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT id
    FROM automation_tasks
    WHERE shop_id = ? AND idempotency_key_hash = ?
    LIMIT 1
  `).bind(input.shopId, input.idempotencyKeyHash).first<{ id: string }>();
  return row === null ? null : loadTask(input.env, input.shopId, row.id);
}

function isFreshTimestamp(value: string | null, now: Date, maximumAgeMs: number): boolean {
  if (value === null) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && timestamp <= now.getTime() + FUTURE_CLOCK_SKEW_MS
    && timestamp >= now.getTime() - maximumAgeMs;
}

async function resolveProviderEvidence(input: {
  env: AppBindings;
  now: Date;
  task: AutomationTask;
}): Promise<ProviderEvidence | null> {
  if (input.task.capabilityCode === "telegram.bot.create") {
    const integrationId = TELEGRAM_REFERENCE.exec(input.task.inputReference)?.[1];
    if (integrationId === undefined) return null;
    const row = await input.env.PLATFORM_DB.prepare(`
      SELECT ti.id, ti.last_health_update_at AS observedAt
      FROM telegram_integrations AS ti
      INNER JOIN telegram_credentials AS tc
        ON tc.id = ti.active_credential_id
        AND tc.integration_id = ti.id
        AND tc.shop_id = ti.shop_id
        AND tc.status = 'active'
        AND tc.activated_at IS NOT NULL
      WHERE ti.id = ? AND ti.shop_id = ?
        AND ti.status = 'active' AND ti.webhook_status = 'verified'
        AND ti.active_credential_id IS NOT NULL AND ti.bot_id IS NOT NULL
      LIMIT 1
    `).bind(integrationId, input.task.shopId).first<{ id: string; observedAt: string | null }>();
    return row !== null && isFreshTimestamp(row.observedAt, input.now, TELEGRAM_EVIDENCE_TTL_MS)
      ? { reference: `d1:telegram-integration/${row.id}` }
      : null;
  }
  if (input.task.capabilityCode === "payments.payos.channel_create") {
    const integrationId = PAYMENT_REFERENCE.exec(input.task.inputReference)?.[1];
    if (integrationId === undefined) return null;
    const row = await input.env.PLATFORM_DB.prepare(`
      SELECT pi.id, pi.last_checked_at AS checkedAt,
        pi.last_webhook_verified_at AS webhookVerifiedAt
      FROM payment_integrations AS pi
      INNER JOIN payment_credentials AS pc
        ON pc.id = pi.active_credential_id
        AND pc.integration_id = pi.id
        AND pc.shop_id = pi.shop_id
        AND pc.provider = 'payos'
        AND pc.status = 'active'
        AND pc.activated_at IS NOT NULL
        AND pc.provider_ownership_fingerprint IS NOT NULL
      WHERE pi.id = ? AND pi.shop_id = ? AND pi.provider = 'payos'
        AND pi.status = 'active' AND pi.webhook_status = 'verified'
        AND pi.active_credential_id IS NOT NULL
        AND pi.provider_identity_fingerprint IS NOT NULL
      LIMIT 1
    `).bind(integrationId, input.task.shopId).first<{
      checkedAt: string | null;
      id: string;
      webhookVerifiedAt: string | null;
    }>();
    return row !== null
      && isFreshTimestamp(row.checkedAt, input.now, PAYOS_EVIDENCE_TTL_MS)
      && isFreshTimestamp(row.webhookVerifiedAt, input.now, PAYOS_EVIDENCE_TTL_MS)
      ? { reference: `d1:payment-integration/${row.id}` }
      : null;
  }
  if (input.task.capabilityCode === "domain.custom.manual_dns") {
    const domainId = DOMAIN_REFERENCE.exec(input.task.inputReference)?.[1];
    if (domainId === undefined) return null;
    const row = await input.env.PLATFORM_DB.prepare(`
      SELECT id, last_checked_at AS observedAt
      FROM shop_domains
      WHERE id = ? AND shop_id = ? AND type = 'custom'
        AND status = 'active' AND ownership_verified_at IS NOT NULL
        AND cloudflare_hostname_id IS NOT NULL
        AND hostname_status = 'active' AND ssl_status = 'active'
        AND dns_status = 'active' AND activated_at IS NOT NULL
        AND (${customDomainTurnstileAdmissionSql("shop_domains")})
        AND deleted_at IS NULL AND delete_requested_at IS NULL
        AND lease_token IS NULL
      LIMIT 1
    `).bind(domainId, input.task.shopId).first<{ id: string; observedAt: string | null }>();
    return row !== null && isFreshTimestamp(row.observedAt, input.now, DOMAIN_EVIDENCE_TTL_MS)
      ? { reference: `d1:domain/${row.id}` }
      : null;
  }
  return null;
}

function parseProcessingMutation(value: unknown): ProcessingMutation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.state !== "processing"
    || typeof row.taskId !== "string"
    || typeof row.expectedVersion !== "number"
    || !Number.isSafeInteger(row.expectedVersion)
    || row.expectedVersion < 1
    || typeof row.auditId !== "string"
    || !(row.challengeId === null || typeof row.challengeId === "string")) {
    return null;
  }
  return {
    auditId: row.auditId,
    challengeId: row.challengeId,
    expectedVersion: row.expectedVersion,
    state: "processing",
    taskId: row.taskId,
  };
}

function parsePublicAutomationTask(value: unknown): PublicAutomationTask | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const continuation = row.continuation;
  const validContinuation = continuation === null || (
    typeof continuation === "object"
    && !Array.isArray(continuation)
    && ((continuation as Record<string, unknown>).kind === "approval_granted"
      || (continuation as Record<string, unknown>).kind === "provider_check")
  );
  if (typeof row.actionUrl !== "string"
    || typeof row.attemptCount !== "number"
    || !Number.isSafeInteger(row.attemptCount)
    || row.attemptCount < 0
    || typeof row.capabilityCode !== "string"
    || typeof row.canCancel !== "boolean"
    || !validContinuation
    || typeof row.createdAt !== "string"
    || typeof row.id !== "string"
    || !(row.lastSafeErrorCode === null || typeof row.lastSafeErrorCode === "string")
    || !(row.nextAttemptAt === null || typeof row.nextAttemptAt === "string")
    || typeof row.status !== "string"
    || !AUTOMATION_TASK_STATUSES.includes(row.status as AutomationTaskStatus)
    || typeof row.updatedAt !== "string"
    || typeof row.version !== "number"
    || !Number.isSafeInteger(row.version)
    || row.version < 1) {
    return null;
  }
  return {
    actionUrl: row.actionUrl,
    attemptCount: row.attemptCount,
    capabilityCode: row.capabilityCode,
    canCancel: row.canCancel,
    continuation: continuation as PublicAutomationTask["continuation"],
    createdAt: row.createdAt,
    id: row.id,
    lastSafeErrorCode: row.lastSafeErrorCode,
    nextAttemptAt: row.nextAttemptAt,
    status: row.status as AutomationTaskStatus,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function parseCompletedMutation(value: unknown): CompletedMutation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.state !== "completed") return null;
  const task = parsePublicAutomationTask(row.task);
  if (task === null) {
    return null;
  }
  return { state: "completed", task };
}

function parseStoredMutation(value: string): ProcessingMutation | CompletedMutation {
  try {
    const parsed = JSON.parse(value) as unknown;
    const processing = parseProcessingMutation(parsed);
    if (processing !== null) return processing;
    const completed = parseCompletedMutation(parsed);
    if (completed !== null) return completed;
  } catch {
    // Invalid durable state must fail closed.
  }
  throw new AppError("internal_error", 500);
}

async function reserveMutation(input: {
  env: AppBindings;
  keyHash: string;
  namespace: string;
  now: Date;
  processing: ProcessingMutation;
  requestHash: string;
  userId: string;
}): Promise<MutationReservation> {
  const nowIso = input.now.toISOString();
  const reservationResults = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      DELETE FROM idempotency_records
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at <= ?
    `).bind(input.userId, input.namespace, input.keyHash, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO idempotency_records (
        actor_user_id, namespace, key_hash, request_hash, response_json,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(actor_user_id, namespace, key_hash) DO NOTHING
    `).bind(
      input.userId,
      input.namespace,
      input.keyHash,
      input.requestHash,
      JSON.stringify(input.processing),
      nowIso,
      new Date(input.now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
    ),
  ]);
  const stored = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash AS requestHash, response_json AS responseJson
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
    LIMIT 1
  `).bind(input.userId, input.namespace, input.keyHash).first<StoredMutation>();
  if (stored === null) throw new AppError("automation_idempotency_failed", 500);
  if (stored.requestHash !== input.requestHash) throw new AppError("idempotency_conflict", 409);
  const state = parseStoredMutation(stored.responseJson);
  if (state.state === "completed") {
    if (state.task.id !== input.processing.taskId) throw new AppError("idempotency_conflict", 409);
    return {
      completedTask: state.task,
      processing: input.processing,
      replayed: true,
      state: "completed",
    };
  }
  if (state.taskId !== input.processing.taskId || state.expectedVersion !== input.processing.expectedVersion) {
    throw new AppError("idempotency_conflict", 409);
  }
  return {
    completedTask: null,
    processing: state,
    replayed: reservationResults[1]?.meta.changes === 0,
    state: "processing",
  };
}

async function finalizeMutation(input: {
  env: AppBindings;
  keyHash: string;
  namespace: string;
  now: Date;
  requestHash: string;
  task: AutomationTask;
  userId: string;
}): Promise<void> {
  const updated = await input.env.PLATFORM_DB.prepare(`
    UPDATE idempotency_records
    SET response_json = ?
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
      AND request_hash = ?
  `).bind(
    JSON.stringify({ state: "completed", task: publicTask(input.task, input.now) }),
    input.userId,
    input.namespace,
    input.keyHash,
    input.requestHash,
  ).run();
  if (updated.meta.changes !== 1) throw new AppError("automation_idempotency_failed", 500);
}

async function ensureUnusedEvidenceAnchor(input: {
  env: AppBindings;
  keyHash: string;
  namespace: string;
  now: Date;
  processing: ProcessingMutation;
  requestHash: string;
  userId: string;
}): Promise<ProcessingMutation | CompletedMutation> {
  let current = input.processing;
  const nowIso = input.now.toISOString();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (current.challengeId === null) throw new AppError("internal_error", 500);
    const challenge = await input.env.PLATFORM_DB.prepare(`
      SELECT status, expires_at AS expiresAt, consumed_at AS consumedAt
      FROM automation_evidence_challenges
      WHERE id = ?
      LIMIT 1
    `).bind(current.challengeId).first<{
      consumedAt: string | null;
      expiresAt: string;
      status: string;
    }>();
    if (challenge === null) return current;
    if (!new Set(["consumed", "issued", "revoked"]).has(challenge.status)) {
      throw new AppError("internal_error", 500);
    }
    if (challenge.status === "issued") {
      const expiresAt = Date.parse(challenge.expiresAt);
      if (!Number.isFinite(expiresAt)) throw new AppError("internal_error", 500);
      if (expiresAt > input.now.getTime()) throw new AppError("automation_idempotency_busy", 409);
      const revoked = await input.env.PLATFORM_DB.prepare(`
        UPDATE automation_evidence_challenges
        SET status = 'revoked', updated_at = ?
        WHERE id = ? AND status = 'issued' AND expires_at <= ?
      `).bind(nowIso, current.challengeId, nowIso).run();
      if (revoked.meta.changes !== 1) continue;
    }
    if (challenge.status === "consumed") {
      const consumedAt = challenge.consumedAt === null ? Number.NaN : Date.parse(challenge.consumedAt);
      if (!Number.isFinite(consumedAt)) throw new AppError("internal_error", 500);
      if (consumedAt > input.now.getTime() - CONSUMED_EVIDENCE_GRACE_MS) {
        throw new AppError("automation_idempotency_busy", 409);
      }
    }
    const replacement: ProcessingMutation = {
      ...current,
      auditId: createId("aud"),
      challengeId: createId("aech"),
    };
    const updated = await input.env.PLATFORM_DB.prepare(`
      UPDATE idempotency_records
      SET response_json = ?
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
        AND request_hash = ? AND response_json = ?
    `).bind(
      JSON.stringify(replacement),
      input.userId,
      input.namespace,
      input.keyHash,
      input.requestHash,
      JSON.stringify(current),
    ).run();
    if (updated.meta.changes === 1) return replacement;
    const stored = await input.env.PLATFORM_DB.prepare(`
      SELECT request_hash AS requestHash, response_json AS responseJson
      FROM idempotency_records
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
      LIMIT 1
    `).bind(input.userId, input.namespace, input.keyHash).first<StoredMutation>();
    if (stored === null) throw new AppError("automation_idempotency_failed", 500);
    if (stored.requestHash !== input.requestHash) throw new AppError("idempotency_conflict", 409);
    const state = parseStoredMutation(stored.responseJson);
    if (state.state === "completed") return state;
    current = state;
  }
  throw new AppError("automation_idempotency_busy", 409);
}

async function insertTaskAudit(input: {
  action: string;
  auditId: string;
  env: AppBindings;
  metadata: Readonly<Record<string, boolean | number | string>>;
  now: Date;
  requestId: string;
  shopId: string;
  taskId: string;
  userId: string;
}): Promise<void> {
  await input.env.PLATFORM_DB.prepare(`
    INSERT OR IGNORE INTO audit_logs (
      id, shop_id, actor_type, actor_id, action, resource_type,
      resource_id, safe_metadata_json, request_id, created_at
    ) VALUES (?, ?, 'user', ?, ?, 'automation_task', ?, ?, ?, ?)
  `).bind(
    input.auditId,
    input.shopId,
    input.userId,
    input.action,
    input.taskId,
    JSON.stringify(input.metadata),
    input.requestId,
    input.now.toISOString(),
  ).run();
}

function evidenceReference(challengeId: string): string {
  return `audit:automation-evidence/${challengeId}`;
}

function controlActionReference(auditId: string): string {
  return `action:automation-control/${auditId}`;
}

async function createAndConsumeEvidence(input: {
  auditId: string;
  capabilityCode: string;
  challengeId: string;
  env: AppBindings;
  kind: EvidenceKind;
  now: Date;
  requestId: string;
  shopId: string;
  taskId: string;
  taskVersion: number;
  userId: string;
  providerReference?: string;
}): Promise<{ reference: string; token: string }> {
  const token = createOpaqueToken(32);
  assertAutomationEvidenceToken(token);
  const tokenHash = await sha256TextHex(token);
  const nowIso = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + EVIDENCE_TTL_MS).toISOString();
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO automation_evidence_challenges (
        id, task_id, shop_id, actor_user_id, kind, token_hash, status,
        audit_log_id, expires_at, consumed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'issued', NULL, ?, NULL, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).bind(
      input.challengeId,
      input.taskId,
      input.shopId,
      input.userId,
      input.kind,
      tokenHash,
      expiresAt,
      nowIso,
      nowIso,
    ),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      )
      SELECT ?, shop_id, 'user', actor_user_id, ?, 'automation_evidence',
        id, ?, ?, ?
      FROM automation_evidence_challenges
      WHERE id = ? AND task_id = ? AND shop_id = ? AND actor_user_id = ?
        AND kind = ? AND token_hash = ? AND status = 'issued' AND expires_at > ?
    `).bind(
      input.auditId,
      "automation.evidence_consumed",
      JSON.stringify({
        capabilityCode: input.capabilityCode,
        evidenceKind: input.kind,
        taskVersion: input.taskVersion,
        ...(input.providerReference === undefined ? {} : { providerReference: input.providerReference }),
      }),
      input.requestId,
      nowIso,
      input.challengeId,
      input.taskId,
      input.shopId,
      input.userId,
      input.kind,
      tokenHash,
      nowIso,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE automation_evidence_challenges
      SET status = 'consumed', audit_log_id = ?, consumed_at = ?, updated_at = ?
      WHERE id = ? AND task_id = ? AND shop_id = ? AND actor_user_id = ?
        AND kind = ? AND token_hash = ? AND status = 'issued' AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM audit_logs
          WHERE id = ? AND shop_id = automation_evidence_challenges.shop_id
            AND actor_type = 'user'
            AND actor_id = automation_evidence_challenges.actor_user_id
            AND resource_type = 'automation_evidence'
            AND resource_id = automation_evidence_challenges.id
        )
    `).bind(
      input.auditId,
      nowIso,
      nowIso,
      input.challengeId,
      input.taskId,
      input.shopId,
      input.userId,
      input.kind,
      tokenHash,
      nowIso,
      input.auditId,
    ),
  ]);
  if (results[0]?.meta.changes !== 1
    || results[1]?.meta.changes !== 1
    || results[2]?.meta.changes !== 1) {
    throw new AppError("automation_evidence_conflict", 409);
  }
  return { reference: evidenceReference(input.challengeId), token };
}

function orchestratorFor(input: {
  env: AppBindings;
  evidence?: { reference: string; token: string };
  now: Date;
}) {
  const repository = createD1AutomationTaskRepository(input.env.PLATFORM_DB);
  return {
    orchestrator: createAutomationOrchestrator({
      executors: createAutomationExecutors(input.env),
      now: () => input.now,
      repository,
      ...(input.evidence === undefined
        ? {}
        : {
            resolveContinuationEvidence: ({ evidenceToken }: { evidenceToken: string }) => Promise.resolve(
              constantTimeEqual(evidenceToken, input.evidence?.token ?? "")
                ? input.evidence?.reference ?? null
                : null,
            ),
          }),
    }),
    repository,
  };
}

async function findRecoveryEvent(input: {
  actionReference?: string;
  evidenceReference?: string;
  env: AppBindings;
  expectedVersion: number;
  safeCode?: string;
  shopId: string;
  taskId: string;
  toStatus?: AutomationTaskStatus;
  userId: string;
  requiresEvidence?: boolean;
}): Promise<boolean> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT 1 AS found
    FROM automation_task_events
    WHERE task_id = ? AND shop_id = ? AND actor_role = 'seller' AND actor_id = ?
      AND task_version = ?
      AND (? IS NULL OR action_reference = ?)
      AND (? IS NULL OR evidence_reference = ?)
      AND (? IS NULL OR safe_code = ?)
      AND (? IS NULL OR to_status = ?)
      AND (? = 0 OR evidence_reference IS NOT NULL)
    LIMIT 1
  `).bind(
    input.taskId,
    input.shopId,
    input.userId,
    input.expectedVersion + 1,
    input.actionReference ?? null,
    input.actionReference ?? null,
    input.evidenceReference ?? null,
    input.evidenceReference ?? null,
    input.safeCode ?? null,
    input.safeCode ?? null,
    input.toStatus ?? null,
    input.toStatus ?? null,
    input.requiresEvidence === true ? 1 : 0,
  ).first<{ found: number }>();
  return row !== null;
}

async function recoverMutation(input: {
  actionReference?: string;
  env: AppBindings;
  evidenceReference?: string;
  expectedVersion: number;
  keyHash: string;
  kind: MutationKind;
  namespace: string;
  requestHash: string;
  safeCode?: string;
  shopId: string;
  taskId: string;
  userId: string;
}): Promise<AutomationTask | null> {
  const found = await findRecoveryEvent({
    env: input.env,
    expectedVersion: input.expectedVersion,
    shopId: input.shopId,
    taskId: input.taskId,
    userId: input.userId,
    ...(input.actionReference === undefined ? {} : { actionReference: input.actionReference }),
    ...(input.evidenceReference === undefined ? {} : { evidenceReference: input.evidenceReference }),
    ...(input.safeCode === undefined ? {} : { safeCode: input.safeCode }),
    ...(input.kind === "cancel" ? { toStatus: "canceled" as const } : {}),
    ...(input.kind === "resume" ? { requiresEvidence: true } : {}),
  });
  if (!found) return null;
  return loadTask(input.env, input.shopId, input.taskId);
}

function isQuotaTrigger(error: unknown): boolean {
  return error instanceof Error && error.message.includes("automation_open_task_limit");
}

export async function createAutomationTask(input: {
  capabilityCode: string;
  env: AppBindings;
  idempotencyKey: string | null;
  requestId: string;
  runtime?: ApiRuntime;
  shopPublicId: string;
  userId: string;
}): Promise<{ replayed: boolean; task: PublicAutomationTask }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  defaultAutomationCapabilityRegistry.require(input.capabilityCode);
  if (!API_START_CAPABILITIES.has(input.capabilityCode)) {
    throw new AppError("automation_capability_context_required", 409);
  }
  const { limits, shopId } = await requireAutomationMutationMember(input);
  const automationRunLimit = planLimit(limits, "automation_runs");
  const now = nowFrom(input.runtime);
  const idempotencyKeyHash = await sha256TextHex(await hmacToken(
    input.env.SESSION_SECRET,
    "automation-create-idempotency-v2",
    JSON.stringify({ idempotencyKey, shopId }),
  ));
  const requestHash = await sha256Hex({ capabilityCode: input.capabilityCode, shopId });
  const { orchestrator } = orchestratorFor({ env: input.env, now });
  const existing = await findTaskByCreateIdempotency({
    env: input.env,
    idempotencyKeyHash,
    shopId,
  });
  if (existing !== null) {
    if (existing.requestHash !== requestHash) throw new AppError("idempotency_conflict", 409);
    await insertTaskAudit({
      action: "automation.task_created",
      auditId: `aud_create_${existing.id}`,
      env: input.env,
      metadata: { capabilityCode: existing.capabilityCode, status: existing.status, version: existing.version },
      now,
      requestId: input.requestId,
      shopId,
      taskId: existing.id,
      userId: input.userId,
    });
    await meterAutomationTask({ database: input.env.PLATFORM_DB, limit: automationRunLimit, now, shopId, taskId: existing.id });
    return { replayed: true, task: publicTask(existing, now) };
  }
  if (automationRunLimit !== null) {
    await assertQuotaAvailable({
      database: input.env.PLATFORM_DB,
      limit: automationRunLimit,
      metric: "automation_runs",
      shopId,
      requested: 1,
    });
  }
  let task: AutomationTask;
  try {
    task = await orchestrator.start({ actorId: input.userId, actorRole: "seller", shopId }, {
      capabilityCode: input.capabilityCode,
      idempotencyKeyHash,
      inputReference: `d1:shop/${shopId}`,
      requestHash,
      shopId,
    });
  } catch (error) {
    if (!isQuotaTrigger(error)) throw error;
    const replay = await findTaskByCreateIdempotency({
      env: input.env,
      idempotencyKeyHash,
      shopId,
    });
    if (replay !== null) {
      if (replay.requestHash !== requestHash) throw new AppError("idempotency_conflict", 409);
      await insertTaskAudit({
        action: "automation.task_created",
        auditId: `aud_create_${replay.id}`,
        env: input.env,
        metadata: { capabilityCode: replay.capabilityCode, status: replay.status, version: replay.version },
        now,
        requestId: input.requestId,
        shopId,
        taskId: replay.id,
        userId: input.userId,
      });
      await meterAutomationTask({ database: input.env.PLATFORM_DB, limit: automationRunLimit, now, shopId, taskId: replay.id });
      return { replayed: true, task: publicTask(replay, now) };
    }
    throw new AppError("automation_task_limit_reached", 429);
  }
  await insertTaskAudit({
    action: "automation.task_created",
    auditId: `aud_create_${task.id}`,
    env: input.env,
    metadata: { capabilityCode: task.capabilityCode, status: task.status, version: task.version },
    now,
    requestId: input.requestId,
    shopId,
    taskId: task.id,
    userId: input.userId,
  });
  await meterAutomationTask({ database: input.env.PLATFORM_DB, limit: automationRunLimit, now, shopId, taskId: task.id });
  return { replayed: false, task: publicTask(task, now) };
}

export async function listAutomationTasks(input: {
  capabilityCode?: string;
  env: AppBindings;
  limit?: number;
  runtime?: ApiRuntime;
  shopPublicId: string;
  status?: string;
  userId: string;
}): Promise<{ tasks: PublicAutomationTask[] }> {
  const { shopId } = await requireMember(input, "shop:read");
  const limit = requireListLimit(input.limit);
  const status = requireTaskStatus(input.status);
  if (input.capabilityCode !== undefined) defaultAutomationCapabilityRegistry.require(input.capabilityCode);
  const clauses = ["shop_id = ?"];
  const values: Array<number | string> = [shopId];
  if (status !== undefined) {
    clauses.push("status = ?");
    values.push(status);
  }
  if (input.capabilityCode !== undefined) {
    clauses.push("capability_code = ?");
    values.push(input.capabilityCode);
  }
  values.push(limit);
  const result = await input.env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, capability_code AS capabilityCode, status,
      idempotency_key_hash AS idempotencyKeyHash, request_hash AS requestHash,
      input_reference AS inputReference, attempt_count AS attemptCount,
      next_attempt_at AS nextAttemptAt, lease_token AS leaseToken,
      lease_expires_at AS leaseExpiresAt, last_safe_error_code AS lastSafeErrorCode,
      audit_log_id AS auditLogId,
      consent_evidence_reference AS consentEvidenceReference,
      action_reference AS actionReference, version,
      created_at AS createdAt, updated_at AS updatedAt
    FROM automation_tasks
    WHERE ${clauses.join(" AND ")}
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).bind(...values).all<AutomationTask>();
  const now = nowFrom(input.runtime);
  return { tasks: result.results.map((task) => publicTask(task, now)) };
}

export async function getAutomationTask(input: {
  env: AppBindings;
  runtime?: ApiRuntime;
  shopPublicId: string;
  taskId: string;
  userId: string;
}): Promise<{ task: PublicAutomationTask }> {
  assertAutomationTaskId(input.taskId);
  const { shopId } = await requireMember(input, "shop:read");
  const task = await loadTask(input.env, shopId, input.taskId);
  return { task: publicTask(task, nowFrom(input.runtime)) };
}

export async function cancelAutomationTask(input: {
  env: AppBindings;
  expectedVersion: number;
  idempotencyKey: string | null;
  reasonCode: string;
  requestId: string;
  runtime?: ApiRuntime;
  shopPublicId: string;
  taskId: string;
  userId: string;
}): Promise<{ replayed: boolean; task: PublicAutomationTask }> {
  assertAutomationTaskId(input.taskId);
  const expectedVersion = requireExpectedVersion(input.expectedVersion);
  const reasonCode = requireReasonCode(input.reasonCode);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const member = await requireMember(input, "shop:read");
  const current = await loadTask(input.env, member.shopId, input.taskId);
  assertRoleCapability(member.role, capabilityPermission(current.capabilityCode));
  const shopId = member.shopId;
  const now = nowFrom(input.runtime);
  const namespace = `automation.cancel.v2:${shopId}:${input.taskId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "automation-control-idempotency-v2", idempotencyKey);
  const requestHash = await sha256Hex({ expectedVersion, reasonCode, shopId, taskId: input.taskId });
  const safeCode = `automation_canceled.${reasonCode}`;
  const reservation = await reserveMutation({
    env: input.env,
    keyHash,
    namespace,
    now,
    processing: {
      auditId: createId("aud"),
      challengeId: null,
      expectedVersion,
      state: "processing",
      taskId: input.taskId,
    },
    requestHash,
    userId: input.userId,
  });
  if (reservation.state === "completed") {
    if (reservation.completedTask === null) throw new AppError("internal_error", 500);
    return { replayed: true, task: reservation.completedTask };
  }
  const durableActionReference = controlActionReference(reservation.processing.auditId);
  if (reservation.replayed) {
    const recovered = await recoverMutation({
      actionReference: durableActionReference,
      env: input.env,
      expectedVersion,
      keyHash,
      kind: "cancel",
      namespace,
      requestHash,
      safeCode,
      shopId,
      taskId: input.taskId,
      userId: input.userId,
    });
    if (recovered !== null) {
      await insertTaskAudit({
        action: "automation.task_canceled",
        auditId: reservation.processing.auditId,
        env: input.env,
        metadata: { capabilityCode: recovered.capabilityCode, reasonCode, version: recovered.version },
        now,
        requestId: input.requestId,
        shopId,
        taskId: recovered.id,
        userId: input.userId,
      });
      await finalizeMutation({ env: input.env, keyHash, namespace, now, requestHash, task: recovered, userId: input.userId });
      return { replayed: reservation.replayed, task: publicTask(recovered, now) };
    }
  }
  let task: AutomationTask;
  try {
    task = await orchestratorFor({ env: input.env, now }).orchestrator.cancelTask(
      { actorId: input.userId, actorRole: "seller", shopId },
      input.taskId,
      expectedVersion,
      safeCode,
      durableActionReference,
    );
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "automation_version_conflict") throw error;
    const recovered = await recoverMutation({
      actionReference: durableActionReference,
      env: input.env,
      expectedVersion,
      keyHash,
      kind: "cancel",
      namespace,
      requestHash,
      safeCode,
      shopId,
      taskId: input.taskId,
      userId: input.userId,
    });
    if (recovered === null) {
      if (reservation.replayed) throw new AppError("automation_idempotency_busy", 409);
      throw error;
    }
    await insertTaskAudit({
      action: "automation.task_canceled",
      auditId: reservation.processing.auditId,
      env: input.env,
      metadata: { capabilityCode: recovered.capabilityCode, reasonCode, version: recovered.version },
      now,
      requestId: input.requestId,
      shopId,
      taskId: recovered.id,
      userId: input.userId,
    });
    await finalizeMutation({ env: input.env, keyHash, namespace, now, requestHash, task: recovered, userId: input.userId });
    return { replayed: reservation.replayed, task: publicTask(recovered, now) };
  }
  if (task.actionReference !== durableActionReference) {
    throw new AppError("automation_version_conflict", 409);
  }
  await insertTaskAudit({
    action: "automation.task_canceled",
    auditId: reservation.processing.auditId,
    env: input.env,
    metadata: { capabilityCode: task.capabilityCode, reasonCode, version: task.version },
    now,
    requestId: input.requestId,
    shopId,
    taskId: task.id,
    userId: input.userId,
  });
  await finalizeMutation({ env: input.env, keyHash, namespace, now, requestHash, task, userId: input.userId });
  return { replayed: reservation.replayed, task: publicTask(task, now) };
}

export async function resumeAutomationTask(input: {
  env: AppBindings;
  evidenceToken?: string;
  expectedVersion: number;
  idempotencyKey: string | null;
  requestId: string;
  runtime?: ApiRuntime;
  shopPublicId: string;
  taskId: string;
  userId: string;
}): Promise<{ replayed: boolean; task: PublicAutomationTask }> {
  assertAutomationTaskId(input.taskId);
  const expectedVersion = requireExpectedVersion(input.expectedVersion);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const member = await requireMember(input, "shop:read");
  const current = await loadTask(input.env, member.shopId, input.taskId);
  assertRoleCapability(member.role, capabilityPermission(current.capabilityCode));
  const shopId = member.shopId;
  if (input.evidenceToken !== undefined) {
    throw new AppError("automation_evidence_server_only", 400);
  }
  const now = nowFrom(input.runtime);
  const namespace = `automation.resume.v2:${shopId}:${input.taskId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "automation-control-idempotency-v2", idempotencyKey);
  const requestHash = await sha256Hex({ expectedVersion, shopId, taskId: input.taskId });
  const challengeId = createId("aech");
  const reservation = await reserveMutation({
    env: input.env,
    keyHash,
    namespace,
    now,
    processing: {
      auditId: createId("aud"),
      challengeId,
      expectedVersion,
      state: "processing",
      taskId: input.taskId,
    },
    requestHash,
    userId: input.userId,
  });
  if (reservation.state === "completed") {
    if (reservation.completedTask === null) throw new AppError("internal_error", 500);
    return { replayed: true, task: reservation.completedTask };
  }
  let processing = reservation.processing;
  if (reservation.replayed) {
    const recovered = await recoverMutation({
      env: input.env,
      expectedVersion,
      keyHash,
      kind: "resume",
      namespace,
      requestHash,
      shopId,
      taskId: input.taskId,
      userId: input.userId,
    });
    if (recovered !== null) {
      await finalizeMutation({ env: input.env, keyHash, namespace, now, requestHash, task: recovered, userId: input.userId });
      return { replayed: true, task: publicTask(recovered, now) };
    }
    const anchor = await ensureUnusedEvidenceAnchor({
      env: input.env,
      keyHash,
      namespace,
      now,
      processing,
      requestHash,
      userId: input.userId,
    });
    if (anchor.state === "completed") {
      return { replayed: true, task: anchor.task };
    }
    processing = anchor;
  }
  const durableChallengeId = processing.challengeId;
  if (durableChallengeId === null) throw new AppError("internal_error", 500);
  const currentForMutation = reservation.replayed
    ? await loadTask(input.env, shopId, input.taskId)
    : current;
  const kind: EvidenceKind = currentForMutation.status === "waiting_user"
    ? "approval_granted"
    : currentForMutation.status === "waiting_provider"
      ? "external_action_completed"
      : (() => { throw new AppError("automation_continuation_invalid", 409); })();
  const providerReference = kind === "external_action_completed"
    ? (await resolveProviderEvidence({ env: input.env, now, task: currentForMutation }))?.reference ?? null
    : null;
  if (kind === "external_action_completed" && providerReference === null) {
    throw new AppError("automation_provider_evidence_pending", 409);
  }
  const durableEvidenceReference = evidenceReference(durableChallengeId);
  let evidence: { reference: string; token: string };
  try {
    evidence = await createAndConsumeEvidence({
      auditId: processing.auditId,
      capabilityCode: currentForMutation.capabilityCode,
      challengeId: durableChallengeId,
      env: input.env,
      kind,
      now,
      requestId: input.requestId,
      shopId,
      taskId: input.taskId,
      taskVersion: expectedVersion,
      userId: input.userId,
      ...(providerReference === null ? {} : { providerReference }),
    });
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "automation_evidence_conflict") throw error;
    const recovered = await recoverMutation({
      env: input.env,
      evidenceReference: durableEvidenceReference,
      expectedVersion,
      keyHash,
      kind: "resume",
      namespace,
      requestHash,
      shopId,
      taskId: input.taskId,
      userId: input.userId,
    });
    if (recovered === null) throw new AppError("automation_idempotency_busy", 409);
    await finalizeMutation({ env: input.env, keyHash, namespace, now, requestHash, task: recovered, userId: input.userId });
    return { replayed: reservation.replayed, task: publicTask(recovered, now) };
  }
  const continuation: AutomationContinuation = kind === "approval_granted"
    ? { evidenceToken: evidence.token, kind }
    : { evidenceToken: evidence.token, kind };
  let task: AutomationTask;
  try {
    task = await orchestratorFor({ env: input.env, evidence, now }).orchestrator.continueTask(
      { actorId: input.userId, actorRole: "seller", shopId },
      input.taskId,
      continuation,
      expectedVersion,
    );
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "automation_version_conflict") throw error;
    const recovered = await recoverMutation({
      env: input.env,
      evidenceReference: durableEvidenceReference,
      expectedVersion,
      keyHash,
      kind: "resume",
      namespace,
      requestHash,
      shopId,
      taskId: input.taskId,
      userId: input.userId,
    });
    if (recovered === null) {
      if (reservation.replayed) throw new AppError("automation_idempotency_busy", 409);
      throw error;
    }
    await finalizeMutation({ env: input.env, keyHash, namespace, now, requestHash, task: recovered, userId: input.userId });
    return { replayed: reservation.replayed, task: publicTask(recovered, now) };
  }
  await finalizeMutation({ env: input.env, keyHash, namespace, now, requestHash, task, userId: input.userId });
  return { replayed: reservation.replayed, task: publicTask(task, now) };
}
