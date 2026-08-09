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
};

export function fingerprintPayosStagingUatEvidence(evidence: unknown): string;
export function serializePayosOwnerAttestationPayload(evidence: unknown): string;
export function evaluatePayosStagingUatEvidence(evidence: unknown, binding: PayosStagingUatBinding): {
  accepted: boolean;
  acceptanceReasonCode: string | null;
  evidenceFingerprintSha256: string;
  evidenceKind: "provider_acceptance" | "contract_gap";
  localScenarioCount: 10;
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
  localScenarioCount: 10;
  providerScenarioCount: 2;
  releaseId: string;
  scenarioCount: 14;
  unsupportedReasonCodes: readonly string[];
  unsupportedScenarioCount: 2;
  workerVersion: string;
};
