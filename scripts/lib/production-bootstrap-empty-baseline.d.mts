export interface ProductionBootstrapEmptyBaselineFlags {
  confirmFirstProductionBootstrap: boolean;
  confirmProduction: boolean;
  dryRun: boolean;
  environment: "production";
  execute: boolean;
  json: boolean;
}

export function parseProductionBootstrapEmptyBaselineFlags(
  argv: string[],
): ProductionBootstrapEmptyBaselineFlags;

export const PRODUCTION_EMPTY_BASELINE_TOKEN_NAME: "CLOUDFLARE_PRODUCTION_EMPTY_BASELINE_API_TOKEN";
export function requireProductionEmptyBaselineToken(environment?: NodeJS.ProcessEnv): string;
export function buildProductionEmptyBaselineEnvironment(
  environment: NodeJS.ProcessEnv,
  accountId: string,
  token: string,
): NodeJS.ProcessEnv;

export function validateProductionBootstrapEmptyBaselineAdmission(input: Record<string, unknown>): {
  accountId: string;
  databaseId: string;
  databaseName: string;
};

export function runProductionBootstrapEmptyBaselineDrill(
  input: Record<string, any>,
): Promise<Record<string, any>>;

export const emptyBaselinePaths: Readonly<{ reportRoot: string }>;
