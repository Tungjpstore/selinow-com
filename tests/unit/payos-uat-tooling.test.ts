import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildPayosScenarioArtifact } from "../../scripts/payos-uat-artifact.mjs";
import { collectPayosUatEvidence } from "../../scripts/payos-uat-collect.mjs";
import { signPayosProviderExecutionArtifact } from "../../scripts/payos-uat-execution-sign.mjs";
import { signPayosUatEvidence } from "../../scripts/payos-uat-sign.mjs";
import { validatePayosUatEvidenceFile } from "../../scripts/payos-uat-validate.mjs";
import {
  readPayosProviderExecutionArtifacts,
  serializePayosRunnerAttestationPayload,
  PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS,
  PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS,
  PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS,
  PAYOS_STAGING_UAT_SCENARIO_IDS,
} from "../../scripts/lib/payos-uat-evidence.mjs";

const temporaryDirectories: string[] = [];
const WORKER_VERSION = "staging-worker-version-20260811";
const CONTROLLED_ACCOUNT_FINGERPRINT = "a".repeat(64);
const RUNNER_KEY_ID = "staging-runner-test";
const RUNNER_KEYS = generateKeyPairSync("ed25519");
const RUNNER_PUBLIC_KEY = RUNNER_KEYS.publicKey.export({ format: "pem", type: "spki" });
const RUNNER_SPKI_SHA256 = createHash("sha256")
  .update(RUNNER_KEYS.publicKey.export({ format: "der", type: "spki" }))
  .digest("hex");
const RUNNER_TRUST = {
  stagingRunnerPublicKeys: { [RUNNER_KEY_ID]: RUNNER_PUBLIC_KEY },
  stagingRunnerSpkiFingerprints: { [RUNNER_KEY_ID]: RUNNER_SPKI_SHA256 },
};
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

function writeProviderExecutionArtifact(
  testFixture: Fixture,
  scenarioId: "signed_exact_payment" | "direct_reconciliation",
  options: { canonicalUnsigned?: boolean; processed?: boolean; referenceSuffix?: string; runnerKeys?: typeof RUNNER_KEYS; unsigned?: boolean } = {},
) {
  const verificationMethod = scenarioId === "signed_exact_payment" ? "signed_webhook" : "verified_provider_response";
  const artifactRef = `.wrangler/releases/staging/${testFixture.releaseId}/execution/payos-${scenarioId}${options.canonicalUnsigned === true ? ".unsigned" : ""}.json`;
  const manifestBytes = readFileSync(testFixture.manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { commitSha: string; treeSha: string };
  const release = {
    commitSha: manifest.commitSha,
    manifestRef: testFixture.manifestRef,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    releaseId: testFixture.releaseId,
    treeSha: manifest.treeSha,
    workerVersion: WORKER_VERSION,
  };
  const suffix = options.referenceSuffix ?? (scenarioId === "signed_exact_payment" ? "1" : "2");
  const artifact: {
    runnerAttestation: null | {
      algorithm: string;
      keyId: string;
      publicKeySpkiSha256: string;
      signatureBase64: string;
      signedAt: string;
    };
    [key: string]: unknown;
  } = {
    authority: {
      attemptReference: `attempt:pay_00000000-0000-4000-8000-00000000000${suffix}`,
      authoritySource: scenarioId === "signed_exact_payment" ? "staging_d1_verified_event" : "staging_exact_attempt_reconciliation",
      eventReference: `event:pev_00000000-0000-4000-8000-00000000000${suffix}`,
      providerAuthority: scenarioId === "signed_exact_payment" ? "provider_signed_webhook" : "provider_signed_response",
      providerReference: `provider:${suffix.repeat(64)}`,
      requestReference: `request:payos-uat-${suffix}`,
    },
    controlledAccountFingerprintSha256: CONTROLLED_ACCOUNT_FINGERPRINT,
    environment: "staging",
    evidenceKind: "provider_execution",
    observedAt: testFixture.now.toISOString(),
    provider: "payos",
    providerEnvironment: "production_controlled",
    redaction: {
      noCredentialData: true,
      noCustomerData: true,
      noFinancialDetails: true,
      noRawPayload: true,
    },
    release,
    result: { duplicate: false, processed: options.processed ?? true, state: "paid_exact" },
    runnerAttestation: null,
    scenarioId,
    schemaVersion: 1,
    verificationMethod,
  };
  if (options.unsigned !== true) {
    const runnerKeys = options.runnerKeys ?? RUNNER_KEYS;
    const publicKeySpkiSha256 = createHash("sha256")
      .update(runnerKeys.publicKey.export({ format: "der", type: "spki" }))
      .digest("hex");
    artifact.runnerAttestation = {
      algorithm: "ed25519",
      keyId: RUNNER_KEY_ID,
      publicKeySpkiSha256,
      signatureBase64: "",
      signedAt: testFixture.now.toISOString(),
    };
    artifact.runnerAttestation.signatureBase64 = sign(
      null,
      Buffer.from(serializePayosRunnerAttestationPayload(artifact)),
      runnerKeys.privateKey,
    ).toString("base64");
  }
  const path = join(testFixture.root, artifactRef);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { artifactRef, path };
}

async function completeUnsignedEvidence(testFixture: Fixture, options: { duplicateProviderRefs?: boolean } = {}) {
  const observedAt = testFixture.now.toISOString();
  const scenarios: Record<string, Record<string, unknown>> = {};
  let release: Record<string, unknown> | null = null;
  const providerExecutionFingerprints: string[] = [];
  for (const id of PAYOS_STAGING_UAT_SCENARIO_IDS) {
    const policy = scenarioPolicy(id);
    const artifactRef = `.wrangler/releases/staging/${testFixture.releaseId}/scenarios/payos-${id}.json`;
    const execution = PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS.includes(id)
      ? writeProviderExecutionArtifact(testFixture, id as "signed_exact_payment" | "direct_reconciliation", {
        ...(options.duplicateProviderRefs === true && id === "direct_reconciliation" ? { referenceSuffix: "1" } : {}),
      })
      : null;
    const result = await buildPayosScenarioArtifact({
      ...policy,
      executionEvidencePath: execution?.artifactRef ?? null,
      manifestPath: testFixture.manifestPath,
      observedAt,
      output: artifactRef,
      root: testFixture.root,
      scenarioId: id,
      ...RUNNER_TRUST,
      workerVersion: WORKER_VERSION,
    });
    release ??= result.artifact.release;
    if (typeof result.artifact.proofOfExecutionFingerprintSha256 === "string") {
      providerExecutionFingerprints.push(result.artifact.proofOfExecutionFingerprintSha256);
    }
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
      transactionEvidenceFingerprintSha256: createHash("sha256")
        .update(JSON.stringify(providerExecutionFingerprints.sort()))
        .digest("hex"),
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
    const execution = writeProviderExecutionArtifact(testFixture, "signed_exact_payment");
    const output = `.wrangler/releases/staging/${testFixture.releaseId}/scenarios/payos-signed_exact_payment.json`;
    const result = await buildPayosScenarioArtifact({
      classification: "provider_supported",
      executionEvidencePath: execution.artifactRef,
      manifestPath: testFixture.manifestPath,
      observedAt: testFixture.now.toISOString(),
      output,
      root: testFixture.root,
      scenarioId: "signed_exact_payment",
      ...RUNNER_TRUST,
      status: "passed",
      verificationMethod: "signed_webhook",
      workerVersion: WORKER_VERSION,
    });

    expect(statSync(result.artifactPath).mode & 0o777).toBe(0o600);
    expect(result.artifact).toMatchObject({
      controlledAccountFingerprintSha256: CONTROLLED_ACCOUNT_FINGERPRINT,
      evidenceKind: "provider_acceptance",
      scenarioId: "signed_exact_payment",
    });
    expect(result.artifact.proofOfExecutionFingerprintSha256).toBe(
      createHash("sha256").update(readFileSync(execution.path)).digest("hex"),
    );
    expect(result.artifactFingerprintSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(readFileSync(result.artifactPath, "utf8")).not.toMatch(/"(?:apiKey|checksumKey|rawPayload|checkoutUrl)"\s*:/u);
  });

  it("signs a canonical unsigned execution artifact with a separately trusted runner key", async () => {
    const testFixture = fixture();
    const unsigned = writeProviderExecutionArtifact(testFixture, "signed_exact_payment", {
      canonicalUnsigned: true,
      unsigned: true,
    });
    const privateKeyPath = join(testFixture.root, ".wrangler", "runner-private.pem");
    writeFileSync(privateKeyPath, RUNNER_KEYS.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    chmodSync(privateKeyPath, 0o600);
    const output = `.wrangler/releases/staging/${testFixture.releaseId}/execution/payos-signed_exact_payment.json`;

    const signed = await signPayosProviderExecutionArtifact({
      input: unsigned.artifactRef,
      keyId: RUNNER_KEY_ID,
      output,
      privateKeyPath,
      root: testFixture.root,
      signedAt: testFixture.now.toISOString(),
    });

    expect(statSync(signed.artifactPath).mode & 0o777).toBe(0o600);
    expect(signed.publicKeySpkiSha256).toBe(RUNNER_SPKI_SHA256);
    const signedArtifact = JSON.parse(readFileSync(signed.artifactPath, "utf8")) as Record<string, unknown>;
    expect(signedArtifact).not.toHaveProperty("publicKey");
    expect(signedArtifact.runnerAttestation).toMatchObject({
      algorithm: "ed25519",
      keyId: RUNNER_KEY_ID,
      publicKeySpkiSha256: RUNNER_SPKI_SHA256,
    });

    await expect(buildPayosScenarioArtifact({
      classification: "provider_supported",
      executionEvidencePath: output,
      manifestPath: testFixture.manifestPath,
      observedAt: testFixture.now.toISOString(),
      output: `.wrangler/releases/staging/${testFixture.releaseId}/scenarios/payos-signed_exact_payment.json`,
      root: testFixture.root,
      scenarioId: "signed_exact_payment",
      ...RUNNER_TRUST,
      status: "passed",
      verificationMethod: "signed_webhook",
      workerVersion: WORKER_VERSION,
    })).resolves.toMatchObject({ artifact: { scenarioId: "signed_exact_payment" } });

    await expect(signPayosProviderExecutionArtifact({
      input: unsigned.artifactRef,
      keyId: RUNNER_KEY_ID,
      output,
      privateKeyPath,
      root: testFixture.root,
      signedAt: testFixture.now.toISOString(),
    })).rejects.toThrow("payos_uat_execution_sign_output_exists");
  });

  it("refuses to sign execution evidence reached through a symlinked ancestor", async () => {
    const testFixture = fixture();
    const unsigned = writeProviderExecutionArtifact(testFixture, "signed_exact_payment", {
      canonicalUnsigned: true,
      unsigned: true,
    });
    const executionDirectory = dirname(unsigned.path);
    const executionTarget = `${executionDirectory}-target`;
    renameSync(executionDirectory, executionTarget);
    symlinkSync(executionTarget, executionDirectory, "dir");
    const privateKeyPath = join(testFixture.root, ".wrangler", "runner-private.pem");
    writeFileSync(privateKeyPath, RUNNER_KEYS.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });

    await expect(signPayosProviderExecutionArtifact({
      input: unsigned.artifactRef,
      keyId: RUNNER_KEY_ID,
      output: `.wrangler/releases/staging/${testFixture.releaseId}/execution/payos-signed_exact_payment.json`,
      privateKeyPath,
      root: testFixture.root,
      signedAt: testFixture.now.toISOString(),
    })).rejects.toThrow("payos_uat_execution_sign_input_ancestor_invalid");
  });

  it("rejects a provider scenario without a separate private execution artifact", async () => {
    const testFixture = fixture();
    await expect(buildPayosScenarioArtifact({
      classification: "provider_supported",
      executionEvidencePath: null,
      manifestPath: testFixture.manifestPath,
      observedAt: testFixture.now.toISOString(),
      output: `.wrangler/releases/staging/${testFixture.releaseId}/scenarios/payos-signed_exact_payment.json`,
      root: testFixture.root,
      scenarioId: "signed_exact_payment",
      status: "passed",
      verificationMethod: "signed_webhook",
      workerVersion: WORKER_VERSION,
    })).rejects.toThrow("payos_uat_provider_execution_artifact_required");
  });

  it("rejects tampered or reused provider execution artifacts", async () => {
    const testFixture = fixture();
    const evidence = await completeUnsignedEvidence(testFixture);
    const executionPath = join(testFixture.root, `.wrangler/releases/staging/${testFixture.releaseId}/execution/payos-signed_exact_payment.json`);
    writeFileSync(executionPath, "{}\n", { mode: 0o600 });
    expect(() => readPayosProviderExecutionArtifacts({ evidence, repositoryRoot: testFixture.root, ...RUNNER_TRUST }))
      .toThrow("payos_uat_provider_execution_artifact_hash_mismatch");

    const restored = writeProviderExecutionArtifact(testFixture, "signed_exact_payment");
    const directPath = join(testFixture.root, `.wrangler/releases/staging/${testFixture.releaseId}/execution/payos-direct_reconciliation.json`);
    writeFileSync(directPath, readFileSync(restored.path), { mode: 0o600 });
    expect(() => readPayosProviderExecutionArtifacts({ evidence, repositoryRoot: testFixture.root, ...RUNNER_TRUST }))
      .toThrow(/payos_uat_provider_execution_artifact_(?:hash|binding)_mismatch/u);
  });

  it("rejects duplicate authoritative provider and D1 references", async () => {
    const testFixture = fixture();
    const evidence = await completeUnsignedEvidence(testFixture, { duplicateProviderRefs: true });
    expect(() => readPayosProviderExecutionArtifacts({ evidence, repositoryRoot: testFixture.root, ...RUNNER_TRUST }))
      .toThrow("payos_uat_provider_execution_reference_duplicate");
  });

  it("rejects unsigned, unpinned and arbitrary processed execution claims", async () => {
    const unsignedFixture = fixture();
    const unsigned = writeProviderExecutionArtifact(unsignedFixture, "signed_exact_payment", { unsigned: true });
    await expect(buildPayosScenarioArtifact({
      classification: "provider_supported",
      executionEvidencePath: unsigned.artifactRef,
      manifestPath: unsignedFixture.manifestPath,
      observedAt: unsignedFixture.now.toISOString(),
      output: `.wrangler/releases/staging/${unsignedFixture.releaseId}/scenarios/payos-signed_exact_payment.json`,
      root: unsignedFixture.root,
      scenarioId: "signed_exact_payment",
      status: "passed",
      verificationMethod: "signed_webhook",
      workerVersion: WORKER_VERSION,
      ...RUNNER_TRUST,
    })).rejects.toThrow("payos_uat_runner_attestation_required");

    const unpinnedFixture = fixture();
    const selfGenerated = generateKeyPairSync("ed25519");
    const unpinned = writeProviderExecutionArtifact(unpinnedFixture, "signed_exact_payment", { runnerKeys: selfGenerated });
    await expect(buildPayosScenarioArtifact({
      classification: "provider_supported",
      executionEvidencePath: unpinned.artifactRef,
      manifestPath: unpinnedFixture.manifestPath,
      observedAt: unpinnedFixture.now.toISOString(),
      output: `.wrangler/releases/staging/${unpinnedFixture.releaseId}/scenarios/payos-signed_exact_payment.json`,
      root: unpinnedFixture.root,
      scenarioId: "signed_exact_payment",
      status: "passed",
      verificationMethod: "signed_webhook",
      workerVersion: WORKER_VERSION,
      ...RUNNER_TRUST,
    })).rejects.toThrow(/payos_uat_runner_attestation_(?:fingerprint_mismatch|invalid)/u);

    const arbitraryFixture = fixture();
    const arbitrary = writeProviderExecutionArtifact(arbitraryFixture, "signed_exact_payment", { processed: false });
    await expect(buildPayosScenarioArtifact({
      classification: "provider_supported",
      executionEvidencePath: arbitrary.artifactRef,
      manifestPath: arbitraryFixture.manifestPath,
      observedAt: arbitraryFixture.now.toISOString(),
      output: `.wrangler/releases/staging/${arbitraryFixture.releaseId}/scenarios/payos-signed_exact_payment.json`,
      root: arbitraryFixture.root,
      scenarioId: "signed_exact_payment",
      status: "passed",
      verificationMethod: "signed_webhook",
      workerVersion: WORKER_VERSION,
      ...RUNNER_TRUST,
    })).rejects.toThrow("payos_uat_provider_execution_result_invalid");
  });

  it("rejects execution artifacts reached through a symlinked ancestor", async () => {
    const testFixture = fixture();
    const releaseRoot = join(testFixture.root, `.wrangler/releases/staging/${testFixture.releaseId}`);
    const external = join(testFixture.root, "external-execution");
    mkdirSync(external, { recursive: true });
    symlinkSync(external, join(releaseRoot, "execution"));
    const execution = writeProviderExecutionArtifact(testFixture, "signed_exact_payment");
    await expect(buildPayosScenarioArtifact({
      classification: "provider_supported",
      executionEvidencePath: execution.artifactRef,
      manifestPath: testFixture.manifestPath,
      observedAt: testFixture.now.toISOString(),
      output: `.wrangler/releases/staging/${testFixture.releaseId}/scenarios/payos-signed_exact_payment.json`,
      root: testFixture.root,
      scenarioId: "signed_exact_payment",
      status: "passed",
      verificationMethod: "signed_webhook",
      workerVersion: WORKER_VERSION,
      ...RUNNER_TRUST,
    })).rejects.toThrow("payos_uat_provider_execution_artifact_ancestor_invalid");
  });

  it("assembles canonical unsigned evidence from verified scenario artifacts", async () => {
    const testFixture = fixture();
    await completeUnsignedEvidence(testFixture);
    const output = join(testFixture.root, `.wrangler/releases/staging/${testFixture.releaseId}/payos-uat-evidence.unsigned.json`);
    const result = await collectPayosUatEvidence({
      completedAt: testFixture.now.toISOString(),
      createdAt: new Date(testFixture.now.getTime() - 30_000).toISOString(),
      manifestPath: testFixture.manifestPath,
      output,
      root: testFixture.root,
      ...RUNNER_TRUST,
      workerVersion: WORKER_VERSION,
    });
    expect(statSync(result.evidencePath).mode & 0o777).toBe(0o600);
    expect(result.evidence).toMatchObject({
      evidenceKind: "provider_acceptance",
      providerExecution: {
        controlledAccountFingerprintSha256: CONTROLLED_ACCOUNT_FINGERPRINT,
        realLowValueTransactionObserved: true,
        syntheticSignatureUsed: false,
      },
      schemaVersion: 2,
    });
    const providerExecution = (result.evidence as { providerExecution: { transactionEvidenceFingerprintSha256: string } }).providerExecution;
    expect(providerExecution.transactionEvidenceFingerprintSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects noncanonical output and fingerprint scope escalation", async () => {
    const testFixture = fixture();
    await expect(buildPayosScenarioArtifact({
      classification: "selinow_local_assurance",
      executionEvidencePath: `.wrangler/releases/staging/${testFixture.releaseId}/execution/payos-invalid_signature.json`,
      manifestPath: testFixture.manifestPath,
      observedAt: testFixture.now.toISOString(),
      output: `.wrangler/releases/staging/${testFixture.releaseId}/scenarios/payos-invalid_signature.json`,
      root: testFixture.root,
      scenarioId: "invalid_signature",
      status: "passed",
      verificationMethod: "local_contract",
      workerVersion: WORKER_VERSION,
    })).rejects.toThrow("payos_uat_provider_execution_artifact_scope_invalid");
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
      ...RUNNER_TRUST,
    });
    expect(statSync(signed.evidencePath).mode & 0o777).toBe(0o600);
    const ownerPublicKey = keys.publicKey.export({ format: "pem", type: "spki" });
    const validation = await validatePayosUatEvidenceFile({
      evidencePath: signed.evidencePath,
      manifestPath: testFixture.manifestPath,
      now: testFixture.now,
      ownerAttestationPublicKeys: { "release-owner-test": ownerPublicKey },
      root: testFixture.root,
      ...RUNNER_TRUST,
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
    expect(packageJson.scripts["payos:uat:collect"]).toBe("node scripts/payos-uat-collect.mjs");
    expect(packageJson.scripts["payos:uat:execution:sign"]).toBe("node scripts/payos-uat-execution-sign.mjs");
    expect(packageJson.scripts["payos:uat:sign"]).toBe("node scripts/payos-uat-sign.mjs");
    expect(packageJson.scripts["payos:uat:validate"]).toBe("node scripts/payos-uat-validate.mjs");
  });
});
