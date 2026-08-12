export function parseArguments(argv: string[]): {
  json: boolean;
  manifestPath: string;
  write: boolean;
};

export function runStagingDeploymentEvidence(
  options: ReturnType<typeof parseArguments>,
  dependencies?: Record<string, any>,
): Promise<{
  artifactSha256: string;
  deploymentId: string;
  environment: "staging";
  evidenceRef: string;
  mode: "validated" | "written";
  ok: true;
  workerVersion: string;
}>;
