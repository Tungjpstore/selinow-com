/// <reference types="node" />

export type BackupEnvironment = "local" | "production" | "staging";

export type DatabaseTarget = {
  binding: "PLATFORM_DB";
  databaseId: string;
  databaseName: string;
  environment: BackupEnvironment;
  resourceRef: string;
};

export type BackupSnapshotRecord = {
  checksum_sha256: string | null;
  completed_at: string | null;
  created_at: string;
  environment: BackupEnvironment;
  expires_at: string | null;
  id: string;
  item_count: number | null;
  last_safe_error_code: string | null;
  provider_reference: string | null;
  request_id: string;
  requested_by_user_id: null;
  resource_kind: "d1";
  resource_ref: string;
  scope_key: string;
  shop_id: null;
  size_bytes: number | null;
  snapshot_kind: "export" | "manifest" | "time_travel";
  status: "available" | "expired" | "failed" | "requested";
  updated_at: string;
  version: 1;
};

export type RestoreDrillRecord = {
  backup_snapshot_id: string;
  completed_at: string | null;
  created_at: string;
  environment: "isolated" | "local" | "staging";
  foreign_key_violation_count: number;
  id: string;
  integrity_status: "failed" | "ok" | "pending";
  last_safe_error_code: string | null;
  request_id: string;
  requested_by_user_id: null;
  restored_item_count: number | null;
  shop_id: null;
  started_at: string | null;
  status: "canceled" | "failed" | "passed" | "planned" | "running";
  target_resource_ref: string;
  updated_at: string;
  version: 1;
};

type WranglerRunner = (
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => { stderr: string; stdout: string };

type WranglerConfig = {
  d1_databases?: Array<Record<string, unknown>>;
  env?: Partial<Record<BackupEnvironment, { d1_databases?: Array<Record<string, unknown>> }>>;
};

type OperationResult = {
  actions: Array<{ code: string; detail: string; ok: boolean }>;
  environment: BackupEnvironment;
  ok: boolean;
  [key: string]: unknown;
};

type StagingAdmission = (input: {
  environment?: NodeJS.ProcessEnv;
  runWranglerImplementation?: WranglerRunner;
}) => Promise<{ accountId: string; databaseId: string; databaseName: string }>;

type RemoteIdentity = { accountId: string; databaseId: string; databaseName: string };

type ProductionIdentityImplementation = (target: DatabaseTarget) => Promise<RemoteIdentity>;

export function resolveDatabaseTarget(
  config: WranglerConfig,
  environment: BackupEnvironment,
): DatabaseTarget;

export function assertDistinctRestoreTarget(
  sourceName: string,
  targetName: string,
  environment: BackupEnvironment,
): void;

export function assertExactMigrationLedger(
  appliedMigrationNames: string[],
  repositoryMigrationNames: string[],
): void;

export function resolvePendingMigrationNames(
  appliedMigrationNames: string[],
  repositoryMigrationNames: string[],
): string[];

export function normalizeHistoricalMigrationAliases(
  databasePath: string,
  repositoryMigrationNames: string[],
): Array<{ canonical: string; historical: string }>;

export const restoreCountValidationTables: readonly string[];
export const restoreValidationTables: readonly string[];
export function assertRequiredRestoreTables(tableNames: Iterable<string>): void;
export function readCrossLedgerMismatches(database: {
  prepare(sql: string): { all(): Array<Record<string, unknown>> };
}): Array<{ code: string; id: string }>;
export function verifyLocalIntegrity(databasePath: string): {
  foreignKeyViolationCount: number;
  integrityOk: boolean;
};

export function buildBackupSnapshotRecord(input: {
  checksumSha256?: string;
  completedAt?: string;
  createdAt: string;
  environment: BackupEnvironment;
  expiresAt?: string | null;
  id: string;
  itemCount?: number;
  lastSafeErrorCode?: string;
  providerReference?: string | null;
  requestId: string;
  resourceRef: string;
  sizeBytes?: number;
  snapshotKind: BackupSnapshotRecord["snapshot_kind"];
  status: BackupSnapshotRecord["status"];
  updatedAt: string;
}): BackupSnapshotRecord;

export function buildRestoreDrillRecord(input: {
  backupSnapshotId: string;
  completedAt?: string;
  createdAt: string;
  environment: RestoreDrillRecord["environment"];
  foreignKeyViolationCount?: number;
  id: string;
  integrityStatus: RestoreDrillRecord["integrity_status"];
  lastSafeErrorCode?: string;
  requestId: string;
  restoredItemCount?: number;
  startedAt?: string;
  status: RestoreDrillRecord["status"];
  targetResourceRef: string;
  updatedAt: string;
}): RestoreDrillRecord;

export function cleanupRestoreTempDirectory(path: string, drillId: string): Promise<void>;

export function assertFreshStagingBackupEvidence(options: {
  accountId: string;
  backupRoot?: string;
  databaseId: string;
  databaseName: string;
  now?: Date;
}): Promise<{
  artifactPath: string;
  checksumSha256: string;
  completedAt: string;
  reportRef: string;
  sizeBytes: number;
  snapshotId: string;
}>;

export function assertFreshStagingContinuationEvidence(options: {
  accountId: string;
  backupRoot?: string;
  databaseId: string;
  databaseName: string;
  now?: Date;
  repositoryRoot?: string;
  restoreRoot?: string;
  reviewedCommitSha: string;
}): Promise<{
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
  reviewedCommitSha: string;
}>;

export function assertStagingContinuationEvidenceByReference(options: {
  accountId: string;
  backupRoot?: string;
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
  databaseId: string;
  databaseName: string;
  evidenceRecordedAt: Date | string;
  repositoryRoot?: string;
  restoreRoot?: string;
  reviewedCommitSha: string;
}): ReturnType<typeof assertFreshStagingContinuationEvidence>;

export function assertFreshProductionBootstrapBackupEvidence(options: {
  accountId: string;
  backupRoot?: string;
  databaseId: string;
  databaseName: string;
  now?: Date;
}): Promise<{
  artifactPath: string;
  completedAt: string;
  checksumSha256: string;
  providerBookmarkRecorded: true;
  reportRef: string;
  sizeBytes: number;
  snapshotId: string;
}>;

export function assertFreshProductionContinuationEvidence(options: {
  accountId: string;
  backupRoot?: string;
  databaseId: string;
  databaseName: string;
  now?: Date;
  repositoryRoot?: string;
  restoreRoot?: string;
  reviewedCommitSha: string;
}): Promise<{
  backup: {
    artifactPath: string;
    completedAt: string;
    checksumSha256: string;
    providerBookmarkRecorded: true;
    reportRef: string;
    sizeBytes: number;
    snapshotId: string;
  };
  reviewedCommitSha: string;
  restore: {
    completedAt: string;
    reportRef: string;
    snapshotId: string;
    targetResourceRef: string;
  };
}>;

export function assertProductionBackupAdmission(input: {
  environment?: NodeJS.ProcessEnv;
  identityImplementation?: ProductionIdentityImplementation;
  runWranglerImplementation?: WranglerRunner;
  target: DatabaseTarget;
}): Promise<RemoteIdentity>;

export function createBackup(options: {
  config?: WranglerConfig;
  dryRun: boolean;
  environment: BackupEnvironment;
  now?: Date;
  operatorEnvironment?: NodeJS.ProcessEnv;
  productionIdentityImplementation?: ProductionIdentityImplementation;
  randomBytesImplementation?: (size: number) => Buffer;
  runner?: WranglerRunner;
  stagingAdmissionImplementation?: StagingAdmission;
}): Promise<OperationResult>;

export function runRestoreDrill(options: {
  config?: WranglerConfig;
  dryRun: boolean;
  environment: BackupEnvironment;
  now?: Date;
  reviewedCommitSha?: string;
  randomBytesImplementation?: (size: number) => Buffer;
  runner?: WranglerRunner;
}): Promise<OperationResult>;

export const backupPaths: {
  backupRoot: string;
  drillReportRoot: string;
};
