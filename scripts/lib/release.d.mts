export type ReleaseCheck = { name: string; ok: boolean };
export type ProductionWranglerToolchainAttestation = {
  cliPath: string;
  fingerprintSha256: string;
  packageVersion: string;
};

export function buildProductionReleaseGitEnvironment(
  environment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
export function runProductionReleaseGit(
  args: string[],
  options?: {
    cwd?: string;
    encoding?: BufferEncoding;
    environment?: NodeJS.ProcessEnv;
  },
): import("node:child_process").SpawnSyncReturns<string>;
export function createProductionWranglerToolchainAttestation(
  root?: string,
): Promise<ProductionWranglerToolchainAttestation>;
export function fingerprintProductionWranglerToolchain(root?: string): Promise<string>;
export function assertProductionWranglerToolchain(
  expected: ProductionWranglerToolchainAttestation,
  root?: string,
): Promise<ProductionWranglerToolchainAttestation>;
export function runAttestedProductionWrangler(
  attestation: ProductionWranglerToolchainAttestation,
  args: string[],
  options?: {
    capture?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    repositoryRoot?: string;
  },
): Promise<{ stderr: string; stdout: string }>;

export const REQUIRED_PRODUCTION_VARS: string[];
export const REQUIRED_WORKER_SECRET_NAMES: string[];
export function evaluateBackupPrerequisites(evidence: Record<string, unknown> | null, now?: Date): ReleaseCheck[];
export function inspectProductionReadiness(input: {
  evidence: Record<string, unknown> | null;
  candidatePending?: boolean;
  now: Date;
  productionSpec: Record<string, unknown> | null;
  workerSecretNames: string[];
  wranglerConfig: Record<string, unknown>;
}): { checks: ReleaseCheck[]; missing: string[]; ok: boolean };
export function buildRollbackMatrix(): Array<Record<string, string>>;
export function buildReleaseArtifacts(input: {
  evidence: Record<string, unknown>;
  migrationNames: string[];
  now: Date;
  packageVersion: string;
  productionSpec: Record<string, unknown>;
  workerSecretNames: string[];
  wranglerConfig: Record<string, unknown>;
}): { manifest: Record<string, unknown>; rollbackMatrix: Array<Record<string, string>> };
export function validateProductionDeployAdmission(input: {
  evidence: Record<string, unknown>;
  manifest: unknown;
  migrationNames: string[];
  now: Date;
  packageVersion: string;
  productionSpec: Record<string, unknown>;
  repositoryClean: boolean;
  repositoryCommitSha: string;
  workerSecretNames: string[];
  wranglerConfig: Record<string, unknown>;
}): { candidateWorkerVersion: string; commitSha: string; previousWorkerVersion: string; releaseId: string };
export function validateProductionCandidateUploadAdmission(input: {
  evidence: Record<string, unknown>;
  migrationNames: string[];
  now: Date;
  packageVersion: string;
  productionSpec: Record<string, unknown>;
  repositoryClean: boolean;
  repositoryCommitSha: string;
  workerSecretNames: string[];
  wranglerConfig: Record<string, unknown>;
}): { commitSha: string; previousWorkerVersion: string; releaseId: string };
export function captureProductionCandidateVersion(input: {
  activeVersionId: string;
  afterVersions: Array<Record<string, unknown>>;
  beforeVersions: Array<Record<string, unknown>>;
}): string;
export function productionDeploymentVersion(deployments: unknown): string;
export function fingerprintProductionUploadInputs(root?: string): Promise<string>;
export function removeProductionUploadStage(
  stageRoot: string,
  root: string | undefined,
  releaseId: string,
): Promise<void>;
export function stageProductionUploadInputs(
  root: string | undefined,
  releaseId: string,
  input?: {
    generatedManifest: Record<string, any>;
    productionSpec: Record<string, any>;
  },
): Promise<{ artifactSha256: string; stageRoot: string; uploadConfigSha256: string }>;
export function validateProductionGeneratedUploadConfig(
  config: Record<string, any>,
  input: {
    generatedManifest: Record<string, any>;
    productionSpec: Record<string, any>;
  },
): true;
export function validateProductionCandidateVersionView(
  view: Record<string, any>,
  candidateWorkerVersion: string,
  input: {
    generatedManifest: Record<string, any>;
    productionSpec: Record<string, any>;
    wranglerConfig: Record<string, any>;
  },
): string[];
export function validateProductionCandidateVersionProvenance(
  view: Record<string, any>,
  input: { commitSha: string; tag: string },
): { message: string; source: string; tag: string; triggeredBy: string };
export function assertProductionPreActivationVersions(
  initialAdmission: Record<string, any>,
  finalAdmission?: Record<string, any>,
): string;
export function buildProductionReleaseAuditEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
  accountId: string,
  auditToken: string,
): NodeJS.ProcessEnv;
export function buildProductionReleaseEditEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
  accountId: string,
  editToken: string,
): NodeJS.ProcessEnv;
export function writeProductionCandidateArtifacts(input: {
  evidence: Record<string, any>;
  evidencePath: string;
  report: Record<string, any>;
  repositoryRoot?: string;
}): Promise<{
  candidateWorkerVersion: string;
  evidence: Record<string, any>;
  reportRef: string;
}>;
export function assertProductionDeployAdmission(input: {
  evidencePath?: string;
  manifestPath: string;
  now?: Date;
  repositoryRoot?: string;
  specPath?: string;
  workerSecretNames: string[];
}): Promise<{
  candidateReport: Record<string, any>;
  candidateWorkerVersion: string;
  commitSha: string;
  previousWorkerVersion: string;
  releaseId: string;
}>;
export function assertProductionWorkerDeployAdmission(input: {
  assertReleaseAdmissionImplementation?: (input: {
    manifestPath: string;
    now?: Date;
    repositoryRoot: string;
    workerSecretNames: string[];
  }) => Promise<{
    candidateReport: Record<string, any>;
    candidateWorkerVersion: string;
    commitSha: string;
    previousWorkerVersion: string;
    releaseId: string;
  }>;
  candidateVersionViewImplementation?: (
    accountId: string,
    workerName: string,
    versionId: string,
  ) => Promise<Record<string, any>>;
  deploymentInventoryImplementation?: (accountId: string, workerName: string) => Promise<unknown>;
  environment?: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
  generatedManifest?: Record<string, unknown> | null;
  manifestPath: string;
  now?: Date;
  productionSpec?: Record<string, unknown> | null;
  repositoryRoot?: string;
  runWranglerImplementation?: (
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => { stderr: string; stdout: string };
  stagingSpec?: Record<string, unknown> | null;
  token?: string;
  verifyLocalArtifact?: boolean;
  workerIdentityImplementation?: (input: Record<string, unknown>) => Promise<{
    accountId: string;
    databaseId: string;
    databaseName: string;
    workerName: string;
    zoneId: string;
    zoneName: string;
  }>;
  workerSecretNames: string[];
  wranglerConfig?: Record<string, unknown>;
}): Promise<{
  accountId: string;
  activeWorkerVersion: string;
  bindingNames: string[];
  candidateReport: Record<string, any>;
  candidateWorkerVersion: string;
  commitSha: string;
  databaseId: string;
  databaseName: string;
  previousWorkerVersion: string;
  releaseId: string;
  workerName: string;
  zoneId: string;
  zoneName: string;
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
