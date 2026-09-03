import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, stat, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

import {
  DODO_SCENARIO_EXECUTION_CONTRACTS,
  DODO_STAGING_UAT_SCENARIO_IDS,
} from "./dodo-uat-evidence.mjs";
import {
  PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS,
} from "./payos-uat-evidence.mjs";
import { verifyStagingDeploymentEvidence } from "./staging-deployment-evidence.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const WORKER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const PROVIDERS = new Set(["dodo", "payos"]);
const DODO_SCENARIOS = new Set(DODO_STAGING_UAT_SCENARIO_IDS);
const PAYOS_SCENARIOS = new Set(PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS);
const UNSAFE = [
  /https?:\/\//iu,
  /Bearer(?:\s+|[_-])/iu,
  /(?:secret|token|api[_-]?key|private[_-]?key|raw[_-]?(?:body|payload)|checkout[_-]?url|credential)/iu,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
];

function fail(code) {
  throw new Error(code);
}

function exactKeys(value, expected, issue) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(issue);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(issue);
}

function safe(value) {
  if (typeof value === "string" && UNSAFE.some((pattern) => pattern.test(value))) fail("provider_uat_runner_unsafe_output");
  if (Array.isArray(value)) value.forEach(safe);
  else if (value !== null && typeof value === "object") Object.values(value).forEach(safe);
}

function iso(value, issue) {
  if (typeof value !== "string") fail(issue);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) fail(issue);
  return date;
}

function sha(value, issue) {
  if (typeof value !== "string" || !SHA256.test(value) || /^0+$/u.test(value)) fail(issue);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function artifactFingerprint(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalManifestRef(releaseId) {
  return `.wrangler/releases/staging/${releaseId}/release-manifest.json`;
}

function canonicalReceiptRef(releaseId, provider, scenarioId) {
  return `.wrangler/releases/staging/${releaseId}/execution/provider-${provider}-${scenarioId}.receipt.json`;
}

function canonicalArtifactRef(releaseId, provider, scenarioId) {
  return provider === "dodo"
    ? `artifact:.wrangler/releases/staging/${releaseId}/dodo-uat-execution-proofs/${scenarioId}.json`
    : `artifact:.wrangler/releases/staging/${releaseId}/execution/payos-${scenarioId}.json`;
}

async function readPrivateFile(path, issue) {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (descriptor === null) fail(issue);
  try {
    const opened = await descriptor.stat({ bigint: true });
    const current = await stat(path, { bigint: true });
    if (!opened.isFile() || (opened.mode & 0o077n) !== 0n || opened.dev !== current.dev || opened.ino !== current.ino) {
      fail(`${issue}_permissions_invalid`);
    }
    const bytes = await descriptor.readFile();
    const closed = await descriptor.stat({ bigint: true });
    if (opened.size !== closed.size || opened.mtimeNs !== closed.mtimeNs || opened.ctimeNs !== closed.ctimeNs) {
      fail(`${issue}_changed_during_read`);
    }
    return bytes;
  } finally {
    await descriptor.close();
  }
}

async function assertNoSymlinkAncestors(root, path, issue) {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) fail(issue);
  let current = resolve(root);
  for (const segment of rel.split(sep).slice(0, -1)) {
    current = resolve(current, segment);
    const entry = await lstat(current).catch(() => null);
    if (entry === null || !entry.isDirectory() || entry.isSymbolicLink()) fail(issue);
  }
}

function runGit(root, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveResult(stdout.trim()) : reject(new Error("provider_uat_runner_git_unavailable")));
  });
}

async function readManifest({ manifestPath, repositoryRoot }) {
  const root = resolve(repositoryRoot);
  const path = resolve(root, manifestPath);
  const rel = relative(root, path).split(sep).join("/");
  const match = /^\.wrangler\/releases\/staging\/(stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12})\/release-manifest\.json$/u.exec(rel);
  if (match === null) fail("provider_uat_runner_manifest_path_noncanonical");
  await assertNoSymlinkAncestors(root, path, "provider_uat_runner_manifest_path_invalid");
  const bytes = await readPrivateFile(path, "provider_uat_runner_manifest_missing");
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { fail("provider_uat_runner_manifest_invalid"); }
  if (manifest.schemaVersion !== 3 || manifest.environment !== "staging" || manifest.releaseId !== match[1]
    || !GIT_SHA.test(manifest.commitSha ?? "") || !GIT_SHA.test(manifest.treeSha ?? "")
    || typeof manifest.createdAt !== "string" || typeof manifest.expiresAt !== "string") {
    fail("provider_uat_runner_manifest_invalid");
  }
  const currentCommit = await runGit(root, ["rev-parse", "--verify", "HEAD"]);
  const currentTree = await runGit(root, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (currentCommit !== manifest.commitSha || currentTree !== manifest.treeSha) fail("provider_uat_runner_manifest_source_mismatch");
  const status = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length !== 0) fail("provider_uat_runner_source_dirty");
  return {
    manifest,
    manifestRef: rel,
    manifestSha256: artifactFingerprint(bytes),
    release: {
      commitSha: manifest.commitSha,
      manifestRef: rel,
      manifestSha256: artifactFingerprint(bytes),
      releaseId: manifest.releaseId,
      treeSha: manifest.treeSha,
    },
  };
}

function assertScenario(provider, scenarioId) {
  if (!PROVIDERS.has(provider)) fail("provider_uat_runner_provider_invalid");
  const allowed = provider === "dodo" ? DODO_SCENARIOS : PAYOS_SCENARIOS;
  if (!allowed.has(scenarioId)) fail("provider_uat_runner_scenario_invalid");
}

async function assertExecutorPath(path, root) {
  if (typeof path !== "string" || path.length === 0) fail("provider_uat_runner_executor_required");
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.includes("\\")) fail("provider_uat_runner_executor_path_invalid");
  const entry = await lstat(absolute).catch(() => null);
  if (entry === null) fail("provider_uat_runner_executor_missing");
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o111) === 0) fail("provider_uat_runner_executor_not_executable");
  const normalized = rel.split(sep).join("/");
  const tracked = await runGit(root, ["ls-files", "--error-unmatch", "--", normalized]).catch(() => "");
  if (tracked !== normalized) fail("provider_uat_runner_executor_not_candidate_bound");
  return absolute;
}

function expectedProviderAuthority(provider, scenarioId) {
  if (provider === "payos") return "payos_signed_webhook_or_verified_response";
  const contract = DODO_SCENARIO_EXECUTION_CONTRACTS[scenarioId];
  if (contract.signatureAuthority === "dodo") return "dodo_signed_webhook";
  if (contract.signatureAuthority === "controlled_runner") return "controlled_runner_signature";
  if (contract.eventSource === "dodo_test_api") return "dodo_test_api";
  return "staging_runtime";
}

function assertReceipt(value, context) {
  exactKeys(value, [
    "artifactRef", "artifactSha256", "authority", "d1AfterSha256", "d1BeforeSha256", "d1TransitionSha256",
    "executionTranscriptSha256", "observedAt", "provider", "providerEventSha256", "providerSignatureSha256",
    "release", "scenarioId", "schemaVersion",
  ], "provider_uat_runner_receipt_invalid");
  safe(value);
  if (value.schemaVersion !== 1 || value.provider !== context.provider || value.scenarioId !== context.scenarioId
    || JSON.stringify(canonical(value.release)) !== JSON.stringify(canonical(context.release))
    || value.artifactRef !== canonicalArtifactRef(context.release.releaseId, context.provider, context.scenarioId)
    || value.authority !== expectedProviderAuthority(context.provider, context.scenarioId)) {
    fail("provider_uat_runner_receipt_binding_invalid");
  }
  iso(value.observedAt, "provider_uat_runner_receipt_timestamp_invalid");
  for (const key of ["artifactSha256", "d1BeforeSha256", "d1AfterSha256", "d1TransitionSha256", "executionTranscriptSha256"]) sha(value[key], "provider_uat_runner_receipt_hash_invalid");
  if (value.providerEventSha256 !== null) sha(value.providerEventSha256, "provider_uat_runner_receipt_hash_invalid");
  if (value.providerSignatureSha256 !== null) sha(value.providerSignatureSha256, "provider_uat_runner_receipt_hash_invalid");
  if (typeof value.requestReference !== "undefined" || typeof value.sessionReference !== "undefined") fail("provider_uat_runner_receipt_extra_claims");
  const stateEffect = context.provider === "dodo"
    ? DODO_SCENARIO_EXECUTION_CONTRACTS[context.scenarioId]?.stateEffect
    : "transition";
  if (stateEffect === "transition" && value.d1BeforeSha256 === value.d1AfterSha256) fail("provider_uat_runner_receipt_transition_missing");
  if (stateEffect === "no_op" && value.d1BeforeSha256 !== value.d1AfterSha256) fail("provider_uat_runner_receipt_no_op_invalid");
  const requiresProviderSignature = context.provider === "payos"
    || DODO_SCENARIO_EXECUTION_CONTRACTS[context.scenarioId]?.signatureAuthority !== "none";
  if (requiresProviderSignature && (value.providerEventSha256 === null || value.providerSignatureSha256 === null)) {
    fail("provider_uat_runner_provider_signature_missing");
  }
  if (!requiresProviderSignature && (value.providerEventSha256 !== null || value.providerSignatureSha256 !== null)) {
    fail("provider_uat_runner_provider_signature_unexpected");
  }
}

async function executorEnvironment(context) {
  const allowed = ["SELINOW_UAT_D1_CONTEXT_PATH", "SELINOW_UAT_AUTH_CONTEXT_PATH"];
  allowed.push(context.provider === "dodo" ? "SELINOW_UAT_DODO_CONTEXT_PATH" : "SELINOW_UAT_PAYOS_CONTEXT_PATH");
  const missing = allowed.filter((name) => typeof context.environment?.[name] !== "string" || context.environment[name].trim().length === 0);
  if (missing.length > 0) fail(`provider_uat_runner_prerequisite_missing:${missing.sort().join(",")}`);
  for (const name of allowed) {
    const path = resolve(context.environment[name].trim());
    const entry = await lstat(path).catch(() => null);
    if (entry === null || !entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) {
      fail(`provider_uat_runner_prerequisite_invalid:${name}`);
    }
  }
  return Object.fromEntries(allowed.map((name) => [name, context.environment[name].trim()]));
}

async function executeExecutor(path, context, timeoutMs) {
  const maxOutputBytes = 256 * 1024;
  const payload = `${JSON.stringify({
    schemaVersion: 1,
    provider: context.provider,
    providerEnvironment: context.provider === "dodo" ? "test_mode" : "production_controlled",
    scenarioId: context.scenarioId,
    release: context.release,
    requiredClaims: [
      "artifactRef", "artifactSha256", "providerEventSha256", "providerSignatureSha256",
      "d1BeforeSha256", "d1AfterSha256", "d1TransitionSha256", "executionTranscriptSha256",
    ],
  })}\n`;
  const safeEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    SELINOW_UAT_RUNNER: "1",
    SELINOW_UAT_PROVIDER: context.provider,
    SELINOW_UAT_SCENARIO_ID: context.scenarioId,
    SELINOW_UAT_RELEASE_ID: context.release.releaseId,
    SELINOW_UAT_WORKER_VERSION: context.workerVersion,
    ...await executorEnvironment(context),
  };
  return new Promise((resolveResult, reject) => {
    const child = spawn(path, [], { cwd: context.repositoryRoot, env: safeEnv, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (stream, chunk) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > maxOutputBytes) {
        child.kill("SIGKILL");
        reject(new Error("provider_uat_runner_executor_output_too_large"));
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("provider_uat_runner_executor_timeout"));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("provider_uat_runner_executor_failed"));
      if (stderr.trim().length !== 0 || UNSAFE.some((pattern) => pattern.test(stdout))) return reject(new Error("provider_uat_runner_executor_output_invalid"));
      let result;
      try { result = JSON.parse(stdout); } catch { return reject(new Error("provider_uat_runner_executor_json_invalid")); }
      return resolveResult(result);
    });
    child.stdin.end(payload);
  });
}

async function verifyArtifact({ receipt, context }) {
  const ref = receipt.artifactRef.slice("artifact:".length);
  const root = resolve(context.repositoryRoot);
  const path = resolve(root, ref);
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel.includes("\\")) fail("provider_uat_runner_artifact_path_invalid");
  await assertNoSymlinkAncestors(root, path, "provider_uat_runner_artifact_path_invalid");
  const bytes = await readPrivateFile(path, "provider_uat_runner_artifact_missing");
  if (artifactFingerprint(bytes) !== receipt.artifactSha256) fail("provider_uat_runner_artifact_hash_mismatch");
  let artifact;
  try { artifact = JSON.parse(bytes.toString("utf8")); } catch { fail("provider_uat_runner_artifact_invalid"); }
  safe(artifact);
  if (artifact?.provider !== context.provider || artifact?.scenarioId !== context.scenarioId
    || artifact?.environment !== "staging" || artifact?.release?.releaseId !== context.release.releaseId
    || artifact?.release?.workerVersion !== context.workerVersion
    || JSON.stringify(canonical(artifact.release)) !== JSON.stringify(canonical(context.release))) fail("provider_uat_runner_artifact_binding_invalid");
  if (context.provider === "dodo") {
    if (artifact?.attestation?.algorithm !== "ed25519" || typeof artifact?.attestation?.signatureBase64 !== "string" || artifact.attestation.signatureBase64.length < 80) {
      fail("provider_uat_runner_provider_signature_missing");
    }
    const fingerprints = artifact?.fingerprints;
    if (fingerprints?.d1BeforeSha256 !== receipt.d1BeforeSha256
      || fingerprints?.d1AfterSha256 !== receipt.d1AfterSha256
      || fingerprints?.d1TransitionSha256 !== receipt.d1TransitionSha256
      || fingerprints?.executionTranscriptSha256 !== receipt.executionTranscriptSha256
      || fingerprints?.providerEventSha256 !== receipt.providerEventSha256
      || fingerprints?.providerSignatureSha256 !== receipt.providerSignatureSha256) {
      fail("provider_uat_runner_receipt_artifact_mismatch");
    }
  } else if (artifact?.runnerAttestation?.algorithm !== "ed25519") {
    fail("provider_uat_runner_provider_signature_missing");
  }
}

export async function runProviderUatScenario({
  environment = process.env,
  executor,
  manifestPath,
  provider,
  repositoryRoot,
  scenarioId,
  timeoutMs = 5 * 60_000,
  verifyStagingDeploymentEvidenceImplementation = verifyStagingDeploymentEvidence,
}) {
  const root = resolve(repositoryRoot);
  assertScenario(provider, scenarioId);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60_000) fail("provider_uat_runner_timeout_invalid");
  const bundle = await readManifest({ manifestPath, repositoryRoot: root });
  const deployment = await verifyStagingDeploymentEvidenceImplementation({
    environment,
    evidencePath: `.wrangler/releases/staging/${bundle.release.releaseId}/deployment-evidence.json`,
    manifestPath,
    repositoryRoot: root,
  });
  const workerVersion = deployment?.workerVersion;
  if (!WORKER_VERSION.test(workerVersion ?? "")) fail("provider_uat_runner_worker_version_invalid");
  const executorPath = await assertExecutorPath(executor, root);
  const context = { environment, provider, repositoryRoot: root, release: { ...bundle.release, workerVersion }, scenarioId, workerVersion };
  const receipt = await executeExecutor(executorPath, context, timeoutMs);
  assertReceipt(receipt, context);
  await verifyArtifact({ receipt, context });
  const receiptRef = canonicalReceiptRef(bundle.release.releaseId, provider, scenarioId);
  const receiptPath = resolve(root, receiptRef);
  const bytes = Buffer.from(`${JSON.stringify({
    artifactRef: receipt.artifactRef,
    artifactSha256: receipt.artifactSha256,
    authority: receipt.authority,
    d1AfterSha256: receipt.d1AfterSha256,
    d1BeforeSha256: receipt.d1BeforeSha256,
    d1TransitionSha256: receipt.d1TransitionSha256,
    executionTranscriptSha256: receipt.executionTranscriptSha256,
    observedAt: receipt.observedAt,
    provider: receipt.provider,
    providerEventSha256: receipt.providerEventSha256,
    providerSignatureSha256: receipt.providerSignatureSha256,
    release: context.release,
    scenarioId,
    schemaVersion: 1,
  }, null, 2)}\n`, "utf8");
  await mkdir(resolve(root, ".wrangler", "releases", "staging", bundle.release.releaseId, "execution"), { mode: 0o700, recursive: true });
  await writeFile(receiptPath, bytes, { flag: "wx", mode: 0o600 }).catch(() => fail("provider_uat_runner_receipt_exists"));
  await chmod(receiptPath, 0o600);
  return {
    accepted: false,
    artifactRef: receipt.artifactRef,
    artifactSha256: receipt.artifactSha256,
    provider,
    receiptRef,
    releaseId: bundle.release.releaseId,
    scenarioId,
    workerVersion,
    next: provider === "dodo"
      ? "Run dodo-uat-collect and dodo-uat-validate for the complete 32-scenario set."
      : "Run payos-uat-collect, payos-uat-sign, and payos-uat-validate for the complete 14-scenario set.",
  };
}

export { canonicalArtifactRef, canonicalManifestRef, canonicalReceiptRef };
