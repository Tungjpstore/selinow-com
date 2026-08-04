export const repositoryRoot: string;

export class CloudflareApiError extends Error {
  code: string;
  status: number;
}

export interface SaasDnsRecord {
  content: string;
  key: string;
  name: string;
  proxied: boolean;
  ttl: number;
  type: string;
}

export interface PlatformEnvironmentSpec {
  accountId: string;
  environment: "staging";
  hostnames: string[];
  resources: { d1: string };
  saas: {
    cnameTarget: string;
    dnsRecords: SaasDnsRecord[];
    fallbackOrigin: string;
  };
  sharedZoneDisabledRoutes: string[];
  productionWorkerName: string;
  wildcardRoute: string;
  workerName: string;
  workerRoutes: Array<
    | { custom_domain: true; pattern: string }
    | { pattern: string; zone_name: string }
  >;
  zoneId: string;
  zoneName: string;
}

export interface SaasState {
  dnsRecords: Record<string, Array<Record<string, unknown>>>;
  fallbackOrigin: { origin: string; status: string } | null;
}

export interface SaasAction {
  action: "conflict" | "create" | "reuse" | "update";
  key: string;
  kind: "dns" | "fallback_origin";
  name: string;
  recordId?: string;
  status?: string;
}

export interface StagingRouteCheck {
  code: string;
  detail: string;
  ok: boolean;
}

export interface StagingRouteAudit {
  checks: StagingRouteCheck[];
  ok: boolean;
}

export interface StagingMutationAdmission extends StagingRouteAudit {
  accountId: string;
  databaseId: string;
  databaseName: string;
  environment?: "staging";
  observedAt?: string;
  workerName?: string;
  zoneId?: string;
  zoneName?: string;
}

export function assertOwnedName(name: string): void;
export function buildStagingRoutes(
  spec: PlatformEnvironmentSpec,
): PlatformEnvironmentSpec["workerRoutes"];
export function validateStagingRouteInventory(
  spec: PlatformEnvironmentSpec,
  liveRoutes: unknown,
): StagingRouteAudit;
export function auditStagingRouteInventory(
  spec: PlatformEnvironmentSpec,
  token: string,
  fetchImplementation?: typeof fetch,
): Promise<StagingRouteAudit>;
export function validateProductionWorkerRouteInventory(
  productionSpec: Record<string, any>,
  stagingSpec: Record<string, any>,
  wranglerConfig: Record<string, any>,
  liveRoutes: unknown,
  liveDomains: unknown,
): { checks: StagingRouteCheck[]; ok: boolean };
export function assertProductionWorkerDatabaseIdentity(
  d1ListOutput: unknown,
  databaseId: string,
  databaseName: string,
): void;
export function assertProductionWorkerIdentityAdmission(input: {
  environment?: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
  productionSpec: Record<string, any>;
  repositoryRoot?: string;
  runWranglerImplementation?: (
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => { stderr: string; stdout: string };
  stagingSpec: Record<string, any>;
  token?: string;
  wranglerConfig: Record<string, any>;
}): Promise<{
  accountId: string;
  checks: StagingRouteCheck[];
  databaseId: string;
  databaseName: string;
  ok: boolean;
  workerName: string;
  zoneId: string;
  zoneName: string;
}>;
export function inspectStagingRoutePreflight(input?: {
  environment?: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
  runWranglerImplementation?: (
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => { stderr: string; stdout: string };
  runtimeIdentityImplementation?: (spec: PlatformEnvironmentSpec) => Promise<{ databaseId: string; databaseName: string }>;
  spec?: PlatformEnvironmentSpec;
  token?: string;
}): Promise<StagingMutationAdmission & {
  environment: "staging";
  observedAt: string;
  workerName: string;
  zoneId: string;
  zoneName: string;
}>;
export function assertStagingDeployAdmission(input?: {
  doctorImplementation?: (environment: "staging", input?: Record<string, unknown>) => Promise<{ checks?: Array<{ code?: string; ok?: boolean }>; ok: boolean }>;
  environment?: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
  runWranglerImplementation?: (
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => { stderr: string; stdout: string };
  spec?: PlatformEnvironmentSpec;
  token?: string;
  platformToken?: string;
  runtimeIdentityImplementation?: (spec: PlatformEnvironmentSpec) => Promise<{ databaseId: string; databaseName: string }>;
}): Promise<StagingMutationAdmission>;
export function assertStagingMutationAdmission(input?: {
  doctorImplementation?: (environment: "staging", input?: Record<string, unknown>) => Promise<{ checks?: Array<{ code?: string; ok?: boolean }>; ok: boolean }>;
  environment?: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
  runWranglerImplementation?: (
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => { stderr: string; stdout: string };
  spec?: PlatformEnvironmentSpec;
  token?: string;
  platformToken?: string;
  runtimeIdentityImplementation?: (spec: PlatformEnvironmentSpec) => Promise<{ databaseId: string; databaseName: string }>;
}): Promise<StagingMutationAdmission>;
export function validateStagingRuntimeIdentity(
  spec: PlatformEnvironmentSpec & { resources: { d1: string } },
  manifest: Record<string, any>,
  wranglerConfig: Record<string, any>,
): { databaseId: string; databaseName: string };
export function assertStagingAccountIdentity(
  whoamiOutput: unknown,
  accountId: string,
): void;
export function assertStagingDatabaseIdentity(
  d1ListOutput: unknown,
  databaseId: string,
  databaseName: string,
): void;
export function buildPinnedCloudflareEnvironment(
  environment: NodeJS.ProcessEnv,
  accountId: string,
): NodeJS.ProcessEnv;
export function buildQueueBindings(
  resources: {
    deadLetterQueue: string;
    integrationQueue: string;
    notificationQueue: string;
  },
  maxRetries: number,
): {
  producers: Array<{ binding: string; queue: string }>;
  consumers: Array<{
    dead_letter_queue?: string;
    max_batch_size: number;
    max_batch_timeout: number;
    max_retries: number;
    queue: string;
    retry_delay?: number;
  }>;
};
export function buildStagingVars(
  spec: PlatformEnvironmentSpec,
  manifest: { version: string },
): Record<string, string>;
export function cloudflareApiRequest(
  token: string,
  path: string,
  options?: {
    body?: unknown;
    fetchImplementation?: typeof fetch;
    method?: string;
  },
): Promise<unknown>;
export function doctor(
  environment: "local" | "production" | "staging",
  input?: {
    accountId?: string;
    environment?: NodeJS.ProcessEnv;
    fetchImplementation?: typeof fetch;
    runWranglerImplementation?: (
      args: string[],
      options?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => { stderr: string; stdout: string };
    spec?: PlatformEnvironmentSpec & { resources: Record<string, string> };
  },
): Promise<{ checks: Array<{ code: string; detail: string; ok: boolean }>; environment: string; ok: boolean }>;
export function discoverSaasState(
  spec: PlatformEnvironmentSpec,
  token: string,
  fetchImplementation?: typeof fetch,
): Promise<SaasState>;
export function parseQueueNames(output: string): string[];
export function parseR2Names(output: string): string[];
export function parseSecretNames(output: string): string[];
export function planSaasConfiguration(
  spec: PlatformEnvironmentSpec,
  state: SaasState,
): SaasAction[];
export function provision(
  environment: "staging",
  dryRun: boolean,
  input?: {
    environment?: NodeJS.ProcessEnv;
    fetchImplementation?: typeof fetch;
    platformToken?: string;
    runWranglerImplementation?: (
      args: string[],
      options?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => { stderr: string; stdout: string };
    writeGeneratedConfigImplementation?: (
      spec: PlatformEnvironmentSpec,
      manifest: Record<string, unknown>,
    ) => Promise<void>;
  },
): Promise<{
  actions: Array<Record<string, unknown>>;
  environment: "staging";
  ok: true;
  manifest?: Record<string, unknown>;
}>;
export function requireCloudflarePlatformToken(environment?: NodeJS.ProcessEnv): string;
export function requireCloudflareRouteAuditToken(environment?: NodeJS.ProcessEnv): string;
