import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  inspectProductionReadiness,
  readOptionalJson,
} from "./lib/release.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

function parseArguments(argv) {
  const options = {
    evidencePath: resolve(repositoryRoot, ".wrangler/release/production-evidence.json"),
    json: false,
    secretNamesPath: null,
    specPath: resolve(repositoryRoot, "infra/environments/production.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--spec") options.specPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--secret-names") options.secretNamesPath = resolve(repositoryRoot, argv[++index] ?? "");
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}

async function loadSecretNames(path) {
  if (path !== null) {
    const value = await readOptionalJson(path);
    if (!Array.isArray(value)) throw new Error("worker_secret_names_invalid");
    return value.filter((name) => typeof name === "string");
  }
  return (process.env.SELINOW_WORKER_SECRET_NAMES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function writeResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({
      checks: result.checks,
      environment: "production",
      missing: result.missing,
      ok: result.ok,
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.ok ? "PASS" : "FAIL"} production\n`);
  for (const check of result.checks) process.stdout.write(`${check.ok ? "=" : "x"} ${check.name}\n`);
}

try {
  const options = parseArguments(process.argv.slice(2));
  const wranglerConfig = JSON.parse(await readFile(resolve(repositoryRoot, "wrangler.jsonc"), "utf8"));
  const result = inspectProductionReadiness({
    evidence: await readOptionalJson(options.evidencePath),
    now: new Date(),
    productionSpec: await readOptionalJson(options.specPath),
    workerSecretNames: await loadSecretNames(options.secretNamesPath),
    wranglerConfig,
  });
  writeResult(result, options.json);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message)
    ? error.message
    : "release_doctor_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
