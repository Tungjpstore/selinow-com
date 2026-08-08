export type DodoCatalogReferences = Readonly<Record<string, string>>;
export type DodoCatalogClassification = {
  mode: "already_configured" | "pending" | "rotation_required" | "rotated";
  pendingCount: number;
  publishedCount: number;
};

export const DODO_CATALOG_OFFERS: readonly Readonly<{
  amountMinor: number;
  currency: "VND" | "USD";
  id: string;
  marketCode: "vn" | "global";
  pendingRef: string;
  planCode: "starter" | "pro";
  referenceEnv: string;
}>[];

export function parseDodoCatalogArguments(argv: readonly string[]): {
  apply: boolean;
  confirmCatalogUpdate: boolean;
  confirmProduction: boolean;
  confirmProductionLiveCatalog: boolean;
  confirmStagingTestCatalog: boolean;
  environment: "staging" | "production";
  explicitDryRun: boolean;
  json: boolean;
};
export function readDodoCatalogReferences(environment?: NodeJS.ProcessEnv): DodoCatalogReferences;
export function readDodoCatalogProviderMode(environment?: NodeJS.ProcessEnv): "test_mode" | "live_mode";
export function validateDodoCatalogTarget(input: {
  environment: "staging" | "production";
  providerMode: "test_mode" | "live_mode";
  confirmProduction?: boolean;
  confirmProductionLiveCatalog?: boolean;
  confirmStagingTestCatalog?: boolean;
}): void;
export function dodoCatalogReadSql(): string;
export function dodoCatalogRotationSql(sourceReferences: DodoCatalogReferences, targetReferences: DodoCatalogReferences): string;
export function classifyDodoCatalogRows(rows: readonly Record<string, unknown>[], references: DodoCatalogReferences): DodoCatalogClassification;
export function dodoCatalogUpdateSql(references: DodoCatalogReferences): string;
export function parseDodoCatalogCommandOutput(output: string): { updatedCount: number };
export function parseDodoCatalogRotationCommandOutput(output: string): { mode: "already_rotated" | "rotated"; closedCount: number; insertedCount: number };
export function reconcileDodoCatalog(input: {
  environment: "staging" | "production";
  references: DodoCatalogReferences;
  providerMode: "test_mode" | "live_mode";
  confirmProduction?: boolean;
  confirmProductionLiveCatalog?: boolean;
  confirmStagingTestCatalog?: boolean;
}): Promise<DodoCatalogClassification & { environment: string; updatedCount: number; closedCount: number; insertedCount: number }>;
