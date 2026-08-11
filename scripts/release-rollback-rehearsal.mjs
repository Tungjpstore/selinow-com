import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildProductionRollbackRehearsalArtifact,
  listMigrationNames,
  readOptionalJson,
  validateProductionRollbackArtifact,
  writeProductionRollbackRehearsalArtifact,
} from "./lib/release.mjs";
import { run, runWrangler } from "./lib/cli.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function parseArguments(argv) {
  const options = {
    confirmMaintenanceDrain: false,
    confirmProduction: false,
    evidencePath: resolve(repositoryRoot, ".wrangler/release/production-evidence.json"),
    execute: false,
    json: false,
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--json") options.json = true;
    else if (argument === "--write") options.write = true;
    else if (argument === "--execute") options.execute = true;
    else if (argument === "--confirm-production") options.confirmProduction = true;
    else if (argument === "--confirm-maintenance-drain") options.confirmMaintenanceDrain = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (options.execute && options.write) throw new Error("production_rollback_rehearsal_mode_conflict");
  if (options.execute && !options.confirmProduction) throw new Error("production_confirmation_required");
  if (options.execute && !options.confirmMaintenanceDrain) throw new Error("maintenance_drain_confirmation_required");
  return options;
}

function parseJsonOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("production_rollback_active_version_invalid");
  }
}

function activeVersionFromDeployments(payload) {
  const deployments = Array.isArray(payload) ? payload : payload?.deployments;
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error("production_rollback_active_version_invalid");
  }
  const first = [...deployments].sort((left, right) => (
    Date.parse(right?.created_on ?? right?.createdOn ?? "")
    - Date.parse(left?.created_on ?? left?.createdOn ?? "")
  ))[0];
  const version = first?.versionId
    ?? (Array.isArray(first?.versions) && first.versions.length === 1 && first.versions[0]?.percentage === 100
      ? first.versions[0]?.version_id
      : null);
  if (typeof version !== "string" || !UUID_PATTERN.test(version)) {
    throw new Error("production_rollback_active_version_invalid");
  }
  return version;
}

function defaultOperations({
  canaryUrl = "https://canary.selinow.com/",
  commandEnvironment = process.env,
  repositoryRoot: root = repositoryRoot,
} = {}) {
  const deploy = async (version, role) => {
    runWrangler([
      "versions", "deploy", `${version}@100%`, "--env", "production", "--yes",
      "--message", `rollback rehearsal ${role} ${version}`,
    ], { cwd: root, env: commandEnvironment });
  };
  const active = async () => activeVersionFromDeployments(parseJsonOutput(runWrangler(
    ["deployments", "list", "--env", "production", "--json"],
    { cwd: root, env: commandEnvironment },
  ).stdout));
  return {
    deployWorkerVersion: deploy,
    getActiveWorkerVersion: active,
    restoreWorkerVersion: (version) => deploy(version, "restore"),
    smokeCanary: async () => {
      const response = await globalThis.fetch(canaryUrl, {
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(15_000),
      });
      if (!response || response.status < 200 || response.status >= 400) {
        throw new Error("production_rollback_canary_smoke_failed");
      }
      // Read only a bounded body so a broken Worker cannot exhaust the rehearsal process.
      await response.body?.cancel?.();
      return { status: response.status };
    },
    verifyActiveWorkerVersion: active,
  };
}

function authorizingArtifact(input, completedAt) {
  const artifact = buildProductionRollbackRehearsalArtifact({ ...input, now: new Date(completedAt) });
  artifact.rehearsal = {
    authorizesProductionAdmission: true,
    completedAt,
    kind: "live_rollback_rehearsal",
    result: "passed",
  };
  return artifact;
}

function assertRepositorySourceBinding(evidence, root) {
  const git = (args) => run("git", args, { cwd: root }).stdout.trim();
  let commitSha;
  let treeSha;
  let status;
  let rollbackCommitSha;
  let rollbackTreeSha;
  try {
    commitSha = git(["rev-parse", "--verify", "HEAD^{commit}"]);
    treeSha = git(["rev-parse", "--verify", "HEAD^{tree}"]);
    status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
    rollbackCommitSha = git(["rev-parse", "--verify", `${evidence.rollback.candidate.commitSha}^{commit}`]);
    rollbackTreeSha = git(["rev-parse", "--verify", `${evidence.rollback.candidate.commitSha}^{tree}`]);
  } catch (error) {
    throw new Error("production_rollback_rehearsal_source_unavailable", { cause: error });
  }
  if (status !== "" || commitSha !== evidence.commitSha || treeSha !== evidence.treeSha) {
    throw new Error("production_rollback_rehearsal_source_mismatch");
  }
  if (rollbackCommitSha !== evidence.rollback.candidate.commitSha
    || rollbackTreeSha !== evidence.rollback.candidate.treeSha) {
    throw new Error("production_rollback_rehearsal_rollback_source_invalid");
  }
}

async function writeAuthorizingArtifact({ artifact, evidence, migrationNames, repositoryRoot: root }) {
  const evidenceRef = `.wrangler/releases/${evidence.releaseId}/rollback-rehearsal.json`;
  const artifactPath = resolve(root, evidenceRef);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
  const rollback = evidence.rollback;
  rollback.rehearsedAt = artifact.rehearsal.completedAt;
  rollback.candidate.rehearsedAt = artifact.rehearsal.completedAt;
  rollback.candidate.evidenceRef = evidenceRef;
  rollback.candidate.artifactSha256 = artifactSha256;
  rollback.rehearsalEvidenceRef = evidenceRef;

  const directory = dirname(artifactPath);
  const temporaryPath = `${artifactPath}.tmp-${process.pid}`;
  const backupPath = `${artifactPath}.bak-${process.pid}`;
  await mkdir(directory, { mode: 0o700, recursive: true });
  await writeFile(temporaryPath, bytes, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  let hadPrevious = false;
  try {
    if (existsSync(artifactPath)) {
      await rename(artifactPath, backupPath);
      hadPrevious = true;
    }
    await rename(temporaryPath, artifactPath);
    validateProductionRollbackArtifact({ evidence, migrationNames, repositoryRoot: root });
    if (hadPrevious) await rm(backupPath, { force: true });
  } catch (error) {
    await rm(artifactPath, { force: true });
    if (hadPrevious) await rename(backupPath, artifactPath);
    throw error;
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { artifact, artifactSha256, evidenceRef };
}

export async function executeProductionRollbackRehearsal(input) {
  const evidence = input?.evidence;
  const migrationNames = input?.migrationNames;
  const root = input?.repositoryRoot ?? repositoryRoot;
  const operations = { ...defaultOperations(input), ...(input?.operations ?? {}) };
  if (typeof operations.getActiveWorkerVersion !== "function"
    || typeof operations.deployWorkerVersion !== "function"
    || typeof operations.restoreWorkerVersion !== "function"
    || typeof operations.verifyActiveWorkerVersion !== "function"
    || typeof operations.smokeCanary !== "function") {
    throw new Error("production_rollback_rehearsal_operations_missing");
  }
  const previousVersion = evidence?.previousWorkerVersion;
  const rollbackVersion = evidence?.rollback?.candidate?.workerVersion;
  if (!UUID_PATTERN.test(previousVersion ?? "") || !UUID_PATTERN.test(rollbackVersion ?? "")
    || previousVersion === rollbackVersion) {
    throw new Error("production_rollback_rehearsal_input_invalid");
  }
  // Fail before any live mutation if the schema/source-bound compatibility contract is invalid.
  buildProductionRollbackRehearsalArtifact({ evidence, migrationNames, now: input?.now });
  const sourceAdmission = input?.assertSourceBindingImplementation ?? assertRepositorySourceBinding;
  await sourceAdmission(evidence, root);
  const current = await operations.getActiveWorkerVersion();
  if (current !== previousVersion) throw new Error("production_rollback_rehearsal_previous_not_active");

  let rollbackAttempted = false;
  let primaryError = null;
  let restoreError = null;
  let restored = false;
  try {
    rollbackAttempted = true;
    await operations.deployWorkerVersion(rollbackVersion, "rollback");
    const activeRollback = await operations.verifyActiveWorkerVersion();
    if (activeRollback !== rollbackVersion) throw new Error("production_rollback_rehearsal_rollback_not_active");
    await operations.smokeCanary({ url: input?.canaryUrl ?? "https://canary.selinow.com/", workerVersion: rollbackVersion });
  } catch (error) {
    primaryError = error;
  } finally {
    if (rollbackAttempted) {
      try {
        await operations.restoreWorkerVersion(previousVersion);
        const activeRestored = await operations.verifyActiveWorkerVersion();
        if (activeRestored !== previousVersion) {
          restoreError = new Error("production_rollback_rehearsal_restore_not_active");
        } else {
          restored = true;
        }
      } catch (error) {
        restoreError = error;
      }
    }
  }
  if (restoreError !== null) {
    throw new Error("production_rollback_rehearsal_restore_failed", { cause: restoreError });
  }
  if (primaryError !== null) throw primaryError;
  if (!restored) throw new Error("production_rollback_rehearsal_restore_failed");

  const completedAt = new Date(input?.now ?? Date.now()).toISOString();
  const artifact = authorizingArtifact({ evidence, migrationNames, repositoryRoot: root }, completedAt);
  const writer = input?.writeAuthorizingArtifact ?? writeAuthorizingArtifact;
  return writer({ artifact, evidence, migrationNames, repositoryRoot: root });
}

export async function runProductionRollbackRehearsal(options, dependencies = {}) {
  const evidence = await readOptionalJson(options.evidencePath);
  if (evidence === null) throw new Error("production_evidence_missing");
  const migrationNames = await listMigrationNames();
  const input = { evidence, migrationNames, now: new Date(), repositoryRoot, ...dependencies };
  if (options.execute) {
    const result = await executeProductionRollbackRehearsal(input);
    return {
      authorizesProductionAdmission: true,
      artifactSha256: result.artifactSha256,
      environment: "production",
      evidenceRef: result.evidenceRef,
      mode: "live_rollback_rehearsal",
      ok: true,
    };
  }
  const artifact = buildProductionRollbackRehearsalArtifact(input);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const result = options.write
    ? await writeProductionRollbackRehearsalArtifact(input)
    : {
      artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      evidenceRef: `.wrangler/releases/${evidence.releaseId}/rollback-rehearsal.json`,
    };
  return {
    authorizesProductionAdmission: false,
    artifactSha256: result.artifactSha256,
    environment: "production",
    evidenceRef: result.evidenceRef,
    mode: "schema_compatibility_validation",
    ok: true,
  };
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const output = await runProductionRollbackRehearsal(options);
    process.stdout.write(options.json
      ? `${JSON.stringify(output, null, 2)}\n`
      : `PASS rollback ${output.mode} ${options.write ? "written" : "validated"}: ${output.evidenceRef}\n`);
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(error.message)
      ? error.message
      : "production_rollback_rehearsal_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
