export const PRODUCTION_CONTINUATION_ROUTE_MUTATION_TOKEN_NAME: "CLOUDFLARE_PRODUCTION_ROUTE_MUTATION_API_TOKEN";
export const PRODUCTION_CONTINUATION_ROUTE_AUDIT_TOKEN_NAME: "CLOUDFLARE_ROUTE_AUDIT_API_TOKEN";

export interface ProductionContinuationRoute {
  id: string;
  pattern: string;
  script: string | null;
}

export interface ProductionContinuationReleaseBinding {
  candidateWorkerVersion: string;
  commitSha: string;
  manifestRef: string;
  manifestSha256: string;
  releaseId: string;
  treeSha: string;
}

export interface ProductionContinuationDatabaseIdentity {
  databaseId: string;
  databaseName: string;
}

export interface ProductionContinuationRouteInventory extends ProductionContinuationDatabaseIdentity {
  accountId: string;
  activeWorkerVersion: string;
  routes: ProductionContinuationRoute[];
  workerName: string;
  zoneId: string;
  zoneName: string;
}

export interface ProductionContinuationRouteChange {
  after: ProductionContinuationRoute;
  before: ProductionContinuationRoute | null;
  pattern: string;
  script: string;
  type: "create" | "replace";
}

export interface ProductionContinuationRouteState {
  accountId: string;
  appliedAt: string;
  candidateWorkerVersion: string;
  changes: ProductionContinuationRouteChange[];
  commitSha: string;
  databaseId: string;
  databaseName: string;
  environment: "production";
  manifestRef: string;
  manifestSha256: string;
  mode: "applied";
  planSha256: string;
  releaseId: string;
  routesAfter: ProductionContinuationRoute[];
  routesAfterSha256: string;
  routesBefore: ProductionContinuationRoute[];
  schemaVersion: 1;
  stagingExceptions: string[];
  stateSha256: string;
  treeSha: string;
  workerName: string;
  zoneId: string;
  zoneName: string;
}

export function fingerprintProductionContinuationRoute(value: unknown): string;
export function normalizeProductionContinuationRoute(route: unknown): ProductionContinuationRoute;
export function normalizeProductionContinuationRouteInventory(
  input: Record<string, any>,
  options?: { database?: ProductionContinuationDatabaseIdentity; productionSpec?: Record<string, any> },
): ProductionContinuationRouteInventory;
export function buildProductionContinuationRoutePlan(input: Record<string, any>): Record<string, any>;
export function applyProductionContinuationRouteHandoff(input: Record<string, any>): Promise<Record<string, any>>;
export function rollbackProductionContinuationRouteHandoff(input: Record<string, any>): Promise<Record<string, any>>;
export const executeProductionContinuationRouteHandoff: typeof applyProductionContinuationRouteHandoff;
export const compensateProductionContinuationRouteHandoff: typeof rollbackProductionContinuationRouteHandoff;
export function validateProductionContinuationRouteState(input: Record<string, any>): Record<string, any>;
export function discoverProductionContinuationRouteInventory(input: Record<string, any> & { deploymentAuditToken?: string }): Promise<ProductionContinuationRouteInventory>;
export function createProductionContinuationRoute(input: Record<string, any>): Promise<Record<string, any>>;
export function updateProductionContinuationRoute(input: Record<string, any>): Promise<Record<string, any>>;
export function deleteProductionContinuationRoute(input: Record<string, any>): Promise<unknown>;
export function writeProductionContinuationRouteState(
  root: string,
  state: ProductionContinuationRouteState,
): Promise<string>;
