export type DatabaseFlags = {
  buildOnly: boolean;
  confirmProduction: boolean;
  dryRun: boolean;
  environment: "local" | "staging" | "production";
  json: boolean;
  releaseManifestPath: string | null;
};

export function parseDatabaseFlags(argv: string[]): DatabaseFlags;
export function requiresProductionMigrationAdmission(operation: string | undefined, flags: DatabaseFlags): boolean;
export function requiresStagingDatabaseAdmission(operation: string | undefined, flags: DatabaseFlags): boolean;
export function requiresStagingReleaseManifest(operation: string | undefined, flags: DatabaseFlags): boolean;
export function resolveApprovedProductionDatabaseTarget(input: {
  productionSpec: Record<string, any>;
  wranglerConfig: Record<string, any>;
}): {
  accountId: string;
  target: {
    binding: "PLATFORM_DB";
    databaseId: string;
    databaseName: string;
    environment: "production";
    resourceRef: string;
  };
};
export function assertProductionAccountIdentity(whoamiOutput: string, accountId: string): void;
export function assertProductionDatabaseIdentity(
  d1ListOutput: string,
  databaseId: string,
  databaseName: string,
): void;
export function parseProductionMigrationLedgerOutput(output: string): string[];
export function assertProductionMigrationLedgerPrefix(input?: {
  environment?: NodeJS.ProcessEnv;
  expectedPrefix?: string[];
  migrationNames?: string[];
  repositoryRoot?: string;
  runWranglerImplementation?: (
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
  ) => { stderr: string; stdout: string };
}): Promise<{ migrationNames: string[] }>;
export function assertProductionMigrationLedger(input?: {
  environment?: NodeJS.ProcessEnv;
  migrationNames?: string[];
  repositoryRoot?: string;
  runWranglerImplementation?: (
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
  ) => { stderr: string; stdout: string };
}): Promise<{ migrationNames: string[] }>;
export function assertProductionDatabasePreflight(input?: {
  environment?: NodeJS.ProcessEnv;
  requirePaymentProviderSchema?: boolean;
  repositoryRoot?: string;
  runWranglerImplementation?: (
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
  ) => { stderr: string; stdout: string };
}): { checks: Array<{ code: string; detail: string; ok: boolean }>; ok: true };
export function assertProductionMigrationAdmission(input: {
  assertDatabasePreflightImplementation?: (input: {
    environment?: NodeJS.ProcessEnv;
    repositoryRoot: string;
    requirePaymentProviderSchema?: boolean;
    runWranglerImplementation: (
      args: string[],
      options: { cwd: string; env?: NodeJS.ProcessEnv },
    ) => { stderr: string; stdout: string };
  }) => { checks: Array<{ code: string; detail: string; ok: boolean }>; ok: boolean };
  assertContinuationEvidenceImplementation?: (input: {
    accountId: string;
    databaseId: string;
    databaseName: string;
    repositoryRoot: string;
    reviewedCommitSha: string;
  }) => Promise<{
    backup: {
      checksumSha256: string;
      snapshotId: string;
    };
    restore: {
      reportRef: string;
      snapshotId: string;
    };
  }>;
  assertReleaseAdmissionImplementation?: (input: {
    manifestPath: string;
    repositoryRoot: string;
    workerSecretNames: string[];
  }) => Promise<{ commitSha: string; migrationLedgerPrefix?: string[]; releaseId: string }>;
  assertMigrationLedgerImplementation?: (input: {
    environment?: NodeJS.ProcessEnv;
    migrationNames: string[];
    repositoryRoot: string;
    runWranglerImplementation: (
      args: string[],
      options: { cwd: string; env?: NodeJS.ProcessEnv },
    ) => { stderr: string; stdout: string };
  }) => Promise<{ migrationNames: string[] }>;
  assertMigrationLedgerPrefixImplementation?: (input: {
    environment?: NodeJS.ProcessEnv;
    expectedPrefix?: string[];
    migrationNames: string[];
    repositoryRoot: string;
    runWranglerImplementation: (
      args: string[],
      options: { cwd: string; env?: NodeJS.ProcessEnv },
    ) => { stderr: string; stdout: string };
  }) => Promise<{ migrationNames: string[] }>;
  manifestPath: string;
  environment?: NodeJS.ProcessEnv;
  migrationNames?: string[];
  operation?: "migrate" | "seed";
  productionSpec?: Record<string, any> | null;
  repositoryRoot?: string;
  runWranglerImplementation?: (
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
  ) => { stderr: string; stdout: string };
  workerSecretNames: string[];
  wranglerConfig?: Record<string, any>;
}): Promise<{
  accountId: string;
  commitSha: string;
  databaseId: string;
  databaseName: string;
  releaseId: string;
}>;
