import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { parseFlags, writeOutput } from "./lib/cli.mjs";
import { repositoryRoot } from "./lib/platform.mjs";
import { createStagingPhaseASmokePlan, runStagingPhaseASmoke } from "./lib/staging-smoke.mjs";

async function readStagingSpec() {
  const source = await readFile(resolve(repositoryRoot, "infra/environments/staging.json"), "utf8");
  return JSON.parse(source);
}

let environment = "unknown";
try {
  const flags = parseFlags(process.argv.slice(2));
  environment = flags.environment;
  if (flags.environment !== "staging") throw new Error("staging_phase_a_smoke_staging_only");
  const result = await runStagingPhaseASmoke({ plan: createStagingPhaseASmokePlan(await readStagingSpec()) });
  writeOutput(result, flags.json);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown_error";
  writeOutput({ actions: [{ code: "staging_phase_a_smoke_failed", detail: message, ok: false }], environment, ok: false, readOnly: true }, process.argv.includes("--json"));
  process.exitCode = 1;
}
