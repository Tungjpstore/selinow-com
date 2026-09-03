export type ProviderUatRunnerResult = {
  accepted: false;
  artifactRef: string;
  artifactSha256: string;
  provider: "dodo" | "payos";
  receiptRef: string;
  releaseId: string;
  scenarioId: string;
  workerVersion: string;
  next: string;
};

export function canonicalArtifactRef(releaseId: string, provider: "dodo" | "payos", scenarioId: string): string;
export function canonicalManifestRef(releaseId: string): string;
export function canonicalReceiptRef(releaseId: string, provider: "dodo" | "payos", scenarioId: string): string;

export function runProviderUatScenario(input: {
  environment?: Record<string, string | undefined>;
  executor: string;
  manifestPath: string;
  provider: "dodo" | "payos";
  repositoryRoot: string;
  scenarioId: string;
  timeoutMs?: number;
  verifyStagingDeploymentEvidenceImplementation?: (input: Record<string, unknown>) => Promise<{ workerVersion?: string }>;
}): Promise<ProviderUatRunnerResult>;
