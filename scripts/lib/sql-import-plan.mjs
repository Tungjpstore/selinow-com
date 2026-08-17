// Chunked import planning for D1 remote restore drills.
//
// D1 executes an uploaded SQL file as a sequence of batched transactions
// (~100 statements per batch). Consequences that shape this plan:
//   * `PRAGMA defer_foreign_keys` does NOT survive batch boundaries, so any
//     statement set that relies on deferred foreign keys must fit in ONE chunk
//     and re-assert the pragma inside that chunk.
//   * `CREATE TABLE ... REFERENCES parent` resolves the parent at creation time
//     unless deferral is active within the same batch, so parents must be
//     created before children — except FK cycles, whose members are isolated
//     into a single deferred chunk (verified to work on D1 remote).
//   * Explicit `BEGIN`/`COMMIT` are rejected by D1 remote, so chunks never
//     carry transaction control; each chunk is applied with `--yes`, and D1
//     wraps every batch in its own transaction.
//
// The planner is pure (no fs, no network) so it is fully unit-testable.
export const DEFERRED_FOREIGN_KEYS_PRAGMA = "PRAGMA defer_foreign_keys=TRUE";
export const DEFAULT_MAX_STATEMENTS_PER_CHUNK = 99;

// Quote-aware split on statement-terminating semicolons, then reassembly of
// `CREATE TRIGGER ... BEGIN ... END;` bodies whose inner semicolons are part
// of the trigger program rather than statement boundaries.
export function splitSqlStatements(sql) {
  if (typeof sql !== "string") throw new Error("sql_import_plan_input_invalid");
  const fragments = [];
  let current = "";
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (inString) {
      current += character;
      if (character === "'") {
        if (sql[index + 1] === "'") {
          current += "'";
          index += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (character === "'") {
      inString = true;
      current += character;
      continue;
    }
    if (character === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0) fragments.push(trimmed);
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0 || inString) {
    throw new Error("sql_import_plan_unparsed_trailing_content");
  }
  const statements = [];
  let position = 0;
  while (position < fragments.length) {
    const fragment = fragments[position];
    if (/^CREATE TRIGGER/iu.test(fragment) && !/\bEND$/iu.test(fragment)) {
      const parts = [fragment];
      position += 1;
      while (position < fragments.length) {
        parts.push(fragments[position]);
        const ended = /^\s*END$/iu.test(fragments[position]);
        position += 1;
        if (ended) break;
      }
      statements.push(parts.join("; "));
      continue;
    }
    statements.push(fragment);
    position += 1;
  }
  return statements;
}

const CREATE_TABLE_PATTERN = /^CREATE TABLE (?:IF NOT EXISTS )?"?([A-Za-z0-9_]+)"?[\s(]/iu;
const INSERT_PATTERN = /^INSERT (?:OR IGNORE )?INTO "?([A-Za-z0-9_]+)"?/iu;
const REFERENCE_PATTERN = /REFERENCES\s+"?([A-Za-z0-9_]+)"?/giu;
const STATEMENT_TABLE_PATTERN = /^(?:CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? [^\s]+ ON|CREATE (?:TEMP )?(?:VIEW|TRIGGER)(?: IF NOT EXISTS)? [^\s]+ (?:INSTEAD OF )?(?:FOR EACH ROW )?(?:WHEN [\s\S]*? )?(?:INSERT|UPDATE|DELETE)(?: \w+)* ON) "?([A-Za-z0-9_]+)"?/iu;
const TRANSACTION_CONTROL_PATTERN = /^(?:BEGIN|COMMIT|END TRANSACTION|ROLLBACK)\b/iu;
const DEFER_PRAGMA_PATTERN = /^PRAGMA defer_foreign_keys/iu;

// Builds an ordered, chunked execution plan from parsed dump statements.
// Returns `{ chunks, summary }` where each chunk is
// `{ statements: string[], deferredForeignKeys: boolean }`; statements are
// emitted WITHOUT trailing semicolons (the renderer adds them).
export function buildChunkedImportPlan(statements, options = {}) {
  const maxStatementsPerChunk = options.maxStatementsPerChunk ?? DEFAULT_MAX_STATEMENTS_PER_CHUNK;
  if (!Number.isSafeInteger(maxStatementsPerChunk) || maxStatementsPerChunk < 2) {
    throw new Error("sql_import_plan_chunk_size_invalid");
  }
  const sequence = []; // {kind:"stmt"|"inserts", statement?, tableName?, table?}
  const insertsByTable = new Map();
  const tableParents = new Map();
  const selfReferencingTables = new Set();
  let strippedDeferPragmaCount = 0;
  for (const statement of statements) {
    if (TRANSACTION_CONTROL_PATTERN.test(statement)) {
      throw new Error("sql_import_plan_transaction_control_unsupported");
    }
    if (DEFER_PRAGMA_PATTERN.test(statement)) {
      strippedDeferPragmaCount += 1;
      continue; // re-asserted per chunk that needs it
    }
    const insertMatch = statement.match(INSERT_PATTERN);
    if (insertMatch) {
      const table = insertMatch[1];
      if (!insertsByTable.has(table)) {
        insertsByTable.set(table, []);
        sequence.push({ kind: "inserts", table });
      }
      insertsByTable.get(table).push(statement);
      continue;
    }
    const createMatch = statement.match(CREATE_TABLE_PATTERN);
    if (createMatch) {
      const name = createMatch[1];
      // A dump defining the same table twice has no unambiguous topological
      // order; fail closed instead of letting D1 reject it mid-import.
      if (tableParents.has(name)) throw new Error("sql_import_plan_unresolvable_order");
      const references = [...statement.matchAll(REFERENCE_PATTERN)].map((match) => match[1]);
      if (references.includes(name)) selfReferencingTables.add(name);
      tableParents.set(name, new Set(references.filter((parent) => parent !== name)));
      sequence.push({ kind: "stmt", statement, tableName: name });
      continue;
    }
    sequence.push({ kind: "stmt", statement });
  }

  // Non-CREATE-TABLE DDL (indexes, triggers, views) names the table it binds
  // to, so it can be deferred until that table exists.
  const referencedTableOf = (statement) => statement.match(STATEMENT_TABLE_PATTERN)?.[1] ?? null;

  // Phase 1: CREATE TABLE order. Parents precede children, dump order kept
  // among ready tables; FK-cycle members (and tables blocked only by cycles)
  // form one atomic unit spliced at the earliest dump position of any member.
  const tableEntries = new Map();
  for (const entry of sequence) {
    if (entry.kind === "stmt" && entry.tableName) tableEntries.set(entry.tableName, entry);
  }
  const tableOrder = [];
  const tablePlaced = new Set();
  const pendingTables = new Set(tableEntries.keys());
  let tableProgress = true;
  while (pendingTables.size > 0 && tableProgress) {
    tableProgress = false;
    for (const entry of sequence) {
      if (entry.kind !== "stmt" || !entry.tableName || !pendingTables.has(entry.tableName)) continue;
      const parents = tableParents.get(entry.tableName) ?? new Set();
      if ([...parents].every((parent) => !tableEntries.has(parent) || tablePlaced.has(parent))) {
        tableOrder.push(entry.tableName);
        tablePlaced.add(entry.tableName);
        pendingTables.delete(entry.tableName);
        tableProgress = true;
      }
    }
  }
  const cycleTables = [...pendingTables];
  if (cycleTables.length > maxStatementsPerChunk - 1) {
    throw new Error("sql_import_plan_cycle_unit_too_large");
  }
  if (cycleTables.length > 0) {
    const earliestCycleIndex = Math.min(
      ...cycleTables.map((name) => sequence.indexOf(tableEntries.get(name))),
    );
    let spliceAt = tableOrder.length;
    for (let position = 0; position < tableOrder.length; position += 1) {
      const dumpIndex = sequence.indexOf(tableEntries.get(tableOrder[position]));
      if (dumpIndex > earliestCycleIndex) {
        spliceAt = position;
        break;
      }
    }
    tableOrder.splice(spliceAt, 0, ...cycleTables);
  }
  const cycleUnitSet = new Set(cycleTables);
  const firstCycleTable = cycleTables[0] ?? null;
  const lastCycleTable = cycleTables[cycleTables.length - 1] ?? null;
  const cycleInsertRowCount = cycleTables.reduce(
    (total, table) => total + (insertsByTable.get(table)?.length ?? 0),
    0,
  );

  // Phase 2: remaining statements keep dump order, gated on dependencies:
  // INSERT blocks wait for every FK parent's INSERT block; other DDL waits
  // for its target table's CREATE.
  const placedInserts = new Set();
  const insertReady = (table) => {
    const parents = tableParents.get(table) ?? new Set();
    return [...parents].every((parent) => !insertsByTable.has(parent) || placedInserts.has(parent));
  };
  const emitted = new Set();
  const orderEntries = [];
  for (const name of tableOrder) {
    const entry = tableEntries.get(name);
    emitted.add(entry);
    orderEntries.push(entry);
  }
  const insertOrder = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const entry of sequence) {
      if (emitted.has(entry)) continue;
      if (entry.kind === "inserts") {
        if (!insertReady(entry.table)) continue;
        insertOrder.push(entry.table);
        placedInserts.add(entry.table);
      } else {
        const referenced = referencedTableOf(entry.statement);
        const referencedEntry = referenced ? tableEntries.get(referenced) : undefined;
        if (referencedEntry && !emitted.has(referencedEntry)) continue;
      }
      emitted.add(entry);
      orderEntries.push(entry);
      progressed = true;
    }
  }
  // INSERT blocks of FK-cycle tables can never become "ready" (their parents
  // are never placed); append them last — emission isolates them in one
  // deferred chunk so the whole mutual-reference group commits atomically.
  for (const entry of sequence) {
    if (entry.kind !== "inserts" || placedInserts.has(entry.table)) continue;
    emitted.add(entry);
    orderEntries.push(entry);
    insertOrder.push(entry.table);
  }
  if (emitted.size !== sequence.length) {
    throw new Error("sql_import_plan_unresolvable_order");
  }

  // Chunk emission. The FK-cycle CREATE TABLE unit is flushed into its own
  // chunk so one deferred-FK batch covers every mutual reference.
  const chunks = [];
  let buffer = [];
  let bufferDeferred = false;
  const flush = () => {
    if (buffer.length === 0) return;
    chunks.push({ statements: buffer, deferredForeignKeys: bufferDeferred });
    buffer = [];
    bufferDeferred = false;
  };
  const push = (statement, deferred = false) => {
    const capacity = maxStatementsPerChunk - (bufferDeferred || deferred ? 1 : 0);
    if (buffer.length >= capacity) flush();
    if (deferred) bufferDeferred = true;
    buffer.push(statement);
  };
  const markDeferred = () => {
    bufferDeferred = true;
  };
  let cycleDataGroupStarted = false;
  if (cycleInsertRowCount > maxStatementsPerChunk - 1) {
    throw new Error("sql_import_plan_deferred_insert_group_too_large");
  }
  for (const entry of orderEntries) {
    if (entry.kind === "stmt") {
      const isCycleMember = entry.tableName !== undefined && cycleUnitSet.has(entry.tableName);
      if (entry.tableName === firstCycleTable) flush();
      if (isCycleMember) {
        push(entry.statement, true);
        if (entry.tableName === lastCycleTable) flush();
      } else {
        push(entry.statement);
      }
      continue;
    }
    const rows = insertsByTable.get(entry.table);
    const isCycleData = cycleUnitSet.has(entry.table);
    const deferred = isCycleData || selfReferencingTables.has(entry.table);
    if (deferred) {
      if (isCycleData) {
        // All FK-cycle table data shares ONE deferred chunk (see header).
        if (!cycleDataGroupStarted) {
          flush();
          markDeferred();
          cycleDataGroupStarted = true;
        }
        for (const row of rows) push(row, true);
        continue;
      }
      // Self-referencing data stays inside one chunk (see header).
      flush();
      if (rows.length > maxStatementsPerChunk - 1) {
        throw new Error("sql_import_plan_deferred_insert_group_too_large");
      }
      markDeferred();
      for (const row of rows) push(row, true);
      flush();
      continue;
    }
    for (const row of rows) push(row);
  }
  flush();

  return {
    chunks,
    summary: Object.freeze({
      chunkCount: chunks.length,
      cycleTables: [...cycleTables],
      deferredChunkCount: chunks.filter((chunk) => chunk.deferredForeignKeys).length,
      insertRowCount: [...insertsByTable.values()].reduce((total, rows) => total + rows.length, 0),
      insertTableCount: insertsByTable.size,
      maxStatementsPerChunk,
      selfReferencingTables: [...selfReferencingTables],
      statementCount: statements.length,
      strippedDeferPragmaCount,
      tableCount: tableEntries.size,
    }),
  };
}

// Renders one chunk as executable SQL: optional deferred-FK pragma first,
// then every statement terminated by a semicolon. No explicit transactions.
export function renderChunkSql(chunk) {
  const lines = [
    ...(chunk.deferredForeignKeys ? [`${DEFERRED_FOREIGN_KEYS_PRAGMA};`] : []),
    ...chunk.statements.map((statement) => `${statement};`),
  ];
  return `${lines.join("\n")}\n`;
}
