import { spawnSync } from "node:child_process";
import process from "node:process";
import { resolve } from "node:path";

import { run, runWrangler, writeOutput } from "./lib/cli.mjs";
import {
  buildCanaryBuildEnvironment,
  buildCanaryWranglerEnvironment,
  assertProductionCanaryStaticIdentity,
  createProductionCanaryRoute,
  deleteProductionCanaryRoute,
  discoverProductionCanaryInventory,
  requireCanaryAuditToken,
  requireCanaryRouteToken,
  requireCanaryWorkerToken,
  resolveProductionCanaryDns,
  isFirstProductionPlaceholderVersionView,
  runProductionCanaryApply,
  runProductionCanaryRollback,
  runProductionCanaryUpload,
  writeProductionCanaryReport,
} from "./lib/production-canary.mjs";
import { listMigrationNames, readOptionalJson } from "./lib/release.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

const DEFAULT_EVIDENCE_PATH = resolve(repositoryRoot, ".wrangler/bootstrap/production-evidence.json");
const DEFAULT_MANIFEST_PATH = resolve(repositoryRoot, "infra/generated/production.json");
const DEFAULT_SPEC_PATH = resolve(repositoryRoot, "infra/environments/production.json");
const DEFAULT_STAGING_SPEC_PATH = resolve(repositoryRoot, "infra/environments/staging.json");
const DEFAULT_TRAFFIC_PATH = resolve(repositoryRoot, ".wrangler/bootstrap/production-inventory.json");
const DEFAULT_WRANGLER_PATH = resolve(repositoryRoot, "wrangler.jsonc");

function parseArguments(argv) {
  const options = {
    confirmFirstProductionBootstrap: false,
    confirmProduction: false,
    environment: null,
    evidencePath: DEFAULT_EVIDENCE_PATH,
    execute: false,
    inventoryPath: null,
    json: false,
    manifestPath: DEFAULT_MANIFEST_PATH,
    message: null,
    mode: null,
    planPath: null,
    specPath: DEFAULT_SPEC_PATH,
    statePath: null,
    tag: null,
    trafficPath: DEFAULT_TRAFFIC_PATH,
    uploadReportPath: null,
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
    else if (argument === "--inventory") options.inventoryPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--manifest") options.manifestPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--message") options.message = argv[++index] ?? "";
    else if (argument === "--plan") options.planPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--spec") options.specPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--state") options.statePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--tag") options.tag = argv[++index] ?? "";
    else if (argument === "--traffic-snapshot") options.trafficPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--upload-report") options.uploadReportPath = resolve(repositoryRoot, argv[++index] ?? "");
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (options.environment !== "production") throw new Error("production_canary_environment_required");
  if (!new Set(["apply", "rollback", "upload"]).has(options.mode)) throw new Error("production_canary_mode_required");
  if (options.planPath === null) throw new Error("production_canary_plan_required");
  if (options.execute && !options.confirmProduction) throw new Error("production_confirmation_required");
  if (options.execute && !options.confirmFirstProductionBootstrap) {
    throw new Error("production_first_bootstrap_confirmation_required");
  }
  if (!options.execute && options.inventoryPath === null) throw new Error("production_canary_inventory_required");
  if (options.mode === "upload" && !options.tag) throw new Error("production_canary_tag_required");
  if (options.mode === "apply" && options.uploadReportPath === null) throw new Error("production_canary_upload_report_required");
  if (options.mode === "rollback" && options.statePath === null) throw new Error("production_canary_state_required");
  return options;
}

function readGitValue(args, code) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(code);
  return result.stdout.trim();
}

function repositoryState() {
  return {
    clean: readGitValue(["status", "--porcelain=v1", "--untracked-files=all"], "production_canary_source_status_unavailable") === "",
    commitSha: readGitValue(["rev-parse", "--verify", "HEAD"], "production_canary_commit_unavailable"),
    treeSha: readGitValue(["rev-parse", "--verify", "HEAD^{tree}"], "production_canary_tree_unavailable"),
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
  if (result.candidateVersionId) process.stdout.write(`candidate ${result.candidateVersionId}\n`);
  if (result.reportRef) process.stdout.write(`report ${result.reportRef}\n`);
  if (result.stateRef) process.stdout.write(`state ${result.stateRef}\n`);
}

try {
  const options = parseArguments(process.argv.slice(2));
  const now = new Date();
  const [productionSpec, manifest, canonicalProductionSpec, canonicalManifest, canonicalStagingSpec, wranglerConfig, plan, evidence, trafficSnapshot, migrationNames, uploadReport, canaryState] = await Promise.all([
    requireJson(options.specPath, "production_spec_missing"),
    requireJson(options.manifestPath, "production_bootstrap_generated_manifest_missing"),
    requireJson(DEFAULT_SPEC_PATH, "production_spec_missing"),
    requireJson(DEFAULT_MANIFEST_PATH, "production_bootstrap_generated_manifest_missing"),
    requireJson(DEFAULT_STAGING_SPEC_PATH, "staging_spec_missing"),
    requireJson(DEFAULT_WRANGLER_PATH, "wrangler_config_missing"),
    requireJson(options.planPath, "production_canary_plan_missing"),
    requireJson(options.evidencePath, "production_bootstrap_evidence_missing"),
    requireJson(options.trafficPath, "production_canary_traffic_snapshot_missing"),
    listMigrationNames(),
    options.uploadReportPath === null ? null : requireJson(options.uploadReportPath, "production_canary_upload_report_missing"),
    options.statePath === null ? null : requireJson(options.statePath, "production_canary_state_missing"),
  ]);
  const expectedPlanPath = resolve(repositoryRoot, ".wrangler", "bootstrap", evidence?.ceremonyId ?? "", "canary-plan.json");
  if (resolve(options.planPath) !== expectedPlanPath) throw new Error("production_canary_plan_path_invalid");
  assertProductionCanaryStaticIdentity({
    canonicalGeneratedManifest: canonicalManifest,
    canonicalProductionSpec,
    generatedManifest: manifest,
    productionSpec,
  });
  const databaseId = manifest?.resources?.d1?.id;
  if (
    manifest?.environment !== "production"
    || manifest?.accountId !== productionSpec.accountId
    || manifest?.zoneId !== productionSpec.zoneId
    || manifest?.workerName !== productionSpec.workerName
    || manifest?.zoneName !== productionSpec.zoneName
    || manifest?.resources?.d1?.name !== productionSpec.resources?.d1
    || typeof databaseId !== "string"
  ) {
    throw new Error("production_canary_manifest_identity_mismatch");
  }
  if (
    canonicalStagingSpec?.environment !== "staging"
    || canonicalStagingSpec?.accountId !== productionSpec.accountId
    || canonicalStagingSpec?.zoneId !== productionSpec.zoneId
    || canonicalStagingSpec?.zoneName !== productionSpec.zoneName
    || typeof canonicalStagingSpec?.workerName !== "string"
  ) {
    throw new Error("production_canary_staging_spec_identity_mismatch");
  }

  const operatorEnvironment = { ...process.env };
  let auditToken = null;
  let workerToken = null;
  let routeToken = null;
  let auditEnvironment = null;
  let workerEnvironment = null;
  if (options.execute) {
    auditToken = requireCanaryAuditToken(operatorEnvironment);
    workerToken = requireCanaryWorkerToken(operatorEnvironment);
    if (options.mode !== "upload") routeToken = requireCanaryRouteToken(operatorEnvironment);
    auditEnvironment = buildCanaryWranglerEnvironment(operatorEnvironment, productionSpec.accountId, auditToken);
    workerEnvironment = buildCanaryWranglerEnvironment(operatorEnvironment, productionSpec.accountId, workerToken);
  }

  const inventoryImplementation = options.execute
    ? () => discoverProductionCanaryInventory({
        auditToken,
        commandEnvironment: auditEnvironment,
        databaseId,
        now: new Date(),
        productionSpec,
        repositoryRoot,
        runWranglerImplementation: runWrangler,
      })
    : async () => requireJson(options.inventoryPath, "production_canary_inventory_missing");
  const reportWriter = (value, mode) => writeProductionCanaryReport(
    repositoryRoot,
    evidence.ceremonyId,
    mode,
    value,
  );
  const common = {
    confirmFirstProductionBootstrap: options.confirmFirstProductionBootstrap,
    confirmProduction: options.confirmProduction,
    databaseId,
    evidence,
    execute: options.execute,
    generatedManifest: manifest,
    inventoryImplementation,
    migrationNames,
    now,
    plan,
    productionSpec,
    repositoryState: repositoryState(),
    stagingWorkerName: canonicalStagingSpec.workerName,
    trafficSnapshot,
    wranglerConfig,
    writeReportImplementation: reportWriter,
  };

  let result;
  if (options.mode === "upload") {
    const message = options.message || `first-production canary ${common.repositoryState.commitSha}`;
    const versionViewImplementation = async (versionId) => {
      const output = runWrangler([
        "versions", "view", versionId, "--env", "production", "--json",
      ], { cwd: repositoryRoot, env: auditEnvironment }).stdout;
      try {
        return JSON.parse(output);
      } catch {
        throw new Error("production_canary_candidate_view_invalid");
      }
    };
    result = await runProductionCanaryUpload({
      ...common,
      buildImplementation: async () => {
        run("npm", ["run", "build"], {
          capture: false,
          cwd: repositoryRoot,
          env: buildCanaryBuildEnvironment(operatorEnvironment),
        });
      },
      tag: options.tag,
      uploadImplementation: async (controlVersionId) => {
        try {
          runWrangler([
            "versions",
            "upload",
            "--env",
            "production",
            "--strict",
            "--tag",
            options.tag,
            "--message",
            message,
          ], { cwd: repositoryRoot, env: workerEnvironment });
        } catch (error) {
          const controlView = await versionViewImplementation(controlVersionId);
          if (!isFirstProductionPlaceholderVersionView(controlView)) throw error;
          runWrangler([
            "versions",
            "upload",
            "--env",
            "production",
            "--tag",
            options.tag,
            "--message",
            message,
          ], { cwd: repositoryRoot, env: workerEnvironment });
        }
      },
      versionViewImplementation,
    });
  } else if (options.mode === "apply") {
    result = await runProductionCanaryApply({
      ...common,
      createRouteImplementation: ({ pattern, script }) => createProductionCanaryRoute({
        pattern,
        script,
        token: routeToken,
        zoneId: productionSpec.zoneId,
      }),
      deleteRouteImplementation: (routeId) => deleteProductionCanaryRoute({
        routeId,
        token: routeToken,
        zoneId: productionSpec.zoneId,
      }),
      dnsAdmissionImplementation: (hostname) => resolveProductionCanaryDns({ hostname }),
      deployVersionImplementation: async (versionId) => {
        runWrangler([
          "versions", "deploy", `${versionId}@100%`, "--env", "production", "--yes",
          "--message", `first-production canary ${versionId}`,
        ], { cwd: repositoryRoot, env: workerEnvironment });
      },
      uploadReport,
    });
  } else {
    result = await runProductionCanaryRollback({
      ...common,
      canaryState,
      deleteRouteImplementation: (routeId) => deleteProductionCanaryRoute({
        routeId,
        token: routeToken,
        zoneId: productionSpec.zoneId,
      }),
      deployVersionImplementation: async (versionId) => {
        runWrangler([
          "versions", "deploy", `${versionId}@100%`, "--env", "production", "--yes",
          "--message", `first-production canary rollback ${versionId}`,
        ], { cwd: repositoryRoot, env: workerEnvironment });
      },
    });
  }
  writeResult(result, options.json);
} catch (error) {
  const message = error instanceof Error ? error.message : "production_canary_failed";
  const safeCode = /^[A-Za-z0-9_:.-]{1,240}$/u.test(message) ? message : "production_canary_failed";
  writeOutput({
    actions: [{ code: safeCode, ok: false }],
    environment: "production",
    ok: false,
  }, process.argv.includes("--json"));
  process.exitCode = 1;
}
