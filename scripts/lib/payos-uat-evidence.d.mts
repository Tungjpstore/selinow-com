export const PAYOS_PROVIDER_REQUIRED_SCENARIO_IDS: readonly string[];
export const PAYOS_LOCAL_ASSURANCE_SCENARIO_IDS: readonly string[];
export const PAYOS_PROVIDER_UNSUPPORTED_SCENARIO_IDS: readonly string[];
export const PAYOS_STAGING_UAT_SCENARIO_IDS: readonly string[];

export type PayosStagingUatBinding = {
  commitSha: string;
  treeSha: string;
  releaseId: string;
  manifestRef: string;
  manifestSha256: string;
  workerVersion: string;
  requireArtifactProof?: boolean;
  scenarioArtifactFingerprints?: Record<string, string>;
  ownerAttestationPublicKeys?: Record<string, string>;
  providerExecutionArtifactFingerprints?: Record<string, string>;
};

export function fingerprintPayosStagingUatEvidence(evidence: unknown): string;
export function serializePayosOwnerAttestationPayload(evidence: unknown): string;
export function serializePayosRunnerAttestationPayload(evidence: unknown): string;
export function assertPayosUnsignedProviderExecutionArtifact(value: unknown): unknown;
export function readPayosRunnerTrustAnchor(input: {
  keyId: string;
  publicKeyPath: string;
  repositoryRoot: string;
  spkiSha256: string;
}): {
  stagingRunnerPublicKeys: Record<string, string>;
  stagingRunnerSpkiFingerprints: Record<string, string>;
};
export function readPayosProviderExecutionArtifact(input: {
  executionEvidencePath: string;
  observedAt: string;
  release: Record<string, string>;
  repositoryRoot: string;
  scenarioId: string;
  stagingRunnerPublicKeys?: Record<string, string>;
  stagingRunnerSpkiFingerprints?: Record<string, string>;
  verificationMethod: string;
}): {
  authority: Record<string, string>;
  controlledAccountFingerprintSha256: string;
  fingerprintSha256: string;
  path: string;
};
export function readPayosProviderExecutionArtifacts(input: {
  evidence: unknown;
  repositoryRoot: string;
  stagingRunnerPublicKeys?: Record<string, string>;
  stagingRunnerSpkiFingerprints?: Record<string, string>;
}): {
  authorities: Record<string, Record<string, string>>;
  fingerprints: Record<string, string>;
  transactionEvidenceFingerprintSha256: string;
};
export function readPayosScenarioArtifactFingerprints(input: { evidence: unknown; repositoryRoot: string }): Record<string, string>;
export function evaluatePayosStagingUatEvidence(evidence: unknown, binding: PayosStagingUatBinding): {
  accepted: boolean;
  acceptanceReasonCode: string | null;
  evidenceFingerprintSha256: string;
  evidenceKind: "provider_acceptance" | "contract_gap";
  fullCommerceAccepted: boolean;
  fullCommerceReasonCodes: readonly string[];
  localScenarioCount: 10;
  paymentLaneAccepted: boolean;
  providerScenarioCount: 2;
  releaseId: string;
  scenarioCount: 14;
  unsupportedReasonCodes: readonly string[];
  unsupportedScenarioCount: 2;
  workerVersion: string;
  error?: "payos_uat_contract_gap";
};
export function assertPayosStagingUatEvidence(evidence: unknown, binding: PayosStagingUatBinding): {
  accepted: true;
  acceptanceReasonCode: null;
  evidenceFingerprintSha256: string;
  evidenceKind: "provider_acceptance";
  fullCommerceAccepted: boolean;
  fullCommerceReasonCodes: readonly string[];
  localScenarioCount: 10;
  paymentLaneAccepted: true;
  providerScenarioCount: 2;
  releaseId: string;
  scenarioCount: 14;
  unsupportedReasonCodes: readonly string[];
  unsupportedScenarioCount: 2;
  workerVersion: string;
};
