export const CANARY_AUDIT_TOKEN_NAME: "CLOUDFLARE_CANARY_AUDIT_API_TOKEN";
export const CANARY_ROUTE_TOKEN_NAME: "CLOUDFLARE_CANARY_ROUTE_API_TOKEN";
export const CANARY_WORKER_TOKEN_NAME: "CLOUDFLARE_CANARY_WORKER_API_TOKEN";

export interface ProductionCanaryRoute {
  id: string;
  pattern: string;
  script: string | null;
}

export interface ProductionCanaryInventory {
  accountId: string;
  databaseId: string;
  databaseName: string;
  deployments: Array<{ createdOn: string; id: string; versionId: string }>;
  domains: Array<{ hostname: string; service: string; zoneId: string | null; zoneName: string | null }>;
  observedAt: string;
  queueConsumers: Array<{ consumers: unknown[]; queueName: string }>;
  routes: ProductionCanaryRoute[];
  schedules: Array<{ cron: string }>;
  secretNames: string[];
  versions: Array<{ annotations: Record<string, unknown>; id: string; metadata: Record<string, unknown>; number: number | null }>;
  workerName: string;
  zoneId: string;
  zoneName: string;
}

export interface ProductionCanaryDnsAdmission {
  addresses: string[];
  hostname: string;
}

export function requireCanaryAuditToken(environment: NodeJS.ProcessEnv): string;
export function requireCanaryRouteToken(environment: NodeJS.ProcessEnv): string;
export function requireCanaryWorkerToken(environment: NodeJS.ProcessEnv): string;
export function buildCanaryWranglerEnvironment(environment: NodeJS.ProcessEnv, accountId: string, token: string): NodeJS.ProcessEnv;
export function buildCanaryBuildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function resolveProductionCanaryDns(input: {
  fetchImplementation?: typeof fetch;
  hostname: string;
  resolve4Implementation?: (hostname: string) => Promise<string[]>;
  resolve6Implementation?: (hostname: string) => Promise<string[]>;
}): Promise<ProductionCanaryDnsAdmission>;
export function assertProductionCanaryDnsAdmission(
  admission: unknown,
  productionSpec: Record<string, any>,
): ProductionCanaryDnsAdmission;
export function assertProductionCanaryStaticIdentity(input: {
  canonicalGeneratedManifest: Record<string, any>;
  canonicalProductionSpec: Record<string, any>;
  generatedManifest: Record<string, any>;
  productionSpec: Record<string, any>;
}): void;
export function validateProductionCanaryPlan(input: Record<string, any>): string;
export function normalizeCanaryInventory(input: Record<string, any>): ProductionCanaryInventory;
export function validateCandidateVersionView(
  view: Record<string, any>,
  candidateVersionId: string,
  input: {
    generatedManifest: Record<string, any>;
    productionSpec: Record<string, any>;
    wranglerConfig: Record<string, any>;
  },
): string[];

export function discoverProductionCanaryInventory(input: {
  auditToken: string;
  commandEnvironment: NodeJS.ProcessEnv;
  databaseId: string;
  fetchImplementation?: typeof fetch;
  now?: Date;
  productionSpec: Record<string, any>;
  repositoryRoot: string;
  runWranglerImplementation: (
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => { stderr: string; stdout: string };
}): Promise<ProductionCanaryInventory>;

export function runProductionCanaryUpload(input: Record<string, any>): Promise<Record<string, any>>;
export function runProductionCanaryApply(input: Record<string, any>): Promise<Record<string, any>>;
export function runProductionCanaryRollback(input: Record<string, any>): Promise<Record<string, any>>;
export function createProductionCanaryRoute(input: {
  fetchImplementation?: typeof fetch;
  pattern: string;
  script: string;
  token: string;
  zoneId: string;
}): Promise<Record<string, any>>;
export function deleteProductionCanaryRoute(input: {
  fetchImplementation?: typeof fetch;
  routeId: string;
  token: string;
  zoneId: string;
}): Promise<unknown>;
export function writeProductionCanaryReport(
  root: string,
  ceremonyId: string,
  mode: "applied" | "rollback" | "upload",
  value: unknown,
): Promise<string>;
