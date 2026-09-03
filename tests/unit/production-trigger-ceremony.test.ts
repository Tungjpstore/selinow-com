/* eslint-disable @typescript-eslint/require-await */

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyProductionTriggerPlan,
  buildProductionTriggerPlan,
  compensateProductionTriggerCeremony,
  createProductionTriggerEvidence,
  desiredProductionTriggerSpec,
  deriveProductionTriggerConfig,
  discoverProductionTriggerInventory,
  executeProductionTriggerCeremony,
  fingerprintProductionTrigger,
  normalizeProductionTriggerInventory,
  validateProductionTriggerReleaseManifest,
  writeProductionTriggerEvidence,
} from "../../scripts/lib/production-trigger-ceremony.mjs";
import type { ProductionTriggerSpec } from "../../scripts/lib/production-trigger-ceremony.mjs";

const CRON = "*/15 * * * *";
const spec: ProductionTriggerSpec = {
  accountId: "ef250a88911fd24073cb73d1c07e0218",
  environment: "production",
  resources: {
    deadLetterQueue: "selinow-dlq-production",
    integrationQueue: "selinow-integration-production",
    notificationQueue: "selinow-notification-production",
  },
  workerName: "selinow-com-production",
  cron: CRON,
};

const releaseBinding = {
  candidateWorkerVersion: "11111111-1111-4111-8111-111111111111",
  commitSha: "1".repeat(40),
  manifestRef: ".wrangler/releases/rel_20260809T000000Z_111111111111/release-manifest.json",
  manifestSha256: "2".repeat(64),
  releaseId: "rel_20260809T000000Z_111111111111",
  treeSha: "3".repeat(40),
};

function emptyInventory() {
  return normalizeProductionTriggerInventory({
    accountId: spec.accountId,
    environment: spec.environment,
    workerName: spec.workerName,
    queueConsumers: [
      { consumers: [], queueName: spec.resources.integrationQueue },
      { consumers: [], queueName: spec.resources.notificationQueue },
      { consumers: [], queueName: spec.resources.deadLetterQueue },
    ],
    schedules: [],
    activeWorkerVersion: releaseBinding.candidateWorkerVersion,
    configFingerprintSha256: "a".repeat(64),
  });
}

function createdResources(plan: ReturnType<typeof buildProductionTriggerPlan>) {
  return plan.actions.filter((action) => action.action === "create").map((action) => {
    if (action.kind === "cron") {
      if (typeof action.cron !== "string") throw new Error("missing_cron_plan_fixture");
      return { cron: action.cron, kind: "cron" as const };
    }
    if (typeof action.queue !== "string" || typeof action.script !== "string") {
      throw new Error("missing_queue_plan_fixture");
    }
    return { kind: "queue_consumer" as const, queue: action.queue, script: action.script };
  });
}

describe("production trigger ceremony", () => {
  it("defines exactly the reviewed consumers and fifteen-minute cron", () => {
    const desired = desiredProductionTriggerSpec(spec);

    expect(desired.cron).toBe("*/15 * * * *");
    expect(desired.consumers).toHaveLength(3);
    expect(desired.consumers.map((consumer) => consumer.queue)).toEqual([
      spec.resources.integrationQueue,
      spec.resources.notificationQueue,
      spec.resources.deadLetterQueue,
    ]);
    expect(desired.consumers.at(0)?.settings).toEqual({
      batchSize: 10,
      batchTimeout: 5,
      deadLetterQueue: spec.resources.deadLetterQueue,
      maxRetries: 5,
      retryDelaySecs: 60,
    });
    expect(desired.consumers.at(2)?.settings).toEqual({
      batchSize: 10,
      batchTimeout: 5,
      maxRetries: 100,
    });
  });

  it("normalizes the current Cloudflare consumer response without weakening exact settings", () => {
    const desired = desiredProductionTriggerSpec(spec);
    const inventory = normalizeProductionTriggerInventory({
      ...emptyInventory(),
      queueConsumers: desired.consumers.map((consumer) => ({
        consumers: [{
          dead_letter_queue: consumer.settings.deadLetterQueue,
          script: consumer.script,
          settings: {
            batch_size: consumer.settings.batchSize,
            max_retries: consumer.settings.maxRetries,
            retry_delay: consumer.settings.retryDelaySecs ?? 0,
            ...(consumer.settings.batchTimeout === undefined
              ? {}
              : { max_wait_time_ms: consumer.settings.batchTimeout * 1000 }),
          },
        }],
        queueName: consumer.queue,
      })),
      schedules: [CRON],
    });

    const plan = buildProductionTriggerPlan({
      configFingerprintSha256: "a".repeat(64),
      inventory,
      releaseBinding,
      spec,
    });
    expect(plan.actions.every((action) => action.action === "reuse")).toBe(true);

    const drifted = structuredClone(inventory);
    const firstConsumer = drifted.queueConsumers[0]?.consumers[0];
    if (!firstConsumer) throw new Error("missing_consumer_fixture");
    firstConsumer.settings.retryDelaySecs = 61;
    expect(() => buildProductionTriggerPlan({
      configFingerprintSha256: "a".repeat(64),
      inventory: drifted,
      releaseBinding,
      spec,
    })).toThrow("production_trigger_conflict");
  });

  it("produces an exact create-only diff from an idle production inventory", () => {
    const plan = buildProductionTriggerPlan({
      configFingerprintSha256: "a".repeat(64),
      inventory: emptyInventory(),
      releaseBinding,
      spec,
    });

    expect(plan.actions).toHaveLength(4);
    expect(plan.actions.every((action) => action.action === "create")).toBe(true);
    expect(plan.safeguards.allowedMutations).toEqual([
      "queue_consumer_create",
      "worker_cron_trigger_set",
    ]);
  });

  it("fails closed when an existing consumer conflicts with the reviewed worker", () => {
    const inventory = normalizeProductionTriggerInventory({
      ...emptyInventory(),
      queueConsumers: [
        {
          queueName: spec.resources.integrationQueue,
          consumers: [{ script_name: "unreviewed-worker", settings: { batch_size: 10 } }],
        },
        ...emptyInventory().queueConsumers.filter((entry) => entry.queueName !== spec.resources.integrationQueue),
      ],
    });

    expect(() => buildProductionTriggerPlan({
      configFingerprintSha256: "a".repeat(64),
      inventory,
      releaseBinding,
      spec,
    })).toThrow("production_trigger_conflict");
  });

  it("requires explicit confirmation before any apply runner call", async () => {
    const calls: string[][] = [];
    const plan = buildProductionTriggerPlan({
      configFingerprintSha256: "a".repeat(64),
      inventory: emptyInventory(),
      releaseBinding,
      spec,
    });

    await expect(applyProductionTriggerPlan({
      confirmProduction: false,
      configFingerprintSha256: "a".repeat(64),
      inventory: emptyInventory(),
      plan,
      releaseBinding,
      spec,
      runWranglerImplementation: (args: string[]) => {
        calls.push(args);
        return { stderr: "", stdout: "" };
      },
    })).rejects.toThrow("production_trigger_confirmation_required");
    expect(calls).toHaveLength(0);
  });

  it("writes reference-only evidence with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "selinow-trigger-test-"));
    const path = join(directory, "evidence.json");
    const evidence = createProductionTriggerEvidence({
      after: emptyInventory(),
      before: emptyInventory(),
      configFingerprintSha256: "a".repeat(64),
      createdResources: [],
      planSha256: fingerprintProductionTrigger({ ok: true }),
      releaseBinding,
      spec,
    });

    await writeProductionTriggerEvidence(path, evidence);
    const file = await stat(path);
    expect(file.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(parsed.referencesOnly).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("token");
  });

  it("compensates only consumers and cron created by the evidence", async () => {
    const calls: string[][] = [];
    const apiCalls: Array<{ method?: string; body?: unknown }> = [];
    const before = emptyInventory();
    const after = normalizeProductionTriggerInventory({
      ...before,
      queueConsumers: desiredProductionTriggerSpec(spec).consumers.map((consumer) => ({
        queueName: consumer.queue,
        consumers: [{ script_name: spec.workerName, settings: consumer.settings }],
      })),
      schedules: [CRON],
    });
    const evidence = createProductionTriggerEvidence({
      after,
      before,
      configFingerprintSha256: "a".repeat(64),
      createdResources: [
        ...desiredProductionTriggerSpec(spec).consumers.map((consumer) => ({
          kind: "queue_consumer" as const,
          queue: consumer.queue,
          script: spec.workerName,
        })),
        { kind: "cron" as const, cron: CRON },
      ],
      planSha256: buildProductionTriggerPlan({
        configFingerprintSha256: "a".repeat(64),
        inventory: before,
        releaseBinding,
        spec,
      }).fingerprints.planSha256,
      releaseBinding,
      spec,
    });

    await compensateProductionTriggerCeremony({
      confirmProduction: true,
      currentInventory: after,
      evidence,
      requestSchedulesImplementation: async (_token: string, _path: string, options: { body?: unknown; method?: string }) => {
        apiCalls.push(options);
        return [];
      },
      runWranglerImplementation: (args: string[]) => {
        calls.push(args);
        return { stderr: "", stdout: "" };
      },
      spec,
    });

    expect(calls).toHaveLength(3);
    expect(calls.every((args) => args.slice(0, 3).join(" ") === "queues consumer remove")).toBe(true);
    expect(apiCalls).toEqual([{ body: [], method: "PUT" }]);
  });

  it("discovers queues and schedules through injected read-only runners", async () => {
    const calls: string[][] = [];
    const inventory = await discoverProductionTriggerInventory({
      auditToken: "audit-token-for-test",
      configFingerprintSha256: "a".repeat(64),
      fetchImplementation: async (request: RequestInfo | URL) => {
        const url = typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url;
        const result = url.endsWith("/deployments")
          ? { deployments: [{ created_on: "2026-08-09T00:00:00.000Z", versions: [{ percentage: 100, version_id: releaseBinding.candidateWorkerVersion }] }] }
          : { schedules: [] };
        return new Response(JSON.stringify({ success: true, result }), {
          headers: { "content-type": "application/json" },
        });
      },
      runWranglerImplementation: (args: string[]) => {
        calls.push(args);
        if (args[0] === "whoami") return { stderr: "", stdout: JSON.stringify({ accounts: [{ id: spec.accountId }] }) };
        return { stderr: "", stdout: "[]" };
      },
      releaseBinding,
      spec,
    });

    expect(inventory.schedules).toEqual([]);
    expect(calls.filter((args) => args[0] === "queues" && args[1] === "consumer")).toHaveLength(3);
    expect(calls.some((args) => args.includes("add"))).toBe(false);
  });

  it("rejects a reviewed config whose production trigger contract differs", () => {
    expect(() => deriveProductionTriggerConfig(spec, {
      env: {
        production: {
          name: spec.workerName,
          queues: { consumers: [] },
          triggers: { crons: ["0 * * * *"] },
        },
      },
    })).toThrow("production_trigger_config_contract_invalid");
  });

  it("treats an already exact state as an idempotent no-op", async () => {
    const desired = desiredProductionTriggerSpec(spec);
    const current = normalizeProductionTriggerInventory({
      accountId: spec.accountId,
      activeWorkerVersion: releaseBinding.candidateWorkerVersion,
      configFingerprintSha256: "a".repeat(64),
      environment: "production",
      workerName: spec.workerName,
      queueConsumers: desired.consumers.map((consumer) => ({
        queueName: consumer.queue,
        consumers: [{ script_name: consumer.script, settings: consumer.settings }],
      })),
      schedules: [desired.cron],
    });
    const plan = buildProductionTriggerPlan({ configFingerprintSha256: "a".repeat(64), inventory: current, releaseBinding, spec });
    const calls: string[][] = [];
    const result = await applyProductionTriggerPlan({
      confirmProduction: true,
      configFingerprintSha256: "a".repeat(64),
      inventory: current,
      plan,
      releaseBinding,
      runWranglerImplementation: (args: string[]) => {
        calls.push(args);
        return { stderr: "", stdout: "" };
      },
      spec,
    });
    expect(result.createdResources).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("re-verifies the exact post-apply state before writing evidence", async () => {
    const before = emptyInventory();
    const desired = desiredProductionTriggerSpec(spec);
    const after = normalizeProductionTriggerInventory({
      ...before,
      queueConsumers: desired.consumers.map((consumer) => ({
        queueName: consumer.queue,
        consumers: [{ script_name: consumer.script, settings: consumer.settings }],
      })),
      schedules: [desired.cron],
    });
    const plan = buildProductionTriggerPlan({ configFingerprintSha256: "a".repeat(64), inventory: before, releaseBinding, spec });
    let discoveries = 0;
    const commands: string[][] = [];
    const scheduleMutations: Array<{ body?: unknown; method?: string }> = [];
    const evidence = await executeProductionTriggerCeremony({
      apply: true,
      confirmProduction: true,
      configFingerprintSha256: "a".repeat(64),
      discoverInventoryImplementation: async () => (discoveries++ < 5 ? before : after),
      plan,
      releaseBinding,
      requestSchedulesImplementation: async (_token: string, _path: string, options: { body?: unknown; method?: string }) => {
        scheduleMutations.push(options);
        return options.body;
      },
      runWranglerImplementation: (args: string[]) => {
        commands.push(args);
        return { stderr: "", stdout: "" };
      },
      spec,
      writeEvidenceImplementation: async (_path: string, value: unknown) => value,
    });

    expect(evidence.ok).toBe(true);
    expect(evidence.evidence.createdResources).toHaveLength(4);
    expect(evidence.evidence.release).toEqual(releaseBinding);
    expect(commands).toHaveLength(3);
    expect(commands[0]).toEqual(expect.arrayContaining([
      "queues", "consumer", "add", spec.resources.integrationQueue, spec.workerName,
      "--env", "production", "--batch-size", "10", "--batch-timeout", "5",
      "--message-retries", "5", "--dead-letter-queue", spec.resources.deadLetterQueue,
      "--retry-delay-secs", "60",
    ]));
    expect(commands[2]).toEqual(expect.arrayContaining([
      "queues", "consumer", "add", spec.resources.deadLetterQueue, spec.workerName,
      "--message-retries", "100",
    ]));
    expect(scheduleMutations).toEqual([{ body: [{ cron: CRON }], method: "PUT" }]);
  });

  it("accepts provider-added optional consumer defaults after creation", async () => {
    const before = emptyInventory();
    const desired = desiredProductionTriggerSpec(spec);
    const after = normalizeProductionTriggerInventory({
      ...before,
      queueConsumers: desired.consumers.map((consumer) => ({
        queueName: consumer.queue,
        consumers: [{
          script_name: consumer.script,
          settings: { ...consumer.settings, maxConcurrency: 1 },
        }],
      })),
      schedules: [CRON],
    });
    const plan = buildProductionTriggerPlan({
      configFingerprintSha256: "a".repeat(64),
      inventory: before,
      releaseBinding,
      spec,
    });
    const evidence = createProductionTriggerEvidence({
      after,
      before,
      configFingerprintSha256: "a".repeat(64),
      createdResources: createdResources(plan),
      planSha256: plan.fingerprints.planSha256,
      releaseBinding,
      spec,
    });

    const directory = await mkdtemp(join(tmpdir(), "selinow-trigger-defaults-"));
    await expect(writeProductionTriggerEvidence(join(directory, "evidence.json"), evidence)).resolves.toBeTruthy();
  });

  it("rejects trigger activation when the admitted candidate is not active", () => {
    const inventory = normalizeProductionTriggerInventory({
      ...emptyInventory(),
      activeWorkerVersion: "22222222-2222-4222-8222-222222222222",
    });
    expect(() => buildProductionTriggerPlan({
      configFingerprintSha256: "a".repeat(64),
      inventory,
      releaseBinding,
      spec,
    })).toThrow("production_trigger_active_worker_version_mismatch");
  });

  it("propagates the full discovery context through the real apply path", async () => {
    const desired = desiredProductionTriggerSpec(spec);
    const consumers = new Map(desired.consumers.map((consumer) => [consumer.queue, [] as Array<{ script: string; settings: typeof consumer.settings }>]));
    let schedules: string[] = [];
    const commands: string[][] = [];
    const runner = (args: string[]) => {
      commands.push(args);
      if (args[0] === "whoami") return { stderr: "", stdout: JSON.stringify({ accounts: [{ id: spec.accountId }] }) };
      const operation = args[2];
      const queue = args[3] ?? "";
      if (operation === "list") return { stderr: "", stdout: JSON.stringify(consumers.get(queue) ?? []) };
      if (operation === "add") {
        const expected = desired.consumers.find((consumer) => consumer.queue === queue);
        if (!expected) throw new Error("unexpected_queue_add");
        consumers.set(queue, [{ script: expected.script, settings: expected.settings }]);
      } else if (operation === "remove") {
        consumers.set(queue, []);
      }
      return { stderr: "", stdout: "" };
    };
    const request = async (_token: string, path: string, options: { body?: Array<{ cron: string }>; method?: string } = {}) => {
      if (path.endsWith("/deployments")) {
        return { deployments: [{ created_on: "2026-08-09T00:00:00.000Z", versions: [{ percentage: 100, version_id: releaseBinding.candidateWorkerVersion }] }] };
      }
      if (options.method === "PUT") schedules = (options.body ?? []).map((entry) => entry.cron);
      return { schedules };
    };

    const result = await executeProductionTriggerCeremony({
      apply: true,
      auditToken: "audit-token-for-test",
      confirmProduction: true,
      configFingerprintSha256: "a".repeat(64),
      mutationToken: "mutation-token-for-test",
      releaseBinding,
      requestSchedulesImplementation: request,
      runWranglerImplementation: runner,
      spec,
    });

    expect(result.ok).toBe(true);
    expect(result.evidence.createdResources).toHaveLength(4);
    expect(schedules).toEqual([CRON]);
    expect(commands.filter((args) => args[2] === "add")).toHaveLength(3);
  });

  it("rejects a forged plan before invoking mutation runners", async () => {
    const calls: string[][] = [];
    const plan = buildProductionTriggerPlan({
      configFingerprintSha256: "a".repeat(64),
      inventory: emptyInventory(),
      releaseBinding,
      spec,
    });
    const firstAction = plan.actions[0];
    if (firstAction?.kind !== "queue_consumer" || firstAction.settings === undefined) throw new Error("missing_queue_plan_fixture");
    firstAction.settings.maxRetries = 99;

    await expect(applyProductionTriggerPlan({
      confirmProduction: true,
      configFingerprintSha256: "a".repeat(64),
      inventory: emptyInventory(),
      plan,
      releaseBinding,
      runWranglerImplementation: (args: string[]) => {
        calls.push(args);
        return { stderr: "", stdout: "" };
      },
      spec,
    })).rejects.toThrow("production_trigger_plan_contents_mismatch");
    expect(calls).toEqual([]);
  });

  it("rejects a concurrent queue consumer before adding a duplicate", async () => {
    const desired = desiredProductionTriggerSpec(spec);
    const raced = normalizeProductionTriggerInventory({
      ...emptyInventory(),
      queueConsumers: emptyInventory().queueConsumers.map((entry) => entry.queueName === spec.resources.integrationQueue
        ? { consumers: [{ script: spec.workerName, settings: desired.consumers[0]?.settings }], queueName: entry.queueName }
        : entry),
    });
    const plan = buildProductionTriggerPlan({
      configFingerprintSha256: "a".repeat(64),
      inventory: emptyInventory(),
      releaseBinding,
      spec,
    });
    const calls: string[][] = [];

    await expect(applyProductionTriggerPlan({
      confirmProduction: true,
      configFingerprintSha256: "a".repeat(64),
      discoverInventoryImplementation: async () => raced,
      inventory: emptyInventory(),
      plan,
      releaseBinding,
      runWranglerImplementation: (args: string[]) => {
        calls.push(args);
        return { stderr: "", stdout: "" };
      },
      spec,
    })).rejects.toThrow("production_trigger_queue_precondition_changed");
    expect(calls).toEqual([]);
  });

  it("refuses rollback instead of clearing a concurrent unrelated schedule", async () => {
    const before = emptyInventory();
    const desired = desiredProductionTriggerSpec(spec);
    const after = normalizeProductionTriggerInventory({
      ...before,
      queueConsumers: desired.consumers.map((consumer) => ({
        consumers: [{ script: consumer.script, settings: consumer.settings }],
        queueName: consumer.queue,
      })),
      schedules: [CRON],
    });
    const plan = buildProductionTriggerPlan({ configFingerprintSha256: "a".repeat(64), inventory: before, releaseBinding, spec });
    const evidence = createProductionTriggerEvidence({
      after,
      before,
      configFingerprintSha256: "a".repeat(64),
      createdResources: createdResources(plan),
      planSha256: plan.fingerprints.planSha256,
      releaseBinding,
      spec,
    });
    const raced = normalizeProductionTriggerInventory({ ...after, schedules: [CRON, "0 * * * *"] });
    const calls: string[][] = [];
    const apiCalls: unknown[] = [];

    await expect(compensateProductionTriggerCeremony({
      confirmProduction: true,
      currentInventory: after,
      discoverInventoryImplementation: async () => raced,
      evidence,
      requestSchedulesImplementation: async (...args: unknown[]) => {
        apiCalls.push(args);
        return [];
      },
      runWranglerImplementation: (args: string[]) => {
        calls.push(args);
        return { stderr: "", stdout: "" };
      },
      spec,
    })).rejects.toThrow("production_trigger_schedule_rollback_conflict");
    expect(calls).toEqual([]);
    expect(apiCalls).toEqual([]);
  });

  it("rejects tampered rollback resources and plan fingerprints", async () => {
    const before = emptyInventory();
    const desired = desiredProductionTriggerSpec(spec);
    const after = normalizeProductionTriggerInventory({
      ...before,
      queueConsumers: desired.consumers.map((consumer) => ({
        consumers: [{ script: consumer.script, settings: consumer.settings }],
        queueName: consumer.queue,
      })),
      schedules: [CRON],
    });
    const plan = buildProductionTriggerPlan({ configFingerprintSha256: "a".repeat(64), inventory: before, releaseBinding, spec });
    const base = createProductionTriggerEvidence({
      after,
      before,
      configFingerprintSha256: "a".repeat(64),
      createdResources: createdResources(plan),
      planSha256: plan.fingerprints.planSha256,
      releaseBinding,
      spec,
    });
    const resourcesTampered = structuredClone(base);
    const firstResource = resourcesTampered.createdResources[0];
    if (firstResource?.kind !== "queue_consumer") throw new Error("missing_resource_fixture");
    firstResource.queue = "selinow-unreviewed-production";
    await expect(compensateProductionTriggerCeremony({
      confirmProduction: true,
      currentInventory: after,
      evidence: resourcesTampered,
      spec,
    })).rejects.toThrow("production_trigger_evidence_resources_mismatch");

    const planTampered = structuredClone(base);
    planTampered.planSha256 = "f".repeat(64);
    await expect(compensateProductionTriggerCeremony({
      confirmProduction: true,
      currentInventory: after,
      evidence: planTampered,
      spec,
    })).rejects.toThrow("production_trigger_evidence_plan_mismatch");
  });

  it("binds trigger activation to a clean exact production release manifest", () => {
    const configFingerprint = "a".repeat(64);
    const evidence = {
      candidateWorkerVersion: releaseBinding.candidateWorkerVersion,
      commitSha: releaseBinding.commitSha,
      environment: "production",
      releaseId: releaseBinding.releaseId,
      schemaVersion: 2,
      treeSha: releaseBinding.treeSha,
    };
    const manifest = {
      candidateWorkerVersion: releaseBinding.candidateWorkerVersion,
      commitSha: releaseBinding.commitSha,
      configFingerprintSha256: configFingerprint,
      environment: "production",
      releaseId: releaseBinding.releaseId,
      schemaVersion: 2,
      treeSha: releaseBinding.treeSha,
    };
    expect(validateProductionTriggerReleaseManifest({
      evidence,
      manifest,
      manifestSha256: releaseBinding.manifestSha256,
      releaseConfigFingerprintSha256: configFingerprint,
      repositoryState: { clean: true, commitSha: releaseBinding.commitSha, treeSha: releaseBinding.treeSha },
    })).toEqual(releaseBinding);

    expect(() => validateProductionTriggerReleaseManifest({
      evidence,
      manifest: { ...manifest, configFingerprintSha256: "b".repeat(64) },
      manifestSha256: releaseBinding.manifestSha256,
      releaseConfigFingerprintSha256: configFingerprint,
      repositoryState: { clean: true, commitSha: releaseBinding.commitSha, treeSha: releaseBinding.treeSha },
    })).toThrow("production_trigger_release_binding_mismatch");
    expect(() => validateProductionTriggerReleaseManifest({
      evidence,
      manifest,
      manifestSha256: releaseBinding.manifestSha256,
      releaseConfigFingerprintSha256: configFingerprint,
      repositoryState: { clean: false, commitSha: releaseBinding.commitSha, treeSha: releaseBinding.treeSha },
    })).toThrow("production_trigger_source_dirty");
  });
});
