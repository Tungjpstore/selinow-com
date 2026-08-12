import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  DODO_CONTROLLED_CONCURRENCY_SCENARIO_IDS,
  DODO_CONTROLLED_NEGATIVE_SCENARIO_IDS,
  DODO_SCENARIO_EXECUTION_CONTRACTS,
  DODO_STAGING_UAT_SCENARIO_IDS,
  assertDodoStagingUatEvidence,
  assertCanonicalDodoUatEvidencePath,
  collectDodoStagingUatEvidence,
  fingerprintDodoStagingUatEvidence,
  fingerprintDodoUatExecutionProofPublicKey,
  fingerprintDodoUatReference,
  readDodoUatExecutionProofArtifacts,
  serializeDodoUatExecutionProofPayload,
} from "../../scripts/lib/dodo-uat-evidence.mjs";
import type { DodoStagingUatEvidence, DodoUatExecutionProofArtifact } from "../../scripts/lib/dodo-uat-evidence.mjs";

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const MANIFEST_SHA = "c".repeat(64);
const RELEASE_ID = `stg_20260808T090000Z_${COMMIT_SHA.slice(0, 12)}`;
const MANIFEST_REF = `.wrangler/releases/staging/${RELEASE_ID}/release-manifest.json`;
const WORKER_VERSION = "f18fc9e8-4bf4-4e2a-b953-178e91a91f43";
const CREATED_AT = "2026-08-08T09:00:00.000Z";
const COMPLETED_AT = "2026-08-08T10:00:00.000Z";
const KEY_ID = "dodo-staging-runner-v1";
const KEYS = generateKeyPairSync("ed25519");
const PUBLIC_KEY = KEYS.publicKey.export({ format: "pem", type: "spki" });
const APPROVED_EXECUTION_PROOF_TRUST = {
  keyId: KEY_ID,
  spkiSha256: fingerprintDodoUatExecutionProofPublicKey(PUBLIC_KEY),
};

const release = {
  releaseId: RELEASE_ID,
  commitSha: COMMIT_SHA,
  treeSha: TREE_SHA,
  manifestRef: MANIFEST_REF,
  manifestSha256: MANIFEST_SHA,
  workerVersion: WORKER_VERSION,
};

const binding = {
  ...release,
  approvedExecutionProofTrust: APPROVED_EXECUTION_PROOF_TRUST,
  executionProofPublicKeys: { [KEY_ID]: PUBLIC_KEY },
};

const offers = [
  { planCode: "starter", marketCode: "vn", currency: "VND", amountMinor: 99_000, interval: "month", providerReferenceFingerprintSha256: "1".repeat(64) },
  { planCode: "pro", marketCode: "vn", currency: "VND", amountMinor: 299_000, interval: "month", providerReferenceFingerprintSha256: "2".repeat(64) },
  { planCode: "starter", marketCode: "global", currency: "USD", amountMinor: 500, interval: "month", providerReferenceFingerprintSha256: "3".repeat(64) },
  { planCode: "pro", marketCode: "global", currency: "USD", amountMinor: 1_500, interval: "month", providerReferenceFingerprintSha256: "4".repeat(64) },
] as DodoStagingUatEvidence["offers"];

function sha(index: number, offset = 0) {
  return (index * 10 + offset + 1).toString(16).padStart(64, "0");
}

function observedAt(index: number) {
  return new Date(new Date(CREATED_AT).getTime() + ((index + 1) * 1_000)).toISOString();
}

function executionProof(scenarioId: string, index: number) {
  const contract = DODO_SCENARIO_EXECUTION_CONTRACTS[scenarioId];
  if (contract === undefined) throw new Error(`missing_contract:${scenarioId}`);
  const providerEvidenceRequired = contract.signatureAuthority !== "none";
  const relatedIndex = contract.relatedScenarioId === null ? null : DODO_STAGING_UAT_SCENARIO_IDS.indexOf(contract.relatedScenarioId);
  if (relatedIndex !== null && relatedIndex < 0) throw new Error(`missing_related_contract:${scenarioId}`);
  const sameEventReplay = contract.relationship === "same_event_replay";
  const sameEventIdentity = sameEventReplay || contract.relationship === "same_event_conflicting_payload";
  const d1BeforeSha256 = relatedIndex === null ? sha(index, 3) : sha(relatedIndex, 4);
  const scenarioObservedAt = observedAt(index);
  const artifact = {
    schemaVersion: 2,
    artifactKind: "dodo_uat_execution_proof",
    provider: "dodo",
    environment: "staging",
    providerEnvironment: "test_mode",
    scenarioId,
    release,
    observedAt: scenarioObservedAt,
    result: "passed",
    outcome: contract.outcome,
    executionMode: contract.executionMode,
    verificationMethod: contract.verificationMethod,
    authority: {
      runnerId: "selinow-dodo-staging-runner-v1",
      eventSource: contract.eventSource,
      signatureAuthority: contract.signatureAuthority,
      controlledInjection: contract.controlledInjection,
    },
    references: {
      requestReference: `request:req_${String(index).padStart(4, "0")}`,
      eventReference: contract.requiresEventReference ? `event:evt_${String(sameEventIdentity && relatedIndex !== null ? relatedIndex : index).padStart(4, "0")}` : null,
      sessionReference: contract.requiresSessionReference ? `session:ses_${String(relatedIndex ?? index).padStart(4, "0")}` : null,
    },
    fingerprints: {
      executionTranscriptSha256: sha(index, 0),
      providerEventSha256: providerEvidenceRequired ? sha(sameEventReplay && relatedIndex !== null ? relatedIndex : index, 1) : null,
      providerSignatureSha256: providerEvidenceRequired ? sha(sameEventReplay && relatedIndex !== null ? relatedIndex : index, 2) : null,
      d1BeforeSha256,
      d1AfterSha256: contract.stateEffect === "no_op" ? d1BeforeSha256 : sha(index, 4),
      d1TransitionSha256: sha(index, 5),
    },
    state: {
      before: contract.stateBefore,
      after: contract.stateAfter,
      effect: contract.stateEffect,
    },
    relatedScenario: contract.relatedScenarioId === null ? null : {
      scenarioId: contract.relatedScenarioId,
      relationship: contract.relationship,
    },
    redaction: {
      noRawPayload: true,
      noSensitiveValues: true,
      noCustomerData: true,
      noPaymentInstrumentData: true,
    },
    attestation: {
      algorithm: "ed25519",
      keyId: KEY_ID,
      signedAt: scenarioObservedAt,
      signatureBase64: "",
    },
  };
  artifact.attestation.signatureBase64 = sign(
    null,
    Buffer.from(serializeDodoUatExecutionProofPayload(artifact)),
    KEYS.privateKey,
  ).toString("base64");
  return artifact;
}

function writeExecutionProofs(root: string, mutate?: (artifact: ReturnType<typeof executionProof>, scenarioId: string) => void) {
  const proofArtifacts: Record<string, { artifactRef: string; artifactSha256: string }> = {};
  DODO_STAGING_UAT_SCENARIO_IDS.forEach((scenarioId, index) => {
    const artifact = executionProof(scenarioId, index);
    mutate?.(artifact, scenarioId);
    const artifactRef = `artifact:.wrangler/releases/staging/${RELEASE_ID}/dodo-uat-execution-proofs/${scenarioId}.json`;
    const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
    const path = `${root}/${artifactRef.slice("artifact:".length)}`;
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, bytes, { mode: 0o600 });
    proofArtifacts[scenarioId] = {
      artifactRef,
      artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  return proofArtifacts;
}

function rewriteProof(
  root: string,
  proofArtifacts: Record<string, { artifactRef: string; artifactSha256: string }>,
  scenarioId: string,
  mutate: (artifact: DodoUatExecutionProofArtifact) => void,
) {
  const descriptor = proofArtifacts[scenarioId];
  if (descriptor === undefined) throw new Error(`missing_proof:${scenarioId}`);
  const path = `${root}/${descriptor.artifactRef.slice("artifact:".length)}`;
  const artifact = JSON.parse(readFileSync(path, "utf8")) as DodoUatExecutionProofArtifact;
  mutate(artifact);
  artifact.attestation.signatureBase64 = sign(
    null,
    Buffer.from(serializeDodoUatExecutionProofPayload(artifact)),
    KEYS.privateKey,
  ).toString("base64");
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  writeFileSync(path, bytes, { mode: 0o600 });
  descriptor.artifactSha256 = createHash("sha256").update(bytes).digest("hex");
}

async function collectFixture(root: string, proofArtifacts = writeExecutionProofs(root)) {
  return collectDodoStagingUatEvidence({
    approvedExecutionProofTrust: APPROVED_EXECUTION_PROOF_TRUST,
    completedAt: COMPLETED_AT,
    createdAt: CREATED_AT,
    endpointFingerprintSha256: "d".repeat(64),
    executionProofPublicKeys: { [KEY_ID]: PUBLIC_KEY },
    offers,
    proofArtifacts,
    release,
    repositoryRoot: root,
  });
}

describe("Dodo staging UAT execution evidence", () => {
  it("accepts only 32 independently signed mode-0600 execution proofs", async () => {
    const root = mkdtempSync(`${tmpdir()}/dodo-uat-proof-`);
    try {
      const collected = await collectFixture(root);
      const verifiedExecutionProofs = readDodoUatExecutionProofArtifacts({
        approvedExecutionProofTrust: APPROVED_EXECUTION_PROOF_TRUST,
        evidence: collected.evidence,
        executionProofPublicKeys: { [KEY_ID]: PUBLIC_KEY },
        repositoryRoot: root,
      });

      expect(assertDodoStagingUatEvidence(collected.evidence, {
        ...binding,
        verifiedExecutionProofs,
      })).toEqual({
        accepted: true,
        evidenceFingerprintSha256: fingerprintDodoStagingUatEvidence(collected.evidence),
        releaseId: RELEASE_ID,
        scenarioCount: 32,
        workerVersion: WORKER_VERSION,
      });
      expect(statSync(collected.evidencePath).mode & 0o777).toBe(0o600);
      expect(Object.keys(verifiedExecutionProofs)).toHaveLength(32);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects the legacy operator-authored passed-claim collector input", async () => {
    const root = mkdtempSync(`${tmpdir()}/dodo-uat-self-claim-`);
    try {
      await expect(collectDodoStagingUatEvidence({
        approvedExecutionProofTrust: APPROVED_EXECUTION_PROOF_TRUST,
        completedAt: COMPLETED_AT,
        createdAt: CREATED_AT,
        endpointFingerprintSha256: "d".repeat(64),
        executionProofPublicKeys: { [KEY_ID]: PUBLIC_KEY },
        offers,
        release,
        repositoryRoot: root,
        scenarios: Object.fromEntries(DODO_STAGING_UAT_SCENARIO_IDS.map((id) => [id, {
          status: "passed",
          observedAt: observedAt(0),
          requestReference: `request:${id}`,
          eventReference: null,
          sessionReference: null,
        }])),
      } as never)).rejects.toThrow("dodo_uat_collection_input_invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsigned, untrusted, tampered, and hash-conflicting proof artifacts", async () => {
    const cases = [
      ["unsigned", (artifact: ReturnType<typeof executionProof>, id: string) => {
        if (id === "starter_checkout") artifact.attestation.signatureBase64 = "";
      }, "dodo_uat_execution_proof_attestation_invalid"],
      ["tampered", (artifact: ReturnType<typeof executionProof>, id: string) => {
        if (id === "starter_checkout") artifact.result = "failed";
      }, "dodo_uat_execution_proof_not_passed"],
      ["unsafe", (artifact: ReturnType<typeof executionProof>, id: string) => {
        if (id === "starter_checkout") Object.assign(artifact, { rawPayload: "{}" });
      }, "dodo_uat_field_unsafe"],
    ] as const;
    for (const [label, mutate, issue] of cases) {
      const root = mkdtempSync(`${tmpdir()}/dodo-uat-${label}-`);
      try {
        await expect(collectFixture(root, writeExecutionProofs(root, mutate))).rejects.toThrow(issue);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const root = mkdtempSync(`${tmpdir()}/dodo-uat-untrusted-`);
    try {
      const proofArtifacts = writeExecutionProofs(root);
      await expect(collectDodoStagingUatEvidence({
        approvedExecutionProofTrust: APPROVED_EXECUTION_PROOF_TRUST,
        completedAt: COMPLETED_AT,
        createdAt: CREATED_AT,
        endpointFingerprintSha256: "d".repeat(64),
        executionProofPublicKeys: {},
        offers,
        proofArtifacts,
        release,
        repositoryRoot: root,
      })).rejects.toThrow("dodo_uat_execution_proof_attestation_untrusted");

      const collected = await collectFixture(root, proofArtifacts);
      const reboundEvidence = structuredClone(collected.evidence);
      reboundEvidence.executionProofTrustFingerprintSha256 = "e".repeat(64);
      expect(() => assertDodoStagingUatEvidence(reboundEvidence, {
        ...release,
        approvedExecutionProofTrust: { keyId: KEY_ID, spkiSha256: "e".repeat(64) },
        verifiedExecutionProofs: collected.verifiedExecutionProofs,
      })).toThrow("dodo_uat_execution_proof_trust_mismatch");

      const first = proofArtifacts.starter_checkout;
      if (first === undefined) throw new Error("missing_starter_proof");
      first.artifactSha256 = "f".repeat(64);
      await expect(collectFixture(root, proofArtifacts)).rejects.toThrow("dodo_uat_execution_proof_hash_mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an out-of-band approved key ID and SPKI fingerprint in addition to the keyring", async () => {
    const root = mkdtempSync(`${tmpdir()}/dodo-uat-trust-anchor-`);
    try {
      const proofArtifacts = writeExecutionProofs(root);
      await expect(collectDodoStagingUatEvidence({
        completedAt: COMPLETED_AT,
        createdAt: CREATED_AT,
        endpointFingerprintSha256: "d".repeat(64),
        executionProofPublicKeys: { [KEY_ID]: PUBLIC_KEY },
        offers,
        proofArtifacts,
        release,
        repositoryRoot: root,
      } as never)).rejects.toThrow("dodo_uat_collection_input_invalid");

      await expect(collectDodoStagingUatEvidence({
        approvedExecutionProofTrust: { keyId: KEY_ID, spkiSha256: "e".repeat(64) },
        completedAt: COMPLETED_AT,
        createdAt: CREATED_AT,
        endpointFingerprintSha256: "d".repeat(64),
        executionProofPublicKeys: { [KEY_ID]: PUBLIC_KEY },
        offers,
        proofArtifacts,
        release,
        repositoryRoot: root,
      })).rejects.toThrow("dodo_uat_execution_proof_attestation_untrusted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces scenario outcomes, state effects, and replay/order relationships", async () => {
    const cases = [
      ["outcome", "duplicate_webhook", (artifact: DodoUatExecutionProofArtifact) => { artifact.outcome = "accepted"; }, "dodo_uat_execution_proof_outcome_invalid"],
      ["no-op", "duplicate_webhook", (artifact: DodoUatExecutionProofArtifact) => { artifact.fingerprints.d1AfterSha256 = "e".repeat(64); }, "dodo_uat_execution_proof_no_op_invalid"],
      ["transition", "payment_succeeded_exactly_once", (artifact: DodoUatExecutionProofArtifact) => { artifact.fingerprints.d1AfterSha256 = artifact.fingerprints.d1BeforeSha256; }, "dodo_uat_execution_proof_transition_invalid"],
      ["duplicate-replay", "duplicate_webhook", (artifact: DodoUatExecutionProofArtifact) => { artifact.fingerprints.providerEventSha256 = "e".repeat(64); }, "dodo_uat_execution_proof_replay_relationship_invalid"],
      ["conflicting-replay", "conflicting_duplicate_event", (artifact: DodoUatExecutionProofArtifact) => { artifact.fingerprints.providerEventSha256 = sha(DODO_STAGING_UAT_SCENARIO_IDS.indexOf("payment_succeeded_exactly_once"), 1); }, "dodo_uat_execution_proof_conflict_relationship_invalid"],
      ["stale-state", "stale_timestamp", (artifact: DodoUatExecutionProofArtifact) => { artifact.fingerprints.d1BeforeSha256 = "e".repeat(64); artifact.fingerprints.d1AfterSha256 = "e".repeat(64); }, "dodo_uat_execution_proof_relationship_state_invalid"],
      ["out-of-order-time", "out_of_order_webhook", (artifact: DodoUatExecutionProofArtifact) => { artifact.observedAt = observedAt(DODO_STAGING_UAT_SCENARIO_IDS.indexOf("renewal_success")); artifact.attestation.signedAt = artifact.observedAt; }, "dodo_uat_execution_proof_relationship_order_invalid"],
    ] as const;
    for (const [label, scenarioId, mutate, issue] of cases) {
      const root = mkdtempSync(`${tmpdir()}/dodo-uat-${label}-`);
      try {
        const proofArtifacts = writeExecutionProofs(root);
        rewriteProof(root, proofArtifacts, scenarioId, mutate);
        await expect(collectFixture(root, proofArtifacts)).rejects.toThrow(issue);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("enforces provider-signature, D1-transition, and controlled-runner requirements per scenario", async () => {
    const cases = [
      ["payment_succeeded_exactly_once", (artifact: ReturnType<typeof executionProof>) => { artifact.fingerprints.providerSignatureSha256 = null; }, "dodo_uat_execution_proof_provider_signature_required"],
      ["renewal_success", (artifact: ReturnType<typeof executionProof>) => { (artifact.fingerprints as { d1TransitionSha256: string | null }).d1TransitionSha256 = null; }, "dodo_uat_execution_proof_d1_transition_required"],
      ["amount_mismatch", (artifact: ReturnType<typeof executionProof>) => { artifact.authority.signatureAuthority = "dodo"; }, "dodo_uat_execution_proof_authority_invalid"],
      ["concurrent_duplicate_checkout", (artifact: ReturnType<typeof executionProof>) => { artifact.authority.controlledInjection = "none"; }, "dodo_uat_execution_proof_authority_invalid"],
    ] as const;
    for (const [scenario, mutate, issue] of cases) {
      const root = mkdtempSync(`${tmpdir()}/dodo-uat-contract-`);
      try {
        const proofArtifacts = writeExecutionProofs(root, (artifact, scenarioId) => {
          if (scenarioId !== scenario) return;
          mutate(artifact);
          artifact.attestation.signatureBase64 = sign(
            null,
            Buffer.from(serializeDodoUatExecutionProofPayload(artifact)),
            KEYS.privateKey,
          ).toString("base64");
          const path = `${root}/.wrangler/releases/staging/${RELEASE_ID}/dodo-uat-execution-proofs/${scenarioId}.json`;
          const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
          writeFileSync(path, bytes, { mode: 0o600 });
        });
        // Recompute hashes because the proof writer mutation replaces the bytes.
        for (const id of DODO_STAGING_UAT_SCENARIO_IDS) {
          const record = proofArtifacts[id];
          if (record === undefined) throw new Error(`missing_proof:${id}`);
          const bytes = readFileSync(`${root}/${record.artifactRef.slice("artifact:".length)}`);
          record.artifactSha256 = createHash("sha256").update(bytes).digest("hex");
        }
        await expect(collectFixture(root, proofArtifacts)).rejects.toThrow(issue);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects reused request/transcript evidence across otherwise valid proofs", async () => {
    const root = mkdtempSync(`${tmpdir()}/dodo-uat-duplicate-proof-`);
    try {
      let original: ReturnType<typeof executionProof> | null = null;
      const proofArtifacts = writeExecutionProofs(root, (artifact, scenarioId) => {
        if (scenarioId === "starter_checkout") original = structuredClone(artifact);
        if (scenarioId !== "pro_checkout" || original === null) return;
        artifact.references.requestReference = original.references.requestReference;
        artifact.fingerprints.executionTranscriptSha256 = original.fingerprints.executionTranscriptSha256;
        artifact.attestation.signatureBase64 = sign(
          null,
          Buffer.from(serializeDodoUatExecutionProofPayload(artifact)),
          KEYS.privateKey,
        ).toString("base64");
      });
      await expect(collectFixture(root, proofArtifacts)).rejects.toThrow(/dodo_uat_execution_proof_(?:reference|transcript)_duplicate/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a controlled negative or concurrency proof is unavailable", async () => {
    expect(DODO_CONTROLLED_NEGATIVE_SCENARIO_IDS).toContain("amount_mismatch");
    expect(DODO_CONTROLLED_CONCURRENCY_SCENARIO_IDS).toEqual(["checkout_response_loss", "concurrent_duplicate_checkout"]);
    const root = mkdtempSync(`${tmpdir()}/dodo-uat-missing-runner-`);
    try {
      const proofArtifacts = writeExecutionProofs(root);
      delete proofArtifacts.amount_mismatch;
      await expect(collectFixture(root, proofArtifacts)).rejects.toThrow("dodo_uat_execution_proof_set_invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects non-private proof artifacts and release drift", async () => {
    const root = mkdtempSync(`${tmpdir()}/dodo-uat-permissions-`);
    try {
      const proofArtifacts = writeExecutionProofs(root);
      const starter = proofArtifacts.starter_checkout;
      if (starter === undefined) throw new Error("missing_starter_proof");
      chmodSync(`${root}/${starter.artifactRef.slice("artifact:".length)}`, 0o644);
      await expect(collectFixture(root, proofArtifacts)).rejects.toThrow("dodo_uat_execution_proof_permissions_invalid");

      chmodSync(`${root}/${starter.artifactRef.slice("artifact:".length)}`, 0o600);
      const artifact = JSON.parse(readFileSync(`${root}/${starter.artifactRef.slice("artifact:".length)}`, "utf8")) as unknown as DodoUatExecutionProofArtifact;
      artifact.release.workerVersion = "other-worker-version";
      artifact.attestation.signatureBase64 = sign(
        null,
        Buffer.from(serializeDodoUatExecutionProofPayload(artifact)),
        KEYS.privateKey,
      ).toString("base64");
      const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
      writeFileSync(`${root}/${starter.artifactRef.slice("artifact:".length)}`, bytes, { mode: 0o600 });
      starter.artifactSha256 = createHash("sha256").update(bytes).digest("hex");
      await expect(collectFixture(root, proofArtifacts)).rejects.toThrow("dodo_uat_execution_proof_binding_invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects non-canonical evidence paths and symlinked proof/evidence ancestors", async () => {
    const proofRoot = mkdtempSync(`${tmpdir()}/dodo-uat-proof-symlink-`);
    try {
      const proofArtifacts = writeExecutionProofs(proofRoot);
      const proofDirectory = `${proofRoot}/.wrangler/releases/staging/${RELEASE_ID}/dodo-uat-execution-proofs`;
      const movedProofDirectory = `${proofRoot}/.wrangler/releases/staging/${RELEASE_ID}/proofs-real`;
      renameSync(proofDirectory, movedProofDirectory);
      symlinkSync(movedProofDirectory, proofDirectory, "dir");
      await expect(collectFixture(proofRoot, proofArtifacts)).rejects.toThrow("dodo_uat_execution_proof_path_invalid");
    } finally {
      rmSync(proofRoot, { recursive: true, force: true });
    }

    const evidenceRoot = mkdtempSync(`${tmpdir()}/dodo-uat-evidence-symlink-`);
    try {
      const collected = await collectFixture(evidenceRoot);
      expect(assertCanonicalDodoUatEvidencePath({
        evidencePath: collected.evidencePath,
        releaseId: RELEASE_ID,
        repositoryRoot: evidenceRoot,
      })).toBe(collected.evidencePath);
      expect(() => assertCanonicalDodoUatEvidencePath({
        evidencePath: `${evidenceRoot}/dodo-uat-evidence.json`,
        releaseId: RELEASE_ID,
        repositoryRoot: evidenceRoot,
      })).toThrow("dodo_uat_evidence_path_invalid");

      const movedEvidence = `${collected.evidencePath}.real`;
      renameSync(collected.evidencePath, movedEvidence);
      symlinkSync(movedEvidence, collected.evidencePath);
      expect(() => assertCanonicalDodoUatEvidencePath({
        evidencePath: collected.evidencePath,
        releaseId: RELEASE_ID,
        repositoryRoot: evidenceRoot,
      })).toThrow("dodo_uat_evidence_path_invalid");
    } finally {
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("preserves exact offer and endpoint contracts without exposing provider references", () => {
    expect(fingerprintDodoUatReference("endpoint", "https://api-staging.selinow.com/api/webhooks/billing/dodo/opaque")).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprintDodoUatReference("endpoint", "same-reference")).not.toBe(fingerprintDodoUatReference("offer:starter:vn", "same-reference"));
    expect(() => fingerprintDodoUatReference("secret", "private-value")).toThrow("dodo_uat_fingerprint_scope_invalid");
  });

  it("ships a fail-closed contract-gap example, not a provider acceptance claim", () => {
    const source = readFileSync("infra/release/dodo-uat-evidence.example.json", "utf8");
    const example = JSON.parse(source) as { evidenceKind?: string; acceptanceReasonCode?: string; scenarioContracts?: Record<string, unknown> };
    expect(example.evidenceKind).toBe("contract_gap");
    expect(example.acceptanceReasonCode).toBe("dodo_genuine_execution_proofs_not_collected");
    expect(Object.keys(example.scenarioContracts ?? {}).sort()).toEqual([...DODO_STAGING_UAT_SCENARIO_IDS].sort());
    expect(source).not.toMatch(/Bearer |whsec_|"(?:apiKey|webhookKey|webhookSecret|rawBody|rawPayload|checkoutUrl|customerEmail|customerPhone|customerAddress|cardNumber)"\s*:/iu);
  });
});
