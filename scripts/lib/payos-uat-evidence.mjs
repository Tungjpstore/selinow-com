import { createHash } from "node:crypto";

export const PAYOS_STAGING_UAT_SCENARIO_IDS = Object.freeze([
  "signed_exact_payment",
  "invalid_signature",
  "duplicate_replay",
  "conflicting_replay",
  "partial_payment",
  "overpayment",
  "late_payment",
  "amount_mismatch",
  "currency_mismatch",
  "tenant_isolation",
  "signed_refund",
  "signed_chargeback",
  "direct_reconciliation",
  "fulfillment_exactly_once",
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const RELEASE_ID = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;
const WORKER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const REF = /^(?:request|event|session):[A-Za-z0-9._-]{3,128}$|^artifact:[A-Za-z0-9._/-]{3,240}$/u;
const UNSAFE = [/https?:\/\//iu, /Bearer(?:\s+|[_-])/iu, /whsec_/iu, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu, /(?:secret|token|api[_-]?key|raw[_-]?(?:body|payload)|checkout[_-]?url|customer|buyer|credential)/iu];

function keys(value, expected, issue) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(issue);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(issue);
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

export function assertPayosStagingUatEvidence(evidence, binding) {
  keys(evidence, ["channel", "completedAt", "createdAt", "environment", "provider", "providerEnvironment", "redaction", "release", "scenarios", "schemaVersion"], "payos_uat_evidence_invalid");
  if (evidence.schemaVersion !== 1 || evidence.environment !== "staging" || evidence.provider !== "payos" || evidence.providerEnvironment !== "test_mode" || evidence.channel !== "seller_payment") throw new Error("payos_uat_evidence_invalid");
  assertRelease(evidence.release, binding);
  keys(evidence.redaction, ["auditNoSensitiveValues", "d1NoRawPayload", "d1NoSecretValues", "logsNoSensitiveValues", "queuesNoSensitiveValues", "evidenceFingerprintSha256"], "payos_uat_redaction_invalid");
  for (const [key, value] of Object.entries(evidence.redaction)) if (key !== "evidenceFingerprintSha256" && value !== true) throw new Error("payos_uat_redaction_incomplete");
  sha(evidence.redaction.evidenceFingerprintSha256, "payos_uat_redaction_fingerprint_invalid");
  keys(evidence.scenarios, PAYOS_STAGING_UAT_SCENARIO_IDS, "payos_uat_scenario_set_invalid");
  const fingerprints = [];
  for (const id of PAYOS_STAGING_UAT_SCENARIO_IDS) {
    const record = evidence.scenarios[id];
    keys(record, ["evidenceFingerprintSha256", "eventReference", "observedAt", "requestReference", "status"], "payos_uat_scenario_record_invalid");
    safe(record);
    if (record.status !== "passed") throw new Error("payos_uat_scenario_not_passed");
    iso(record.observedAt, "payos_uat_scenario_timestamp_invalid");
    sha(record.evidenceFingerprintSha256, "payos_uat_scenario_fingerprint_invalid");
    if (binding?.requireArtifactProof === true && binding.scenarioArtifactFingerprints?.[id] !== record.evidenceFingerprintSha256) throw new Error("payos_uat_scenario_artifact_unverified");
    if (![record.requestReference, record.eventReference].some((ref) => typeof ref === "string" && REF.test(ref))) throw new Error("payos_uat_scenario_reference_invalid");
    fingerprints.push(record.evidenceFingerprintSha256);
  }
  if (new Set(fingerprints).size !== fingerprints.length) throw new Error("payos_uat_scenario_fingerprint_duplicate");
  iso(evidence.createdAt, "payos_uat_created_at_invalid");
  iso(evidence.completedAt, "payos_uat_completed_at_invalid");
  const created = new Date(evidence.createdAt).getTime();
  const completed = new Date(evidence.completedAt).getTime();
  if (completed < created || PAYOS_STAGING_UAT_SCENARIO_IDS.some((id) => {
    const observed = new Date(evidence.scenarios[id].observedAt).getTime();
    return observed < created || observed > completed;
  })) throw new Error("payos_uat_time_order_invalid");
  safe(evidence);
  return { accepted: true, evidenceFingerprintSha256: fingerprintPayosStagingUatEvidence(evidence), releaseId: evidence.release.releaseId, scenarioCount: PAYOS_STAGING_UAT_SCENARIO_IDS.length, workerVersion: evidence.release.workerVersion };
}
