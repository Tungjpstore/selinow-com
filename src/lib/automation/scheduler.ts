import { isAppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";
import { createD1AutomationTaskRepository } from "./d1-repository";
import { createAutomationExecutors } from "./executors";
import { createAutomationOrchestrator } from "./orchestrator";
import type { AutomationCapabilityRegistry } from "./registry";
import type {
  AutomationExecutor,
  AutomationTaskDueReference,
  AutomationTaskRepository,
  AutomationTaskStatus,
} from "./types";

const DEFAULT_BATCH_LIMIT = 25;

export type AutomationSchedulerMetrics = {
  attempted: number;
  canceled: number;
  candidates: number;
  errors: number;
  failed: number;
  missingExecutors: number;
  recovered: number;
  retryable: number;
  skipped: number;
  succeeded: number;
};

export type AutomationSchedulerOptions = {
  batchLimit?: number;
  executors: ReadonlyMap<string, AutomationExecutor>;
  leaseDurationMs?: number;
  leaseTokenFactory?: () => string;
  /** Fixed cutoff for selecting due rows; lease/settlement time uses `clock`. */
  dueAt?: Date;
  clock?: () => Date;
  registry?: AutomationCapabilityRegistry;
  repository: AutomationTaskRepository;
};

export type ScheduledAutomationOptions = Omit<AutomationSchedulerOptions, "dueAt" | "repository" | "executors"> & {
  executors?: ReadonlyMap<string, AutomationExecutor>;
};

function boundedBatchLimit(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 1
    ? Math.min(value, 100)
    : DEFAULT_BATCH_LIMIT;
}

function uniqueCandidates(
  recovered: readonly AutomationTaskDueReference[],
  due: readonly AutomationTaskDueReference[],
  limit: number,
): AutomationTaskDueReference[] {
  const references = new Map<string, AutomationTaskDueReference>();
  for (const reference of [...recovered, ...due]) {
    references.set(`${reference.shopId}\0${reference.id}`, reference);
    if (references.size >= limit) break;
  }
  return [...references.values()];
}

function countStatus(metrics: AutomationSchedulerMetrics, status: AutomationTaskStatus): void {
  if (status === "succeeded") metrics.succeeded += 1;
  else if (status === "retryable") metrics.retryable += 1;
  else if (status === "failed") metrics.failed += 1;
  else if (status === "canceled") metrics.canceled += 1;
  else metrics.skipped += 1;
}

export async function processDueAutomationTasks(options: AutomationSchedulerOptions): Promise<AutomationSchedulerMetrics> {
  const clock = options.clock ?? (() => new Date());
  const dueAt = options.dueAt ?? clock();
  const dueAtIso = dueAt.toISOString();
  const limit = boundedBatchLimit(options.batchLimit);
  const metrics: AutomationSchedulerMetrics = {
    attempted: 0,
    canceled: 0,
    candidates: 0,
    errors: 0,
    failed: 0,
    missingExecutors: 0,
    recovered: 0,
    retryable: 0,
    skipped: 0,
    succeeded: 0,
  };
  const recoveryTransition = {
    actorId: "automation-scheduler",
    actorRole: "system",
    safeCode: "automation_lease_recovered",
  } as const;
  let recovered: AutomationTaskDueReference[];
  let due: AutomationTaskDueReference[];
  try {
    recovered = await options.repository.recoverExpiredLeases({ limit, now: dueAtIso, transition: recoveryTransition });
    due = await options.repository.listDue({ limit, now: dueAtIso });
  } catch {
    metrics.errors = 1;
    return metrics;
  }
  const candidates = uniqueCandidates(recovered, due, limit);
  metrics.candidates = candidates.length;
  metrics.recovered = recovered.length;
  const orchestrator = createAutomationOrchestrator({
    executors: options.executors,
    ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
    ...(options.leaseTokenFactory === undefined ? {} : { leaseTokenFactory: options.leaseTokenFactory }),
    now: clock,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    repository: options.repository,
  });

  for (const reference of candidates) {
    metrics.attempted += 1;
    try {
      const task = await orchestrator.continueTask({
        actorId: "automation-scheduler",
        actorRole: "system",
        shopId: reference.shopId,
      }, reference.id, { kind: "retry_due" }, reference.version);
      if (task.lastSafeErrorCode === "automation_executor_missing") metrics.missingExecutors += 1;
      countStatus(metrics, task.status);
    } catch (error) {
      if (isAppError(error) && (
        error.code === "automation_retry_not_due"
        || error.code === "automation_task_not_found"
        || error.code === "automation_continuation_invalid"
      )) {
        metrics.skipped += 1;
      } else {
        metrics.errors += 1;
      }
    }
  }

  return metrics;
}

export function processScheduledAutomationTasks(
  env: AppBindings,
  scheduledAt: Date,
  options?: ScheduledAutomationOptions,
): Promise<AutomationSchedulerMetrics> {
  const schedulerOptions = options ?? {};
  const clock = schedulerOptions.clock ?? (() => new Date());
  const wallClockAtStart = clock();
  return processDueAutomationTasks({
    ...schedulerOptions,
    executors: schedulerOptions.executors ?? createAutomationExecutors(env),
    clock,
    dueAt: new Date(Math.max(scheduledAt.getTime(), wallClockAtStart.getTime())),
    repository: createD1AutomationTaskRepository(env.PLATFORM_DB),
  });
}
