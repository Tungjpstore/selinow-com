import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import { createGeneratedLicenseQueueEnvelope } from "../commerce/generated-license";
import type { AppBindings } from "../platform/bindings";
import {
  operationsScopeKey,
  safeOperationsReference,
  safeReferenceEnvelope,
  upsertOpenIncident,
} from "./incidents";

const MESSAGE_KINDS = [
  "order_paid",
  "payment_exception",
  "integration",
  "notification",
  "telegram_delivery",
  "domain_reconciliation",
  "operations",
  "unknown",
] as const;
const REFERENCE_TYPES = [
  "order",
  "payment_attempt",
  "payment_integration",
  "telegram_integration",
  "shop_domain",
  "outbox_job",
  "rotation_run",
  "backup_snapshot",
  "none",
] as const;

export type DeadLetterMessageKind = typeof MESSAGE_KINDS[number];
export type DeadLetterReferenceType = typeof REFERENCE_TYPES[number];
export type DeadLetterReplayStatus = "completed" | "enqueued" | "failed" | "idle" | "requested";
export type DeadLetterReplayTargetKind = "delivery_job" | "domain_event";
export type DeadLetterStatus = "acknowledged" | "open" | "resolved" | "retry_requested";

type DeadLetterRow = {
  acknowledgedAt: string | null;
  acknowledgedByUserId: string | null;
  createdAt: string;
  failureCode: string;
  firstSeenAt: string;
  id: string;
  incidentId: string | null;
  lastSeenAt: string;
  messageId: string;
  messageKind: DeadLetterMessageKind;
  occurrenceCount: number;
  providerAttempts: number;
  queueName: string;
  referenceId: string | null;
  referenceType: DeadLetterReferenceType;
  replayStatus: DeadLetterReplayStatus | null;
  replayTargetKind: DeadLetterReplayTargetKind | null;
  resolutionCode: string | null;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  retryCount: number;
  retryRequestedAt: string | null;
  retryRequestedByUserId: string | null;
  safeEnvelopeJson: string;
  shopId: string | null;
  status: DeadLetterStatus;
  updatedAt: string;
  version: number;
};

export type DeadLetterView = Omit<DeadLetterRow, "safeEnvelopeJson"> & {
  safeEnvelope: Record<string, string>;
};

export type ActiveDeadLetterList = {
  hasMore: boolean;
  items: DeadLetterView[];
  limit: number;
};

type GeneratedLicenseDeadLetterRow = {
  createdAt: string;
  failureCode: string;
  id: string;
  occurrenceCount: number;
  providerAttempts: number;
  requestId: string;
  requestStatus: "canceled" | "failed" | "manual_review" | "pending" | "processing" | "reconcile_pending" | "retryable" | "succeeded";
  resolutionCode: string | null;
  resolvedAt: string | null;
  safeContextJson: string;
  shopId: string;
  status: "acknowledged" | "open" | "resolved" | "retry_requested";
  updatedAt: string;
};

export type GeneratedLicenseDeadLetterView = Omit<GeneratedLicenseDeadLetterRow, "safeContextJson"> & {
  safeContext: Record<string, string>;
};

export type ActiveGeneratedLicenseDeadLetterList = {
  hasMore: boolean;
  items: GeneratedLicenseDeadLetterView[];
  limit: number;
};

const GENERATED_LICENSE_DEAD_LETTER_SELECT = `
  SELECT dead_letter.id, dead_letter.shop_id AS shopId,
    dead_letter.request_id AS requestId, dead_letter.failure_code AS failureCode,
    dead_letter.safe_context_json AS safeContextJson, dead_letter.status,
    dead_letter.provider_attempts AS providerAttempts,
    dead_letter.occurrence_count AS occurrenceCount,
    dead_letter.resolution_code AS resolutionCode,
    dead_letter.resolved_at AS resolvedAt,
    dead_letter.created_at AS createdAt, dead_letter.updated_at AS updatedAt,
    request.status AS requestStatus
  FROM generated_license_dead_letters AS dead_letter
  INNER JOIN generated_license_requests AS request
    ON request.id = dead_letter.request_id AND request.shop_id = dead_letter.shop_id
`;

function mapGeneratedLicenseDeadLetter(row: GeneratedLicenseDeadLetterRow): GeneratedLicenseDeadLetterView {
  const { safeContextJson, ...view } = row;
  const safeContext: Record<string, string> = {};
  try {
    const parsed = JSON.parse(safeContextJson) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("safe_context_invalid");
    for (const key of ["providerCode", "requestId"] as const) {
      const value = (parsed as Record<string, unknown>)[key];
      if (value !== undefined) safeContext[key] = safeOperationsReference(value, `safe_context_${key}_invalid`);
    }
  } catch {
    // A corrupt safe projection must not make the operator surface fail open.
  }
  return { ...view, safeContext };
}

const DEAD_LETTER_SELECT = `
  SELECT id, shop_id AS shopId, queue_name AS queueName, message_id AS messageId,
    message_kind AS messageKind, reference_type AS referenceType,
    reference_id AS referenceId, failure_code AS failureCode,
    (SELECT target_kind FROM queue_dead_letter_outbox_links
      WHERE dead_letter_id = queue_dead_letters.id LIMIT 1) AS replayTargetKind,
    (SELECT replay_status FROM queue_dead_letter_outbox_links
      WHERE dead_letter_id = queue_dead_letters.id LIMIT 1) AS replayStatus,
    safe_envelope_json AS safeEnvelopeJson, status,
    provider_attempts AS providerAttempts, occurrence_count AS occurrenceCount,
    incident_id AS incidentId, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
    acknowledged_by_user_id AS acknowledgedByUserId, acknowledged_at AS acknowledgedAt,
    retry_requested_by_user_id AS retryRequestedByUserId,
    retry_requested_at AS retryRequestedAt, retry_count AS retryCount,
    resolved_by_user_id AS resolvedByUserId, resolved_at AS resolvedAt,
    resolution_code AS resolutionCode, version, created_at AS createdAt,
    updated_at AS updatedAt
  FROM queue_dead_letters
`;

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function safeAttempts(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new AppError("operations_validation_failed", 400, ["provider_attempts_invalid"]);
  }
  return value;
}

function safeActor(value: string | null): string | null {
  return value === null ? null : safeOperationsReference(value, "actor_user_id_invalid");
}

function safeExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AppError("operations_validation_failed", 400, ["expected_version_invalid"]);
  }
  return value;
}

function mapDeadLetter(row: DeadLetterRow): DeadLetterView {
  const { safeEnvelopeJson, ...view } = row;
  const safeEnvelope = (() => {
    try {
      return safeReferenceEnvelope(JSON.parse(safeEnvelopeJson) as unknown);
    } catch {
      return {};
    }
  })();
  return { ...view, safeEnvelope };
}

async function findDeadLetterByMessage(
  env: AppBindings,
  queueName: string,
  messageId: string,
): Promise<DeadLetterRow | null> {
  return env.PLATFORM_DB.prepare(`${DEAD_LETTER_SELECT}
    WHERE queue_name = ? AND message_id = ? LIMIT 1
  `).bind(queueName, messageId).first<DeadLetterRow>();
}

async function findDeadLetterById(
  env: AppBindings,
  id: string,
  shopId: string | null,
): Promise<DeadLetterRow | null> {
  return env.PLATFORM_DB.prepare(`${DEAD_LETTER_SELECT}
    WHERE id = ? AND shop_id IS ? LIMIT 1
  `).bind(id, shopId).first<DeadLetterRow>();
}

function requireDeadLetter(row: DeadLetterRow | null): DeadLetterRow {
  if (row === null) throw new AppError("dead_letter_not_found", 404);
  return row;
}

type ReplayTarget = {
  id: string;
  kind: DeadLetterReplayTargetKind;
};

async function findReplayTarget(input: {
  env: AppBindings;
  operationId: string | undefined;
  referenceId: string;
  shopId: string;
}): Promise<ReplayTarget | null> {
  const findDomainEvent = () => input.env.PLATFORM_DB.prepare(`
    SELECT id FROM domain_events WHERE shop_id = ? AND id = ? LIMIT 1
  `).bind(input.shopId, input.referenceId).first<{ id: string }>();
  const findDeliveryJob = () => input.env.PLATFORM_DB.prepare(`
    SELECT id FROM delivery_jobs WHERE shop_id = ? AND id = ? LIMIT 1
  `).bind(input.shopId, input.referenceId).first<{ id: string }>();

  if (input.operationId === "domain_event_dispatch") {
    const target = await findDomainEvent();
    return target === null ? null : { id: target.id, kind: "domain_event" };
  }
  if (input.operationId === "channel_delivery") {
    const target = await findDeliveryJob();
    return target === null ? null : { id: target.id, kind: "delivery_job" };
  }

  const [domainEvent, deliveryJob] = await Promise.all([findDomainEvent(), findDeliveryJob()]);
  if (domainEvent !== null && deliveryJob === null) {
    return { id: domainEvent.id, kind: "domain_event" };
  }
  if (deliveryJob !== null && domainEvent === null) {
    return { id: deliveryJob.id, kind: "delivery_job" };
  }
  return null;
}

async function ensureOutboxReplayLink(input: {
  deadLetter: DeadLetterRow;
  env: AppBindings;
  nowIso: string;
  operationId: string | undefined;
}): Promise<void> {
  const { deadLetter } = input;
  if (deadLetter.referenceType !== "outbox_job" || deadLetter.referenceId === null
    || deadLetter.shopId === null) return;
  const target = await findReplayTarget({
    env: input.env,
    operationId: input.operationId,
    referenceId: deadLetter.referenceId,
    shopId: deadLetter.shopId,
  });
  if (target === null) return;

  const liveTargetSql = target.kind === "domain_event"
    ? "target_kind = 'domain_event' AND domain_event_id = ?"
    : "target_kind = 'delivery_job' AND delivery_job_id = ?";
  const targetColumns = target.kind === "domain_event"
    ? { deliveryJobId: null, domainEventId: target.id }
    : { deliveryJobId: target.id, domainEventId: null };
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE queue_dead_letter_outbox_links
      SET replay_status = 'failed', replay_finished_at = ?,
        last_safe_error_code = 'queue_retries_exhausted',
        version = version + 1, updated_at = ?
      WHERE shop_id = ? AND ${liveTargetSql}
        AND dead_letter_id != ? AND replay_status IN ('requested', 'enqueued')
    `).bind(input.nowIso, input.nowIso, deadLetter.shopId, target.id, deadLetter.id),
    input.env.PLATFORM_DB.prepare(`
      INSERT OR IGNORE INTO queue_dead_letter_outbox_links (
        dead_letter_id, shop_id, target_kind, domain_event_id, delivery_job_id,
        replay_status, replay_count, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'idle', 0, 1, ?, ?)
    `).bind(
      deadLetter.id,
      deadLetter.shopId,
      target.kind,
      targetColumns.domainEventId,
      targetColumns.deliveryJobId,
      input.nowIso,
      input.nowIso,
    ),
  ]);
  const linked = await input.env.PLATFORM_DB.prepare(`
    SELECT target_kind AS targetKind, domain_event_id AS domainEventId,
      delivery_job_id AS deliveryJobId
    FROM queue_dead_letter_outbox_links
    WHERE dead_letter_id = ? AND shop_id = ? LIMIT 1
  `).bind(deadLetter.id, deadLetter.shopId).first<{
    deliveryJobId: string | null;
    domainEventId: string | null;
    targetKind: DeadLetterReplayTargetKind;
  }>();
  const linkedTargetId = linked?.targetKind === "domain_event"
    ? linked.domainEventId
    : linked?.deliveryJobId;
  if (linked === null || linked.targetKind !== target.kind || linkedTargetId !== target.id) {
    throw new AppError("dead_letter_replay_target_invalid", 409);
  }
}

export async function listActiveDeadLetters(input: {
  env: AppBindings;
  limit?: number;
}): Promise<ActiveDeadLetterList> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError("operations_validation_failed", 400, ["limit_invalid"]);
  }
  const result = await input.env.PLATFORM_DB.prepare(`${DEAD_LETTER_SELECT}
    WHERE status IN ('open', 'acknowledged', 'retry_requested')
    ORDER BY CASE status
      WHEN 'open' THEN 3
      WHEN 'retry_requested' THEN 2
      ELSE 1
    END DESC, last_seen_at DESC, id
    LIMIT ?
  `).bind(limit + 1).all<DeadLetterRow>();
  return {
    hasMore: result.results.length > limit,
    items: result.results.slice(0, limit).map(mapDeadLetter),
    limit,
  };
}

export async function listActiveGeneratedLicenseDeadLetters(input: {
  env: AppBindings;
  limit?: number;
}): Promise<ActiveGeneratedLicenseDeadLetterList> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError("operations_validation_failed", 400, ["limit_invalid"]);
  }
  const result = await input.env.PLATFORM_DB.prepare(`${GENERATED_LICENSE_DEAD_LETTER_SELECT}
    WHERE dead_letter.status IN ('open', 'acknowledged', 'retry_requested')
    ORDER BY CASE dead_letter.status
      WHEN 'open' THEN 3
      WHEN 'retry_requested' THEN 2
      ELSE 1
    END DESC, dead_letter.updated_at DESC, dead_letter.id
    LIMIT ?
  `).bind(limit + 1).all<GeneratedLicenseDeadLetterRow>();
  return {
    hasMore: result.results.length > limit,
    items: result.results.slice(0, limit).map(mapGeneratedLicenseDeadLetter),
    limit,
  };
}

async function attachIncident(
  env: AppBindings,
  deadLetter: DeadLetterRow,
  incidentId: string,
  nowIso: string,
): Promise<DeadLetterRow> {
  if (deadLetter.incidentId === incidentId) return deadLetter;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = requireDeadLetter(await findDeadLetterById(env, deadLetter.id, deadLetter.shopId));
    if (current.incidentId === incidentId) return current;
    const result = await env.PLATFORM_DB.prepare(`
      UPDATE queue_dead_letters
      SET incident_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id IS ? AND version = ?
    `).bind(
      incidentId,
      nowIso,
      current.id,
      current.shopId,
      current.version,
    ).run();
    if (result.meta.changes === 1) {
      return requireDeadLetter(await findDeadLetterById(env, current.id, current.shopId));
    }
  }
  throw new AppError("dead_letter_conflict", 409);
}

export async function recordDeadLetter(input: {
  env: AppBindings;
  failureCode: string;
  messageId: string;
  messageKind: DeadLetterMessageKind;
  now?: Date;
  providerAttempts: number;
  queueName: string;
  referenceId?: string;
  referenceType: DeadLetterReferenceType;
  safeEnvelope?: unknown;
  shopId: string | null;
}): Promise<DeadLetterView> {
  if (!isOneOf(input.messageKind, MESSAGE_KINDS) || !isOneOf(input.referenceType, REFERENCE_TYPES)) {
    throw new AppError("operations_validation_failed", 400, ["dead_letter_classification_invalid"]);
  }
  const queueName = safeOperationsReference(input.queueName, "queue_name_invalid");
  const messageId = safeOperationsReference(input.messageId, "message_id_invalid");
  const failureCode = safeOperationsReference(input.failureCode, "failure_code_invalid");
  const providerAttempts = safeAttempts(input.providerAttempts);
  const referenceId = input.referenceType === "none"
    ? null
    : safeOperationsReference(input.referenceId, "reference_id_invalid");
  if (input.referenceType === "none" && input.referenceId !== undefined) {
    throw new AppError("operations_validation_failed", 400, ["reference_id_unexpected"]);
  }
  const safeEnvelope = safeReferenceEnvelope(input.safeEnvelope);
  const safeEnvelopeJson = JSON.stringify(safeEnvelope);
  const scopeKey = operationsScopeKey(input.shopId);
  const nowIso = (input.now ?? new Date()).toISOString();
  let row: DeadLetterRow | null = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await findDeadLetterByMessage(input.env, queueName, messageId);
    if (existing !== null) {
      if (existing.shopId !== input.shopId) throw new AppError("dead_letter_scope_conflict", 409);
      if (existing.messageKind !== input.messageKind
        || existing.referenceType !== input.referenceType
        || existing.referenceId !== referenceId) {
        throw new AppError("dead_letter_identity_conflict", 409);
      }
      const result = await input.env.PLATFORM_DB.prepare(`
        UPDATE queue_dead_letters
        SET message_kind = ?, reference_type = ?, reference_id = ?, failure_code = ?,
            safe_envelope_json = ?, status = 'open',
            provider_attempts = MAX(provider_attempts, ?),
            occurrence_count = occurrence_count + 1, last_seen_at = ?,
            acknowledged_by_user_id = NULL, acknowledged_at = NULL,
            retry_requested_by_user_id = NULL, retry_requested_at = NULL,
            resolved_by_user_id = NULL, resolved_at = NULL, resolution_code = NULL,
            version = version + 1, updated_at = ?
        WHERE id = ? AND shop_id IS ? AND scope_key = ? AND version = ?
      `).bind(
        input.messageKind,
        input.referenceType,
        referenceId,
        failureCode,
        safeEnvelopeJson,
        providerAttempts,
        nowIso,
        nowIso,
        existing.id,
        input.shopId,
        scopeKey,
        existing.version,
      ).run();
      if (result.meta.changes === 1) {
        row = requireDeadLetter(await findDeadLetterById(input.env, existing.id, input.shopId));
        break;
      }
      continue;
    }

    const id = createId("dlq");
    try {
      await input.env.PLATFORM_DB.prepare(`
        INSERT INTO queue_dead_letters (
          id, shop_id, scope_key, queue_name, message_id, message_kind,
          reference_type, reference_id, failure_code, safe_envelope_json,
          status, provider_attempts, occurrence_count, first_seen_at,
          last_seen_at, retry_count, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ?, 0, 1, ?, ?)
      `).bind(
        id,
        input.shopId,
        scopeKey,
        queueName,
        messageId,
        input.messageKind,
        input.referenceType,
        referenceId,
        failureCode,
        safeEnvelopeJson,
        providerAttempts,
        nowIso,
        nowIso,
        nowIso,
        nowIso,
      ).run();
      row = requireDeadLetter(await findDeadLetterById(input.env, id, input.shopId));
      break;
    } catch (error) {
      if (await findDeadLetterByMessage(input.env, queueName, messageId) === null) throw error;
      // A concurrent delivery of the same queue/message pair won the insert.
    }
  }
  if (row === null) throw new AppError("dead_letter_conflict", 409);

  await ensureOutboxReplayLink({
    deadLetter: row,
    env: input.env,
    nowIso,
    operationId: safeEnvelope.operationId,
  });

  const incident = await upsertOpenIncident({
    category: "queue_dead_letter",
    env: input.env,
    incidentKey: `dead-letter:${row.id}`,
    ...(input.now === undefined ? {} : { now: input.now }),
    safeContext: {
      deadLetterId: row.id,
      messageId: row.messageId,
      queueName: row.queueName,
      ...(safeEnvelope.operationId === undefined ? {} : { operationId: safeEnvelope.operationId }),
      ...(safeEnvelope.requestId === undefined ? {} : { requestId: safeEnvelope.requestId }),
    },
    severity: row.occurrenceCount >= 8 ? "high" : row.occurrenceCount >= 3 ? "medium" : "low",
    shopId: input.shopId,
    sourceKind: "queue",
    sourceRef: row.id,
  });
  row = await attachIncident(input.env, row, incident.id, nowIso);
  return mapDeadLetter(row);
}

async function transitionDeadLetter(input: {
  actorUserId: string | null;
  env: AppBindings;
  expectedVersion: number;
  id: string;
  now?: Date;
  requestId: string;
  resolutionCode?: string;
  shopId: string | null;
  transition: "acknowledge" | "request_retry" | "resolve";
}): Promise<DeadLetterView> {
  const id = safeOperationsReference(input.id, "dead_letter_id_invalid");
  const actorUserId = safeActor(input.actorUserId);
  const expectedVersion = safeExpectedVersion(input.expectedVersion);
  const requestId = safeOperationsReference(input.requestId, "request_id_invalid");
  const nowIso = (input.now ?? new Date()).toISOString();
  let statement: D1PreparedStatement;
  let auditAction: string;
  let auditMetadata = "{}";
  let eligibleStatusSql: string;
  if (input.transition === "acknowledge") {
    auditAction = "operations.dead_letter_acknowledged";
    eligibleStatusSql = "status = 'open'";
    statement = input.env.PLATFORM_DB.prepare(`
      UPDATE queue_dead_letters
      SET status = 'acknowledged', acknowledged_by_user_id = ?, acknowledged_at = ?,
          version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id IS ? AND status = 'open' AND version = ?
    `).bind(actorUserId, nowIso, nowIso, id, input.shopId, expectedVersion);
  } else if (input.transition === "request_retry") {
    auditAction = "operations.dead_letter_retry_requested";
    eligibleStatusSql = "status IN ('open', 'acknowledged')";
    statement = input.env.PLATFORM_DB.prepare(`
      UPDATE queue_dead_letters
      SET status = 'retry_requested', retry_requested_by_user_id = ?,
          retry_requested_at = ?, retry_count = retry_count + 1,
          version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id IS ? AND status IN ('open', 'acknowledged') AND version = ?
    `).bind(actorUserId, nowIso, nowIso, id, input.shopId, expectedVersion);
  } else {
    const resolutionCode = safeOperationsReference(input.resolutionCode, "resolution_code_invalid");
    auditAction = "operations.dead_letter_resolved";
    auditMetadata = JSON.stringify({ resolutionCode });
    eligibleStatusSql = "status IN ('open', 'acknowledged', 'retry_requested')";
    statement = input.env.PLATFORM_DB.prepare(`
      UPDATE queue_dead_letters
      SET status = 'resolved', resolved_by_user_id = ?, resolved_at = ?,
          resolution_code = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id IS ?
        AND status IN ('open', 'acknowledged', 'retry_requested') AND version = ?
    `).bind(
      actorUserId,
      nowIso,
      resolutionCode,
      nowIso,
      id,
      input.shopId,
      expectedVersion,
    );
  }
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
        safe_metadata_json, request_id, created_at, source_kind, correlation_id,
        operation_id, retention_class
      ) SELECT ?, ?, 'platform_admin', ?, ?, 'queue_dead_letter', ?, ?, ?, ?,
        'http', ?, ?, 'security'
      WHERE EXISTS (
        SELECT 1 FROM queue_dead_letters
        WHERE id = ? AND shop_id IS ? AND ${eligibleStatusSql} AND version = ?
      )
    `).bind(
      createId("aud"),
      input.shopId,
      actorUserId,
      auditAction,
      id,
      auditMetadata,
      requestId,
      nowIso,
      requestId,
      id,
      id,
      input.shopId,
      expectedVersion,
    ),
    statement,
  ]);
  if (results[1]?.meta.changes !== 1) {
    if (await findDeadLetterById(input.env, id, input.shopId) === null) {
      throw new AppError("dead_letter_not_found", 404);
    }
    throw new AppError("dead_letter_conflict", 409);
  }
  if (results[0]?.meta.changes !== 1) throw new AppError("dead_letter_conflict", 409);
  return mapDeadLetter(requireDeadLetter(await findDeadLetterById(input.env, id, input.shopId)));
}

export function acknowledgeDeadLetter(input: {
  actorUserId: string | null;
  env: AppBindings;
  expectedVersion: number;
  id: string;
  now?: Date;
  requestId: string;
  shopId: string | null;
}): Promise<DeadLetterView> {
  return transitionDeadLetter({ ...input, transition: "acknowledge" });
}

export function requestDeadLetterRetry(input: {
  actorUserId: string | null;
  env: AppBindings;
  expectedVersion: number;
  id: string;
  now?: Date;
  requestId: string;
  shopId: string | null;
}): Promise<DeadLetterView> {
  return transitionDeadLetter({ ...input, transition: "request_retry" });
}

export function resolveDeadLetter(input: {
  actorUserId: string | null;
  env: AppBindings;
  expectedVersion: number;
  id: string;
  now?: Date;
  requestId: string;
  resolutionCode: string;
  shopId: string | null;
}): Promise<DeadLetterView> {
  return transitionDeadLetter({ ...input, transition: "resolve" });
}

type ReplayLink = {
  deliveryJobId: string | null;
  domainEventId: string | null;
  replayRequestId: string | null;
  replayStatus: DeadLetterReplayStatus;
  targetKind: DeadLetterReplayTargetKind;
};

const REPLAY_NAMESPACE = "admin.dead-letter-replay.v1";
const REPLAY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const GENERATED_LICENSE_RETRY_NAMESPACE = "admin.generated-license-dead-letter-retry.v1";

async function findGeneratedLicenseDeadLetterById(
  env: AppBindings,
  id: string,
  shopId: string,
): Promise<GeneratedLicenseDeadLetterRow | null> {
  return env.PLATFORM_DB.prepare(`${GENERATED_LICENSE_DEAD_LETTER_SELECT}
    WHERE dead_letter.id = ? AND dead_letter.shop_id = ? LIMIT 1
  `).bind(id, shopId).first<GeneratedLicenseDeadLetterRow>();
}

async function requireReplayOperator(env: AppBindings, userId: string): Promise<void> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT role FROM platform_admins
    WHERE user_id = ? AND status = 'active' LIMIT 1
  `).bind(userId).first<{ role: "owner" | "risk" | "support" }>();
  if (row === null || !new Set(["owner", "risk"]).has(row.role)) {
    throw new AppError("authorization_denied", 403);
  }
}

export async function requestGeneratedLicenseDeadLetterRetry(input: {
  actorUserId: string;
  env: AppBindings;
  id: string;
  idempotencyKey: string;
  now?: Date;
  requestId: string;
  shopId: string;
}): Promise<{ deadLetter: GeneratedLicenseDeadLetterView; operationId: string; replayed: boolean }> {
  const actorUserId = safeOperationsReference(input.actorUserId, "actor_user_id_invalid");
  const id = safeOperationsReference(input.id, "dead_letter_id_invalid");
  const shopId = safeOperationsReference(input.shopId, "shop_id_invalid");
  const requestId = safeOperationsReference(input.requestId, "request_id_invalid");
  if (!REPLAY_KEY.test(input.idempotencyKey)) {
    throw new AppError("operations_validation_failed", 400, ["idempotency_key_invalid"]);
  }
  await requireReplayOperator(input.env, actorUserId);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "idempotency", input.idempotencyKey);
  const requestHash = await sha256Json({ deadLetterId: id, shopId });
  const operationId = `gld_${(await hmacToken(
    input.env.SESSION_SECRET,
    GENERATED_LICENSE_RETRY_NAMESPACE,
    `${actorUserId}:${input.idempotencyKey}`,
  )).slice(0, 48)}`;
  const deadLetter = await findGeneratedLicenseDeadLetterById(input.env, id, shopId);
  if (deadLetter === null) throw new AppError("generated_license_dead_letter_not_found", 404);
  const stored = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash AS requestHash, response_json AS responseJson
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
    LIMIT 1
  `).bind(actorUserId, GENERATED_LICENSE_RETRY_NAMESPACE, keyHash, nowIso)
    .first<{ requestHash: string; responseJson: string }>();
  if (stored !== null && stored.requestHash !== requestHash) {
    throw new AppError("idempotency_conflict", 409);
  }

  let replayed = stored !== null;
  const state = stored === null ? null : parseGeneratedLicenseRetryState(stored.responseJson);
  if (stored === null) {
    if (!new Set(["open", "acknowledged"]).has(deadLetter.status)
      || !new Set(["failed", "manual_review"]).has(deadLetter.requestStatus)) {
      throw new AppError("generated_license_dead_letter_conflict", 409);
    }
    let batchChangedAll = false;
    try {
      const results = await input.env.PLATFORM_DB.batch([
        input.env.PLATFORM_DB.prepare(`
        UPDATE generated_license_dead_letters
        SET status = 'retry_requested', updated_at = ?
        WHERE id = ? AND shop_id = ? AND status IN ('open', 'acknowledged')
          AND EXISTS (
            SELECT 1 FROM generated_license_requests
            WHERE id = ? AND shop_id = ? AND status IN ('failed', 'manual_review')
          )
      `).bind(nowIso, id, shopId, deadLetter.requestId, shopId),
        input.env.PLATFORM_DB.prepare(`
        UPDATE generated_license_requests
        SET status = 'retryable', next_attempt_at = ?, last_safe_error_code = NULL,
          lease_token = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND shop_id = ? AND status IN ('failed', 'manual_review')
          AND changes() = 1
          AND EXISTS (
            SELECT 1 FROM generated_license_dead_letters
            WHERE id = ? AND shop_id = ? AND status = 'retry_requested'
          )
      `).bind(nowIso, nowIso, deadLetter.requestId, shopId, id, shopId),
        input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
          safe_metadata_json, request_id, created_at, source_kind,
          correlation_id, operation_id, retention_class
        ) SELECT ?, ?, 'platform_admin', ?, 'operations.generated_license_dead_letter_retry_requested',
          'generated_license_dead_letter', ?, ?, ?, ?, 'http', ?, ?, 'security'
        WHERE changes() = 1
          AND EXISTS (
            SELECT 1 FROM generated_license_dead_letters
            WHERE id = ? AND shop_id = ? AND status = 'retry_requested'
          ) AND EXISTS (
            SELECT 1 FROM generated_license_requests
            WHERE id = ? AND shop_id = ? AND status = 'retryable'
          )
      `).bind(
        createId("aud"), shopId, actorUserId, id,
        JSON.stringify({ operationId, requestId: deadLetter.requestId }), requestId, nowIso,
        requestId, operationId, id, shopId, deadLetter.requestId, shopId,
      ),
        input.env.PLATFORM_DB.prepare(`
        INSERT INTO idempotency_records (
          actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE changes() = 1
      `).bind(
        actorUserId, GENERATED_LICENSE_RETRY_NAMESPACE, keyHash, requestHash,
        JSON.stringify({ state: "pending", operationId }), nowIso,
        new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
      ),
      ]);
      batchChangedAll = results.every((result) => result.meta.changes === 1);
    } catch (error) {
      const raced = await input.env.PLATFORM_DB.prepare(`
        SELECT request_hash AS requestHash, response_json AS responseJson
        FROM idempotency_records
        WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
        LIMIT 1
      `).bind(actorUserId, GENERATED_LICENSE_RETRY_NAMESPACE, keyHash, nowIso)
        .first<{ requestHash: string; responseJson: string }>();
      if (raced === null) throw error;
      if (raced.requestHash !== requestHash) throw new AppError("idempotency_conflict", 409);
      replayed = true;
      if (parseGeneratedLicenseRetryState(raced.responseJson) === "enqueued") {
        const refreshed = await findGeneratedLicenseDeadLetterById(input.env, id, shopId);
        if (refreshed === null) throw new AppError("generated_license_dead_letter_not_found", 404);
        return { deadLetter: mapGeneratedLicenseDeadLetter(refreshed), operationId, replayed: true };
      }
    }
    if (!batchChangedAll && !replayed) {
      throw new AppError("generated_license_dead_letter_conflict", 409);
    }
  } else if (state === "enqueued") {
    return {
      deadLetter: mapGeneratedLicenseDeadLetter(deadLetter),
      operationId,
      replayed: true,
    };
  } else if (state === "pending" || state === "enqueuing") {
    const ownership = await input.env.PLATFORM_DB.prepare(`
      SELECT 1 AS owned
      FROM audit_logs
      WHERE shop_id = ? AND action = 'operations.generated_license_dead_letter_retry_requested'
        AND resource_id = ? AND operation_id = ?
      LIMIT 1
    `).bind(shopId, id, operationId).first<{ owned: number }>();
    if (ownership === null
      || deadLetter.status !== "retry_requested"
      || deadLetter.requestStatus !== "retryable") {
      throw new AppError("generated_license_dead_letter_conflict", 409);
    }
    if (state === "enqueuing") {
      throw new AppError("generated_license_dead_letter_enqueue_in_progress", 409);
    }
  }

  const claiming = await input.env.PLATFORM_DB.prepare(`
    UPDATE idempotency_records SET response_json = ?
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND request_hash = ?
      AND json_extract(response_json, '$.state') = 'pending'
      AND json_extract(response_json, '$.operationId') = ?
  `).bind(
    JSON.stringify({ state: "enqueuing", operationId }), actorUserId,
    GENERATED_LICENSE_RETRY_NAMESPACE, keyHash, requestHash, operationId,
  ).run();
  if (claiming.meta.changes !== 1) {
    const current = await input.env.PLATFORM_DB.prepare(`
      SELECT response_json AS responseJson
      FROM idempotency_records
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND request_hash = ?
      LIMIT 1
    `).bind(actorUserId, GENERATED_LICENSE_RETRY_NAMESPACE, keyHash, requestHash)
      .first<{ responseJson: string }>();
    if (current !== null && parseGeneratedLicenseRetryState(current.responseJson) === "enqueued") {
      const refreshed = await findGeneratedLicenseDeadLetterById(input.env, id, shopId);
      if (refreshed === null) throw new AppError("generated_license_dead_letter_not_found", 404);
      return { deadLetter: mapGeneratedLicenseDeadLetter(refreshed), operationId, replayed: true };
    }
    if (current !== null && parseGeneratedLicenseRetryState(current.responseJson) === "enqueuing") {
      throw new AppError("generated_license_dead_letter_enqueue_in_progress", 409);
    }
    throw new AppError("generated_license_dead_letter_conflict", 409);
  }

  try {
    await input.env.INTEGRATION_QUEUE.send(createGeneratedLicenseQueueEnvelope({
      requestId: deadLetter.requestId,
      shopId,
    }));
  } catch {
    await input.env.PLATFORM_DB.prepare(`
      UPDATE idempotency_records SET response_json = ?
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND request_hash = ?
        AND json_extract(response_json, '$.state') = 'enqueuing'
        AND json_extract(response_json, '$.operationId') = ?
    `).bind(
      JSON.stringify({ state: "pending", operationId }), actorUserId,
      GENERATED_LICENSE_RETRY_NAMESPACE, keyHash, requestHash, operationId,
    ).run();
    throw new AppError("generated_license_dead_letter_enqueue_failed", 503);
  }
  const enqueued = await input.env.PLATFORM_DB.prepare(`
    UPDATE idempotency_records SET response_json = ?
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND request_hash = ?
      AND json_extract(response_json, '$.state') = 'enqueuing'
      AND json_extract(response_json, '$.operationId') = ?
  `).bind(
    JSON.stringify({ state: "enqueued", operationId }), actorUserId,
    GENERATED_LICENSE_RETRY_NAMESPACE, keyHash, requestHash, operationId,
  ).run();
  if (enqueued.meta.changes !== 1) {
    const current = await input.env.PLATFORM_DB.prepare(`
      SELECT response_json AS responseJson
      FROM idempotency_records
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND request_hash = ?
      LIMIT 1
    `).bind(actorUserId, GENERATED_LICENSE_RETRY_NAMESPACE, keyHash, requestHash)
      .first<{ responseJson: string }>();
    if (current !== null && parseGeneratedLicenseRetryState(current.responseJson) === "enqueued") {
      const refreshed = await findGeneratedLicenseDeadLetterById(input.env, id, shopId);
      if (refreshed === null) throw new AppError("generated_license_dead_letter_not_found", 404);
      return { deadLetter: mapGeneratedLicenseDeadLetter(refreshed), operationId, replayed: true };
    }
    throw new AppError("generated_license_dead_letter_conflict", 409);
  }
  const refreshed = await findGeneratedLicenseDeadLetterById(input.env, id, shopId);
  if (refreshed === null) throw new AppError("generated_license_dead_letter_not_found", 404);
  return { deadLetter: mapGeneratedLicenseDeadLetter(refreshed), operationId, replayed };
}

function parseGeneratedLicenseRetryState(value: string): "enqueued" | "enqueuing" | "pending" {
  try {
    const parsed = JSON.parse(value) as { state?: unknown };
    if (parsed.state === "pending" || parsed.state === "enqueuing" || parsed.state === "enqueued") return parsed.state;
  } catch {
    // Fail closed when an idempotency record has an unexpected shape.
  }
  throw new AppError("internal_error", 500);
}

function parseReplayState(value: string): "enqueued" | "enqueuing" | "pending" {
  try {
    const parsed = JSON.parse(value) as { state?: unknown };
    if (parsed.state === "pending" || parsed.state === "enqueuing" || parsed.state === "enqueued") return parsed.state;
  } catch {
    // Fail closed when an idempotency record has an unexpected shape.
  }
  throw new AppError("internal_error", 500);
}

/**
 * Audits and recovers a generic terminal outbox target before enqueueing a
 * reference-only message. Reusing the same Idempotency-Key resumes an enqueue
 * interrupted after D1 committed without repeating the recovery transition.
 */
export async function requestGenericDeadLetterReplay(input: {
  actorUserId: string;
  env: AppBindings;
  expectedVersion: number;
  id: string;
  idempotencyKey: string;
  now?: Date;
  requestId: string;
  shopId: string;
}): Promise<{ deadLetter: DeadLetterView; operationId: string; replayed: boolean }> {
  const actorUserId = safeOperationsReference(input.actorUserId, "actor_user_id_invalid");
  const id = safeOperationsReference(input.id, "dead_letter_id_invalid");
  const shopId = safeOperationsReference(input.shopId, "shop_id_invalid");
  const requestId = safeOperationsReference(input.requestId, "request_id_invalid");
  const expectedVersion = safeExpectedVersion(input.expectedVersion);
  if (!REPLAY_KEY.test(input.idempotencyKey)) {
    throw new AppError("operations_validation_failed", 400, ["idempotency_key_invalid"]);
  }
  await requireReplayOperator(input.env, actorUserId);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "idempotency", input.idempotencyKey);
  const requestHash = await sha256Json({ deadLetterId: id, expectedVersion, shopId });
  const operationId = `dlr_${(await hmacToken(
    input.env.SESSION_SECRET,
    REPLAY_NAMESPACE,
    `${actorUserId}:${input.idempotencyKey}`,
  )).slice(0, 48)}`;
  const deadLetter = requireDeadLetter(await findDeadLetterById(input.env, id, shopId));
  const stored = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash AS requestHash, response_json AS responseJson
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
    LIMIT 1
  `).bind(actorUserId, REPLAY_NAMESPACE, keyHash, nowIso)
    .first<{ requestHash: string; responseJson: string }>();
  if (stored !== null && stored.requestHash !== requestHash) {
    throw new AppError("idempotency_conflict", 409);
  }
  const link = await input.env.PLATFORM_DB.prepare(`
    SELECT target_kind AS targetKind, domain_event_id AS domainEventId,
      delivery_job_id AS deliveryJobId, replay_status AS replayStatus,
      replay_request_id AS replayRequestId
    FROM queue_dead_letter_outbox_links
    WHERE dead_letter_id = ? AND shop_id = ? LIMIT 1
  `).bind(id, shopId).first<ReplayLink>();
  if (link === null) throw new AppError("dead_letter_replay_target_missing", 409);
  const targetId = link.targetKind === "domain_event" ? link.domainEventId : link.deliveryJobId;
  if (targetId === null || deadLetter.referenceType !== "outbox_job" || deadLetter.referenceId !== targetId) {
    throw new AppError("dead_letter_replay_target_invalid", 409);
  }
  let queueKind: "integration" | "notification" = "integration";
  let targetVersion: number;
  let targetStatus: string;
  if (link.targetKind === "domain_event") {
    const target = await input.env.PLATFORM_DB.prepare(`
      SELECT status, version FROM domain_events WHERE shop_id = ? AND id = ? LIMIT 1
    `).bind(shopId, targetId).first<{ status: string; version: number }>();
    if (target === null) throw new AppError("dead_letter_replay_target_invalid", 409);
    ({ status: targetStatus, version: targetVersion } = target);
  } else {
    const target = await input.env.PLATFORM_DB.prepare(`
      SELECT status, version, queue_kind AS queueKind
      FROM delivery_jobs WHERE shop_id = ? AND id = ? LIMIT 1
    `).bind(shopId, targetId).first<{ queueKind: "integration" | "notification"; status: string; version: number }>();
    if (target === null || target.queueKind !== deadLetter.queueName) {
      throw new AppError("dead_letter_replay_target_invalid", 409);
    }
    ({ queueKind, status: targetStatus, version: targetVersion } = target);
  }

  let replayed = stored !== null;
  let state = stored === null ? null : parseReplayState(stored.responseJson);
  if (stored === null) {
    const eligibleTarget = link.targetKind === "domain_event"
      ? new Set(["failed"])
      : new Set(["dead_letter", "failed"]);
    if (!new Set(["idle", "failed", "completed"]).has(link.replayStatus)
      || deadLetter.status === "resolved" || !eligibleTarget.has(targetStatus)) {
      throw new AppError("dead_letter_conflict", 409);
    }
    const targetStatement = link.targetKind === "domain_event"
      ? input.env.PLATFORM_DB.prepare(`
        UPDATE domain_events SET status = 'retryable', next_attempt_at = ?,
          lease_token = NULL, lease_expires_at = NULL, last_safe_error_code = NULL,
          version = version + 1, updated_at = ?
        WHERE shop_id = ? AND id = ? AND status = 'failed' AND version = ?
      `).bind(nowIso, nowIso, shopId, targetId, targetVersion)
      : input.env.PLATFORM_DB.prepare(`
        UPDATE delivery_jobs SET status = 'retryable', next_attempt_at = ?,
          lease_token = NULL, lease_expires_at = NULL, dead_lettered_at = NULL,
          last_safe_error_code = NULL, version = version + 1, updated_at = ?
        WHERE shop_id = ? AND id = ? AND status IN ('failed', 'dead_letter') AND version = ?
      `).bind(nowIso, nowIso, shopId, targetId, targetVersion);
    const statements = [
      input.env.PLATFORM_DB.prepare(`
        UPDATE queue_dead_letters SET status = 'retry_requested',
          retry_requested_by_user_id = ?, retry_requested_at = ?,
          retry_count = retry_count + 1, version = version + 1, updated_at = ?
        WHERE id = ? AND shop_id = ? AND status IN ('open', 'acknowledged')
          AND version = ? AND reference_type = 'outbox_job' AND reference_id = ?
      `).bind(actorUserId, nowIso, nowIso, id, shopId, expectedVersion, targetId),
      input.env.PLATFORM_DB.prepare(`
        UPDATE queue_dead_letter_outbox_links SET replay_status = 'requested',
          replay_request_id = ?, replay_requested_by_user_id = ?, replay_requested_at = ?,
          replay_enqueued_at = NULL, replay_finished_at = NULL,
          last_safe_error_code = NULL, replay_count = replay_count + 1,
          version = version + 1, updated_at = ?
        WHERE dead_letter_id = ? AND shop_id = ? AND target_kind = ?
          AND replay_status IN ('idle', 'failed', 'completed')
      `).bind(operationId, actorUserId, nowIso, nowIso, id, shopId, link.targetKind),
      targetStatement,
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
          safe_metadata_json, request_id, created_at, source_kind,
          correlation_id, operation_id, retention_class
        ) VALUES (?, ?, 'platform_admin', ?, 'operations.dead_letter_replay_requested',
          'queue_dead_letter', ?, ?, ?, ?, 'http', ?, ?, 'security')
      `).bind(createId("aud"), shopId, actorUserId, id,
        JSON.stringify({ operationId, targetId, targetKind: link.targetKind }),
        requestId, nowIso, requestId, operationId),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO idempotency_records (
          actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(actorUserId, REPLAY_NAMESPACE, keyHash, requestHash,
        JSON.stringify({ state: "pending", operationId }), nowIso,
        new Date(now.getTime() + 24 * 60 * 60_000).toISOString()),
    ];
    try {
      const results = await input.env.PLATFORM_DB.batch(statements);
      if (results.some((result) => result.meta.changes !== 1)) {
        throw new AppError("dead_letter_conflict", 409);
      }
    } catch (error) {
      const raced = await input.env.PLATFORM_DB.prepare(`
        SELECT request_hash AS requestHash, response_json AS responseJson
        FROM idempotency_records
        WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? LIMIT 1
      `).bind(actorUserId, REPLAY_NAMESPACE, keyHash).first<{ requestHash: string; responseJson: string }>();
      if (raced === null) throw error;
      if (raced.requestHash !== requestHash) throw new AppError("idempotency_conflict", 409);
      replayed = true;
      state = parseReplayState(raced.responseJson);
    }
  }
  if (state === "enqueued") {
    return { deadLetter: mapDeadLetter(deadLetter), operationId, replayed: true };
  }

  const ownership = await input.env.PLATFORM_DB.prepare(`
    SELECT replay_status AS replayStatus, replay_request_id AS replayRequestId
    FROM queue_dead_letter_outbox_links
    WHERE dead_letter_id = ? AND shop_id = ? LIMIT 1
  `).bind(id, shopId).first<{ replayRequestId: string | null; replayStatus: string }>();
  if (ownership?.replayStatus !== "requested" || ownership.replayRequestId !== operationId) {
    throw new AppError("dead_letter_conflict", 409);
  }
  if (state === "enqueuing") throw new AppError("dead_letter_replay_enqueue_in_progress", 409);

  const claimed = await input.env.PLATFORM_DB.prepare(`
    UPDATE idempotency_records SET response_json = ?
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND request_hash = ?
      AND json_extract(response_json, '$.state') = 'pending'
      AND json_extract(response_json, '$.operationId') = ?
  `).bind(
    JSON.stringify({ state: "enqueuing", operationId }), actorUserId,
    REPLAY_NAMESPACE, keyHash, requestHash, operationId,
  ).run();
  if (claimed.meta.changes !== 1) {
    const current = await input.env.PLATFORM_DB.prepare(`
      SELECT response_json AS responseJson
      FROM idempotency_records
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND request_hash = ?
      LIMIT 1
    `).bind(actorUserId, REPLAY_NAMESPACE, keyHash, requestHash).first<{ responseJson: string }>();
    if (current !== null && parseReplayState(current.responseJson) === "enqueued") {
      return { deadLetter: mapDeadLetter(deadLetter), operationId, replayed: true };
    }
    if (current !== null && parseReplayState(current.responseJson) === "enqueuing") {
      throw new AppError("dead_letter_replay_enqueue_in_progress", 409);
    }
    throw new AppError("dead_letter_conflict", 409);
  }

  const queue = queueKind === "integration" ? input.env.INTEGRATION_QUEUE : input.env.NOTIFICATION_QUEUE;
  try {
    await queue.send({
      kind: queueKind,
      operationId: link.targetKind === "domain_event" ? "domain_event_dispatch" : "channel_delivery",
      referenceId: targetId,
      referenceType: "outbox_job",
      requestId,
      shopId,
      sourceQueue: queueKind,
      version: 1,
    });
  } catch {
    await input.env.PLATFORM_DB.prepare(`
      UPDATE idempotency_records SET response_json = ?
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND request_hash = ?
        AND json_extract(response_json, '$.state') = 'enqueuing'
        AND json_extract(response_json, '$.operationId') = ?
    `).bind(
      JSON.stringify({ state: "pending", operationId }), actorUserId,
      REPLAY_NAMESPACE, keyHash, requestHash, operationId,
    ).run();
    throw new AppError("dead_letter_replay_enqueue_failed", 503);
  }
  const enqueued = await input.env.PLATFORM_DB.prepare(`
    UPDATE queue_dead_letter_outbox_links
    SET replay_status = 'enqueued', replay_enqueued_at = ?,
      version = version + 1, updated_at = ?
    WHERE dead_letter_id = ? AND shop_id = ? AND replay_status = 'requested'
      AND replay_request_id = ?
  `).bind(nowIso, nowIso, id, shopId, operationId).run();
  if (enqueued.meta.changes !== 1) {
    const current = await input.env.PLATFORM_DB.prepare(`
      SELECT replay_status AS replayStatus, replay_request_id AS replayRequestId
      FROM queue_dead_letter_outbox_links WHERE dead_letter_id = ? AND shop_id = ?
    `).bind(id, shopId).first<{ replayRequestId: string | null; replayStatus: string }>();
    if (current?.replayStatus !== "enqueued" || current.replayRequestId !== operationId) {
      throw new AppError("dead_letter_conflict", 409);
    }
  }
  const completed = await input.env.PLATFORM_DB.prepare(`
    UPDATE idempotency_records SET response_json = ?
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND request_hash = ?
      AND json_extract(response_json, '$.state') = 'enqueuing'
      AND json_extract(response_json, '$.operationId') = ?
  `).bind(JSON.stringify({ state: "enqueued", operationId }), actorUserId,
    REPLAY_NAMESPACE, keyHash, requestHash, operationId).run();
  if (completed.meta.changes !== 1) {
    const current = await input.env.PLATFORM_DB.prepare(`
      SELECT response_json AS responseJson
      FROM idempotency_records
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND request_hash = ?
      LIMIT 1
    `).bind(actorUserId, REPLAY_NAMESPACE, keyHash, requestHash).first<{ responseJson: string }>();
    if (current === null || parseReplayState(current.responseJson) !== "enqueued") {
      throw new AppError("dead_letter_conflict", 409);
    }
  }
  return {
    deadLetter: mapDeadLetter(requireDeadLetter(await findDeadLetterById(input.env, id, shopId))),
    operationId,
    replayed,
  };
}
