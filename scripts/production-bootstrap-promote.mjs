import { spawnSync } from "node:child_process";
import process from "node:process";
import { relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { runWrangler, writeOutput } from "./lib/cli.mjs";
import {
  buildProductionPromotionAuditEnvironment,
  createProductionPromotionRoute,
  deleteProductionPromotionRoute,
  requirePromotionAuditToken,
  requirePromotionRouteToken,
  runProductionPromotion,
  runProductionPromotionRollback,
  updateProductionPromotionRoute,
  writeProductionPromotionReport,
} from "./lib/production-promotion.mjs";
import { discoverProductionCanaryInventory } from "./lib/production-canary.mjs";
import { listMigrationNames, readOptionalJson } from "./lib/release.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

const DEFAULT_EVIDENCE_PATH = resolve(repositoryRoot, ".wrangler/bootstrap/production-evidence.json");
const DEFAULT_MANIFEST_PATH = resolve(repositoryRoot, "infra/generated/production.json");
const DEFAULT_SPEC_PATH = resolve(repositoryRoot, "infra/environments/production.json");
const DEFAULT_STAGING_SPEC_PATH = resolve(repositoryRoot, "infra/environments/staging.json");
const DEFAULT_TRAFFIC_PATH = resolve(repositoryRoot, ".wrangler/bootstrap/production-inventory.json");

function parseArguments(argv) {
  const options = {
    acceptancePath: null,
    canaryStatePath: null,
    confirmFirstProductionBootstrap: false,
    confirmProduction: false,
    environment: null,
    evidencePath: DEFAULT_EVIDENCE_PATH,
    execute: false,
    inventoryPath: null,
    json: false,
    manifestPath: DEFAULT_MANIFEST_PATH,
    mode: "apply",
    planPath: null,
    savedInventoryPath: null,
    specPath: DEFAULT_SPEC_PATH,
    stagingSpecPath: DEFAULT_STAGING_SPEC_PATH,
    statePath: null,
    trafficPath: DEFAULT_TRAFFIC_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-first-production-bootstrap") options.confirmFirstProductionBootstrap = true;
    else if (argument === "--confirm-production") options.confirmProduction = true;
    else if (argument === "--execute") options.execute = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--env") options.environment = argv[++index] ?? "";
    else if (argument.startsWith("--env=")) options.environment = argument.slice("--env=".length);
    else if (argument === "--mode") options.mode = argv[++index] ?? "";
    else if (argument.startsWith("--mode=")) options.mode = argument.slice("--mode=".length);
    else if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--manifest") options.manifestPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--spec") options.specPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--staging-spec") options.stagingSpecPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--plan") options.planPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--traffic-snapshot") options.trafficPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--inventory") options.inventoryPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--saved-inventory") options.savedInventoryPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--canary-state") options.canaryStatePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--acceptance") options.acceptancePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--state") options.statePath = resolve(repositoryRoot, argv[++index] ?? "");
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (options.environment !== "production") throw new Error("production_promotion_environment_required");
  if (!new Set(["apply", "rollback"]).has(options.mode)) throw new Error("production_promotion_mode_required");
  if (options.planPath === null) throw new Error("production_promotion_plan_required");
  if (options.canaryStatePath === null) throw new Error("production_promotion_canary_state_required");
  if (options.acceptancePath === null) throw new Error("production_promotion_acceptance_required");
  if (options.mode === "rollback" && options.statePath === null) throw new Error("production_promotion_state_required");
  if (!options.execute && options.inventoryPath === null) throw new Error("production_promotion_inventory_required");
  if (options.execute && !options.confirmProduction) throw new Error("production_confirmation_required");
  if (options.execute && !options.confirmFirstProductionBootstrap) {
    throw new Error("production_first_bootstrap_confirmation_required");
  }
  return options;
}

function readGitValue(args, code) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(code);
  return result.stdout.trim();
}

function repositoryState() {
  return {
    clean: readGitValue(["status", "--porcelain=v1", "--untracked-files=all"], "production_promotion_source_status_unavailable") === "",
    commitSha: readGitValue(["rev-parse", "--verify", "HEAD"], "production_promotion_commit_unavailable"),
    treeSha: readGitValue(["rev-parse", "--verify", "HEAD^{tree}"], "production_promotion_tree_unavailable"),
  };
}

async function requireJson(path, code) {
  const value = await readOptionalJson(path);
  if (value === null) throw new Error(code);
  return value;
}

function writeResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  writeOutput(result, false);
  if (result.stateRef) process.stdout.write(`state ${result.stateRef}\n`);
  if (result.reportRef) process.stdout.write(`report ${result.reportRef}\n`);
}

try {
  const options = parseArguments(process.argv.slice(2));
  const now = new Date();
  const [productionSpec, stagingSpec, manifest, canonicalProductionSpec, canonicalStagingSpec, canonicalManifest, plan, evidence, trafficSnapshot, canaryState, acceptanceEvidence, state, savedInventory, migrationNames] = await Promise.all([
    requireJson(options.specPath, "production_spec_missing"),
    requireJson(options.stagingSpecPath, "staging_spec_missing"),
    requireJson(options.manifestPath, "production_bootstrap_generated_manifest_missing"),
    requireJson(DEFAULT_SPEC_PATH, "production_spec_missing"),
    requireJson(DEFAULT_STAGING_SPEC_PATH, "staging_spec_missing"),
    requireJson(DEFAULT_MANIFEST_PATH, "production_bootstrap_generated_manifest_missing"),
    requireJson(options.planPath, "production_promotion_plan_missing"),
    requireJson(options.evidencePath, "production_bootstrap_evidence_missing"),
    requireJson(options.trafficPath, "production_promotion_traffic_snapshot_missing"),
    requireJson(options.canaryStatePath, "production_promotion_canary_state_missing"),
    requireJson(options.acceptancePath, "production_promotion_acceptance_missing"),
    options.statePath === null ? null : requireJson(options.statePath, "production_promotion_state_missing"),
    options.savedInventoryPath === null ? null : requireJson(options.savedInventoryPath, "production_promotion_saved_inventory_missing"),
    listMigrationNames(),
  ]);
  if (
    !isDeepStrictEqual(productionSpec, canonicalProductionSpec)
    || !isDeepStrictEqual(stagingSpec, canonicalStagingSpec)
    || !isDeepStrictEqual(manifest, canonicalManifest)
  ) throw new Error("production_promotion_static_identity_mismatch");
  if (
    manifest?.environment !== "production"
    || manifest.accountId !== productionSpec.accountId
    || manifest.zoneId !== productionSpec.zoneId
    || manifest.zoneName !== productionSpec.zoneName
    || manifest.workerName !== productionSpec.workerName
    || manifest.resources?.d1?.name !== productionSpec.resources?.d1
    || typeof manifest.resources?.d1?.id !== "string"
  ) throw new Error("production_promotion_manifest_identity_mismatch");
  const expectedPlanPath = resolve(repositoryRoot, ".wrangler", "bootstrap", evidence.ceremonyId, "promote-plan.json");
  if (resolve(options.planPath) !== expectedPlanPath) throw new Error("production_promotion_plan_path_invalid");
  const expectedCanaryStateRef = relative(repositoryRoot, options.canaryStatePath).split("\\").join("/");
  if (acceptanceEvidence.canaryStateRef !== expectedCanaryStateRef) {
    throw new Error("production_promotion_canary_state_ref_mismatch");
  }
  const operatorEnvironment = { ...process.env };
  let auditToken = null;
  let routeToken = null;
  if (options.execute) {
    auditToken = requirePromotionAuditToken(operatorEnvironment);
    routeToken = requirePromotionRouteToken(operatorEnvironment);
  }
  const inventoryImplementation = options.execute
    ? () => discoverProductionCanaryInventory({
        auditToken,
        commandEnvironment: buildProductionPromotionAuditEnvironment(
          operatorEnvironment,
          productionSpec.accountId,
          auditToken,
        ),
        databaseId: manifest?.resources?.d1?.id,
        now,
        productionSpec,
        repositoryRoot,
        runWranglerImplementation: runWrangler,
      })
    : async () => requireJson(options.inventoryPath, "production_promotion_inventory_missing");
  const common = {
    acceptanceEvidence,
    canaryState,
    confirmFirstProductionBootstrap: options.confirmFirstProductionBootstrap,
    confirmProduction: options.confirmProduction,
    evidence,
    execute: options.execute,
    databaseId: manifest.resources.d1.id,
    inventoryImplementation,
    migrationNames,
    liveNow: () => new Date(),
    now,
    plan,
    productionSpec,
    repositoryState: repositoryState(),
    savedInventory: savedInventory ?? undefined,
    stagingSpec,
    trafficSnapshot,
  };
  const routeImplementation = {
    createRouteImplementation: ({ pattern, script }) => createProductionPromotionRoute({
      pattern,
      script,
      token: routeToken,
      zoneId: productionSpec.zoneId,
    }),
    deleteRouteImplementation: (routeId) => deleteProductionPromotionRoute({
      routeId,
      token: routeToken,
      zoneId: productionSpec.zoneId,
    }),
    updateRouteImplementation: (routeId, { pattern, script }) => updateProductionPromotionRoute({
      pattern,
      routeId,
      script,
      token: routeToken,
      zoneId: productionSpec.zoneId,
    }),
  };
  const reportWriter = (value, mode) => writeProductionPromotionReport(
    repositoryRoot,
    evidence.ceremonyId,
    mode,
    value,
  );
  const result = options.mode === "rollback"
    ? await runProductionPromotionRollback({
        ...common,
        ...routeImplementation,
        state,
        writeReportImplementation: reportWriter,
      })
    : await runProductionPromotion({
        ...common,
        ...routeImplementation,
        writeReportImplementation: reportWriter,
      });
  writeResult(result, options.json);
} catch (error) {
  const message = error instanceof Error ? error.message : "production_promotion_failed";
  const safeCode = /^[A-Za-z0-9_:.-]{1,240}$/u.test(message) ? message : "production_promotion_failed";
  writeOutput({ actions: [{ code: safeCode, ok: false }], environment: "production", ok: false }, process.argv.includes("--json"));
  process.exitCode = 1;
}
