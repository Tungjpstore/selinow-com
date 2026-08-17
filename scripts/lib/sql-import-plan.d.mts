export const DEFERRED_FOREIGN_KEYS_PRAGMA: string;
export const DEFAULT_MAX_STATEMENTS_PER_CHUNK: number;

export interface ImportChunk {
  deferredForeignKeys: boolean;
  statements: string[];
}

export interface ChunkedImportPlanSummary {
  chunkCount: number;
  cycleTables: string[];
  deferredChunkCount: number;
  insertRowCount: number;
  insertTableCount: number;
  maxStatementsPerChunk: number;
  selfReferencingTables: string[];
  statementCount: number;
  strippedDeferPragmaCount: number;
  tableCount: number;
}

export interface ChunkedImportPlan {
  chunks: ImportChunk[];
  summary: ChunkedImportPlanSummary;
}

export function splitSqlStatements(sql: string): string[];

export function buildChunkedImportPlan(
  statements: string[],
  options?: { maxStatementsPerChunk?: number },
): ChunkedImportPlan;

export function renderChunkSql(chunk: ImportChunk): string;
