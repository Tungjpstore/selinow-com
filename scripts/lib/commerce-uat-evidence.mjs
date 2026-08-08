import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";

import { assertDodoStagingUatEvidence } from "./dodo-uat-evidence.mjs";
import { assertPayosStagingUatEvidence } from "./payos-uat-evidence.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const RELEASE_ID = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;
const SAFE_REF = /^\.wrangler\/releases\/staging\/[A-Za-z0-9._/-]+\.json$/u;

function git(root, args, issue) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(issue);
  return result.stdout.trim();
}

function safeArtifactPath(root, value, issue) {
  if (typeof value !== "string" || !SAFE_REF.test(value)) throw new Error(issue);
  const path = resolve(root, value);
  const rel = relative(resolve(root, ".wrangler/releases/staging"), path);
  if (rel.startsWith("..") || rel.includes("\\") || rel.length === 0) throw new Error(issue);
  return path;
}

function readPrivateJson(root, reference, missingIssue) {
  const path = safeArtifactPath(root, reference, missingIssue);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(missingIssue);
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error(`${missingIssue}_permissions_invalid`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${missingIssue}_invalid`);
  }
}

export function readTrustedStagingUatBinding({ evidence, manifestPath: requestedManifestPath, repositoryRoot, workerVersion }) {
  const root = repositoryRoot;
  const release = evidence?.release;
  if (typeof release?.manifestRef !== "string") throw new Error("commerce_uat_release_binding_missing");
  if (!GIT_SHA.test(release.commitSha ?? "") || !GIT_SHA.test(release.treeSha ?? "") || !RELEASE_ID.test(release.releaseId ?? "")) {
    throw new Error("commerce_uat_release_binding_invalid");
  }
  if (!SHA256.test(release.manifestSha256 ?? "")) throw new Error("commerce_uat_manifest_hash_invalid");
  const manifestPath = safeArtifactPath(root, release.manifestRef, "commerce_uat_manifest_ref_invalid");
  if (requestedManifestPath !== undefined && resolve(root, requestedManifestPath) !== manifestPath) throw new Error("commerce_uat_manifest_ref_mismatch");
  if (workerVersion !== undefined && workerVersion !== release.workerVersion) throw new Error("commerce_uat_worker_version_mismatch");
  let bytes;
  try {
    bytes = readFileSync(manifestPath);
  } catch {
    throw new Error("commerce_uat_manifest_missing");
  }
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  if (manifestSha256 !== release.manifestSha256) throw new Error("commerce_uat_manifest_hash_mismatch");
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("commerce_uat_manifest_invalid");
  }
  if (manifest.schemaVersion !== 3 || manifest.environment !== "staging" || manifest.releaseId !== release.releaseId) {
    throw new Error("commerce_uat_manifest_invalid");
  }
  const commitSha = git(root, ["rev-parse", "--verify", "HEAD"], "commerce_uat_commit_unavailable");
  const treeSha = git(root, ["rev-parse", "--verify", "HEAD^{tree}"], "commerce_uat_tree_unavailable");
  if (commitSha !== release.commitSha) throw new Error("commerce_uat_commit_mismatch");
  if (treeSha !== release.treeSha) throw new Error("commerce_uat_tree_mismatch");
  if (manifest.commitSha !== commitSha || manifest.treeSha !== treeSha) throw new Error("commerce_uat_manifest_binding_mismatch");
  return {
    commitSha,
    manifestRef: release.manifestRef,
    manifestSha256,
    releaseId: release.releaseId,
    treeSha,
    workerVersion: release.workerVersion,
  };
}

export function validateCommerceUatArtifactsSync({ evidence, repositoryRoot }) {
  const root = repositoryRoot;
  const result = {};
  for (const [provider, validator] of [["dodo", assertDodoStagingUatEvidence], ["payos", assertPayosStagingUatEvidence]]) {
    const reference = evidence?.commerceAcceptance?.[provider]?.evidenceRef;
    try {
      const artifact = readPrivateJson(root, reference, `${provider}_uat_artifact_missing`);
      const binding = readTrustedStagingUatBinding({ evidence: artifact, repositoryRoot: root });
      const accepted = validator(artifact, binding);
      result[provider] = {
        accepted: true,
        artifactFingerprintSha256: accepted.evidenceFingerprintSha256,
        manifestRef: binding.manifestRef,
        manifestSha256: binding.manifestSha256,
        releaseId: binding.releaseId,
        scenarioCount: accepted.scenarioCount,
        workerVersion: binding.workerVersion,
      };
    } catch (error) {
      result[provider] = {
        accepted: false,
        error: error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message) ? error.message : `${provider}_uat_validation_failed`,
      };
    }
  }
  return result;
}

export async function validateCommerceUatArtifacts(input) {
  return validateCommerceUatArtifactsSync(input);
}
