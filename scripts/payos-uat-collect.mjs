import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS,
  PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS,
  PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS,
  PAYOS_STAGING_UAT_SCENARIO_IDS,
  readPayosProviderExecutionArtifacts,
  readPayosRunnerTrustAnchor,
} from "./lib/payos-uat-evidence.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

const GIT_SHA = /^[a-f0-9]{40}$/u;
const RELEASE_ID = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;
const WORKER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UNSUPPORTED_REASONS = Object.freeze({
  signed_chargeback: "payos_signed_chargeback_not_supported",
  signed_refund: "payos_signed_refund_not_supported",
});

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") options.manifestPath = argv[++index] ?? "";
    else if (argument === "--worker-version") options.workerVersion = argv[++index] ?? "";
    else if (argument === "--created-at") options.createdAt = argv[++index] ?? "";
    else if (argument === "--completed-at") options.completedAt = argv[++index] ?? "";
    else if (argument === "--runner-attestation-key-id") options.runnerAttestationKeyId = argv[++index] ?? "";
    else if (argument === "--runner-attestation-public-key") options.runnerAttestationPublicKeyPath = argv[++index] ?? "";
    else if (argument === "--runner-attestation-spki-sha256") options.runnerAttestationSpkiSha256 = argv[++index] ?? "";
    else if (argument === "--output") options.output = argv[++index] ?? "";
    else throw new Error("payos_uat_collect_argument_invalid");
  }
  return options;
}

function iso(value, issue) {
  const parsed = new Date(value ?? "");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(issue);
  return parsed;
}

async function readPrivateJson(path, issue) {
  const stat = await lstat(path).catch(() => null);
  if (stat === null) throw new Error(issue);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error(`${issue}_permissions_invalid`);
  const bytes = await readFile(path);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    throw new Error(`${issue}_invalid`);
  }
}

function releaseFromManifest(manifest, bytes, manifestRef, workerVersion) {
  if (manifest?.schemaVersion !== 3 || manifest?.environment !== "staging"
    || !RELEASE_ID.test(manifest.releaseId ?? "")
    || !GIT_SHA.test(manifest.commitSha ?? "") || !GIT_SHA.test(manifest.treeSha ?? "")
    || !WORKER_VERSION.test(workerVersion ?? "")) {
    throw new Error("payos_uat_manifest_invalid");
  }
  return {
    commitSha: manifest.commitSha,
    manifestRef,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    releaseId: manifest.releaseId,
    treeSha: manifest.treeSha,
    workerVersion,
  };
}

function assertRelease(actual, expected) {
  for (const key of ["commitSha", "manifestRef", "manifestSha256", "releaseId", "treeSha", "workerVersion"]) {
    if (actual?.[key] !== expected[key]) throw new Error("payos_uat_scenario_artifact_binding_mismatch");
  }
}

function scenarioPolicy(id) {
  if (PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS.includes(id)) {
    return {
      classification: "provider_supported",
      reasonCode: null,
      status: "passed",
      verificationMethod: id === "signed_exact_payment" ? "signed_webhook" : "verified_provider_response",
    };
  }
  if (PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS.includes(id)) {
    return { classification: "selinow_local_assurance", reasonCode: null, status: "passed", verificationMethod: "local_contract" };
  }
  return {
    classification: "provider_unsupported",
    reasonCode: UNSUPPORTED_REASONS[id],
    status: "unsupported",
    verificationMethod: "provider_capability_audit",
  };
}

function assertScenarioArtifact(artifact, id, policy, release) {
  if (artifact?.schemaVersion !== 1 || artifact?.evidenceKind !== "provider_acceptance"
    || artifact?.environment !== "staging" || artifact?.provider !== "payos"
    || artifact?.scenarioId !== id || artifact?.classification !== policy.classification
    || artifact?.result !== policy.status || artifact?.verificationMethod !== policy.verificationMethod) {
    throw new Error("payos_uat_scenario_artifact_invalid");
  }
  iso(artifact.observedAt, "payos_uat_scenario_timestamp_invalid");
  assertRelease(artifact.release, release);
  const providerRequired = PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS.includes(id);
  if (providerRequired) {
    if (!SHA256.test(artifact.controlledAccountFingerprintSha256 ?? "")
      || !SHA256.test(artifact.proofOfExecutionFingerprintSha256 ?? "")) {
      throw new Error("payos_uat_provider_execution_artifact_unverified");
    }
  } else if (artifact.controlledAccountFingerprintSha256 !== null || artifact.proofOfExecutionFingerprintSha256 !== null) {
    throw new Error("payos_uat_scenario_fingerprint_scope_invalid");
  }
  if (artifact?.redaction?.noRawPayload !== true || artifact?.redaction?.noSensitiveValues !== true) {
    throw new Error("payos_uat_scenario_artifact_redaction_invalid");
  }
}

export async function collectPayosUatEvidence({
  completedAt,
  createdAt,
  manifestPath,
  output,
  root = repositoryRoot,
  stagingRunnerPublicKeys,
  stagingRunnerSpkiFingerprints,
  workerVersion,
}) {
  const created = iso(createdAt, "payos_uat_created_at_invalid");
  const completed = iso(completedAt, "payos_uat_completed_at_invalid");
  if (completed.getTime() < created.getTime()) throw new Error("payos_uat_time_order_invalid");
  const manifestAbsolute = resolve(root, manifestPath);
  const manifestLoaded = await readPrivateJson(manifestAbsolute, "payos_uat_manifest_missing");
  const manifestRef = relative(root, manifestAbsolute).split("\\").join("/");
  const release = releaseFromManifest(manifestLoaded.value, manifestLoaded.bytes, manifestRef, workerVersion);
  const canonicalManifest = resolve(root, ".wrangler", "releases", "staging", release.releaseId, "release-manifest.json");
  if (manifestAbsolute !== canonicalManifest) throw new Error("payos_uat_manifest_path_noncanonical");

  const scenarios = {};
  const scenarioFingerprints = [];
  const providerFingerprints = [];
  const controlledFingerprints = new Set();
  for (const id of PAYOS_STAGING_UAT_SCENARIO_IDS) {
    const artifactRef = `.wrangler/releases/staging/${release.releaseId}/scenarios/payos-${id}.json`;
    const loaded = await readPrivateJson(resolve(root, artifactRef), "payos_uat_scenario_artifact_missing");
    const policy = scenarioPolicy(id);
    assertScenarioArtifact(loaded.value, id, policy, release);
    const fingerprint = createHash("sha256").update(loaded.bytes).digest("hex");
    scenarioFingerprints.push(fingerprint);
    if (PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS.includes(id)) {
      controlledFingerprints.add(loaded.value.controlledAccountFingerprintSha256);
      providerFingerprints.push(loaded.value.proofOfExecutionFingerprintSha256);
    }
    scenarios[id] = {
      classification: policy.classification,
      evidenceFingerprintSha256: fingerprint,
      eventReference: null,
      observedAt: loaded.value.observedAt,
      reasonCode: policy.reasonCode,
      requestReference: `artifact:${artifactRef}`,
      status: policy.status,
      verificationMethod: policy.verificationMethod,
    };
  }
  if (controlledFingerprints.size !== 1 || new Set(providerFingerprints).size !== providerFingerprints.length) {
    throw new Error("payos_uat_provider_execution_reference_duplicate");
  }
  const controlledAccountFingerprintSha256 = [...controlledFingerprints][0];
  const transactionEvidenceFingerprintSha256 = createHash("sha256").update(JSON.stringify([...providerFingerprints].sort())).digest("hex");
  const evidence = {
    acceptanceReasonCode: null,
    channel: "seller_payment",
    completedAt,
    createdAt,
    environment: "staging",
    evidenceKind: "provider_acceptance",
    ownerAttestation: null,
    provider: "payos",
    providerEnvironment: "production_controlled",
    providerExecution: {
      controlledAccountFingerprintSha256,
      paymentInstrument: "controlled_real_bank",
      realLowValueTransactionObserved: true,
      signatureSource: "provider_signed_webhook_and_verified_response",
      syntheticSignatureUsed: false,
      transactionEvidenceFingerprintSha256,
    },
    redaction: {
      auditNoSensitiveValues: true,
      d1NoRawPayload: true,
      d1NoSecretValues: true,
      evidenceFingerprintSha256: createHash("sha256").update(JSON.stringify([...scenarioFingerprints, ...providerFingerprints].sort())).digest("hex"),
      logsNoSensitiveValues: true,
      queuesNoSensitiveValues: true,
    },
    release,
    scenarioPolicy: {
      localRequired: PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS,
      providerRequired: PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS,
      providerUnsupported: PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS,
    },
    scenarios,
    schemaVersion: 2,
    unsupportedCapabilities: {
      signedChargeback: { documentationReference: "payos_docs:payment_webhook", reasonCode: UNSUPPORTED_REASONS.signed_chargeback, status: "unsupported" },
      signedRefund: { documentationReference: "payos_docs:payment_webhook", reasonCode: UNSUPPORTED_REASONS.signed_refund, status: "unsupported" },
    },
  };
  readPayosProviderExecutionArtifacts({
    evidence,
    repositoryRoot: root,
    stagingRunnerPublicKeys,
    stagingRunnerSpkiFingerprints,
  });
  const outputPath = resolve(root, output);
  const canonicalOutput = resolve(root, ".wrangler", "releases", "staging", release.releaseId, "payos-uat-evidence.unsigned.json");
  if (outputPath !== canonicalOutput) throw new Error("payos_uat_collect_output_noncanonical");
  await mkdir(dirname(outputPath), { mode: 0o700, recursive: true });
  try {
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    throw new Error("payos_uat_collect_output_exists");
  }
  await chmod(outputPath, 0o600);
  return { evidence, evidencePath: outputPath, releaseId: release.releaseId };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const runnerTrust = readPayosRunnerTrustAnchor({
    keyId: options.runnerAttestationKeyId,
    publicKeyPath: options.runnerAttestationPublicKeyPath,
    repositoryRoot,
    spkiSha256: options.runnerAttestationSpkiSha256,
  });
  const result = await collectPayosUatEvidence({ ...options, ...runnerTrust });
  process.stdout.write(`${JSON.stringify({ evidencePath: result.evidencePath, releaseId: result.releaseId }, null, 2)}\n`);
  return result;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message) ? error.message : "payos_uat_collect_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
