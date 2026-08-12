export type PayosUatValidationOutput = {
  accepted: boolean;
  acceptanceReasonCode: string | null;
  artifactFingerprintSha256: string;
  evidenceFingerprintSha256: string;
  evidenceKind: string | null;
  fullCommerceAccepted: boolean;
  fullCommerceReasonCodes: readonly string[];
  localScenarioCount: number;
  manifestRef: string | null;
  manifestSha256: string | null;
  paymentLaneAccepted: boolean;
  providerScenarioCount: number;
  reasonCodes: readonly string[];
  releaseId: string | null;
  scenarioCount: number;
  unsupportedReasonCodes: readonly string[];
  unsupportedScenarioCount: number;
  workerVersion: string;
};

export function validatePayosUatEvidenceFile(input: {
  evidencePath: string;
  manifestPath: string;
  now?: Date;
  ownerAttestationPublicKeys?: Record<string, string>;
  stagingRunnerPublicKeys?: Record<string, string>;
  stagingRunnerSpkiFingerprints?: Record<string, string>;
  workerVersion: string;
  root?: string;
}): Promise<PayosUatValidationOutput>;

export function main(argv?: string[]): Promise<PayosUatValidationOutput>;
