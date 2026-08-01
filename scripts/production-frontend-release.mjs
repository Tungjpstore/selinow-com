import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { run, runWrangler } from "./lib/cli.mjs";
import {
  assertFrontendOnlyActivationTransition,
  assertFrontendOnlyControlInventory,
  assertFrontendOnlyUploadTransition,
  assertFrontendOnlyVersionParity,
  compensateFrontendOnlyActivation,
  fingerprintFrontendOnly,
  discoverFrontendOnlyWorkerVersions,
  FRONTEND_ONLY_BASELINE_COMMIT,
  FRONTEND_ONLY_RELEASE_MODE,
  FRONTEND_ONLY_ROLLBACK_VERSION,
  normalizeFrontendOnlyMigrationLedger,
  qualifyFrontendOnlySource,
  runFrontendOnlySmoke,
  waitForFrontendOnlyActiveVersion,
  validateFrontendOnlyEvidence,
} from "./lib/frontend-only-release.mjs";
import {
  buildCanaryBuildEnvironment,
  discoverProductionCanaryInventory,
} from "./lib/production-canary.mjs";
import {
  buildProductionReleaseAuditEnvironment,
  buildProductionReleaseEditEnvironment,
  fingerprintProductionUploadInputs,
  removeProductionUploadStage,
  stageProductionUploadInputs,
} from "./lib/release.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

const DEFAULT_EVIDENCE = resolve(repositoryRoot, ".wrangler/release/production-frontend-only-evidence.json");
const GENERATED_MANIFEST = resolve(repositoryRoot, "infra/generated/production.json");
const PRODUCTION_SPEC = resolve(repositoryRoot, "infra/environments/production.json");
const LEDGER_SQL = "SELECT id, name, applied_at FROM d1_migrations ORDER BY id";
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function parseArguments(argv) {
  const options = {
    confirmProduction: false,
    environment: null,
    evidencePath: DEFAULT_EVIDENCE,
    execute: false,
    json: false,
    mode: null,
    monitorSeconds: 900,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-production") options.confirmProduction = true;
    else if (argument === "--execute") options.execute = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--env") options.environment = argv[++index] ?? "";
    else if (argument.startsWith("--env=")) options.environment = argument.slice("--env=".length);
    else if (argument === "--mode") options.mode = argv[++index] ?? "";
    else if (argument.startsWith("--mode=")) options.mode = argument.slice("--mode=".length);
    else if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--monitor-seconds") options.monitorSeconds = Number(argv[++index]);
    else if (argument.startsWith("--monitor-seconds=")) options.monitorSeconds = Number(argument.slice("--monitor-seconds=".length));
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (options.environment !== "production") throw new Error("production_frontend_only_environment_required");
  if (!new Set(["activate", "plan", "rollback", "upload"]).has(options.mode)) {
    throw new Error("production_frontend_only_mode_required");
  }
  if (options.execute && !options.confirmProduction) throw new Error("production_confirmation_required");
  if (options.execute && options.mode === "plan") throw new Error("production_frontend_only_plan_execute_forbidden");
  if (options.mode === "activate" && options.execute
    && (!Number.isSafeInteger(options.monitorSeconds) || options.monitorSeconds < 900 || options.monitorSeconds > 3600)) {
    throw new Error("production_frontend_only_monitor_window_invalid");
  }
  return options;
}

function git(args, code, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding });
  if (result.error || result.status !== 0) throw new Error(code);
  return result.stdout;
}

function parseRawChanges(output) {
  return String(output).trim().split("\n").filter(Boolean).map((line) => {
    const match = line.match(/^:([0-9]{6}) ([0-9]{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])\t(.+)$/u);
    if (!match) throw new Error("production_frontend_only_source_change_invalid");
    return { newMode: match[2], oldMode: match[1], path: match[4], status: match[3] };
  });
}
function storefrontSuffix(source) {
  const marker = '{mode === "storefront" && shop && (';
  const index = source.indexOf(marker);
  if (index < 0) throw new Error("production_frontend_only_storefront_suffix_missing");
  return source.slice(index);
}


function repositoryState() {
  const diff = git(["diff", "--binary", "--full-index", FRONTEND_ONLY_BASELINE_COMMIT, "HEAD", "--"], "production_frontend_only_diff_unavailable");
  const baselineIndex = git(["show", `${FRONTEND_ONLY_BASELINE_COMMIT}:src/pages/index.astro`], "production_frontend_only_baseline_index_unavailable");
  const currentIndex = git(["show", "HEAD:src/pages/index.astro"], "production_frontend_only_index_unavailable");
  return {
    baselineCommitSha: FRONTEND_ONLY_BASELINE_COMMIT,
    baselineIsAncestor: spawnSync("git", ["merge-base", "--is-ancestor", FRONTEND_ONLY_BASELINE_COMMIT, "HEAD"], { cwd: repositoryRoot }).status === 0,
    changes: parseRawChanges(git(["diff", "--raw", "--no-abbrev", FRONTEND_ONLY_BASELINE_COMMIT, "HEAD", "--"], "production_frontend_only_changes_unavailable")),
    clean: git(["status", "--porcelain=v1", "--untracked-files=all"], "production_frontend_only_status_unavailable").trim() === "",
    commitSha: git(["rev-parse", "--verify", "HEAD"], "production_frontend_only_commit_unavailable").trim(),
    diffSha256: createHash("sha256").update(diff).digest("hex"),
    mergeCommits: git(["rev-list", "--merges", `${FRONTEND_ONLY_BASELINE_COMMIT}..HEAD`], "production_frontend_only_history_unavailable").trim().split("\n").filter(Boolean),
    storefrontSuffixUnchanged: storefrontSuffix(baselineIndex) === storefrontSuffix(currentIndex),
    treeSha: git(["rev-parse", "--verify", "HEAD^{tree}"], "production_frontend_only_tree_unavailable").trim(),
  };
}

function parseJson(text, code) {
  try {
    return JSON.parse(String(text));
  } catch {
    throw new Error(code);
  }
}

async function requireJson(path, code) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(code);
  }
}

async function assertPrivateEvidenceReports(evidence) {
  for (const name of ["quality", "browser", "visual", "security"]) {
    const report = evidence[name];
    const path = resolve(repositoryRoot, report.reportRef);
    let stat;
    let body;
    try {
      [stat, body] = await Promise.all([lstat(path), readFile(path)]);
    } catch {
      throw new Error(`production_frontend_only_report_missing:${name}`);
    }
    let receipt;
    try {
      receipt = JSON.parse(body.toString("utf8"));
    } catch {
      throw new Error(`production_frontend_only_report_invalid:${name}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || createHash("sha256").update(body).digest("hex") !== report.reportSha256
      || receipt?.schemaVersion !== 1 || receipt?.mode !== FRONTEND_ONLY_RELEASE_MODE
      || receipt?.releaseId !== evidence.releaseId || receipt?.commitSha !== evidence.commitSha
      || receipt?.treeSha !== evidence.treeSha || receipt?.section !== name || receipt?.passed !== true) {
      throw new Error(`production_frontend_only_report_admission_failed:${name}`);
    }
  }
}

function requireToken(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
}

async function writePrivateReport(evidence, name, report) {
  const directory = resolve(repositoryRoot, ".wrangler", "releases", evidence.releaseId);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const path = resolve(directory, `${name}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return `.wrangler/releases/${evidence.releaseId}/${name}.json`;
}

function candidateUploadReportPath(evidence) {
  return resolve(repositoryRoot, ".wrangler", "releases", evidence.releaseId, "frontend-only-upload.json");
}

function validateUploadReport(report, evidence) {
  if (report?.schemaVersion !== 1 || report?.mode !== FRONTEND_ONLY_RELEASE_MODE
    || report?.phase !== "upload" || report?.releaseId !== evidence.releaseId
    || report?.commitSha !== evidence.commitSha || report?.treeSha !== evidence.treeSha
    || report?.rollbackWorkerVersion !== FRONTEND_ONLY_ROLLBACK_VERSION
    || !UUID_PATTERN.test(report?.candidateWorkerVersion ?? "")
    || !/^[a-f0-9]{64}$/u.test(report?.migrationLedgerSha256 ?? "")
    || !/^[a-f0-9]{64}$/u.test(report?.inventoryInvariantSha256 ?? "")
    || !/^[a-f0-9]{64}$/u.test(report?.runtimeSha256 ?? "")) {
    throw new Error("production_frontend_only_upload_report_invalid");
  }
  return report;
}

function assertCandidateProvenance(view, evidence) {
  if (view?.annotations?.["workers/message"] !== `frontend-only release ${evidence.commitSha}`
    || view?.annotations?.["workers/tag"] !== evidence.releaseId
    || view?.annotations?.["workers/triggered_by"] !== "version_upload"
    || view?.metadata?.source !== "wrangler") {
    throw new Error("production_frontend_only_candidate_provenance_invalid");
  }
}


function sourceAdmission(evidence, baselinePackage, currentPackage) {
  return qualifyFrontendOnlySource({
    baselinePackage,
    currentPackage,
    evidence,
    source: repositoryState(),
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [evidence, generatedManifest, productionSpec, baselinePackage, currentPackage] = await Promise.all([
    requireJson(options.evidencePath, "production_frontend_only_evidence_missing"),
    requireJson(GENERATED_MANIFEST, "production_generated_manifest_missing"),
    requireJson(PRODUCTION_SPEC, "production_spec_missing"),
    Promise.resolve(parseJson(git(["show", `${FRONTEND_ONLY_BASELINE_COMMIT}:package.json`], "production_frontend_only_baseline_package_unavailable"), "production_frontend_only_baseline_package_invalid")),
    requireJson(resolve(repositoryRoot, "package.json"), "production_frontend_only_package_invalid"),
  ]);
  validateFrontendOnlyEvidence(evidence);
  await assertPrivateEvidenceReports(evidence);
  const qualification = sourceAdmission(evidence, baselinePackage, currentPackage);
  if (!options.execute) {
    return {
      actions: [
        "exact_source_and_receipt_admission",
        "full_live_inventory_and_d1_ledger_comparison",
        "immutable_versions_upload_only",
        "non_assets_bindings_handlers_runtime_parity",
        "versions_deploy_candidate_at_100_percent_only",
        "get_only_smoke_15_min_monitor_and_exact_rollback",
      ],
      environment: "production",
      executed: false,
      ok: true,
      qualification,
      requestedMode: options.mode,
    };
  }

  const operatorEnvironment = { ...process.env };
  const auditToken = requireToken(operatorEnvironment, "CLOUDFLARE_ROUTE_AUDIT_API_TOKEN");
  const workerToken = requireToken(operatorEnvironment, "CLOUDFLARE_RELEASE_WORKER_API_TOKEN");
  const auditEnvironment = buildProductionReleaseAuditEnvironment(operatorEnvironment, productionSpec.accountId, auditToken);
  const editEnvironment = buildProductionReleaseEditEnvironment(operatorEnvironment, productionSpec.accountId, workerToken);
  const databaseId = generatedManifest?.resources?.d1?.id;
  if (generatedManifest?.accountId !== productionSpec.accountId
    || generatedManifest?.workerName !== productionSpec.workerName
    || generatedManifest?.zoneId !== productionSpec.zoneId
    || generatedManifest?.resources?.d1?.name !== productionSpec.resources?.d1
    || typeof databaseId !== "string") {
    throw new Error("production_frontend_only_runtime_identity_invalid");
  }
  const inventory = async () => {
    const [base, versions] = await Promise.all([
      discoverProductionCanaryInventory({
        auditToken, commandEnvironment: auditEnvironment, databaseId, now: new Date(),
        productionSpec, repositoryRoot, runWranglerImplementation: runWrangler,
      }),
      discoverFrontendOnlyWorkerVersions({ accountId: productionSpec.accountId, token: auditToken, workerName: productionSpec.workerName }),
    ]);
    return { ...base, versions };
  };
  const migrationLedger = () => normalizeFrontendOnlyMigrationLedger(parseJson(runWrangler([
    "d1", "execute", "PLATFORM_DB", "--env", "production", "--remote",
    "--command", LEDGER_SQL, "--json",
  ], { cwd: repositoryRoot, env: auditEnvironment }).stdout, "production_frontend_only_migration_ledger_invalid"));
  const versionView = (versionId) => parseJson(runWrangler([
    "versions", "view", versionId, "--env", "production", "--json",
  ], { cwd: repositoryRoot, env: auditEnvironment }).stdout, "production_frontend_only_version_view_invalid");
  const deployVersion = (versionId, message) => runWrangler([
    "versions", "deploy", `${versionId}@100%`, "--env", "production", "--yes", "--message", message,
  ], { cwd: repositoryRoot, env: editEnvironment });

  if (options.mode === "upload") {
    const [before, ledgerBefore] = await Promise.all([inventory(), migrationLedger()]);
    assertFrontendOnlyControlInventory(before);
    run("npm", ["run", "build"], {
      capture: false,
      cwd: repositoryRoot,
      env: buildCanaryBuildEnvironment(operatorEnvironment),
    });
    const rebuiltQualification = sourceAdmission(evidence, baselinePackage, currentPackage);
    if (!isDeepStrictEqual(qualification, rebuiltQualification)) throw new Error("production_frontend_only_source_changed_after_build");
    const [admitted, ledgerAdmitted] = await Promise.all([inventory(), migrationLedger()]);
    if (!isDeepStrictEqual(inventoryWithoutObservedAt(before), inventoryWithoutObservedAt(admitted))
      || !isDeepStrictEqual(ledgerBefore, ledgerAdmitted)) {
      throw new Error("production_frontend_only_admission_changed_before_upload");
    }
    const stage = await stageProductionUploadInputs(repositoryRoot, evidence.releaseId, { generatedManifest, productionSpec });
    try {
      runWrangler([
        "versions", "upload", "dist/server/entry.mjs",
        "--config", "production-upload-wrangler.json",
        "--no-bundle", "--assets", "dist/client", "--strict",
        "--tag", evidence.releaseId,
        "--message", `frontend-only release ${evidence.commitSha}`,
      ], { cwd: stage.stageRoot, env: editEnvironment });
      const [sourceArtifact, stagedArtifact, after, ledgerAfter] = await Promise.all([
        fingerprintProductionUploadInputs(repositoryRoot),
        fingerprintProductionUploadInputs(stage.stageRoot),
        inventory(),
        migrationLedger(),
      ]);
      if (sourceArtifact !== stage.artifactSha256 || stagedArtifact !== stage.artifactSha256
        || !isDeepStrictEqual(ledgerBefore, ledgerAfter)) {
        throw new Error("production_frontend_only_upload_input_or_ledger_drift");
      }
      const candidateWorkerVersion = assertFrontendOnlyUploadTransition(admitted, after);
      const [previousView, candidateView] = await Promise.all([
        versionView(FRONTEND_ONLY_ROLLBACK_VERSION),
        versionView(candidateWorkerVersion),
      ]);
      assertCandidateProvenance(candidateView, evidence);
      const parity = assertFrontendOnlyVersionParity(previousView, candidateView);
      const report = {
        artifactSha256: stage.artifactSha256,
        bindingNames: parity.bindingNames,
        candidateWorkerVersion,
        commitSha: evidence.commitSha,
        createdAt: new Date().toISOString(),
        environment: "production",
        migrationLedgerSha256: fingerprintFrontendOnly(ledgerAfter),
        inventoryInvariantSha256: fingerprintFrontendOnly(inventoryWithoutDeploymentState(after)),
        mode: FRONTEND_ONLY_RELEASE_MODE,
        phase: "upload",
        releaseId: evidence.releaseId,
        rollbackWorkerVersion: FRONTEND_ONLY_ROLLBACK_VERSION,
        runtimeSha256: parity.runtimeSha256,
        schemaVersion: 1,
        treeSha: evidence.treeSha,
        uploadConfigSha256: stage.uploadConfigSha256,
      };
      const reportRef = await writePrivateReport(evidence, "frontend-only-upload", report);
      return { candidateWorkerVersion, executed: true, ok: true, phase: "upload", reportRef };
    } finally {
      await removeProductionUploadStage(stage.stageRoot, repositoryRoot, evidence.releaseId);
    }
  }

  const uploadReport = validateUploadReport(await requireJson(
    candidateUploadReportPath(evidence),
    "production_frontend_only_upload_report_missing",
  ), evidence);
  const candidateWorkerVersion = uploadReport.candidateWorkerVersion;
  const [before, ledgerBefore, previousView, candidateView] = await Promise.all([
    inventory(), migrationLedger(), versionView(FRONTEND_ONLY_ROLLBACK_VERSION), versionView(candidateWorkerVersion),
  ]);
  const parity = assertFrontendOnlyVersionParity(previousView, candidateView);
  if (candidateWorkerVersion === FRONTEND_ONLY_ROLLBACK_VERSION
    || !before.versions.some((version) => version.id === candidateWorkerVersion)) {
    throw new Error("production_frontend_only_candidate_missing_before_activation");
  }
  assertCandidateProvenance(candidateView, evidence);
  if (parity.runtimeSha256 !== uploadReport.runtimeSha256
    || fingerprintFrontendOnly(ledgerBefore) !== uploadReport.migrationLedgerSha256
    || fingerprintFrontendOnly(inventoryWithoutDeploymentState(before)) !== uploadReport.inventoryInvariantSha256) {
    throw new Error("production_frontend_only_upload_receipt_drift");
  }

  if (options.mode === "rollback") {
    if (before.deployments[0]?.versionId !== candidateWorkerVersion) {
      throw new Error("production_frontend_only_candidate_not_active_for_rollback");
    }
    deployVersion(FRONTEND_ONLY_ROLLBACK_VERSION, `frontend-only rollback ${evidence.releaseId}`);
    const restored = await waitForFrontendOnlyActiveVersion({
      allowedVersions: new Set([candidateWorkerVersion, FRONTEND_ONLY_ROLLBACK_VERSION]),
      expectedVersion: FRONTEND_ONLY_ROLLBACK_VERSION,
      inventoryImplementation: inventory,
    });
    const ledgerRestored = await migrationLedger();
    assertFrontendOnlyControlInventory(restored);
    if (!isDeepStrictEqual(inventoryWithoutDeploymentState(before), inventoryWithoutDeploymentState(restored))
      || !isDeepStrictEqual(ledgerBefore, ledgerRestored)) {
      throw new Error("production_frontend_only_rollback_inventory_drift");
    }
    const reportRef = await writePrivateReport(evidence, "frontend-only-rollback", {
      candidateWorkerVersion,
      completedAt: new Date().toISOString(),
      mode: FRONTEND_ONLY_RELEASE_MODE,
      releaseId: evidence.releaseId,
      restoredWorkerVersion: FRONTEND_ONLY_ROLLBACK_VERSION,
      schemaVersion: 1,
    });
    return { executed: true, ok: true, phase: "rollback", reportRef };
  }

  assertFrontendOnlyControlInventory(before);
  let activationAttempted = false;
  try {
    activationAttempted = true;
    deployVersion(candidateWorkerVersion, `frontend-only activate ${evidence.releaseId}`);
    const activated = await waitForFrontendOnlyActiveVersion({
      allowedVersions: new Set([candidateWorkerVersion, FRONTEND_ONLY_ROLLBACK_VERSION]),
      expectedVersion: candidateWorkerVersion,
      inventoryImplementation: inventory,
    });
    const ledgerActivated = await migrationLedger();
    assertFrontendOnlyActivationTransition(before, activated, candidateWorkerVersion);
    if (!isDeepStrictEqual(ledgerBefore, ledgerActivated)) throw new Error("production_frontend_only_activation_ledger_drift");
    const firstSmoke = await runFrontendOnlySmoke();
    await delay(options.monitorSeconds * 1000);
    const [finalInventory, finalLedger, finalSmoke] = await Promise.all([
      inventory(), migrationLedger(), runFrontendOnlySmoke(),
    ]);
    if (finalInventory.deployments[0]?.versionId !== candidateWorkerVersion
      || !isDeepStrictEqual(inventoryWithoutObservedAt(activated), inventoryWithoutObservedAt(finalInventory))
      || !isDeepStrictEqual(ledgerBefore, finalLedger)) {
      throw new Error("production_frontend_only_monitor_drift");
    }
    const reportRef = await writePrivateReport(evidence, "frontend-only-activation", {
      candidateWorkerVersion,
      completedAt: new Date().toISOString(),
      firstSmoke,
      mode: FRONTEND_ONLY_RELEASE_MODE,
      monitorSeconds: options.monitorSeconds,
      releaseId: evidence.releaseId,
      schemaVersion: 1,
      finalSmoke,
    });
    return { candidateWorkerVersion, executed: true, ok: true, phase: "activate", reportRef };
  } catch (error) {
    if (activationAttempted) {
      await compensateFrontendOnlyActivation({
        allowedVersions: new Set([candidateWorkerVersion, FRONTEND_ONLY_ROLLBACK_VERSION]),
        deployRollbackImplementation: () => deployVersion(
          FRONTEND_ONLY_ROLLBACK_VERSION,
          `frontend-only automatic rollback ${evidence.releaseId}`,
        ),
        inventoryImplementation: inventory,
        migrationLedgerImplementation: migrationLedger,
        originalError: error,
        verifyRestoredImplementation: (restored, ledgerRestored) => {
          assertFrontendOnlyControlInventory(restored);
          if (!isDeepStrictEqual(inventoryWithoutDeploymentState(before), inventoryWithoutDeploymentState(restored))
            || !isDeepStrictEqual(ledgerBefore, ledgerRestored)) {
            throw new Error("production_frontend_only_automatic_rollback_inventory_drift");
          }
        },
      });
    }
    throw error;
  }
}

function inventoryWithoutObservedAt(inventory) {
  const copy = { ...inventory };
  delete copy.observedAt;
  return copy;
}

function inventoryWithoutDeploymentState(inventory) {
  const copy = inventoryWithoutObservedAt(inventory);
  delete copy.deployments;
  return copy;
}

try {

  const result = await main();
  process.stdout.write(`${JSON.stringify(result, null, process.argv.includes("--json") ? 2 : 0)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "production_frontend_only_failed";
  const code = /^[A-Za-z0-9_:.-]{1,300}$/u.test(message) ? message : "production_frontend_only_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
