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
  migrationLedgerPrefix: string[];
  migrationNames: string[];
  releaseId: string;
  schemaVersion: 3;
  treeSha: string;
};

export type StagingReleaseAdmission = {
  commitSha: string;
  continuationEvidence: StagingReleaseManifest["continuationEvidence"];
  createdAt: string;
  databaseTarget: StagingReleaseManifest["databaseTarget"];
  migrationLedgerPrefix: string[];
  migrationNames: string[];
  releaseId: string;
  treeSha: string;
};

export type StagingMigrationCompletion = {
  commitSha: string;
  completedAt: string;
  databaseTarget: StagingReleaseManifest["databaseTarget"];
  environment: "staging";
  migrationNames: string[];
  releaseId: string;
  schemaVersion: 1;
  treeSha: string;
};

export type StagingPostMigrationEvidence = StagingMigrationCompletion & {
  continuationEvidence: StagingReleaseManifest["continuationEvidence"];
  migrationCompletedAt: string;
};

export function readStagingRepositoryState(root?: string): StagingRepositoryState;
export function validateStagingReleaseManifest(input: {
  manifest: StagingReleaseManifest;
  migrationNames: string[];
  now?: Date;
  repositoryState: StagingRepositoryState;
}): StagingReleaseAdmission;
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
  migrationLedgerPrefix: string[];
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
export function buildStagingMigrationCompletion(input: {
  databaseTarget: StagingReleaseManifest["databaseTarget"];
  migrationNames: string[];
  now?: Date;
  releaseAdmission: StagingReleaseAdmission;
}): StagingMigrationCompletion;
export function writeStagingMigrationCompletion(
  completion: StagingMigrationCompletion,
  root?: string,
): Promise<string>;
export function assertStagingMigrationCompletion(input: {
  databaseTarget: StagingReleaseManifest["databaseTarget"];
  migrationNames: string[];
  now?: Date;
  releaseAdmission: StagingReleaseAdmission;
  repositoryRoot?: string;
}): Promise<StagingMigrationCompletion>;
export function buildStagingPostMigrationEvidence(input: {
  continuationEvidence: Parameters<typeof buildStagingReleaseManifest>[0]["continuationEvidence"];
  databaseTarget: StagingReleaseManifest["databaseTarget"];
  migrationCompletion: StagingMigrationCompletion;
  migrationNames: string[];
  now?: Date;
  releaseAdmission: StagingReleaseAdmission;
}): StagingPostMigrationEvidence;
export function writeStagingPostMigrationEvidence(
  evidence: StagingPostMigrationEvidence,
  root?: string,
): Promise<string>;
export function readStagingPostMigrationEvidence(input: {
  databaseTarget: StagingReleaseManifest["databaseTarget"];
  migrationCompletion: StagingMigrationCompletion;
  migrationNames: string[];
  now?: Date;
  releaseAdmission: StagingReleaseAdmission;
  repositoryRoot?: string;
}): Promise<StagingPostMigrationEvidence>;
export function assertStagingPostMigrationEvidence(input: Parameters<typeof readStagingPostMigrationEvidence>[0] & {
  continuationEvidence: Parameters<typeof buildStagingReleaseManifest>[0]["continuationEvidence"];
}): Promise<StagingPostMigrationEvidence>;
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
export function assertStagingMigrationLedgerPrefix(input?: {
  environment?: NodeJS.ProcessEnv;
  expectedPrefix?: string[];
  migrationNames?: string[];
  repositoryRoot?: string;
  runWranglerImplementation?: (
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => { stdout: string; stderr: string };
}): Promise<{ migrationNames: string[] }>;
export function captureStagingReleaseDatabaseBaseline(input: {
  assertStagingMutationAdmissionImplementation?: (input: {
    environment?: NodeJS.ProcessEnv;
    runWranglerImplementation?: (
      args: string[],
      options?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => { stdout: string; stderr: string };
  }) => Promise<StagingReleaseManifest["databaseTarget"]>;
  databaseTarget: StagingReleaseManifest["databaseTarget"];
  environment?: NodeJS.ProcessEnv;
  migrationNames?: string[];
  repositoryRoot?: string;
  runWranglerImplementation?: (
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => { stdout: string; stderr: string };
}): Promise<{
  databaseTarget: StagingReleaseManifest["databaseTarget"];
  migrationLedgerPrefix: string[];
}>;
export function parseStagingDatabasePreflightOutput(output: string, options?: {
  allowMissingPayosConnections?: boolean;
}): {
  checks: Array<{ code: string; detail: string; ok: boolean }>;
};
export function assertStagingDatabasePreflight(input?: {
  allowMissingPayosConnections?: boolean;
  environment?: NodeJS.ProcessEnv;
  repositoryRoot?: string;
  runImplementation?: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => { stdout: string; stderr: string };
}): { checks: Array<{ code: string; detail: string; ok: boolean }> };
export function runStagingMigrationWithVerification(input: {
  assertDatabasePreflightImplementation?: (input?: {
    allowMissingPayosConnections?: boolean;
    environment?: NodeJS.ProcessEnv;
    migrationNames?: string[];
    repositoryRoot?: string;
  }) => unknown;
  assertPostMigrationContractImplementation?: (input?: {
    environment?: NodeJS.ProcessEnv;
    migrationNames?: string[];
    repositoryRoot?: string;
  }) => unknown;
  assertMigrationLedgerImplementation?: (input?: {
    environment?: NodeJS.ProcessEnv;
    migrationNames?: string[];
    repositoryRoot?: string;
  }) => Promise<unknown>;
  assertMigrationLedgerPrefixImplementation?: (input?: {
    environment?: NodeJS.ProcessEnv;
    expectedPrefix?: string[];
    migrationNames?: string[];
    repositoryRoot?: string;
  }) => Promise<unknown>;
  environment?: NodeJS.ProcessEnv;
  expectedPrefix: string[];
  migrationNames?: string[];
  repositoryRoot?: string;
  runMigrationImplementation: () => unknown | Promise<unknown>;
}): Promise<void>;
export function writeStagingReleaseManifest(manifest: StagingReleaseManifest, root?: string): Promise<string>;
export function assertStagingReleaseAdmission(input: {
  manifestPath: string;
  migrationNames?: string[];
  now?: Date;
  repositoryRoot?: string;
  repositoryState?: StagingRepositoryState;
}): Promise<StagingReleaseAdmission>;
