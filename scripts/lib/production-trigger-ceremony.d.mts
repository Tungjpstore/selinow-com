export interface ProductionTriggerSpec {
  accountId: string;
  environment: "production";
  resources: {
    deadLetterQueue: string;
    integrationQueue: string;
    notificationQueue: string;
  };
  workerName: string;
  cron?: string;
}

export interface ProductionTriggerSettings {
  batchSize?: number;
  batchTimeout?: number;
  deadLetterQueue?: string;
  maxConcurrency?: number;
  maxRetries?: number;
  retryDelaySecs?: number;
}

export interface ProductionTriggerConsumer {
  queue: string;
  script: string;
  settings: ProductionTriggerSettings;
}

export interface ProductionTriggerInventory {
  accountId: string;
  activeWorkerVersion: string | null;
  configFingerprintSha256: string;
  environment: "production";
  observedAt: string;
  queueConsumers: Array<{ consumers: Array<{ script: string; settings: ProductionTriggerSettings }>; queueName: string }>;
  schedules: string[];
  workerName: string;
}

export interface ProductionTriggerReleaseBinding {
  candidateWorkerVersion: string;
  commitSha: string;
  manifestRef: string;
  manifestSha256: string;
  releaseId: string;
  treeSha: string;
}

export interface ProductionTriggerAction {
  action: "create" | "reuse";
  code: string;
  kind: "cron" | "queue_consumer";
  queue?: string;
  script?: string;
  settings?: ProductionTriggerSettings;
  cron?: string;
}

export interface ProductionTriggerPlan {
  actions: ProductionTriggerAction[];
  accountId: string;
  configFingerprintSha256: string;
  environment: "production";
  fingerprints: { inventorySha256: string; planSha256: string };
  release: ProductionTriggerReleaseBinding;
  safeguards: { allowedMutations: string[]; confirmation: string; defaultMode: string; noDeletes: boolean; noUpdates: boolean };
  schemaVersion: number;
  workerName: string;
}

export interface ProductionTriggerEvidence {
  accountId: string;
  after: { activeWorkerVersion: string | null; queueConsumers: ProductionTriggerInventory["queueConsumers"]; schedules: string[] };
  before: { activeWorkerVersion: string | null; queueConsumers: ProductionTriggerInventory["queueConsumers"]; schedules: string[] };
  configFingerprintSha256: string;
  createdResources: Array<{ kind: "cron"; cron: string } | { kind: "queue_consumer"; queue: string; script: string }>;
  environment: "production";
  observedAt: string;
  planSha256: string;
  referencesOnly: true;
  release: ProductionTriggerReleaseBinding;
  schemaVersion: number;
  workerName: string;
}

export function applyProductionTriggerPlan(input: Record<string, unknown> & {
  confirmProduction: boolean;
  configFingerprintSha256: string;
  inventory: ProductionTriggerInventory;
  plan: ProductionTriggerPlan;
  releaseBinding?: ProductionTriggerReleaseBinding;
  spec: ProductionTriggerSpec;
  runWranglerImplementation?: (args: string[], options?: Record<string, unknown>) => { stderr: string; stdout: string };
}): Promise<{ createdResources: ProductionTriggerEvidence["createdResources"]; executed: boolean; ok: boolean }>;
export function buildProductionTriggerPlan(input: {
  configFingerprintSha256: string;
  inventory: ProductionTriggerInventory;
  releaseBinding: ProductionTriggerReleaseBinding;
  spec: ProductionTriggerSpec;
}): ProductionTriggerPlan;
export function compensateProductionTriggerCeremony(input: Record<string, unknown> & {
  confirmProduction: boolean;
  currentInventory: ProductionTriggerInventory;
  evidence: ProductionTriggerEvidence;
  spec: ProductionTriggerSpec;
}): Promise<{ executed: boolean; ok: boolean; rolledBackResources: ProductionTriggerEvidence["createdResources"] }>;
export function createProductionTriggerEvidence(input: {
  after: ProductionTriggerInventory;
  before: ProductionTriggerInventory;
  configFingerprintSha256: string;
  createdResources: ProductionTriggerEvidence["createdResources"];
  planSha256: string;
  releaseBinding: ProductionTriggerReleaseBinding;
  spec: ProductionTriggerSpec;
}): ProductionTriggerEvidence;
export function deriveProductionTriggerConfig(spec: ProductionTriggerSpec, wranglerConfig: Record<string, unknown>): {
  configFingerprintSha256: string;
  releaseConfigFingerprintSha256: string;
  spec: ProductionTriggerSpec;
};
export function desiredProductionTriggerSpec(spec: ProductionTriggerSpec): {
  accountId: string;
  consumers: ProductionTriggerConsumer[];
  cron: string;
  environment: "production";
  workerName: string;
};
export function discoverProductionTriggerInventory(input: Record<string, unknown> & {
  auditToken: string;
  configFingerprintSha256: string;
  fetchImplementation?: typeof fetch;
  releaseBinding?: ProductionTriggerReleaseBinding;
  spec: ProductionTriggerSpec;
  runWranglerImplementation?: (args: string[], options?: Record<string, unknown>) => { stderr: string; stdout: string };
}): Promise<ProductionTriggerInventory>;
export function executeProductionTriggerCeremony(input: Record<string, unknown> & {
  apply: boolean;
  confirmProduction: boolean;
  configFingerprintSha256: string;
  discoverInventoryImplementation?: (context?: Record<string, unknown>) => Promise<ProductionTriggerInventory>;
  plan?: ProductionTriggerPlan;
  releaseBinding: ProductionTriggerReleaseBinding;
  spec: ProductionTriggerSpec;
}): Promise<Record<string, unknown> & { evidence: ProductionTriggerEvidence; ok: boolean; plan: ProductionTriggerPlan }>;
export function fingerprintProductionTrigger(value: unknown): string;
export function normalizeProductionTriggerInventory(input: Record<string, unknown>): ProductionTriggerInventory;
export function normalizeProductionTriggerReleaseBinding(value: unknown): ProductionTriggerReleaseBinding | null;
export function productionTriggerSchedulePath(spec: ProductionTriggerSpec): string;
export function validateProductionTriggerReleaseManifest(input: Record<string, unknown> & {
  evidence: Record<string, unknown>;
  manifest: Record<string, unknown>;
  manifestSha256: string;
  releaseConfigFingerprintSha256: string;
  repositoryState?: { clean: boolean; commitSha: string; treeSha: string };
}): ProductionTriggerReleaseBinding;
export function writeProductionTriggerEvidence(path: string, evidence: ProductionTriggerEvidence): Promise<string>;
