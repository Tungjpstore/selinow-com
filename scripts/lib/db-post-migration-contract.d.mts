export const REQUIRED_POST_MIGRATION_OBJECTS: Readonly<{
  table: readonly string[];
  index: readonly string[];
  trigger: readonly string[];
}>;
export const REQUIRED_POST_MIGRATION_COLUMNS: Readonly<Record<string, readonly string[]>>;
export const POST_MIGRATION_FOREIGN_KEY_SQL: string;
export const POST_MIGRATION_OBJECT_SQL: string;
export const POST_MIGRATION_COLUMN_SQL: string;
export const POST_MIGRATION_CROSS_LEDGER_SQL: string;

export function parsePostMigrationForeignKeyOutput(output: string): { violationCount: 0 };
export function parsePostMigrationObjectOutput(output: string): { objectCount: number };
export function parsePostMigrationColumnOutput(output: string): { columnCount: number };
export function parsePostMigrationCrossLedgerOutput(output: string): { mismatchCount: 0 };
export function assertRemotePostMigrationContract(input?: {
  environment?: NodeJS.ProcessEnv;
  environmentName: "staging" | "production";
  repositoryRoot?: string;
  runWranglerImplementation?: (
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
  ) => { stderr: string; stdout: string };
}): {
  columnCount: number;
  mismatchCount: 0;
  objectCount: number;
  ok: true;
  violationCount: 0;
};
