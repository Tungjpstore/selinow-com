import process from "node:process";

import { parseFlags, writeOutput } from "./lib/cli.mjs";
import { provision } from "./lib/platform.mjs";

let environment = "unknown";
try {
  const flags = parseFlags(process.argv.slice(2));
  environment = flags.environment;
  const result = await provision(flags.environment, flags.dryRun);
  writeOutput(result, flags.json);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown_error";
  writeOutput({ actions: [{ code: "provision_failed", detail: message, ok: false }], environment, ok: false }, process.argv.includes("--json"));
  process.exitCode = 1;
}
