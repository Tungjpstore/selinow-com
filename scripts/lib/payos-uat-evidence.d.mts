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
};

export function fingerprintPayosStagingUatEvidence(evidence: unknown): string;
export function assertPayosStagingUatEvidence(evidence: unknown, binding: PayosStagingUatBinding): {
  accepted: true;
  evidenceFingerprintSha256: string;
  releaseId: string;
  scenarioCount: 14;
  workerVersion: string;
};
