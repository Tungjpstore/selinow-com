import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readTrustedStagingUatBinding } from "./lib/commerce-uat-evidence.mjs";
import {
  assertPayosStagingUatEvidence,
  readPayosProviderExecutionArtifacts,
  readPayosRunnerTrustAnchor,
  readPayosScenarioArtifactFingerprints,
  serializePayosOwnerAttestationPayload,
} from "./lib/payos-uat-evidence.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const RELEASE_ID = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;

function parseArguments(argv) {
  const options = { overwrite: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--evidence") options.evidencePath = argv[++index] ?? "";
    else if (argument === "--private-key") options.privateKeyPath = argv[++index] ?? "";
    else if (argument === "--key-id") options.keyId = argv[++index] ?? "";
    else if (argument === "--signed-at") options.signedAt = argv[++index] ?? "";
    else if (argument === "--runner-attestation-key-id") options.runnerAttestationKeyId = argv[++index] ?? "";
    else if (argument === "--runner-attestation-public-key") options.runnerAttestationPublicKeyPath = argv[++index] ?? "";
    else if (argument === "--runner-attestation-spki-sha256") options.runnerAttestationSpkiSha256 = argv[++index] ?? "";
    else if (argument === "--output") options.output = argv[++index] ?? "";
    else if (argument === "--overwrite") options.overwrite = true;
    else throw new Error("payos_uat_sign_argument_invalid");
  }
  return options;
}

async function readPrivateFile(path, missingIssue, permissionsIssue) {
  const stat = await lstat(path).catch(() => null);
  if (stat === null) throw new Error(missingIssue);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error(permissionsIssue);
  return readFile(path);
}

function assertIso(value) {
  const date = new Date(value ?? "");
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error("payos_uat_owner_attestation_timestamp_invalid");
}

function canonicalOutputPath(root, releaseId, output) {
  if (!RELEASE_ID.test(releaseId ?? "")) throw new Error("payos_uat_release_id_invalid");
  const canonical = resolve(root, ".wrangler", "releases", "staging", releaseId, "payos-uat-evidence.json");
  if (resolve(root, output) !== canonical) throw new Error("payos_uat_evidence_path_noncanonical");
  return canonical;
}

export async function signPayosUatEvidence({
  evidencePath,
  privateKeyPath,
  keyId,
  signedAt,
  output,
  overwrite = false,
  root = repositoryRoot,
  stagingRunnerPublicKeys,
  stagingRunnerSpkiFingerprints,
}) {
  if (typeof evidencePath !== "string" || evidencePath.length === 0) throw new Error("payos_uat_evidence_required");
  if (typeof privateKeyPath !== "string" || privateKeyPath.length === 0) throw new Error("payos_uat_owner_private_key_required");
  if (typeof output !== "string" || output.length === 0) throw new Error("payos_uat_sign_output_required");
  if (typeof keyId !== "string" || !KEY_ID.test(keyId)) throw new Error("payos_uat_owner_attestation_key_id_invalid");
  assertIso(signedAt);
  const evidenceBytes = await readPrivateFile(resolve(root, evidencePath), "payos_uat_evidence_missing", "payos_uat_evidence_permissions_invalid");
  let evidence;
  try {
    evidence = JSON.parse(evidenceBytes.toString("utf8"));
  } catch {
    throw new Error("payos_uat_evidence_invalid");
  }
  if (evidence?.evidenceKind !== "provider_acceptance") throw new Error("payos_uat_evidence_kind_invalid");
  const outputPath = canonicalOutputPath(root, evidence?.release?.releaseId, output);
  const privateKeyBytes = await readPrivateFile(resolve(root, privateKeyPath), "payos_uat_owner_private_key_missing", "payos_uat_owner_private_key_permissions_invalid");
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyBytes);
  } catch {
    throw new Error("payos_uat_owner_private_key_invalid");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("payos_uat_owner_private_key_invalid");
  const attestation = { algorithm: "ed25519", keyId, signatureBase64: "", signedAt };
  const signedEvidence = { ...evidence, ownerAttestation: attestation };
  attestation.signatureBase64 = sign(null, Buffer.from(serializePayosOwnerAttestationPayload(signedEvidence)), privateKey).toString("base64");
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const binding = readTrustedStagingUatBinding({ evidence: signedEvidence, repositoryRoot: root });
  const scenarioArtifactFingerprints = readPayosScenarioArtifactFingerprints({ evidence: signedEvidence, repositoryRoot: root });
  const providerExecution = readPayosProviderExecutionArtifacts({
    evidence: signedEvidence,
    repositoryRoot: root,
    stagingRunnerPublicKeys,
    stagingRunnerSpkiFingerprints,
  });
  assertPayosStagingUatEvidence(signedEvidence, {
    ...binding,
    ownerAttestationPublicKeys: { [keyId]: publicKeyPem },
    providerExecutionArtifactFingerprints: providerExecution.fingerprints,
    requireArtifactProof: true,
    scenarioArtifactFingerprints,
  });
  const outputRelative = relative(resolve(root, ".wrangler", "releases", "staging", evidence.release.releaseId), outputPath);
  if (outputRelative !== "payos-uat-evidence.json") throw new Error("payos_uat_evidence_path_noncanonical");
  const bytes = Buffer.from(`${JSON.stringify(signedEvidence, null, 2)}\n`, "utf8");
  await mkdir(dirname(outputPath), { mode: 0o700, recursive: true });
  if (overwrite) {
    const current = await lstat(outputPath).catch(() => null);
    if (current !== null && (!current.isFile() || current.isSymbolicLink() || (current.mode & 0o077) !== 0)) {
      throw new Error("payos_uat_sign_output_permissions_invalid");
    }
  }
  try {
    await writeFile(outputPath, bytes, { flag: overwrite ? "w" : "wx", mode: 0o600 });
  } catch {
    throw new Error("payos_uat_sign_output_exists");
  }
  await chmod(outputPath, 0o600);
  return {
    artifactFingerprintSha256: createHash("sha256").update(bytes).digest("hex"),
    evidencePath: outputPath,
    keyId,
    releaseId: evidence.release.releaseId,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const runnerTrust = readPayosRunnerTrustAnchor({
    keyId: options.runnerAttestationKeyId,
    publicKeyPath: options.runnerAttestationPublicKeyPath,
    repositoryRoot,
    spkiSha256: options.runnerAttestationSpkiSha256,
  });
  const result = await signPayosUatEvidence({ ...options, ...runnerTrust });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message) ? error.message : "payos_uat_sign_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
