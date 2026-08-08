export type DodoCatalogReferences = Readonly<Record<string, string>>;
export type DodoCatalogClassification = {
  mode: "already_configured" | "pending";
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
  environment: "staging" | "production";
  explicitDryRun: boolean;
  json: boolean;
};
export function readDodoCatalogReferences(environment?: NodeJS.ProcessEnv): DodoCatalogReferences;
export function dodoCatalogReadSql(): string;
export function classifyDodoCatalogRows(rows: readonly Record<string, unknown>[], references: DodoCatalogReferences): DodoCatalogClassification;
export function dodoCatalogUpdateSql(references: DodoCatalogReferences): string;
export function parseDodoCatalogCommandOutput(output: string): { updatedCount: number };
export function reconcileDodoCatalog(input: { environment: "staging" | "production"; references: DodoCatalogReferences }): Promise<DodoCatalogClassification & { environment: string; updatedCount: number }>;
