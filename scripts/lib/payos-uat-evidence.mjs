import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { Buffer } from "node:buffer";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export const PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS = Object.freeze([
  "signed_exact_payment",
  "direct_reconciliation",
]);

export const PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS = Object.freeze([
  "invalid_signature",
  "duplicate_replay",
  "conflicting_replay",
  "partial_payment",
  "overpayment",
  "late_payment",
  "amount_mismatch",
  "currency_mismatch",
  "tenant_isolation",
  "fulfillment_exactly_once",
]);

export const PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS = Object.freeze([
  "signed_refund",
  "signed_chargeback",
]);

export const PAYOS_STAGING_UAT_SCENARIO_IDS = Object.freeze([
  ...PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS,
  ...PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS,
  ...PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS,
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const RELEASE_ID = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;
const WORKER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const REF = /^(?:request|event|session):[A-Za-z0-9._-]{3,128}$|^artifact:[A-Za-z0-9._/-]{3,240}$/u;
const ATTESTATION_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const UNSAFE = [/https?:\/\//iu, /Bearer(?:\s+|[_-])/iu, /whsec_/iu, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu, /(?:secret|token|api[_-]?key|raw[_-]?(?:body|payload)|checkout[_-]?url|customer|buyer|credential)/iu];
const PROVIDER_METHODS = Object.freeze({
  direct_reconciliation: "verified_provider_response",
  signed_exact_payment: "signed_webhook",
});
const UNSUPPORTED_REASONS = Object.freeze({
  signed_chargeback: "payos_signed_chargeback_not_supported",
  signed_refund: "payos_signed_refund_not_supported",
});
const PROVIDER_EXECUTION_REF = /^provider:[a-f0-9]{64}$/u;
const ATTEMPT_REF = /^attempt:pay_[0-9a-f-]{36}$/u;
const EVENT_REF = /^event:pev_[0-9a-f-]{36}$/u;
const REQUEST_REF = /^request:[A-Za-z0-9._:-]{8,128}$/u;
const RUNNER_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const AUTHORITY_SOURCES = Object.freeze({
  direct_reconciliation: ["staging_exact_attempt_reconciliation", "provider_signed_response"],
  signed_exact_payment: ["staging_d1_verified_event", "provider_signed_webhook"],
});

function keys(value, expected, issue) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(issue);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(issue);
}

function exactArray(value, expected, issue) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((entry, index) => entry !== expected[index])) {
    throw new Error(issue);
  }
}

function safe(value) {
  if (typeof value === "string" && UNSAFE.some((pattern) => pattern.test(value))) throw new Error("payos_uat_value_unsafe");
  if (Array.isArray(value)) value.forEach(safe);
  else if (typeof value === "object" && value !== null) Object.values(value).forEach(safe);
}

function sha(value, issue) {
  if (typeof value !== "string" || !SHA256.test(value) || /^0+$/u.test(value)) throw new Error(issue);
}

function iso(value, issue) {
  if (typeof value !== "string") throw new Error(issue);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error(issue);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonical(nested)]));
}

export function serializePayosRunnerAttestationPayload(artifact) {
  const attestation = artifact?.runnerAttestation;
  return JSON.stringify(canonical({
    ...artifact,
    runnerAttestation: attestation === null || attestation === undefined
      ? null
      : {
        algorithm: attestation.algorithm,
        keyId: attestation.keyId,
        publicKeySpkiSha256: attestation.publicKeySpkiSha256,
        signedAt: attestation.signedAt,
      },
  }));
}

export function readPayosRunnerTrustAnchor({ keyId, publicKeyPath, repositoryRoot, spkiSha256 }) {
  if (!RUNNER_KEY_ID.test(keyId ?? "") || !SHA256.test(spkiSha256 ?? "") || typeof publicKeyPath !== "string" || publicKeyPath.length === 0) {
    throw new Error("payos_uat_runner_trust_anchor_invalid");
  }
  const path = resolve(repositoryRoot, publicKeyPath);
  const publicKeyPem = readPrivateFile(repositoryRoot, path, {
    invalid: "payos_uat_runner_public_key_invalid",
    missing: "payos_uat_runner_public_key_missing",
    path: "payos_uat_runner_public_key_ancestor_invalid",
    permissions: "payos_uat_runner_public_key_invalid",
  }, { requirePrivatePermissions: false }).toString("utf8");
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    throw new Error("payos_uat_runner_public_key_invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("payos_uat_runner_public_key_invalid");
  const observed = createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex");
  if (observed !== spkiSha256) throw new Error("payos_uat_runner_attestation_fingerprint_mismatch");
  return {
    stagingRunnerPublicKeys: { [keyId]: publicKeyPem },
    stagingRunnerSpkiFingerprints: { [keyId]: spkiSha256 },
  };
}

export function assertPayosUnsignedProviderExecutionArtifact(value) {
  const scenarioId = value?.scenarioId;
  if (!PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS.includes(scenarioId)) {
    throw new Error("payos_uat_provider_execution_artifact_invalid");
  }
  if (value?.runnerAttestation !== null) throw new Error("payos_uat_runner_attestation_already_present");
  const controlledAccountFingerprintSha256 = value?.controlledAccountFingerprintSha256;
  sha(controlledAccountFingerprintSha256, "payos_uat_provider_execution_artifact_invalid");
  const release = value?.release;
  const evidence = {
    providerExecution: { controlledAccountFingerprintSha256 },
    release,
    scenarios: { [scenarioId]: { observedAt: value?.observedAt } },
  };
  assertProviderExecutionArtifact(value, evidence, scenarioId);
  safe(value);
  return value;
}

function fingerprintList(values) {
  return createHash("sha256").update(JSON.stringify([...values].sort())).digest("hex");
}

function readPrivateFile(root, path, issues, { requirePrivatePermissions = true } = {}) {
  const base = resolve(root);
  const target = resolve(path);
  const rel = relative(base, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(issues.path);
  assertNoSymlinkAncestors(base, target, issues.path);
  let descriptor;
  try {
    const canonicalRoot = realpathSync.native(base);
    const canonicalPath = realpathSync.native(target);
    const expectedCanonicalPath = resolve(canonicalRoot, rel);
    if (canonicalPath !== expectedCanonicalPath) throw new Error(issues.path);
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = fstatSync(descriptor, { bigint: true });
    const pathStat = statSync(target, { bigint: true });
    if (!openedStat.isFile()
      || (requirePrivatePermissions && (openedStat.mode & 0o077n) !== 0n)
      || openedStat.dev !== pathStat.dev
      || openedStat.ino !== pathStat.ino
      || realpathSync.native(target) !== canonicalPath) {
      throw new Error(issues.permissions);
    }
    const bytes = readFileSync(descriptor);
    const closedOverStat = fstatSync(descriptor, { bigint: true });
    const finalPathStat = statSync(target, { bigint: true });
    if (openedStat.dev !== closedOverStat.dev
      || openedStat.ino !== closedOverStat.ino
      || openedStat.dev !== finalPathStat.dev
      || openedStat.ino !== finalPathStat.ino
      || openedStat.size !== closedOverStat.size
      || openedStat.mtimeNs !== closedOverStat.mtimeNs
      || openedStat.ctimeNs !== closedOverStat.ctimeNs
      || realpathSync.native(target) !== canonicalPath) {
      throw new Error(issues.path);
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && Object.values(issues).includes(error.message)) throw error;
    if (error?.code === "ELOOP") throw new Error(issues.path, { cause: error });
    throw new Error(descriptor === undefined ? issues.missing : issues.invalid, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readPrivateJson(root, path, missingIssue, pathIssue = `${missingIssue}_path_invalid`) {
  const bytes = readPrivateFile(root, path, {
    invalid: `${missingIssue}_invalid`,
    missing: missingIssue,
    path: pathIssue,
    permissions: `${missingIssue}_permissions_invalid`,
  });
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    throw new Error(`${missingIssue}_invalid`);
  }
}

function assertNoSymlinkAncestors(root, path, issue) {
  const base = resolve(root);
  const rel = relative(base, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(issue);
  let current = base;
  const parts = rel.split(sep).slice(0, -1);
  for (const part of parts) {
    current = resolve(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new Error(issue);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(issue);
  }
}

function canonicalExecutionPath(root, releaseId, scenarioId) {
  const path = resolve(root, ".wrangler", "releases", "staging", releaseId, "execution", `payos-${scenarioId}.json`);
  const rel = relative(resolve(root, ".wrangler", "releases", "staging", releaseId), path);
  if (rel.startsWith("..") || rel.includes("\\")) throw new Error("payos_uat_provider_execution_artifact_path_invalid");
  return path;
}

function scenarioArtifactPath(root, reference, releaseId, scenarioId) {
  const expected = `artifact:.wrangler/releases/staging/${releaseId}/scenarios/payos-${scenarioId}.json`;
  if (reference !== expected) {
    throw new Error("payos_uat_scenario_artifact_reference_required");
  }
  const path = resolve(root, reference.slice("artifact:".length));
  const rel = relative(resolve(root, ".wrangler", "releases", "staging"), path);
  if (rel.startsWith("..") || rel.includes("\\")) throw new Error("payos_uat_scenario_artifact_reference_required");
  return path;
}

function assertExecutionRelease(release, expected) {
  keys(release, ["commitSha", "manifestRef", "manifestSha256", "releaseId", "treeSha", "workerVersion"], "payos_uat_provider_execution_artifact_binding_mismatch");
  for (const key of ["commitSha", "manifestRef", "manifestSha256", "releaseId", "treeSha", "workerVersion"]) {
    if (release[key] !== expected[key]) throw new Error("payos_uat_provider_execution_artifact_binding_mismatch");
  }
}

function assertProviderExecutionArtifact(value, evidence, scenarioId) {
  keys(value, [
    "authority",
    "controlledAccountFingerprintSha256",
    "environment",
    "evidenceKind",
    "observedAt",
    "provider",
    "providerEnvironment",
    "redaction",
    "release",
    "result",
    "runnerAttestation",
    "scenarioId",
    "schemaVersion",
    "verificationMethod",
  ], "payos_uat_provider_execution_artifact_invalid");
  const record = evidence.scenarios[scenarioId];
  if (value.schemaVersion !== 1
    || value.evidenceKind !== "provider_execution"
    || value.environment !== "staging"
    || value.provider !== "payos"
    || value.providerEnvironment !== "production_controlled"
    || value.scenarioId !== scenarioId
    || value.verificationMethod !== PROVIDER_METHODS[scenarioId]
    || value.observedAt !== record.observedAt
    || value.controlledAccountFingerprintSha256 !== evidence.providerExecution.controlledAccountFingerprintSha256) {
    throw new Error("payos_uat_provider_execution_artifact_binding_mismatch");
  }
  assertExecutionRelease(value.release, evidence.release);
  keys(value.authority, ["attemptReference", "authoritySource", "eventReference", "providerAuthority", "providerReference", "requestReference"], "payos_uat_provider_execution_authority_invalid");
  const [authoritySource, providerAuthority] = AUTHORITY_SOURCES[scenarioId] ?? [];
  if (!ATTEMPT_REF.test(value.authority.attemptReference ?? "")
    || !EVENT_REF.test(value.authority.eventReference ?? "")
    || !PROVIDER_EXECUTION_REF.test(value.authority.providerReference ?? "")
    || !REQUEST_REF.test(value.authority.requestReference ?? "")
    || value.authority.authoritySource !== authoritySource
    || value.authority.providerAuthority !== providerAuthority) {
    throw new Error("payos_uat_provider_execution_authority_invalid");
  }
  keys(value.result, ["duplicate", "processed", "state"], "payos_uat_provider_execution_result_invalid");
  if (value.result.duplicate !== false || value.result.processed !== true || value.result.state !== "paid_exact") {
    throw new Error("payos_uat_provider_execution_result_invalid");
  }
  keys(value.redaction, ["noCredentialData", "noCustomerData", "noFinancialDetails", "noRawPayload"], "payos_uat_provider_execution_redaction_invalid");
  if (Object.values(value.redaction).some((entry) => entry !== true)) {
    throw new Error("payos_uat_provider_execution_redaction_invalid");
  }
  return value.authority;
}

function assertRunnerAttestation(value, trust) {
  const attestation = value.runnerAttestation;
  if (attestation === null) throw new Error("payos_uat_runner_attestation_required");
  keys(attestation, ["algorithm", "keyId", "publicKeySpkiSha256", "signatureBase64", "signedAt"], "payos_uat_runner_attestation_invalid");
  if (attestation.algorithm !== "ed25519" || !RUNNER_KEY_ID.test(attestation.keyId ?? "")
    || !SHA256.test(attestation.publicKeySpkiSha256 ?? "") || !BASE64.test(attestation.signatureBase64 ?? "")) {
    throw new Error("payos_uat_runner_attestation_invalid");
  }
  iso(attestation.signedAt, "payos_uat_runner_attestation_invalid");
  const observedAt = new Date(value.observedAt).getTime();
  const signedAt = new Date(attestation.signedAt).getTime();
  if (signedAt < observedAt || signedAt > observedAt + 15 * 60_000) throw new Error("payos_uat_runner_attestation_invalid");
  const publicKeyPem = trust?.stagingRunnerPublicKeys?.[attestation.keyId];
  const pinnedFingerprint = trust?.stagingRunnerSpkiFingerprints?.[attestation.keyId];
  if (typeof publicKeyPem !== "string" || !SHA256.test(pinnedFingerprint ?? "")) {
    throw new Error("payos_uat_runner_attestation_untrusted");
  }
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    throw new Error("payos_uat_runner_attestation_untrusted");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("payos_uat_runner_attestation_untrusted");
  const observedFingerprint = createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  if (observedFingerprint !== pinnedFingerprint || attestation.publicKeySpkiSha256 !== pinnedFingerprint) {
    throw new Error("payos_uat_runner_attestation_fingerprint_mismatch");
  }
  const signature = Buffer.from(attestation.signatureBase64, "base64");
  if (signature.length !== 64
    || !verifySignature(null, Buffer.from(serializePayosRunnerAttestationPayload(value)), publicKey, signature)) {
    throw new Error("payos_uat_runner_attestation_invalid");
  }
}

export function readPayosProviderExecutionArtifact({
  executionEvidencePath,
  observedAt,
  release,
  repositoryRoot,
  scenarioId,
  stagingRunnerPublicKeys,
  stagingRunnerSpkiFingerprints,
  verificationMethod,
}) {
  const root = resolve(repositoryRoot);
  const expectedPath = canonicalExecutionPath(root, release.releaseId, scenarioId);
  if (resolve(root, executionEvidencePath) !== expectedPath) {
    throw new Error("payos_uat_provider_execution_artifact_path_invalid");
  }
  const loaded = readPrivateJson(
    root,
    expectedPath,
    "payos_uat_provider_execution_artifact_missing",
    "payos_uat_provider_execution_artifact_ancestor_invalid",
  );
  const controlledAccountFingerprintSha256 = loaded.value?.controlledAccountFingerprintSha256;
  sha(controlledAccountFingerprintSha256, "payos_uat_provider_execution_artifact_invalid");
  const evidence = {
    providerExecution: { controlledAccountFingerprintSha256 },
    release,
    scenarios: { [scenarioId]: { observedAt } },
  };
  if (verificationMethod !== PROVIDER_METHODS[scenarioId]) throw new Error("payos_uat_provider_execution_artifact_binding_mismatch");
  const authority = assertProviderExecutionArtifact(loaded.value, evidence, scenarioId);
  assertRunnerAttestation(loaded.value, { stagingRunnerPublicKeys, stagingRunnerSpkiFingerprints });
  return {
    authority,
    controlledAccountFingerprintSha256,
    fingerprintSha256: createHash("sha256").update(loaded.bytes).digest("hex"),
    path: expectedPath,
  };
}

/** Verify the separate provider-execution artifacts before release admission. */
export function readPayosProviderExecutionArtifacts({
  evidence,
  repositoryRoot,
  stagingRunnerPublicKeys,
  stagingRunnerSpkiFingerprints,
}) {
  if (evidence?.evidenceKind !== "provider_acceptance") throw new Error("payos_uat_provider_execution_artifact_not_applicable");
  const root = resolve(repositoryRoot);
  const fingerprints = {};
  const authorities = {};
  const references = new Set();
  for (const scenarioId of PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS) {
    const record = evidence?.scenarios?.[scenarioId];
    const scenarioPath = scenarioArtifactPath(root, record?.requestReference, evidence.release.releaseId, scenarioId);
    const scenario = readPrivateJson(root, scenarioPath, "payos_uat_scenario_artifact_missing").value;
    const executionPath = canonicalExecutionPath(root, evidence.release.releaseId, scenarioId);
    const execution = readPrivateJson(
      root,
      executionPath,
      "payos_uat_provider_execution_artifact_missing",
      "payos_uat_provider_execution_artifact_ancestor_invalid",
    );
    const fingerprint = createHash("sha256").update(execution.bytes).digest("hex");
    if (scenario?.scenarioId !== scenarioId || scenario?.proofOfExecutionFingerprintSha256 !== fingerprint) {
      throw new Error("payos_uat_provider_execution_artifact_hash_mismatch");
    }
    const authority = assertProviderExecutionArtifact(execution.value, evidence, scenarioId);
    assertRunnerAttestation(execution.value, { stagingRunnerPublicKeys, stagingRunnerSpkiFingerprints });
    for (const reference of Object.values(authority)) {
      if (references.has(reference)) throw new Error("payos_uat_provider_execution_reference_duplicate");
      references.add(reference);
    }
    fingerprints[scenarioId] = fingerprint;
    authorities[scenarioId] = authority;
  }
  const transactionEvidenceFingerprintSha256 = fingerprintList(Object.values(fingerprints));
  if (transactionEvidenceFingerprintSha256 !== evidence.providerExecution.transactionEvidenceFingerprintSha256) {
    throw new Error("payos_uat_provider_execution_fingerprint_mismatch");
  }
  return { authorities, fingerprints, transactionEvidenceFingerprintSha256 };
}

export function readPayosScenarioArtifactFingerprints({ evidence, repositoryRoot }) {
  const fingerprints = {};
  for (const scenarioId of PAYOS_STAGING_UAT_SCENARIO_IDS) {
    const record = evidence?.scenarios?.[scenarioId];
    const path = scenarioArtifactPath(resolve(repositoryRoot), record?.requestReference, evidence.release.releaseId, scenarioId);
    const loaded = readPrivateJson(resolve(repositoryRoot), path, "payos_uat_scenario_artifact_missing");
    const fingerprint = createHash("sha256").update(loaded.bytes).digest("hex");
    if (fingerprint !== record?.evidenceFingerprintSha256) throw new Error("payos_uat_scenario_artifact_hash_mismatch");
    if (loaded.value?.provider !== "payos" || loaded.value?.environment !== "staging"
      || loaded.value?.scenarioId !== scenarioId || loaded.value?.release?.releaseId !== evidence?.release?.releaseId) {
      throw new Error("payos_uat_scenario_artifact_binding_mismatch");
    }
    fingerprints[scenarioId] = fingerprint;
  }
  return fingerprints;
}

export function fingerprintPayosStagingUatEvidence(evidence) {
  return createHash("sha256").update(JSON.stringify(canonical(evidence))).digest("hex");
}

/** Serialize the claims covered by the detached release-owner signature. */
export function serializePayosOwnerAttestationPayload(evidence) {
  const attestation = evidence?.ownerAttestation;
  const unsigned = attestation === null || attestation === undefined
    ? { ...evidence, ownerAttestation: null }
    : {
      ...evidence,
      ownerAttestation: {
        algorithm: attestation.algorithm,
        keyId: attestation.keyId,
        signedAt: attestation.signedAt,
      },
    };
  return JSON.stringify(canonical(unsigned));
}

function assertRelease(release, binding) {
  keys(release, ["commitSha", "manifestRef", "manifestSha256", "releaseId", "treeSha", "workerVersion"], "payos_uat_release_invalid");
  if (!GIT_SHA.test(release.commitSha ?? "") || /^0+$/u.test(release.commitSha)) throw new Error("payos_uat_commit_invalid");
  if (!GIT_SHA.test(release.treeSha ?? "") || /^0+$/u.test(release.treeSha)) throw new Error("payos_uat_tree_invalid");
  if (!RELEASE_ID.test(release.releaseId ?? "")) throw new Error("payos_uat_release_id_invalid");
  if (typeof release.manifestRef !== "string" || !release.manifestRef.startsWith(".wrangler/releases/staging/") || !release.manifestRef.endsWith("/release-manifest.json")) throw new Error("payos_uat_manifest_ref_invalid");
  sha(release.manifestSha256, "payos_uat_manifest_hash_invalid");
  if (!WORKER_VERSION.test(release.workerVersion ?? "")) throw new Error("payos_uat_worker_version_invalid");
  if (binding.commitSha !== release.commitSha) throw new Error("payos_uat_commit_mismatch");
  if (binding.treeSha !== release.treeSha) throw new Error("payos_uat_tree_mismatch");
  if (binding.releaseId !== release.releaseId || binding.manifestRef !== release.manifestRef || binding.manifestSha256 !== release.manifestSha256) throw new Error("payos_uat_manifest_mismatch");
  if (binding.workerVersion !== release.workerVersion) throw new Error("payos_uat_worker_version_mismatch");
}

function assertRedaction(redaction) {
  keys(redaction, ["auditNoSensitiveValues", "d1NoRawPayload", "d1NoSecretValues", "logsNoSensitiveValues", "queuesNoSensitiveValues", "evidenceFingerprintSha256"], "payos_uat_redaction_invalid");
  for (const [key, value] of Object.entries(redaction)) {
    if (key !== "evidenceFingerprintSha256" && value !== true) throw new Error("payos_uat_redaction_incomplete");
  }
  sha(redaction.evidenceFingerprintSha256, "payos_uat_redaction_fingerprint_invalid");
}

function assertScenarioPolicy(policy) {
  keys(policy, ["localRequired", "providerRequired", "providerUnsupported"], "payos_uat_scenario_policy_invalid");
  exactArray(policy.providerRequired, PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS, "payos_uat_scenario_policy_invalid");
  exactArray(policy.localRequired, PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS, "payos_uat_scenario_policy_invalid");
  exactArray(policy.providerUnsupported, PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS, "payos_uat_scenario_policy_invalid");
}

function assertUnsupportedCapabilities(capabilities) {
  keys(capabilities, ["signedChargeback", "signedRefund"], "payos_uat_unsupported_capabilities_invalid");
  for (const [key, scenarioId] of [["signedRefund", "signed_refund"], ["signedChargeback", "signed_chargeback"]]) {
    const record = capabilities[key];
    keys(record, ["documentationReference", "reasonCode", "status"], "payos_uat_unsupported_capabilities_invalid");
    if (record.status !== "unsupported"
      || record.reasonCode !== UNSUPPORTED_REASONS[scenarioId]
      || record.documentationReference !== "payos_docs:payment_webhook") {
      throw new Error("payos_uat_unsupported_capabilities_invalid");
    }
  }
}

function assertProviderExecution(execution, evidenceKind) {
  keys(execution, ["controlledAccountFingerprintSha256", "paymentInstrument", "realLowValueTransactionObserved", "signatureSource", "syntheticSignatureUsed", "transactionEvidenceFingerprintSha256"], "payos_uat_provider_execution_invalid");
  if (execution.syntheticSignatureUsed !== false) throw new Error("payos_uat_provider_execution_invalid");
  if (evidenceKind === "provider_acceptance") {
    sha(execution.controlledAccountFingerprintSha256, "payos_uat_provider_execution_invalid");
    sha(execution.transactionEvidenceFingerprintSha256, "payos_uat_provider_execution_invalid");
    if (execution.paymentInstrument !== "controlled_real_bank"
      || execution.realLowValueTransactionObserved !== true
      || execution.signatureSource !== "provider_signed_webhook_and_verified_response") {
      throw new Error("payos_uat_provider_execution_invalid");
    }
    return;
  }
  if (execution.controlledAccountFingerprintSha256 !== null
    || execution.transactionEvidenceFingerprintSha256 !== null
    || execution.paymentInstrument !== "none"
    || execution.realLowValueTransactionObserved !== false
    || execution.signatureSource !== "none") {
    throw new Error("payos_uat_provider_execution_invalid");
  }
}

function assertOwnerAttestation(attestation, evidence, binding) {
  if (evidence.evidenceKind === "contract_gap") {
    if (attestation !== null) throw new Error("payos_uat_owner_attestation_invalid");
    return;
  }
  keys(attestation, ["algorithm", "keyId", "signatureBase64", "signedAt"], "payos_uat_owner_attestation_invalid");
  if (attestation.algorithm !== "ed25519" || !ATTESTATION_KEY_ID.test(attestation.keyId)) throw new Error("payos_uat_owner_attestation_invalid");
  iso(attestation.signedAt, "payos_uat_owner_attestation_invalid");
  const signedAt = new Date(attestation.signedAt).getTime();
  const createdAt = new Date(evidence.createdAt).getTime();
  const completedAt = new Date(evidence.completedAt).getTime();
  if (signedAt < createdAt || signedAt > completedAt) throw new Error("payos_uat_owner_attestation_invalid");
  if (typeof attestation.signatureBase64 !== "string" || !BASE64.test(attestation.signatureBase64)) throw new Error("payos_uat_owner_attestation_invalid");
  const publicKeyPem = binding?.ownerAttestationPublicKeys?.[attestation.keyId];
  if (typeof publicKeyPem !== "string" || publicKeyPem.length < 32) throw new Error("payos_uat_owner_attestation_untrusted");
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    throw new Error("payos_uat_owner_attestation_untrusted");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("payos_uat_owner_attestation_untrusted");
  let signature;
  try {
    signature = Buffer.from(attestation.signatureBase64, "base64");
  } catch {
    throw new Error("payos_uat_owner_attestation_invalid");
  }
  if (signature.length !== 64
    || !verifySignature(null, Buffer.from(serializePayosOwnerAttestationPayload(evidence)), publicKey, signature)) {
    throw new Error("payos_uat_owner_attestation_invalid");
  }
}

function assertScenarioProof(record, id, binding) {
  iso(record.observedAt, "payos_uat_scenario_timestamp_invalid");
  sha(record.evidenceFingerprintSha256, "payos_uat_scenario_fingerprint_invalid");
  if (![record.requestReference, record.eventReference].some((ref) => typeof ref === "string" && REF.test(ref))) {
    throw new Error("payos_uat_scenario_reference_invalid");
  }
  if (binding?.requireArtifactProof === true && binding.scenarioArtifactFingerprints?.[id] !== record.evidenceFingerprintSha256) {
    throw new Error("payos_uat_scenario_artifact_unverified");
  }
}

function assertProviderScenario(record, id, binding) {
  if (record.status !== "passed"
    || record.classification !== "provider_supported"
    || record.reasonCode !== null
    || record.verificationMethod !== PROVIDER_METHODS[id]) {
    throw new Error("payos_uat_provider_scenario_invalid");
  }
  assertScenarioProof(record, id, binding);
}

function assertLocalScenario(record, id, binding) {
  if (record.status !== "passed"
    || record.classification !== "selinow_local_assurance"
    || record.reasonCode !== null
    || record.verificationMethod !== "local_contract") {
    throw new Error("payos_uat_local_scenario_invalid");
  }
  assertScenarioProof(record, id, binding);
}

function assertUnsupportedScenario(record, id, binding, requireProof) {
  if (record.status !== "unsupported"
    || record.classification !== "provider_unsupported"
    || record.reasonCode !== UNSUPPORTED_REASONS[id]
    || record.verificationMethod !== "provider_capability_audit") {
    throw new Error("payos_uat_unsupported_scenario_invalid");
  }
  if (requireProof) assertScenarioProof(record, id, binding);
}

function assertGapScenario(record, id) {
  const providerRequired = PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS.includes(id);
  const expectedClassification = providerRequired ? "provider_supported" : "selinow_local_assurance";
  const expectedMethod = providerRequired ? PROVIDER_METHODS[id] : "local_contract";
  const expectedStatus = providerRequired ? "blocked" : "not_started";
  const expectedReason = providerRequired ? "payos_controlled_real_transaction_not_executed" : "payos_local_assurance_not_recorded";
  if (record.classification !== expectedClassification
    || record.verificationMethod !== expectedMethod
    || record.status !== expectedStatus
    || record.reasonCode !== expectedReason
    || record.observedAt !== null
    || record.evidenceFingerprintSha256 !== null
    || record.requestReference !== null
    || record.eventReference !== null) {
    throw new Error("payos_uat_contract_gap_scenario_invalid");
  }
}

function assertScenarioSet(evidence, binding) {
  keys(evidence.scenarios, PAYOS_STAGING_UAT_SCENARIO_IDS, "payos_uat_scenario_set_invalid");
  const fingerprints = [];
  for (const id of PAYOS_STAGING_UAT_SCENARIO_IDS) {
    const record = evidence.scenarios[id];
    keys(record, ["classification", "evidenceFingerprintSha256", "eventReference", "observedAt", "reasonCode", "requestReference", "status", "verificationMethod"], "payos_uat_scenario_record_invalid");
    if (PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS.includes(id)) {
      assertUnsupportedScenario(record, id, binding, evidence.evidenceKind === "provider_acceptance");
    } else if (evidence.evidenceKind === "contract_gap") {
      assertGapScenario(record, id);
    } else if (PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS.includes(id)) {
      assertProviderScenario(record, id, binding);
    } else {
      assertLocalScenario(record, id, binding);
    }
    if (typeof record.evidenceFingerprintSha256 === "string") fingerprints.push(record.evidenceFingerprintSha256);
  }
  if (new Set(fingerprints).size !== fingerprints.length) throw new Error("payos_uat_scenario_fingerprint_duplicate");
}

function assertTimestamps(evidence) {
  iso(evidence.createdAt, "payos_uat_created_at_invalid");
  iso(evidence.completedAt, "payos_uat_completed_at_invalid");
  const created = new Date(evidence.createdAt).getTime();
  const completed = new Date(evidence.completedAt).getTime();
  if (completed < created || PAYOS_STAGING_UAT_SCENARIO_IDS.some((id) => {
    const observedAt = evidence.scenarios[id].observedAt;
    if (observedAt === null) return false;
    const observed = new Date(observedAt).getTime();
    return !Number.isFinite(observed) || observed < created || observed > completed;
  })) throw new Error("payos_uat_time_order_invalid");
}

export function evaluatePayosStagingUatEvidence(evidence, binding) {
  keys(evidence, ["acceptanceReasonCode", "channel", "completedAt", "createdAt", "environment", "evidenceKind", "ownerAttestation", "provider", "providerEnvironment", "providerExecution", "redaction", "release", "scenarioPolicy", "scenarios", "schemaVersion", "unsupportedCapabilities"], "payos_uat_evidence_invalid");
  if (evidence.schemaVersion !== 2 || evidence.environment !== "staging" || evidence.provider !== "payos" || evidence.channel !== "seller_payment") throw new Error("payos_uat_evidence_invalid");
  if (evidence.evidenceKind !== "provider_acceptance" && evidence.evidenceKind !== "contract_gap") throw new Error("payos_uat_evidence_kind_invalid");
  if ((evidence.evidenceKind === "provider_acceptance" && evidence.providerEnvironment !== "production_controlled")
    || (evidence.evidenceKind === "contract_gap" && evidence.providerEnvironment !== "unavailable")) {
    throw new Error("payos_uat_provider_environment_invalid");
  }
  if (evidence.evidenceKind === "provider_acceptance" && evidence.acceptanceReasonCode !== null) throw new Error("payos_uat_acceptance_reason_invalid");
  if (evidence.evidenceKind === "contract_gap" && evidence.acceptanceReasonCode !== "payos_controlled_real_transaction_not_executed") throw new Error("payos_uat_acceptance_reason_invalid");
  safe(evidence);
  assertRelease(evidence.release, binding);
  assertRedaction(evidence.redaction);
  assertScenarioPolicy(evidence.scenarioPolicy);
  assertUnsupportedCapabilities(evidence.unsupportedCapabilities);
  assertScenarioSet(evidence, binding);
  assertProviderExecution(evidence.providerExecution, evidence.evidenceKind);
  assertOwnerAttestation(evidence.ownerAttestation, evidence, binding);
  assertTimestamps(evidence);
  const common = {
    evidenceFingerprintSha256: fingerprintPayosStagingUatEvidence(evidence),
    evidenceKind: evidence.evidenceKind,
    fullCommerceAccepted: false,
    fullCommerceReasonCodes: PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS.map((id) => UNSUPPORTED_REASONS[id]),
    localScenarioCount: PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS.length,
    providerScenarioCount: PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS.length,
    releaseId: evidence.release.releaseId,
    scenarioCount: PAYOS_STAGING_UAT_SCENARIO_IDS.length,
    unsupportedReasonCodes: PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS.map((id) => UNSUPPORTED_REASONS[id]),
    unsupportedScenarioCount: PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS.length,
    workerVersion: evidence.release.workerVersion,
  };
  if (evidence.evidenceKind === "contract_gap") {
    return {
      ...common,
      accepted: false,
      acceptanceReasonCode: evidence.acceptanceReasonCode,
      error: "payos_uat_contract_gap",
      paymentLaneAccepted: false,
    };
  }
  return { ...common, accepted: true, acceptanceReasonCode: null, paymentLaneAccepted: true };
}

export function assertPayosStagingUatEvidence(evidence, binding) {
  const result = evaluatePayosStagingUatEvidence(evidence, binding);
  if (!result.accepted) throw new Error(`${result.error}:${result.acceptanceReasonCode}`);
  return result;
}
