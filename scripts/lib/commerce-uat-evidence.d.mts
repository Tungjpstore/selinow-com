export type CommerceUatArtifactValidation = Record<"dodo" | "payos", {
  accepted: boolean;
  error?: string;
  artifactFingerprintSha256?: string;
  manifestRef?: string;
  manifestSha256?: string;
  releaseId?: string;
  scenarioCount?: number;
  workerVersion?: string;
}>;

export function readTrustedStagingUatBinding(input: {
  evidence: unknown;
  manifestPath?: string;
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

export function validateCommerceUatArtifactsSync(input: { evidence: unknown; repositoryRoot: string }): CommerceUatArtifactValidation;
export function validateCommerceUatArtifacts(input: { evidence: unknown; repositoryRoot: string }): Promise<CommerceUatArtifactValidation>;
