import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export const DODO_STAGING_UAT_SCENARIO_IDS = Object.freeze([
  "plan_catalog_offers",
  "pending_provider_ref_fail_closed",
  "starter_checkout",
  "pro_checkout",
  "vn_vnd_checkout",
  "global_usd_checkout",
  "return_url_no_activation",
  "subscription_active_before_payment",
  "payment_succeeded_exactly_once",
  "duplicate_webhook",
  "conflicting_duplicate_event",
  "invalid_signature",
  "stale_timestamp",
  "amount_mismatch",
  "currency_mismatch",
  "provider_reference_mismatch",
  "tenant_metadata_mismatch",
  "initial_payment_failure",
  "suspended_recovery",
  "renewal_success",
  "renewal_failure_grace",
  "grace_expiry",
  "upgrade_immediate",
  "downgrade_scheduled",
  "cancel_lifecycle",
  "resume_flow",
  "checkout_response_loss",
  "concurrent_duplicate_checkout",
  "out_of_order_webhook",
  "invalid_webhook_body",
  "redaction_storage",
  "tenant_isolation",
]);

export const DODO_CONTROLLED_NEGATIVE_SCENARIO_IDS = Object.freeze([
  "conflicting_duplicate_event",
  "stale_timestamp",
  "amount_mismatch",
  "currency_mismatch",
  "provider_reference_mismatch",
  "tenant_metadata_mismatch",
  "invalid_webhook_body",
]);

export const DODO_CONTROLLED_CONCURRENCY_SCENARIO_IDS = Object.freeze([
  "checkout_response_loss",
  "concurrent_duplicate_checkout",
]);

const PROVIDER_CHECKOUT_SCENARIOS = new Set([
  "starter_checkout",
  "pro_checkout",
  "vn_vnd_checkout",
  "global_usd_checkout",
]);
const PROVIDER_WEBHOOK_SCENARIOS = new Set([
  "subscription_active_before_payment",
  "payment_succeeded_exactly_once",
  "duplicate_webhook",
  "initial_payment_failure",
  "suspended_recovery",
  "renewal_success",
  "renewal_failure_grace",
  "upgrade_immediate",
  "downgrade_scheduled",
  "cancel_lifecycle",
  "resume_flow",
  "out_of_order_webhook",
]);
const RUNTIME_PROBE_SCENARIOS = new Set([
  "pending_provider_ref_fail_closed",
  "return_url_no_activation",
  "invalid_signature",
  "redaction_storage",
  "tenant_isolation",
]);

const SCENARIO_SEMANTICS = Object.freeze({
  plan_catalog_offers: ["catalog_verified", "catalog_configured", "catalog_configured", "no_op", null, null],
  pending_provider_ref_fail_closed: ["missing_provider_reference_rejected", "pending_payment", "pending_payment", "no_op", null, null],
  starter_checkout: ["checkout_created", "no_subscription", "starter_pending_payment", "transition", null, null],
  pro_checkout: ["checkout_created", "no_subscription", "pro_pending_payment", "transition", null, null],
  vn_vnd_checkout: ["checkout_created", "no_subscription", "vn_vnd_pending_payment", "transition", null, null],
  global_usd_checkout: ["checkout_created", "no_subscription", "global_usd_pending_payment", "transition", null, null],
  return_url_no_activation: ["return_observed_without_activation", "pending_payment", "pending_payment", "no_op", null, null],
  subscription_active_before_payment: ["premature_activation_ignored", "pending_payment", "pending_payment", "no_op", null, null],
  payment_succeeded_exactly_once: ["payment_applied_exactly_once", "pending_payment", "active", "transition", null, null],
  duplicate_webhook: ["duplicate_replay_ignored", "active", "active", "no_op", "payment_succeeded_exactly_once", "same_event_replay"],
  conflicting_duplicate_event: ["conflicting_replay_rejected", "active", "active", "no_op", "payment_succeeded_exactly_once", "same_event_conflicting_payload"],
  invalid_signature: ["invalid_signature_rejected", "pending_payment", "pending_payment", "no_op", null, null],
  stale_timestamp: ["stale_event_rejected", "active", "active", "no_op", "payment_succeeded_exactly_once", "stale_event"],
  amount_mismatch: ["amount_mismatch_rejected", "pending_payment", "pending_payment", "no_op", null, null],
  currency_mismatch: ["currency_mismatch_rejected", "pending_payment", "pending_payment", "no_op", null, null],
  provider_reference_mismatch: ["provider_reference_mismatch_rejected", "pending_payment", "pending_payment", "no_op", null, null],
  tenant_metadata_mismatch: ["tenant_metadata_mismatch_rejected", "pending_payment", "pending_payment", "no_op", null, null],
  initial_payment_failure: ["initial_payment_failure_applied", "pending_payment", "suspended", "transition", null, null],
  suspended_recovery: ["suspension_recovered", "suspended", "active", "transition", null, null],
  renewal_success: ["renewal_applied", "active_current_period", "active_renewed_period", "transition", null, null],
  renewal_failure_grace: ["renewal_failure_entered_grace", "active", "grace", "transition", null, null],
  grace_expiry: ["grace_expired", "grace", "suspended", "transition", null, null],
  upgrade_immediate: ["upgrade_applied_immediately", "active_starter", "active_pro", "transition", null, null],
  downgrade_scheduled: ["downgrade_scheduled", "active_pro", "active_pro_downgrade_scheduled", "transition", null, null],
  cancel_lifecycle: ["cancellation_scheduled", "active", "cancel_at_period_end", "transition", null, null],
  resume_flow: ["subscription_resumed", "cancel_at_period_end", "active", "transition", null, null],
  checkout_response_loss: ["checkout_recovered_idempotently", "no_subscription", "pending_payment", "transition", null, null],
  concurrent_duplicate_checkout: ["single_checkout_committed", "no_subscription", "pending_payment", "transition", null, null],
  out_of_order_webhook: ["out_of_order_event_ignored", "active_renewed_period", "active_renewed_period", "no_op", "renewal_success", "out_of_order_event"],
  invalid_webhook_body: ["invalid_body_rejected", "pending_payment", "pending_payment", "no_op", null, null],
  redaction_storage: ["sensitive_storage_absent", "runtime_state", "runtime_state", "no_op", null, null],
  tenant_isolation: ["cross_tenant_access_rejected", "tenant_state", "tenant_state", "no_op", null, null],
});

function withScenarioSemantics(scenarioId, contract) {
  const semantics = SCENARIO_SEMANTICS[scenarioId];
  if (semantics === undefined) throw new Error("dodo_uat_scenario_semantics_missing");
  const [outcome, stateBefore, stateAfter, stateEffect, relatedScenarioId, relationship] = semantics;
  return Object.freeze({
    ...contract,
    outcome,
    relatedScenarioId,
    relationship,
    stateAfter,
    stateBefore,
    stateEffect,
  });
}

function scenarioContract(scenarioId) {
  if (scenarioId === "plan_catalog_offers") return withScenarioSemantics(scenarioId, {
    controlledInjection: "none",
    eventSource: "dodo_test_api",
    executionMode: "provider_catalog_observation",
    requiresEventReference: false,
    requiresSessionReference: false,
    signatureAuthority: "none",
    verificationMethod: "provider_api_and_d1",
  });
  if (PROVIDER_CHECKOUT_SCENARIOS.has(scenarioId)) return withScenarioSemantics(scenarioId, {
    controlledInjection: "none",
    eventSource: "dodo_test_api",
    executionMode: "provider_checkout_observation",
    requiresEventReference: false,
    requiresSessionReference: true,
    signatureAuthority: "none",
    verificationMethod: "provider_checkout_and_d1",
  });
  if (PROVIDER_WEBHOOK_SCENARIOS.has(scenarioId)) return withScenarioSemantics(scenarioId, {
    controlledInjection: "none",
    eventSource: "dodo_signed_webhook",
    executionMode: "provider_webhook_observation",
    requiresEventReference: true,
    requiresSessionReference: true,
    signatureAuthority: "dodo",
    verificationMethod: "provider_signed_webhook_and_d1",
  });
  if (DODO_CONTROLLED_NEGATIVE_SCENARIO_IDS.includes(scenarioId)) return withScenarioSemantics(scenarioId, {
    controlledInjection: scenarioId,
    eventSource: "controlled_runner",
    executionMode: "controlled_negative_webhook",
    requiresEventReference: true,
    requiresSessionReference: true,
    signatureAuthority: "controlled_runner",
    verificationMethod: "controlled_signed_webhook_injection",
  });
  if (RUNTIME_PROBE_SCENARIOS.has(scenarioId)) return withScenarioSemantics(scenarioId, {
    controlledInjection: scenarioId,
    eventSource: "none",
    executionMode: "controlled_runtime_probe",
    requiresEventReference: false,
    requiresSessionReference: false,
    signatureAuthority: "none",
    verificationMethod: "staging_runtime_and_d1",
  });
  if (scenarioId === "grace_expiry") return withScenarioSemantics(scenarioId, {
    controlledInjection: scenarioId,
    eventSource: "none",
    executionMode: "controlled_clock_transition",
    requiresEventReference: false,
    requiresSessionReference: true,
    signatureAuthority: "none",
    verificationMethod: "controlled_clock_and_d1",
  });
  if (DODO_CONTROLLED_CONCURRENCY_SCENARIO_IDS.includes(scenarioId)) return withScenarioSemantics(scenarioId, {
    controlledInjection: scenarioId,
    eventSource: "dodo_test_api",
    executionMode: "controlled_checkout_fault",
    requiresEventReference: false,
    requiresSessionReference: true,
    signatureAuthority: "none",
    verificationMethod: scenarioId === "checkout_response_loss" ? "controlled_network_fault" : "controlled_concurrency",
  });
  throw new Error("dodo_uat_scenario_id_invalid");
}

export const DODO_SCENARIO_EXECUTION_CONTRACTS = Object.freeze(Object.fromEntries(
  DODO_STAGING_UAT_SCENARIO_IDS.map((scenarioId) => [scenarioId, scenarioContract(scenarioId)]),
));

const OFFER_CONTRACT = [
  { planCode: "starter", marketCode: "vn", currency: "VND", amountMinor: 99_000, interval: "month" },
  { planCode: "pro", marketCode: "vn", currency: "VND", amountMinor: 299_000, interval: "month" },
  { planCode: "starter", marketCode: "global", currency: "USD", amountMinor: 500, interval: "month" },
  { planCode: "pro", marketCode: "global", currency: "USD", amountMinor: 1_500, interval: "month" },
];

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const RELEASE_ID_PATTERN = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;
const WORKER_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const REFERENCE_PATTERN = /^(?:request|event|session):[A-Za-z0-9._-]{3,128}$/u;
const ATTESTATION_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const SAFE_MANIFEST_PATTERN = /^\.wrangler\/releases\/staging\/stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}\/release-manifest\.json$/u;
const EXECUTION_PROOF_REF_PATTERN = /^artifact:\.wrangler\/releases\/staging\/(stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12})\/dodo-uat-execution-proofs\/([a-z0-9_]+)\.json$/u;
const EVIDENCE_REF_PATTERN = /^\.wrangler\/releases\/staging\/(stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12})\/dodo-uat-evidence\.json$/u;
const PLACEHOLDER_PATTERN = /(?:replace-with|placeholder|change-me|not-provisioned|<[^>]+>)/iu;
const UNSAFE_VALUE_PATTERNS = [
  /https?:\/\//iu,
  /\bBearer(?:\s+|[_-])/iu,
  /whsec_/iu,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
  /(?:^|[:._-])(?:secret|token|api[_-]?key|webhook[_-]?(?:key|secret)|private[_-]?key|card[_-]?number)(?:[:._-]|$)/iu,
];

function exactKeys(value, expected, issue) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(issue);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    if (actual.some((key) => /api[_-]?key|webhook[_-]?(?:key|secret)|raw[_-]?(?:body|payload)|checkout[_-]?url|customer|buyer|token|credential|card/iu.test(key))) {
      throw new Error("dodo_uat_field_unsafe");
    }
    throw new Error(issue);
  }
}

function assertSafeStrings(value) {
  if (typeof value === "string" && UNSAFE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) throw new Error("dodo_uat_value_unsafe");
  if (Array.isArray(value)) value.forEach(assertSafeStrings);
  else if (typeof value === "object" && value !== null) Object.values(value).forEach(assertSafeStrings);
}

function assertSha256(value, issue) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value) || /^0+$/u.test(value)) throw new Error(issue);
}

function assertIsoDate(value, issue) {
  if (typeof value !== "string") throw new Error(issue);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error(issue);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonicalize(nested)]));
}

export function fingerprintDodoStagingUatEvidence(evidence) {
  return createHash("sha256").update(JSON.stringify(canonicalize(evidence))).digest("hex");
}

export function fingerprintDodoUatReference(scope, value) {
  if (typeof scope !== "string" || !/^(?:endpoint|offer:[a-z]+:(?:vn|global))$/u.test(scope)) throw new Error("dodo_uat_fingerprint_scope_invalid");
  if (typeof value !== "string" || value.length < 3 || value.length > 512 || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })) throw new Error("dodo_uat_fingerprint_value_invalid");
  return createHash("sha256").update(`dodo-uat-reference:v1:${scope}:${value}`).digest("hex");
}

export function fingerprintDodoUatExecutionProofPublicKey(publicKeyPem) {
  let publicKey;
  try { publicKey = createPublicKey(publicKeyPem); } catch { throw new Error("dodo_uat_execution_proof_public_key_invalid"); }
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("dodo_uat_execution_proof_public_key_invalid");
  return createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex");
}

function assertApprovedExecutionProofTrust(trust) {
  exactKeys(trust, ["keyId", "spkiSha256"], "dodo_uat_execution_proof_trust_invalid");
  if (!ATTESTATION_KEY_ID_PATTERN.test(trust.keyId ?? "")) throw new Error("dodo_uat_execution_proof_trust_invalid");
  assertSha256(trust.spkiSha256, "dodo_uat_execution_proof_trust_invalid");
}

function canonicalRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) throw new Error("dodo_uat_repository_root_required");
  try { return realpathSync(resolve(repositoryRoot)); } catch { throw new Error("dodo_uat_repository_root_invalid"); }
}

function assertNoSymlinkPath(repositoryRoot, targetPath, issue, { allowMissingLeaf = false } = {}) {
  const root = canonicalRepositoryRoot(repositoryRoot);
  const target = resolve(targetPath);
  const pathRelativeToRoot = relative(root, target);
  if (pathRelativeToRoot === "" || pathRelativeToRoot === ".." || pathRelativeToRoot.startsWith(`..${sep}`) || resolve(root, pathRelativeToRoot) !== target) throw new Error(issue);
  const segments = pathRelativeToRoot.split(sep);
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = resolve(cursor, segments[index]);
    let stat;
    try { stat = lstatSync(cursor); } catch {
      if (allowMissingLeaf && index === segments.length - 1) return target;
      throw new Error(issue);
    }
    if (stat.isSymbolicLink()) throw new Error(issue);
  }
  let realTarget;
  try { realTarget = realpathSync(target); } catch { throw new Error(issue); }
  if (realTarget !== target) throw new Error(issue);
  return target;
}

function readPrivateFile(repositoryRoot, targetPath, issues, expectedMode = 0o600n) {
  const path = assertNoSymlinkPath(repositoryRoot, targetPath, issues.path, { allowMissingLeaf: true });
  let descriptor;
  try {
    const canonicalPath = realpathSync(path);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = fstatSync(descriptor, { bigint: true });
    const pathStat = statSync(path, { bigint: true });
    if (!openedStat.isFile()
      || (openedStat.mode & 0o777n) !== expectedMode
      || openedStat.dev !== pathStat.dev
      || openedStat.ino !== pathStat.ino
      || realpathSync(path) !== canonicalPath) {
      throw new Error(issues.permissions);
    }
    const bytes = readFileSync(descriptor);
    const closedOverStat = fstatSync(descriptor, { bigint: true });
    const finalPathStat = statSync(path, { bigint: true });
    if (openedStat.dev !== closedOverStat.dev
      || openedStat.ino !== closedOverStat.ino
      || openedStat.dev !== finalPathStat.dev
      || openedStat.ino !== finalPathStat.ino
      || openedStat.size !== closedOverStat.size
      || openedStat.mtimeNs !== closedOverStat.mtimeNs
      || openedStat.ctimeNs !== closedOverStat.ctimeNs
      || realpathSync(path) !== canonicalPath) {
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

export function assertCanonicalDodoUatEvidencePath({ evidencePath, releaseId, repositoryRoot }) {
  if (!RELEASE_ID_PATTERN.test(releaseId ?? "")) throw new Error("dodo_uat_evidence_path_invalid");
  const evidenceRef = `.wrangler/releases/staging/${releaseId}/dodo-uat-evidence.json`;
  if (!EVIDENCE_REF_PATTERN.test(evidenceRef)) throw new Error("dodo_uat_evidence_path_invalid");
  const supplied = resolve(evidencePath);
  const logicalExpected = resolve(repositoryRoot, evidenceRef);
  const expected = resolve(canonicalRepositoryRoot(repositoryRoot), evidenceRef);
  if (supplied !== logicalExpected && supplied !== expected) throw new Error("dodo_uat_evidence_path_invalid");
  return assertNoSymlinkPath(repositoryRoot, expected, "dodo_uat_evidence_path_invalid");
}

function assertReleaseShape(release, issue = "dodo_uat_release_invalid") {
  exactKeys(release, ["commitSha", "manifestRef", "manifestSha256", "releaseId", "treeSha", "workerVersion"], issue);
  if (!GIT_SHA_PATTERN.test(release.commitSha ?? "") || /^0+$/u.test(release.commitSha)
    || !GIT_SHA_PATTERN.test(release.treeSha ?? "") || /^0+$/u.test(release.treeSha)
    || !RELEASE_ID_PATTERN.test(release.releaseId ?? "")
    || !SAFE_MANIFEST_PATTERN.test(release.manifestRef ?? "")
    || !release.manifestRef.includes(release.releaseId)
    || !SHA256_PATTERN.test(release.manifestSha256 ?? "") || /^0+$/u.test(release.manifestSha256)
    || !WORKER_VERSION_PATTERN.test(release.workerVersion ?? "")
    || PLACEHOLDER_PATTERN.test(release.workerVersion)) throw new Error(issue);
}

function assertReleaseBinding(release, binding) {
  assertReleaseShape(release);
  if (binding.commitSha !== release.commitSha) throw new Error("dodo_uat_commit_mismatch");
  if (binding.treeSha !== release.treeSha) throw new Error("dodo_uat_tree_mismatch");
  if (binding.releaseId !== release.releaseId) throw new Error("dodo_uat_release_mismatch");
  if (binding.manifestRef !== release.manifestRef || binding.manifestSha256 !== release.manifestSha256) throw new Error("dodo_uat_manifest_mismatch");
  if (binding.workerVersion !== release.workerVersion) throw new Error("dodo_uat_worker_version_mismatch");
}

function assertOffers(offers) {
  if (!Array.isArray(offers) || offers.length !== OFFER_CONTRACT.length) throw new Error("dodo_uat_offer_contract_invalid");
  const fingerprints = new Set();
  offers.forEach((offer, index) => {
    exactKeys(offer, ["amountMinor", "currency", "interval", "marketCode", "planCode", "providerReferenceFingerprintSha256"], "dodo_uat_offer_contract_invalid");
    const expected = OFFER_CONTRACT[index];
    if (expected === undefined || offer.planCode !== expected.planCode || offer.marketCode !== expected.marketCode || offer.currency !== expected.currency || offer.amountMinor !== expected.amountMinor || offer.interval !== expected.interval) throw new Error("dodo_uat_offer_contract_invalid");
    assertSha256(offer.providerReferenceFingerprintSha256, "dodo_uat_offer_fingerprint_invalid");
    if (fingerprints.has(offer.providerReferenceFingerprintSha256)) throw new Error("dodo_uat_offer_fingerprint_duplicate");
    fingerprints.add(offer.providerReferenceFingerprintSha256);
  });
}

export function serializeDodoUatExecutionProofPayload(proof) {
  const attestation = proof?.attestation;
  const unsigned = {
    ...proof,
    attestation: attestation === null || attestation === undefined ? null : {
      algorithm: attestation.algorithm,
      keyId: attestation.keyId,
      signedAt: attestation.signedAt,
    },
  };
  return JSON.stringify(canonicalize(unsigned));
}

function assertProofAttestation(attestation, proof, publicKeys, approvedTrust) {
  assertApprovedExecutionProofTrust(approvedTrust);
  exactKeys(attestation, ["algorithm", "keyId", "signatureBase64", "signedAt"], "dodo_uat_execution_proof_attestation_invalid");
  if (attestation.algorithm !== "ed25519" || !ATTESTATION_KEY_ID_PATTERN.test(attestation.keyId ?? "")) throw new Error("dodo_uat_execution_proof_attestation_invalid");
  assertIsoDate(attestation.signedAt, "dodo_uat_execution_proof_attestation_invalid");
  if (attestation.signedAt !== proof.observedAt || typeof attestation.signatureBase64 !== "string" || !BASE64_PATTERN.test(attestation.signatureBase64)) throw new Error("dodo_uat_execution_proof_attestation_invalid");
  if (attestation.keyId !== approvedTrust.keyId) throw new Error("dodo_uat_execution_proof_attestation_untrusted");
  const pem = publicKeys?.[attestation.keyId];
  if (typeof pem !== "string" || pem.length < 32) throw new Error("dodo_uat_execution_proof_attestation_untrusted");
  let publicKey;
  try { publicKey = createPublicKey(pem); } catch { throw new Error("dodo_uat_execution_proof_attestation_untrusted"); }
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("dodo_uat_execution_proof_attestation_untrusted");
  const spkiSha256 = fingerprintDodoUatExecutionProofPublicKey(pem);
  if (spkiSha256 !== approvedTrust.spkiSha256) throw new Error("dodo_uat_execution_proof_attestation_untrusted");
  let signature;
  try { signature = Buffer.from(attestation.signatureBase64, "base64"); } catch { throw new Error("dodo_uat_execution_proof_attestation_invalid"); }
  if (signature.length !== 64 || !verifySignature(null, Buffer.from(serializeDodoUatExecutionProofPayload(proof)), publicKey, signature)) throw new Error("dodo_uat_execution_proof_attestation_invalid");
  return spkiSha256;
}

function assertReference(value, required) {
  if (value === null && !required) return;
  if (typeof value !== "string" || !REFERENCE_PATTERN.test(value)) throw new Error("dodo_uat_execution_proof_reference_invalid");
}

function assertExecutionProof(proof, input) {
  exactKeys(proof, ["artifactKind", "attestation", "authority", "environment", "executionMode", "fingerprints", "observedAt", "outcome", "provider", "providerEnvironment", "redaction", "references", "relatedScenario", "release", "result", "scenarioId", "schemaVersion", "state", "verificationMethod"], "dodo_uat_execution_proof_invalid");
  if (proof.schemaVersion !== 2 || proof.artifactKind !== "dodo_uat_execution_proof" || proof.provider !== "dodo" || proof.environment !== "staging" || proof.providerEnvironment !== "test_mode") throw new Error("dodo_uat_execution_proof_invalid");
  if (proof.scenarioId !== input.scenarioId || proof.result !== "passed") throw new Error(proof.result === "passed" ? "dodo_uat_execution_proof_scenario_invalid" : "dodo_uat_execution_proof_not_passed");
  assertIsoDate(proof.observedAt, "dodo_uat_execution_proof_timestamp_invalid");
  assertReleaseShape(proof.release, "dodo_uat_execution_proof_binding_invalid");
  if (JSON.stringify(proof.release) !== JSON.stringify(input.release)) throw new Error("dodo_uat_execution_proof_binding_invalid");
  const contract = DODO_SCENARIO_EXECUTION_CONTRACTS[input.scenarioId];
  if (contract === undefined || proof.executionMode !== contract.executionMode || proof.verificationMethod !== contract.verificationMethod) throw new Error("dodo_uat_execution_proof_contract_invalid");
  if (proof.outcome !== contract.outcome) throw new Error("dodo_uat_execution_proof_outcome_invalid");
  exactKeys(proof.state, ["after", "before", "effect"], "dodo_uat_execution_proof_state_invalid");
  if (proof.state.before !== contract.stateBefore || proof.state.after !== contract.stateAfter || proof.state.effect !== contract.stateEffect) throw new Error("dodo_uat_execution_proof_state_invalid");
  if (contract.relatedScenarioId === null) {
    if (proof.relatedScenario !== null) throw new Error("dodo_uat_execution_proof_relationship_invalid");
  } else {
    exactKeys(proof.relatedScenario, ["relationship", "scenarioId"], "dodo_uat_execution_proof_relationship_invalid");
    if (proof.relatedScenario.scenarioId !== contract.relatedScenarioId || proof.relatedScenario.relationship !== contract.relationship) throw new Error("dodo_uat_execution_proof_relationship_invalid");
  }

  exactKeys(proof.authority, ["controlledInjection", "eventSource", "runnerId", "signatureAuthority"], "dodo_uat_execution_proof_authority_invalid");
  if (typeof proof.authority.runnerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(proof.authority.runnerId)
    || proof.authority.controlledInjection !== contract.controlledInjection
    || proof.authority.eventSource !== contract.eventSource
    || proof.authority.signatureAuthority !== contract.signatureAuthority) throw new Error("dodo_uat_execution_proof_authority_invalid");

  exactKeys(proof.references, ["eventReference", "requestReference", "sessionReference"], "dodo_uat_execution_proof_reference_invalid");
  assertReference(proof.references.requestReference, true);
  assertReference(proof.references.eventReference, contract.requiresEventReference);
  assertReference(proof.references.sessionReference, contract.requiresSessionReference);

  exactKeys(proof.fingerprints, ["d1AfterSha256", "d1BeforeSha256", "d1TransitionSha256", "executionTranscriptSha256", "providerEventSha256", "providerSignatureSha256"], "dodo_uat_execution_proof_fingerprints_invalid");
  assertSha256(proof.fingerprints.executionTranscriptSha256, "dodo_uat_execution_proof_transcript_required");
  assertSha256(proof.fingerprints.d1BeforeSha256, "dodo_uat_execution_proof_d1_before_required");
  assertSha256(proof.fingerprints.d1AfterSha256, "dodo_uat_execution_proof_d1_after_required");
  assertSha256(proof.fingerprints.d1TransitionSha256, "dodo_uat_execution_proof_d1_transition_required");
  if (contract.stateEffect === "no_op" && proof.fingerprints.d1BeforeSha256 !== proof.fingerprints.d1AfterSha256) throw new Error("dodo_uat_execution_proof_no_op_invalid");
  if (contract.stateEffect === "transition" && proof.fingerprints.d1BeforeSha256 === proof.fingerprints.d1AfterSha256) throw new Error("dodo_uat_execution_proof_transition_invalid");
  if (contract.signatureAuthority === "none") {
    if (proof.fingerprints.providerEventSha256 !== null || proof.fingerprints.providerSignatureSha256 !== null) throw new Error("dodo_uat_execution_proof_provider_evidence_unexpected");
  } else {
    assertSha256(proof.fingerprints.providerEventSha256, "dodo_uat_execution_proof_provider_event_required");
    assertSha256(proof.fingerprints.providerSignatureSha256, "dodo_uat_execution_proof_provider_signature_required");
  }

  exactKeys(proof.redaction, ["noCustomerData", "noPaymentInstrumentData", "noRawPayload", "noSensitiveValues"], "dodo_uat_execution_proof_redaction_invalid");
  if (Object.values(proof.redaction).some((value) => value !== true)) throw new Error("dodo_uat_execution_proof_redaction_invalid");
  assertSafeStrings({ ...proof, attestation: { ...proof.attestation, signatureBase64: "redacted" } });
  const attestationSpkiSha256 = assertProofAttestation(proof.attestation, proof, input.executionProofPublicKeys, input.approvedExecutionProofTrust);
  return {
    artifactSha256: input.artifactSha256,
    artifactRef: input.artifactRef,
    attestationKeyId: proof.attestation.keyId,
    attestationSpkiSha256,
    d1AfterSha256: proof.fingerprints.d1AfterSha256,
    d1BeforeSha256: proof.fingerprints.d1BeforeSha256,
    eventReference: proof.references.eventReference,
    executionMode: proof.executionMode,
    executionTranscriptSha256: proof.fingerprints.executionTranscriptSha256,
    d1TransitionSha256: proof.fingerprints.d1TransitionSha256,
    observedAt: proof.observedAt,
    outcome: proof.outcome,
    providerEventSha256: proof.fingerprints.providerEventSha256,
    providerSignatureSha256: proof.fingerprints.providerSignatureSha256,
    relatedScenario: proof.relatedScenario,
    requestReference: proof.references.requestReference,
    sessionReference: proof.references.sessionReference,
    state: proof.state,
    verificationMethod: proof.verificationMethod,
  };
}

function proofPath(root, releaseId, scenarioId) {
  return resolve(canonicalRepositoryRoot(root), `.wrangler/releases/staging/${releaseId}/dodo-uat-execution-proofs/${scenarioId}.json`);
}

function assertScenarioRelationships(verified) {
  const eventUses = new Map();
  for (const [scenarioId, proof] of Object.entries(verified)) {
    if (proof.eventReference !== null) {
      const uses = eventUses.get(proof.eventReference) ?? [];
      uses.push(scenarioId);
      eventUses.set(proof.eventReference, uses);
    }
    if (proof.relatedScenario === null) continue;
    const related = verified[proof.relatedScenario.scenarioId];
    if (related === undefined || proof.sessionReference === null || proof.sessionReference !== related.sessionReference) throw new Error("dodo_uat_execution_proof_relationship_invalid");
    if (new Date(proof.observedAt).getTime() <= new Date(related.observedAt).getTime()) throw new Error("dodo_uat_execution_proof_relationship_order_invalid");
    if (proof.d1BeforeSha256 !== related.d1AfterSha256 || proof.d1BeforeSha256 !== proof.d1AfterSha256) throw new Error("dodo_uat_execution_proof_relationship_state_invalid");
    if (proof.relatedScenario.relationship === "same_event_replay") {
      if (proof.eventReference !== related.eventReference
        || proof.providerEventSha256 !== related.providerEventSha256
        || proof.providerSignatureSha256 !== related.providerSignatureSha256) throw new Error("dodo_uat_execution_proof_replay_relationship_invalid");
    } else if (proof.relatedScenario.relationship === "same_event_conflicting_payload") {
      if (proof.eventReference !== related.eventReference
        || proof.providerEventSha256 === related.providerEventSha256) throw new Error("dodo_uat_execution_proof_conflict_relationship_invalid");
    } else if (proof.relatedScenario.relationship === "stale_event" || proof.relatedScenario.relationship === "out_of_order_event") {
      if (proof.eventReference === related.eventReference) throw new Error("dodo_uat_execution_proof_order_relationship_invalid");
    } else {
      throw new Error("dodo_uat_execution_proof_relationship_invalid");
    }
  }
  for (const scenarioIds of eventUses.values()) {
    if (scenarioIds.length === 1) continue;
    const expectedReplaySet = ["conflicting_duplicate_event", "duplicate_webhook", "payment_succeeded_exactly_once"];
    if (JSON.stringify([...scenarioIds].sort()) !== JSON.stringify(expectedReplaySet)) throw new Error("dodo_uat_execution_proof_reference_duplicate");
  }
}

function readExecutionProofSet(input) {
  assertApprovedExecutionProofTrust(input.approvedExecutionProofTrust);
  exactKeys(input.proofArtifacts, DODO_STAGING_UAT_SCENARIO_IDS, "dodo_uat_execution_proof_set_invalid");
  const verified = {};
  const artifactRefs = new Set();
  const artifactHashes = new Set();
  const requestRefs = new Set();
  const transcriptHashes = new Set();
  const transitionHashes = new Set();
  for (const scenarioId of DODO_STAGING_UAT_SCENARIO_IDS) {
    const descriptor = input.proofArtifacts[scenarioId];
    exactKeys(descriptor, ["artifactRef", "artifactSha256"], "dodo_uat_execution_proof_descriptor_invalid");
    const match = typeof descriptor.artifactRef === "string" ? EXECUTION_PROOF_REF_PATTERN.exec(descriptor.artifactRef) : null;
    if (match === null || match[1] !== input.release.releaseId || match[2] !== scenarioId) throw new Error("dodo_uat_execution_proof_reference_invalid");
    assertSha256(descriptor.artifactSha256, "dodo_uat_execution_proof_hash_invalid");
    if (artifactRefs.has(descriptor.artifactRef)) throw new Error("dodo_uat_execution_proof_reference_duplicate");
    if (artifactHashes.has(descriptor.artifactSha256)) throw new Error("dodo_uat_execution_proof_hash_duplicate");
    artifactRefs.add(descriptor.artifactRef);
    artifactHashes.add(descriptor.artifactSha256);
    const path = proofPath(input.repositoryRoot, input.release.releaseId, scenarioId);
    let bytes;
    let proof;
    try {
      bytes = readPrivateFile(input.repositoryRoot, path, {
        invalid: "dodo_uat_execution_proof_invalid",
        missing: "dodo_uat_execution_proof_missing",
        path: "dodo_uat_execution_proof_path_invalid",
        permissions: "dodo_uat_execution_proof_permissions_invalid",
      });
      proof = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("dodo_uat_execution_proof_")) throw error;
      throw new Error("dodo_uat_execution_proof_invalid", { cause: error });
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== descriptor.artifactSha256) throw new Error("dodo_uat_execution_proof_hash_mismatch");
    const result = assertExecutionProof(proof, {
      artifactRef: descriptor.artifactRef,
      artifactSha256: digest,
      approvedExecutionProofTrust: input.approvedExecutionProofTrust,
      executionProofPublicKeys: input.executionProofPublicKeys,
      release: input.release,
      scenarioId,
    });
    if (requestRefs.has(result.requestReference)) throw new Error("dodo_uat_execution_proof_reference_duplicate");
    if (transcriptHashes.has(result.executionTranscriptSha256)) throw new Error("dodo_uat_execution_proof_transcript_duplicate");
    if (transitionHashes.has(result.d1TransitionSha256)) throw new Error("dodo_uat_execution_proof_transition_duplicate");
    requestRefs.add(result.requestReference);
    transcriptHashes.add(result.executionTranscriptSha256);
    transitionHashes.add(result.d1TransitionSha256);
    verified[scenarioId] = result;
  }
  assertScenarioRelationships(verified);
  return verified;
}

function derivedRedactionEvidence(verifiedProofs) {
  const proofHashes = DODO_STAGING_UAT_SCENARIO_IDS.map((scenarioId) => verifiedProofs[scenarioId].artifactSha256);
  return {
    auditNoSensitiveValues: true,
    d1NoHostedCheckoutUrl: true,
    d1NoRawPayload: true,
    d1NoSecretValues: true,
    logsNoSensitiveValues: true,
    queuesNoSensitiveValues: true,
    evidenceFingerprintSha256: createHash("sha256").update(`dodo-uat-redaction:v3:${proofHashes.join(":")}`).digest("hex"),
  };
}

function scenarioRecordFromProof(proof) {
  return {
    status: "passed",
    outcome: proof.outcome,
    state: proof.state,
    relatedScenario: proof.relatedScenario,
    observedAt: proof.observedAt,
    evidenceFingerprintSha256: proof.artifactSha256,
    proofReference: proof.artifactRef,
    requestReference: proof.requestReference,
    eventReference: proof.eventReference,
    sessionReference: proof.sessionReference,
    executionMode: proof.executionMode,
    verificationMethod: proof.verificationMethod,
    attestationKeyId: proof.attestationKeyId,
  };
}

export async function collectDodoStagingUatEvidence(input) {
  exactKeys(input, ["approvedExecutionProofTrust", "completedAt", "createdAt", "endpointFingerprintSha256", "executionProofPublicKeys", "offers", "proofArtifacts", "release", "repositoryRoot"], "dodo_uat_collection_input_invalid");
  if (typeof input.repositoryRoot !== "string" || input.repositoryRoot.length === 0) throw new Error("dodo_uat_repository_root_required");
  assertApprovedExecutionProofTrust(input.approvedExecutionProofTrust);
  assertReleaseShape(input.release, "dodo_uat_collection_release_invalid");
  assertSha256(input.endpointFingerprintSha256, "dodo_uat_endpoint_fingerprint_invalid");
  assertOffers(input.offers);
  assertIsoDate(input.createdAt, "dodo_uat_created_at_invalid");
  assertIsoDate(input.completedAt, "dodo_uat_completed_at_invalid");
  const verifiedExecutionProofs = readExecutionProofSet(input);
  const scenarios = Object.fromEntries(DODO_STAGING_UAT_SCENARIO_IDS.map((scenarioId) => [scenarioId, scenarioRecordFromProof(verifiedExecutionProofs[scenarioId])]));
  const evidence = {
    schemaVersion: 3,
    evidenceKind: "provider_acceptance",
    environment: "staging",
    provider: "dodo",
    providerEnvironment: "test_mode",
    scenarioPolicyVersion: "dodo_uat_v3",
    release: input.release,
    executionProofTrustFingerprintSha256: input.approvedExecutionProofTrust.spkiSha256,
    endpointFingerprintSha256: input.endpointFingerprintSha256,
    offers: input.offers,
    scenarios,
    redaction: derivedRedactionEvidence(verifiedExecutionProofs),
    createdAt: input.createdAt,
    completedAt: input.completedAt,
  };
  assertDodoStagingUatEvidence(evidence, { ...input.release, approvedExecutionProofTrust: input.approvedExecutionProofTrust, verifiedExecutionProofs });
  const evidenceRef = `.wrangler/releases/staging/${input.release.releaseId}/dodo-uat-evidence.json`;
  const evidencePath = resolve(canonicalRepositoryRoot(input.repositoryRoot), evidenceRef);
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await mkdir(dirname(evidencePath), { mode: 0o700, recursive: true });
  assertNoSymlinkPath(input.repositoryRoot, dirname(evidencePath), "dodo_uat_evidence_path_invalid");
  try {
    await writeFile(evidencePath, evidenceBytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw new Error("dodo_uat_evidence_write_failed", { cause: error });
    assertCanonicalDodoUatEvidencePath({ evidencePath, releaseId: input.release.releaseId, repositoryRoot: input.repositoryRoot });
    const existing = readPrivateFile(input.repositoryRoot, evidencePath, {
      invalid: "dodo_uat_evidence_read_failed",
      missing: "dodo_uat_evidence_read_failed",
      path: "dodo_uat_evidence_path_invalid",
      permissions: "dodo_uat_evidence_read_failed",
    });
    if (!existing.equals(evidenceBytes)) throw new Error("dodo_uat_evidence_conflict", { cause: error });
  }
  await chmod(evidencePath, 0o600);
  assertCanonicalDodoUatEvidencePath({ evidencePath, releaseId: input.release.releaseId, repositoryRoot: input.repositoryRoot });
  return {
    artifactSha256: createHash("sha256").update(evidenceBytes).digest("hex"),
    evidence,
    evidencePath,
    evidenceRef,
    verifiedExecutionProofs,
  };
}

export function readDodoUatExecutionProofArtifacts({ approvedExecutionProofTrust, evidence, executionProofPublicKeys, repositoryRoot }) {
  assertReleaseShape(evidence?.release);
  assertApprovedExecutionProofTrust(approvedExecutionProofTrust);
  if (evidence?.executionProofTrustFingerprintSha256 !== approvedExecutionProofTrust.spkiSha256) throw new Error("dodo_uat_execution_proof_trust_mismatch");
  const proofArtifacts = Object.fromEntries(DODO_STAGING_UAT_SCENARIO_IDS.map((scenarioId) => {
    const record = evidence?.scenarios?.[scenarioId];
    return [scenarioId, {
      artifactRef: record?.proofReference,
      artifactSha256: record?.evidenceFingerprintSha256,
    }];
  }));
  return readExecutionProofSet({ approvedExecutionProofTrust, executionProofPublicKeys, proofArtifacts, release: evidence.release, repositoryRoot });
}

export const readDodoUatScenarioArtifacts = readDodoUatExecutionProofArtifacts;

function assertRedaction(redaction, verifiedProofs) {
  exactKeys(redaction, ["auditNoSensitiveValues", "d1NoHostedCheckoutUrl", "d1NoRawPayload", "d1NoSecretValues", "evidenceFingerprintSha256", "logsNoSensitiveValues", "queuesNoSensitiveValues"], "dodo_uat_redaction_invalid");
  if (Object.entries(redaction).some(([key, value]) => key !== "evidenceFingerprintSha256" && value !== true)) throw new Error("dodo_uat_redaction_incomplete");
  const expected = derivedRedactionEvidence(verifiedProofs);
  if (redaction.evidenceFingerprintSha256 !== expected.evidenceFingerprintSha256) throw new Error("dodo_uat_redaction_fingerprint_invalid");
}

function assertScenarioSet(evidence, verifiedProofs, approvedTrust) {
  exactKeys(evidence.scenarios, DODO_STAGING_UAT_SCENARIO_IDS, "dodo_uat_scenario_set_invalid");
  const artifactHashes = new Set();
  for (const scenarioId of DODO_STAGING_UAT_SCENARIO_IDS) {
    const record = evidence.scenarios[scenarioId];
    exactKeys(record, ["attestationKeyId", "eventReference", "evidenceFingerprintSha256", "executionMode", "observedAt", "outcome", "proofReference", "relatedScenario", "requestReference", "sessionReference", "state", "status", "verificationMethod"], "dodo_uat_scenario_record_invalid");
    const proof = verifiedProofs?.[scenarioId];
    if (proof === undefined) throw new Error("dodo_uat_execution_proof_unverified");
    if (proof.attestationKeyId !== approvedTrust.keyId || proof.attestationSpkiSha256 !== approvedTrust.spkiSha256) throw new Error("dodo_uat_execution_proof_trust_mismatch");
    const expected = scenarioRecordFromProof(proof);
    if (JSON.stringify(record) !== JSON.stringify(expected)) throw new Error("dodo_uat_execution_proof_binding_mismatch");
    if (artifactHashes.has(record.evidenceFingerprintSha256)) throw new Error("dodo_uat_scenario_fingerprint_duplicate");
    artifactHashes.add(record.evidenceFingerprintSha256);
  }
}

export function assertDodoStagingUatEvidence(evidence, binding) {
  exactKeys(evidence, ["completedAt", "createdAt", "endpointFingerprintSha256", "environment", "evidenceKind", "executionProofTrustFingerprintSha256", "offers", "provider", "providerEnvironment", "redaction", "release", "scenarioPolicyVersion", "scenarios", "schemaVersion"], "dodo_uat_evidence_invalid");
  if (evidence.schemaVersion !== 3 || evidence.evidenceKind !== "provider_acceptance" || evidence.environment !== "staging" || evidence.provider !== "dodo" || evidence.providerEnvironment !== "test_mode" || evidence.scenarioPolicyVersion !== "dodo_uat_v3") throw new Error("dodo_uat_evidence_invalid");
  assertApprovedExecutionProofTrust(binding?.approvedExecutionProofTrust);
  if (evidence.executionProofTrustFingerprintSha256 !== binding.approvedExecutionProofTrust.spkiSha256) throw new Error("dodo_uat_execution_proof_trust_mismatch");
  assertReleaseBinding(evidence.release, binding);
  assertSha256(evidence.endpointFingerprintSha256, "dodo_uat_endpoint_fingerprint_invalid");
  assertOffers(evidence.offers);
  assertScenarioSet(evidence, binding?.verifiedExecutionProofs, binding.approvedExecutionProofTrust);
  assertRedaction(evidence.redaction, binding?.verifiedExecutionProofs);
  assertIsoDate(evidence.createdAt, "dodo_uat_created_at_invalid");
  assertIsoDate(evidence.completedAt, "dodo_uat_completed_at_invalid");
  const createdAt = new Date(evidence.createdAt).getTime();
  const completedAt = new Date(evidence.completedAt).getTime();
  if (completedAt < createdAt || DODO_STAGING_UAT_SCENARIO_IDS.some((scenarioId) => {
    const observedAt = new Date(evidence.scenarios[scenarioId].observedAt).getTime();
    return observedAt < createdAt || observedAt > completedAt;
  })) throw new Error("dodo_uat_time_order_invalid");
  assertSafeStrings(evidence);
  return {
    accepted: true,
    evidenceFingerprintSha256: fingerprintDodoStagingUatEvidence(evidence),
    releaseId: evidence.release.releaseId,
    scenarioCount: DODO_STAGING_UAT_SCENARIO_IDS.length,
    workerVersion: evidence.release.workerVersion,
  };
}
