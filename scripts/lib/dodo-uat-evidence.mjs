import { createHash } from "node:crypto";

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
const SAFE_REFERENCE_PATTERN = /^(?:request|event|session|artifact):[A-Za-z0-9._-]{3,128}$/u;
const SAFE_MANIFEST_PATTERN = /^\.wrangler\/releases\/staging\/stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}\/release-manifest\.json$/u;
const PLACEHOLDER_PATTERN = /(?:replace-with|placeholder|change-me|not-provisioned|<[^>]+>)/iu;
const UNSAFE_VALUE_PATTERNS = [
  /https?:\/\//iu,
  /\bBearer(?:\s+|[_-])/iu,
  /whsec_/iu,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
  /(?:^|[:._-])(?:secret|token|api[_-]?key|webhook[_-]?(?:key|secret)|private[_-]?key)(?:[:._-]|$)/iu,
];

function exactKeys(value, expected, issue) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(issue);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    if (actual.some((key) => /api[_-]?key|webhook[_-]?(?:key|secret)|raw[_-]?(?:body|payload)|checkout[_-]?url|customer|buyer|token|credential/iu.test(key))) {
      throw new Error("dodo_uat_field_unsafe");
    }
    throw new Error(issue);
  }
}

function assertSafeStrings(value) {
  if (typeof value === "string" && UNSAFE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error("dodo_uat_value_unsafe");
  }
  if (Array.isArray(value)) {
    value.forEach(assertSafeStrings);
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(assertSafeStrings);
  }
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

function assertRelease(evidence, binding) {
  exactKeys(evidence.release, ["commitSha", "manifestRef", "manifestSha256", "releaseId", "treeSha", "workerVersion"], "dodo_uat_release_invalid");
  if (!GIT_SHA_PATTERN.test(evidence.release.commitSha) || /^0+$/u.test(evidence.release.commitSha)) throw new Error("dodo_uat_commit_invalid");
  if (!GIT_SHA_PATTERN.test(evidence.release.treeSha) || /^0+$/u.test(evidence.release.treeSha)) throw new Error("dodo_uat_tree_invalid");
  if (!RELEASE_ID_PATTERN.test(evidence.release.releaseId)) throw new Error("dodo_uat_release_id_invalid");
  if (!SAFE_MANIFEST_PATTERN.test(evidence.release.manifestRef)) throw new Error("dodo_uat_manifest_ref_invalid");
  if (!evidence.release.manifestRef.includes(evidence.release.releaseId)) throw new Error("dodo_uat_manifest_ref_invalid");
  assertSha256(evidence.release.manifestSha256, "dodo_uat_manifest_hash_invalid");
  if (!WORKER_VERSION_PATTERN.test(evidence.release.workerVersion) || PLACEHOLDER_PATTERN.test(evidence.release.workerVersion)) throw new Error("dodo_uat_worker_version_invalid");
  if (binding.commitSha !== evidence.release.commitSha) throw new Error("dodo_uat_commit_mismatch");
  if (binding.treeSha !== evidence.release.treeSha) throw new Error("dodo_uat_tree_mismatch");
  if (binding.releaseId !== evidence.release.releaseId) throw new Error("dodo_uat_release_mismatch");
  if (binding.manifestRef !== evidence.release.manifestRef || binding.manifestSha256 !== evidence.release.manifestSha256) throw new Error("dodo_uat_manifest_mismatch");
  if (binding.workerVersion !== evidence.release.workerVersion) throw new Error("dodo_uat_worker_version_mismatch");
}

function assertOffers(offers) {
  if (!Array.isArray(offers) || offers.length !== OFFER_CONTRACT.length) throw new Error("dodo_uat_offer_contract_invalid");
  const fingerprints = new Set();
  offers.forEach((offer, index) => {
    exactKeys(offer, ["amountMinor", "currency", "interval", "marketCode", "planCode", "providerReferenceFingerprintSha256"], "dodo_uat_offer_contract_invalid");
    const expected = OFFER_CONTRACT[index];
    if (expected === undefined || offer.planCode !== expected.planCode || offer.marketCode !== expected.marketCode || offer.currency !== expected.currency || offer.amountMinor !== expected.amountMinor || offer.interval !== expected.interval) {
      throw new Error("dodo_uat_offer_contract_invalid");
    }
    assertSha256(offer.providerReferenceFingerprintSha256, "dodo_uat_offer_fingerprint_invalid");
    if (fingerprints.has(offer.providerReferenceFingerprintSha256)) throw new Error("dodo_uat_offer_fingerprint_duplicate");
    fingerprints.add(offer.providerReferenceFingerprintSha256);
  });
}

function assertScenarioRecord(record) {
  exactKeys(record, ["evidenceFingerprintSha256", "eventReference", "observedAt", "requestReference", "sessionReference", "status"], "dodo_uat_scenario_record_invalid");
  assertSafeStrings(record);
  if (record.status !== "passed") throw new Error("dodo_uat_scenario_not_passed");
  assertIsoDate(record.observedAt, "dodo_uat_scenario_timestamp_invalid");
  assertSha256(record.evidenceFingerprintSha256, "dodo_uat_scenario_fingerprint_invalid");
  const references = [record.requestReference, record.eventReference, record.sessionReference].filter((reference) => reference !== null);
  if (references.length === 0 || references.some((reference) => typeof reference !== "string" || !SAFE_REFERENCE_PATTERN.test(reference))) throw new Error("dodo_uat_scenario_reference_invalid");
}

function assertScenarios(scenarios) {
  exactKeys(scenarios, DODO_STAGING_UAT_SCENARIO_IDS, "dodo_uat_scenario_set_invalid");
  DODO_STAGING_UAT_SCENARIO_IDS.forEach((scenarioId) => assertScenarioRecord(scenarios[scenarioId]));
  const fingerprints = DODO_STAGING_UAT_SCENARIO_IDS.map((scenarioId) => scenarios[scenarioId].evidenceFingerprintSha256);
  if (new Set(fingerprints).size !== fingerprints.length) throw new Error("dodo_uat_scenario_fingerprint_duplicate");
}

function assertRedaction(redaction) {
  exactKeys(redaction, ["auditNoSensitiveValues", "d1NoHostedCheckoutUrl", "d1NoRawPayload", "d1NoSecretValues", "evidenceFingerprintSha256", "logsNoSensitiveValues", "queuesNoSensitiveValues"], "dodo_uat_redaction_invalid");
  if (Object.entries(redaction).some(([key, value]) => key !== "evidenceFingerprintSha256" && value !== true)) throw new Error("dodo_uat_redaction_incomplete");
  assertSha256(redaction.evidenceFingerprintSha256, "dodo_uat_redaction_fingerprint_invalid");
}

export function assertDodoStagingUatEvidence(evidence, binding) {
  exactKeys(evidence, ["completedAt", "createdAt", "endpointFingerprintSha256", "environment", "offers", "provider", "providerEnvironment", "redaction", "release", "scenarios", "schemaVersion"], "dodo_uat_evidence_invalid");
  if (evidence.schemaVersion !== 1 || evidence.environment !== "staging" || evidence.provider !== "dodo") throw new Error("dodo_uat_evidence_invalid");
  if (evidence.providerEnvironment !== "test_mode") throw new Error("dodo_uat_provider_environment_invalid");
  assertSha256(evidence.endpointFingerprintSha256, "dodo_uat_endpoint_fingerprint_invalid");
  assertRelease(evidence, binding);
  assertOffers(evidence.offers);
  assertScenarios(evidence.scenarios);
  assertRedaction(evidence.redaction);
  assertIsoDate(evidence.createdAt, "dodo_uat_created_at_invalid");
  assertIsoDate(evidence.completedAt, "dodo_uat_completed_at_invalid");
  const createdAt = new Date(evidence.createdAt).getTime();
  const completedAt = new Date(evidence.completedAt).getTime();
  if (completedAt < createdAt) throw new Error("dodo_uat_time_order_invalid");
  if (DODO_STAGING_UAT_SCENARIO_IDS.some((scenarioId) => {
    const observedAt = new Date(evidence.scenarios[scenarioId].observedAt).getTime();
    return observedAt < createdAt || observedAt > completedAt;
  })) throw new Error("dodo_uat_scenario_timestamp_outside_window");
  assertSafeStrings(evidence);
  return {
    accepted: true,
    evidenceFingerprintSha256: fingerprintDodoStagingUatEvidence(evidence),
    releaseId: evidence.release.releaseId,
    scenarioCount: DODO_STAGING_UAT_SCENARIO_IDS.length,
    workerVersion: evidence.release.workerVersion,
  };
}
