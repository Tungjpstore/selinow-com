export const DODO_STAGING_UAT_SCENARIO_IDS: readonly string[];

export type DodoStagingUatEvidence = {
  schemaVersion: 1;
  environment: "staging";
  provider: "dodo";
  providerEnvironment: "test_mode";
  release: {
    releaseId: string;
    commitSha: string;
    treeSha: string;
    manifestRef: string;
    manifestSha256: string;
    workerVersion: string;
  };
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
    observedAt: string;
    evidenceFingerprintSha256: string;
    requestReference: string | null;
    eventReference: string | null;
    sessionReference: string | null;
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

export type DodoStagingUatBinding = Pick<DodoStagingUatEvidence["release"], "commitSha" | "treeSha" | "releaseId" | "manifestRef" | "manifestSha256" | "workerVersion">;

export function fingerprintDodoStagingUatEvidence(evidence: unknown): string;
export function fingerprintDodoUatReference(scope: string, value: string): string;
export function assertDodoStagingUatEvidence(evidence: unknown, binding: DodoStagingUatBinding): {
  accepted: true;
  evidenceFingerprintSha256: string;
  releaseId: string;
  scenarioCount: 32;
  workerVersion: string;
};
