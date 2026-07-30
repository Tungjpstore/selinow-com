import { createId, createOpaqueToken } from "../core/ids";
import { AppError } from "../core/errors";
import {
  assertAutomationAccessContext,
  assertAutomationEvidenceToken,
  assertAutomationReference,
  assertAutomationTaskId,
  assertAutomationTaskStartInput,
  assertAutomationTransitionEvidence,
  initialTaskStatus,
  isRetryDue,
  nextRetryAt,
} from "./policy";
import { defaultAutomationCapabilityRegistry } from "./registry";
import type { AutomationCapabilityRegistry } from "./registry";
import type {
  AutomationAccessContext,
  AutomationCapabilityDefinition,
  AutomationContinuation,
  AutomationContinuationEvidenceResolver,
  AutomationExecutionResult,
  AutomationExecutor,
  AutomationOrchestrator,
  AutomationTask,
  AutomationTaskRepository,
  AutomationTaskStartInput,
  AutomationTaskTransitionEvidence,
} from "./types";

export type AutomationOrchestratorOptions = {
  executors: ReadonlyMap<string, AutomationExecutor>;
  leaseDurationMs?: number;
  leaseTokenFactory?: () => string;
  now?: () => Date;
  resolveContinuationEvidence?: AutomationContinuationEvidenceResolver;
  registry?: AutomationCapabilityRegistry;
  repository: AutomationTaskRepository;
  taskIdFactory?: () => string;
};

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled"]);
const DEFAULT_LEASE_DURATION_MS = 90_000;

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function taskError(code: string, status: number): AppError {
  return new AppError(code, status);
}

function assertReplayMatches(existing: AutomationTask, input: AutomationTaskStartInput): AutomationTask {
  if (existing.requestHash !== input.requestHash) throw taskError("idempotency_conflict", 409);
  return existing;
}

function isTerminal(task: AutomationTask): boolean {
  return TERMINAL_STATUSES.has(task.status);
}

function assertTenant(context: AutomationAccessContext, shopId: string): void {
  if (context.shopId !== shopId) throw taskError("automation_tenant_mismatch", 403);
}

function transitionFor(
  context: AutomationAccessContext,
  metadata: Omit<AutomationTaskTransitionEvidence, "actorId" | "actorRole"> = {},
): AutomationTaskTransitionEvidence {
  const transition = { actorId: context.actorId, actorRole: context.actorRole, ...metadata };
  assertAutomationTransitionEvidence(transition);
  return transition;
}

export function createAutomationOrchestrator(options: AutomationOrchestratorOptions): AutomationOrchestrator {
  const registry = options.registry ?? defaultAutomationCapabilityRegistry;
  const now = options.now ?? (() => new Date());
  const taskIdFactory = options.taskIdFactory ?? (() => createId("aut"));
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const leaseTokenFactory = options.leaseTokenFactory ?? (() => createOpaqueToken(18));

  async function getTask(context: AutomationAccessContext, taskId: string): Promise<AutomationTask> {
    assertAutomationTaskId(taskId);
    const task = await options.repository.get({ shopId: context.shopId, taskId });
    if (task === null) throw taskError("automation_task_not_found", 404);
    // A repository must enforce this too; keeping the check here protects in-memory adapters.
    assertTenant(context, task.shopId);
    return task;
  }

  async function createTask(context: AutomationAccessContext, input: AutomationTaskStartInput, definition: AutomationCapabilityDefinition): Promise<{ created: boolean; task: AutomationTask }> {
    const timestamp = nowIso(now);
    const task: AutomationTask = {
      actionReference: input.actionReference ?? null,
      attemptCount: 0,
      auditLogId: null,
      capabilityCode: definition.code,
      consentEvidenceReference: null,
      createdAt: timestamp,
      id: taskIdFactory(),
      inputReference: input.inputReference,
      idempotencyKeyHash: input.idempotencyKeyHash,
      lastSafeErrorCode: definition.level === "unsupported" ? "automation_unsupported" : null,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: null,
      requestHash: input.requestHash,
      shopId: input.shopId,
      status: initialTaskStatus(definition.level),
      updatedAt: timestamp,
      version: 1,
    };
    return options.repository.create({
      task,
      transition: transitionFor(context, {
        ...(input.actionReference === undefined ? {} : { actionReference: input.actionReference }),
        safeCode: definition.level === "unsupported" ? "automation_unsupported" : "automation_task_created",
      }),
    });
  }

  async function claimExecution(
    context: AutomationAccessContext,
    task: AutomationTask,
    metadata: Omit<AutomationTaskTransitionEvidence, "actorId" | "actorRole"> = {},
  ): Promise<AutomationTask | null> {
    assertTenant(context, task.shopId);
    const currentTime = now();
    return options.repository.claimDue({
      expectedVersion: task.version,
      leaseExpiresAt: new Date(currentTime.getTime() + leaseDurationMs).toISOString(),
      leaseToken: leaseTokenFactory(),
      now: currentTime.toISOString(),
      shopId: context.shopId,
      taskId: task.id,
      transition: transitionFor(context, { ...metadata, safeCode: "automation_execution_claimed" }),
    });
  }

  async function settleExecution(context: AutomationAccessContext, task: AutomationTask, definition: AutomationCapabilityDefinition, result: AutomationExecutionResult): Promise<AutomationTask> {
    const timestamp = nowIso(now);
    const nextStatus = result.outcome === "completed"
      ? "succeeded"
      : result.outcome === "failed" || task.attemptCount >= definition.retryPolicy.maxAttempts
        ? "failed"
        : "retryable";
    const safeErrorCode = result.outcome === "completed" ? null : result.safeErrorCode;
    const nextAttempt = nextStatus === "retryable" && result.outcome === "retry"
      ? nextRetryAt({ attemptCount: task.attemptCount, now: now(), policy: definition.retryPolicy, ...(result.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: result.retryAfterSeconds }) })
      : null;
    const settled: AutomationTask = {
      ...task,
      lastSafeErrorCode: safeErrorCode,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: nextAttempt,
      status: nextStatus,
      updatedAt: timestamp,
      version: task.version + 1,
    };
    const persisted = await options.repository.update({
      expectedVersion: task.version,
      shopId: context.shopId,
      task: settled,
      transition: transitionFor(context, { safeCode: safeErrorCode ?? "automation_succeeded" }),
    });
    if (persisted !== null) return persisted;
    return getTask(context, task.id);
  }

  async function execute(
    context: AutomationAccessContext,
    task: AutomationTask,
    metadata: Omit<AutomationTaskTransitionEvidence, "actorId" | "actorRole"> = {},
  ): Promise<AutomationTask> {
    if (isTerminal(task)) return task;
    const definition = registry.require(task.capabilityCode);
    if (task.attemptCount >= definition.retryPolicy.maxAttempts) {
      return settleExecution(context, task, definition, { outcome: "failed", safeErrorCode: task.lastSafeErrorCode ?? "automation_retry_exhausted" });
    }
    const running = await claimExecution(context, task, metadata);
    if (running === null) return getTask(context, task.id);
    const executor = options.executors.get(task.capabilityCode);
    if (executor === undefined) {
      return settleExecution(context, running, definition, { outcome: "retry", safeErrorCode: "automation_executor_missing" });
    }
    let result: AutomationExecutionResult;
    try {
      result = await executor({
        attemptCount: running.attemptCount,
        capabilityCode: running.capabilityCode,
        inputReference: running.inputReference,
        shopId: running.shopId,
        taskId: running.id,
      });
    } catch {
      result = { outcome: "retry", safeErrorCode: "automation_executor_failed" };
    }
    return settleExecution(context, running, definition, result);
  }

  async function start(context: AutomationAccessContext, input: AutomationTaskStartInput): Promise<AutomationTask> {
    assertAutomationAccessContext(context);
    assertAutomationTaskStartInput(input);
    assertTenant(context, input.shopId);
    const definition = registry.require(input.capabilityCode);
    const existing = await options.repository.findByIdempotency({ idempotencyKeyHash: input.idempotencyKeyHash, shopId: context.shopId });
    if (existing !== null) return assertReplayMatches(existing, input);
    const created = await createTask(context, input, definition);
    const task = created.created ? created.task : assertReplayMatches(created.task, input);
    return created.created && task.status === "pending" ? execute(context, task) : task;
  }

  async function cancelTask(
    context: AutomationAccessContext,
    taskId: string,
    expectedVersion: number,
    safeCode = "automation_canceled_by_user",
    actionReference?: string,
  ): Promise<AutomationTask> {
    assertAutomationAccessContext(context);
    const transition = transitionFor(context, {
      ...(actionReference === undefined ? {} : { actionReference }),
      safeCode,
    });
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw taskError("automation_expected_version_invalid", 400);
    }
    const task = await getTask(context, taskId);
    if (task.version !== expectedVersion) throw taskError("automation_version_conflict", 409);
    if (isTerminal(task)) return task;
    if (task.status === "running" && task.leaseExpiresAt !== null && task.leaseExpiresAt > nowIso(now)) {
      throw taskError("automation_cancel_conflict", 409);
    }
    const timestamp = nowIso(now);
    const canceled: AutomationTask = {
      ...task,
      lastSafeErrorCode: safeCode,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: null,
      status: "canceled",
      updatedAt: timestamp,
      version: task.version + 1,
    };
    const persisted = await options.repository.update({
      expectedVersion: task.version,
      shopId: context.shopId,
      task: canceled,
      transition,
    });
    if (persisted !== null) return persisted;
    const current = await getTask(context, task.id);
    if (current.status === "canceled") return current;
    throw taskError("automation_version_conflict", 409);
  }

  async function continueTask(context: AutomationAccessContext, taskId: string, continuation: AutomationContinuation, expectedVersion?: number): Promise<AutomationTask> {
    assertAutomationAccessContext(context);
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw taskError("automation_expected_version_invalid", 400);
    }
    const task = await getTask(context, taskId);
    if (expectedVersion !== undefined && task.version !== expectedVersion) {
      throw taskError("automation_version_conflict", 409);
    }
    if (isTerminal(task)) return task;
    if (task.status === "running") {
      if (task.leaseExpiresAt !== null && task.leaseExpiresAt > nowIso(now)) return task;
      return execute(context, task);
    }
    if (continuation.kind === "approval_granted") {
      if (task.status !== "waiting_user") throw taskError("automation_continuation_invalid", 409);
      assertAutomationEvidenceToken(continuation.evidenceToken);
      if (options.resolveContinuationEvidence === undefined) throw taskError("automation_evidence_verifier_missing", 503);
      const evidenceReference = await options.resolveContinuationEvidence({ context, evidenceToken: continuation.evidenceToken, kind: continuation.kind, task });
      if (evidenceReference === null) throw taskError("automation_evidence_invalid", 403);
      assertAutomationReference(evidenceReference);
      return execute(context, task, { evidenceReference });
    }
    if (continuation.kind === "external_action_completed") {
      if (task.status !== "waiting_provider") throw taskError("automation_continuation_invalid", 409);
      assertAutomationEvidenceToken(continuation.evidenceToken);
      if (options.resolveContinuationEvidence === undefined) throw taskError("automation_evidence_verifier_missing", 503);
      const evidenceReference = await options.resolveContinuationEvidence({ context, evidenceToken: continuation.evidenceToken, kind: continuation.kind, task });
      if (evidenceReference === null) throw taskError("automation_evidence_invalid", 403);
      assertAutomationReference(evidenceReference);
      return execute(context, task, { evidenceReference });
    }
    if (task.status === "pending") return execute(context, task);
    if (!isRetryDue(task.status, task.nextAttemptAt, now())) throw taskError("automation_retry_not_due", 409);
    return execute(context, task);
  }

  return { cancelTask, continueTask, start };
}
