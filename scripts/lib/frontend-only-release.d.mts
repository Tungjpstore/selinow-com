export const FRONTEND_ONLY_RELEASE_MODE: "production_frontend_only_v1";
export const FRONTEND_ONLY_BASELINE_COMMIT: string;
export const FRONTEND_ONLY_ROLLBACK_VERSION: string;
export const FRONTEND_ONLY_SMOKE_CHECKS: ReadonlyArray<{
  allowedStatuses: number[];
  method: "GET";
  name: string;
  url: string;
}>;

export function discoverFrontendOnlyWorkerVersions(input: {
  accountId: string;
  fetchImplementation?: typeof fetch;
  token: string;
  workerName: string;
}): Promise<Array<{
  annotations: Record<string, unknown>;
  id: string;
  metadata: Record<string, unknown>;
  number: number | null;
}>>;
export function waitForFrontendOnlyActiveVersion(input: {
  allowedVersions: Set<string>;
  attempts?: number;
  delayImplementation?: (milliseconds: number) => Promise<unknown>;
  expectedVersion: string;
  inventoryImplementation: () => Promise<{
    deployments: Array<{ versionId: string }>;
    [key: string]: unknown;
  }>;
}): Promise<{
  deployments: Array<{ versionId: string }>;
  [key: string]: unknown;
}>;
export function compensateFrontendOnlyActivation(input: {
  allowedVersions: Set<string>;
  attempts?: number;
  candidateWorkerVersion: string;
  delayImplementation?: (milliseconds: number) => Promise<unknown>;
  deployRollbackImplementation: () => unknown | Promise<unknown>;
  inventoryImplementation: () => Promise<Record<string, any>>;
  migrationLedgerImplementation: () => unknown | Promise<unknown>;
  originalError: unknown;
  verifyRestoredImplementation: (
    restoredInventory: Record<string, any>,
    restoredLedger: unknown,
  ) => unknown | Promise<unknown>;
}): Promise<never>;
export function fingerprintFrontendOnly(value: unknown): string;
export function validateFrontendOnlyEvidence(evidence: unknown): Record<string, any>;
export function qualifyFrontendOnlySource(input: {
  baselinePackage: Record<string, any>;
  currentPackage: Record<string, any>;
  evidence: Record<string, any>;
  source: Record<string, any>;
}): Record<string, unknown>;
export function normalizeFrontendOnlyMigrationLedger(output: unknown): Array<{
  appliedAt: string;
  id: number;
  name: string;
}>;
export function assertFrontendOnlyControlInventory(inventory: Record<string, any>): string;
export function assertFrontendOnlyUploadTransition(
  before: Record<string, any>,
  after: Record<string, any>,
): string;
export function assertFrontendOnlyVersionParity(
  previousView: Record<string, any>,
  candidateView: Record<string, any>,
): { bindingNames: string[]; runtimeSha256: string };
export function assertFrontendOnlyActivationTransition(
  before: Record<string, any>,
  after: Record<string, any>,
  candidateVersionId: string,
): string;
export function runFrontendOnlySmoke(fetchImplementation?: typeof fetch): Promise<Array<{
  name: string;
  status: number;
  url: string;
}>>;
