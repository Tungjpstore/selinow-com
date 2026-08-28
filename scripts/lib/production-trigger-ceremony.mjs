import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { runWrangler } from "./cli.mjs";
import { cloudflareApiRequest } from "./platform.mjs";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const SAFE_RESOURCE_PATTERN = /^selinow-[a-z0-9-]+$/u;
const SAFE_WORKER_PATTERN = /^selinow-com-[a-z0-9-]+$/u;
const SAFE_SCRIPT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const REQUIRED_CRON = "*/15 * * * *";
const SCHEMA_VERSION = 1;
const ALLOWED_MUTATIONS = ["queue_consumer_create", "worker_cron_trigger_set"];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}

export function fingerprintProductionTrigger(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function assertAccountId(accountId, code = "production_trigger_account_id_invalid") {
  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) throw new Error(code);
}

function assertSha256(value, code = "production_trigger_fingerprint_invalid") {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(code);
}

function normalizeReleaseBinding(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object"
    || typeof value.releaseId !== "string"
    || !RELEASE_ID_PATTERN.test(value.releaseId)
    || typeof value.commitSha !== "string"
    || !SHA1_PATTERN.test(value.commitSha)
    || typeof value.treeSha !== "string"
    || !SHA1_PATTERN.test(value.treeSha)
    || typeof value.manifestSha256 !== "string"
    || !SHA256_PATTERN.test(value.manifestSha256)
    || typeof value.manifestRef !== "string"
    || value.manifestRef !== `.wrangler/releases/${value.releaseId}/release-manifest.json`
    || typeof value.candidateWorkerVersion !== "string"
    || !UUID_PATTERN.test(value.candidateWorkerVersion)) {
    throw new Error("production_trigger_release_binding_invalid");
  }
  return {
    candidateWorkerVersion: value.candidateWorkerVersion,
    commitSha: value.commitSha,
    manifestRef: value.manifestRef,
    manifestSha256: value.manifestSha256,
    releaseId: value.releaseId,
    treeSha: value.treeSha,
  };
}

export function normalizeProductionTriggerReleaseBinding(value) {
  return normalizeReleaseBinding(value);
}

function assertResourceName(value, code = "production_trigger_resource_invalid") {
  if (typeof value !== "string" || !SAFE_RESOURCE_PATTERN.test(value)) throw new Error(code);
}

function assertWorkerName(value, code = "production_trigger_worker_invalid") {
  if (typeof value !== "string" || !SAFE_WORKER_PATTERN.test(value)) throw new Error(code);
}

function assertScriptName(value, code = "production_trigger_consumer_script_invalid") {
  if (typeof value !== "string" || !SAFE_SCRIPT_PATTERN.test(value)) throw new Error(code);
}

function normalizeSetting(value, aliases) {
  for (const alias of aliases) {
    if (value?.[alias] !== undefined) return value[alias];
  }
  return undefined;
}

function normalizeConsumer(raw) {
  if (raw === null || typeof raw !== "object") {
    throw new Error("production_trigger_consumer_inventory_invalid");
  }
  const script = normalizeSetting(raw, ["script", "script_name", "scriptName", "worker", "worker_name"]);
  assertScriptName(script);
  const rawSettings = raw.settings ?? raw;
  if (rawSettings === null || typeof rawSettings !== "object") {
    throw new Error("production_trigger_consumer_settings_invalid");
  }
  const rawBatchTimeout = normalizeSetting(rawSettings, ["batchTimeout", "batch_timeout", "max_batch_timeout"]);
  const rawMaxWaitMs = normalizeSetting(rawSettings, ["maxWaitTimeMs", "max_wait_time_ms"]);
  const batchTimeout = rawBatchTimeout !== undefined
    ? rawBatchTimeout
    : Number.isInteger(rawMaxWaitMs) && rawMaxWaitMs > 0 && rawMaxWaitMs % 1000 === 0
      ? rawMaxWaitMs / 1000
      : undefined;
  const rawRetryDelay = normalizeSetting(rawSettings, ["retryDelaySecs", "retry_delay_secs", "retry_delay"]);
  const settings = {
    batchSize: normalizeSetting(rawSettings, ["batchSize", "batch_size", "max_batch_size"]),
    batchTimeout,
    deadLetterQueue: normalizeSetting(rawSettings, ["deadLetterQueue", "dead_letter_queue"])
      ?? normalizeSetting(raw, ["deadLetterQueue", "dead_letter_queue"]),
    maxRetries: normalizeSetting(rawSettings, ["maxRetries", "max_retries", "messageRetries"]),
    maxConcurrency: normalizeSetting(rawSettings, ["maxConcurrency", "max_concurrency"]),
    retryDelaySecs: rawRetryDelay === 0 ? undefined : rawRetryDelay,
  };
  for (const key of Object.keys(settings)) {
    if (settings[key] === undefined) delete settings[key];
  }
  if (settings.deadLetterQueue !== undefined) assertResourceName(settings.deadLetterQueue);
  for (const key of ["batchSize", "batchTimeout", "maxRetries", "maxConcurrency", "retryDelaySecs"]) {
    if (settings[key] !== undefined && (!Number.isInteger(settings[key]) || settings[key] < 1)) {
      throw new Error("production_trigger_consumer_settings_invalid");
    }
  }
  return { script, settings };
}

function normalizeQueueConsumers(value) {
  if (!Array.isArray(value)) throw new Error("production_trigger_queue_inventory_invalid");
  const seen = new Set();
  return value.map((entry) => {
    const queueName = entry?.queueName ?? entry?.queue_name ?? entry?.queue;
    assertResourceName(queueName, "production_trigger_queue_inventory_invalid");
    if (seen.has(queueName)) throw new Error("production_trigger_queue_inventory_duplicate");
    seen.add(queueName);
    if (!Array.isArray(entry?.consumers)) throw new Error("production_trigger_consumer_inventory_invalid");
    return {
      consumers: entry.consumers.map(normalizeConsumer),
      queueName,
    };
  }).sort((left, right) => left.queueName.localeCompare(right.queueName));
}

function normalizeSchedules(value) {
  if (!Array.isArray(value)) throw new Error("production_trigger_schedule_inventory_invalid");
  const schedules = value.map((entry) => {
    const cron = typeof entry === "string" ? entry : entry?.cron;
    if (typeof cron !== "string" || cron.trim() !== cron || cron.length < 5 || cron.length > 100) {
      throw new Error("production_trigger_schedule_inventory_invalid");
    }
    return cron;
  }).sort();
  if (new Set(schedules).size !== schedules.length) {
    throw new Error("production_trigger_schedule_inventory_duplicate");
  }
  return schedules;
}

export function normalizeProductionTriggerInventory(input) {
  if (input?.environment !== "production") throw new Error("production_trigger_environment_invalid");
  assertAccountId(input.accountId);
  assertWorkerName(input.workerName);
  assertSha256(input.configFingerprintSha256);
  const queueConsumers = normalizeQueueConsumers(input.queueConsumers);
  const queueNames = queueConsumers.map((entry) => entry.queueName);
  if (new Set(queueNames).size !== 3) throw new Error("production_trigger_queue_inventory_incomplete");
  return {
    accountId: input.accountId,
    activeWorkerVersion: input.activeWorkerVersion === undefined
      ? null
      : (typeof input.activeWorkerVersion === "string" && UUID_PATTERN.test(input.activeWorkerVersion)
        ? input.activeWorkerVersion
        : (() => { throw new Error("production_trigger_active_worker_version_invalid"); })()),
    configFingerprintSha256: input.configFingerprintSha256,
    environment: "production",
    observedAt: typeof input.observedAt === "string" ? input.observedAt : new Date().toISOString(),
    queueConsumers,
    schedules: normalizeSchedules(input.schedules),
    workerName: input.workerName,
  };
}

function normalizeSpec(spec) {
  if (spec?.environment !== "production") throw new Error("production_trigger_environment_invalid");
  assertAccountId(spec.accountId);
  assertWorkerName(spec.workerName);
  if (spec.cron !== undefined && spec.cron !== REQUIRED_CRON) {
    throw new Error("production_trigger_cron_contract_invalid");
  }
  const resources = spec.resources ?? {};
  for (const key of ["integrationQueue", "notificationQueue", "deadLetterQueue"]) {
    assertResourceName(resources[key]);
  }
  if (new Set([resources.integrationQueue, resources.notificationQueue, resources.deadLetterQueue]).size !== 3) {
    throw new Error("production_trigger_queue_contract_invalid");
  }
  return {
    accountId: spec.accountId,
    environment: "production",
    resources: {
      deadLetterQueue: resources.deadLetterQueue,
      integrationQueue: resources.integrationQueue,
      notificationQueue: resources.notificationQueue,
    },
    workerName: spec.workerName,
    cron: REQUIRED_CRON,
  };
}

export function desiredProductionTriggerSpec(spec) {
  const normalized = normalizeSpec(spec);
  const { resources } = normalized;
  return {
    accountId: normalized.accountId,
    consumers: [
      {
        queue: resources.integrationQueue,
        script: normalized.workerName,
        settings: {
          batchSize: 10,
          batchTimeout: 5,
          deadLetterQueue: resources.deadLetterQueue,
          maxRetries: 5,
          retryDelaySecs: 60,
        },
      },
      {
        queue: resources.notificationQueue,
        script: normalized.workerName,
        settings: {
          batchSize: 10,
          batchTimeout: 5,
          deadLetterQueue: resources.deadLetterQueue,
          maxRetries: 5,
          retryDelaySecs: 60,
        },
      },
      {
        queue: resources.deadLetterQueue,
        script: normalized.workerName,
        settings: {
          batchSize: 10,
          batchTimeout: 5,
          maxRetries: 100,
        },
      },
    ],
    cron: normalized.cron,
    environment: normalized.environment,
    workerName: normalized.workerName,
  };
}

function configConsumerShape(consumer) {
  const queue = consumer?.queue;
  const settings = consumer ?? {};
  return {
    dead_letter_queue: settings.dead_letter_queue,
    max_batch_size: settings.max_batch_size,
    max_batch_timeout: settings.max_batch_timeout,
    max_retries: settings.max_retries,
    queue,
    retry_delay: settings.retry_delay,
  };
}

function expectedConfigConsumerShape(consumer) {
  const shape = {
    max_batch_size: consumer.settings.batchSize,
    max_batch_timeout: consumer.settings.batchTimeout,
    max_retries: consumer.settings.maxRetries,
    queue: consumer.queue,
  };
  if (consumer.settings.deadLetterQueue !== undefined) {
    shape.dead_letter_queue = consumer.settings.deadLetterQueue;
  }
  if (consumer.settings.retryDelaySecs !== undefined) {
    shape.retry_delay = consumer.settings.retryDelaySecs;
  }
  return shape;
}

export function deriveProductionTriggerConfig(spec, wranglerConfig) {
  const normalizedSpec = normalizeSpec(spec);
  const production = wranglerConfig?.env?.production;
  if (production?.name !== normalizedSpec.workerName
    || !Array.isArray(production?.queues?.consumers)
    || !Array.isArray(production?.triggers?.crons)
    || !isDeepStrictEqual(production.triggers.crons, [REQUIRED_CRON])) {
    throw new Error("production_trigger_config_contract_invalid");
  }
  const desired = desiredProductionTriggerSpec(normalizedSpec);
  const configured = production.queues.consumers.map(configConsumerShape).map(canonicalize)
    .sort((left, right) => String(left.queue).localeCompare(String(right.queue)));
  const expected = desired.consumers.map(expectedConfigConsumerShape)
    .sort((left, right) => left.queue.localeCompare(right.queue));
  if (!isDeepStrictEqual(configured, expected)) {
    throw new Error("production_trigger_config_contract_invalid");
  }
  return {
    configFingerprintSha256: fingerprintProductionTrigger({
      consumers: expected,
      cron: REQUIRED_CRON,
      environment: "production",
      workerName: normalizedSpec.workerName,
    }),
    releaseConfigFingerprintSha256: fingerprintProductionTrigger({
      production,
      productionSpec: spec,
    }),
    spec: normalizedSpec,
  };
}

function settingsMatch(actual, desired) {
  return Object.entries(desired).every(([key, value]) => actual?.[key] === value)
    && Object.keys(actual ?? {}).every((key) => Object.prototype.hasOwnProperty.call(desired, key)
      || key === "maxConcurrency");
}

function inventoryTriggerShape(inventory) {
  return {
    activeWorkerVersion: inventory.activeWorkerVersion,
    queueConsumers: inventory.queueConsumers,
    schedules: inventory.schedules,
  };
}

function normalizeTriggerSnapshot(snapshot, spec, configFingerprintSha256) {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("production_trigger_evidence_snapshot_invalid");
  }
  return normalizeProductionTriggerInventory({
    ...snapshot,
    accountId: spec.accountId,
    configFingerprintSha256,
    environment: "production",
    workerName: spec.workerName,
  });
}

function createdResourcesFromPlan(plan) {
  return plan.actions.filter((action) => action.action === "create").map((action) => {
    if (action.kind === "queue_consumer") {
      return { kind: "queue_consumer", queue: action.queue, script: action.script };
    }
    if (action.kind === "cron") return { kind: "cron", cron: action.cron };
    throw new Error("production_trigger_action_kind_invalid");
  });
}

function assertAfterTriggerShape(before, after, plan) {
  if (after.activeWorkerVersion !== before.activeWorkerVersion) {
    throw new Error("production_trigger_evidence_after_mismatch");
  }

  const actionsByQueue = new Map(plan.actions
    .filter((action) => action.kind === "queue_consumer")
    .map((action) => [action.queue, action]));
  for (const beforeQueue of before.queueConsumers) {
    const afterQueue = after.queueConsumers.find((entry) => entry.queueName === beforeQueue.queueName);
    const action = actionsByQueue.get(beforeQueue.queueName);
    if (!afterQueue || action === undefined || afterQueue.queueName !== beforeQueue.queueName) {
      throw new Error("production_trigger_evidence_after_mismatch");
    }

    if (action.action === "reuse") {
      // Reused resources must remain byte-for-byte unchanged; the ceremony has
      // no update scope and must not hide a concurrent operator mutation.
      if (!isDeepStrictEqual(afterQueue, beforeQueue)) {
        throw new Error("production_trigger_evidence_after_mismatch");
      }
      continue;
    }

    if (action.action !== "create"
      || afterQueue.consumers.length !== 1
      || afterQueue.consumers[0]?.script !== action.script
      || !settingsMatch(afterQueue.consumers[0]?.settings, action.settings)) {
      throw new Error("production_trigger_evidence_after_mismatch");
    }
  }

  const createsCron = plan.actions.some((action) => action.action === "create" && action.kind === "cron");
  const expectedSchedules = createsCron ? [REQUIRED_CRON] : before.schedules;
  if (!isDeepStrictEqual(after.schedules, expectedSchedules)) {
    throw new Error("production_trigger_evidence_after_mismatch");
  }
}

function assertInventoryIdentity(inventory, spec, configFingerprintSha256) {
  if (inventory.accountId !== spec.accountId || inventory.workerName !== spec.workerName) {
    throw new Error("production_trigger_inventory_identity_mismatch");
  }
  if (configFingerprintSha256 !== undefined && inventory.configFingerprintSha256 !== configFingerprintSha256) {
    throw new Error("production_trigger_config_fingerprint_mismatch");
  }
}

export function buildProductionTriggerPlan(input) {
  const spec = normalizeSpec(input.spec);
  const inventory = normalizeProductionTriggerInventory(input.inventory);
  assertSha256(input.configFingerprintSha256);
  assertInventoryIdentity(inventory, spec, input.configFingerprintSha256);
  const release = normalizeReleaseBinding(input.releaseBinding);
  if (release === null) throw new Error("production_trigger_release_binding_missing");
  if (release !== null && inventory.activeWorkerVersion !== release.candidateWorkerVersion) {
    throw new Error("production_trigger_active_worker_version_mismatch");
  }
  const desired = desiredProductionTriggerSpec(spec);
  const byQueue = new Map(inventory.queueConsumers.map((entry) => [entry.queueName, entry]));
  const actions = [];
  for (const consumer of desired.consumers) {
    const current = byQueue.get(consumer.queue);
    if (!current) throw new Error(`production_trigger_queue_missing:${consumer.queue}`);
    if (current.consumers.length === 0) {
      actions.push({
        action: "create",
        code: `queue.consumer.${consumer.queue}`,
        kind: "queue_consumer",
        queue: consumer.queue,
        script: consumer.script,
        settings: consumer.settings,
      });
    } else if (current.consumers.length === 1) {
      const [existing] = current.consumers;
      if (existing.script === consumer.script && settingsMatch(existing.settings, consumer.settings)) {
        actions.push({
          action: "reuse",
          code: `queue.consumer.${consumer.queue}`,
          kind: "queue_consumer",
          queue: consumer.queue,
          script: consumer.script,
          settings: consumer.settings,
        });
      } else {
        throw new Error(`production_trigger_conflict:${consumer.queue}`);
      }
    } else {
      throw new Error(`production_trigger_conflict:${consumer.queue}`);
    }
  }

  if (inventory.schedules.length === 0) {
    actions.push({ action: "create", code: "worker.cron.*_15", kind: "cron", cron: REQUIRED_CRON });
  } else if (isDeepStrictEqual(inventory.schedules, [REQUIRED_CRON])) {
    actions.push({ action: "reuse", code: "worker.cron.*_15", kind: "cron", cron: REQUIRED_CRON });
  } else {
    throw new Error("production_trigger_schedule_conflict");
  }

  return {
    actions,
    accountId: spec.accountId,
    configFingerprintSha256: input.configFingerprintSha256,
    environment: "production",
    fingerprints: {
      inventorySha256: fingerprintProductionTrigger(inventoryTriggerShape(inventory)),
      planSha256: fingerprintProductionTrigger({ actions, configFingerprintSha256: input.configFingerprintSha256, release }),
    },
    release: release ?? undefined,
    safeguards: {
      allowedMutations: [...ALLOWED_MUTATIONS],
      confirmation: "--confirm-production",
      defaultMode: "read_only_plan",
      noDeletes: true,
      noUpdates: true,
    },
    schemaVersion: SCHEMA_VERSION,
    workerName: spec.workerName,
  };
}

function parseJsonOutput(output, code) {
  try {
    return JSON.parse(String(output ?? ""));
  } catch {
    throw new Error(code);
  }
}

function accountIdentityMatches(output, accountId) {
  const ids = String(output ?? "").match(/(?<![a-f0-9])[a-f0-9]{32}(?![a-f0-9])/giu) ?? [];
  return ids.map((value) => value.toLowerCase()).includes(accountId.toLowerCase());
}

function unwrapConsumerList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.consumers)) return value.consumers;
  throw new Error("production_trigger_consumer_inventory_invalid");
}

function activeVersionFromDeployments(value) {
  const deployments = Array.isArray(value) ? value : value?.deployments;
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error("production_trigger_deployment_inventory_invalid");
  }
  const sorted = deployments.map((deployment) => {
    const createdAt = Date.parse(String(deployment?.created_on ?? deployment?.createdOn ?? ""));
    if (!Number.isFinite(createdAt)) throw new Error("production_trigger_deployment_inventory_invalid");
    return { createdAt, deployment };
  }).sort((left, right) => right.createdAt - left.createdAt);
  const latest = sorted[0].deployment;
  const version = latest?.versionId
    ?? (Array.isArray(latest?.versions) && latest.versions.length === 1 ? latest.versions[0]?.version_id : null);
  const percentage = latest?.versionId === undefined ? latest?.versions?.[0]?.percentage : 100;
  if (typeof version !== "string" || !UUID_PATTERN.test(version) || percentage !== 100) {
    throw new Error("production_trigger_active_worker_version_invalid");
  }
  return version;
}

export function productionTriggerSchedulePath(spec) {
  const normalized = normalizeSpec(spec);
  return `/accounts/${normalized.accountId}/workers/scripts/${encodeURIComponent(normalized.workerName)}/schedules`;
}

export function validateProductionTriggerReleaseManifest({
  evidence,
  manifest,
  manifestSha256,
  releaseConfigFingerprintSha256,
  repositoryState,
} = {}) {
  if (evidence?.schemaVersion !== 2 || evidence?.environment !== "production") {
    throw new Error("production_trigger_release_evidence_invalid");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)
    || manifest.schemaVersion !== 2 || manifest.environment !== "production") {
    throw new Error("production_trigger_release_manifest_invalid");
  }
  assertSha256(manifestSha256, "production_trigger_release_manifest_hash_invalid");
  assertSha256(releaseConfigFingerprintSha256, "production_trigger_release_config_fingerprint_invalid");
  const release = normalizeReleaseBinding({
    candidateWorkerVersion: evidence.candidateWorkerVersion,
    commitSha: evidence.commitSha,
    manifestRef: `.wrangler/releases/${String(evidence.releaseId ?? "")}/release-manifest.json`,
    manifestSha256,
    releaseId: evidence.releaseId,
    treeSha: evidence.treeSha,
  });
  if (manifest.releaseId !== release.releaseId
    || manifest.commitSha !== release.commitSha
    || manifest.treeSha !== release.treeSha
    || manifest.candidateWorkerVersion !== release.candidateWorkerVersion
    || manifest.configFingerprintSha256 !== releaseConfigFingerprintSha256) {
    throw new Error("production_trigger_release_binding_mismatch");
  }
  if (repositoryState !== undefined) {
    if (repositoryState?.clean !== true) throw new Error("production_trigger_source_dirty");
    if (repositoryState.commitSha !== release.commitSha || repositoryState.treeSha !== release.treeSha) {
      throw new Error("production_trigger_source_binding_mismatch");
    }
  }
  return release;
}

export async function discoverProductionTriggerInventory(input) {
  const spec = normalizeSpec(input.spec);
  assertSha256(input.configFingerprintSha256);
  const runner = input.runWranglerImplementation ?? runWrangler;
  const runnerOptions = input.runnerOptions ?? {};
  const whoami = runner(["whoami", "--json"], runnerOptions).stdout;
  if (!accountIdentityMatches(whoami, spec.accountId)) {
    throw new Error("production_trigger_account_identity_mismatch");
  }
  const queueConsumers = [];
  for (const consumer of desiredProductionTriggerSpec(spec).consumers) {
    const output = runner([
      "queues", "consumer", "list", consumer.queue, "--env", "production", "--json",
    ], runnerOptions).stdout;
    queueConsumers.push({ queueName: consumer.queue, consumers: unwrapConsumerList(parseJsonOutput(output, "production_trigger_consumer_inventory_invalid")) });
  }
  const request = input.requestSchedulesImplementation ?? cloudflareApiRequest;
  if (!input.auditToken && request === cloudflareApiRequest) throw new Error("production_trigger_audit_token_missing");
  const scheduleResult = await request(input.auditToken ?? "injected", productionTriggerSchedulePath(spec), {
    fetchImplementation: input.fetchImplementation,
  });
  const schedules = Array.isArray(scheduleResult) ? scheduleResult : scheduleResult?.schedules;
  const deploymentsResult = await request(input.auditToken ?? "injected", `/accounts/${spec.accountId}/workers/scripts/${encodeURIComponent(spec.workerName)}/deployments`, {
    fetchImplementation: input.fetchImplementation,
  });
  return normalizeProductionTriggerInventory({
    accountId: spec.accountId,
    activeWorkerVersion: activeVersionFromDeployments(deploymentsResult),
    configFingerprintSha256: input.configFingerprintSha256,
    environment: "production",
    observedAt: (input.now ?? new Date()).toISOString(),
    queueConsumers,
    schedules,
    workerName: spec.workerName,
  });
}

function assertPlan(input) {
  if (input?.plan?.schemaVersion !== SCHEMA_VERSION
    || input.plan.environment !== "production"
    || input.plan.accountId !== input.spec.accountId
    || input.plan.workerName !== input.spec.workerName
    || input.plan.configFingerprintSha256 !== input.configFingerprintSha256) {
    throw new Error("production_trigger_plan_identity_mismatch");
  }
  const expectedRelease = normalizeReleaseBinding(input.releaseBinding);
  const planRelease = normalizeReleaseBinding(input.plan.release);
  if (!isDeepStrictEqual(expectedRelease, planRelease)) {
    throw new Error("production_trigger_plan_release_binding_mismatch");
  }
  if (!isDeepStrictEqual(input.plan.safeguards?.allowedMutations, ALLOWED_MUTATIONS)) {
    throw new Error("production_trigger_plan_mutation_scope_invalid");
  }
  const currentFingerprint = fingerprintProductionTrigger(inventoryTriggerShape(input.inventory));
  if (currentFingerprint !== input.plan.fingerprints?.inventorySha256) {
    throw new Error("production_trigger_inventory_changed");
  }
  const expectedPlan = buildProductionTriggerPlan({
    configFingerprintSha256: input.configFingerprintSha256,
    inventory: input.inventory,
    releaseBinding: input.releaseBinding,
    spec: input.spec,
  });
  if (!isDeepStrictEqual(input.plan.actions, expectedPlan.actions)
    || !isDeepStrictEqual(input.plan.fingerprints, expectedPlan.fingerprints)
    || !isDeepStrictEqual(input.plan.safeguards, expectedPlan.safeguards)) {
    throw new Error("production_trigger_plan_contents_mismatch");
  }
}

function queueAddArgs(action, workerName) {
  const args = ["queues", "consumer", "add", action.queue, workerName, "--env", "production", "--batch-size", String(action.settings.batchSize), "--batch-timeout", String(action.settings.batchTimeout), "--message-retries", String(action.settings.maxRetries)];
  if (action.settings.deadLetterQueue !== undefined) {
    args.push("--dead-letter-queue", action.settings.deadLetterQueue);
  }
  if (action.settings.retryDelaySecs !== undefined) {
    args.push("--retry-delay-secs", String(action.settings.retryDelaySecs));
  }
  return args;
}

function queueRemoveArgs(resource) {
  return ["queues", "consumer", "remove", resource.queue, resource.script, "--env", "production"];
}

async function compensateResources(input, resources) {
  const runner = input.runWranglerImplementation ?? runWrangler;
  const queueResources = resources.filter((entry) => entry.kind === "queue_consumer");
  const cron = resources.find((entry) => entry.kind === "cron");

  // The schedules endpoint replaces the complete collection. Refuse to clear
  // it if any schedule other than the ceremony-owned trigger is visible.
  if (cron) {
    let current = input.currentInventory;
    if (typeof input.discoverInventoryImplementation === "function") {
      current = await input.discoverInventoryImplementation({ phase: "before_compensation" });
    }
    if (current !== undefined && current !== null) {
      const normalized = normalizeProductionTriggerInventory(current);
      if (!isDeepStrictEqual(normalized.schedules, [cron.cron])) {
        throw new Error("production_trigger_schedule_rollback_conflict");
      }
    }
  }

  for (const resource of queueResources) {
    if (typeof input.discoverInventoryImplementation === "function") {
      const current = normalizeProductionTriggerInventory(await input.discoverInventoryImplementation({
        phase: "before_queue_compensation",
        queue: resource.queue,
      }));
      const queue = current.queueConsumers.find((entry) => entry.queueName === resource.queue);
      if (!queue || queue.consumers.length !== 1 || queue.consumers[0]?.script !== resource.script) {
        throw new Error(`production_trigger_queue_rollback_conflict:${resource.queue}`);
      }
    } else if (input.currentInventory !== undefined) {
      const current = normalizeProductionTriggerInventory(input.currentInventory);
      const queue = current.queueConsumers.find((entry) => entry.queueName === resource.queue);
      if (!queue || queue.consumers.length !== 1 || queue.consumers[0]?.script !== resource.script) {
        throw new Error(`production_trigger_queue_rollback_conflict:${resource.queue}`);
      }
    }
    runner(queueRemoveArgs(resource), input.runnerOptions);
  }
  if (cron) {
    const request = input.requestSchedulesImplementation ?? cloudflareApiRequest;
    if (!input.mutationToken && request === cloudflareApiRequest) {
      throw new Error("production_trigger_mutation_token_missing");
    }
    await request(input.mutationToken ?? "injected", input.schedulePath ?? productionTriggerSchedulePath(input.spec), {
      body: [],
      method: "PUT",
      fetchImplementation: input.fetchImplementation,
    });
  }
}

export async function applyProductionTriggerPlan(input) {
  if (input.confirmProduction !== true) throw new Error("production_trigger_confirmation_required");
  const spec = normalizeSpec(input.spec);
  const inventory = normalizeProductionTriggerInventory(input.inventory);
  assertSha256(input.configFingerprintSha256);
  assertInventoryIdentity(inventory, spec, input.configFingerprintSha256);
  const release = normalizeReleaseBinding(input.releaseBinding ?? input.plan.release);
  if (release !== null && inventory.activeWorkerVersion !== release.candidateWorkerVersion) {
    throw new Error("production_trigger_active_worker_version_mismatch");
  }
  assertPlan({ ...input, inventory, releaseBinding: release, spec });
  const runner = input.runWranglerImplementation ?? runWrangler;
  const createdResources = [];
  try {
    for (const action of input.plan.actions.filter((entry) => entry.action === "create")) {
      if (action.kind === "queue_consumer") {
        if (typeof input.discoverInventoryImplementation === "function") {
          const latest = normalizeProductionTriggerInventory(await input.discoverInventoryImplementation({
            phase: "before_queue",
            queue: action.queue,
          }));
          const queue = latest.queueConsumers.find((entry) => entry.queueName === action.queue);
          if (!queue || queue.consumers.length !== 0) {
            throw new Error(`production_trigger_queue_precondition_changed:${action.queue}`);
          }
          if (!isDeepStrictEqual(latest.schedules, inventory.schedules)) {
            throw new Error("production_trigger_schedule_precondition_changed");
          }
          if (release !== null && latest.activeWorkerVersion !== release.candidateWorkerVersion) {
            throw new Error("production_trigger_active_worker_version_mismatch");
          }
        }
        runner(queueAddArgs(action, spec.workerName), input.runnerOptions);
        createdResources.push({ kind: "queue_consumer", queue: action.queue, script: action.script });
      } else if (action.kind === "cron") {
        if (inventory.schedules.length !== 0) throw new Error("production_trigger_schedule_precondition_changed");
        if (typeof input.discoverInventoryImplementation === "function") {
          const latest = normalizeProductionTriggerInventory(await input.discoverInventoryImplementation({ phase: "before_cron" }));
          if (latest.schedules.length !== 0) throw new Error("production_trigger_schedule_precondition_changed");
          if (release !== null && latest.activeWorkerVersion !== release.candidateWorkerVersion) {
            throw new Error("production_trigger_active_worker_version_mismatch");
          }
        }
        const request = input.requestSchedulesImplementation ?? cloudflareApiRequest;
        if (!input.mutationToken && request === cloudflareApiRequest) {
          throw new Error("production_trigger_mutation_token_missing");
        }
        await request(input.mutationToken ?? "injected", productionTriggerSchedulePath(spec), {
          body: [{ cron: spec.cron }],
          fetchImplementation: input.fetchImplementation,
          method: "PUT",
        });
        createdResources.push({ kind: "cron", cron: spec.cron });
      } else {
        throw new Error("production_trigger_action_kind_invalid");
      }
    }
  } catch (error) {
    try {
      await compensateResources(input, createdResources);
    } catch {
      // Preserve the original failure; operator can use the evidence-free emergency plan.
    }
    throw error;
  }
  return { createdResources, executed: true, ok: true };
}

export async function executeProductionTriggerCeremony(input) {
  const spec = normalizeSpec(input.spec);
  const discover = input.discoverInventoryImplementation
    ?? ((context = {}) => discoverProductionTriggerInventory({
      ...context,
      auditToken: input.auditToken,
      configFingerprintSha256: input.configFingerprintSha256,
      fetchImplementation: input.fetchImplementation,
      requestSchedulesImplementation: input.requestSchedulesImplementation,
      runWranglerImplementation: input.runWranglerImplementation,
      runnerOptions: input.runnerOptions,
      spec,
    }));
  const before = normalizeProductionTriggerInventory(await discover({
    auditToken: input.auditToken,
    configFingerprintSha256: input.configFingerprintSha256,
    fetchImplementation: input.fetchImplementation,
    requestSchedulesImplementation: input.requestSchedulesImplementation,
    runWranglerImplementation: input.runWranglerImplementation,
    runnerOptions: input.runnerOptions,
    spec,
  }));
  const plan = input.plan ?? buildProductionTriggerPlan({
    configFingerprintSha256: input.configFingerprintSha256,
    inventory: before,
    releaseBinding: input.releaseBinding,
    spec,
  });
  if (input.apply !== true) {
    return { applied: false, before, ok: true, plan };
  }
  const applied = await applyProductionTriggerPlan({
    ...input,
    configFingerprintSha256: input.configFingerprintSha256,
    discoverInventoryImplementation: discover,
    inventory: before,
    plan,
    spec,
  });
  try {
    const after = normalizeProductionTriggerInventory(await discover({
      auditToken: input.auditToken,
      configFingerprintSha256: input.configFingerprintSha256,
      fetchImplementation: input.fetchImplementation,
      requestSchedulesImplementation: input.requestSchedulesImplementation,
      runWranglerImplementation: input.runWranglerImplementation,
      runnerOptions: input.runnerOptions,
      spec,
    }));
    const postPlan = buildProductionTriggerPlan({
      configFingerprintSha256: input.configFingerprintSha256,
      inventory: after,
      releaseBinding: input.releaseBinding ?? plan.release,
      spec,
    });
    if (postPlan.actions.some((action) => action.action === "create")) {
      throw new Error("production_trigger_post_apply_not_ready");
    }
    const evidence = createProductionTriggerEvidence({
      after,
      before,
      configFingerprintSha256: input.configFingerprintSha256,
      createdResources: applied.createdResources,
      planSha256: plan.fingerprints.planSha256,
      releaseBinding: input.releaseBinding ?? plan.release,
      spec,
    });
    const writer = input.writeEvidenceImplementation ?? writeProductionTriggerEvidence;
    const evidencePath = input.evidencePath === undefined
      ? undefined
      : await writer(input.evidencePath, evidence);
    return { after, applied, evidence, evidencePath, ok: true, plan };
  } catch (error) {
    try {
      await compensateResources(input, applied.createdResources);
    } catch {
      // Preserve the verification failure and leave the evidence-free rollback path visible to the operator.
    }
    throw error;
  }
}

function assertEvidence(input) {
  const evidence = input.evidence;
  if (evidence?.schemaVersion !== SCHEMA_VERSION
    || evidence.referencesOnly !== true
    || evidence.environment !== "production"
    || evidence.accountId !== input.spec.accountId
    || evidence.workerName !== input.spec.workerName
    || (input.configFingerprintSha256 !== undefined
      && evidence.configFingerprintSha256 !== input.configFingerprintSha256)
    || !Array.isArray(evidence.createdResources)) {
    throw new Error("production_trigger_evidence_invalid");
  }
  assertSha256(evidence.configFingerprintSha256);
  const release = normalizeReleaseBinding(evidence.release);
  if (release === null) {
    throw new Error("production_trigger_evidence_release_missing");
  }
  if (!evidence.before || !evidence.after) throw new Error("production_trigger_evidence_invalid");
  const before = normalizeTriggerSnapshot(evidence.before, input.spec, evidence.configFingerprintSha256);
  const after = normalizeTriggerSnapshot(evidence.after, input.spec, evidence.configFingerprintSha256);
  if (typeof evidence.planSha256 !== "string" || !SHA256_PATTERN.test(evidence.planSha256)) {
    throw new Error("production_trigger_evidence_plan_invalid");
  }
  const normalizedResources = evidence.createdResources.map((resource) => {
    if (resource?.kind === "queue_consumer") {
      if (!isDeepStrictEqual(Object.keys(resource).sort(), ["kind", "queue", "script"])) {
        throw new Error("production_trigger_evidence_resource_invalid");
      }
      assertResourceName(resource.queue);
      assertWorkerName(resource.script);
      return { kind: "queue_consumer", queue: resource.queue, script: resource.script };
    }
    if (resource?.kind === "cron"
      && isDeepStrictEqual(Object.keys(resource).sort(), ["cron", "kind"])
      && resource.cron === REQUIRED_CRON) {
      return { cron: resource.cron, kind: "cron" };
    }
    throw new Error("production_trigger_evidence_resource_invalid");
  });

  if (input.spec?.resources !== undefined) {
    const expectedPlan = buildProductionTriggerPlan({
      configFingerprintSha256: evidence.configFingerprintSha256,
      inventory: before,
      releaseBinding: release,
      spec: input.spec,
    });
    if (evidence.planSha256 !== expectedPlan.fingerprints.planSha256) {
      throw new Error("production_trigger_evidence_plan_mismatch");
    }
    if (!isDeepStrictEqual(normalizedResources, createdResourcesFromPlan(expectedPlan))) {
      throw new Error("production_trigger_evidence_resources_mismatch");
    }
    // Rebuild the post-state plan so provider-added optional defaults (for
    // example maxConcurrency) remain valid while all required fields stay
    // contract-checked and no update/extra resource slips through.
    const postPlan = buildProductionTriggerPlan({
      configFingerprintSha256: evidence.configFingerprintSha256,
      inventory: after,
      releaseBinding: release,
      spec: input.spec,
    });
    if (postPlan.actions.some((action) => action.action === "create")) {
      throw new Error("production_trigger_evidence_after_mismatch");
    }
    assertAfterTriggerShape(before, after, expectedPlan);
  }
  return { after, before, release, resources: normalizedResources };
}

export function createProductionTriggerEvidence(input) {
  const spec = normalizeSpec(input.spec);
  assertSha256(input.configFingerprintSha256);
  const before = normalizeProductionTriggerInventory(input.before);
  const after = normalizeProductionTriggerInventory(input.after);
  const resources = input.createdResources.map((resource) => {
    if (resource.kind === "queue_consumer") {
      assertResourceName(resource.queue);
      assertWorkerName(resource.script);
      return { kind: resource.kind, queue: resource.queue, script: resource.script };
    }
    if (resource.kind === "cron" && resource.cron === REQUIRED_CRON) return { kind: resource.kind, cron: resource.cron };
    throw new Error("production_trigger_evidence_resource_invalid");
  });
  assertSha256(input.planSha256);
  const release = normalizeReleaseBinding(input.releaseBinding);
  if (release === null) throw new Error("production_trigger_release_binding_missing");
  return {
    accountId: spec.accountId,
    after: inventoryTriggerShape(after),
    before: inventoryTriggerShape(before),
    configFingerprintSha256: input.configFingerprintSha256,
    createdResources: resources,
    environment: "production",
    planSha256: input.planSha256,
    release: release ?? undefined,
    referencesOnly: true,
    schemaVersion: SCHEMA_VERSION,
    workerName: spec.workerName,
    observedAt: new Date().toISOString(),
  };
}

export async function writeProductionTriggerEvidence(path, evidence) {
  if (typeof path !== "string" || path.length === 0) throw new Error("production_trigger_evidence_path_invalid");
  assertEvidence({ evidence, spec: { accountId: evidence.accountId, environment: "production", workerName: evidence.workerName }, configFingerprintSha256: evidence.configFingerprintSha256 });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function compensateProductionTriggerCeremony(input) {
  if (input.confirmProduction !== true) throw new Error("production_trigger_confirmation_required");
  const spec = normalizeSpec(input.spec);
  const current = normalizeProductionTriggerInventory(input.currentInventory);
  const validated = assertEvidence({ ...input, spec });
  if (current.accountId !== spec.accountId || current.workerName !== spec.workerName) {
    throw new Error("production_trigger_rollback_identity_mismatch");
  }
  if (fingerprintProductionTrigger(inventoryTriggerShape(current))
    !== fingerprintProductionTrigger(inventoryTriggerShape(validated.after))) {
    throw new Error("production_trigger_rollback_conflict");
  }
  const resources = validated.resources;
  await compensateResources({
    ...input,
    currentInventory: current,
    schedulePath: input.schedulePath,
  }, resources);
  return { executed: true, ok: true, rolledBackResources: resources };
}

export const PRODUCTION_TRIGGER_CRON = REQUIRED_CRON;
export const PRODUCTION_TRIGGER_ALLOWED_MUTATIONS = [...ALLOWED_MUTATIONS];
