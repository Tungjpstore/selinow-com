import { spawnSync } from "node:child_process";
import process from "node:process";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { writeOutput } from "./lib/cli.mjs";
import {
  assertProductionBootstrapExecutionAdmission,
  buildProductionBootstrapPlan,
  writeProductionBootstrapPlan,
} from "./lib/production-bootstrap.mjs";
import { listMigrationNames, readOptionalJson } from "./lib/release.mjs";
import { repositoryRoot } from "./lib/platform.mjs";
import { assertProductionPromotionStagingContract } from "./lib/production-promotion-staging.mjs";

const DEFAULT_STAGING_SPEC_PATH = resolve(repositoryRoot, "infra/environments/staging.json");
const DEFAULT_PROMOTION_STAGING_SPEC_PATH = resolve(
  repositoryRoot,
  "infra/release/production-promotion-staging.json",
);

function parseArguments(argv) {
  const options = {
    confirmFirstProductionBootstrap: false,
    confirmProduction: false,
    evidencePath: resolve(repositoryRoot, ".wrangler/bootstrap/production-evidence.json"),
    inventoryPath: resolve(repositoryRoot, ".wrangler/bootstrap/production-inventory.json"),
    json: false,
    phase: "resources",
    secretNamesPath: null,
    specPath: resolve(repositoryRoot, "infra/environments/production.json"),
    stagingSpecPath: null,
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--write") options.write = true;
    else if (argument === "--confirm-production") options.confirmProduction = true;
    else if (argument === "--confirm-first-production-bootstrap") options.confirmFirstProductionBootstrap = true;
    else if (argument === "--phase") options.phase = argv[++index] ?? "";
    else if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--inventory") options.inventoryPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--secret-names") options.secretNamesPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--spec") options.specPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--staging-spec") options.stagingSpecPath = resolve(repositoryRoot, argv[++index] ?? "");
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (options.stagingSpecPath === null) {
    options.stagingSpecPath = options.phase === "promote"
      ? DEFAULT_PROMOTION_STAGING_SPEC_PATH
      : DEFAULT_STAGING_SPEC_PATH;
  }
  return options;
}

function readGitValue(args, errorCode) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) throw new Error(errorCode);
  return result.stdout.trim();
}

function readRepositoryState() {
  return {
    clean: readGitValue(["status", "--porcelain=v1", "--untracked-files=all"], "production_bootstrap_source_status_unavailable") === "",
    commitSha: readGitValue(["rev-parse", "--verify", "HEAD"], "production_bootstrap_commit_unavailable"),
    treeSha: readGitValue(["rev-parse", "--verify", "HEAD^{tree}"], "production_bootstrap_tree_unavailable"),
  };
}

async function loadSecretNames(path) {
  const value = path === null
    ? (process.env.SELINOW_WORKER_SECRET_NAMES ?? "").split(",").map((name) => name.trim()).filter(Boolean)
    : await readOptionalJson(path);
  if (!Array.isArray(value)) throw new Error("production_bootstrap_secret_names_invalid");
  return value;
}

async function loadAdmissionInput(options, now) {
  const [productionSpec, stagingSpec, canonicalStagingSpec, canonicalPromotionStagingSpec, evidence, inventory, secretNames, migrationNames] = await Promise.all([
    readOptionalJson(options.specPath),
    readOptionalJson(options.stagingSpecPath),
    readOptionalJson(DEFAULT_STAGING_SPEC_PATH),
    readOptionalJson(DEFAULT_PROMOTION_STAGING_SPEC_PATH),
    readOptionalJson(options.evidencePath),
    readOptionalJson(options.inventoryPath),
    loadSecretNames(options.secretNamesPath),
    listMigrationNames(),
  ]);
  if (productionSpec === null) throw new Error("production_spec_missing");
  if (stagingSpec === null) throw new Error("staging_spec_missing");
  if (canonicalStagingSpec === null || canonicalPromotionStagingSpec === null) {
    throw new Error("production_promotion_staging_contract_missing");
  }
  assertProductionPromotionStagingContract(canonicalStagingSpec, canonicalPromotionStagingSpec);
  if (options.phase === "promote" && !isDeepStrictEqual(stagingSpec, canonicalPromotionStagingSpec)) {
    throw new Error("production_promotion_staging_contract_invalid");
  }
  if (evidence === null) throw new Error("production_bootstrap_evidence_missing");
  if (inventory === null) throw new Error("production_bootstrap_inventory_missing");
  return {
    evidence,
    inventory,
    migrationNames,
    now,
    phase: options.phase,
    productionSpec,
    repositoryState: readRepositoryState(),
    secretNames,
    stagingSpec,
  };
}

function writeResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.ok ? "PASS" : "FAIL"} production bootstrap ${result.phase}\n`);
  for (const action of result.actions ?? []) {
    process.stdout.write(`${action.action === "create" ? "+" : action.action === "reuse" ? "=" : "-"} ${action.code}\n`);
  }
  if (result.planRef) process.stdout.write(`plan ${result.planRef}\n`);
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.write && !options.confirmProduction) throw new Error("production_bootstrap_confirmation_required");
  if (options.write && !options.confirmFirstProductionBootstrap) {
    throw new Error("production_first_bootstrap_confirmation_required");
  }

  const now = new Date();
  const initial = await loadAdmissionInput(options, now);
  const plan = options.write
    ? assertProductionBootstrapExecutionAdmission({
        confirmFirstProductionBootstrap: options.confirmFirstProductionBootstrap,
        confirmProduction: options.confirmProduction,
        final: await loadAdmissionInput(options, now),
        initial,
      })
    : buildProductionBootstrapPlan(initial);
  const planRef = options.write ? await writeProductionBootstrapPlan(plan, repositoryRoot) : null;
  writeResult({
    actions: plan.actions,
    environment: "production",
    executed: false,
    fingerprints: plan.fingerprints,
    ok: true,
    phase: plan.phase,
    planRef: planRef ?? undefined,
    safeguards: plan.safeguards,
  }, options.json);
} catch (error) {
  const message = error instanceof Error ? error.message : "production_bootstrap_failed";
  const safeCode = /^[a-z0-9_:.-]{1,220}$/u.test(message) ? message : "production_bootstrap_failed";
  writeOutput({
    actions: [{ code: safeCode, ok: false }],
    environment: "production",
    ok: false,
  }, process.argv.includes("--json"));
  process.exitCode = 1;
}
