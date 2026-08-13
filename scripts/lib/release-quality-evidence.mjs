import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";

import { repositoryRoot } from "./platform.mjs";

const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,80}$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export const QUALITY_COMMANDS = Object.freeze([
  Object.freeze({ args: ["run", "check"], command: "npm", key: "check" }),
  Object.freeze({ args: ["run", "lint"], command: "npm", key: "lint" }),
  Object.freeze({ args: ["--no-install", "tsc", "--noEmit"], command: "npx", key: "tscNoEmit" }),
  Object.freeze({ args: ["test"], command: "npm", key: "test" }),
  Object.freeze({ args: ["run", "build"], command: "npm", key: "build" }),
  Object.freeze({ args: ["run", "build:staging"], command: "npm", key: "buildStaging" }),
  Object.freeze({ args: ["audit", "--audit-level=high"], command: "npm", key: "auditHigh" }),
  Object.freeze({ args: ["run", "deploy:dry-run"], command: "npm", key: "deployDryRun" }),
  Object.freeze({ args: ["run", "deploy:staging:dry-run"], command: "npm", key: "deployStagingDryRun" }),
  Object.freeze({ args: ["diff", "--check"], command: "git", key: "gitDiffCheck" }),
]);

function gitValue(root, args, code) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(code);
  return result.stdout.trim();
}

export function readQualityCandidateState(root = repositoryRoot) {
  return {
    commitSha: gitValue(root, ["rev-parse", "--verify", "HEAD^{commit}"], "quality_evidence_commit_unavailable"),
    dirty: gitValue(root, ["status", "--porcelain=v1", "--untracked-files=all"], "quality_evidence_status_unavailable"),
    treeSha: gitValue(root, ["rev-parse", "--verify", "HEAD^{tree}"], "quality_evidence_tree_unavailable"),
  };
}

function assertEvidenceBinding(evidence, state) {
  if (!RELEASE_ID_PATTERN.test(evidence?.releaseId ?? "")
    || !SHA_PATTERN.test(evidence?.commitSha ?? "")
    || !SHA_PATTERN.test(evidence?.treeSha ?? "")
    || !UUID_PATTERN.test(evidence?.staging?.workerVersion ?? "")
    || state.dirty !== ""
    || state.commitSha !== evidence.commitSha
    || state.treeSha !== evidence.treeSha) {
    throw new Error("quality_evidence_candidate_mismatch");
  }
}

function artifactBytes(artifact) {
  return Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function collectReleaseQualityEvidence({
  evidence,
  now = new Date(),
  readCandidateStateImplementation = readQualityCandidateState,
  repositoryRoot: root = repositoryRoot,
  runCommandImplementation,
} = {}) {
  const before = readCandidateStateImplementation(root);
  assertEvidenceBinding(evidence, before);
  const runCommand = runCommandImplementation ?? ((step) => {
    const result = spawnSync(step.command, step.args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    if (result.error || result.status !== 0) throw new Error(`quality_evidence_gate_failed:${step.key}`);
  });
  const passed = {};
  for (const step of QUALITY_COMMANDS) {
    await runCommand(step);
    passed[step.key] = true;
  }
  const after = readCandidateStateImplementation(root);
  assertEvidenceBinding(evidence, after);
  if (after.commitSha !== before.commitSha || after.treeSha !== before.treeSha) {
    throw new Error("quality_evidence_candidate_changed");
  }
  const observedAt = now.toISOString();
  const artifact = {
    commitSha: evidence.commitSha,
    environment: "production",
    evidence: {
      auditHigh: passed.auditHigh === true,
      build: passed.build === true,
      buildStaging: passed.buildStaging === true,
      check: passed.check === true,
      deployDryRun: passed.deployDryRun === true,
      deployStagingDryRun: passed.deployStagingDryRun === true,
      gitDiffCheck: passed.gitDiffCheck === true,
      lint: passed.lint === true,
      schemaVersion: 2,
      test: passed.test === true,
      tscNoEmit: passed.tscNoEmit === true,
    },
    mode: "quality_evidence",
    observedAt,
    releaseId: evidence.releaseId,
    schemaVersion: 1,
    treeSha: evidence.treeSha,
    workerVersion: evidence.staging.workerVersion,
  };
  const bytes = artifactBytes(artifact);
  return {
    artifact,
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    evidenceRef: `.wrangler/releases/${evidence.releaseId}/quality-evidence.json`,
    quality: {
      ...artifact.evidence,
      artifactSchemaVersion: 1,
      artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      evidenceRef: `.wrangler/releases/${evidence.releaseId}/quality-evidence.json`,
      observedAt,
    },
  };
}

async function assertPrivateRegularFile(path, code) {
  const value = await lstat(path);
  if (!value.isFile() || value.isSymbolicLink() || (value.mode & 0o077) !== 0) throw new Error(code);
}

async function assertNoSymlinkAncestors(path, root, code) {
  assertInsideRoot(path, root, code);
  const rel = relative(resolve(root), resolve(path));
  let current = resolve(root);
  for (const segment of rel.split(sep)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(code);
    } catch (error) {
      if (error instanceof Error && error.message === code) throw error;
      if (error?.code === "ENOENT") return;
      throw new Error(code, { cause: error });
    }
  }
}

function assertInsideRoot(path, root, code) {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(code);
}

async function readPrivateJson(path, root, code) {
  assertInsideRoot(path, root, code);
  let handle;
  try {
    const canonicalRoot = await realpath(resolve(root));
    const rel = relative(resolve(root), resolve(path));
    const canonicalPath = await realpath(resolve(path));
    if (canonicalPath !== resolve(canonicalRoot, rel)) throw new Error(code);
    handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    const current = await stat(resolve(path), { bigint: true });
    if (!opened.isFile() || (opened.mode & 0o077n) !== 0n
      || opened.dev !== current.dev || opened.ino !== current.ino) throw new Error(code);
    return JSON.parse((await handle.readFile()).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code, { cause: error });
  } finally {
    await handle?.close();
  }
}

function assertCollectedBinding(collected, evidence) {
  const expectedRef = `.wrangler/releases/${evidence.releaseId}/quality-evidence.json`;
  const bytes = artifactBytes(collected?.artifact);
  if (collected?.evidenceRef !== expectedRef
    || collected?.artifact?.commitSha !== evidence.commitSha
    || collected?.artifact?.treeSha !== evidence.treeSha
    || collected?.artifact?.releaseId !== evidence.releaseId
    || collected?.artifact?.workerVersion !== evidence.staging.workerVersion
    || collected?.artifact?.mode !== "quality_evidence"
    || collected?.artifact?.schemaVersion !== 1
    || createHash("sha256").update(bytes).digest("hex") !== collected?.artifactSha256
    || collected?.quality?.artifactSha256 !== collected?.artifactSha256
    || collected?.quality?.evidenceRef !== expectedRef) {
    throw new Error("quality_evidence_artifact_binding_invalid");
  }
}

export async function writeReleaseQualityEvidence({
  collected,
  evidence,
  evidencePath,
  readCandidateStateImplementation = readQualityCandidateState,
  repositoryRoot: root = repositoryRoot,
} = {}) {
  assertEvidenceBinding(evidence, readCandidateStateImplementation(root));
  const canonicalEvidencePath = resolve(root, ".wrangler/release/production-evidence.json");
  const resolvedEvidencePath = resolve(evidencePath ?? "");
  if (resolvedEvidencePath !== canonicalEvidencePath) throw new Error("quality_evidence_source_path_invalid");
  assertInsideRoot(resolvedEvidencePath, root, "quality_evidence_source_path_invalid");
  const evidenceRelativePath = relative(resolve(root), resolvedEvidencePath).split(sep).join("/");
  if (!/^\.wrangler\/release\/[A-Za-z0-9._-]+\.json$/u.test(evidenceRelativePath)) {
    throw new Error("quality_evidence_source_path_invalid");
  }
  await assertPrivateRegularFile(resolvedEvidencePath, "quality_evidence_source_permissions_invalid");
  await assertNoSymlinkAncestors(resolvedEvidencePath, root, "quality_evidence_source_permissions_invalid");
  const onDiskEvidence = await readPrivateJson(
    resolvedEvidencePath,
    root,
    "quality_evidence_source_read_invalid",
  );
  if (JSON.stringify(onDiskEvidence) !== JSON.stringify(evidence)) {
    throw new Error("quality_evidence_source_changed");
  }
  assertCollectedBinding(collected, evidence);

  const artifactPath = resolve(root, collected.evidenceRef);
  assertInsideRoot(artifactPath, root, "quality_evidence_artifact_path_invalid");
  await assertNoSymlinkAncestors(dirname(artifactPath), root, "quality_evidence_artifact_path_invalid");
  const artifactBytesValue = artifactBytes(collected.artifact);
  const updatedEvidence = { ...evidence, quality: collected.quality };
  const evidenceBytes = Buffer.from(`${JSON.stringify(updatedEvidence, null, 2)}\n`, "utf8");
  const artifactTemporaryPath = `${artifactPath}.tmp-${process.pid}`;
  const evidenceTemporaryPath = `${resolvedEvidencePath}.tmp-${process.pid}`;
  let artifactCommitted = false;
  await mkdir(dirname(artifactPath), { mode: 0o700, recursive: true });
  await chmod(dirname(artifactPath), 0o700);
  await assertNoSymlinkAncestors(dirname(artifactPath), root, "quality_evidence_artifact_path_invalid");
  try {
    await writeFile(artifactTemporaryPath, artifactBytesValue, { flag: "wx", mode: 0o600 });
    await writeFile(evidenceTemporaryPath, evidenceBytes, { flag: "wx", mode: 0o600 });
    await link(artifactTemporaryPath, artifactPath);
    artifactCommitted = true;
    await rm(artifactTemporaryPath, { force: true });
    await rename(evidenceTemporaryPath, resolvedEvidencePath);
  } catch (error) {
    if (artifactCommitted) await rm(artifactPath, { force: true });
    await rm(artifactTemporaryPath, { force: true });
    await rm(evidenceTemporaryPath, { force: true });
    throw error;
  }
  await chmod(artifactPath, 0o600);
  await chmod(resolvedEvidencePath, 0o600);
  return { artifactSha256: collected.artifactSha256, evidenceRef: collected.evidenceRef };
}
