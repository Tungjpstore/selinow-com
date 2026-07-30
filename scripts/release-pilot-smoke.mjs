import { resolve } from "node:path";
import process from "node:process";

import { readOptionalJson, runPilotSmoke } from "./lib/release.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

function parseArguments(argv) {
  const options = { confirmProduction: false, execute: false, json: false, planPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-production") options.confirmProduction = true;
    else if (argument === "--execute") options.execute = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--plan") options.planPath = resolve(repositoryRoot, argv[++index] ?? "");
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (options.planPath === null) throw new Error("pilot_plan_required");
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const plan = await readOptionalJson(options.planPath);
  if (plan === null) throw new Error("pilot_plan_missing");
  const result = await runPilotSmoke({
    confirmProduction: options.confirmProduction,
    execute: options.execute,
    plan,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"} production ${result.executed ? "executed" : "plan"}\n`);
    for (const action of result.actions) process.stdout.write(`${action.ok ? "=" : "x"} ${action.name}:${action.code}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(error.message)
    ? error.message
    : "pilot_smoke_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
