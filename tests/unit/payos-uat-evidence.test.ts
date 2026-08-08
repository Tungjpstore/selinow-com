import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertPayosStagingUatEvidence,
  fingerprintPayosStagingUatEvidence,
  PAYOS_STAGING_UAT_SCENARIO_IDS,
} from "../../scripts/lib/payos-uat-evidence.mjs";

const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const releaseId = "stg_20260808T090000Z_aaaaaaaaaaaa";
const manifestRef = `.wrangler/releases/staging/${releaseId}/release-manifest.json`;
const binding = { commitSha, treeSha, releaseId, manifestRef, manifestSha256: "c".repeat(64), workerVersion: "worker-20260808" };

function evidence() {
  return {
    schemaVersion: 1,
    environment: "staging",
    provider: "payos",
    providerEnvironment: "test_mode",
    channel: "seller_payment",
    release: { ...binding },
    scenarios: Object.fromEntries(PAYOS_STAGING_UAT_SCENARIO_IDS.map((id, index) => [id, {
      status: "passed",
      observedAt: "2026-08-08T09:30:00.000Z",
      evidenceFingerprintSha256: (index + 1).toString(16).padStart(64, "0"),
      requestReference: `request:req_${String(index).padStart(4, "0")}`,
      eventReference: `event:evt_${String(index).padStart(4, "0")}`,
    }])),
    redaction: {
      d1NoRawPayload: true,
      d1NoSecretValues: true,
      logsNoSensitiveValues: true,
      queuesNoSensitiveValues: true,
      auditNoSensitiveValues: true,
      evidenceFingerprintSha256: "d".repeat(64),
    },
    createdAt: "2026-08-08T09:00:00.000Z",
    completedAt: "2026-08-08T09:30:00.000Z",
  };
}

describe("PayOS staging UAT evidence", () => {
  it("accepts the complete signed-event and reconciliation scenario set", () => {
    const value = evidence();
    expect(assertPayosStagingUatEvidence(value, binding)).toMatchObject({ accepted: true, scenarioCount: 14, releaseId });
    expect(fingerprintPayosStagingUatEvidence(value)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ["invalid_signature", "failed"],
    ["duplicate_replay", "not_started"],
    ["tenant_isolation", "failed"],
  ])("rejects incomplete scenario %s", (id, status) => {
    const value = evidence();
    const record = value.scenarios[id];
    if (record === undefined) throw new Error("missing_scenario_fixture");
    record.status = status;
    expect(() => assertPayosStagingUatEvidence(value, binding)).toThrow("payos_uat_scenario_not_passed");
  });

  it("rejects unsafe payload material and binding drift", () => {
    const unsafe = evidence();
    const signedPayment = unsafe.scenarios.signed_exact_payment;
    if (signedPayment === undefined) throw new Error("missing_scenario_fixture");
    signedPayment.requestReference = "https://payos.example/checkout";
    expect(() => assertPayosStagingUatEvidence(unsafe, binding)).toThrow("payos_uat_value_unsafe");
    const drift = evidence();
    drift.release.commitSha = "f".repeat(40);
    expect(() => assertPayosStagingUatEvidence(drift, binding)).toThrow("payos_uat_commit_mismatch");
  });

  it("ships only a bounded, redacted example", () => {
    const source = readFileSync("infra/release/payos-uat-evidence.example.json", "utf8");
    const example = JSON.parse(source) as { scenarios?: Record<string, unknown> };
    expect(Object.keys(example.scenarios ?? {}).sort()).toEqual([...PAYOS_STAGING_UAT_SCENARIO_IDS].sort());
    expect(source).not.toMatch(/Bearer |whsec_|"(?:rawPayload|checkoutUrl|customerEmail)"\s*:/iu);
  });
});
