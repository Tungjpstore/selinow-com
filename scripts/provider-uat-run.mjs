import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runProviderUatScenario } from "./lib/provider-uat-runner.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

export function parseArguments(argv) {
  const options = { executor: null, json: false, manifestPath: null, provider: null, scenarioId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--executor") options.executor = argv[++index] ?? "";
    else if (argument === "--json") options.json = true;
    else if (argument === "--manifest") options.manifestPath = argv[++index] ?? "";
    else if (argument === "--provider") options.provider = argv[++index] ?? "";
    else if (argument === "--scenario") options.scenarioId = argv[++index] ?? "";
    else throw new Error("provider_uat_runner_argument_invalid");
  }
  for (const key of ["executor", "manifestPath", "provider", "scenarioId"]) {
    if (typeof options[key] !== "string" || options[key].length === 0) throw new Error(`provider_uat_runner_${key === "scenarioId" ? "scenario" : key}_required`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  const result = await (dependencies.runProviderUatScenarioImplementation ?? runProviderUatScenario)({
    environment: process.env,
    executor: options.executor,
    manifestPath: options.manifestPath,
    provider: options.provider,
    repositoryRoot,
    scenarioId: options.scenarioId,
  });
  process.stdout.write(options.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `COLLECTED ${result.provider} ${result.scenarioId} ${result.releaseId}; acceptance evidence not written\n`);
  return result;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:,.-]{1,260}$/u.test(error.message)
      ? error.message
      : "provider_uat_runner_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
