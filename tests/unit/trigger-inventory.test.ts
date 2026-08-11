import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  auditTriggerInventory,
  deriveTriggerInventoryContract,
  discoverTriggerInventory,
  triggerSchedulePath,
  type TriggerContract,
} from "../../scripts/lib/trigger-inventory.mjs";

const ACCOUNT_ID = "ef250a88911fd24073cb73d1c07e0218";

function fixture(environment: "staging" | "production") {
  const suffix = environment;
  const workerName = `selinow-com-${suffix}`;
  const deadLetterQueue = `selinow-dlq-${suffix}`;
  const integrationQueue = `selinow-integration-${suffix}`;
  const notificationQueue = `selinow-notification-${suffix}`;
  const cron = environment === "staging" ? "* * * * *" : "*/15 * * * *";
  const spec = {
    accountId: ACCOUNT_ID,
    environment,
    resources: { deadLetterQueue, integrationQueue, notificationQueue },
    workerName,
  };
  const wranglerConfig = {
    env: {
      [environment]: {
        name: workerName,
        queues: {
          consumers: [
            {
              dead_letter_queue: deadLetterQueue,
              max_batch_size: 10,
              max_batch_timeout: 5,
              max_retries: 5,
              queue: integrationQueue,
              retry_delay: 60,
            },
            {
              dead_letter_queue: deadLetterQueue,
              max_batch_size: 10,
              max_batch_timeout: 5,
              max_retries: 5,
              queue: notificationQueue,
              retry_delay: 60,
            },
            {
              max_batch_size: 10,
              max_batch_timeout: 5,
              max_retries: 100,
              queue: deadLetterQueue,
            },
          ],
        },
        triggers: { crons: [cron] },
      },
    },
  };
  return { cron, spec, wranglerConfig };
}

function liveInventory(contract: TriggerContract) {
  return {
    queueConsumers: contract.consumers.map((consumer) => ({
      consumers: [{
        consumer_id: "provider-id-must-be-ignored",
        dead_letter_queue: consumer.settings.deadLetterQueue,
        script: consumer.script,
        settings: {
          batch_size: consumer.settings.batchSize,
          max_retries: consumer.settings.maxRetries,
          max_wait_time_ms: Number(consumer.settings.batchTimeout) * 1000,
          retry_delay: consumer.settings.retryDelaySecs ?? 0,
        },
        type: "worker",
      }],
      queueName: consumer.queue,
    })),
    schedules: contract.schedules.map((cron) => ({ cron })),
  };
}

describe("read-only trigger inventory admission", () => {
  it.each(["staging", "production"] as const)("derives the exact %s queue and cron contract", (environment) => {
    const input = fixture(environment);
    const contract = deriveTriggerInventoryContract({ environment, spec: input.spec, wranglerConfig: input.wranglerConfig });

    expect(contract.environment).toBe(environment);
    expect(contract.workerName).toBe(`selinow-com-${environment}`);
    expect(contract.consumers).toHaveLength(3);
    expect(contract.schedules).toEqual([input.cron]);
  });

  it("accepts the live Wrangler aliases and ignores provider-only identifiers", () => {
    const input = fixture("staging");
    const contract = deriveTriggerInventoryContract({ environment: "staging", spec: input.spec, wranglerConfig: input.wranglerConfig });
    const live = liveInventory(contract);

    expect(auditTriggerInventory({ contract, ...live })).toMatchObject({ ok: true });
    expect(JSON.stringify(auditTriggerInventory({ contract, ...live }))).not.toContain("provider-id-must-be-ignored");
  });

  it("fails closed on a missing consumer, a conflicting worker, or cron drift", () => {
    const input = fixture("production");
    const contract = deriveTriggerInventoryContract({ environment: "production", spec: input.spec, wranglerConfig: input.wranglerConfig });
    const live = liveInventory(contract);
    const firstQueue = live.queueConsumers[0];
    if (firstQueue === undefined || firstQueue.consumers[0] === undefined) throw new Error("trigger_fixture_invalid");

    const missing = auditTriggerInventory({ contract, queueConsumers: live.queueConsumers.slice(1), schedules: live.schedules });
    const conflict = auditTriggerInventory({
      contract,
      queueConsumers: [{ ...firstQueue, consumers: [{ ...firstQueue.consumers[0], script: "selinow-com-unreviewed" }] }, ...live.queueConsumers.slice(1)],
      schedules: live.schedules,
    });
    const driftedCron = auditTriggerInventory({ contract, queueConsumers: live.queueConsumers, schedules: [{ cron: "0 * * * *" }] });

    expect(missing.ok).toBe(false);
    expect(conflict.ok).toBe(false);
    expect(driftedCron.ok).toBe(false);
  });

  it("reads only exact queues and the exact Worker schedule endpoint", async () => {
    const input = fixture("staging");
    const contract = deriveTriggerInventoryContract({ environment: "staging", spec: input.spec, wranglerConfig: input.wranglerConfig });
    const live = liveInventory(contract);
    const calls: string[][] = [];
    const inventory = await discoverTriggerInventory({
      contract,
      fetchImplementation: (url) => {
        const observedUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        expect(observedUrl).toContain(triggerSchedulePath(contract));
        return Promise.resolve(new Response(JSON.stringify({ result: live.schedules, success: true }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }));
      },
      now: new Date("2026-08-11T00:00:00.000Z"),
      runWranglerImplementation: (args: string[]) => {
        calls.push(args);
        if (args[0] === "whoami") return { stderr: "", stdout: `Account ID: ${ACCOUNT_ID}` };
        const queue = args[3];
        const row = live.queueConsumers.find((entry) => entry.queueName === queue);
        return { stderr: "", stdout: JSON.stringify(row?.consumers ?? []) };
      },
      token: "temporary-read-token",
    });

    expect(inventory.observedAt).toBe("2026-08-11T00:00:00.000Z");
    expect(calls).toHaveLength(4);
    expect(calls.slice(1).every((args) => args.includes("--json") && args.includes("--env"))).toBe(true);
    expect(auditTriggerInventory({ contract, queueConsumers: inventory.queueConsumers, schedules: inventory.schedules }).ok).toBe(true);
  });

  it("fails without a dedicated token and does not print secret values", () => {
    const result = spawnSync(process.execPath, ["scripts/trigger-inventory.mjs", "--env", "staging", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "CLOUDFLARE_STAGING_TRIGGER_AUDIT_API_TOKEN")),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("cloudflare_staging_trigger_audit_api_token_missing");
    expect(result.stdout).not.toContain("temporary-read-token");
  });
});
