import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { listMigrationNames } from "./release.mjs";
import { repositoryRoot } from "./platform.mjs";

const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}$/u;
const RELEASE_ID_PATTERN = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;

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
    "createdAt",
    "environment",
    "expiresAt",
    "migrationNames",
    "releaseId",
    "schemaVersion",
    "treeSha",
  ], "staging_release_manifest_invalid");
  if (input.repositoryState.clean !== true) throw new Error("staging_release_source_dirty");
  if (!GIT_OBJECT_PATTERN.test(input.repositoryState.commitSha ?? "")) throw new Error("staging_release_commit_unavailable");
  if (!GIT_OBJECT_PATTERN.test(input.repositoryState.treeSha ?? "")) throw new Error("staging_release_tree_unavailable");
  if (input.manifest.schemaVersion !== 1 || input.manifest.environment !== "staging") {
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
  const compactTimestamp = now.toISOString().replaceAll(/[-:]/gu, "").replace(".000", "");
  const releaseId = `stg_${compactTimestamp}_${repositoryState.commitSha.slice(0, 12)}`;
  const migrationNames = input.migrationNames ?? await listMigrationNames(root);
  return {
    commitSha: repositoryState.commitSha,
    createdAt: now.toISOString(),
    environment: "staging",
    expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    migrationNames,
    releaseId,
    schemaVersion: 1,
    treeSha: repositoryState.treeSha,
  };
}

export async function writeStagingReleaseManifest(manifest, root = repositoryRoot) {
  const directory = resolve(root, ".wrangler", "releases", "staging", manifest.releaseId);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  const manifestPath = resolve(directory, "release-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(manifestPath, 0o600);
  return manifestPath;
}

export async function assertStagingReleaseAdmission(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const manifestPath = resolve(root, input.manifestPath);
  let manifestStat;
  let manifest;
  try {
    [manifestStat, manifest] = await Promise.all([
      lstat(manifestPath),
      readFile(manifestPath, "utf8").then((value) => JSON.parse(value)),
    ]);
  } catch {
    throw new Error("staging_release_manifest_missing");
  }
  if (!manifestStat.isFile() || (manifestStat.mode & 0o077) !== 0) {
    throw new Error("staging_release_manifest_permissions_invalid");
  }
  const repositoryState = input.repositoryState ?? readStagingRepositoryState(root);
  const migrationNames = input.migrationNames ?? await listMigrationNames(root);
  const admission = validateStagingReleaseManifest({
    manifest,
    migrationNames,
    now: input.now,
    repositoryState,
  });
  const canonicalPath = resolve(root, ".wrangler", "releases", "staging", admission.releaseId, "release-manifest.json");
  if (manifestPath !== canonicalPath || dirname(manifestPath) !== dirname(canonicalPath)) {
    throw new Error("staging_release_manifest_path_invalid");
  }
  return admission;
}
