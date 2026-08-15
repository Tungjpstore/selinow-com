export function signPayosProviderExecutionArtifact(input: {
  input: string;
  keyId: string;
  output: string;
  privateKeyPath: string;
  root?: string;
  signedAt: string;
}): Promise<{
  artifactFingerprintSha256: string;
  artifactPath: string;
  keyId: string;
  publicKeySpkiSha256: string;
  releaseId: string;
  scenarioId: string;
}>;

export function main(argv?: string[]): Promise<unknown>;
