import { describe, expect, it, vi } from "vitest";

import { createAutomationOrchestrator } from "../../src/lib/automation/orchestrator";
import { AutomationCapabilityRegistry, defaultAutomationCapabilityRegistry } from "../../src/lib/automation/registry";
import { processDueAutomationTasks } from "../../src/lib/automation/scheduler";
import type {
  AutomationAccessContext,
  AutomationCapabilityDefinition,
  AutomationExecutor,
  AutomationContinuationEvidenceResolver,
  AutomationTask,
  AutomationTaskDueReference,
  AutomationTaskRepository,
  AutomationTaskStartInput,
} from "../../src/lib/automation/types";

const STARTED_AT = "2026-07-26T00:00:00.000Z";

class MemoryAutomationTaskRepository implements AutomationTaskRepository {
  readonly claimInputs: Parameters<AutomationTaskRepository["claimDue"]>[0][] = [];
  private readonly idempotency = new Map<string, string>();
  private readonly tasks = new Map<string, AutomationTask>();
  onUpdate?: (task: AutomationTask) => void;

  private key(input: { idempotencyKeyHash: string; shopId: string }): string {
    return `${input.shopId}\0${input.idempotencyKeyHash}`;
  }

  create(input: Parameters<AutomationTaskRepository["create"]>[0]): Promise<{ created: boolean; task: AutomationTask }> {
    const { task } = input;
    const key = this.key(task);
    const existingId = this.idempotency.get(key);
    if (existingId !== undefined) {
      const existing = this.tasks.get(existingId);
      if (existing === undefined) throw new Error("missing task");
      return Promise.resolve({ created: false, task: existing });
    }
    this.tasks.set(task.id, task);
    this.idempotency.set(key, task.id);
    return Promise.resolve({ created: true, task });
  }

  findByIdempotency(input: { idempotencyKeyHash: string; shopId: string }): Promise<AutomationTask | null> {
    const id = this.idempotency.get(this.key(input));
    return Promise.resolve(id === undefined ? null : this.tasks.get(id) ?? null);
  }

  get(input: { shopId: string; taskId: string }): Promise<AutomationTask | null> {
    const task = this.tasks.get(input.taskId);
    return Promise.resolve(task?.shopId === input.shopId ? task : null);
  }

  update(input: Parameters<AutomationTaskRepository["update"]>[0]): Promise<AutomationTask | null> {
    const current = this.tasks.get(input.task.id);
    if (current === undefined || current.shopId !== input.shopId || current.version !== input.expectedVersion) return Promise.resolve(null);
    this.tasks.set(input.task.id, input.task);
    this.onUpdate?.(input.task);
    return Promise.resolve(input.task);
  }

  claimDue(input: Parameters<AutomationTaskRepository["claimDue"]>[0]): Promise<AutomationTask | null> {
    this.claimInputs.push(input);
    const current = this.tasks.get(input.taskId);
    const eligible = current !== undefined
      && current.shopId === input.shopId
      && current.version === input.expectedVersion
      && (current.status === "pending"
        || current.status === "waiting_user"
        || current.status === "waiting_provider"
        || (current.status === "retryable" && current.nextAttemptAt !== null && current.nextAttemptAt <= input.now)
        || (current.status === "running" && current.leaseExpiresAt !== null && current.leaseExpiresAt <= input.now));
    if (!eligible) return Promise.resolve(null);
    const claimed: AutomationTask = {
      ...current,
      attemptCount: current.attemptCount + 1,
      consentEvidenceReference: input.transition.evidenceReference ?? current.consentEvidenceReference,
      leaseExpiresAt: input.leaseExpiresAt,
      leaseToken: input.leaseToken,
      nextAttemptAt: null,
      status: "running",
      updatedAt: input.now,
      version: current.version + 1,
    };
    this.tasks.set(claimed.id, claimed);
    return Promise.resolve(claimed);
  }

  listDue(input: { limit: number; now: string }): Promise<AutomationTaskDueReference[]> {
    const due = [...this.tasks.values()]
      .filter((task) => task.status === "pending"
        || (task.status === "retryable" && task.nextAttemptAt !== null && task.nextAttemptAt <= input.now)
        || (task.status === "running" && task.leaseExpiresAt !== null && task.leaseExpiresAt <= input.now))
      .slice(0, input.limit)
      .map(({ id, shopId, status, version }) => ({ id, shopId, status, version }));
    return Promise.resolve(due);
  }

  recoverExpiredLeases(input: Parameters<AutomationTaskRepository["recoverExpiredLeases"]>[0]): Promise<AutomationTaskDueReference[]> {
    const recovered: AutomationTaskDueReference[] = [];
    for (const task of this.tasks.values()) {
      if (recovered.length >= input.limit) break;
      if (task.status !== "running" || task.leaseExpiresAt === null || task.leaseExpiresAt > input.now) continue;
      const updated: AutomationTask = {
        ...task,
        lastSafeErrorCode: "automation_lease_expired",
        leaseExpiresAt: null,
        leaseToken: null,
        nextAttemptAt: input.now,
        status: "retryable",
        updatedAt: input.now,
        version: task.version + 1,
      };
      this.tasks.set(updated.id, updated);
      recovered.push({ id: updated.id, shopId: updated.shopId, status: updated.status, version: updated.version });
    }
    return Promise.resolve(recovered);
  }
}

function accessContext(shopId = "shop-a"): AutomationAccessContext {
  return { actorId: "seller-a", actorRole: "seller", shopId };
}

const APPROVAL_TOKEN = "approval-evidence-token-001";
const PROVIDER_TOKEN = "provider-evidence-token-001";

function evidenceResolver(reference: string, token: string): AutomationContinuationEvidenceResolver {
  return ({ evidenceToken }) => Promise.resolve(evidenceToken === token ? reference : null);
}

function startInput(capabilityCode: string, overrides: Partial<AutomationTaskStartInput> = {}): AutomationTaskStartInput {
  return {
    capabilityCode,
    idempotencyKeyHash: "a".repeat(64),
    inputReference: `d1:automation-input/${capabilityCode}`,
    requestHash: "b".repeat(64),
    shopId: "shop-a",
    ...overrides,
  };
}

function testRegistry(definition: AutomationCapabilityDefinition): AutomationCapabilityRegistry {
  return new AutomationCapabilityRegistry([definition]);
}

function persistedTask(id: string, overrides: Partial<AutomationTask> = {}): AutomationTask {
  return {
    actionReference: null,
    attemptCount: 1,
    auditLogId: null,
    capabilityCode: "test.scheduler",
    consentEvidenceReference: null,
    createdAt: STARTED_AT,
    id,
    idempotencyKeyHash: "c".repeat(64),
    inputReference: `d1:automation-input/${id}`,
    lastSafeErrorCode: "provider_busy",
    leaseExpiresAt: null,
    leaseToken: null,
    nextAttemptAt: STARTED_AT,
    requestHash: "d".repeat(64),
    shopId: "shop-a",
    status: "retryable",
    updatedAt: STARTED_AT,
    version: 1,
    ...overrides,
  };
}

describe("no-tech automation capability registry", () => {
  it.each([
    ["shop.provision", "automatic"],
    ["domain.custom.domain_connect", "approval_required"],
    ["telegram.bot.create", "external_action"],
    ["domain.custom.apex", "unsupported"],
  ] as const)("classifies %s as %s", (code, level) => {
    expect(defaultAutomationCapabilityRegistry.require(code).level).toBe(level);
  });
});

describe("automation task orchestration", () => {
  it("runs automatic capabilities once and replays the completed task idempotently", async () => {
    const repository = new MemoryAutomationTaskRepository();
    const executor = vi.fn<AutomationExecutor>(() => Promise.resolve({ outcome: "completed" }));
    const orchestrator = createAutomationOrchestrator({
      executors: new Map([["shop.provision", executor]]),
      now: () => new Date(STARTED_AT),
      repository,
      taskIdFactory: () => "aut-automatic",
    });

    const first = await orchestrator.start(accessContext(), startInput("shop.provision"));
    const replay = await orchestrator.start(accessContext(), startInput("shop.provision"));

    expect(first).toMatchObject({ attemptCount: 1, id: "aut-automatic", status: "succeeded" });
    expect(replay).toEqual(first);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith({
      attemptCount: 1,
      capabilityCode: "shop.provision",
      inputReference: "d1:automation-input/shop.provision",
      shopId: "shop-a",
      taskId: "aut-automatic",
    });
  });

  it("waits for explicit approval before executing an approval-required capability", async () => {
    const repository = new MemoryAutomationTaskRepository();
    const executor = vi.fn<AutomationExecutor>(() => Promise.resolve({ outcome: "completed" }));
    const orchestrator = createAutomationOrchestrator({
      executors: new Map([["domain.custom.domain_connect", executor]]),
      now: () => new Date(STARTED_AT),
      resolveContinuationEvidence: evidenceResolver("audit:approval/domain-connect", APPROVAL_TOKEN),
      repository,
      taskIdFactory: () => "aut-approval",
    });

    const waiting = await orchestrator.start(accessContext(), startInput("domain.custom.domain_connect"));
    expect(waiting.status).toBe("waiting_user");
    expect(executor).not.toHaveBeenCalled();

    const completed = await orchestrator.continueTask(accessContext(), waiting.id, { evidenceToken: APPROVAL_TOKEN, kind: "approval_granted" });
    const replay = await orchestrator.continueTask(accessContext(), waiting.id, { evidenceToken: APPROVAL_TOKEN, kind: "approval_granted" });
    expect(completed.status).toBe("succeeded");
    expect(replay).toEqual(completed);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("waits for verified external action before executing the continuation", async () => {
    const repository = new MemoryAutomationTaskRepository();
    const executor = vi.fn<AutomationExecutor>(() => Promise.resolve({ outcome: "completed" }));
    const orchestrator = createAutomationOrchestrator({
      executors: new Map([["telegram.bot.create", executor]]),
      now: () => new Date(STARTED_AT),
      resolveContinuationEvidence: evidenceResolver("audit:provider/telegram-ready", PROVIDER_TOKEN),
      repository,
      taskIdFactory: () => "aut-external",
    });

    const waiting = await orchestrator.start(accessContext(), startInput("telegram.bot.create"));
    expect(waiting.status).toBe("waiting_provider");
    expect(executor).not.toHaveBeenCalled();

    const completed = await orchestrator.continueTask(accessContext(), waiting.id, { evidenceToken: PROVIDER_TOKEN, kind: "external_action_completed" });
    expect(completed.status).toBe("succeeded");
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("records unsupported capabilities without calling an executor", async () => {
    const orchestrator = createAutomationOrchestrator({
      executors: new Map(),
      now: () => new Date(STARTED_AT),
      repository: new MemoryAutomationTaskRepository(),
      taskIdFactory: () => "aut-unsupported",
    });

    await expect(orchestrator.start(accessContext(), startInput("domain.custom.apex"))).resolves.toMatchObject({
      attemptCount: 0,
      lastSafeErrorCode: "automation_unsupported",
      status: "canceled",
    });
  });

  it("schedules bounded retries, rejects early retry and completes when due", async () => {
    const capability: AutomationCapabilityDefinition = {
      code: "test.retry",
      level: "automatic",
      retryPolicy: { baseDelaySeconds: 30, maxAttempts: 3, maxDelaySeconds: 300 },
    };
    const repository = new MemoryAutomationTaskRepository();
    let currentTime = new Date(STARTED_AT);
    const executor = vi.fn<AutomationExecutor>()
      .mockResolvedValueOnce({ outcome: "retry", retryAfterSeconds: 60, safeErrorCode: "provider_busy" })
      .mockResolvedValueOnce({ outcome: "completed" });
    const orchestrator = createAutomationOrchestrator({
      executors: new Map([[capability.code, executor]]),
      now: () => currentTime,
      registry: testRegistry(capability),
      repository,
      taskIdFactory: () => "aut-retry",
    });

    const scheduled = await orchestrator.start(accessContext(), startInput(capability.code));
    expect(scheduled).toMatchObject({
      attemptCount: 1,
      lastSafeErrorCode: "provider_busy",
      nextAttemptAt: "2026-07-26T00:01:00.000Z",
      status: "retryable",
    });
    await expect(orchestrator.continueTask(accessContext(), scheduled.id, { kind: "retry_due" }))
      .rejects.toMatchObject({ code: "automation_retry_not_due", status: 409 });

    currentTime = new Date("2026-07-26T00:01:00.000Z");
    const completed = await orchestrator.continueTask(accessContext(), scheduled.id, { kind: "retry_due" });
    expect(completed).toMatchObject({ attemptCount: 2, nextAttemptAt: null, status: "succeeded" });
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("fails closed after the retry budget is exhausted", async () => {
    const capability: AutomationCapabilityDefinition = {
      code: "test.exhausted",
      level: "automatic",
      retryPolicy: { baseDelaySeconds: 10, maxAttempts: 2, maxDelaySeconds: 60 },
    };
    let currentTime = new Date(STARTED_AT);
    const executor = vi.fn<AutomationExecutor>(() => Promise.resolve({ outcome: "retry", safeErrorCode: "provider_busy" }));
    const orchestrator = createAutomationOrchestrator({
      executors: new Map([[capability.code, executor]]),
      now: () => currentTime,
      registry: testRegistry(capability),
      repository: new MemoryAutomationTaskRepository(),
      taskIdFactory: () => "aut-exhausted",
    });

    const scheduled = await orchestrator.start(accessContext(), startInput(capability.code));
    currentTime = new Date(scheduled.nextAttemptAt ?? "invalid");
    const failed = await orchestrator.continueTask(accessContext(), scheduled.id, { kind: "retry_due" });
    const replay = await orchestrator.continueTask(accessContext(), scheduled.id, { kind: "retry_due" });

    expect(failed).toMatchObject({ attemptCount: 2, lastSafeErrorCode: "provider_busy", status: "failed" });
    expect(replay).toEqual(failed);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("reclaims an expired execution lease with the same task identity", async () => {
    const capability: AutomationCapabilityDefinition = {
      code: "test.stale_lease",
      level: "automatic",
      retryPolicy: { baseDelaySeconds: 10, maxAttempts: 3, maxDelaySeconds: 60 },
    };
    const repository = new MemoryAutomationTaskRepository();
    await repository.create({
      task: {
        actionReference: null,
        attemptCount: 1,
        auditLogId: null,
        capabilityCode: capability.code,
        consentEvidenceReference: null,
        createdAt: "2026-07-25T23:58:00.000Z",
        id: "aut-stale-lease",
        idempotencyKeyHash: "c".repeat(64),
        inputReference: "d1:automation-input/stale-lease",
        lastSafeErrorCode: null,
        leaseExpiresAt: "2026-07-25T23:59:00.000Z",
        leaseToken: "expired-lease-token",
        nextAttemptAt: null,
        requestHash: "d".repeat(64),
        shopId: "shop-a",
        status: "running",
        updatedAt: "2026-07-25T23:58:00.000Z",
        version: 2,
      },
      transition: { actorId: "test-system", actorRole: "system", safeCode: "automation_test_seeded" },
    });
    const executor = vi.fn<AutomationExecutor>(() => Promise.resolve({ outcome: "completed" }));
    const orchestrator = createAutomationOrchestrator({
      executors: new Map([[capability.code, executor]]),
      now: () => new Date(STARTED_AT),
      registry: testRegistry(capability),
      repository,
    });

    const completed = await orchestrator.continueTask(accessContext(), "aut-stale-lease", { kind: "retry_due" });

    expect(completed).toMatchObject({ attemptCount: 2, id: "aut-stale-lease", leaseToken: null, status: "succeeded" });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of an idempotency key for a different request", async () => {
    const executor = vi.fn<AutomationExecutor>(() => Promise.resolve({ outcome: "completed" }));
    const orchestrator = createAutomationOrchestrator({
      executors: new Map([["shop.provision", executor]]),
      now: () => new Date(STARTED_AT),
      repository: new MemoryAutomationTaskRepository(),
      taskIdFactory: () => "aut-conflict",
    });
    const input = startInput("shop.provision");

    await orchestrator.start(accessContext(), input);
    await expect(orchestrator.start(accessContext(), { ...input, requestHash: "e".repeat(64) }))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of a shop-scoped idempotency key for a different capability", async () => {
    const shopExecutor = vi.fn<AutomationExecutor>(() => Promise.resolve({ outcome: "completed" }));
    const domainExecutor = vi.fn<AutomationExecutor>(() => Promise.resolve({ outcome: "completed" }));
    const orchestrator = createAutomationOrchestrator({
      executors: new Map([
        ["shop.provision", shopExecutor],
        ["domain.platform.provision", domainExecutor],
      ]),
      now: () => new Date(STARTED_AT),
      repository: new MemoryAutomationTaskRepository(),
      taskIdFactory: () => "aut-capability-conflict",
    });

    await orchestrator.start(accessContext(), startInput("shop.provision"));
    await expect(orchestrator.start(accessContext(), startInput("domain.platform.provision", {
      requestHash: "e".repeat(64),
    }))).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(shopExecutor).toHaveBeenCalledTimes(1);
    expect(domainExecutor).not.toHaveBeenCalled();
  });

  it("fails closed when a different tenant tries to read or continue a task", async () => {
    const repository = new MemoryAutomationTaskRepository();
    const orchestrator = createAutomationOrchestrator({
      executors: new Map([["domain.custom.domain_connect", vi.fn<AutomationExecutor>(() => Promise.resolve({ outcome: "completed" }))]]),
      now: () => new Date(STARTED_AT),
      resolveContinuationEvidence: evidenceResolver("audit:approval/cross-tenant", APPROVAL_TOKEN),
      repository,
      taskIdFactory: () => "aut-tenant-isolation",
    });
    const task = await orchestrator.start(accessContext(), startInput("domain.custom.domain_connect"));

    await expect(orchestrator.continueTask(accessContext("shop-b"), task.id, {
      evidenceToken: APPROVAL_TOKEN,
      kind: "approval_granted",
    })).rejects.toMatchObject({ code: "automation_task_not_found", status: 404 });
    await expect(orchestrator.start(accessContext("shop-b"), startInput("shop.provision")))
      .rejects.toMatchObject({ code: "automation_tenant_mismatch", status: 403 });
  });

  it("rejects raw references and non-SHA-256 digest inputs", async () => {
    const orchestrator = createAutomationOrchestrator({
      executors: new Map(),
      now: () => new Date(STARTED_AT),
      repository: new MemoryAutomationTaskRepository(),
    });

    await expect(orchestrator.start(accessContext(), startInput("shop.provision", { idempotencyKeyHash: "raw-key" })))
      .rejects.toMatchObject({ code: "automation_digest_invalid", status: 400 });
    await expect(orchestrator.start(accessContext(), startInput("shop.provision", { inputReference: "https://provider.example/setup?token=secret" })))
      .rejects.toMatchObject({ code: "automation_reference_invalid", status: 400 });
  });

  it("requires a server-issued evidence token bound by the verifier", async () => {
    const repository = new MemoryAutomationTaskRepository();
    const executor = vi.fn<AutomationExecutor>(() => Promise.resolve({ outcome: "completed" }));
    const resolver = vi.fn<AutomationContinuationEvidenceResolver>(({ context, evidenceToken, task }) => Promise.resolve(
      context.shopId === task.shopId && task.id === "aut-evidence-bound" && evidenceToken === APPROVAL_TOKEN
        ? "audit:approval/server-issued"
        : null,
    ));
    const orchestrator = createAutomationOrchestrator({
      executors: new Map([["domain.custom.domain_connect", executor]]),
      now: () => new Date(STARTED_AT),
      repository,
      resolveContinuationEvidence: resolver,
      taskIdFactory: () => "aut-evidence-bound",
    });
    const waiting = await orchestrator.start(accessContext(), startInput("domain.custom.domain_connect"));

    await expect(orchestrator.continueTask(accessContext(), waiting.id, {
      evidenceToken: "attacker-fabricated-token",
      kind: "approval_granted",
    })).rejects.toMatchObject({ code: "automation_evidence_invalid", status: 403 });
    const verificationCall = resolver.mock.calls[0]?.[0];
    expect(verificationCall?.context).toEqual(accessContext());
    expect(verificationCall?.evidenceToken).toBe("attacker-fabricated-token");
    expect(verificationCall?.task.id).toBe(waiting.id);
    expect(verificationCall?.task.shopId).toBe("shop-a");
    expect(executor).not.toHaveBeenCalled();
    await expect(repository.get({ shopId: "shop-a", taskId: waiting.id })).resolves.toMatchObject({ status: "waiting_user" });
  });

  it("claims a continuation once under concurrent callers", async () => {
    const repository = new MemoryAutomationTaskRepository();
    const executor = vi.fn<AutomationExecutor>(() => Promise.resolve({ outcome: "completed" }));
    const orchestrator = createAutomationOrchestrator({
      executors: new Map([["domain.custom.domain_connect", executor]]),
      now: () => new Date(STARTED_AT),
      resolveContinuationEvidence: evidenceResolver("audit:approval/concurrent", APPROVAL_TOKEN),
      repository,
      taskIdFactory: () => "aut-concurrent-claim",
    });
    const waiting = await orchestrator.start(accessContext(), startInput("domain.custom.domain_connect"));
    const continuation = { evidenceToken: APPROVAL_TOKEN, kind: "approval_granted" } as const;

    await Promise.all([
      orchestrator.continueTask(accessContext(), waiting.id, continuation),
      orchestrator.continueTask(accessContext(), waiting.id, continuation),
    ]);

    expect(executor).toHaveBeenCalledTimes(1);
    await expect(repository.get({ shopId: "shop-a", taskId: waiting.id })).resolves.toMatchObject({ status: "succeeded" });
  });
});

describe("automation due-task scheduler", () => {
  const capability: AutomationCapabilityDefinition = {
    code: "test.scheduler",
    level: "automatic",
    retryPolicy: { baseDelaySeconds: 30, maxAttempts: 3, maxDelaySeconds: 300 },
  };

  it("processes due reference-only work and records bounded metrics", async () => {
    const repository = new MemoryAutomationTaskRepository();
    await repository.create({
      task: persistedTask("aut-scheduler-due"),
      transition: { actorId: "test-system", actorRole: "system", safeCode: "automation_test_seeded" },
    });
    const executor = vi.fn<AutomationExecutor>(() => Promise.resolve({ outcome: "completed" }));

    const metrics = await processDueAutomationTasks({
      executors: new Map([[capability.code, executor]]),
      leaseTokenFactory: () => "scheduler-lease-token",
      dueAt: new Date(STARTED_AT),
      clock: () => new Date(STARTED_AT),
      registry: testRegistry(capability),
      repository,
    });

    expect(metrics).toMatchObject({ attempted: 1, candidates: 1, errors: 0, succeeded: 1 });
    expect(executor).toHaveBeenCalledWith({
      attemptCount: 2,
      capabilityCode: capability.code,
      inputReference: "d1:automation-input/aut-scheduler-due",
      shopId: "shop-a",
      taskId: "aut-scheduler-due",
    });
  });

  it("leaves due work retryable and reports a missing executor without crashing cron", async () => {
    const repository = new MemoryAutomationTaskRepository();
    const task = persistedTask("aut-scheduler-missing");
    await repository.create({
      task,
      transition: { actorId: "test-system", actorRole: "system", safeCode: "automation_test_seeded" },
    });

    const metrics = await processDueAutomationTasks({
      executors: new Map(),
      dueAt: new Date(STARTED_AT),
      clock: () => new Date(STARTED_AT),
      registry: testRegistry(capability),
      repository,
    });

    expect(metrics).toMatchObject({ attempted: 1, errors: 0, missingExecutors: 1, retryable: 1, skipped: 0 });
    await expect(repository.get({ shopId: task.shopId, taskId: task.id })).resolves.toMatchObject({
      lastSafeErrorCode: "automation_executor_missing",
      status: "retryable",
      version: 3,
    });
  });

  it("defers a missing executor so it cannot starve later due capabilities", async () => {
    const repository = new MemoryAutomationTaskRepository();
    await repository.create({
      task: persistedTask("aut-scheduler-no-executor", { capabilityCode: "test.no_executor" }),
      transition: { actorId: "test-system", actorRole: "system", safeCode: "automation_test_seeded" },
    });
    await repository.create({
      task: persistedTask("aut-scheduler-after-missing", { capabilityCode: "test.after_missing", idempotencyKeyHash: "e".repeat(64) }),
      transition: { actorId: "test-system", actorRole: "system", safeCode: "automation_test_seeded" },
    });
    const registry = new AutomationCapabilityRegistry([
      capability,
      { ...capability, code: "test.no_executor" },
      { ...capability, code: "test.after_missing" },
    ]);
    const executor = vi.fn<AutomationExecutor>(() => Promise.resolve({ outcome: "completed" }));

    const firstPass = await processDueAutomationTasks({
      batchLimit: 1,
      clock: () => new Date(STARTED_AT),
      dueAt: new Date(STARTED_AT),
      executors: new Map([["test.after_missing", executor]]),
      registry,
      repository,
    });
    expect(firstPass).toMatchObject({ missingExecutors: 1, retryable: 1 });

    const secondPass = await processDueAutomationTasks({
      batchLimit: 1,
      clock: () => new Date(STARTED_AT),
      dueAt: new Date(STARTED_AT),
      executors: new Map([["test.after_missing", executor]]),
      registry,
      repository,
    });
    expect(secondPass).toMatchObject({ succeeded: 1 });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("uses a fresh wall clock for each lease after earlier batch work settles", async () => {
    const repository = new MemoryAutomationTaskRepository();
    await repository.create({
      task: persistedTask("aut-clock-first", { capabilityCode: "test.clock_first" }),
      transition: { actorId: "test-system", actorRole: "system", safeCode: "automation_test_seeded" },
    });
    await repository.create({
      task: persistedTask("aut-clock-second", { capabilityCode: "test.clock_second", idempotencyKeyHash: "e".repeat(64) }),
      transition: { actorId: "test-system", actorRole: "system", safeCode: "automation_test_seeded" },
    });
    const registry = new AutomationCapabilityRegistry([
      { ...capability, code: "test.clock_first" },
      { ...capability, code: "test.clock_second" },
    ]);
    let currentClock = new Date(STARTED_AT);
    repository.onUpdate = (task) => {
      if (task.id === "aut-clock-first" && task.status === "succeeded") {
        currentClock = new Date("2026-07-26T00:02:00.000Z");
      }
    };

    const metrics = await processDueAutomationTasks({
      batchLimit: 2,
      clock: () => currentClock,
      dueAt: new Date(STARTED_AT),
      executors: new Map([
        ["test.clock_first", () => Promise.resolve({ outcome: "completed" as const })],
        ["test.clock_second", () => Promise.resolve({ outcome: "completed" as const })],
      ]),
      registry,
      repository,
    });

    expect(metrics.succeeded).toBe(2);
    expect(repository.claimInputs.map((input) => input.now)).toEqual([
      STARTED_AT,
      "2026-07-26T00:02:00.000Z",
    ]);
    expect(repository.claimInputs[1]?.leaseExpiresAt).toBe("2026-07-26T00:03:30.000Z");
  });

  it("reports repository failure without aborting the scheduled handler", async () => {
    class FailingAutomationTaskRepository extends MemoryAutomationTaskRepository {
      override recoverExpiredLeases(): Promise<AutomationTaskDueReference[]> {
        return Promise.reject(new Error("database_unavailable"));
      }
    }

    await expect(processDueAutomationTasks({
      executors: new Map(),
      dueAt: new Date(STARTED_AT),
      clock: () => new Date(STARTED_AT),
      registry: testRegistry(capability),
      repository: new FailingAutomationTaskRepository(),
    })).resolves.toMatchObject({ attempted: 0, candidates: 0, errors: 1 });
  });

  it("recovers an expired lease before retrying the same task", async () => {
    const repository = new MemoryAutomationTaskRepository();
    await repository.create({
      task: persistedTask("aut-scheduler-stale", {
        leaseExpiresAt: "2026-07-25T23:59:00.000Z",
        leaseToken: "expired-scheduler-lease",
        nextAttemptAt: null,
        status: "running",
      }),
      transition: { actorId: "test-system", actorRole: "system", safeCode: "automation_test_seeded" },
    });

    const metrics = await processDueAutomationTasks({
      executors: new Map([[capability.code, () => Promise.resolve({ outcome: "completed" })]]),
      leaseTokenFactory: () => "scheduler-retry-token",
      dueAt: new Date(STARTED_AT),
      clock: () => new Date(STARTED_AT),
      registry: testRegistry(capability),
      repository,
    });

    expect(metrics).toMatchObject({ attempted: 1, recovered: 1, succeeded: 1 });
  });
});
