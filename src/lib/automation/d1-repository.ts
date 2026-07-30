import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import {
  assertAutomationReference,
  assertAutomationTaskId,
  assertAutomationTaskStartInput,
  assertAutomationTransitionEvidence,
} from "./policy";
import { AUTOMATION_TASK_STATUSES } from "./types";
import type {
  AutomationTask,
  AutomationTaskDueReference,
  AutomationTaskRepository,
  AutomationTaskStatus,
  AutomationTaskTransitionEvidence,
} from "./types";

const SAFE_CODE = /^[a-z][a-z0-9._:-]{2,95}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_LEASE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/u;
const MAX_DUE_TASKS = 100;

type TaskRow = AutomationTask;

const TASK_SELECT = `
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
`;

const CLAIMABLE_PREDICATE = `
  (
    status = 'pending'
    OR (status IN ('waiting_user', 'waiting_provider') AND ? IS NOT NULL)
    OR (status = 'retryable' AND next_attempt_at <= ?)
    OR (status = 'running' AND lease_expires_at <= ?)
  )
`;

function validationError(issue: string): AppError {
  return new AppError("automation_repository_validation_failed", 400, [issue]);
}

function assertIdentifier(value: string, issue: string): void {
  if (!SAFE_IDENTIFIER.test(value)) throw validationError(issue);
}

function assertIsoTimestamp(value: string, issue: string): void {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw validationError(issue);
  }
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DUE_TASKS) {
    throw validationError("limit_invalid");
  }
}

function assertTaskStatus(value: string): asserts value is AutomationTaskStatus {
  if (!AUTOMATION_TASK_STATUSES.includes(value as AutomationTaskStatus)) {
    throw validationError("status_invalid");
  }
}

function assertOptionalReference(value: string | null, issue: string): void {
  if (value === null) return;
  try {
    assertAutomationReference(value);
  } catch {
    throw validationError(issue);
  }
}

function assertTask(task: AutomationTask): void {
  try {
    assertAutomationTaskId(task.id);
    assertAutomationTaskStartInput({
      ...(task.actionReference === null ? {} : { actionReference: task.actionReference }),
      capabilityCode: task.capabilityCode,
      idempotencyKeyHash: task.idempotencyKeyHash,
      inputReference: task.inputReference,
      requestHash: task.requestHash,
      shopId: task.shopId,
    });
  } catch (error) {
    if (error instanceof AppError) throw validationError(error.code);
    throw error;
  }
  assertTaskStatus(task.status);
  if (!Number.isSafeInteger(task.attemptCount) || task.attemptCount < 0) {
    throw validationError("attempt_count_invalid");
  }
  if (!Number.isSafeInteger(task.version) || task.version < 1) {
    throw validationError("version_invalid");
  }
  assertIsoTimestamp(task.createdAt, "created_at_invalid");
  assertIsoTimestamp(task.updatedAt, "updated_at_invalid");
  if (task.nextAttemptAt !== null) assertIsoTimestamp(task.nextAttemptAt, "next_attempt_at_invalid");
  if (task.leaseExpiresAt !== null) assertIsoTimestamp(task.leaseExpiresAt, "lease_expires_at_invalid");
  if (task.leaseToken !== null && !SAFE_LEASE_TOKEN.test(task.leaseToken)) {
    throw validationError("lease_token_invalid");
  }
  if (task.lastSafeErrorCode !== null && !SAFE_CODE.test(task.lastSafeErrorCode)) {
    throw validationError("safe_error_code_invalid");
  }
  if (task.auditLogId !== null) assertIdentifier(task.auditLogId, "audit_log_id_invalid");
  assertOptionalReference(task.consentEvidenceReference, "consent_evidence_reference_invalid");
  assertOptionalReference(task.actionReference, "action_reference_invalid");
  const hasLease = task.leaseToken !== null && task.leaseExpiresAt !== null;
  if ((task.status === "running") !== hasLease
    || (task.leaseToken === null) !== (task.leaseExpiresAt === null)) {
    throw validationError("lease_state_invalid");
  }
  if ((task.status === "retryable") !== (task.nextAttemptAt !== null)) {
    throw validationError("retry_state_invalid");
  }
}

function assertTransition(transition: AutomationTaskTransitionEvidence): void {
  try {
    assertAutomationTransitionEvidence(transition);
  } catch (error) {
    if (error instanceof AppError) throw validationError(error.code);
    throw error;
  }
}

function changes(result: D1Result | undefined): number {
  return result?.meta.changes ?? 0;
}

function transitionValues(transition: AutomationTaskTransitionEvidence): {
  actionReference: string | null;
  evidenceReference: string | null;
  safeCode: string | null;
} {
  return {
    actionReference: transition.actionReference ?? null,
    evidenceReference: transition.evidenceReference ?? null,
    safeCode: transition.safeCode ?? null,
  };
}

export class D1AutomationTaskRepository implements AutomationTaskRepository {
  constructor(private readonly database: D1Database) {}

  async create(input: {
    task: AutomationTask;
    transition: AutomationTaskTransitionEvidence;
  }): Promise<{ created: boolean; task: AutomationTask }> {
    assertTask(input.task);
    assertTransition(input.transition);
    if (input.task.version !== 1) throw validationError("create_version_invalid");
    const eventId = createId("aev");
    const transition = transitionValues(input.transition);
    const actionReference = transition.actionReference ?? input.task.actionReference;
    const evidenceReference = transition.evidenceReference ?? input.task.consentEvidenceReference;
    const [insertResult] = await this.database.batch([
      this.database.prepare(`
        INSERT INTO automation_tasks (
          id, shop_id, capability_code, status, idempotency_key_hash,
          request_hash, input_reference, attempt_count, next_attempt_at,
          lease_token, lease_expires_at, last_safe_error_code, audit_log_id,
          consent_evidence_reference, action_reference, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(shop_id, idempotency_key_hash) DO NOTHING
      `).bind(
        input.task.id,
        input.task.shopId,
        input.task.capabilityCode,
        input.task.status,
        input.task.idempotencyKeyHash,
        input.task.requestHash,
        input.task.inputReference,
        input.task.attemptCount,
        input.task.nextAttemptAt,
        input.task.leaseToken,
        input.task.leaseExpiresAt,
        input.task.lastSafeErrorCode,
        input.task.auditLogId,
        evidenceReference,
        actionReference,
        input.task.version,
        input.task.createdAt,
        input.task.updatedAt,
      ),
      this.database.prepare(`
        INSERT INTO automation_task_events (
          id, task_id, shop_id, from_status, to_status, actor_role, actor_id,
          audit_log_id, safe_code, evidence_reference, action_reference,
          task_version, created_at
        )
        SELECT ?, id, shop_id, NULL, status, ?, ?, audit_log_id, ?, ?, ?, version, ?
        FROM automation_tasks
        WHERE id = ? AND shop_id = ? AND version = 1
          AND NOT EXISTS (
            SELECT 1 FROM automation_task_events
            WHERE task_id = automation_tasks.id AND task_version = 1
          )
      `).bind(
        eventId,
        input.transition.actorRole,
        input.transition.actorId,
        transition.safeCode,
        transition.evidenceReference,
        transition.actionReference,
        input.task.createdAt,
        input.task.id,
        input.task.shopId,
      ),
    ]);
    const created = changes(insertResult) === 1;
    const task = created
      ? await this.get({ shopId: input.task.shopId, taskId: input.task.id })
      : await this.findByIdempotency({
        idempotencyKeyHash: input.task.idempotencyKeyHash,
        shopId: input.task.shopId,
      });
    if (task === null) throw new AppError("automation_task_create_conflict", 409);
    return { created, task };
  }

  findByIdempotency(input: {
    idempotencyKeyHash: string;
    shopId: string;
  }): Promise<AutomationTask | null> {
    try {
      assertAutomationTaskStartInput({
        capabilityCode: "validation.lookup",
        idempotencyKeyHash: input.idempotencyKeyHash,
        inputReference: "d1:validation/reference",
        requestHash: input.idempotencyKeyHash,
        shopId: input.shopId,
      });
    } catch (error) {
      if (error instanceof AppError) throw validationError(error.code);
      throw error;
    }
    return this.database.prepare(`${TASK_SELECT}
      WHERE shop_id = ? AND idempotency_key_hash = ?
      LIMIT 1
    `).bind(input.shopId, input.idempotencyKeyHash).first<TaskRow>();
  }

  get(input: { shopId: string; taskId: string }): Promise<AutomationTask | null> {
    assertIdentifier(input.shopId, "shop_id_invalid");
    try {
      assertAutomationTaskId(input.taskId);
    } catch {
      throw validationError("task_id_invalid");
    }
    return this.database.prepare(`${TASK_SELECT}
      WHERE shop_id = ? AND id = ? LIMIT 1
    `).bind(input.shopId, input.taskId).first<TaskRow>();
  }

  async update(input: {
    expectedVersion: number;
    shopId: string;
    task: AutomationTask;
    transition: AutomationTaskTransitionEvidence;
  }): Promise<AutomationTask | null> {
    assertTask(input.task);
    assertTransition(input.transition);
    assertIdentifier(input.shopId, "shop_id_invalid");
    if (input.shopId !== input.task.shopId) throw new AppError("automation_tenant_mismatch", 403);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || input.task.version !== input.expectedVersion + 1) {
      throw validationError("expected_version_invalid");
    }
    const eventId = createId("aev");
    const transition = transitionValues(input.transition);
    const actionReference = transition.actionReference ?? input.task.actionReference;
    const evidenceReference = transition.evidenceReference ?? input.task.consentEvidenceReference;
    const [, updateResult] = await this.database.batch([
      this.database.prepare(`
        INSERT INTO automation_task_events (
          id, task_id, shop_id, from_status, to_status, actor_role, actor_id,
          audit_log_id, safe_code, evidence_reference, action_reference,
          task_version, created_at
        )
        SELECT ?, id, shop_id, status, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM automation_tasks
        WHERE id = ? AND shop_id = ? AND version = ?
          AND NOT EXISTS (
            SELECT 1 FROM automation_task_events
            WHERE task_id = automation_tasks.id AND task_version = ?
          )
      `).bind(
        eventId,
        input.task.status,
        input.transition.actorRole,
        input.transition.actorId,
        input.task.auditLogId,
        transition.safeCode,
        transition.evidenceReference,
        transition.actionReference,
        input.task.version,
        input.task.updatedAt,
        input.task.id,
        input.shopId,
        input.expectedVersion,
        input.task.version,
      ),
      this.database.prepare(`
        UPDATE automation_tasks
        SET status = ?, attempt_count = ?, next_attempt_at = ?, lease_token = ?,
          lease_expires_at = ?, last_safe_error_code = ?, audit_log_id = ?,
          consent_evidence_reference = ?, action_reference = ?, version = ?,
          updated_at = ?
        WHERE id = ? AND shop_id = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM automation_task_events
            WHERE id = ? AND task_id = automation_tasks.id AND task_version = ?
          )
      `).bind(
        input.task.status,
        input.task.attemptCount,
        input.task.nextAttemptAt,
        input.task.leaseToken,
        input.task.leaseExpiresAt,
        input.task.lastSafeErrorCode,
        input.task.auditLogId,
        evidenceReference,
        actionReference,
        input.task.version,
        input.task.updatedAt,
        input.task.id,
        input.shopId,
        input.expectedVersion,
        eventId,
        input.task.version,
      ),
    ]);
    if (changes(updateResult) !== 1) return null;
    return this.get({ shopId: input.shopId, taskId: input.task.id });
  }

  async claimDue(input: {
    expectedVersion: number;
    leaseExpiresAt: string;
    leaseToken: string;
    now: string;
    shopId: string;
    taskId: string;
    transition: AutomationTaskTransitionEvidence;
  }): Promise<AutomationTask | null> {
    assertIdentifier(input.shopId, "shop_id_invalid");
    try {
      assertAutomationTaskId(input.taskId);
    } catch {
      throw validationError("task_id_invalid");
    }
    assertTransition(input.transition);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw validationError("expected_version_invalid");
    }
    assertIsoTimestamp(input.now, "now_invalid");
    assertIsoTimestamp(input.leaseExpiresAt, "lease_expires_at_invalid");
    if (input.leaseExpiresAt <= input.now) throw validationError("lease_expiry_invalid");
    if (!SAFE_LEASE_TOKEN.test(input.leaseToken)) throw validationError("lease_token_invalid");
    const eventId = createId("aev");
    const transition = transitionValues(input.transition);
    const [, updateResult] = await this.database.batch([
      this.database.prepare(`
        INSERT INTO automation_task_events (
          id, task_id, shop_id, from_status, to_status, actor_role, actor_id,
          audit_log_id, safe_code, evidence_reference, action_reference,
          task_version, created_at
        )
        SELECT ?, id, shop_id, status, 'running', ?, ?, audit_log_id, ?, ?, ?, version + 1, ?
        FROM automation_tasks
        WHERE id = ? AND shop_id = ? AND version = ?
          AND ${CLAIMABLE_PREDICATE}
          AND NOT EXISTS (
            SELECT 1 FROM automation_task_events
            WHERE task_id = automation_tasks.id AND task_version = automation_tasks.version + 1
          )
      `).bind(
        eventId,
        input.transition.actorRole,
        input.transition.actorId,
        transition.safeCode,
        transition.evidenceReference,
        transition.actionReference,
        input.now,
        input.taskId,
        input.shopId,
        input.expectedVersion,
        transition.evidenceReference,
        input.now,
        input.now,
      ),
      this.database.prepare(`
        UPDATE automation_tasks
        SET status = 'running', attempt_count = attempt_count + 1,
          next_attempt_at = NULL, lease_token = ?, lease_expires_at = ?,
          last_safe_error_code = NULL,
          consent_evidence_reference = COALESCE(?, consent_evidence_reference),
          action_reference = COALESCE(?, action_reference),
          version = version + 1, updated_at = ?
        WHERE id = ? AND shop_id = ? AND version = ?
          AND ${CLAIMABLE_PREDICATE}
          AND EXISTS (
            SELECT 1 FROM automation_task_events
            WHERE id = ? AND task_id = automation_tasks.id
              AND task_version = automation_tasks.version + 1
          )
      `).bind(
        input.leaseToken,
        input.leaseExpiresAt,
        transition.evidenceReference,
        transition.actionReference,
        input.now,
        input.taskId,
        input.shopId,
        input.expectedVersion,
        transition.evidenceReference,
        input.now,
        input.now,
        eventId,
      ),
    ]);
    if (changes(updateResult) !== 1) return null;
    return this.get({ shopId: input.shopId, taskId: input.taskId });
  }

  async listDue(input: { limit: number; now: string }): Promise<AutomationTaskDueReference[]> {
    assertLimit(input.limit);
    assertIsoTimestamp(input.now, "now_invalid");
    const result = await this.database.prepare(`
      SELECT id, shop_id AS shopId, status, version
      FROM automation_tasks
      WHERE status = 'pending'
        OR (status = 'retryable' AND next_attempt_at <= ?)
        OR (status = 'running' AND lease_expires_at <= ?)
      ORDER BY COALESCE(next_attempt_at, lease_expires_at, updated_at), id
      LIMIT ?
    `).bind(input.now, input.now, input.limit).all<AutomationTaskDueReference>();
    return result.results;
  }

  async recoverExpiredLeases(input: {
    limit: number;
    now: string;
    transition: AutomationTaskTransitionEvidence;
  }): Promise<AutomationTaskDueReference[]> {
    assertLimit(input.limit);
    assertIsoTimestamp(input.now, "now_invalid");
    assertTransition(input.transition);
    const candidates = await this.database.prepare(`
      SELECT id, shop_id AS shopId, status, version
      FROM automation_tasks
      WHERE status = 'running' AND lease_expires_at <= ?
      ORDER BY lease_expires_at, id
      LIMIT ?
    `).bind(input.now, input.limit).all<AutomationTaskDueReference>();
    const recovered: AutomationTaskDueReference[] = [];
    for (const candidate of candidates.results) {
      const reference = await this.recoverExpiredLease(candidate, input.now, input.transition);
      if (reference !== null) recovered.push(reference);
    }
    return recovered;
  }

  private async recoverExpiredLease(
    candidate: AutomationTaskDueReference,
    now: string,
    transitionInput: AutomationTaskTransitionEvidence,
  ): Promise<AutomationTaskDueReference | null> {
    const eventId = createId("aev");
    const transition = transitionValues(transitionInput);
    const safeCode = transition.safeCode ?? "automation_lease_expired";
    const [, updateResult] = await this.database.batch([
      this.database.prepare(`
        INSERT INTO automation_task_events (
          id, task_id, shop_id, from_status, to_status, actor_role, actor_id,
          audit_log_id, safe_code, evidence_reference, action_reference,
          task_version, created_at
        )
        SELECT ?, id, shop_id, status, 'retryable', ?, ?, audit_log_id, ?, ?, ?, version + 1, ?
        FROM automation_tasks
        WHERE id = ? AND shop_id = ? AND version = ?
          AND status = 'running' AND lease_expires_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM automation_task_events
            WHERE task_id = automation_tasks.id AND task_version = automation_tasks.version + 1
          )
      `).bind(
        eventId,
        transitionInput.actorRole,
        transitionInput.actorId,
        safeCode,
        transition.evidenceReference,
        transition.actionReference,
        now,
        candidate.id,
        candidate.shopId,
        candidate.version,
        now,
      ),
      this.database.prepare(`
        UPDATE automation_tasks
        SET status = 'retryable', next_attempt_at = ?, lease_token = NULL,
          lease_expires_at = NULL,
          last_safe_error_code = COALESCE(last_safe_error_code, ?),
          consent_evidence_reference = COALESCE(?, consent_evidence_reference),
          action_reference = COALESCE(?, action_reference),
          version = version + 1, updated_at = ?
        WHERE id = ? AND shop_id = ? AND version = ?
          AND status = 'running' AND lease_expires_at <= ?
          AND EXISTS (
            SELECT 1 FROM automation_task_events
            WHERE id = ? AND task_id = automation_tasks.id
              AND task_version = automation_tasks.version + 1
          )
      `).bind(
        now,
        safeCode,
        transition.evidenceReference,
        transition.actionReference,
        now,
        candidate.id,
        candidate.shopId,
        candidate.version,
        now,
        eventId,
      ),
    ]);
    if (changes(updateResult) !== 1) return null;
    return {
      id: candidate.id,
      shopId: candidate.shopId,
      status: "retryable",
      version: candidate.version + 1,
    };
  }
}

export function createD1AutomationTaskRepository(database: D1Database): AutomationTaskRepository {
  return new D1AutomationTaskRepository(database);
}
