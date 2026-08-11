import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateCommerceUatArtifactsSync } from "./lib/commerce-uat-evidence.mjs";
import {
  fingerprintPayosStagingUatEvidence,
  PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS,
  PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS,
  PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS,
} from "./lib/payos-uat-evidence.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const RELEASE_ID = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;

function parseArguments(argv) {
  const options = {
    evidencePath: null,
    json: false,
    manifestPath: null,
    ownerAttestationKeyId: null,
    ownerAttestationPublicKeyPath: null,
    workerVersion: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--evidence") options.evidencePath = argv[++index] ?? "";
    else if (argument === "--manifest") options.manifestPath = argv[++index] ?? "";
    else if (argument === "--owner-attestation-key-id") options.ownerAttestationKeyId = argv[++index] ?? "";
    else if (argument === "--owner-attestation-public-key") options.ownerAttestationPublicKeyPath = argv[++index] ?? "";
    else if (argument === "--worker-version") options.workerVersion = argv[++index] ?? "";
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}

async function loadOwnerAttestationPublicKeys(options) {
  const keyId = options.ownerAttestationKeyId ?? process.env.SELINOW_PAYOS_UAT_ATTESTATION_KEY_ID ?? null;
  if (options.ownerAttestationPublicKeyPath !== null) {
    if (keyId === null || keyId.length === 0) throw new Error("payos_uat_owner_attestation_key_id_required");
    return { [keyId]: await readFile(resolve(repositoryRoot, options.ownerAttestationPublicKeyPath), "utf8") };
  }
  const encoded = process.env.SELINOW_PAYOS_UAT_ATTESTATION_PUBLIC_KEY_PEM_BASE64;
  if (keyId !== null && keyId.length > 0 && typeof encoded === "string" && encoded.length > 0) {
    return { [keyId]: Buffer.from(encoded, "base64").toString("utf8") };
  }
  return {};
}

async function readPrivateEvidence(path) {
  const stat = await lstat(path).catch(() => null);
  if (stat === null) throw new Error("payos_uat_evidence_missing");
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("payos_uat_evidence_permissions_invalid");
  const bytes = await readFile(path);
  let evidence;
  try {
    evidence = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("payos_uat_evidence_invalid");
  }
  return { bytes, evidence };
}

function canonicalEvidenceRef(root, evidencePath, releaseId) {
  if (!RELEASE_ID.test(releaseId ?? "")) throw new Error("payos_uat_release_id_invalid");
  const canonical = resolve(root, ".wrangler", "releases", "staging", releaseId, "payos-uat-evidence.json");
  if (resolve(evidencePath) !== canonical) throw new Error("payos_uat_evidence_path_noncanonical");
  return relative(root, canonical).split("\\").join("/");
}

/** Validate the same release-bound scenario artifacts consumed by release admission. */
export async function validatePayosUatEvidenceFile({
  evidencePath,
  manifestPath,
  now = new Date(),
  ownerAttestationPublicKeys,
  workerVersion,
  root = repositoryRoot,
}) {
  if (typeof evidencePath !== "string" || evidencePath.length === 0) throw new Error("payos_uat_evidence_required");
  if (typeof manifestPath !== "string" || manifestPath.length === 0) throw new Error("payos_uat_manifest_required");
  if (typeof workerVersion !== "string" || workerVersion.length === 0) throw new Error("payos_uat_worker_version_required");
  const resolvedEvidencePath = isAbsolute(evidencePath) ? evidencePath : resolve(root, evidencePath);
  const loaded = await readPrivateEvidence(resolvedEvidencePath);
  const releaseId = loaded.evidence?.release?.releaseId;
  const evidenceRef = canonicalEvidenceRef(root, resolvedEvidencePath, releaseId);
  const declaredManifestRef = loaded.evidence?.release?.manifestRef;
  if (typeof declaredManifestRef !== "string"
    || resolve(root, declaredManifestRef) !== (isAbsolute(manifestPath) ? resolve(manifestPath) : resolve(root, manifestPath))) {
    throw new Error("commerce_uat_manifest_ref_mismatch");
  }
  if (loaded.evidence?.release?.workerVersion !== workerVersion) throw new Error("commerce_uat_worker_version_mismatch");
  const artifactSha256 = createHash("sha256").update(loaded.bytes).digest("hex");
  if (!SHA256.test(artifactSha256)) throw new Error("payos_uat_evidence_hash_invalid");
  const validation = validateCommerceUatArtifactsSync({
    evidence: {
      commerceAcceptance: {
        payos: { artifactSha256, evidenceRef },
      },
    },
    now,
    payosOwnerAttestationPublicKeys: ownerAttestationPublicKeys,
    repositoryRoot: root,
  }).payos;
  const output = {
    accepted: validation.accepted === true,
    acceptanceReasonCode: validation.accepted === true ? null : validation.error ?? "payos_uat_validation_failed",
    artifactFingerprintSha256: validation.artifactFingerprintSha256 ?? artifactSha256,
    evidenceFingerprintSha256: fingerprintPayosStagingUatEvidence(loaded.evidence),
    evidenceKind: loaded.evidence?.evidenceKind ?? null,
    fullCommerceAccepted: validation.fullCommerceAccepted === true,
    fullCommerceReasonCodes: validation.reasonCodes ?? [],
    localScenarioCount: PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS.length,
    manifestRef: validation.manifestRef ?? null,
    manifestSha256: validation.manifestSha256 ?? null,
    paymentLaneAccepted: validation.paymentLaneAccepted === true,
    providerScenarioCount: PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS.length,
    reasonCodes: validation.reasonCodes ?? [],
    releaseId: validation.releaseId ?? releaseId ?? null,
    scenarioCount: validation.scenarioCount ?? 0,
    unsupportedReasonCodes: validation.reasonCodes ?? [],
    unsupportedScenarioCount: PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS.length,
    workerVersion: validation.workerVersion ?? workerVersion,
  };
  return output;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.evidencePath === null || options.evidencePath.length === 0) throw new Error("payos_uat_evidence_required");
  if (options.manifestPath === null || options.manifestPath.length === 0) throw new Error("payos_uat_manifest_required");
  if (options.workerVersion === null || options.workerVersion.length === 0) throw new Error("payos_uat_worker_version_required");
  const result = await validatePayosUatEvidenceFile({
    evidencePath: options.evidencePath,
    manifestPath: options.manifestPath,
    ownerAttestationPublicKeys: await loadOwnerAttestationPublicKeys(options),
    workerVersion: options.workerVersion,
  });
  if (!result.accepted) {
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stderr.write(`BLOCKED payos staging UAT ${result.acceptanceReasonCode} ${result.releaseId}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `PASS payos staging UAT ${result.providerScenarioCount} provider + ${result.localScenarioCount} local scenarios ${result.releaseId}\n`);
  }
  return result;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(error.message) ? error.message : "payos_uat_validation_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
