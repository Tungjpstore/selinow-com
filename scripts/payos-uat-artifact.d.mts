export type PayosScenarioArtifact = {
  classification: string;
  controlledAccountFingerprintSha256: string | null;
  evidenceKind: "provider_acceptance";
  environment: "staging";
  observedAt: string;
  provider: "payos";
  proofOfExecutionFingerprintSha256: string | null;
  redaction: { noRawPayload: true; noSensitiveValues: true };
  release: Record<string, unknown>;
  result: string;
  scenarioId: string;
  schemaVersion: 1;
  verificationMethod: string;
};

export function buildPayosScenarioArtifact(input: {
  manifestPath: string;
  workerVersion: string;
  scenarioId: string;
  classification: string;
  status: string;
  verificationMethod: string;
  observedAt: string;
  controlledAccountFingerprintSha256?: string | null;
  proofOfExecutionFingerprintSha256?: string | null;
  output: string;
  root?: string;
}): Promise<{
  artifact: PayosScenarioArtifact;
  artifactFingerprintSha256: string;
  artifactPath: string;
}>;

export function main(argv?: string[]): Promise<unknown>;
