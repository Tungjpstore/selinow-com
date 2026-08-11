import { readFile } from "node:fs/promises";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

import { runWrangler } from "./cli.mjs";
import { cloudflareApiRequest, repositoryRoot } from "./platform.mjs";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const SAFE_WORKER_PATTERN = /^selinow-com-[a-z0-9-]+$/u;
const SAFE_QUEUE_PATTERN = /^selinow-[a-z0-9-]+$/u;
const SUPPORTED_ENVIRONMENTS = new Set(["staging", "production"]);

function parseJson(value, code) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(code);
  }
}

function assertEnvironment(environment) {
  if (!SUPPORTED_ENVIRONMENTS.has(environment)) throw new Error("trigger_inventory_environment_invalid");
}

function assertAccountId(accountId) {
  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("trigger_inventory_account_invalid");
  }
}

function assertWorkerName(workerName) {
  if (typeof workerName !== "string" || !SAFE_WORKER_PATTERN.test(workerName)) {
    throw new Error("trigger_inventory_worker_invalid");
  }
}

function assertQueueName(queueName) {
  if (typeof queueName !== "string" || !SAFE_QUEUE_PATTERN.test(queueName)) {
    throw new Error("trigger_inventory_queue_invalid");
  }
}

function readSetting(value, aliases) {
  for (const alias of aliases) {
    if (value?.[alias] !== undefined) return value[alias];
  }
  return undefined;
}

function normalizeSettings(value) {
  if (value === null || typeof value !== "object") throw new Error("trigger_inventory_consumer_settings_invalid");
  const waitMilliseconds = readSetting(value, ["max_wait_time_ms"]);
  const batchTimeout = readSetting(value, ["batchTimeout", "batch_timeout", "max_batch_timeout"])
    ?? (waitMilliseconds === undefined ? undefined : waitMilliseconds / 1000);
  const settings = {
    batchSize: readSetting(value, ["batchSize", "batch_size", "max_batch_size"]),
    batchTimeout,
    deadLetterQueue: readSetting(value, ["deadLetterQueue", "dead_letter_queue"]),
    maxConcurrency: readSetting(value, ["maxConcurrency", "max_concurrency"]),
    maxRetries: readSetting(value, ["maxRetries", "max_retries", "messageRetries"]),
    retryDelaySecs: readSetting(value, ["retryDelaySecs", "retry_delay_secs", "retry_delay"]),
  };
  if (settings.retryDelaySecs === 0) delete settings.retryDelaySecs;
  for (const key of Object.keys(settings)) {
    if (settings[key] === undefined) delete settings[key];
  }
  if (settings.deadLetterQueue !== undefined) assertQueueName(settings.deadLetterQueue);
  for (const key of ["batchSize", "batchTimeout", "maxConcurrency", "maxRetries", "retryDelaySecs"]) {
    if (settings[key] !== undefined && (!Number.isInteger(settings[key]) || settings[key] < 1)) {
      throw new Error("trigger_inventory_consumer_settings_invalid");
    }
  }
  return settings;
}

function normalizeConsumer(value) {
  if (value === null || typeof value !== "object") throw new Error("trigger_inventory_consumer_invalid");
  const script = readSetting(value, ["script", "script_name", "scriptName", "worker", "worker_name"]);
  assertWorkerName(script);
  return {
    script,
    settings: normalizeSettings(value.settings === undefined ? value : { ...value, ...value.settings }),
  };
}

function normalizeQueueConsumers(value) {
  if (!Array.isArray(value)) throw new Error("trigger_inventory_queue_inventory_invalid");
  const seen = new Set();
  return value.map((entry) => {
    const queueName = entry?.queueName ?? entry?.queue_name ?? entry?.queue;
    assertQueueName(queueName);
    if (seen.has(queueName)) throw new Error("trigger_inventory_queue_duplicate");
    seen.add(queueName);
    if (!Array.isArray(entry?.consumers)) throw new Error("trigger_inventory_consumer_inventory_invalid");
    return {
      consumers: entry.consumers.map(normalizeConsumer),
      queueName,
    };
  }).sort((left, right) => left.queueName.localeCompare(right.queueName));
}

function normalizeSchedules(value) {
  if (!Array.isArray(value)) throw new Error("trigger_inventory_schedule_inventory_invalid");
  const schedules = value.map((entry) => {
    const cron = typeof entry === "string" ? entry : entry?.cron;
    if (typeof cron !== "string" || cron.trim() !== cron || cron.length < 5 || cron.length > 100) {
      throw new Error("trigger_inventory_schedule_invalid");
    }
    return cron;
  }).sort();
  if (new Set(schedules).size !== schedules.length) throw new Error("trigger_inventory_schedule_duplicate");
  return schedules;
}

export function deriveTriggerInventoryContract({ environment, spec, wranglerConfig } = {}) {
  assertEnvironment(environment);
  if (spec?.environment !== environment) throw new Error("trigger_inventory_spec_environment_invalid");
  assertAccountId(spec.accountId);
  assertWorkerName(spec.workerName);
  const config = wranglerConfig?.env?.[environment];
  if (config?.name !== spec.workerName) throw new Error("trigger_inventory_worker_mismatch");
  const configuredConsumers = config?.queues?.consumers;
  if (!Array.isArray(configuredConsumers)) throw new Error("trigger_inventory_config_consumers_missing");
  const resources = spec.resources ?? {};
  const expectedQueues = [resources.integrationQueue, resources.notificationQueue, resources.deadLetterQueue];
  if (expectedQueues.some((queue) => typeof queue !== "string") || new Set(expectedQueues).size !== 3) {
    throw new Error("trigger_inventory_spec_queues_invalid");
  }
  const consumers = configuredConsumers.map((consumer) => {
    const queue = consumer?.queue;
    assertQueueName(queue);
    if (!expectedQueues.includes(queue)) throw new Error("trigger_inventory_config_queue_invalid");
    return {
      queue,
      script: spec.workerName,
      settings: normalizeSettings(consumer),
    };
  });
  if (consumers.length !== expectedQueues.length || new Set(consumers.map((consumer) => consumer.queue)).size !== consumers.length) {
    throw new Error("trigger_inventory_config_consumers_incomplete");
  }
  const schedules = normalizeSchedules(config?.triggers?.crons);
  if (schedules.length !== 1) throw new Error("trigger_inventory_config_schedule_invalid");
  return {
    accountId: spec.accountId,
    consumers: consumers.sort((left, right) => left.queue.localeCompare(right.queue)),
    environment,
    schedules,
    workerName: spec.workerName,
  };
}

export function auditTriggerInventory({ contract, queueConsumers, schedules } = {}) {
  if (contract === null || typeof contract !== "object") throw new Error("trigger_inventory_contract_required");
  const actualConsumers = normalizeQueueConsumers(queueConsumers);
  const actualSchedules = normalizeSchedules(schedules);
  const expectedConsumers = contract.consumers.map((consumer) => ({
    consumers: [{ script: consumer.script, settings: consumer.settings }],
    queueName: consumer.queue,
  }));
  const checks = contract.consumers.map((expected) => {
    const actual = actualConsumers.find((entry) => entry.queueName === expected.queue);
    const ok = actual !== undefined && isDeepStrictEqual(actual, {
      consumers: [{ script: expected.script, settings: expected.settings }],
      queueName: expected.queue,
    });
    return {
      code: `trigger_queue_${expected.queue.replace(/[^a-z0-9]+/giu, "_")}`,
      detail: ok ? "Queue consumer matches the checked-in Worker contract" : "Queue consumer is missing or drifted",
      ok,
    };
  });
  const cronMatches = isDeepStrictEqual(actualSchedules, contract.schedules);
  checks.push({
    code: "trigger_cron_schedule",
    detail: cronMatches ? "Cron schedule matches the checked-in Worker contract" : "Cron schedule is missing, duplicated, or drifted",
    ok: cronMatches,
  });
  const allowlistMatches = actualConsumers.length === expectedConsumers.length
    && actualConsumers.every((entry) => expectedConsumers.some((expected) => expected.queueName === entry.queueName));
  checks.push({
    code: "trigger_inventory_allowlist",
    detail: allowlistMatches ? "Trigger inventory contains only the reviewed queue set" : "Trigger inventory contains extra or missing queues",
    ok: allowlistMatches,
  });
  return { checks, ok: checks.every((check) => check.ok) };
}

function unwrapConsumerList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.consumers)) return value.consumers;
  throw new Error("trigger_inventory_consumer_inventory_invalid");
}

function accountIdentityMatches(output, accountId) {
  if (String(output).includes(accountId)) return true;
  try {
    const parsed = JSON.parse(String(output));
    return parsed?.loggedIn === true
      && parsed?.authType === "User API Token"
      && Array.isArray(parsed.accounts)
      && parsed.accounts.length === 0;
  } catch {
    return false;
  }
}

function buildAuditEnvironment(token, accountId) {
  return {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: token,
    ...(typeof process.env.HOME === "string" ? { HOME: process.env.HOME } : {}),
    ...(typeof process.env.PATH === "string" ? { PATH: process.env.PATH } : {}),
  };
}

export function triggerSchedulePath(contract) {
  assertEnvironment(contract?.environment);
  assertAccountId(contract.accountId);
  assertWorkerName(contract.workerName);
  return `/accounts/${contract.accountId}/workers/scripts/${encodeURIComponent(contract.workerName)}/schedules`;
}

export async function discoverTriggerInventory({ contract, token, runWranglerImplementation = runWrangler, fetchImplementation, now = new Date() } = {}) {
  if (typeof token !== "string" || token.trim().length === 0) throw new Error("trigger_inventory_audit_token_missing");
  const environment = buildAuditEnvironment(token, contract.accountId);
  const runnerOptions = { cwd: repositoryRoot, env: environment };
  const whoami = runWranglerImplementation(["whoami", "--json"], runnerOptions).stdout;
  if (!accountIdentityMatches(whoami, contract.accountId)) throw new Error("trigger_inventory_account_mismatch");
  const queueConsumers = [];
  for (const expected of contract.consumers) {
    const output = runWranglerImplementation([
      "queues", "consumer", "list", expected.queue, "--env", contract.environment, "--json",
    ], runnerOptions).stdout;
    queueConsumers.push({
      consumers: unwrapConsumerList(parseJson(output, "trigger_inventory_consumer_inventory_invalid")),
      queueName: expected.queue,
    });
  }
  const schedulesResult = await cloudflareApiRequest(token, triggerSchedulePath(contract), { fetchImplementation });
  const schedules = Array.isArray(schedulesResult) ? schedulesResult : schedulesResult?.schedules;
  if (!Array.isArray(schedules)) throw new Error("trigger_inventory_schedule_inventory_invalid");
  return {
    accountId: contract.accountId,
    environment: contract.environment,
    observedAt: now.toISOString(),
    queueConsumers,
    schedules,
    workerName: contract.workerName,
  };
}

export async function loadTriggerContract(environment, root = repositoryRoot) {
  assertEnvironment(environment);
  const [spec, wranglerConfig] = await Promise.all([
    readFile(`${root}/infra/environments/${environment}.json`, "utf8").then((text) => parseJson(text, "trigger_inventory_spec_invalid")),
    readFile(`${root}/wrangler.jsonc`, "utf8").then((text) => parseJson(text, "trigger_inventory_wrangler_invalid")),
  ]);
  return deriveTriggerInventoryContract({ environment, spec, wranglerConfig });
}
