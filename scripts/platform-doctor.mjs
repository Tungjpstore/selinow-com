import process from "node:process";

import { parseFlags, writeOutput } from "./lib/cli.mjs";
import { doctor } from "./lib/platform.mjs";

let environment = "unknown";
try {
  const flags = parseFlags(process.argv.slice(2));
  environment = flags.environment;
  const result = await doctor(flags.environment);
  writeOutput(result, flags.json);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown_error";
  writeOutput({ checks: [{ code: "doctor_failed", detail: message, ok: false }], environment, ok: false }, process.argv.includes("--json"));
  process.exitCode = 1;
}
