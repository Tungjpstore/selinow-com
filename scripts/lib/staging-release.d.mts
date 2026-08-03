export type StagingRepositoryState = {
  clean: boolean;
  commitSha: string;
  treeSha: string;
};

export type StagingReleaseManifest = {
  commitSha: string;
  createdAt: string;
  environment: "staging";
  expiresAt: string;
  migrationNames: string[];
  releaseId: string;
  schemaVersion: 1;
  treeSha: string;
};

export function readStagingRepositoryState(root?: string): StagingRepositoryState;
export function validateStagingReleaseManifest(input: {
  manifest: StagingReleaseManifest;
  migrationNames: string[];
  now?: Date;
  repositoryState: StagingRepositoryState;
}): { commitSha: string; releaseId: string; treeSha: string };
export function buildStagingReleaseManifest(input?: {
  migrationNames?: string[];
  now?: Date;
  repositoryRoot?: string;
  repositoryState?: StagingRepositoryState;
}): Promise<StagingReleaseManifest>;
export function writeStagingReleaseManifest(manifest: StagingReleaseManifest, root?: string): Promise<string>;
export function assertStagingReleaseAdmission(input: {
  manifestPath: string;
  migrationNames?: string[];
  now?: Date;
  repositoryRoot?: string;
  repositoryState?: StagingRepositoryState;
}): Promise<{ commitSha: string; releaseId: string; treeSha: string }>;
