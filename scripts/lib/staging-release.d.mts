export type StagingRepositoryState = {
  clean: boolean;
  commitSha: string;
  treeSha: string;
};

export type StagingReleaseManifest = {
  commitSha: string;
  continuationEvidence: {
    backupChecksumSha256: string;
    backupCompletedAt: string;
    backupReportRef: string;
    backupSizeBytes: number;
    backupSnapshotId: string;
    restoreCompletedAt: string;
    restoreReportRef: string;
    restoreSnapshotId: string;
    restoreTargetResourceRef: string;
  };
  createdAt: string;
  databaseTarget: {
    accountId: string;
    databaseId: string;
    databaseName: string;
  };
  environment: "staging";
  expiresAt: string;
  migrationNames: string[];
  releaseId: string;
  schemaVersion: 2;
  treeSha: string;
};

export function readStagingRepositoryState(root?: string): StagingRepositoryState;
export function validateStagingReleaseManifest(input: {
  manifest: StagingReleaseManifest;
  migrationNames: string[];
  now?: Date;
  repositoryState: StagingRepositoryState;
}): {
  commitSha: string;
  continuationEvidence: StagingReleaseManifest["continuationEvidence"];
  databaseTarget: StagingReleaseManifest["databaseTarget"];
  releaseId: string;
  treeSha: string;
};
export function buildStagingReleaseManifest(input?: {
  continuationEvidence: {
    backup: {
      checksumSha256: string;
      completedAt: string;
      reportRef: string;
      sizeBytes: number;
      snapshotId: string;
    };
    restore: {
      completedAt: string;
      reportRef: string;
      snapshotId: string;
      targetResourceRef: string;
    };
  };
  databaseTarget: StagingReleaseManifest["databaseTarget"];
  migrationNames?: string[];
  now?: Date;
  repositoryRoot?: string;
  repositoryState?: StagingRepositoryState;
}): Promise<StagingReleaseManifest>;
export function assertStagingContinuationBinding(
  admission: {
    continuationEvidence: StagingReleaseManifest["continuationEvidence"];
    databaseTarget: StagingReleaseManifest["databaseTarget"];
  },
  continuationEvidence: Parameters<typeof buildStagingReleaseManifest>[0]["continuationEvidence"],
  databaseTarget: StagingReleaseManifest["databaseTarget"],
): void;
export function parseStagingMigrationLedgerOutput(output: string): string[];
export function assertStagingMigrationLedger(input?: {
  environment?: NodeJS.ProcessEnv;
  migrationNames?: string[];
  repositoryRoot?: string;
  runWranglerImplementation?: (
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => { stdout: string; stderr: string };
}): Promise<{ migrationNames: string[] }>;
export function parseStagingDatabasePreflightOutput(output: string): {
  checks: Array<{ code: string; detail: string; ok: true }>;
};
export function assertStagingDatabasePreflight(input?: {
  environment?: NodeJS.ProcessEnv;
  repositoryRoot?: string;
  runImplementation?: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => { stdout: string; stderr: string };
}): { checks: Array<{ code: string; detail: string; ok: true }> };
export function writeStagingReleaseManifest(manifest: StagingReleaseManifest, root?: string): Promise<string>;
export function assertStagingReleaseAdmission(input: {
  manifestPath: string;
  migrationNames?: string[];
  now?: Date;
  repositoryRoot?: string;
  repositoryState?: StagingRepositoryState;
}): Promise<{
  commitSha: string;
  continuationEvidence: StagingReleaseManifest["continuationEvidence"];
  databaseTarget: StagingReleaseManifest["databaseTarget"];
  releaseId: string;
  treeSha: string;
}>;
