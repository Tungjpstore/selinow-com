export type StagingDeploymentEvidence = {
  cloudflare: {
    accountId: string;
    deployedAt: string;
    deploymentId: string;
    percentage: 100;
    workerName: string;
    workerVersion: string;
  };
  environment: "staging";
  inventory: {
    routeInventorySha256: string;
    triggerInventorySha256: string;
  };
  mode: "staging_worker_deployment_binding";
  observedAt: string;
  release: {
    commitSha: string;
    manifestRef: string;
    manifestSha256: string;
    releaseId: string;
    treeSha: string;
  };
  schemaVersion: 1;
};

export function buildStagingDeploymentVersionMessage(input: {
  manifest: { commitSha: string; releaseId: string; treeSha: string };
  manifestRef: string;
  manifestSha256: string;
}): string;

export function collectStagingDeploymentEvidence(input: Record<string, any>): Promise<{
  artifact: StagingDeploymentEvidence;
  artifactSha256: string;
  evidenceRef: string;
}>;

export function writeStagingDeploymentEvidence(input: {
  artifact: StagingDeploymentEvidence;
  repositoryRoot?: string;
}): Promise<{ artifactSha256: string; evidenceRef: string }>;

export function verifyStagingDeploymentEvidence(input: Record<string, any>): Promise<{
  artifact: StagingDeploymentEvidence;
  artifactSha256: string;
  deploymentId: string;
  evidenceRef: string;
  remoteObservedAt: string;
  routeInventorySha256: string;
  triggerInventorySha256: string;
  workerVersion: string;
}>;
