import process from "node:process";

import { parseFlags, writeOutput } from "./lib/cli.mjs";
import { auditTriggerInventory, discoverTriggerInventory, loadTriggerContract } from "./lib/trigger-inventory.mjs";

let environment = "unknown";
try {
  const flags = parseFlags(process.argv.slice(2));
  environment = flags.environment;
  if (!new Set(["staging", "production"]).has(environment)) throw new Error("trigger_inventory_environment_invalid");
  const tokenName = environment === "production"
    ? "CLOUDFLARE_PRODUCTION_TRIGGER_AUDIT_API_TOKEN"
    : "CLOUDFLARE_STAGING_TRIGGER_AUDIT_API_TOKEN";
  const token = process.env[tokenName]?.trim();
  if (!token) throw new Error(`${tokenName.toLowerCase()}_missing`);
  const contract = await loadTriggerContract(environment);
  const live = await discoverTriggerInventory({ contract, token });
  const result = auditTriggerInventory({ contract, queueConsumers: live.queueConsumers, schedules: live.schedules });
  writeOutput({ checks: result.checks, environment, observedAt: live.observedAt, ok: result.ok }, flags.json);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  const message = error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message)
    ? error.message
    : "trigger_inventory_failed";
  writeOutput({ checks: [{ code: "trigger_inventory_failed", detail: message, ok: false }], environment, ok: false }, process.argv.includes("--json"));
  process.exitCode = 1;
}
