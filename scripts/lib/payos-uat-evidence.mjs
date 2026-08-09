import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { Buffer } from "node:buffer";

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
    };
  }
  return { ...common, accepted: true, acceptanceReasonCode: null };
}

export function assertPayosStagingUatEvidence(evidence, binding) {
  const result = evaluatePayosStagingUatEvidence(evidence, binding);
  if (!result.accepted) throw new Error(`${result.error}:${result.acceptanceReasonCode}`);
  return result;
}
