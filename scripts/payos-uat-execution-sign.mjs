import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertPayosUnsignedProviderExecutionArtifact,
  serializePayosRunnerAttestationPayload,
} from "./lib/payos-uat-evidence.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const RELEASE_ID = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;
const SCENARIO_IDS = new Set(["signed_exact_payment", "direct_reconciliation"]);

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") options.input = argv[++index] ?? "";
    else if (argument === "--output") options.output = argv[++index] ?? "";
    else if (argument === "--private-key") options.privateKeyPath = argv[++index] ?? "";
    else if (argument === "--key-id") options.keyId = argv[++index] ?? "";
    else if (argument === "--signed-at") options.signedAt = argv[++index] ?? "";
    else throw new Error("payos_uat_execution_sign_argument_invalid");
  }
  return options;
}

function assertIso(value) {
  const parsed = new Date(value ?? "");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("payos_uat_runner_attestation_timestamp_invalid");
  }
  return parsed;
}

async function readPrivateFile(path, missingIssue, invalidIssue) {
  const stat = await lstat(path).catch(() => null);
  if (stat === null) throw new Error(missingIssue);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error(invalidIssue);
  return readFile(path);
}

async function assertNoSymlinkAncestors(root, path, issue) {
  const base = resolve(root);
  const rel = relative(base, path);
  if (rel.startsWith("..") || rel.includes("\\")) throw new Error(issue);
  let current = base;
  for (const part of rel.split("/").slice(0, -1)) {
    current = resolve(current, part);
    const stat = await lstat(current).catch(() => null);
    if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error(issue);
  }
}

function canonicalPaths(root, releaseId, scenarioId, input, output) {
  if (!RELEASE_ID.test(releaseId ?? "") || !SCENARIO_IDS.has(scenarioId)) {
    throw new Error("payos_uat_provider_execution_artifact_invalid");
  }
  const executionRoot = resolve(root, ".wrangler", "releases", "staging", releaseId, "execution");
  const canonicalInput = resolve(executionRoot, `payos-${scenarioId}.unsigned.json`);
  const canonicalOutput = resolve(executionRoot, `payos-${scenarioId}.json`);
  if (resolve(root, input) !== canonicalInput) throw new Error("payos_uat_execution_sign_input_noncanonical");
  if (resolve(root, output) !== canonicalOutput) throw new Error("payos_uat_execution_sign_output_noncanonical");
  return { canonicalInput, canonicalOutput };
}

export async function signPayosProviderExecutionArtifact({
  input,
  keyId,
  output,
  privateKeyPath,
  root = repositoryRoot,
  signedAt,
}) {
  if (typeof input !== "string" || input.length === 0) throw new Error("payos_uat_execution_sign_input_required");
  if (typeof output !== "string" || output.length === 0) throw new Error("payos_uat_execution_sign_output_required");
  if (typeof privateKeyPath !== "string" || privateKeyPath.length === 0) throw new Error("payos_uat_runner_private_key_required");
  if (!KEY_ID.test(keyId ?? "")) throw new Error("payos_uat_runner_attestation_key_id_invalid");
  const signed = assertIso(signedAt);

  const inputPath = resolve(root, input);
  await assertNoSymlinkAncestors(root, inputPath, "payos_uat_execution_sign_input_ancestor_invalid");
  const inputBytes = await readPrivateFile(
    inputPath,
    "payos_uat_execution_sign_input_missing",
    "payos_uat_execution_sign_input_permissions_invalid",
  );
  let artifact;
  try {
    artifact = JSON.parse(inputBytes.toString("utf8"));
  } catch {
    throw new Error("payos_uat_execution_sign_input_invalid");
  }
  assertPayosUnsignedProviderExecutionArtifact(artifact);
  const { canonicalInput, canonicalOutput } = canonicalPaths(root, artifact.release.releaseId, artifact.scenarioId, input, output);
  if (inputPath !== canonicalInput) throw new Error("payos_uat_execution_sign_input_noncanonical");
  await assertNoSymlinkAncestors(root, canonicalOutput, "payos_uat_execution_sign_output_ancestor_invalid");

  const observedAt = new Date(artifact.observedAt).getTime();
  if (signed.getTime() < observedAt || signed.getTime() > observedAt + 15 * 60_000) {
    throw new Error("payos_uat_runner_attestation_timestamp_invalid");
  }
  const resolvedPrivateKeyPath = resolve(root, privateKeyPath);
  await assertNoSymlinkAncestors(root, resolvedPrivateKeyPath, "payos_uat_runner_private_key_ancestor_invalid");
  const privateKeyBytes = await readPrivateFile(
    resolvedPrivateKeyPath,
    "payos_uat_runner_private_key_missing",
    "payos_uat_runner_private_key_permissions_invalid",
  );
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyBytes);
  } catch {
    throw new Error("payos_uat_runner_private_key_invalid");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("payos_uat_runner_private_key_invalid");
  const publicKey = createPublicKey(privateKey);
  const publicKeySpkiSha256 = createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  const runnerAttestation = {
    algorithm: "ed25519",
    keyId,
    publicKeySpkiSha256,
    signatureBase64: "",
    signedAt,
  };
  const signedArtifact = { ...artifact, runnerAttestation };
  runnerAttestation.signatureBase64 = sign(
    null,
    Buffer.from(serializePayosRunnerAttestationPayload(signedArtifact)),
    privateKey,
  ).toString("base64");
  const bytes = Buffer.from(`${JSON.stringify(signedArtifact, null, 2)}\n`, "utf8");
  try {
    await writeFile(canonicalOutput, bytes, { flag: "wx", mode: 0o600 });
  } catch {
    throw new Error("payos_uat_execution_sign_output_exists");
  }
  await chmod(canonicalOutput, 0o600);
  return {
    artifactFingerprintSha256: createHash("sha256").update(bytes).digest("hex"),
    artifactPath: canonicalOutput,
    keyId,
    publicKeySpkiSha256,
    releaseId: artifact.release.releaseId,
    scenarioId: artifact.scenarioId,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await signPayosProviderExecutionArtifact(parseArguments(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:.-]{1,200}$/u.test(error.message)
      ? error.message
      : "payos_uat_execution_sign_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
