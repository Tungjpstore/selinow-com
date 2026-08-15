import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { run, runWrangler } from "./cli.mjs";
import { listMigrationNames } from "./release.mjs";
import {
  assertStagingMutationAdmission,
  buildPinnedCloudflareEnvironment,
  repositoryRoot,
} from "./platform.mjs";

const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}$/u;
const RELEASE_ID_PATTERN = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const DATABASE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function exactKeys(value, expected, issue) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(issue);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(issue);
  }
}

function readGitValue(root, args, issue) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(issue);
  return result.stdout.trim();
}

export function readStagingRepositoryState(root = repositoryRoot) {
  const status = readGitValue(root, ["status", "--porcelain=v1", "--untracked-files=all"], "staging_release_source_status_unavailable");
  return {
    clean: status.length === 0,
    commitSha: readGitValue(root, ["rev-parse", "--verify", "HEAD"], "staging_release_commit_unavailable"),
    treeSha: readGitValue(root, ["rev-parse", "--verify", "HEAD^{tree}"], "staging_release_tree_unavailable"),
  };
}

export function validateStagingReleaseManifest(input) {
  exactKeys(input.repositoryState, ["clean", "commitSha", "treeSha"], "staging_release_repository_state_invalid");
  exactKeys(input.manifest, [
    "commitSha",
    "continuationEvidence",
    "createdAt",
    "databaseTarget",
    "environment",
    "expiresAt",
    "migrationLedgerPrefix",
    "migrationNames",
    "releaseId",
    "schemaVersion",
    "treeSha",
  ], "staging_release_manifest_invalid");
  exactKeys(input.manifest.databaseTarget, ["accountId", "databaseId", "databaseName"], "staging_release_manifest_invalid");
  exactKeys(input.manifest.continuationEvidence, [
    "backupChecksumSha256",
    "backupCompletedAt",
    "backupReportRef",
    "backupSizeBytes",
    "backupSnapshotId",
    "restoreCompletedAt",
    "restoreReportRef",
    "restoreSnapshotId",
    "restoreTargetResourceRef",
  ], "staging_release_manifest_invalid");
  if (input.repositoryState.clean !== true) throw new Error("staging_release_source_dirty");
  if (!GIT_OBJECT_PATTERN.test(input.repositoryState.commitSha ?? "")) throw new Error("staging_release_commit_unavailable");
  if (!GIT_OBJECT_PATTERN.test(input.repositoryState.treeSha ?? "")) throw new Error("staging_release_tree_unavailable");
  if (input.manifest.schemaVersion !== 3 || input.manifest.environment !== "staging") {
    throw new Error("staging_release_manifest_invalid");
  }
  if (!ACCOUNT_ID_PATTERN.test(input.manifest.databaseTarget.accountId ?? "")
    || !DATABASE_ID_PATTERN.test(input.manifest.databaseTarget.databaseId ?? "")
    || typeof input.manifest.databaseTarget.databaseName !== "string"
    || input.manifest.databaseTarget.databaseName.length < 1
    || input.manifest.databaseTarget.databaseName.length > 128
    || !SHA256_PATTERN.test(input.manifest.continuationEvidence.backupChecksumSha256 ?? "")
    || !Number.isSafeInteger(input.manifest.continuationEvidence.backupSizeBytes)
    || input.manifest.continuationEvidence.backupSizeBytes < 1) {
    throw new Error("staging_release_manifest_invalid");
  }
  if (!RELEASE_ID_PATTERN.test(input.manifest.releaseId ?? "")) throw new Error("staging_release_id_invalid");
  if (input.manifest.commitSha !== input.repositoryState.commitSha) throw new Error("staging_release_commit_mismatch");
  if (input.manifest.treeSha !== input.repositoryState.treeSha) throw new Error("staging_release_tree_mismatch");
  if (!Array.isArray(input.manifest.migrationNames)
    || input.manifest.migrationNames.length !== input.migrationNames.length
    || input.manifest.migrationNames.some((name, index) => name !== input.migrationNames[index])) {
    throw new Error("staging_release_migration_ledger_mismatch");
  }
  if (!Array.isArray(input.manifest.migrationLedgerPrefix)
    || input.manifest.migrationLedgerPrefix.length === 0
    || input.manifest.migrationLedgerPrefix.length > input.migrationNames.length
    || input.manifest.migrationLedgerPrefix.some((name, index) => name !== input.migrationNames[index])) {
    throw new Error("staging_release_migration_ledger_baseline_mismatch");
  }
  const createdAt = new Date(input.manifest.createdAt ?? "");
  const expiresAt = new Date(input.manifest.expiresAt ?? "");
  const now = input.now ?? new Date();
  if (!Number.isFinite(createdAt.getTime())
    || !Number.isFinite(expiresAt.getTime())
    || createdAt.toISOString() !== input.manifest.createdAt
    || expiresAt.toISOString() !== input.manifest.expiresAt
    || createdAt.getTime() > now.getTime() + 5 * 60_000
    || expiresAt.getTime() <= createdAt.getTime()
    || expiresAt.getTime() - createdAt.getTime() > 7 * 24 * 60 * 60_000
    || now.getTime() > expiresAt.getTime()) {
    throw new Error("staging_release_window_invalid");
  }
  return {
    commitSha: input.repositoryState.commitSha,
    continuationEvidence: input.manifest.continuationEvidence,
    createdAt: input.manifest.createdAt,
    databaseTarget: input.manifest.databaseTarget,
    migrationLedgerPrefix: input.manifest.migrationLedgerPrefix,
    migrationNames: input.manifest.migrationNames,
    releaseId: input.manifest.releaseId,
    treeSha: input.repositoryState.treeSha,
  };
}

export async function buildStagingReleaseManifest(input = {}) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const repositoryState = input.repositoryState ?? readStagingRepositoryState(root);
  if (repositoryState.clean !== true) throw new Error("staging_release_source_dirty");
  if (!GIT_OBJECT_PATTERN.test(repositoryState.commitSha ?? "")) throw new Error("staging_release_commit_unavailable");
  if (!GIT_OBJECT_PATTERN.test(repositoryState.treeSha ?? "")) throw new Error("staging_release_tree_unavailable");
  const now = input.now ?? new Date();
  const compactTimestamp = now.toISOString().replaceAll(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const releaseId = `stg_${compactTimestamp}_${repositoryState.commitSha.slice(0, 12)}`;
  const migrationNames = input.migrationNames ?? await listMigrationNames(root);
  if (input.databaseTarget === undefined || input.continuationEvidence === undefined) {
    throw new Error("staging_release_continuation_evidence_required");
  }
  if (input.migrationLedgerPrefix === undefined) {
    throw new Error("staging_release_migration_ledger_baseline_required");
  }
  if (!Array.isArray(input.migrationLedgerPrefix)
    || input.migrationLedgerPrefix.length === 0
    || input.migrationLedgerPrefix.length > migrationNames.length
    || input.migrationLedgerPrefix.some((name, index) => name !== migrationNames[index])) {
    throw new Error("staging_release_migration_ledger_baseline_mismatch");
  }
  return {
    commitSha: repositoryState.commitSha,
    continuationEvidence: {
      backupChecksumSha256: input.continuationEvidence.backup.checksumSha256,
      backupCompletedAt: input.continuationEvidence.backup.completedAt,
      backupReportRef: input.continuationEvidence.backup.reportRef,
      backupSizeBytes: input.continuationEvidence.backup.sizeBytes,
      backupSnapshotId: input.continuationEvidence.backup.snapshotId,
      restoreCompletedAt: input.continuationEvidence.restore.completedAt,
      restoreReportRef: input.continuationEvidence.restore.reportRef,
      restoreSnapshotId: input.continuationEvidence.restore.snapshotId,
      restoreTargetResourceRef: input.continuationEvidence.restore.targetResourceRef,
    },
    createdAt: now.toISOString(),
    databaseTarget: input.databaseTarget,
    environment: "staging",
    expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    migrationLedgerPrefix: input.migrationLedgerPrefix,
    migrationNames,
    releaseId,
    schemaVersion: 3,
    treeSha: repositoryState.treeSha,
  };
}

export function assertStagingContinuationBinding(admission, continuationEvidence, databaseTarget) {
  const expected = admission.continuationEvidence;
  const actual = {
    backupChecksumSha256: continuationEvidence.backup.checksumSha256,
    backupCompletedAt: continuationEvidence.backup.completedAt,
    backupReportRef: continuationEvidence.backup.reportRef,
    backupSizeBytes: continuationEvidence.backup.sizeBytes,
    backupSnapshotId: continuationEvidence.backup.snapshotId,
    restoreCompletedAt: continuationEvidence.restore.completedAt,
    restoreReportRef: continuationEvidence.restore.reportRef,
    restoreSnapshotId: continuationEvidence.restore.snapshotId,
    restoreTargetResourceRef: continuationEvidence.restore.targetResourceRef,
  };
  if (Object.keys(expected).some((key) => expected[key] !== actual[key])
    || admission.databaseTarget.accountId !== databaseTarget.accountId
    || admission.databaseTarget.databaseId !== databaseTarget.databaseId
    || admission.databaseTarget.databaseName !== databaseTarget.databaseName) {
    throw new Error("staging_release_continuation_evidence_mismatch");
  }
}

function stagingReleaseArtifactPath(root, releaseId, fileName) {
  if (!RELEASE_ID_PATTERN.test(releaseId ?? "")) throw new Error("staging_release_id_invalid");
  return resolve(root, ".wrangler", "releases", "staging", releaseId, fileName);
}

async function writeImmutableStagingReleaseArtifact(root, releaseId, fileName, value, issue) {
  const artifactPath = stagingReleaseArtifactPath(root, releaseId, fileName);
  await mkdir(dirname(artifactPath), { mode: 0o700, recursive: true });
  await chmod(dirname(artifactPath), 0o700);
  try {
    await writeFile(artifactPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(issue, { cause: error });
    throw error;
  }
  await chmod(artifactPath, 0o600);
  return artifactPath;
}

async function assertCanonicalStagingArtifactPath(path, root, issue) {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  const rel = relative(absoluteRoot, absolutePath);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel.includes(`${sep}..${sep}`)) throw new Error(issue);
  let current = absoluteRoot;
  for (const segment of rel.split(sep)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(issue);
    } catch (error) {
      if (error instanceof Error && error.message === issue) throw error;
      if (error?.code === "ENOENT") return;
      throw new Error(issue, { cause: error });
    }
  }
}

async function readPrivateStagingReleaseArtifact(path, missingIssue, permissionsIssue) {
  let artifact;
  let artifactStat;
  try {
    [artifact, artifactStat] = await Promise.all([
      readFile(path, "utf8").then((value) => JSON.parse(value)),
      lstat(path),
    ]);
  } catch {
    throw new Error(missingIssue);
  }
  if (!artifactStat.isFile() || (artifactStat.mode & 0o077) !== 0) {
    throw new Error(permissionsIssue);
  }
  return artifact;
}

function assertExactDatabaseTarget(actual, expected, issue) {
  exactKeys(actual, ["accountId", "databaseId", "databaseName"], issue);
  if (actual.accountId !== expected.accountId
    || actual.databaseId !== expected.databaseId
    || actual.databaseName !== expected.databaseName) {
    throw new Error(issue);
  }
}

function assertExactMigrationNames(actual, expected, issue) {
  if (!Array.isArray(actual)
    || actual.length !== expected.length
    || actual.some((name, index) => name !== expected[index])) {
    throw new Error(issue);
  }
}

export function buildStagingMigrationCompletion(input) {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("staging_migration_completion_invalid");
  assertExactDatabaseTarget(
    input.databaseTarget,
    input.releaseAdmission.databaseTarget,
    "staging_migration_completion_target_mismatch",
  );
  assertExactMigrationNames(
    input.migrationNames,
    input.releaseAdmission.migrationNames,
    "staging_migration_completion_ledger_mismatch",
  );
  if (now.getTime() < new Date(input.releaseAdmission.createdAt).getTime()) {
    throw new Error("staging_migration_completion_invalid");
  }
  return {
    commitSha: input.releaseAdmission.commitSha,
    completedAt: now.toISOString(),
    databaseTarget: { ...input.databaseTarget },
    environment: "staging",
    migrationNames: [...input.migrationNames],
    releaseId: input.releaseAdmission.releaseId,
    schemaVersion: 1,
    treeSha: input.releaseAdmission.treeSha,
  };
}

export function writeStagingMigrationCompletion(completion, root = repositoryRoot) {
  return writeImmutableStagingReleaseArtifact(
    root,
    completion.releaseId,
    "migration-completion.json",
    completion,
    "staging_migration_completion_exists",
  );
}

export async function assertStagingMigrationCompletion(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const artifactPath = stagingReleaseArtifactPath(
    root,
    input.releaseAdmission.releaseId,
    "migration-completion.json",
  );
  const completion = await readPrivateStagingReleaseArtifact(
    artifactPath,
    "staging_migration_completion_missing",
    "staging_migration_completion_permissions_invalid",
  );
  exactKeys(completion, [
    "commitSha",
    "completedAt",
    "databaseTarget",
    "environment",
    "migrationNames",
    "releaseId",
    "schemaVersion",
    "treeSha",
  ], "staging_migration_completion_invalid");
  assertExactDatabaseTarget(
    completion.databaseTarget,
    input.databaseTarget,
    "staging_migration_completion_target_mismatch",
  );
  assertExactMigrationNames(
    completion.migrationNames,
    input.migrationNames,
    "staging_migration_completion_ledger_mismatch",
  );
  const completedAt = new Date(completion.completedAt ?? "");
  const now = input.now ?? new Date();
  if (completion.schemaVersion !== 1
    || completion.environment !== "staging"
    || completion.releaseId !== input.releaseAdmission.releaseId
    || completion.commitSha !== input.releaseAdmission.commitSha
    || completion.treeSha !== input.releaseAdmission.treeSha
    || !Number.isFinite(completedAt.getTime())
    || completedAt.toISOString() !== completion.completedAt
    || completedAt.getTime() < new Date(input.releaseAdmission.createdAt).getTime()
    || completedAt.getTime() > now.getTime()) {
    throw new Error("staging_migration_completion_invalid");
  }
  return completion;
}

function continuationEvidenceRecord(continuationEvidence) {
  return {
    backupChecksumSha256: continuationEvidence.backup.checksumSha256,
    backupCompletedAt: continuationEvidence.backup.completedAt,
    backupReportRef: continuationEvidence.backup.reportRef,
    backupSizeBytes: continuationEvidence.backup.sizeBytes,
    backupSnapshotId: continuationEvidence.backup.snapshotId,
    restoreCompletedAt: continuationEvidence.restore.completedAt,
    restoreReportRef: continuationEvidence.restore.reportRef,
    restoreSnapshotId: continuationEvidence.restore.snapshotId,
    restoreTargetResourceRef: continuationEvidence.restore.targetResourceRef,
  };
}

export function buildStagingPostMigrationEvidence(input) {
  const now = input.now ?? new Date();
  const evidence = continuationEvidenceRecord(input.continuationEvidence);
  const backupCompletedAt = new Date(evidence.backupCompletedAt);
  const restoreCompletedAt = new Date(evidence.restoreCompletedAt);
  const migrationCompletedAt = new Date(input.migrationCompletion.completedAt);
  assertExactDatabaseTarget(
    input.databaseTarget,
    input.releaseAdmission.databaseTarget,
    "staging_post_migration_target_mismatch",
  );
  assertExactMigrationNames(
    input.migrationNames,
    input.releaseAdmission.migrationNames,
    "staging_post_migration_ledger_mismatch",
  );
  if (input.migrationCompletion.releaseId !== input.releaseAdmission.releaseId
    || input.migrationCompletion.commitSha !== input.releaseAdmission.commitSha
    || input.migrationCompletion.treeSha !== input.releaseAdmission.treeSha
    || evidence.backupSnapshotId === input.releaseAdmission.continuationEvidence.backupSnapshotId
    || evidence.restoreReportRef === input.releaseAdmission.continuationEvidence.restoreReportRef
    || !Number.isFinite(now.getTime())
    || !Number.isFinite(backupCompletedAt.getTime())
    || !Number.isFinite(restoreCompletedAt.getTime())
    || !Number.isFinite(migrationCompletedAt.getTime())
    || backupCompletedAt.getTime() <= migrationCompletedAt.getTime()
    || restoreCompletedAt.getTime() < backupCompletedAt.getTime()
    || restoreCompletedAt.getTime() > now.getTime()) {
    throw new Error("staging_post_migration_evidence_invalid");
  }
  return {
    commitSha: input.releaseAdmission.commitSha,
    completedAt: now.toISOString(),
    continuationEvidence: evidence,
    databaseTarget: { ...input.databaseTarget },
    environment: "staging",
    migrationCompletedAt: input.migrationCompletion.completedAt,
    migrationNames: [...input.migrationNames],
    releaseId: input.releaseAdmission.releaseId,
    schemaVersion: 1,
    treeSha: input.releaseAdmission.treeSha,
  };
}

export function writeStagingPostMigrationEvidence(evidence, root = repositoryRoot) {
  return writeImmutableStagingReleaseArtifact(
    root,
    evidence.releaseId,
    "post-migration-evidence.json",
    evidence,
    "staging_post_migration_evidence_exists",
  );
}

export async function readStagingPostMigrationEvidence(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const artifactPath = stagingReleaseArtifactPath(
    root,
    input.releaseAdmission.releaseId,
    "post-migration-evidence.json",
  );
  const evidence = await readPrivateStagingReleaseArtifact(
    artifactPath,
    "staging_post_migration_evidence_missing",
    "staging_post_migration_evidence_permissions_invalid",
  );
  exactKeys(evidence, [
    "commitSha",
    "completedAt",
    "continuationEvidence",
    "databaseTarget",
    "environment",
    "migrationCompletedAt",
    "migrationNames",
    "releaseId",
    "schemaVersion",
    "treeSha",
  ], "staging_post_migration_evidence_invalid");
  exactKeys(evidence.continuationEvidence, [
    "backupChecksumSha256",
    "backupCompletedAt",
    "backupReportRef",
    "backupSizeBytes",
    "backupSnapshotId",
    "restoreCompletedAt",
    "restoreReportRef",
    "restoreSnapshotId",
    "restoreTargetResourceRef",
  ], "staging_post_migration_evidence_invalid");
  assertExactDatabaseTarget(
    evidence.databaseTarget,
    input.databaseTarget,
    "staging_post_migration_target_mismatch",
  );
  assertExactMigrationNames(
    evidence.migrationNames,
    input.migrationNames,
    "staging_post_migration_ledger_mismatch",
  );
  const completedAt = new Date(evidence.completedAt ?? "");
  const migrationCompletedAt = new Date(evidence.migrationCompletedAt ?? "");
  if (evidence.schemaVersion !== 1
    || evidence.environment !== "staging"
    || evidence.releaseId !== input.releaseAdmission.releaseId
    || evidence.commitSha !== input.releaseAdmission.commitSha
    || evidence.treeSha !== input.releaseAdmission.treeSha
    || evidence.migrationCompletedAt !== input.migrationCompletion.completedAt
    || !Number.isFinite(completedAt.getTime())
    || completedAt.toISOString() !== evidence.completedAt
    || !Number.isFinite(migrationCompletedAt.getTime())
    || completedAt.getTime() < migrationCompletedAt.getTime()
    || completedAt.getTime() > (input.now ?? new Date()).getTime()) {
    throw new Error("staging_post_migration_evidence_invalid");
  }
  return evidence;
}

export async function assertStagingPostMigrationEvidence(input) {
  const evidence = await readStagingPostMigrationEvidence(input);
  const expected = buildStagingPostMigrationEvidence({
    continuationEvidence: input.continuationEvidence,
    databaseTarget: input.databaseTarget,
    migrationCompletion: input.migrationCompletion,
    migrationNames: input.migrationNames,
    now: new Date(evidence.completedAt),
    releaseAdmission: input.releaseAdmission,
  });
  if (JSON.stringify(evidence) !== JSON.stringify(expected)) {
    throw new Error("staging_post_migration_evidence_mismatch");
  }
  return evidence;
}

export function parseStagingMigrationLedgerOutput(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("staging_migration_ledger_invalid_json");
  }
  const envelopes = Array.isArray(payload) ? payload : [payload];
  if (envelopes.length === 0 || envelopes.some((envelope) => !Array.isArray(envelope?.results))) {
    throw new Error("staging_migration_ledger_invalid_result");
  }
  const names = envelopes.flatMap((envelope) => envelope.results).map((row) => row?.name);
  if (names.some((name) => typeof name !== "string") || new Set(names).size !== names.length) {
    throw new Error("staging_migration_ledger_invalid_result");
  }
  return names;
}

function readStagingMigrationLedger(input, root) {
  const runner = input.runWranglerImplementation ?? runWrangler;
  let output;
  try {
    output = runner([
      "d1", "execute", "PLATFORM_DB", "--env", "staging", "--remote",
      "--command", "SELECT name FROM d1_migrations ORDER BY name;", "--json",
    ], {
      cwd: root,
      env: input.environment,
    }).stdout;
  } catch {
    throw new Error("staging_migration_ledger_unavailable");
  }
  return parseStagingMigrationLedgerOutput(output);
}

export async function assertStagingMigrationLedger(input = {}) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const expected = input.migrationNames ?? await listMigrationNames(root);
  const observed = readStagingMigrationLedger(input, root);
  if (observed.length !== expected.length || observed.some((name, index) => name !== expected[index])) {
    throw new Error("staging_migration_ledger_incomplete");
  }
  return { migrationNames: observed };
}

/** A migration sink may advance only a contiguous prefix of the reviewed source ledger. */
export async function assertStagingMigrationLedgerPrefix(input = {}) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const expected = input.migrationNames ?? await listMigrationNames(root);
  if (input.expectedPrefix !== undefined
    && (!Array.isArray(input.expectedPrefix)
      || input.expectedPrefix.length === 0
      || input.expectedPrefix.length > expected.length
      || input.expectedPrefix.some((name, index) => name !== expected[index]))) {
    throw new Error("staging_migration_ledger_baseline_mismatch");
  }
  const observed = readStagingMigrationLedger(input, root);
  if (observed.length === 0) {
    throw new Error("staging_migration_ledger_prefix_empty");
  }
  if (observed.length > expected.length || observed.some((name, index) => name !== expected[index])) {
    throw new Error("staging_migration_ledger_prefix_invalid");
  }
  if (input.expectedPrefix !== undefined
    && (observed.length !== input.expectedPrefix.length
      || observed.some((name, index) => name !== input.expectedPrefix[index]))) {
    throw new Error("staging_migration_ledger_baseline_mismatch");
  }
  return { migrationNames: observed };
}

export async function captureStagingReleaseDatabaseBaseline(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const operatorEnvironment = input.environment ?? process.env;
  const migrationNames = input.migrationNames ?? await listMigrationNames(root);
  const admission = await (input.assertStagingMutationAdmissionImplementation ?? assertStagingMutationAdmission)({
    environment: operatorEnvironment,
    runWranglerImplementation: input.runWranglerImplementation,
  });
  if (admission.accountId !== input.databaseTarget.accountId
    || admission.databaseId !== input.databaseTarget.databaseId
    || admission.databaseName !== input.databaseTarget.databaseName) {
    throw new Error("staging_release_target_mismatch");
  }
  const ledger = await assertStagingMigrationLedgerPrefix({
    environment: buildPinnedCloudflareEnvironment(operatorEnvironment, admission.accountId),
    migrationNames,
    repositoryRoot: root,
    runWranglerImplementation: input.runWranglerImplementation,
  });
  return {
    databaseTarget: {
      accountId: admission.accountId,
      databaseId: admission.databaseId,
      databaseName: admission.databaseName,
    },
    migrationLedgerPrefix: ledger.migrationNames,
  };
}

export function parseStagingDatabasePreflightOutput(output) {
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error("staging_database_preflight_invalid_json");
  }
  if (result?.environment !== "staging"
    || result?.ok !== true
    || !Array.isArray(result?.checks)
    || result.checks.length === 0
    || result.checks.some((check) => check?.ok !== true)) {
    throw new Error("staging_database_preflight_failed");
  }
  return { checks: result.checks };
}

export function assertStagingDatabasePreflight(input = {}) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const runner = input.runImplementation ?? run;
  const childEnvironment = input.environment?.CLOUDFLARE_D1_API_TOKEN === undefined
    && /^[a-f0-9]{32}$/u.test(input.environment?.CLOUDFLARE_ACCOUNT_ID ?? "")
    && typeof input.environment?.CLOUDFLARE_API_TOKEN === "string"
    ? {
        ...input.environment,
        CLOUDFLARE_D1_API_TOKEN: input.environment.CLOUDFLARE_API_TOKEN,
      }
    : input.environment;
  let output;
  try {
    output = runner(process.execPath, [
      "scripts/db.mjs", "preflight", "--env", "staging", "--json",
    ], {
      cwd: root,
      env: childEnvironment,
    }).stdout;
  } catch {
    throw new Error("staging_database_preflight_failed");
  }
  return parseStagingDatabasePreflightOutput(output);
}

export async function runStagingMigrationWithVerification(input) {
  const preflight = input.assertDatabasePreflightImplementation ?? assertStagingDatabasePreflight;
  const prefix = input.assertMigrationLedgerPrefixImplementation ?? assertStagingMigrationLedgerPrefix;
  const complete = input.assertMigrationLedgerImplementation ?? assertStagingMigrationLedger;
  const shared = {
    environment: input.environment,
    migrationNames: input.migrationNames,
    repositoryRoot: input.repositoryRoot,
  };

  preflight(shared);
  await prefix({ ...shared, expectedPrefix: input.expectedPrefix });
  await input.runMigrationImplementation();
  await complete(shared);
  preflight(shared);
  if (input.assertPostMigrationContractImplementation !== undefined) {
    await input.assertPostMigrationContractImplementation(shared);
  }
}

export async function writeStagingReleaseManifest(manifest, root = repositoryRoot) {
  const directory = resolve(root, ".wrangler", "releases", "staging", manifest.releaseId);
  await assertCanonicalStagingArtifactPath(directory, root, "staging_release_manifest_symlink_invalid");
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  const manifestPath = resolve(directory, "release-manifest.json");
  await assertCanonicalStagingArtifactPath(manifestPath, root, "staging_release_manifest_symlink_invalid");
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("staging_release_manifest_exists", { cause: error });
    throw error;
  }
  await chmod(manifestPath, 0o600);
  return manifestPath;
}

export async function assertStagingReleaseAdmission(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const manifestPath = resolve(root, input.manifestPath);
  const relativeManifestPath = relative(resolve(root), manifestPath).split(sep).join("/");
  const releaseMatch = relativeManifestPath.match(/^\.wrangler\/releases\/staging\/(stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12})\/release-manifest\.json$/u);
  if (releaseMatch === null) throw new Error("staging_release_manifest_path_invalid");
  const expectedPath = resolve(root, ".wrangler", "releases", "staging", releaseMatch[1], "release-manifest.json");
  if (manifestPath !== expectedPath) throw new Error("staging_release_manifest_path_invalid");
  await assertCanonicalStagingArtifactPath(manifestPath, root, "staging_release_manifest_symlink_invalid");
  let manifestStat;
  let manifest;
  let handle;
  try {
    handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    manifestStat = await handle.stat({ bigint: true });
    const pathStat = await stat(manifestPath, { bigint: true });
    if (!manifestStat.isFile() || (manifestStat.mode & 0o077n) !== 0n
      || manifestStat.dev !== pathStat.dev || manifestStat.ino !== pathStat.ino) {
      throw new Error("staging_release_manifest_permissions_invalid");
    }
    manifest = JSON.parse((await handle.readFile()).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === "staging_release_manifest_permissions_invalid") throw error;
    if (error?.code === "ELOOP") {
      throw new Error("staging_release_manifest_symlink_invalid", { cause: error });
    }
    if (manifestStat !== undefined) {
      throw new Error("staging_release_manifest_permissions_invalid", { cause: error });
    }
    throw new Error("staging_release_manifest_missing", { cause: error });
  } finally {
    await handle?.close();
  }
  const repositoryState = input.repositoryState ?? readStagingRepositoryState(root);
  const migrationNames = input.migrationNames ?? await listMigrationNames(root);
  const admission = validateStagingReleaseManifest({
    manifest,
    migrationNames,
    now: input.now,
    repositoryState,
  });
  const admissionPath = resolve(root, ".wrangler", "releases", "staging", admission.releaseId, "release-manifest.json");
  if (manifestPath !== admissionPath || dirname(manifestPath) !== dirname(admissionPath)) {
    throw new Error("staging_release_manifest_path_invalid");
  }
  return admission;
}
