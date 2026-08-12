export function collectPayosUatEvidence(input: {
  completedAt: string;
  createdAt: string;
  manifestPath: string;
  output: string;
  root?: string;
  stagingRunnerPublicKeys?: Record<string, string>;
  stagingRunnerSpkiFingerprints?: Record<string, string>;
  workerVersion: string;
}): Promise<{
  evidence: Record<string, unknown>;
  evidencePath: string;
  releaseId: string;
}>;

export function main(argv?: string[]): Promise<unknown>;
