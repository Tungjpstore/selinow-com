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
export function assertProductionMigrationAdmission(input: {
  assertReleaseAdmissionImplementation?: (input: {
    manifestPath: string;
    repositoryRoot: string;
    workerSecretNames: string[];
  }) => Promise<{ commitSha: string; releaseId: string }>;
  manifestPath: string;
  environment?: NodeJS.ProcessEnv;
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
