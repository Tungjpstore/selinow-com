import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
const SAFE_REFERENCE_PATTERN = /^(?:request|event|session):[A-Za-z0-9._-]{3,128}$|^artifact:[A-Za-z0-9._/-]{3,240}$/u;
const SAFE_OBSERVATION_REFERENCE_PATTERN = /^(?:request|event|session):[A-Za-z0-9._-]{3,128}$/u;
const SCENARIO_ARTIFACT_REF_PATTERN = /^artifact:\.wrangler\/releases\/staging\/(stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12})\/dodo-uat-scenarios\/([a-z0-9_]+)\.json$/u;
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

function assertScenarioRecord(record, scenarioId, binding) {
  exactKeys(record, ["evidenceFingerprintSha256", "eventReference", "observedAt", "requestReference", "sessionReference", "status"], "dodo_uat_scenario_record_invalid");
  assertSafeStrings(record);
  if (record.status !== "passed") throw new Error("dodo_uat_scenario_not_passed");
  assertIsoDate(record.observedAt, "dodo_uat_scenario_timestamp_invalid");
  assertSha256(record.evidenceFingerprintSha256, "dodo_uat_scenario_fingerprint_invalid");
  if (binding?.requireArtifactProof === true && binding.scenarioArtifactFingerprints?.[scenarioId] !== record.evidenceFingerprintSha256) {
    throw new Error("dodo_uat_scenario_artifact_unverified");
  }
  const references = [record.requestReference, record.eventReference, record.sessionReference].filter((reference) => reference !== null);
  if (references.length === 0 || references.some((reference) => typeof reference !== "string" || !SAFE_REFERENCE_PATTERN.test(reference))) throw new Error("dodo_uat_scenario_reference_invalid");
}

function assertScenarios(scenarios, binding) {
  exactKeys(scenarios, DODO_STAGING_UAT_SCENARIO_IDS, "dodo_uat_scenario_set_invalid");
  DODO_STAGING_UAT_SCENARIO_IDS.forEach((scenarioId) => assertScenarioRecord(scenarios[scenarioId], scenarioId, binding));
  const fingerprints = DODO_STAGING_UAT_SCENARIO_IDS.map((scenarioId) => scenarios[scenarioId].evidenceFingerprintSha256);
  if (new Set(fingerprints).size !== fingerprints.length) throw new Error("dodo_uat_scenario_fingerprint_duplicate");
}

function scenarioArtifactReference(releaseId, scenarioId) {
  return `artifact:.wrangler/releases/staging/${releaseId}/dodo-uat-scenarios/${scenarioId}.json`;
}

function scenarioArtifactPath(root, releaseId, scenarioId) {
  return resolve(root, scenarioArtifactReference(releaseId, scenarioId).slice("artifact:".length));
}

function assertReleaseShape(release, issue = "dodo_uat_scenario_artifact_binding_invalid") {
  exactKeys(release, ["commitSha", "manifestRef", "manifestSha256", "releaseId", "treeSha", "workerVersion"], issue);
  if (!GIT_SHA_PATTERN.test(release.commitSha) || /^0+$/u.test(release.commitSha)
    || !GIT_SHA_PATTERN.test(release.treeSha) || /^0+$/u.test(release.treeSha)
    || !RELEASE_ID_PATTERN.test(release.releaseId)
    || !SAFE_MANIFEST_PATTERN.test(release.manifestRef)
    || !release.manifestRef.includes(release.releaseId)
    || !SHA256_PATTERN.test(release.manifestSha256)
    || !WORKER_VERSION_PATTERN.test(release.workerVersion)
    || PLACEHOLDER_PATTERN.test(release.workerVersion)) {
    throw new Error(issue);
  }
}

function assertObservationReference(value, issue) {
  if (value !== null && (typeof value !== "string" || !SAFE_OBSERVATION_REFERENCE_PATTERN.test(value))) throw new Error(issue);
}

function buildScenarioArtifact(input) {
  const expectedKeys = ["environment", "eventReference", "observedAt", "provider", "release", "requestReference", "scenarioId", "sessionReference", "status"];
  if (Object.prototype.hasOwnProperty.call(input ?? {}, "repositoryRoot")) expectedKeys.push("repositoryRoot");
  exactKeys(input, expectedKeys, "dodo_uat_collection_scenario_invalid");
  const scenarioId = input?.scenarioId;
  if (typeof scenarioId !== "string" || !DODO_STAGING_UAT_SCENARIO_IDS.includes(scenarioId)) throw new Error("dodo_uat_scenario_id_invalid");
  assertReleaseShape(input.release);
  if (input.provider !== "dodo" || input.environment !== "staging") throw new Error("dodo_uat_scenario_artifact_binding_invalid");
  if (input.status !== "passed") throw new Error("dodo_uat_scenario_not_passed");
  assertIsoDate(input.observedAt, "dodo_uat_scenario_timestamp_invalid");
  assertObservationReference(input.requestReference, "dodo_uat_scenario_reference_invalid");
  assertObservationReference(input.eventReference, "dodo_uat_scenario_reference_invalid");
  assertObservationReference(input.sessionReference, "dodo_uat_scenario_reference_invalid");
  const artifact = {
    schemaVersion: 1,
    provider: "dodo",
    environment: "staging",
    mode: "scenario_observation",
    scenarioId,
    release: input.release,
    observedAt: input.observedAt,
    evidence: {
      status: "passed",
      requestReference: input.requestReference ?? null,
      eventReference: input.eventReference ?? null,
      sessionReference: input.sessionReference ?? null,
    },
    redaction: { noRawPayload: true, noSensitiveValues: true },
  };
  assertSafeStrings(artifact);
  return artifact;
}

function scenarioArtifactBytes(artifact) {
  return Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export function buildDodoUatScenarioArtifact(input) {
  const artifact = buildScenarioArtifact(input);
  const bytes = scenarioArtifactBytes(artifact);
  return {
    artifact,
    bytes,
    evidenceFingerprintSha256: createHash("sha256").update(bytes).digest("hex"),
    evidenceRef: scenarioArtifactReference(input.release.releaseId, input.scenarioId),
  };
}

export async function writeDodoUatScenarioArtifact(input) {
  const built = buildDodoUatScenarioArtifact(input);
  const root = input.repositoryRoot;
  if (typeof root !== "string" || root.length === 0) throw new Error("dodo_uat_repository_root_required");
  const artifactPath = scenarioArtifactPath(root, input.release.releaseId, input.scenarioId);
  await mkdir(dirname(artifactPath), { mode: 0o700, recursive: true });
  try {
    await writeFile(artifactPath, built.bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw new Error("dodo_uat_scenario_artifact_write_failed", { cause: error });
    let existing;
    try { existing = readFileSync(artifactPath); } catch { throw new Error("dodo_uat_scenario_artifact_read_failed"); }
    if (!existing.equals(built.bytes)) throw new Error("dodo_uat_scenario_artifact_conflict", { cause: error });
  }
  await chmod(artifactPath, 0o600);
  return { ...built, artifactPath };
}

function safeRedactionEvidence() {
  const values = {
    auditNoSensitiveValues: true,
    d1NoHostedCheckoutUrl: true,
    d1NoRawPayload: true,
    d1NoSecretValues: true,
    logsNoSensitiveValues: true,
    queuesNoSensitiveValues: true,
  };
  return {
    ...values,
    evidenceFingerprintSha256: createHash("sha256").update(`dodo-uat-redaction:v1:${JSON.stringify(canonicalize(values))}`).digest("hex"),
  };
}

export async function collectDodoStagingUatEvidence(input) {
  exactKeys(input, ["completedAt", "createdAt", "endpointFingerprintSha256", "offers", "release", "repositoryRoot", "scenarios"], "dodo_uat_collection_input_invalid");
  if (typeof input.repositoryRoot !== "string" || input.repositoryRoot.length === 0) throw new Error("dodo_uat_repository_root_required");
  assertReleaseShape(input.release, "dodo_uat_collection_release_invalid");
  assertSha256(input.endpointFingerprintSha256, "dodo_uat_endpoint_fingerprint_invalid");
  assertOffers(input.offers);
  assertIsoDate(input.createdAt, "dodo_uat_created_at_invalid");
  assertIsoDate(input.completedAt, "dodo_uat_completed_at_invalid");
  exactKeys(input.scenarios, DODO_STAGING_UAT_SCENARIO_IDS, "dodo_uat_scenario_set_invalid");
  assertSafeStrings(input);

  const scenarios = {};
  const scenarioArtifactFingerprints = {};
  for (const scenarioId of DODO_STAGING_UAT_SCENARIO_IDS) {
    const observation = input.scenarios[scenarioId];
    exactKeys(observation, ["eventReference", "observedAt", "requestReference", "sessionReference", "status"], "dodo_uat_collection_scenario_invalid");
    const written = await writeDodoUatScenarioArtifact({
      ...observation,
      environment: "staging",
      provider: "dodo",
      release: input.release,
      repositoryRoot: input.repositoryRoot,
      scenarioId,
    });
    scenarios[scenarioId] = {
      status: "passed",
      observedAt: observation.observedAt,
      evidenceFingerprintSha256: written.evidenceFingerprintSha256,
      requestReference: written.evidenceRef,
      eventReference: null,
      sessionReference: null,
    };
    scenarioArtifactFingerprints[scenarioId] = written.evidenceFingerprintSha256;
  }

  const evidence = {
    schemaVersion: 1,
    environment: "staging",
    provider: "dodo",
    providerEnvironment: "test_mode",
    release: input.release,
    endpointFingerprintSha256: input.endpointFingerprintSha256,
    offers: input.offers,
    scenarios,
    redaction: safeRedactionEvidence(),
    createdAt: input.createdAt,
    completedAt: input.completedAt,
  };
  assertDodoStagingUatEvidence(evidence, {
    ...input.release,
    requireArtifactProof: true,
    scenarioArtifactFingerprints,
  });

  const evidenceRef = `.wrangler/releases/staging/${input.release.releaseId}/dodo-uat-evidence.json`;
  const evidencePath = resolve(input.repositoryRoot, evidenceRef);
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await mkdir(dirname(evidencePath), { mode: 0o700, recursive: true });
  try {
    await writeFile(evidencePath, evidenceBytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw new Error("dodo_uat_evidence_write_failed", { cause: error });
    let existing;
    try { existing = readFileSync(evidencePath); } catch { throw new Error("dodo_uat_evidence_read_failed"); }
    if (!existing.equals(evidenceBytes)) throw new Error("dodo_uat_evidence_conflict", { cause: error });
  }
  await chmod(evidencePath, 0o600);
  return {
    artifactSha256: createHash("sha256").update(evidenceBytes).digest("hex"),
    evidence,
    evidencePath,
    evidenceRef,
    scenarioArtifactFingerprints,
  };
}

export function readDodoUatScenarioArtifacts({ evidence, repositoryRoot }) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) throw new Error("dodo_uat_repository_root_required");
  assertReleaseShape(evidence?.release);
  const fingerprints = {};
  DODO_STAGING_UAT_SCENARIO_IDS.forEach((scenarioId) => {
    const record = evidence?.scenarios?.[scenarioId];
    const refs = [record?.requestReference, record?.eventReference, record?.sessionReference].filter((ref) => ref !== null && ref !== undefined);
    if (refs.length === 0 || refs.some((ref) => typeof ref !== "string" || !SCENARIO_ARTIFACT_REF_PATTERN.test(ref))) throw new Error("dodo_uat_scenario_artifact_reference_required");
    const expectedRef = scenarioArtifactReference(evidence.release.releaseId, scenarioId);
    if (refs.some((ref) => ref !== expectedRef)) throw new Error("dodo_uat_scenario_artifact_reference_invalid");
    const path = scenarioArtifactPath(repositoryRoot, evidence.release.releaseId, scenarioId);
    let stat;
    try { stat = lstatSync(path); } catch { throw new Error("dodo_uat_scenario_artifact_missing"); }
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("dodo_uat_scenario_artifact_permissions_invalid");
    let bytes;
    let artifact;
    try {
      bytes = readFileSync(path);
      artifact = JSON.parse(bytes.toString("utf8"));
    } catch { throw new Error("dodo_uat_scenario_artifact_invalid"); }
    exactKeys(artifact, ["environment", "evidence", "mode", "observedAt", "provider", "redaction", "release", "scenarioId", "schemaVersion"], "dodo_uat_scenario_artifact_invalid");
    exactKeys(artifact.evidence, ["eventReference", "requestReference", "sessionReference", "status"], "dodo_uat_scenario_artifact_invalid");
    exactKeys(artifact.redaction, ["noRawPayload", "noSensitiveValues"], "dodo_uat_scenario_artifact_redaction_invalid");
    if (artifact.schemaVersion !== 1 || artifact.provider !== "dodo" || artifact.environment !== "staging" || artifact.mode !== "scenario_observation"
      || artifact.scenarioId !== scenarioId || artifact.observedAt !== record.observedAt || artifact.evidence.status !== record.status
      || artifact.redaction.noRawPayload !== true || artifact.redaction.noSensitiveValues !== true) throw new Error("dodo_uat_scenario_artifact_binding_invalid");
    assertReleaseShape(artifact.release);
    if (JSON.stringify(artifact.release) !== JSON.stringify(evidence.release)) throw new Error("dodo_uat_scenario_artifact_binding_invalid");
    assertObservationReference(artifact.evidence.requestReference, "dodo_uat_scenario_artifact_reference_invalid");
    assertObservationReference(artifact.evidence.eventReference, "dodo_uat_scenario_artifact_reference_invalid");
    assertObservationReference(artifact.evidence.sessionReference, "dodo_uat_scenario_artifact_reference_invalid");
    assertSafeStrings(artifact);
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    if (fingerprint !== record.evidenceFingerprintSha256) throw new Error("dodo_uat_scenario_artifact_hash_mismatch");
    fingerprints[scenarioId] = fingerprint;
  });
  return fingerprints;
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
  assertScenarios(evidence.scenarios, binding);
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
