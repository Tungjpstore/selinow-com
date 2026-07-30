export type ProductionBootstrapPhase = "resources" | "canary" | "promote";

export interface ProductionBootstrapEvidence {
  approvals: { releaseOwner: string; supportOwner: string };
  backup: {
    completedAt: string | null;
    emptyDatabaseBaselineVerified: boolean;
    providerBookmarkRecorded: boolean;
    restoreDrillCompletedAt: string | null;
    restoreDrillPassed: boolean;
    restoreDrillReportRef: string | null;
    snapshotReportRef: string | null;
  };
  candidateWorkerVersion: string | null;
  canary: {
    accepted: boolean;
    acceptedAt: string | null;
    smokeReportRef: string | null;
    stagingRoutesPreserved: boolean;
    workerVersion: string | null;
  };
  ceremonyId: string;
  environment: "production";
  migrations: { appliedAt: string | null; direction: string; names: string[] };
  monitoring: { alertsReady: boolean; dashboardReady: boolean };
  phase: ProductionBootstrapPhase;
  preBootstrapTrafficSnapshotRef: string;
  previousWorkerVersion: string | null;
  resourceManifestRef: string | null;
  reviewedCommitSha: string;
  reviewedTreeSha: string;
  rollback: { snapshotRef: string; strategy: string };
  schemaVersion: number;
}

export interface ProductionBootstrapResourceInventory {
  d1: Array<{ id: string; name: string }>;
  kv: Array<{ id: string; name: string }>;
  queue: Array<{ name: string }>;
  r2: Array<{ name: string }>;
}

export interface ProductionBootstrapInventory {
  accountId: string;
  domains: Array<{
    hostname: string;
    service: string;
    zoneId: string;
    zoneName: string;
  }>;
  resources: ProductionBootstrapResourceInventory;
  routes: Array<{ pattern: string; script: string | null }>;
  zoneId: string;
  zoneName: string;
}

export interface ProductionBootstrapInput {
  evidence: ProductionBootstrapEvidence;
  inventory: ProductionBootstrapInventory;
  migrationNames: string[];
  now: Date;
  phase: ProductionBootstrapPhase;
  productionSpec: Record<string, unknown>;
  repositoryState: { clean: boolean; commitSha: string; treeSha: string };
  secretNames: string[];
  stagingSpec: Record<string, unknown>;
}

export interface ProductionBootstrapAction {
  action: string;
  code: string;
  hostname?: string;
  id?: string;
  kind?: string;
  name?: string;
  workerName?: string;
}

export interface ProductionBootstrapPlan {
  actions: ProductionBootstrapAction[];
  ceremonyId: string;
  environment: "production";
  fingerprints: {
    evidenceSha256: string;
    inventorySha256: string;
    sourceSha256: string;
    specSha256: string;
  };
  firstVersionRollback: {
    previousWorkerVersion: null;
    snapshotRef: string;
    strategy: "restore_pre_bootstrap_traffic_inventory";
  };
  phase: ProductionBootstrapPhase;
  safeguards: {
    allowedMutations: string[];
    cutoverBlockers: string[];
    forwardOnlyMigrations: true;
    secretNameCount: number;
    secretNamesFingerprintSha256: string;
    secretValuesAccepted: false;
    stagingTrafficImmutable: true;
  };
  schemaVersion: 1;
}

export function inspectProductionBootstrapCutoverBlockers(input: {
  productionSpec: Record<string, unknown>;
  stagingSpec: Record<string, unknown>;
}): string[];

export function buildProductionRouteHandoff(
  productionSpec: Record<string, any>,
  stagingSpec: Record<string, any>,
): {
  canary: Array<{ pattern: string; script: string }>;
  promote: Array<{ pattern: string; script: string }>;
  stagingExceptions: string[];
};

export function assertProductionBootstrapSpecIdentity(productionSpec: Record<string, unknown>): void;
export function assertProductionBootstrapSecretNames(secretNames: string[]): string[];

export function buildProductionBootstrapPlan(input: ProductionBootstrapInput): ProductionBootstrapPlan;

export function assertProductionBootstrapExecutionAdmission(input: {
  confirmFirstProductionBootstrap: boolean;
  confirmProduction: boolean;
  final: ProductionBootstrapInput;
  initial: ProductionBootstrapInput;
}): ProductionBootstrapPlan;

export function writeProductionBootstrapPlan(
  plan: ProductionBootstrapPlan,
  root: string,
): Promise<string>;
