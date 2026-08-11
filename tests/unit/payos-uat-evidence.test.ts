import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertPayosStagingUatEvidence,
  fingerprintPayosStagingUatEvidence,
  PAYOS_STAGING_UAT_SCENARIO_IDS,
  serializePayosOwnerAttestationPayload,
} from "../../scripts/lib/payos-uat-evidence.mjs";
import { validateCommerceUatArtifactsSync } from "../../scripts/lib/commerce-uat-evidence.mjs";

const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const releaseId = "stg_20260808T090000Z_aaaaaaaaaaaa";
const manifestRef = `.wrangler/releases/staging/${releaseId}/release-manifest.json`;
const binding = { commitSha, treeSha, releaseId, manifestRef, manifestSha256: "c".repeat(64), workerVersion: "worker-20260808" };
const ownerKeyId = "release-owner-test";
const ownerKeys = generateKeyPairSync("ed25519");
const ownerPublicKey = ownerKeys.publicKey.export({ format: "pem", type: "spki" });

const providerRequired = ["signed_exact_payment", "direct_reconciliation"];
const localRequired = [
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
];
const providerUnsupported = ["signed_refund", "signed_chargeback"];
const unsupportedReason = {
  signed_chargeback: "payos_signed_chargeback_not_supported",
  signed_refund: "payos_signed_refund_not_supported",
} as const;

type ScenarioFixture = {
  classification: string;
  evidenceFingerprintSha256: string | null;
  eventReference: string | null;
  observedAt: string | null;
  reasonCode: string | null;
  requestReference: string | null;
  status: string;
  verificationMethod: string;
};

type EvidenceFixture = {
  acceptanceReasonCode: string | null;
  evidenceKind: string;
  providerEnvironment: string;
  providerExecution: {
    controlledAccountFingerprintSha256: string | null;
    paymentInstrument: string;
    realLowValueTransactionObserved: boolean;
    signatureSource: string;
    syntheticSignatureUsed: boolean;
    transactionEvidenceFingerprintSha256: string | null;
  };
  ownerAttestation: {
    algorithm: string;
    keyId: string;
    signatureBase64: string;
    signedAt: string;
  } | null;
  release: typeof binding;
  scenarios: Record<string, ScenarioFixture>;
  [key: string]: unknown;
};

function scenario(id: string, index: number) {
  if (providerUnsupported.includes(id)) {
    return {
      classification: "provider_unsupported",
      status: "unsupported",
      observedAt: "2026-08-08T09:30:00.000Z",
      evidenceFingerprintSha256: (index + 1).toString(16).padStart(64, "0"),
      requestReference: `artifact:payos/${id}.json`,
      eventReference: null,
      reasonCode: unsupportedReason[id as keyof typeof unsupportedReason],
      verificationMethod: "provider_capability_audit",
    };
  }
  const providerScenario = providerRequired.includes(id);
  return {
    classification: providerScenario ? "provider_supported" : "selinow_local_assurance",
    status: "passed",
    observedAt: "2026-08-08T09:30:00.000Z",
    evidenceFingerprintSha256: (index + 1).toString(16).padStart(64, "0"),
    requestReference: `artifact:payos/${id}.json`,
    eventReference: null,
    reasonCode: null,
    verificationMethod: id === "signed_exact_payment"
      ? "signed_webhook"
      : id === "direct_reconciliation"
        ? "verified_provider_response"
        : "local_contract",
  };
}

function contractGapScenario(id: string, index: number): ScenarioFixture {
  const record = scenario(id, index);
  if (providerUnsupported.includes(id)) return record;
  const providerScenario = providerRequired.includes(id);
  return {
    ...record,
    status: providerScenario ? "blocked" : "not_started",
    observedAt: null,
    evidenceFingerprintSha256: null,
    requestReference: null,
    eventReference: null,
    reasonCode: providerScenario ? "payos_controlled_real_transaction_not_executed" : "payos_local_assurance_not_recorded",
  };
}

function providerEvidence(): EvidenceFixture {
  const value: EvidenceFixture = {
    schemaVersion: 2,
    evidenceKind: "provider_acceptance",
    acceptanceReasonCode: null,
    environment: "staging",
    provider: "payos",
    providerEnvironment: "production_controlled",
    channel: "seller_payment",
    release: { ...binding },
    providerExecution: {
      controlledAccountFingerprintSha256: "e".repeat(64),
      paymentInstrument: "controlled_real_bank",
      realLowValueTransactionObserved: true,
      signatureSource: "provider_signed_webhook_and_verified_response",
      syntheticSignatureUsed: false,
      transactionEvidenceFingerprintSha256: "f".repeat(64),
    },
    ownerAttestation: {
      algorithm: "ed25519",
      keyId: ownerKeyId,
      signatureBase64: "",
      signedAt: "2026-08-08T09:30:00.000Z",
    },
    scenarioPolicy: { localRequired, providerRequired, providerUnsupported },
    unsupportedCapabilities: {
      signedChargeback: {
        documentationReference: "payos_docs:payment_webhook",
        reasonCode: "payos_signed_chargeback_not_supported",
        status: "unsupported",
      },
      signedRefund: {
        documentationReference: "payos_docs:payment_webhook",
        reasonCode: "payos_signed_refund_not_supported",
        status: "unsupported",
      },
    },
    scenarios: Object.fromEntries(PAYOS_STAGING_UAT_SCENARIO_IDS.map((id, index) => [id, scenario(id, index)])),
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
  if (value.ownerAttestation === null) throw new Error("missing_owner_attestation_fixture");
  value.ownerAttestation.signatureBase64 = sign(null, Buffer.from(serializePayosOwnerAttestationPayload(value)), ownerKeys.privateKey).toString("base64");
  return value;
}

function contractGapEvidence() {
  const value = providerEvidence();
  value.evidenceKind = "contract_gap";
  value.acceptanceReasonCode = "payos_controlled_real_transaction_not_executed";
  value.providerEnvironment = "unavailable";
  value.providerExecution = {
    controlledAccountFingerprintSha256: null,
    paymentInstrument: "none",
    realLowValueTransactionObserved: false,
    signatureSource: "none",
    syntheticSignatureUsed: false,
    transactionEvidenceFingerprintSha256: null,
  };
  value.ownerAttestation = null;
  value.scenarios = Object.fromEntries(PAYOS_STAGING_UAT_SCENARIO_IDS.map((id, index) => [id, contractGapScenario(id, index)]));
  return value;
}

function writeCommerceProviderFixture(tamper: "hash" | "release" | "redaction" | null = null) {
  const root = mkdtempSync(join(tmpdir(), "selinow-payos-commerce-"));
  mkdirSync(join(root, ".wrangler/releases/staging"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".wrangler/\n");
  writeFileSync(join(root, "package.json"), "{\"private\":true}\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "payos-test@selinow.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Selinow PayOS Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "payos commerce fixture"], { cwd: root });
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
  const releaseId = "stg_20260808T090000Z_" + commitSha.slice(0, 12);
  const manifestRef = ".wrangler/releases/staging/" + releaseId + "/release-manifest.json";
  const manifest = JSON.stringify({
    commitSha,
    createdAt: "2026-08-08T09:00:00.000Z",
    environment: "staging",
    expiresAt: "2026-08-09T09:00:00.000Z",
    releaseId,
    schemaVersion: 3,
    treeSha,
  });
  const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
  mkdirSync(join(root, ".wrangler/releases/staging", releaseId), { recursive: true });
  writeFileSync(join(root, manifestRef), manifest, { mode: 0o600 });

  const value = providerEvidence();
  const release = { commitSha, treeSha, releaseId, manifestRef, manifestSha256, workerVersion: "worker-20260808" };
  value.release = release;
  const scenarioDirectory = join(root, ".wrangler/releases/staging", releaseId, "scenarios");
  mkdirSync(scenarioDirectory, { recursive: true });
  for (const id of PAYOS_STAGING_UAT_SCENARIO_IDS) {
    const record = value.scenarios[id];
    if (record === undefined) throw new Error("missing_scenario_fixture");
    const providerScenario = providerRequired.includes(id);
    const artifactValue = {
      classification: record.classification,
      controlledAccountFingerprintSha256: providerScenario ? value.providerExecution.controlledAccountFingerprintSha256 : null,
      evidenceKind: value.evidenceKind,
      environment: "staging",
      observedAt: record.observedAt,
      provider: "payos",
      proofOfExecutionFingerprintSha256: providerScenario ? value.providerExecution.transactionEvidenceFingerprintSha256 : null,
      redaction: { noRawPayload: true, noSensitiveValues: true },
      release,
      result: record.status,
      scenarioId: id,
      schemaVersion: 1,
      verificationMethod: record.verificationMethod,
    };
    if (tamper === "release" && id === "signed_exact_payment") {
      const replacement = releaseId.endsWith("a") ? "b" : "a";
      artifactValue.release = { ...release, releaseId: releaseId.slice(0, -1) + replacement };
    }
    if (tamper === "redaction" && id === "signed_exact_payment") {
      artifactValue.redaction = { noRawPayload: true, noSensitiveValues: false };
    }
    const artifactRef = ".wrangler/releases/staging/" + releaseId + "/scenarios/payos-" + id + ".json";
    const artifactBytes = JSON.stringify(artifactValue);
    writeFileSync(join(root, artifactRef), artifactBytes, { mode: 0o600 });
    record.eventReference = "artifact:" + artifactRef;
    record.requestReference = "artifact:" + artifactRef;
    record.evidenceFingerprintSha256 = tamper === "hash" && id === "signed_exact_payment"
      ? "0".repeat(64)
      : createHash("sha256").update(artifactBytes).digest("hex");
  }
  if (value.ownerAttestation === null) throw new Error("missing_owner_attestation_fixture");
  value.ownerAttestation.signatureBase64 = sign(
    null,
    Buffer.from(serializePayosOwnerAttestationPayload(value)),
    ownerKeys.privateKey,
  ).toString("base64");
  const evidenceRef = manifestRef.slice(0, manifestRef.lastIndexOf("/")) + "/payos-uat-evidence.json";
  const evidenceBytes = JSON.stringify(value);
  writeFileSync(join(root, evidenceRef), evidenceBytes, { mode: 0o600 });
  return {
    root,
    evidence: {
      commerceAcceptance: {
        payos: {
          artifactSha256: createHash("sha256").update(evidenceBytes).digest("hex"),
          evidenceRef,
        },
      },
    },
  };
}

describe("PayOS staging UAT evidence", () => {
  it("accepts only a controlled production provider run plus separate local assurance", () => {
    const value = providerEvidence();
    expect(assertPayosStagingUatEvidence(value, { ...binding, ownerAttestationPublicKeys: { [ownerKeyId]: ownerPublicKey } })).toMatchObject({
      accepted: true,
      evidenceKind: "provider_acceptance",
      fullCommerceAccepted: false,
      fullCommerceReasonCodes: [
        "payos_signed_refund_not_supported",
        "payos_signed_chargeback_not_supported",
      ],
      localScenarioCount: 10,
      paymentLaneAccepted: true,
      providerScenarioCount: 2,
      releaseId,
      scenarioCount: 14,
      unsupportedScenarioCount: 2,
    });
    expect(fingerprintPayosStagingUatEvidence(value)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps payment-lane acceptance outside full-commerce acceptance while reversals are unsupported", () => {
    const fixture = writeCommerceProviderFixture();
    try {
      const result = validateCommerceUatArtifactsSync({
        evidence: fixture.evidence,
        now: new Date("2026-08-08T09:30:00.000Z"),
        payosOwnerAttestationPublicKeys: { [ownerKeyId]: ownerPublicKey },
        repositoryRoot: fixture.root,
      });

      expect(result.payos).toMatchObject({
        accepted: false,
        error: "payos_full_commerce_unsupported",
        paymentLaneAccepted: true,
        reasonCodes: [
          "payos_signed_refund_not_supported",
          "payos_signed_chargeback_not_supported",
        ],
      });
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects the legacy fictional test-mode provider claim", () => {
    const value = providerEvidence();
    value.providerEnvironment = "test_mode";
    expect(() => assertPayosStagingUatEvidence(value, binding)).toThrow("payos_uat_provider_environment_invalid");
  });

  it("rejects synthetic signatures and local evidence relabeled as provider evidence", () => {
    const synthetic = providerEvidence();
    synthetic.providerExecution.syntheticSignatureUsed = true;
    expect(() => assertPayosStagingUatEvidence(synthetic, { ...binding, ownerAttestationPublicKeys: { [ownerKeyId]: ownerPublicKey } })).toThrow("payos_uat_provider_execution_invalid");

    const relabeled = providerEvidence();
    const exact = relabeled.scenarios.signed_exact_payment;
    if (exact === undefined) throw new Error("missing_scenario_fixture");
    exact.classification = "selinow_local_assurance";
    exact.verificationMethod = "local_contract";
    expect(() => assertPayosStagingUatEvidence(relabeled, { ...binding, ownerAttestationPublicKeys: { [ownerKeyId]: ownerPublicKey } })).toThrow("payos_uat_provider_scenario_invalid");
  });

  it("never lets unsupported refund or chargeback claims satisfy provider acceptance", () => {
    const value = providerEvidence();
    const refund = value.scenarios.signed_refund;
    if (refund === undefined) throw new Error("missing_scenario_fixture");
    refund.status = "passed";
    refund.classification = "provider_supported";
    refund.verificationMethod = "signed_webhook";
    refund.reasonCode = null;
    expect(() => assertPayosStagingUatEvidence(value, { ...binding, ownerAttestationPublicKeys: { [ownerKeyId]: ownerPublicKey } })).toThrow("payos_uat_unsupported_scenario_invalid");
  });

  it("validates but rejects a machine-readable contract-gap artifact", () => {
    const value = contractGapEvidence();
    expect(() => assertPayosStagingUatEvidence(value, binding)).toThrow("payos_uat_contract_gap:payos_controlled_real_transaction_not_executed");
  });

  it("keeps contract-gap artifacts outside commerce acceptance", () => {
    const root = mkdtempSync(join(tmpdir(), "selinow-payos-gap-"));
    try {
      const evidenceRef = ".wrangler/releases/staging/payos-contract-gap.json";
      const evidencePath = join(root, evidenceRef);
      mkdirSync(join(root, ".wrangler/releases/staging"), { recursive: true });
      const bytes = `${JSON.stringify(contractGapEvidence())}\n`;
      writeFileSync(evidencePath, bytes, { mode: 0o600 });
      const result = validateCommerceUatArtifactsSync({
        evidence: {
          commerceAcceptance: {
            payos: {
              artifactSha256: createHash("sha256").update(bytes).digest("hex"),
              evidenceRef,
            },
          },
        },
        now: new Date("2026-08-08T09:30:00.000Z"),
        repositoryRoot: root,
      });
      expect(result.payos).toEqual({ accepted: false, error: "payos_uat_provider_binding_mismatch" });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("requires trusted artifacts for provider, local, and capability-audit records", () => {
    const value = providerEvidence();
    expect(() => assertPayosStagingUatEvidence(value, { ...binding, ownerAttestationPublicKeys: { [ownerKeyId]: ownerPublicKey }, requireArtifactProof: true })).toThrow("payos_uat_scenario_artifact_unverified");
    const scenarioArtifactFingerprints = Object.fromEntries(PAYOS_STAGING_UAT_SCENARIO_IDS.map((id) => {
      const record = value.scenarios[id];
      if (record === undefined) throw new Error("missing_scenario_fixture");
      if (record.evidenceFingerprintSha256 === null) throw new Error("missing_scenario_fingerprint");
      return [id, record.evidenceFingerprintSha256];
    }));
    expect(assertPayosStagingUatEvidence(value, { ...binding, ownerAttestationPublicKeys: { [ownerKeyId]: ownerPublicKey }, requireArtifactProof: true, scenarioArtifactFingerprints })).toMatchObject({ accepted: true });
  });

  it("rejects unsafe payload material and binding drift", () => {
    const unsafe = providerEvidence();
    const signedPayment = unsafe.scenarios.signed_exact_payment;
    if (signedPayment === undefined) throw new Error("missing_scenario_fixture");
    signedPayment.requestReference = "https://payos.example/checkout";
    expect(() => assertPayosStagingUatEvidence(unsafe, { ...binding, ownerAttestationPublicKeys: { [ownerKeyId]: ownerPublicKey } })).toThrow("payos_uat_value_unsafe");
    const drift = providerEvidence();
    drift.release.commitSha = "f".repeat(40);
    expect(() => assertPayosStagingUatEvidence(drift, { ...binding, ownerAttestationPublicKeys: { [ownerKeyId]: ownerPublicKey } })).toThrow("payos_uat_commit_mismatch");
  });

  it("rejects provider acceptance without a trusted owner attestation key", () => {
    expect(() => assertPayosStagingUatEvidence(providerEvidence(), binding)).toThrow("payos_uat_owner_attestation_untrusted");
  });

  it("rejects a tampered provider execution claim after signing", () => {
    const value = providerEvidence();
    if (value.ownerAttestation === null) throw new Error("missing_owner_attestation_fixture");
    value.ownerAttestation.signedAt = "2026-08-08T09:29:00.000Z";
    expect(() => assertPayosStagingUatEvidence(value, { ...binding, ownerAttestationPublicKeys: { [ownerKeyId]: ownerPublicKey } })).toThrow("payos_uat_owner_attestation_invalid");
  });

  it.each([
    ["hash", "payos_uat_scenario_artifact_hash_mismatch"],
    ["release", "payos_uat_scenario_artifact_binding_mismatch"],
    ["redaction", "payos_uat_scenario_artifact_redaction_invalid"],
  ] as const)("rejects commerce acceptance when a trusted PayOS scenario artifact is tampered (%s)", (tamper, expectedError) => {
    const fixture = writeCommerceProviderFixture(tamper);
    try {
      const result = validateCommerceUatArtifactsSync({
        evidence: fixture.evidence,
        now: new Date("2026-08-08T09:30:00.000Z"),
        payosOwnerAttestationPublicKeys: { [ownerKeyId]: ownerPublicKey },
        repositoryRoot: fixture.root,
      });
      expect(result.payos).toEqual({ accepted: false, error: expectedError });
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("ships a bounded contract-gap example rather than a provider acceptance claim", () => {
    const source = readFileSync("infra/release/payos-uat-evidence.example.json", "utf8");
    const example = JSON.parse(source) as { evidenceKind?: string; providerEnvironment?: string; scenarios?: Record<string, unknown> };
    expect(example.evidenceKind).toBe("contract_gap");
    expect(example.providerEnvironment).toBe("unavailable");
    expect(Object.keys(example.scenarios ?? {}).sort()).toEqual([...PAYOS_STAGING_UAT_SCENARIO_IDS].sort());
    expect(source).not.toMatch(/Bearer |whsec_|"(?:rawPayload|checkoutUrl|customerEmail)"\s*:/iu);
  });
});
