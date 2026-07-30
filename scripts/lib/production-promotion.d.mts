export const PROMOTION_AUDIT_TOKEN_NAME: "CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN";
export const PROMOTION_ROUTE_TOKEN_NAME: "CLOUDFLARE_PRODUCTION_PROMOTION_ROUTE_API_TOKEN";

export interface ProductionPromotionRoute {
  id: string;
  pattern: string;
  script: string | null;
}

export interface ProductionPromotionInventory {
  accountId: string;
  activeVersionId?: string;
  deployments?: Array<{ versionId: string }>;
  domains: Array<{
    hostname: string;
    service: string;
    zoneId: string | null;
    zoneName: string | null;
  }>;
  observedAt: string;
  queueConsumers?: Array<{ consumers: unknown[]; queueName: string }>;
  routes: ProductionPromotionRoute[];
  schedules?: Array<{ cron: string }>;
  workerName: string;
  zoneId: string;
  zoneName: string;
}

export function fingerprint(value: unknown): string;
export function requirePromotionAuditToken(environment: NodeJS.ProcessEnv): string;
export function requirePromotionRouteToken(environment: NodeJS.ProcessEnv): string;
export function buildProductionPromotionAuditEnvironment(
  environment: NodeJS.ProcessEnv,
  accountId: string,
  token: string,
): NodeJS.ProcessEnv;
export function validateProductionPromotionPlan(input: Record<string, any>): {
  handoff: {
    canary: Array<{ pattern: string; script: string }>;
    promote: Array<{ pattern: string; script: string }>;
    stagingExceptions: string[];
  };
  planSha256: string;
  trafficSnapshot: Record<string, any>;
};
export function runProductionPromotion(input: Record<string, any>): Promise<Record<string, any>>;
export function runProductionPromotionRollback(input: Record<string, any>): Promise<Record<string, any>>;
export function createProductionPromotionRoute(input: {
  fetchImplementation?: typeof fetch;
  pattern: string;
  script: string | null;
  token: string;
  zoneId: string;
}): Promise<Record<string, any>>;
export function updateProductionPromotionRoute(input: {
  fetchImplementation?: typeof fetch;
  pattern: string;
  routeId: string;
  script: string | null;
  token: string;
  zoneId: string;
}): Promise<Record<string, any>>;
export function deleteProductionPromotionRoute(input: {
  fetchImplementation?: typeof fetch;
  routeId: string;
  token: string;
  zoneId: string;
}): Promise<unknown>;
export function writeProductionPromotionReport(
  root: string,
  ceremonyId: string,
  mode: "applied" | "failure" | "rollback",
  value: unknown,
): Promise<string>;
