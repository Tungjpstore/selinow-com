import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createD1AutomationTaskRepository } from "../../src/lib/automation/d1-repository";
import { createAutomationOrchestrator } from "../../src/lib/automation/orchestrator";
import { AutomationCapabilityRegistry } from "../../src/lib/automation/registry";
import type {
  AutomationAccessContext,
  AutomationExecutor,
  AutomationTask,
  AutomationTaskRepository,
  AutomationTaskTransitionEvidence,
} from "../../src/lib/automation/types";

const NOW = "2026-07-26T04:00:00.000Z";
const SHOP_A = "shop-a";
const SHOP_B = "shop-b";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REQUEST_HASH = "c".repeat(64);

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values as SQLInputValue[]);
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: Record<string, SQLInputValue>[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

function createD1(database: DatabaseSync): D1Database {
  let batchTail: Promise<void> = Promise.resolve();
  return {
    batch(statements: D1PreparedStatement[]) {
      const operation = batchTail.then(async () => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          database.exec("COMMIT");
          return results;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });
      batchTail = operation.then(() => undefined, () => undefined);
      return operation;
    },
    prepare(sql: string) {
      return new SqliteStatement(database, sql) as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function seedShops(database: DatabaseSync): void {
  for (const shop of [
    { id: SHOP_A, publicId: "shop_public_a", slug: "shop-a" },
    { id: SHOP_B, publicId: "shop_public_b", slug: "shop-b" },
  ]) {
    database.prepare(`
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency,
        timezone, readiness_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
    `).run(shop.id, shop.publicId, shop.slug, shop.id, NOW, NOW);
  }
}

function transition(overrides: Partial<AutomationTaskTransitionEvidence> = {}): AutomationTaskTransitionEvidence {
  return {
    actorId: "system-scheduler",
    actorRole: "system",
    safeCode: "automation_test_transition",
    ...overrides,
  };
}

function task(overrides: Partial<AutomationTask> = {}): AutomationTask {
  return {
    actionReference: null,
    attemptCount: 0,
    auditLogId: null,
    capabilityCode: "test.automatic",
    consentEvidenceReference: null,
    createdAt: NOW,
    id: "aut_task_00000001",
    idempotencyKeyHash: HASH_A,
    inputReference: "d1:automation-input/task-1",
    lastSafeErrorCode: null,
    leaseExpiresAt: null,
    leaseToken: null,
    nextAttemptAt: null,
    requestHash: REQUEST_HASH,
    shopId: SHOP_A,
    status: "pending",
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

describe("D1 automation task repository", () => {
  let database: DatabaseSync;
  let repository: AutomationTaskRepository;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    seedShops(database);
    repository = createD1AutomationTaskRepository(createD1(database));
  });

  afterEach(() => {
    database.close();
  });

  it("applies strict tenant-scoped schema and retains an immutable transition trail", async () => {
    const created = await repository.create({ task: task(), transition: transition() });

    expect(created.created).toBe(true);
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'index', 'trigger')
        AND name LIKE '%automation_task%'
      ORDER BY name
    `).all().map((row) => String((row as { name: unknown }).name))).toEqual(expect.arrayContaining([
      "automation_task_events",
      "automation_task_events_immutable_delete",
      "automation_task_events_immutable_update",
      "automation_tasks",
      "idx_automation_task_events_shop_task",
      "idx_automation_tasks_shop_create_idempotency",
      "idx_automation_tasks_shop_idempotency",
      "idx_automation_tasks_shop_status_due",
    ]));
    expect(database.prepare(`
      SELECT from_status AS fromStatus, to_status AS toStatus, actor_role AS actorRole,
        actor_id AS actorId, safe_code AS safeCode, task_version AS taskVersion
      FROM automation_task_events WHERE task_id = ?
    `).get(created.task.id)).toEqual({
      actorId: "system-scheduler",
      actorRole: "system",
      fromStatus: null,
      safeCode: "automation_test_transition",
      taskVersion: 1,
      toStatus: "pending",
    });
    expect(() => database.prepare("UPDATE automation_task_events SET safe_code = 'changed' WHERE task_id = ?").run(created.task.id))
      .toThrow(/automation_task_events_immutable/u);
    expect(() => database.prepare("DELETE FROM automation_task_events WHERE task_id = ?").run(created.task.id))
      .toThrow(/automation_task_events_immutable/u);
    expect(() => database.prepare(`
      INSERT INTO automation_task_events (
        id, task_id, shop_id, from_status, to_status, actor_role, actor_id,
        task_version, created_at
      ) VALUES (?, ?, ?, NULL, 'pending', 'system', ?, 99, ?)
    `).run("aev_bad_tenant_01", created.task.id, SHOP_B, "system-check", NOW))
      .toThrow(/FOREIGN KEY constraint failed/u);
    expect(() => database.prepare("DELETE FROM shops WHERE id = ?").run(SHOP_A))
      .toThrow(/FOREIGN KEY constraint failed/u);
    expect(database.prepare("PRAGMA index_info('idx_automation_tasks_shop_create_idempotency')").all())
      .toEqual([
        expect.objectContaining({ name: "shop_id", seqno: 0 }),
        expect.objectContaining({ name: "idempotency_key_hash", seqno: 1 }),
      ]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("deduplicates create keys across capabilities inside a tenant without disclosing them to another tenant", async () => {
    const first = await repository.create({ task: task(), transition: transition() });
    const replay = await repository.create({
      task: task({
        capabilityCode: "test.changed_capability",
        id: "aut_task_00000002",
        requestHash: HASH_B,
      }),
      transition: transition({ actorId: "system-replay" }),
    });
    const otherTenant = await repository.create({
      task: task({ id: "aut_task_shop_b_01", shopId: SHOP_B }),
      transition: transition({ actorId: "system-shop-b" }),
    });

    expect(first.created).toBe(true);
    expect(replay).toEqual({ created: false, task: first.task });
    expect(otherTenant.created).toBe(true);
    await expect(repository.get({ shopId: SHOP_B, taskId: first.task.id })).resolves.toBeNull();
    await expect(repository.findByIdempotency({
      idempotencyKeyHash: first.task.idempotencyKeyHash,
      shopId: SHOP_B,
    })).resolves.toEqual(otherTenant.task);
    await expect(repository.claimDue({
      expectedVersion: first.task.version,
      leaseExpiresAt: "2026-07-26T04:02:00.000Z",
      leaseToken: "lease_token_wrong_tenant",
      now: NOW,
      shopId: SHOP_B,
      taskId: first.task.id,
      transition: transition(),
    })).resolves.toBeNull();
    await expect(repository.update({
      expectedVersion: first.task.version,
      shopId: SHOP_B,
      task: { ...first.task, status: "canceled", version: first.task.version + 1 },
      transition: transition(),
    })).rejects.toMatchObject({ code: "automation_tenant_mismatch", status: 403 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM automation_tasks").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM automation_task_events").get()).toEqual({ count: 2 });
  });

  it.each([
    { capabilityCode: "test.approval", evidence: "audit:approval/evidence-1", level: "approval_required", waitingStatus: "waiting_user" },
    { capabilityCode: "test.external", evidence: "audit:provider/ownership-1", level: "external_action", waitingStatus: "waiting_provider" },
  ] as const)("persists evidence for $waitingStatus continuation through the real D1 repository", async ({ capabilityCode, evidence, level, waitingStatus }) => {
    const executor = vi.fn<AutomationExecutor>(() => Promise.resolve({ outcome: "completed" }));
    const evidenceToken = level === "approval_required"
      ? "approval-evidence-token-d1-001"
      : "provider-evidence-token-d1-001";
    const orchestrator = createAutomationOrchestrator({
      executors: new Map([[capabilityCode, executor]]),
      now: () => new Date(NOW),
      registry: new AutomationCapabilityRegistry([{
        code: capabilityCode,
        level,
        retryPolicy: { baseDelaySeconds: 30, maxAttempts: 3, maxDelaySeconds: 300 },
      }]),
      repository,
      resolveContinuationEvidence: (input) => Promise.resolve(input.evidenceToken === evidenceToken ? evidence : null),
      taskIdFactory: () => `aut_${waitingStatus}_0001`,
    });
    const context: AutomationAccessContext = { actorId: "seller-a", actorRole: "seller", shopId: SHOP_A };
    const waiting = await orchestrator.start(context, {
      capabilityCode,
      idempotencyKeyHash: level === "approval_required" ? HASH_A : HASH_B,
      inputReference: `d1:${waitingStatus}/input-1`,
      requestHash: REQUEST_HASH,
      shopId: SHOP_A,
    });
    expect(waiting.status).toBe(waitingStatus);

    const completed = await orchestrator.continueTask(context, waiting.id, level === "approval_required"
      ? { evidenceToken, kind: "approval_granted" }
      : { evidenceToken, kind: "external_action_completed" });

    expect(completed).toMatchObject({ consentEvidenceReference: evidence, status: "succeeded" });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(database.prepare(`
      SELECT from_status AS fromStatus, to_status AS toStatus,
        evidence_reference AS evidenceReference, actor_role AS actorRole
      FROM automation_task_events
      WHERE task_id = ? AND to_status = 'running'
    `).get(waiting.id)).toEqual({
      actorRole: "seller",
      evidenceReference: evidence,
      fromStatus: waitingStatus,
      toStatus: "running",
    });
  });

  it("claims due work once under concurrent workers and guards settlement with version CAS", async () => {
    const created = await repository.create({ task: task(), transition: transition() });
    const claimInput = {
      expectedVersion: created.task.version,
      leaseExpiresAt: "2026-07-26T04:02:00.000Z",
      now: NOW,
      shopId: SHOP_A,
      taskId: created.task.id,
      transition: transition({ safeCode: "automation_execution_claimed" }),
    };
    const [first, second] = await Promise.all([
      repository.claimDue({ ...claimInput, leaseToken: "lease_token_worker_a" }),
      repository.claimDue({ ...claimInput, leaseToken: "lease_token_worker_b" }),
    ]);
    const running = first ?? second;

    expect([first, second].filter((value) => value !== null)).toHaveLength(1);
    expect(running).toMatchObject({ attemptCount: 1, status: "running", version: 2 });
    if (running === null) throw new Error("claim_missing");
    const succeeded: AutomationTask = {
      ...running,
      leaseExpiresAt: null,
      leaseToken: null,
      status: "succeeded",
      updatedAt: "2026-07-26T04:00:05.000Z",
      version: running.version + 1,
    };
    const failed: AutomationTask = {
      ...succeeded,
      lastSafeErrorCode: "provider_failed",
      status: "failed",
    };
    const [settledA, settledB] = await Promise.all([
      repository.update({
        expectedVersion: running.version,
        shopId: SHOP_A,
        task: succeeded,
        transition: transition({ safeCode: "automation_succeeded" }),
      }),
      repository.update({
        expectedVersion: running.version,
        shopId: SHOP_A,
        task: failed,
        transition: transition({ safeCode: "provider_failed" }),
      }),
    ]);

    expect([settledA, settledB].filter((value) => value !== null)).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM automation_task_events WHERE task_id = ?").get(running.id))
      .toEqual({ count: 3 });
  });

  it("lists reference-only due work, excludes waiting states and recovers stale leases", async () => {
    const pending = await repository.create({ task: task(), transition: transition() });
    await repository.create({
      task: task({
        capabilityCode: "test.waiting",
        id: "aut_task_waiting_01",
        idempotencyKeyHash: HASH_B,
        status: "waiting_user",
      }),
      transition: transition(),
    });
    const running = await repository.claimDue({
      expectedVersion: pending.task.version,
      leaseExpiresAt: "2026-07-26T04:01:00.000Z",
      leaseToken: "lease_token_stale_001",
      now: NOW,
      shopId: SHOP_A,
      taskId: pending.task.id,
      transition: transition({ safeCode: "automation_execution_claimed" }),
    });
    expect(running?.status).toBe("running");

    const due = await repository.listDue({ limit: 10, now: "2026-07-26T04:02:00.000Z" });
    expect(due).toEqual([expect.objectContaining({ id: pending.task.id, status: "running" })]);
    expect(due[0]).not.toHaveProperty("inputReference");

    const recovered = await repository.recoverExpiredLeases({
      limit: 10,
      now: "2026-07-26T04:02:00.000Z",
      transition: transition({ actorId: "scheduled-worker", safeCode: "automation_lease_expired" }),
    });
    expect(recovered).toEqual([{
      id: pending.task.id,
      shopId: SHOP_A,
      status: "retryable",
      version: 3,
    }]);
    await expect(repository.get({ shopId: SHOP_A, taskId: pending.task.id })).resolves.toMatchObject({
      lastSafeErrorCode: "automation_lease_expired",
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: "2026-07-26T04:02:00.000Z",
      status: "retryable",
    });
  });

  it("rejects raw input payloads and malformed digests before writing", async () => {
    await expect(repository.create({
      task: task({ inputReference: '{"botToken":"secret"}' }),
      transition: transition(),
    })).rejects.toMatchObject({ code: "automation_repository_validation_failed", status: 400 });
    await expect(repository.create({
      task: task({ id: "aut_task_bad_hash", idempotencyKeyHash: "not-a-digest" }),
      transition: transition(),
    })).rejects.toMatchObject({ code: "automation_repository_validation_failed", status: 400 });
    await expect(repository.create({
      task: task({ actionReference: "https://provider.example/setup?token=secret" }),
      transition: transition(),
    })).rejects.toMatchObject({ code: "automation_repository_validation_failed", status: 400 });
    expect(() => database.prepare(`
      INSERT INTO automation_tasks (
        id, shop_id, capability_code, status, idempotency_key_hash,
        request_hash, input_reference, version, created_at, updated_at
      ) VALUES (?, ?, 'test.automatic', 'pending', ?, ?, ?, 1, ?, ?)
    `).run(
      "aut_direct_token_01",
      SHOP_A,
      HASH_A,
      REQUEST_HASH,
      "d1:provider/123456:provider-token",
      NOW,
      NOW,
    )).toThrow(/CHECK constraint failed/u);
    expect(database.prepare("SELECT COUNT(*) AS count FROM automation_tasks").get()).toEqual({ count: 0 });
  });
});
