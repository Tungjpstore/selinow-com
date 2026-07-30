export interface ProductionBootstrapExecuteFlags {
  confirmFirstProductionBootstrap: boolean;
  confirmProduction: boolean;
  dryRun: boolean;
  environment: "production";
  execute: boolean;
  json: boolean;
}

export function parseProductionBootstrapExecuteFlags(argv: string[]): ProductionBootstrapExecuteFlags;

export const PRODUCTION_BOOTSTRAP_MIGRATION_TOKEN_NAME: "CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN";
export function requireProductionBootstrapMigrationToken(environment?: NodeJS.ProcessEnv): string;
export function buildProductionBootstrapMigrationEnvironment(
  environment: NodeJS.ProcessEnv,
  accountId: string,
  token: string,
): NodeJS.ProcessEnv;

export function validateProductionBootstrapMigrationAdmission(input: Record<string, unknown>): {
  accountId: string;
  databaseId: string;
  databaseName: string;
  migrationNames: string[];
  secretNameCount: number;
};

export function runProductionBootstrapMigrations(input: Record<string, unknown>): Promise<Record<string, unknown>>;
