export type DodoCatalogReferences = Readonly<Record<string, string>>;
export type DodoCatalogClassification = {
  mode: "already_configured" | "pending" | "published_unverified" | "rotated"
    | "rotated_unverified" | "rotation_required";
  pendingCount: number;
  publishedCount: number;
};
export type DodoCatalogInspection = DodoCatalogClassification & {
  environment: "staging" | "production";
  reconciliationRequired: boolean;
};
export type DodoCatalogRemoteRunner = (
  environment: "staging" | "production",
  args: string[],
  issue: string,
) => string;
export type DodoCatalogFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export const DODO_CATALOG_OFFERS: readonly Readonly<{
  amountMinor: number;
  currency: "VND" | "USD";
  id: string;
  marketCode: "vn" | "global";
  pendingRef: string;
  planCode: "starter" | "pro";
  referenceEnv: string;
  rotatedId: string;
}>[];

export function parseDodoCatalogArguments(argv: readonly string[]): {
  apply: boolean;
  confirmCatalogUpdate: boolean;
  confirmProduction: boolean;
  confirmProductionLiveCatalog: boolean;
  confirmStagingTestCatalog: boolean;
  environment: "staging" | "production";
  explicitDryRun: boolean;
  inspect: boolean;
  json: boolean;
};
export function readDodoCatalogReferences(environment?: NodeJS.ProcessEnv): DodoCatalogReferences;
export function readOptionalDodoCatalogReferences(
  environment?: NodeJS.ProcessEnv,
): DodoCatalogReferences | null;
export function readDodoCatalogProviderMode(environment?: NodeJS.ProcessEnv): "test_mode" | "live_mode";
export function validateDodoCatalogTarget(input: {
  environment: "staging" | "production";
  providerMode: "test_mode" | "live_mode";
  confirmProduction?: boolean;
  confirmProductionLiveCatalog?: boolean;
  confirmStagingTestCatalog?: boolean;
}): void;
export function validateDodoCatalogProviderEnvironment(input: {
  environment: "staging" | "production";
  providerMode: "test_mode" | "live_mode";
}): void;
export function dodoCatalogCompletionReadSql(): string;
export function dodoCatalogCompletionSql(
  references: DodoCatalogReferences,
  mode: "already_configured" | "rotated",
  sourceReferences?: DodoCatalogReferences | null,
): string;
export function dodoCatalogReadSql(): string;
export function dodoCatalogRotationSql(sourceReferences: DodoCatalogReferences, targetReferences: DodoCatalogReferences): string;
export function classifyDodoCatalogRows(
  rows: readonly Record<string, unknown>[],
  references?: DodoCatalogReferences | null,
): DodoCatalogClassification;
export function dodoCatalogUpdateSql(references: DodoCatalogReferences): string;
export function parseDodoCatalogCommandOutput(output: string): { updatedCount: number };
export function parseDodoCatalogRotationCommandOutput(output: string): { mode: "already_rotated" | "rotated"; closedCount: number; insertedCount: number };
export function inspectDodoCatalog(input: {
  environment: "staging" | "production";
  references?: DodoCatalogReferences | null;
  providerMode: "test_mode" | "live_mode";
  runRemoteImplementation?: DodoCatalogRemoteRunner;
}): DodoCatalogInspection;
export function validateDodoCatalogProducts(input: {
  apiBaseUrl?: string;
  apiKey: string;
  fetcher?: DodoCatalogFetcher;
  providerMode: "test_mode" | "live_mode";
  references: DodoCatalogReferences;
}): Promise<void>;
export function reconcileDodoCatalog(input: {
  apiBaseUrl?: string;
  apiKey: string;
  environment: "staging" | "production";
  fetcher?: DodoCatalogFetcher;
  references: DodoCatalogReferences;
  providerMode: "test_mode" | "live_mode";
  confirmProduction?: boolean;
  confirmProductionLiveCatalog?: boolean;
  confirmStagingTestCatalog?: boolean;
  runRemoteImplementation?: DodoCatalogRemoteRunner;
}): Promise<DodoCatalogInspection & { updatedCount: number; closedCount: number; insertedCount: number }>;
