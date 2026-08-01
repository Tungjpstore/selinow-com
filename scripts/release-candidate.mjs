import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

import { run } from "./lib/cli.mjs";
import { buildCanaryBuildEnvironment } from "./lib/production-canary.mjs";
import {
  buildProductionReleaseAuditEnvironment,
  buildProductionReleaseEditEnvironment,
  assertProductionWranglerToolchain,
  captureProductionCandidateVersion,
  createProductionWranglerToolchainAttestation,
  fingerprintProductionUploadInputs,
  listMigrationNames,
  productionDeploymentVersion,
  readOptionalJson,
  removeProductionUploadStage,
  runAttestedProductionWrangler,
  runProductionReleaseGit,
  stageProductionUploadInputs,
  validateProductionCandidateUploadAdmission,
  validateProductionCandidateVersionProvenance,
  validateProductionCandidateVersionView,
  writeProductionCandidateArtifacts,
} from "./lib/release.mjs";
import {
  assertProductionWorkerIdentityAdmission,
  cloudflareApiRequest,
  repositoryRoot,
} from "./lib/platform.mjs";

const EVIDENCE_PATH = resolve(repositoryRoot, ".wrangler/release/production-evidence.json");
const GENERATED_MANIFEST_PATH = resolve(repositoryRoot, "infra/generated/production.json");
const PRODUCTION_SPEC_PATH = resolve(repositoryRoot, "infra/environments/production.json");
const STAGING_SPEC_PATH = resolve(repositoryRoot, "infra/environments/staging.json");
const WRANGLER_PATH = resolve(repositoryRoot, "wrangler.jsonc");

function parseArguments(argv) {
  const options = { confirmProduction: false, execute: false, json: false, tag: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-production") options.confirmProduction = true;
    else if (argument === "--execute") options.execute = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--env") {
      if ((argv[++index] ?? "") !== "production") throw new Error("production_candidate_environment_required");
    } else if (argument === "--env=production") {
      // Explicit production target is mandatory even in plan mode.
    } else if (argument === "--tag") options.tag = argv[++index] ?? "";
    else if (argument.startsWith("--tag=")) options.tag = argument.slice("--tag=".length);
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (!argv.some((argument) => argument === "--env" || argument.startsWith("--env="))) {
    throw new Error("production_candidate_environment_required");
  }
  if (options.execute && !options.confirmProduction) throw new Error("production_confirmation_required");
  return options;
}

function gitValue(args, code) {
  const result = runProductionReleaseGit(args, { cwd: repositoryRoot });
  if (result.error || result.status !== 0) throw new Error(code);
  return result.stdout.trim();
}

function repositoryState() {
  return {
    clean: gitValue(["status", "--porcelain=v1", "--untracked-files=all"], "production_candidate_source_status_unavailable") === "",
    commitSha: gitValue(["rev-parse", "--verify", "HEAD"], "production_candidate_commit_unavailable"),
    treeSha: gitValue(["rev-parse", "--verify", "HEAD^{tree}"], "production_candidate_tree_unavailable"),
  };
}

function requireToken(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
}

function parseJson(output, code) {
  try {
    return JSON.parse(String(output ?? ""));
  } catch {
    throw new Error(code);
  }
}

async function discoverLiveState(input) {
  const identity = await assertProductionWorkerIdentityAdmission({
    environment: input.identityEnvironment,
    productionSpec: input.productionSpec,
    repositoryRoot,
    stagingSpec: input.stagingSpec,
    token: input.auditToken,
    wranglerConfig: input.wranglerConfig,
  });
  const versions = parseJson((await input.runWranglerImplementation([
    "versions", "list", "--env", "production", "--json",
  ], { cwd: repositoryRoot, env: input.auditEnvironment })).stdout, "production_candidate_versions_invalid");
  const deploymentResult = await cloudflareApiRequest(
    input.auditToken,
    `/accounts/${identity.accountId}/workers/scripts/${encodeURIComponent(identity.workerName)}/deployments`,
  );
  const deployments = Array.isArray(deploymentResult) ? deploymentResult : deploymentResult?.deployments;
  return { activeVersion: productionDeploymentVersion(deployments), identity, versions };
}

function sameAdmission(left, right) {
  return isDeepStrictEqual(left.identity, right.identity)
    && left.activeVersion === right.activeVersion
    && isDeepStrictEqual(left.versions, right.versions);
}

function writeResult(result, json) {
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${result.ok ? "PASS" : "FAIL"} production candidate ${result.executed ? "uploaded" : "plan"}\n`);
}

try {
  const options = parseArguments(process.argv.slice(2));
  const now = new Date();
  const [evidence, generatedManifest, productionSpec, stagingSpec, wranglerConfig, packageJson, migrationNames] = await Promise.all([
    readOptionalJson(EVIDENCE_PATH),
    readOptionalJson(GENERATED_MANIFEST_PATH),
    readOptionalJson(PRODUCTION_SPEC_PATH),
    readOptionalJson(STAGING_SPEC_PATH),
    readFile(WRANGLER_PATH, "utf8").then((text) => JSON.parse(text)),
    readFile(resolve(repositoryRoot, "package.json"), "utf8").then((text) => JSON.parse(text)),
    listMigrationNames(),
  ]);
  if (evidence === null) throw new Error("production_evidence_missing");
  if (generatedManifest === null) throw new Error("production_generated_manifest_missing");
  if (productionSpec === null) throw new Error("production_spec_missing");
  if (stagingSpec === null) throw new Error("staging_spec_missing");
  const source = repositoryState();
  const workerSecretNames = (process.env.SELINOW_WORKER_SECRET_NAMES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const localAdmission = validateProductionCandidateUploadAdmission({
    evidence,
    migrationNames,
    now,
    packageVersion: String(packageJson.version ?? "unknown"),
    productionSpec,
    repositoryClean: source.clean,
    repositoryCommitSha: source.commitSha,
    workerSecretNames,
    wranglerConfig,
  });
  const tag = options.tag || localAdmission.releaseId;
  if (!/^[a-z0-9][a-z0-9._-]{7,80}$/u.test(tag)) throw new Error("production_candidate_tag_invalid");
  if (!options.execute) {
    writeResult({
      actions: [
        { code: "build", ok: true },
        { code: "wrangler_versions_upload_strict", ok: true },
        { code: "candidate_binding_and_live_state_verification", ok: true },
        { code: "private_report_and_evidence_patch", ok: true },
      ],
      environment: "production",
      executed: false,
      ok: true,
    }, options.json);
  } else {
    const operatorEnvironment = { ...process.env };
    const wranglerToolchain = await createProductionWranglerToolchainAttestation(repositoryRoot);
    const attestedWrangler = (args, runOptions = {}) => runAttestedProductionWrangler(
      wranglerToolchain,
      args,
      { ...runOptions, repositoryRoot },
    );
    const auditToken = requireToken(operatorEnvironment, "CLOUDFLARE_ROUTE_AUDIT_API_TOKEN");
    const workerToken = requireToken(operatorEnvironment, "CLOUDFLARE_RELEASE_WORKER_API_TOKEN");
    const auditEnvironment = buildProductionReleaseAuditEnvironment(
      operatorEnvironment,
      productionSpec.accountId,
      auditToken,
    );
    const editEnvironment = buildProductionReleaseEditEnvironment(
      operatorEnvironment,
      productionSpec.accountId,
      workerToken,
    );
    const liveInput = {
      auditEnvironment,
      auditToken,
      identityEnvironment: auditEnvironment,
      productionSpec,
      runWranglerImplementation: attestedWrangler,
      stagingSpec,
      wranglerConfig,
    };
    const before = await discoverLiveState(liveInput);
    if (before.activeVersion !== localAdmission.previousWorkerVersion) {
      throw new Error("production_candidate_previous_version_mismatch");
    }
    run("npm", ["run", "build"], {
      capture: false,
      cwd: repositoryRoot,
      env: buildCanaryBuildEnvironment(operatorEnvironment),
    });
    const builtSource = repositoryState();
    if (
      builtSource.clean !== true
      || builtSource.commitSha !== source.commitSha
      || builtSource.treeSha !== source.treeSha
    ) {
      throw new Error("production_candidate_source_changed_after_build");
    }
    await assertProductionWranglerToolchain(wranglerToolchain, repositoryRoot);
    const admitted = await discoverLiveState(liveInput);
    if (!sameAdmission(before, admitted)) throw new Error("production_candidate_admission_changed");
    const preUploadSource = repositoryState();
    if (
      preUploadSource.clean !== true
      || preUploadSource.commitSha !== builtSource.commitSha
      || preUploadSource.treeSha !== builtSource.treeSha
    ) {
      throw new Error("production_candidate_source_changed_before_upload");
    }
    const { artifactSha256, stageRoot, uploadConfigSha256 } = await stageProductionUploadInputs(
      repositoryRoot,
      localAdmission.releaseId,
      {
        generatedManifest,
        productionSpec,
      },
    );
    let after;
    let bindingNames;
    let candidateWorkerVersion;
    try {
      await attestedWrangler([
        "versions", "upload",
        "dist/server/entry.mjs",
        "--config", "production-upload-wrangler.json",
        "--no-bundle",
        "--assets", "dist/client",
        "--strict",
        "--tag", tag,
        "--message", `normal release candidate ${source.commitSha}`,
      ], { cwd: stageRoot, env: editEnvironment });
      await assertProductionWranglerToolchain(wranglerToolchain, repositoryRoot);
      const postUploadSource = repositoryState();
      const [
        postUploadArtifactSha256,
        stagedPostUploadArtifactSha256,
        stagedPostUploadConfigSha256,
      ] = await Promise.all([
        fingerprintProductionUploadInputs(repositoryRoot),
        fingerprintProductionUploadInputs(stageRoot),
        readFile(resolve(stageRoot, "production-upload-wrangler.json")).then((value) => (
          createHash("sha256").update(value).digest("hex")
        )),
      ]);
      if (
        postUploadSource.clean !== true
        || postUploadSource.commitSha !== preUploadSource.commitSha
        || postUploadSource.treeSha !== preUploadSource.treeSha
        || postUploadArtifactSha256 !== artifactSha256
        || stagedPostUploadArtifactSha256 !== artifactSha256
        || stagedPostUploadConfigSha256 !== uploadConfigSha256
      ) {
        throw new Error("production_candidate_upload_inputs_changed_during_upload");
      }
      after = await discoverLiveState(liveInput);
      if (!isDeepStrictEqual(admitted.identity, after.identity) || after.activeVersion !== admitted.activeVersion) {
        throw new Error("production_candidate_upload_changed_live_state");
      }
      candidateWorkerVersion = captureProductionCandidateVersion({
        activeVersionId: admitted.activeVersion,
        afterVersions: after.versions,
        beforeVersions: admitted.versions,
      });
      const candidateView = parseJson((await attestedWrangler([
        "versions", "view", candidateWorkerVersion, "--env", "production", "--json",
      ], { cwd: repositoryRoot, env: auditEnvironment })).stdout, "production_candidate_view_invalid");
      bindingNames = validateProductionCandidateVersionView(candidateView, candidateWorkerVersion, {
        generatedManifest,
        productionSpec,
        wranglerConfig,
      });
      validateProductionCandidateVersionProvenance(candidateView, {
        commitSha: postUploadSource.commitSha,
        tag,
      });
    } finally {
      await removeProductionUploadStage(stageRoot, repositoryRoot, localAdmission.releaseId);
    }
    const report = {
      accountId: after.identity.accountId,
      artifactSha256,
      uploadConfigSha256,
      wranglerToolchainSha256: wranglerToolchain.fingerprintSha256,
      bindingNames,
      candidateWorkerVersion,
      createdAt: now.toISOString(),
      environment: "production",
      mode: "normal_release_candidate_upload",
      previousWorkerVersion: admitted.activeVersion,
      releaseId: localAdmission.releaseId,
      reviewedCommitSha: builtSource.commitSha,
      reviewedTreeSha: builtSource.treeSha,
      schemaVersion: 1,
      tag,
      workerName: after.identity.workerName,
      zoneId: after.identity.zoneId,
    };
    const artifacts = await writeProductionCandidateArtifacts({
      evidence,
      evidencePath: EVIDENCE_PATH,
      report,
      repositoryRoot,
    });
    writeResult({
      actions: [
        { code: "worker_version_uploaded", detail: candidateWorkerVersion, ok: true },
        { code: "live_deployment_unchanged", detail: admitted.activeVersion, ok: true },
        { code: "candidate_bindings_verified", detail: bindingNames.length, ok: true },
      ],
      candidateWorkerVersion,
      environment: "production",
      executed: true,
      ok: true,
      reportRef: artifacts.reportRef,
    }, options.json);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "production_candidate_failed";
  const code = /^[A-Za-z0-9_:.-]{1,240}$/u.test(message) ? message : "production_candidate_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
