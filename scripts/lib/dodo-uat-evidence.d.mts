export const DODO_STAGING_UAT_SCENARIO_IDS: readonly string[];
export const DODO_CONTROLLED_NEGATIVE_SCENARIO_IDS: readonly string[];
export const DODO_CONTROLLED_CONCURRENCY_SCENARIO_IDS: readonly string[];

export type DodoUatRelease = {
  releaseId: string;
  commitSha: string;
  treeSha: string;
  manifestRef: string;
  manifestSha256: string;
  workerVersion: string;
};

export type DodoScenarioExecutionContract = {
  controlledInjection: string;
  eventSource: "controlled_runner" | "dodo_signed_webhook" | "dodo_test_api" | "none";
  executionMode: "controlled_checkout_fault" | "controlled_clock_transition" | "controlled_negative_webhook" | "controlled_runtime_probe" | "provider_catalog_observation" | "provider_checkout_observation" | "provider_webhook_observation";
  requiresEventReference: boolean;
  requiresSessionReference: boolean;
  outcome: string;
  relatedScenarioId: string | null;
  relationship: "out_of_order_event" | "same_event_conflicting_payload" | "same_event_replay" | "stale_event" | null;
  signatureAuthority: "controlled_runner" | "dodo" | "none";
  stateAfter: string;
  stateBefore: string;
  stateEffect: "no_op" | "transition";
  verificationMethod: "controlled_clock_and_d1" | "controlled_concurrency" | "controlled_network_fault" | "controlled_signed_webhook_injection" | "provider_api_and_d1" | "provider_checkout_and_d1" | "provider_signed_webhook_and_d1" | "staging_runtime_and_d1";
};

export const DODO_SCENARIO_EXECUTION_CONTRACTS: Readonly<Record<string, Readonly<DodoScenarioExecutionContract>>>;

export type DodoUatExecutionProofArtifact = {
  schemaVersion: 2;
  artifactKind: "dodo_uat_execution_proof";
  provider: "dodo";
  environment: "staging";
  providerEnvironment: "test_mode";
  scenarioId: string;
  release: DodoUatRelease;
  observedAt: string;
  result: "passed";
  outcome: string;
  executionMode: DodoScenarioExecutionContract["executionMode"];
  verificationMethod: DodoScenarioExecutionContract["verificationMethod"];
  authority: {
    runnerId: string;
    eventSource: DodoScenarioExecutionContract["eventSource"];
    signatureAuthority: DodoScenarioExecutionContract["signatureAuthority"];
    controlledInjection: string;
  };
  references: {
    requestReference: string;
    eventReference: string | null;
    sessionReference: string | null;
  };
  state: {
    before: string;
    after: string;
    effect: "no_op" | "transition";
  };
  relatedScenario: {
    scenarioId: string;
    relationship: "out_of_order_event" | "same_event_conflicting_payload" | "same_event_replay" | "stale_event";
  } | null;
  fingerprints: {
    executionTranscriptSha256: string;
    providerEventSha256: string | null;
    providerSignatureSha256: string | null;
    d1BeforeSha256: string;
    d1AfterSha256: string;
    d1TransitionSha256: string;
  };
  redaction: {
    noRawPayload: true;
    noSensitiveValues: true;
    noCustomerData: true;
    noPaymentInstrumentData: true;
  };
  attestation: {
    algorithm: "ed25519";
    keyId: string;
    signedAt: string;
    signatureBase64: string;
  };
};

export type DodoVerifiedExecutionProof = {
  artifactSha256: string;
  artifactRef: string;
  attestationKeyId: string;
  attestationSpkiSha256: string;
  d1AfterSha256: string;
  d1BeforeSha256: string;
  eventReference: string | null;
  executionMode: DodoScenarioExecutionContract["executionMode"];
  executionTranscriptSha256: string;
  d1TransitionSha256: string;
  observedAt: string;
  outcome: string;
  providerEventSha256: string | null;
  providerSignatureSha256: string | null;
  relatedScenario: DodoUatExecutionProofArtifact["relatedScenario"];
  requestReference: string;
  sessionReference: string | null;
  state: DodoUatExecutionProofArtifact["state"];
  verificationMethod: DodoScenarioExecutionContract["verificationMethod"];
};

export type DodoStagingUatEvidence = {
  schemaVersion: 3;
  evidenceKind: "provider_acceptance";
  environment: "staging";
  provider: "dodo";
  providerEnvironment: "test_mode";
  scenarioPolicyVersion: "dodo_uat_v3";
  release: DodoUatRelease;
  executionProofTrustFingerprintSha256: string;
  endpointFingerprintSha256: string;
  offers: Array<{
    planCode: "starter" | "pro";
    marketCode: "vn" | "global";
    currency: "VND" | "USD";
    amountMinor: number;
    interval: "month";
    providerReferenceFingerprintSha256: string;
  }>;
  scenarios: Record<string, {
    status: "passed";
    outcome: string;
    state: DodoUatExecutionProofArtifact["state"];
    relatedScenario: DodoUatExecutionProofArtifact["relatedScenario"];
    observedAt: string;
    evidenceFingerprintSha256: string;
    proofReference: string;
    requestReference: string;
    eventReference: string | null;
    sessionReference: string | null;
    executionMode: DodoScenarioExecutionContract["executionMode"];
    verificationMethod: DodoScenarioExecutionContract["verificationMethod"];
    attestationKeyId: string;
  }>;
  redaction: {
    d1NoRawPayload: true;
    d1NoHostedCheckoutUrl: true;
    d1NoSecretValues: true;
    logsNoSensitiveValues: true;
    queuesNoSensitiveValues: true;
    auditNoSensitiveValues: true;
    evidenceFingerprintSha256: string;
  };
  createdAt: string;
  completedAt: string;
};

export type DodoStagingUatBinding = DodoUatRelease & {
  approvedExecutionProofTrust: DodoApprovedExecutionProofTrust;
  executionProofPublicKeys?: Record<string, string>;
  verifiedExecutionProofs?: Record<string, DodoVerifiedExecutionProof>;
};

export type DodoApprovedExecutionProofTrust = {
  keyId: string;
  spkiSha256: string;
};

export function serializeDodoUatExecutionProofPayload(proof: unknown): string;
export function fingerprintDodoStagingUatEvidence(evidence: unknown): string;
export function fingerprintDodoUatReference(scope: string, value: string): string;
export function fingerprintDodoUatExecutionProofPublicKey(publicKeyPem: string): string;
export function assertCanonicalDodoUatEvidencePath(input: {
  evidencePath: string;
  releaseId: string;
  repositoryRoot: string;
}): string;

export function readDodoUatExecutionProofArtifacts(input: {
  evidence: DodoStagingUatEvidence;
  approvedExecutionProofTrust: DodoApprovedExecutionProofTrust;
  executionProofPublicKeys: Record<string, string>;
  repositoryRoot: string;
}): Record<string, DodoVerifiedExecutionProof>;

export const readDodoUatScenarioArtifacts: typeof readDodoUatExecutionProofArtifacts;

export function collectDodoStagingUatEvidence(input: {
  approvedExecutionProofTrust: DodoApprovedExecutionProofTrust;
  completedAt: string;
  createdAt: string;
  endpointFingerprintSha256: string;
  executionProofPublicKeys: Record<string, string>;
  offers: DodoStagingUatEvidence["offers"];
  proofArtifacts: Record<string, { artifactRef: string; artifactSha256: string }>;
  release: DodoUatRelease;
  repositoryRoot: string;
}): Promise<{
  artifactSha256: string;
  evidence: DodoStagingUatEvidence;
  evidencePath: string;
  evidenceRef: string;
  verifiedExecutionProofs: Record<string, DodoVerifiedExecutionProof>;
}>;

export function assertDodoStagingUatEvidence(evidence: unknown, binding: DodoStagingUatBinding): {
  accepted: true;
  evidenceFingerprintSha256: string;
  releaseId: string;
  scenarioCount: 32;
  workerVersion: string;
};
