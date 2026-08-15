export type CommerceUatArtifactValidation = Record<"dodo" | "payos", {
  accepted: boolean;
  error?: string;
  artifactFingerprintSha256?: string;
  fullCommerceAccepted?: boolean;
  manifestRef?: string;
  manifestSha256?: string;
  paymentLaneAccepted?: boolean;
  reasonCodes?: readonly string[];
  releaseId?: string;
  scenarioCount?: number;
  workerVersion?: string;
}>;

export function readTrustedStagingUatBinding(input: {
  evidence: unknown;
  manifestPath?: string;
  now?: Date;
  repositoryRoot: string;
  workerVersion?: string;
}): {
  commitSha: string;
  manifestRef: string;
  manifestSha256: string;
  releaseId: string;
  treeSha: string;
  workerVersion: string;
};

export function validateCommerceUatArtifactsSync(input: {
  dodoApprovedExecutionProofTrust?: { keyId: string; spkiSha256: string };
  environment?: Record<string, string | undefined>;
  evidence: unknown;
  now?: Date;
  payosOwnerAttestationPublicKeys?: Record<string, string>;
  payosStagingRunnerPublicKeys?: Record<string, string>;
  payosStagingRunnerSpkiFingerprints?: Record<string, string>;
  repositoryRoot: string;
  trustedStagingWorkerVersion: string;
}): CommerceUatArtifactValidation;
export function validateCommerceUatArtifacts(input: {
  dodoApprovedExecutionProofTrust?: { keyId: string; spkiSha256: string };
  environment?: Record<string, string | undefined>;
  evidence: unknown;
  now?: Date;
  payosOwnerAttestationPublicKeys?: Record<string, string>;
  payosStagingRunnerPublicKeys?: Record<string, string>;
  payosStagingRunnerSpkiFingerprints?: Record<string, string>;
  repositoryRoot: string;
}): Promise<CommerceUatArtifactValidation>;
