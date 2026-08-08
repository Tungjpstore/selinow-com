export type PlatformAdminBootstrapFlags = {
  confirm: boolean;
  confirmProduction: boolean;
  dryRun: boolean;
  environment: "local" | "production" | "staging";
  json: boolean;
  releaseManifestPath: string | null;
  userEmail: string;
  userId: string;
};

export type PlatformAdminBootstrapRunnerOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type PlatformAdminBootstrapRunner = (
  args: string[],
  options?: PlatformAdminBootstrapRunnerOptions,
) => { stderr?: string; stdout: string };

export type ProductionAdminBootstrapAdmission = {
  accountId: string;
  commitSha: string;
  databaseId: string;
  databaseName: string;
  releaseId: string;
};

export type ProductionAdminBootstrapContinuationEvidence = {
  backup: { completedAt: string; [key: string]: unknown };
  restore: { completedAt: string; [key: string]: unknown };
  [key: string]: unknown;
};

type ProductionContinuationEvidenceInput = {
  accountId: string;
  databaseId: string;
  databaseName: string;
  now?: Date;
  repositoryRoot: string;
  reviewedCommitSha: string;
};

type ProductionAdmissionInput = {
  assertContinuationEvidenceImplementation: (
    input: ProductionContinuationEvidenceInput,
  ) => Promise<ProductionAdminBootstrapContinuationEvidence>;
  environment: NodeJS.ProcessEnv;
  manifestPath: string;
  operation: "seed";
  repositoryRoot: string;
  runWranglerImplementation: PlatformAdminBootstrapRunner;
  workerSecretNames: string[];
};

export function parsePlatformAdminBootstrapFlags(argv: string[]): PlatformAdminBootstrapFlags;
export function assertPlatformAdminBootstrapMigrationLedger(migrationNames: string[]): { migrationName: string };
export function assertPlatformAdminBootstrapContinuationFreshness<T extends ProductionAdminBootstrapContinuationEvidence>(
  evidence: T,
  now?: Date,
): T;
export function safePlatformAdminBootstrapErrorCode(error: unknown): string;
export function buildPlatformAdminBootstrapSql(input: { requestId: string; userEmail: string; userId: string }): string;
export function parsePlatformAdminBootstrapOutput(output: string): { adminCount: number; candidateOwnerCount: number; receiptCount: number };
export function runPlatformAdminBootstrap(input: {
  environment?: NodeJS.ProcessEnv;
  flags: PlatformAdminBootstrapFlags;
  now?: Date;
  productionAdmissionImplementation?: (
    input: ProductionAdmissionInput,
  ) => Promise<ProductionAdminBootstrapAdmission>;
  productionContinuationEvidenceImplementation?: (
    input: ProductionContinuationEvidenceInput,
  ) => Promise<ProductionAdminBootstrapContinuationEvidence>;
  productionLedgerImplementation?: (input: {
    environment: NodeJS.ProcessEnv;
    migrationNames: undefined;
    repositoryRoot: string;
    runWranglerImplementation: PlatformAdminBootstrapRunner;
  }) => Promise<{ migrationNames: string[] }>;
  repositoryRoot?: string;
  requestId: string;
  runner: PlatformAdminBootstrapRunner;
  workerSecretNames?: string[];
}): Promise<{ actions: Array<{ code: string; ok: boolean }>; environment: string; ok: boolean }>;
