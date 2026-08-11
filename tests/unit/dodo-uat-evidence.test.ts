import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  DODO_STAGING_UAT_SCENARIO_IDS,
  assertDodoStagingUatEvidence,
  buildDodoUatScenarioArtifact,
  collectDodoStagingUatEvidence,
  fingerprintDodoStagingUatEvidence,
  fingerprintDodoUatReference,
  readDodoUatScenarioArtifacts,
} from "../../scripts/lib/dodo-uat-evidence.mjs";
import type { DodoStagingUatEvidence } from "../../scripts/lib/dodo-uat-evidence.mjs";

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const MANIFEST_SHA = "c".repeat(64);
const RELEASE_ID = `stg_20260808T090000Z_${COMMIT_SHA.slice(0, 12)}`;
const MANIFEST_REF = `.wrangler/releases/staging/${RELEASE_ID}/release-manifest.json`;
const WORKER_VERSION = "f18fc9e8-4bf4-4e2a-b953-178e91a91f43";
const NOW = "2026-08-08T09:30:00.000Z";

function validEvidence() {
  return {
    schemaVersion: 1,
    environment: "staging",
    provider: "dodo",
    providerEnvironment: "test_mode",
    release: {
      releaseId: RELEASE_ID,
      commitSha: COMMIT_SHA,
      treeSha: TREE_SHA,
      manifestRef: MANIFEST_REF,
      manifestSha256: MANIFEST_SHA,
      workerVersion: WORKER_VERSION,
    },
    endpointFingerprintSha256: "d".repeat(64),
    offers: [
      { planCode: "starter", marketCode: "vn", currency: "VND", amountMinor: 99_000, interval: "month", providerReferenceFingerprintSha256: "1".repeat(64) },
      { planCode: "pro", marketCode: "vn", currency: "VND", amountMinor: 299_000, interval: "month", providerReferenceFingerprintSha256: "2".repeat(64) },
      { planCode: "starter", marketCode: "global", currency: "USD", amountMinor: 500, interval: "month", providerReferenceFingerprintSha256: "3".repeat(64) },
      { planCode: "pro", marketCode: "global", currency: "USD", amountMinor: 1_500, interval: "month", providerReferenceFingerprintSha256: "4".repeat(64) },
    ],
    scenarios: Object.fromEntries(DODO_STAGING_UAT_SCENARIO_IDS.map((scenarioId, index) => [scenarioId, {
      status: "passed",
      observedAt: NOW,
      evidenceFingerprintSha256: (index + 1).toString(16).padStart(64, "0"),
      requestReference: `request:req_${String(index).padStart(6, "0")}`,
      eventReference: index === 0 ? null : `event:evt_${String(index).padStart(6, "0")}`,
      sessionReference: index < 2 ? null : `session:ses_${String(index).padStart(6, "0")}`,
    }])),
    redaction: {
      d1NoRawPayload: true,
      d1NoHostedCheckoutUrl: true,
      d1NoSecretValues: true,
      logsNoSensitiveValues: true,
      queuesNoSensitiveValues: true,
      auditNoSensitiveValues: true,
      evidenceFingerprintSha256: "e".repeat(64),
    },
    createdAt: "2026-08-08T09:00:00.000Z",
    completedAt: NOW,
  };
}

function getScenario(evidence: ReturnType<typeof validEvidence>, scenarioId: string) {
  const record = evidence.scenarios[scenarioId];
  if (record === undefined) throw new Error(`missing_fixture_scenario:${scenarioId}`);
  return record;
}

const binding = {
  commitSha: COMMIT_SHA,
  treeSha: TREE_SHA,
  releaseId: RELEASE_ID,
  manifestRef: MANIFEST_REF,
  manifestSha256: MANIFEST_SHA,
  workerVersion: WORKER_VERSION,
};

describe("Dodo staging UAT evidence", () => {
  it("accepts exactly 32 passed scenarios bound to the final staging release", () => {
    const evidence = validEvidence();

    expect(assertDodoStagingUatEvidence(evidence, binding)).toEqual({
      accepted: true,
      evidenceFingerprintSha256: fingerprintDodoStagingUatEvidence(evidence),
      releaseId: RELEASE_ID,
      scenarioCount: 32,
      workerVersion: WORKER_VERSION,
    });
    expect(DODO_STAGING_UAT_SCENARIO_IDS).toHaveLength(32);
  });

  it.each([
    ["commitSha", "f".repeat(40), "dodo_uat_commit_mismatch"],
    ["treeSha", "f".repeat(40), "dodo_uat_tree_mismatch"],
    ["manifestRef", ".wrangler/releases/staging/stg_other/release-manifest.json", "dodo_uat_manifest_ref_invalid"],
    ["manifestSha256", "f".repeat(64), "dodo_uat_manifest_mismatch"],
    ["workerVersion", "other-worker-version", "dodo_uat_worker_version_mismatch"],
  ])("rejects release binding drift for %s", (field, value, issue) => {
    const evidence = validEvidence();
    Object.assign(evidence.release, { [field]: value });

    expect(() => assertDodoStagingUatEvidence(evidence, binding)).toThrow(issue);
  });

  it("requires Dodo test mode and a fingerprinted staging endpoint", () => {
    const live = validEvidence();
    live.providerEnvironment = "live_mode";
    expect(() => assertDodoStagingUatEvidence(live, binding)).toThrow("dodo_uat_provider_environment_invalid");

    const endpoint = validEvidence();
    endpoint.endpointFingerprintSha256 = "https://api-staging.selinow.com/webhook";
    expect(() => assertDodoStagingUatEvidence(endpoint, binding)).toThrow("dodo_uat_endpoint_fingerprint_invalid");

    expect(fingerprintDodoUatReference("endpoint", "https://api-staging.selinow.com/api/webhooks/billing/dodo/opaque")).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprintDodoUatReference("endpoint", "same-reference")).not.toBe(fingerprintDodoUatReference("offer:starter:vn", "same-reference"));
    expect(() => fingerprintDodoUatReference("secret", "private-value")).toThrow("dodo_uat_fingerprint_scope_invalid");
  });

  it("requires the exact four commercial offers with distinct provider fingerprints", () => {
    const duplicate = validEvidence();
    const duplicateOffer = duplicate.offers[3];
    const sourceOffer = duplicate.offers[2];
    if (duplicateOffer === undefined || sourceOffer === undefined) throw new Error("missing_fixture_offer");
    duplicateOffer.providerReferenceFingerprintSha256 = sourceOffer.providerReferenceFingerprintSha256;
    expect(() => assertDodoStagingUatEvidence(duplicate, binding)).toThrow("dodo_uat_offer_fingerprint_duplicate");

    const changedPrice = validEvidence();
    const changedOffer = changedPrice.offers[0];
    if (changedOffer === undefined) throw new Error("missing_fixture_offer");
    changedOffer.amountMinor = 100_000;
    expect(() => assertDodoStagingUatEvidence(changedPrice, binding)).toThrow("dodo_uat_offer_contract_invalid");

    const missing = validEvidence();
    missing.offers.pop();
    expect(() => assertDodoStagingUatEvidence(missing, binding)).toThrow("dodo_uat_offer_contract_invalid");
  });

  it("rejects missing, extra, non-passed, and unreferenced scenario records", () => {
    const missing = validEvidence();
    const missingScenarioId = DODO_STAGING_UAT_SCENARIO_IDS[0];
    if (missingScenarioId === undefined) throw new Error("missing_fixture_scenario_id");
    missing.scenarios = Object.fromEntries(Object.entries(missing.scenarios).filter(([scenarioId]) => scenarioId !== missingScenarioId));
    expect(() => assertDodoStagingUatEvidence(missing, binding)).toThrow("dodo_uat_scenario_set_invalid");

    const extra = validEvidence();
    const extraScenarioId = DODO_STAGING_UAT_SCENARIO_IDS[0];
    if (extraScenarioId === undefined) throw new Error("missing_fixture_scenario_id");
    extra.scenarios.unreviewed_case = getScenario(extra, extraScenarioId);
    expect(() => assertDodoStagingUatEvidence(extra, binding)).toThrow("dodo_uat_scenario_set_invalid");

    const failed = validEvidence();
    const failedScenarioId = DODO_STAGING_UAT_SCENARIO_IDS[1];
    if (failedScenarioId === undefined) throw new Error("missing_fixture_scenario_id");
    getScenario(failed, failedScenarioId).status = "failed";
    expect(() => assertDodoStagingUatEvidence(failed, binding)).toThrow("dodo_uat_scenario_not_passed");

    const noReference = validEvidence();
    const noReferenceScenarioId = DODO_STAGING_UAT_SCENARIO_IDS[2];
    if (noReferenceScenarioId === undefined) throw new Error("missing_fixture_scenario_id");
    Object.assign(getScenario(noReference, noReferenceScenarioId), {
      requestReference: null,
      eventReference: null,
      sessionReference: null,
    });
    expect(() => assertDodoStagingUatEvidence(noReference, binding)).toThrow("dodo_uat_scenario_reference_invalid");

    const reusedEvidence = validEvidence();
    getScenario(reusedEvidence, "duplicate_webhook").evidenceFingerprintSha256 = getScenario(reusedEvidence, "payment_succeeded_exactly_once").evidenceFingerprintSha256;
    expect(() => assertDodoStagingUatEvidence(reusedEvidence, binding)).toThrow("dodo_uat_scenario_fingerprint_duplicate");
  });

  it("fails closed on secret, customer, raw payload, checkout URL, and unsafe reference material", () => {
    for (const mutate of [
      (evidence: ReturnType<typeof validEvidence>) => Object.assign(evidence, { apiKey: "dodo_private_api_key_value" }),
      (evidence: ReturnType<typeof validEvidence>) => Object.assign(getScenario(evidence, "plan_catalog_offers"), { rawPayload: "{}" }),
      (evidence: ReturnType<typeof validEvidence>) => { getScenario(evidence, "plan_catalog_offers").requestReference = "https://checkout.dodopayments.com/session/private"; },
      (evidence: ReturnType<typeof validEvidence>) => { getScenario(evidence, "plan_catalog_offers").eventReference = "event:buyer@example.test"; },
      (evidence: ReturnType<typeof validEvidence>) => { getScenario(evidence, "plan_catalog_offers").sessionReference = "session:Bearer_private_value"; },
    ]) {
      const evidence = validEvidence();
      mutate(evidence);
      expect(() => assertDodoStagingUatEvidence(evidence, binding)).toThrow(/dodo_uat_(?:field|value|scenario_reference)_unsafe/u);
    }
  });

  it("requires complete redaction checks and deterministic canonical fingerprints", () => {
    const evidence = validEvidence();
    const reordered = Object.fromEntries(Object.entries(structuredClone(evidence)).reverse()) as ReturnType<typeof validEvidence>;
    expect(fingerprintDodoStagingUatEvidence(evidence)).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprintDodoStagingUatEvidence(evidence)).toBe(fingerprintDodoStagingUatEvidence(reordered));

    evidence.redaction.logsNoSensitiveValues = false;
    expect(() => assertDodoStagingUatEvidence(evidence, binding)).toThrow("dodo_uat_redaction_incomplete");
  });

  it("rejects hash-shaped scenario claims when trusted artifact proof is required", () => {
    const value = validEvidence();
    expect(() => assertDodoStagingUatEvidence(value, { ...binding, requireArtifactProof: true })).toThrow("dodo_uat_scenario_artifact_unverified");

    const scenarioArtifactFingerprints = Object.fromEntries(
      DODO_STAGING_UAT_SCENARIO_IDS.map((id) => [id, getScenario(value, id).evidenceFingerprintSha256]),
    );
    expect(assertDodoStagingUatEvidence(value, { ...binding, requireArtifactProof: true, scenarioArtifactFingerprints })).toMatchObject({ accepted: true });
  });

  it("ships a bounded, secret-free example with all scenario identifiers", () => {
    const source = readFileSync("infra/release/dodo-uat-evidence.example.json", "utf8");
    const example = JSON.parse(source) as { scenarios?: Record<string, unknown> };

    expect(Object.keys(example.scenarios ?? {}).sort()).toEqual([...DODO_STAGING_UAT_SCENARIO_IDS].sort());
    expect(source).not.toMatch(/Bearer |whsec_|"(?:apiKey|webhookKey|webhookSecret|rawBody|rawPayload|checkoutUrl|customerEmail|customerPhone|customerAddress)"\s*:/iu);
  });

  it("builds and collects release-bound mode-0600 scenario artifacts", async () => {
    const root = mkdtempSync(`${tmpdir()}/dodo-uat-`);
    try {
      const source = validEvidence();
      const collected = await collectDodoStagingUatEvidence({
        completedAt: source.completedAt,
        createdAt: source.createdAt,
        endpointFingerprintSha256: source.endpointFingerprintSha256,
        offers: source.offers as DodoStagingUatEvidence["offers"],
        release: source.release,
        repositoryRoot: root,
        scenarios: Object.fromEntries(DODO_STAGING_UAT_SCENARIO_IDS.map((scenarioId) => {
          const record = getScenario(source, scenarioId);
          return [scenarioId, {
            status: "passed",
            observedAt: record.observedAt,
            requestReference: record.requestReference,
            eventReference: record.eventReference,
            sessionReference: record.sessionReference,
          }];
        })),
      });
      const fingerprints = readDodoUatScenarioArtifacts({ evidence: collected.evidence, repositoryRoot: root });
      expect(Object.keys(fingerprints)).toHaveLength(32);
      expect(assertDodoStagingUatEvidence(collected.evidence, {
        ...binding,
        requireArtifactProof: true,
        scenarioArtifactFingerprints: fingerprints,
      })).toMatchObject({ accepted: true, scenarioCount: 32 });
      expect(statSync(collected.evidencePath).mode & 0o777).toBe(0o600);
      const scenarioRef = collected.evidence.scenarios.plan_catalog_offers?.requestReference;
      if (typeof scenarioRef !== "string") throw new Error("missing_collected_scenario_reference");
      expect(statSync(`${root}/${scenarioRef.replace(/^artifact:/u, "")}`).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe scenario fields and non-private artifacts", () => {
    const value = validEvidence();
    expect(() => buildDodoUatScenarioArtifact({
      environment: "staging",
      eventReference: null,
      observedAt: NOW,
      provider: "dodo",
      rawPayload: "{}",
      release: value.release,
      requestReference: "request:req_000001",
      scenarioId: "plan_catalog_offers",
      sessionReference: null,
      status: "passed",
    } as never)).toThrow("dodo_uat_field_unsafe");

    const root = mkdtempSync(`${tmpdir()}/dodo-uat-permissions-`);
    try {
      const built = buildDodoUatScenarioArtifact({
        environment: "staging",
        eventReference: null,
        observedAt: NOW,
        provider: "dodo",
        release: value.release,
        requestReference: "request:req_000001",
        scenarioId: "plan_catalog_offers",
        sessionReference: null,
        status: "passed",
      });
      const path = `${root}/${built.evidenceRef.replace(/^artifact:/u, "")}`;
      mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      writeFileSync(path, built.bytes, { mode: 0o600 });
      chmodSync(path, 0o644);
      const evidence = value;
      evidence.scenarios.plan_catalog_offers = {
        status: "passed",
        observedAt: NOW,
        evidenceFingerprintSha256: built.evidenceFingerprintSha256,
        requestReference: built.evidenceRef,
        eventReference: null,
        sessionReference: null,
      };
      expect(() => readDodoUatScenarioArtifacts({ evidence: evidence as unknown as DodoStagingUatEvidence, repositoryRoot: root })).toThrow("dodo_uat_scenario_artifact_permissions_invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
