import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS,
  PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS,
  PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS,
} from "./lib/payos-uat-evidence.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const RELEASE_ID = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;
const WORKER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const ISO = (value) => {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
};
const PROVIDER_METHODS = Object.freeze({
  direct_reconciliation: "verified_provider_response",
  signed_exact_payment: "signed_webhook",
});

function parseArguments(argv) {
  const options = { output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") options.manifest = argv[++index] ?? "";
    else if (argument === "--worker-version") options.workerVersion = argv[++index] ?? "";
    else if (argument === "--scenario-id") options.scenarioId = argv[++index] ?? "";
    else if (argument === "--classification") options.classification = argv[++index] ?? "";
    else if (argument === "--status") options.status = argv[++index] ?? "";
    else if (argument === "--verification-method") options.verificationMethod = argv[++index] ?? "";
    else if (argument === "--observed-at") options.observedAt = argv[++index] ?? "";
    else if (argument === "--controlled-account-fingerprint") options.controlledAccountFingerprintSha256 = argv[++index] ?? "";
    else if (argument === "--proof-of-execution-fingerprint") options.proofOfExecutionFingerprintSha256 = argv[++index] ?? "";
    else if (argument === "--output") options.output = argv[++index] ?? "";
    else throw new Error("payos_uat_artifact_argument_invalid");
  }
  return options;
}

function sha(value, issue) {
  if (typeof value !== "string" || !SHA256.test(value) || /^0+$/u.test(value)) throw new Error(issue);
}

async function readManifest(manifestPath, root) {
  const path = resolve(root, manifestPath);
  const stat = await lstat(path).catch(() => null);
  if (stat === null) throw new Error("payos_uat_manifest_missing");
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("payos_uat_manifest_permissions_invalid");
  const bytes = await readFile(path);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("payos_uat_manifest_invalid");
  }
  if (manifest.schemaVersion !== 3 || manifest.environment !== "staging" || !RELEASE_ID.test(manifest.releaseId ?? "")
    || !GIT_SHA.test(manifest.commitSha ?? "") || /^0+$/u.test(manifest.commitSha)
    || !GIT_SHA.test(manifest.treeSha ?? "") || /^0+$/u.test(manifest.treeSha)) {
    throw new Error("payos_uat_manifest_invalid");
  }
  const canonicalPath = resolve(root, ".wrangler", "releases", "staging", manifest.releaseId, "release-manifest.json");
  if (path !== canonicalPath) throw new Error("payos_uat_manifest_path_noncanonical");
  return {
    manifest,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    manifestRef: relative(root, path).split("\\").join("/"),
  };
}

function assertScenarioInput(input) {
  const providerRequired = PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS.includes(input.scenarioId);
  const localRequired = PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS.includes(input.scenarioId);
  const unsupported = PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS.includes(input.scenarioId);
  if (!providerRequired && !localRequired && !unsupported) throw new Error("payos_uat_scenario_id_invalid");
  if (!ISO(input.observedAt) || input.observedAt === null) throw new Error("payos_uat_scenario_timestamp_invalid");
  if (providerRequired) {
    if (input.classification !== "provider_supported" || input.status !== "passed" || input.verificationMethod !== PROVIDER_METHODS[input.scenarioId]) throw new Error("payos_uat_provider_scenario_invalid");
    sha(input.controlledAccountFingerprintSha256, "payos_uat_controlled_account_fingerprint_invalid");
    sha(input.proofOfExecutionFingerprintSha256, "payos_uat_proof_of_execution_fingerprint_invalid");
  } else if (localRequired) {
    if (input.classification !== "selinow_local_assurance" || input.status !== "passed" || input.verificationMethod !== "local_contract") throw new Error("payos_uat_local_scenario_invalid");
    if (input.controlledAccountFingerprintSha256 !== null || input.proofOfExecutionFingerprintSha256 !== null) throw new Error("payos_uat_scenario_fingerprint_scope_invalid");
  } else if (unsupported) {
    if (input.classification !== "provider_unsupported" || input.status !== "unsupported" || input.verificationMethod !== "provider_capability_audit") throw new Error("payos_uat_unsupported_scenario_invalid");
    if (input.controlledAccountFingerprintSha256 !== null || input.proofOfExecutionFingerprintSha256 !== null) throw new Error("payos_uat_scenario_fingerprint_scope_invalid");
  }
}

export async function buildPayosScenarioArtifact({
  manifestPath,
  workerVersion,
  scenarioId,
  classification,
  status,
  verificationMethod,
  observedAt,
  controlledAccountFingerprintSha256 = null,
  proofOfExecutionFingerprintSha256 = null,
  output,
  root = repositoryRoot,
}) {
  if (typeof workerVersion !== "string" || !WORKER_VERSION.test(workerVersion)) throw new Error("payos_uat_worker_version_invalid");
  if (typeof output !== "string" || output.length === 0) throw new Error("payos_uat_artifact_output_required");
  const { manifest, manifestSha256, manifestRef } = await readManifest(manifestPath, root);
  if (manifest.commitSha !== execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    || manifest.treeSha !== execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim()) {
    throw new Error("payos_uat_manifest_source_mismatch");
  }
  const input = { classification, controlledAccountFingerprintSha256, proofOfExecutionFingerprintSha256, scenarioId, status, verificationMethod, observedAt };
  assertScenarioInput(input);
  const release = {
    commitSha: manifest.commitSha,
    manifestRef,
    manifestSha256,
    releaseId: manifest.releaseId,
    treeSha: manifest.treeSha,
    workerVersion,
  };
  const scenariosRoot = resolve(root, ".wrangler", "releases", "staging", manifest.releaseId, "scenarios");
  const outputPath = resolve(root, output);
  const outputRelative = relative(scenariosRoot, outputPath);
  if (outputRelative.startsWith("..") || outputRelative.includes("\\") || !outputPath.endsWith(".json")) throw new Error("payos_uat_artifact_output_noncanonical");
  const artifact = {
    classification,
    controlledAccountFingerprintSha256,
    evidenceKind: "provider_acceptance",
    environment: "staging",
    observedAt,
    provider: "payos",
    proofOfExecutionFingerprintSha256,
    redaction: { noRawPayload: true, noSensitiveValues: true },
    release,
    result: status,
    scenarioId,
    schemaVersion: 1,
    verificationMethod,
  };
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await mkdir(dirname(outputPath), { mode: 0o700, recursive: true });
  try {
    await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
  } catch {
    throw new Error("payos_uat_artifact_output_exists");
  }
  await chmod(outputPath, 0o600);
  return { artifact, artifactFingerprintSha256: createHash("sha256").update(bytes).digest("hex"), artifactPath: outputPath };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  for (const name of ["manifest", "workerVersion", "scenarioId", "classification", "status", "verificationMethod", "observedAt", "output"]) {
    if (typeof options[name] !== "string" || options[name].length === 0) throw new Error(`payos_uat_${name === "manifest" ? "manifest" : name === "workerVersion" ? "worker_version" : "artifact_argument"}_required`);
  }
  const result = await buildPayosScenarioArtifact(options);
  process.stdout.write(`${JSON.stringify({ artifactFingerprintSha256: result.artifactFingerprintSha256, artifactPath: result.artifactPath, scenarioId: result.artifact.scenarioId }, null, 2)}\n`);
  return result;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message) ? error.message : "payos_uat_artifact_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
