import { generateKeyPairSync } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildPayosScenarioArtifact } from "../../scripts/payos-uat-artifact.mjs";
import { signPayosUatEvidence } from "../../scripts/payos-uat-sign.mjs";
import { validatePayosUatEvidenceFile } from "../../scripts/payos-uat-validate.mjs";
import {
  PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS,
  PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS,
  PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS,
  PAYOS_STAGING_UAT_SCENARIO_IDS,
} from "../../scripts/lib/payos-uat-evidence.mjs";

const temporaryDirectories: string[] = [];
const WORKER_VERSION = "staging-worker-version-20260811";
const CONTROLLED_ACCOUNT_FINGERPRINT = "a".repeat(64);
const TRANSACTION_FINGERPRINT = "b".repeat(64);
const UNSUPPORTED_REASONS = {
  signed_chargeback: "payos_signed_chargeback_not_supported",
  signed_refund: "payos_signed_refund_not_supported",
} as const;

type Fixture = {
  manifestPath: string;
  manifestRef: string;
  now: Date;
  releaseId: string;
  root: string;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "selinow-payos-uat-tooling-"));
  temporaryDirectories.push(root);
  writeFileSync(join(root, "package.json"), "{\"private\":true}\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "payos-uat-test@selinow.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Selinow PayOS UAT Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "payos uat fixture"], { cwd: root });
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
  const releaseId = `stg_20260811T050000Z_${commitSha.slice(0, 12)}`;
  const manifestRef = `.wrangler/releases/staging/${releaseId}/release-manifest.json`;
  const manifestPath = join(root, manifestRef);
  const now = new Date();
  mkdirSync(join(root, ".wrangler/releases/staging", releaseId), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({
    commitSha,
    createdAt: new Date(now.getTime() - 60_000).toISOString(),
    environment: "staging",
    expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    releaseId,
    schemaVersion: 3,
    treeSha,
  }), { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  return { manifestPath, manifestRef, now, releaseId, root };
}

function scenarioPolicy(id: string) {
  if (PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS.includes(id)) {
    return {
      classification: "provider_supported",
      controlledAccountFingerprintSha256: CONTROLLED_ACCOUNT_FINGERPRINT,
      proofOfExecutionFingerprintSha256: TRANSACTION_FINGERPRINT,
      reasonCode: null,
      status: "passed",
      verificationMethod: id === "signed_exact_payment" ? "signed_webhook" : "verified_provider_response",
    };
  }
  if (PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS.includes(id)) {
    return {
      classification: "selinow_local_assurance",
      controlledAccountFingerprintSha256: null,
      proofOfExecutionFingerprintSha256: null,
      reasonCode: null,
      status: "passed",
      verificationMethod: "local_contract",
    };
  }
  return {
    classification: "provider_unsupported",
    controlledAccountFingerprintSha256: null,
    proofOfExecutionFingerprintSha256: null,
    reasonCode: UNSUPPORTED_REASONS[id as keyof typeof UNSUPPORTED_REASONS],
    status: "unsupported",
    verificationMethod: "provider_capability_audit",
  };
}

async function completeUnsignedEvidence(testFixture: Fixture) {
  const observedAt = testFixture.now.toISOString();
  const scenarios: Record<string, Record<string, unknown>> = {};
  let release: Record<string, unknown> | null = null;
  for (const id of PAYOS_STAGING_UAT_SCENARIO_IDS) {
    const policy = scenarioPolicy(id);
    const artifactRef = `.wrangler/releases/staging/${testFixture.releaseId}/scenarios/payos-${id}.json`;
    const result = await buildPayosScenarioArtifact({
      ...policy,
      manifestPath: testFixture.manifestPath,
      observedAt,
      output: artifactRef,
      root: testFixture.root,
      scenarioId: id,
      workerVersion: WORKER_VERSION,
    });
    release ??= result.artifact.release;
    scenarios[id] = {
      classification: policy.classification,
      evidenceFingerprintSha256: result.artifactFingerprintSha256,
      eventReference: null,
      observedAt,
      reasonCode: policy.reasonCode,
      requestReference: `artifact:${artifactRef}`,
      status: policy.status,
      verificationMethod: policy.verificationMethod,
    };
  }
  if (release === null) throw new Error("missing_release_fixture");
  return {
    acceptanceReasonCode: null,
    channel: "seller_payment",
    completedAt: observedAt,
    createdAt: new Date(testFixture.now.getTime() - 30_000).toISOString(),
    environment: "staging",
    evidenceKind: "provider_acceptance",
    ownerAttestation: null,
    provider: "payos",
    providerEnvironment: "production_controlled",
    providerExecution: {
      controlledAccountFingerprintSha256: CONTROLLED_ACCOUNT_FINGERPRINT,
      paymentInstrument: "controlled_real_bank",
      realLowValueTransactionObserved: true,
      signatureSource: "provider_signed_webhook_and_verified_response",
      syntheticSignatureUsed: false,
      transactionEvidenceFingerprintSha256: TRANSACTION_FINGERPRINT,
    },
    redaction: {
      auditNoSensitiveValues: true,
      d1NoRawPayload: true,
      d1NoSecretValues: true,
      evidenceFingerprintSha256: "c".repeat(64),
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
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("PayOS UAT tooling", () => {
  it("requires an explicit evidence path at the CLI boundary", () => {
    const result = spawnSync(process.execPath, [
      "scripts/payos-uat-validate.mjs",
      "--manifest",
      "ignored-release-manifest.json",
      "--worker-version",
      WORKER_VERSION,
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("payos_uat_evidence_required");
  });

  it("writes a bounded release-specific scenario artifact with mode 0600", async () => {
    const testFixture = fixture();
    const output = `.wrangler/releases/staging/${testFixture.releaseId}/scenarios/payos-signed-exact-payment.json`;
    const result = await buildPayosScenarioArtifact({
      classification: "provider_supported",
      controlledAccountFingerprintSha256: CONTROLLED_ACCOUNT_FINGERPRINT,
      manifestPath: testFixture.manifestPath,
      observedAt: testFixture.now.toISOString(),
      output,
      proofOfExecutionFingerprintSha256: TRANSACTION_FINGERPRINT,
      root: testFixture.root,
      scenarioId: "signed_exact_payment",
      status: "passed",
      verificationMethod: "signed_webhook",
      workerVersion: WORKER_VERSION,
    });

    expect(statSync(result.artifactPath).mode & 0o777).toBe(0o600);
    expect(result.artifact).toMatchObject({
      controlledAccountFingerprintSha256: CONTROLLED_ACCOUNT_FINGERPRINT,
      evidenceKind: "provider_acceptance",
      proofOfExecutionFingerprintSha256: TRANSACTION_FINGERPRINT,
      scenarioId: "signed_exact_payment",
    });
    expect(result.artifactFingerprintSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(readFileSync(result.artifactPath, "utf8")).not.toMatch(/"(?:apiKey|checksumKey|rawPayload|checkoutUrl)"\s*:/u);
  });

  it("rejects noncanonical output and fingerprint scope escalation", async () => {
    const testFixture = fixture();
    await expect(buildPayosScenarioArtifact({
      classification: "selinow_local_assurance",
      controlledAccountFingerprintSha256: CONTROLLED_ACCOUNT_FINGERPRINT,
      manifestPath: testFixture.manifestPath,
      observedAt: testFixture.now.toISOString(),
      output: join(testFixture.root, "outside.json"),
      proofOfExecutionFingerprintSha256: null,
      root: testFixture.root,
      scenarioId: "invalid_signature",
      status: "passed",
      verificationMethod: "local_contract",
      workerVersion: WORKER_VERSION,
    })).rejects.toThrow("payos_uat_scenario_fingerprint_scope_invalid");
  });

  it("signs mode-0600 evidence and validates all referenced scenario artifacts", async () => {
    const testFixture = fixture();
    const evidence = await completeUnsignedEvidence(testFixture);
    const unsignedPath = join(testFixture.root, ".wrangler", "payos-unsigned.json");
    mkdirSync(join(testFixture.root, ".wrangler"), { recursive: true });
    writeFileSync(unsignedPath, JSON.stringify(evidence), { mode: 0o600 });
    chmodSync(unsignedPath, 0o600);
    const keys = generateKeyPairSync("ed25519");
    const privateKeyPath = join(testFixture.root, ".wrangler", "payos-owner-private.pem");
    writeFileSync(privateKeyPath, keys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    chmodSync(privateKeyPath, 0o600);
    const signedPath = `.wrangler/releases/staging/${testFixture.releaseId}/payos-uat-evidence.json`;

    const signed = await signPayosUatEvidence({
      evidencePath: unsignedPath,
      keyId: "release-owner-test",
      output: signedPath,
      privateKeyPath,
      root: testFixture.root,
      signedAt: testFixture.now.toISOString(),
    });
    expect(statSync(signed.evidencePath).mode & 0o777).toBe(0o600);
    const ownerPublicKey = keys.publicKey.export({ format: "pem", type: "spki" });
    const validation = await validatePayosUatEvidenceFile({
      evidencePath: signed.evidencePath,
      manifestPath: testFixture.manifestPath,
      now: testFixture.now,
      ownerAttestationPublicKeys: { "release-owner-test": ownerPublicKey },
      root: testFixture.root,
      workerVersion: WORKER_VERSION,
    });
    expect(validation).toMatchObject({
      accepted: true,
      fullCommerceAccepted: false,
      paymentLaneAccepted: true,
      reasonCodes: [
        "payos_signed_refund_not_supported",
        "payos_signed_chargeback_not_supported",
      ],
      scenarioCount: 14,
    });

    const tamperedRef = `.wrangler/releases/staging/${testFixture.releaseId}/scenarios/payos-invalid_signature.json`;
    writeFileSync(join(testFixture.root, tamperedRef), "{}\n", { mode: 0o600 });
    const tampered = await validatePayosUatEvidenceFile({
      evidencePath: signed.evidencePath,
      manifestPath: testFixture.manifestPath,
      now: testFixture.now,
      ownerAttestationPublicKeys: { "release-owner-test": ownerPublicKey },
      root: testFixture.root,
      workerVersion: WORKER_VERSION,
    });
    expect(tampered).toMatchObject({ accepted: false, acceptanceReasonCode: "payos_uat_scenario_artifact_hash_mismatch" });
  });

  it("rejects a valid evidence file outside its canonical release filename", async () => {
    const testFixture = fixture();
    const noncanonical = join(testFixture.root, ".wrangler/releases/staging", testFixture.releaseId, "payos-copy.json");
    writeFileSync(noncanonical, JSON.stringify({ release: { releaseId: testFixture.releaseId } }), { mode: 0o600 });
    await expect(validatePayosUatEvidenceFile({
      evidencePath: noncanonical,
      manifestPath: testFixture.manifestPath,
      now: testFixture.now,
      ownerAttestationPublicKeys: {},
      root: testFixture.root,
      workerVersion: WORKER_VERSION,
    })).rejects.toThrow("payos_uat_evidence_path_noncanonical");
  });

  it("keeps package commands bound to dedicated PayOS UAT scripts", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts["payos:uat:artifact"]).toBe("node scripts/payos-uat-artifact.mjs");
    expect(packageJson.scripts["payos:uat:sign"]).toBe("node scripts/payos-uat-sign.mjs");
    expect(packageJson.scripts["payos:uat:validate"]).toBe("node scripts/payos-uat-validate.mjs");
  });
});
