export type ReleaseCheck = { name: string; ok: boolean };

export const REQUIRED_PRODUCTION_VARS: string[];
export const REQUIRED_PRODUCTION_ROLLBACK_INVARIANTS: readonly string[];
export const REQUIRED_WORKER_SECRET_NAMES: string[];
export const REQUIRED_PROVIDER_ACCEPTANCE_KEYS: string[];
export const RELEASE_CHANNEL_KEYS: string[];
export const REQUIRED_COMMERCE_ACCEPTANCE_KEYS: string[];
export const REQUIRED_LEGAL_SUPPORT_DECISION_KEYS: readonly string[];
export const REQUIRED_SECRET_INVENTORY_SCHEMA_VERSION: 1;
export function evaluateBackupPrerequisites(evidence: Record<string, unknown> | null, now?: Date): ReleaseCheck[];
export function evaluateCommerceAcceptance(
  evidence: Record<string, unknown> | null,
  artifactValidation?: Record<string, unknown>,
  requireArtifactHash?: boolean,
): ReleaseCheck[];
export function validateCandidateBoundReleaseEvidence(input?: {
  evidence?: Record<string, unknown> | null;
  now?: Date;
  repositoryRoot?: string;
}): { checks: ReleaseCheck[]; missing: string[]; ok: boolean };
export function validateCandidateWorkerVersionEvidence(input?: {
  evidence?: Record<string, unknown> | null;
  workerVersionInventory?: Array<{
    binding: Record<string, unknown> | null;
    id: string;
  }>;
}): { checks: ReleaseCheck[]; missing: string[]; ok: boolean };
export function inspectLiveCandidateWorkerVersionEvidence(input: {
  environment?: NodeJS.ProcessEnv;
  evidence: Record<string, unknown>;
  productionSpec: Record<string, unknown>;
  repositoryRoot?: string;
  stagingSpec: Record<string, unknown> | null;
  workerIdentityImplementation?: (input: Record<string, unknown>) => Promise<{
    currentWorkerVersion?: string;
    deployableWorkerVersionInventory?: Array<{
      binding: Record<string, unknown> | null;
      id: string;
    }>;
  }>;
  wranglerConfig: Record<string, unknown>;
}): Promise<{ checks: ReleaseCheck[]; missing: string[]; ok: boolean }>;
export function validateLegalSupportDecisionEvidence(input?: {
  evidence?: Record<string, unknown> | null;
  now?: Date;
  repositoryRoot?: string;
}): { checks: ReleaseCheck[]; missing: string[]; ok: boolean };
export function validateSecretInventoryEvidence(input?: {
  evidence?: Record<string, unknown> | null;
  repositoryRoot?: string;
  workerSecretNames?: string[];
}): { checks: ReleaseCheck[]; missing: string[]; ok: boolean };
export function inspectProductionReadiness(input: {
  commerceEvidenceValidation?: Record<string, unknown>;
  evidence: Record<string, unknown> | null;
  migrationNames?: string[];
  now: Date;
  productionSpec: Record<string, unknown> | null;
  repositoryRoot?: string;
  requireReleaseHardening?: boolean;
  workerSecretNames: string[];
  wranglerConfig: Record<string, unknown>;
}): { checks: ReleaseCheck[]; missing: string[]; ok: boolean };
export function buildRollbackMatrix(): Array<Record<string, string>>;
export function buildProductionRollbackRehearsalArtifact(input: {
  evidence: Record<string, unknown>;
  migrationNames: string[];
  now?: Date;
}): Record<string, unknown>;
export function writeProductionRollbackRehearsalArtifact(input: {
  evidence: Record<string, unknown>;
  migrationNames: string[];
  now?: Date;
  repositoryRoot?: string;
}): Promise<{
  artifact: Record<string, unknown>;
  artifactSha256: string;
  evidenceRef: string;
}>;
export function validateProductionRollbackArtifact(input: {
  evidence: Record<string, unknown>;
  migrationNames: string[];
  repositoryRoot?: string;
}): {
  accepted: boolean;
  artifactSha256: string;
  migrationLedgerSha256: string;
  rollbackCandidateWorkerVersion: string;
};
export function buildProductionWorkerVersionMessage(input: {
  commitSha: string;
  manifestRef: string;
  releaseId: string;
  role: "candidate" | "rollback";
  treeSha: string;
}): string;
export function assertProductionWorkerUploadResult(input: {
  after: unknown;
  before: unknown;
  expectedBinding: {
    commitSha: string;
    manifestRef: string;
    releaseId: string;
    role?: "candidate" | "rollback";
    treeSha: string;
  };
}): { binding: Record<string, string>; workerVersion: string };
export function buildReleaseArtifacts(input: {
  commerceEvidenceValidation?: Record<string, unknown>;
  evidence: Record<string, unknown>;
  migrationNames: string[];
  now: Date;
  packageVersion: string;
  productionSpec: Record<string, unknown>;
  repositoryRoot?: string;
  requireReleaseHardening?: boolean;
  workerSecretNames: string[];
  wranglerConfig: Record<string, unknown>;
}): { manifest: Record<string, unknown>; rollbackMatrix: Array<Record<string, string>> };
export function validateProductionDeployAdmission(input: {
  commerceEvidenceValidation?: Record<string, unknown>;
  evidence: Record<string, unknown>;
  manifest: unknown;
  migrationNames: string[];
  now: Date;
  packageVersion: string;
  productionSpec: Record<string, unknown>;
  repositoryClean: boolean;
  repositoryCommitSha: string;
  repositoryTreeSha?: unknown;
  requireRollbackArtifact?: boolean;
  rollbackArtifactValidation?: { accepted?: boolean };
  workerSecretNames: string[];
  wranglerConfig: Record<string, unknown>;
}): { commitSha: string; migrationLedgerPrefix: string[]; releaseId: string };
export function assertProductionDeployAdmission(input: {
  evidencePath?: string;
  manifestPath: string;
  now?: Date;
  repositoryRoot?: string;
  specPath?: string;
  workerSecretNames: string[];
}): Promise<{ commitSha: string; migrationLedgerPrefix: string[]; releaseId: string }>;
export function assertProductionWorkerDeployAdmission(input: {
  assertReleaseAdmissionImplementation?: (input: {
    manifestPath: string;
    now?: Date;
    repositoryRoot: string;
    workerSecretNames: string[];
  }) => Promise<{ commitSha: string; releaseId: string }>;
  environment?: NodeJS.ProcessEnv;
  infrastructureAdmissionMode?: "exact" | "pre_candidate";
  fetchImplementation?: typeof fetch;
  manifestPath: string;
  now?: Date;
  productionSpec?: Record<string, unknown> | null;
  repositoryRoot?: string;
  requireDedicatedWorkerDeployToken?: boolean;
  requireWorkerVersionBinding?: boolean;
  rollbackWorkerVersionBinding?: {
    commitSha: string;
    manifestRef: string;
    releaseId: string;
    treeSha: string;
  };
  runWranglerImplementation?: (
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => { stderr: string; stdout: string };
  stagingSpec?: Record<string, unknown> | null;
  token?: string;
  workerIdentityImplementation?: (input: Record<string, unknown>) => Promise<{
    accountId: string;
    databaseId: string;
    databaseName: string;
    deployableWorkerVersionIds?: string[];
    deployableWorkerVersionInventory?: Array<Record<string, unknown>>;
    currentWorkerVersion?: string;
    workerName: string;
    zoneId: string;
    zoneName: string;
  }>;
  workerSecretNames: string[];
  workerVersionAdmissionMode?: "pre_candidate" | "candidate_active";
  wranglerConfig?: Record<string, unknown>;
}): Promise<{
  accountId: string;
  candidateWorkerVersion?: string;
  commitSha: string;
  databaseId: string;
  databaseName: string;
  releaseId: string;
  rollbackCandidateWorkerVersion?: string;
  treeSha?: string;
  workerName: string;
  zoneId: string;
  zoneName: string;
}>;
export function assertProductionContinuationDeployAdmission(input: {
  accountId: string;
  assertContinuationEvidenceImplementation?: (input: {
    accountId: string;
    backupRoot?: string;
    databaseId: string;
    databaseName: string;
    now?: Date;
    repositoryRoot: string;
    restoreRoot?: string;
    reviewedCommitSha: string;
  }) => Promise<{
    backup: { checksumSha256: string; snapshotId: string };
    restore: { reportRef: string; snapshotId: string };
  }>;
  backupRoot?: string;
  databaseId: string;
  databaseName: string;
  now?: Date;
  repositoryRoot?: string;
  restoreRoot?: string;
  reviewedCommitSha: string;
}): Promise<{
  backupChecksumSha256: string;
  backupSnapshotId: string;
  restoreReportRef: string;
  restoreSnapshotId: string;
  reviewedCommitSha: string;
}>;
export function readOptionalJson(path: string): Promise<unknown | null>;
export function listMigrationNames(root?: string): Promise<string[]>;
export function writeReleaseArtifacts(artifacts: {
  manifest: Record<string, unknown>;
  rollbackMatrix: Array<Record<string, string>>;
}): Promise<{ manifestRef: string; rollbackRef: string }>;
export function validatePilotSmokePlan(plan: unknown): {
  checks: Array<Record<string, unknown>>;
  environment: "production";
  releaseId: string;
};
export function runPilotSmoke(input: {
  confirmProduction: boolean;
  execute: boolean;
  fetchImplementation?: typeof fetch;
  plan: unknown;
}): Promise<{
  actions: Array<{ code: string; name: string; ok: boolean }>;
  environment: "production";
  executed: boolean;
  ok: boolean;
}>;
