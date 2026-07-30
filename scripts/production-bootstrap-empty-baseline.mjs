import process from "node:process";
import { resolve } from "node:path";

import { runWrangler, writeOutput } from "./lib/cli.mjs";
import {
  parseProductionBootstrapEmptyBaselineFlags,
  runProductionBootstrapEmptyBaselineDrill,
} from "./lib/production-bootstrap-empty-baseline.mjs";
import { repositoryRoot } from "./lib/platform.mjs";
import { readOptionalJson } from "./lib/release.mjs";

const SPEC_PATH = resolve(repositoryRoot, "infra/environments/production.json");
const MANIFEST_PATH = resolve(repositoryRoot, "infra/generated/production.json");
const WRANGLER_PATH = resolve(repositoryRoot, "wrangler.jsonc");

function parseArguments(argv) {
  const flagsArgv = [];
  const options = {
    backupRoot: undefined,
    reportRoot: undefined,
    specPath: SPEC_PATH,
    manifestPath: MANIFEST_PATH,
    wranglerPath: WRANGLER_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--backup-root") options.backupRoot = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--report-root") options.reportRoot = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--spec") options.specPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--manifest") options.manifestPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--wrangler-config") options.wranglerPath = resolve(repositoryRoot, argv[++index] ?? "");
    else flagsArgv.push(argument);
  }
  return { ...parseProductionBootstrapEmptyBaselineFlags(flagsArgv), ...options };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const [productionSpec, generatedManifest, wranglerConfig] = await Promise.all([
    readOptionalJson(options.specPath),
    readOptionalJson(options.manifestPath),
    readOptionalJson(options.wranglerPath),
  ]);
  if (productionSpec === null) throw new Error("production_spec_missing");
  if (generatedManifest === null) throw new Error("production_bootstrap_empty_baseline_generated_identity_missing");
  if (wranglerConfig === null) throw new Error("wrangler_config_invalid");
  const result = await runProductionBootstrapEmptyBaselineDrill({
    backupRoot: options.backupRoot,
    confirmFirstProductionBootstrap: options.confirmFirstProductionBootstrap,
    confirmProduction: options.confirmProduction,
    dryRun: options.dryRun,
    environment: options.environment,
    generatedManifest,
    operatorEnvironment: process.env,
    productionSpec,
    reportRoot: options.reportRoot,
    repositoryRoot,
    runWranglerImplementation: options.execute ? runWrangler : undefined,
    wranglerConfig,
  });
  writeOutput(result, options.json);
} catch (error) {
  const message = error instanceof Error ? error.message : "production_bootstrap_empty_baseline_failed";
  const safeCode = /^[a-z0-9_:.-]{1,220}$/u.test(message) ? message : "production_bootstrap_empty_baseline_failed";
  writeOutput({
    actions: [{ code: safeCode, ok: false }],
    environment: "production",
    ok: false,
  }, process.argv.includes("--json"));
  process.exitCode = 1;
}
