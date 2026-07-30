import process from "node:process";

import { parseFlags, writeOutput } from "./lib/cli.mjs";
import { inspectStagingRoutePreflight } from "./lib/platform.mjs";

let environment = "unknown";
try {
  const flags = parseFlags(process.argv.slice(2));
  environment = flags.environment;
  if (flags.environment !== "staging") {
    throw new Error("staging_route_preflight_staging_only");
  }

  const result = await inspectStagingRoutePreflight();
  writeOutput(result, flags.json);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown_error";
  writeOutput({
    checks: [{ code: "staging_route_preflight_failed", detail: message, ok: false }],
    environment,
    ok: false,
  }, process.argv.includes("--json"));
  process.exitCode = 1;
}
