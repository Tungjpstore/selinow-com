export function signPayosUatEvidence(input: {
  evidencePath: string;
  privateKeyPath: string;
  keyId: string;
  signedAt: string;
  output: string;
  overwrite?: boolean;
  root?: string;
  stagingRunnerPublicKeys?: Record<string, string>;
  stagingRunnerSpkiFingerprints?: Record<string, string>;
}): Promise<{
  artifactFingerprintSha256: string;
  evidencePath: string;
  keyId: string;
  releaseId: string;
}>;

export function main(argv?: string[]): Promise<unknown>;
