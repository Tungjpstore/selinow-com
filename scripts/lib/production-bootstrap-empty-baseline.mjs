import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { assertProductionAccountIdentity, assertProductionDatabaseIdentity } from "./db-admission.mjs";
import { assertFreshProductionBootstrapBackupEvidence } from "./backup.mjs";
import { repositoryRoot } from "./platform.mjs";
import { assertProductionBootstrapSpecIdentity } from "./production-bootstrap.mjs";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const D1_DATABASE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const TEMP_NAME_PATTERN = /^selinow-restore-drill-production-empty-[a-f0-9]{12}$/u;
const REPORT_ID_PATTERN = /^rdr_[a-z0-9][a-z0-9._-]{7,72}$/u;
const PLACEHOLDER_PATTERN = /(?:change-me|not-provisioned|placeholder|replace-with|<[^>]+>)/iu;
const CLEANUP_DISCOVERY_ATTEMPTS = 5;
const CLEANUP_DISCOVERY_DELAY_MS = 1_000;
const WRANGLER_ENVIRONMENT_ALLOWLIST = new Set([
  "COREPACK_HOME",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NO_COLOR",
  "NPM_CONFIG_CACHE",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TERM",
  "TEMP",
  "TMP",
  "TMPDIR",
  "npm_config_cache",
]);

const EMPTY_BASELINE_REPORT_ROOT = resolve(repositoryRoot, ".wrangler/restore-drills/production-bootstrap-empty-baseline");

export const PRODUCTION_EMPTY_BASELINE_TOKEN_NAME = "CLOUDFLARE_PRODUCTION_EMPTY_BASELINE_API_TOKEN";

export function requireProductionEmptyBaselineToken(environment = process.env) {
  const value = environment?.[PRODUCTION_EMPTY_BASELINE_TOKEN_NAME];
  const token = typeof value === "string" ? value.trim() : "";
  if (!token) throw new Error("cloudflare_production_empty_baseline_api_token_missing");
  return token;
}

export function buildProductionEmptyBaselineEnvironment(environment, accountId, token) {
  if (!ACCOUNT_ID_PATTERN.test(accountId ?? "")) {
    throw new Error("production_bootstrap_empty_baseline_account_invalid");
  }
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("cloudflare_production_empty_baseline_api_token_invalid");
  }
  const child = Object.fromEntries(Object.entries(environment ?? {}).filter(([name, value]) => (
    WRANGLER_ENVIRONMENT_ALLOWLIST.has(name) && typeof value === "string"
  )));
  return {
    ...child,
    CI: "1",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: token.trim(),
  };
}

export function parseProductionBootstrapEmptyBaselineFlags(argv) {
  let execute = false;
  let dryRunRequested = false;
  const flags = {
    confirmFirstProductionBootstrap: false,
    confirmProduction: false,
    dryRun: true,
    environment: null,
    execute: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-production") flags.confirmProduction = true;
    else if (argument === "--confirm-first-production-bootstrap") flags.confirmFirstProductionBootstrap = true;
    else if (argument === "--dry-run") {
      dryRunRequested = true;
      flags.dryRun = true;
    } else if (argument === "--execute") {
      execute = true;
      flags.execute = true;
      flags.dryRun = false;
    } else if (argument === "--json") flags.json = true;
    else if (argument === "--env") flags.environment = argv[++index] ?? "";
    else if (argument.startsWith("--env=")) flags.environment = argument.slice("--env=".length);
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (flags.environment !== "production") throw new Error("production_bootstrap_empty_baseline_environment_required");
  if (dryRunRequested && execute) throw new Error("production_bootstrap_empty_baseline_mode_conflict");
  if (execute && !flags.confirmProduction) throw new Error("production_confirmation_required");
  if (execute && !flags.confirmFirstProductionBootstrap) throw new Error("production_first_bootstrap_confirmation_required");
  return flags;
}

function safeConfiguredString(value) {
  return typeof value === "string" && value.trim().length >= 1 && value.length <= 240 && !PLACEHOLDER_PATTERN.test(value);
}

function createOperationId(now, randomBytesImplementation = randomBytes) {
  const timestamp = now.toISOString().replaceAll(/[-:.TZ]/gu, "").slice(0, 14);
  return `rdr_${timestamp}_${randomBytesImplementation(6).toString("hex")}`;
}

function parseWranglerRows(output, errorCode) {
  let payload;
  try {
    payload = JSON.parse(String(output ?? ""));
  } catch {
    throw new Error(errorCode);
  }
  const envelopes = Array.isArray(payload) ? payload : [payload];
  const rows = envelopes.flatMap((envelope) => Array.isArray(envelope?.results) ? envelope.results : []);
  if (!Array.isArray(rows)) throw new Error(errorCode);
  return rows;
}

function parseD1List(output, errorCode) {
  let payload;
  try {
    payload = JSON.parse(String(output ?? ""));
  } catch {
    throw new Error(errorCode);
  }
  if (!Array.isArray(payload)) throw new Error(errorCode);
  return payload.map((database) => {
    if (!D1_DATABASE_ID_PATTERN.test(database?.uuid ?? "") || typeof database?.name !== "string") {
      throw new Error(errorCode);
    }
    return { id: database.uuid, name: database.name };
  });
}

function listDatabases(runner, runnerOptions, errorCode) {
  const output = safeRunner(
    runner,
    ["d1", "list", "--env", "production", "--json"],
    errorCode,
    runnerOptions,
  ).stdout;
  return parseD1List(output, errorCode);
}

function exactTemporaryTarget(databases, databaseName, databaseId) {
  const matchingName = databases.filter((database) => database.name === databaseName);
  const matchingId = databaseId === null
    ? []
    : databases.filter((database) => database.id === databaseId);
  if (matchingName.length > 1 || matchingId.length > 1) {
    throw new Error("production_bootstrap_empty_baseline_cleanup_identity_mismatch");
  }
  if (databaseId === null) return matchingName[0] ?? null;
  if (matchingName.length === 0 && matchingId.length === 0) return null;
  if (
    matchingName.length !== 1
    || matchingId.length !== 1
    || matchingName[0].id !== databaseId
    || matchingId[0].name !== databaseName
  ) {
    throw new Error("production_bootstrap_empty_baseline_cleanup_identity_mismatch");
  }
  return matchingName[0];
}

async function discoverTemporaryTarget(input) {
  const attempts = input.attempts ?? CLEANUP_DISCOVERY_ATTEMPTS;
  const delayImplementation = input.delayImplementation ?? delay;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const databases = listDatabases(
      input.runner,
      input.runnerOptions,
      "production_bootstrap_empty_baseline_cleanup_identity_unavailable",
    );
    const match = exactTemporaryTarget(databases, input.databaseName, input.databaseId);
    if (match !== null) return match;
    if (input.databaseId !== null) return null;
    if (attempt + 1 < attempts) await delayImplementation(CLEANUP_DISCOVERY_DELAY_MS);
  }
  return null;
}

async function cleanupTemporaryTarget(input) {
  const target = await discoverTemporaryTarget(input);
  if (target === null) {
    if (input.databaseId === null) {
      throw new Error("production_bootstrap_empty_baseline_cleanup_identity_unknown");
    }
    return;
  }
  if (input.databaseId !== null && target.id !== input.databaseId) {
    throw new Error("production_bootstrap_empty_baseline_cleanup_identity_mismatch");
  }
  safeRunner(
    input.runner,
    ["d1", "delete", target.name, "--env", "production", "--skip-confirmation"],
    "production_bootstrap_empty_baseline_target_delete_failed",
    input.runnerOptions,
  );
  const remaining = listDatabases(
    input.runner,
    input.runnerOptions,
    "production_bootstrap_empty_baseline_cleanup_verification_unavailable",
  );
  if (remaining.some((database) => database.id === target.id || database.name === input.databaseName)) {
    throw new Error("production_bootstrap_empty_baseline_cleanup_verification_failed");
  }
}

function safeRunner(runner, args, errorCode, options) {
  try {
    return runner(args, options);
  } catch (error) {
    throw new Error(errorCode, { cause: error });
  }
}

function reportReference(root, path, customRoot) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) {
    throw new Error("production_bootstrap_empty_baseline_report_path_invalid");
  }
  if (customRoot !== undefined) return normalizedPath;
  const result = relative(repositoryRoot, normalizedPath);
  if (result.startsWith("../") || result === "..") throw new Error("production_bootstrap_empty_baseline_report_path_invalid");
  return result;
}

async function writePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function prepareReportPath(root, drillId) {
  if (!REPORT_ID_PATTERN.test(drillId)) throw new Error("production_bootstrap_empty_baseline_drill_id_invalid");
  const directory = resolve(root, "production-bootstrap-empty-baseline");
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  return resolve(directory, `${drillId}.json`);
}

function assertGeneratedD1Identity(productionSpec, generatedManifest, wranglerConfig) {
  const database = generatedManifest?.resources?.d1;
  if (
    generatedManifest?.environment !== "production"
    || generatedManifest?.accountId !== productionSpec.accountId
    || generatedManifest?.zoneId !== productionSpec.zoneId
    || generatedManifest?.zoneName !== productionSpec.zoneName
    || generatedManifest?.workerName !== productionSpec.workerName
    || database?.name !== productionSpec.resources?.d1
    || !D1_DATABASE_ID_PATTERN.test(database?.id ?? "")
  ) {
    throw new Error("production_bootstrap_empty_baseline_generated_identity_mismatch");
  }
  const configured = Array.isArray(wranglerConfig?.env?.production?.d1_databases)
    ? wranglerConfig.env.production.d1_databases.filter((entry) => entry?.binding === "PLATFORM_DB")
    : [];
  if (
    wranglerConfig?.env?.production?.name !== productionSpec.workerName
    || configured.length !== 1
    || configured[0]?.database_name !== database.name
    || configured[0]?.database_id !== database.id
    || configured[0]?.migrations_dir !== "./migrations"
  ) {
    throw new Error("production_bootstrap_empty_baseline_database_binding_mismatch");
  }
  return { accountId: productionSpec.accountId, databaseId: database.id, databaseName: database.name };
}

export function validateProductionBootstrapEmptyBaselineAdmission(input) {
  if (input?.environment !== "production") throw new Error("production_bootstrap_empty_baseline_environment_required");
  if (!input?.productionSpec || !input?.generatedManifest || !input?.wranglerConfig) {
    throw new Error("production_bootstrap_empty_baseline_static_identity_missing");
  }
  assertProductionBootstrapSpecIdentity(input.productionSpec);
  if (!ACCOUNT_ID_PATTERN.test(input.productionSpec.accountId)) {
    throw new Error("production_bootstrap_empty_baseline_account_invalid");
  }
  return assertGeneratedD1Identity(input.productionSpec, input.generatedManifest, input.wranglerConfig);
}

function remoteExecute(runner, databaseName, sql, errorCode, runnerOptions) {
  return safeRunner(runner, [
    "d1", "execute", databaseName, "--remote", "--env", "production",
    "--command", sql, "--json",
  ], errorCode, runnerOptions).stdout;
}

function readApplicationTables(runner, databaseName, runnerOptions) {
  const rows = parseWranglerRows(remoteExecute(
    runner,
    databaseName,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV', '_cf_METADATA', 'd1_migrations') ORDER BY name;",
    "production_bootstrap_empty_baseline_schema_query_failed",
    runnerOptions,
  ), "production_bootstrap_empty_baseline_schema_invalid");
  return rows.map((row) => {
    if (typeof row?.name !== "string") throw new Error("production_bootstrap_empty_baseline_schema_invalid");
    return row.name;
  });
}

function readMigrationLedgerCount(runner, databaseName, runnerOptions) {
  const tables = parseWranglerRows(remoteExecute(
    runner,
    databaseName,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations';",
    "production_bootstrap_empty_baseline_ledger_query_failed",
    runnerOptions,
  ), "production_bootstrap_empty_baseline_ledger_invalid");
  if (tables.length === 0) return { present: false, count: 0 };
  if (tables.length !== 1 || tables[0]?.name !== "d1_migrations") {
    throw new Error("production_bootstrap_empty_baseline_ledger_invalid");
  }
  const rows = parseWranglerRows(remoteExecute(
    runner,
    databaseName,
    "SELECT COUNT(*) AS count FROM d1_migrations;",
    "production_bootstrap_empty_baseline_ledger_count_failed",
    runnerOptions,
  ), "production_bootstrap_empty_baseline_ledger_invalid");
  const count = Number(rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("production_bootstrap_empty_baseline_ledger_invalid");
  return { present: true, count };
}

function readIntegrity(runner, databaseName, runnerOptions) {
  let integrityStatus = "ok";
  try {
    const integrityRows = parseWranglerRows(remoteExecute(
      runner,
      databaseName,
      "PRAGMA integrity_check;",
      "production_bootstrap_empty_baseline_integrity_query_failed",
      runnerOptions,
    ), "production_bootstrap_empty_baseline_integrity_invalid");
    const integrityOk = integrityRows.length === 1 && String(Object.values(integrityRows[0] ?? {})[0]) === "ok";
    if (!integrityOk) throw new Error("production_bootstrap_empty_baseline_integrity_failed");
  } catch (error) {
    const message = error instanceof Error
      ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`
      : "";
    if (!/SQLITE_AUTH|not authorized/iu.test(message)) throw error;
    // Cloudflare's remote D1 API rejects integrity_check with SQLITE_AUTH.
    integrityStatus = "remote_pragma_unavailable";
  }
  const foreignKeyRows = parseWranglerRows(remoteExecute(
    runner,
    databaseName,
    "PRAGMA foreign_key_check;",
    "production_bootstrap_empty_baseline_foreign_key_query_failed",
    runnerOptions,
  ), "production_bootstrap_empty_baseline_foreign_key_invalid");
  if (foreignKeyRows.length !== 0) throw new Error("production_bootstrap_empty_baseline_foreign_keys_failed");
  return { foreignKeyViolationCount: foreignKeyRows.length, integrityStatus };
}

function assertEmptyBaseline(runner, databaseName, runnerOptions) {
  const applicationTables = readApplicationTables(runner, databaseName, runnerOptions);
  if (applicationTables.length !== 0) throw new Error("production_bootstrap_empty_baseline_application_tables_present");
  const migrationLedger = readMigrationLedgerCount(runner, databaseName, runnerOptions);
  if (migrationLedger.count !== 0) throw new Error("production_bootstrap_empty_baseline_migrations_present");
  return { applicationTableCount: 0, migrationLedgerCount: 0, migrationLedgerPresent: migrationLedger.present };
}

function emptyBaselineDryRun(target) {
  const targetRef = "d1:selinow-restore-drill-production-empty-<generated>";
  return {
    actions: [
      { code: "validate_exact_production_identity", detail: `${target.databaseName}:${target.databaseId}`, ok: true },
      { code: "verify_fresh_report_v2_backup", detail: "private_artifact_checksum_and_target", ok: true },
      { code: "verify_empty_baseline", detail: "no_application_tables_and_empty_migration_ledger", ok: true },
      { code: "create_isolated_target", detail: targetRef, ok: true },
      { code: "import_protected_empty_export", detail: "report_v2_database.sql", ok: true },
      { code: "verify_integrity_and_foreign_keys", detail: "integrity_ok_and_zero_violations", ok: true },
      { code: "delete_isolated_target", detail: "exact_tool_created_target_only", ok: true },
    ],
    environment: "production",
    executed: false,
    ok: true,
  };
}

export async function runProductionBootstrapEmptyBaselineDrill(input) {
  const now = input.now ?? new Date();
  const target = validateProductionBootstrapEmptyBaselineAdmission(input);
  if (input.dryRun) return emptyBaselineDryRun(target);
  if (input.confirmProduction !== true) throw new Error("production_confirmation_required");
  if (input.confirmFirstProductionBootstrap !== true) throw new Error("production_first_bootstrap_confirmation_required");
  const runner = input.runWranglerImplementation;
  if (typeof runner !== "function") throw new Error("production_bootstrap_empty_baseline_runner_unavailable");
  const operatorEnvironment = input.operatorEnvironment ?? process.env;
  const operatorToken = requireProductionEmptyBaselineToken(operatorEnvironment);
  const runnerOptions = {
    cwd: input.repositoryRoot ?? repositoryRoot,
    env: buildProductionEmptyBaselineEnvironment(operatorEnvironment, target.accountId, operatorToken),
  };
  const drillId = createOperationId(now, input.randomBytesImplementation);
  const requestId = randomUUID();
  const reportRoot = input.reportRoot ?? resolve(repositoryRoot, ".wrangler/restore-drills");
  const reportPath = await prepareReportPath(reportRoot, drillId);
  let tempTargetName = null;
  let tempTargetId = null;
  let createAttempted = false;
  let operationError = null;
  let cleanupError = null;
  let verification = null;
  let backupEvidence = null;
  let artifactSizeBytes = null;
  try {
    backupEvidence = await (input.backupEvidenceImplementation ?? assertFreshProductionBootstrapBackupEvidence)({
      accountId: target.accountId,
      backupRoot: input.backupRoot,
      databaseId: target.databaseId,
      databaseName: target.databaseName,
      now,
    });
    const whoami = safeRunner(runner, ["whoami", "--json"], "production_bootstrap_empty_baseline_account_identity_unavailable", runnerOptions).stdout;
    try {
      assertProductionAccountIdentity(whoami, target.accountId);
    } catch {
      throw new Error("production_bootstrap_empty_baseline_account_identity_mismatch");
    }
    const d1ListOutput = safeRunner(runner, ["d1", "list", "--env", "production", "--json"], "production_bootstrap_empty_baseline_database_identity_unavailable", runnerOptions).stdout;
    try {
      assertProductionDatabaseIdentity(d1ListOutput, target.databaseId, target.databaseName);
    } catch {
      throw new Error("production_bootstrap_empty_baseline_database_identity_mismatch");
    }
    const sourceDatabases = parseD1List(d1ListOutput, "production_bootstrap_empty_baseline_database_list_invalid");
    const sourceEmpty = assertEmptyBaseline(runner, target.databaseName, runnerOptions);
    const suffix = (input.randomBytesImplementation ?? randomBytes)(6).toString("hex");
    tempTargetName = `selinow-restore-drill-production-empty-${suffix}`;
    if (!TEMP_NAME_PATTERN.test(tempTargetName) || sourceDatabases.some((database) => database.name === tempTargetName)) {
      throw new Error("production_bootstrap_empty_baseline_target_invalid");
    }
    createAttempted = true;
    safeRunner(runner, ["d1", "create", tempTargetName, "--env", "production", "--location", "apac"], "production_bootstrap_empty_baseline_target_create_failed", runnerOptions);
    const targetListOutput = safeRunner(runner, ["d1", "list", "--env", "production", "--json"], "production_bootstrap_empty_baseline_target_identity_unavailable", runnerOptions).stdout;
    const targetDatabases = parseD1List(targetListOutput, "production_bootstrap_empty_baseline_target_list_invalid");
    const targetMatches = targetDatabases.filter((database) => database.name === tempTargetName);
    if (targetMatches.length !== 1) throw new Error("production_bootstrap_empty_baseline_target_identity_mismatch");
    tempTargetId = targetMatches[0].id;
    const artifactPath = backupEvidence?.artifactPath;
    if (!safeConfiguredString(artifactPath)) throw new Error("production_bootstrap_empty_baseline_backup_artifact_path_missing");
    await chmod(artifactPath, 0o600);
    const artifactStat = await stat(artifactPath);
    if (
      !artifactStat.isFile()
      || artifactStat.size <= 0
      || artifactStat.size !== backupEvidence.sizeBytes
      || await sha256File(artifactPath) !== backupEvidence.checksumSha256
    ) {
      throw new Error("production_bootstrap_empty_baseline_backup_artifact_invalid");
    }
    artifactSizeBytes = artifactStat.size;
    safeRunner(runner, [
      "d1", "execute", tempTargetName, "--remote", "--env", "production",
      "--file", artifactPath, "--yes",
    ], "production_bootstrap_empty_baseline_import_failed", runnerOptions);
    const targetEmpty = assertEmptyBaseline(runner, tempTargetName, runnerOptions);
    const targetHealth = readIntegrity(runner, tempTargetName, runnerOptions);
    verification = { ...sourceEmpty, ...targetEmpty, ...targetHealth };
  } catch (error) {
    operationError = error;
  } finally {
    if (createAttempted && tempTargetName !== null) {
      if (!TEMP_NAME_PATTERN.test(tempTargetName)) {
        cleanupError = new Error("production_bootstrap_empty_baseline_target_invalid");
      } else {
        try {
          await cleanupTemporaryTarget({
            attempts: input.cleanupDiscoveryAttempts,
            databaseId: tempTargetId,
            databaseName: tempTargetName,
            delayImplementation: input.cleanupDelayImplementation,
            runner,
            runnerOptions,
          });
        } catch (error) {
          cleanupError = error;
        }
      }
    }
  }
  if (cleanupError !== null || operationError !== null) {
    const errorCode = cleanupError !== null
      ? "production_bootstrap_empty_baseline_cleanup_failed"
      : operationError instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(operationError.message)
        ? operationError.message
        : "production_bootstrap_empty_baseline_failed";
    await writePrivateJson(reportPath, {
      created_at: now.toISOString(),
      drill_id: drillId,
      environment: "production",
      mode: "empty_baseline",
      report_version: 2,
      status: "failed",
      updated_at: new Date().toISOString(),
      verification: verification ?? null,
      error_code: errorCode,
    });
    throw new Error(errorCode, { cause: operationError ?? cleanupError });
  }
  const completedAt = new Date().toISOString();
  await writePrivateJson(reportPath, {
    backup: {
      completed_at: backupEvidence.completedAt,
      report_ref: backupEvidence.reportRef,
      size_bytes: artifactSizeBytes,
      snapshot_id: backupEvidence.snapshotId,
    },
    created_at: now.toISOString(),
    drill_id: drillId,
    environment: "production",
    mode: "empty_baseline",
    request_id: requestId,
    report_version: 2,
    source: {
      account_id: target.accountId,
      database_id: target.databaseId,
      database_name: target.databaseName,
      resource_ref: `d1:${target.databaseName}`,
    },
    status: "passed",
    target: {
      database_id: tempTargetId,
      database_name: tempTargetName,
      deleted: true,
      resource_ref: `d1:${tempTargetName}`,
    },
    updated_at: completedAt,
    verification,
  });
  const reportRef = reportReference(reportRoot, reportPath, input.reportRoot);
  return {
    actions: [
      { code: "backup_evidence_verified", detail: backupEvidence.reportRef, ok: true },
      { code: "empty_baseline_verified", detail: "no_application_tables_and_empty_migration_ledger", ok: true },
      { code: "isolated_target_imported", detail: `d1:${tempTargetName}`, ok: true },
      { code: "integrity_check", detail: verification.integrityStatus, ok: true },
      { code: "foreign_key_violations", detail: String(verification.foreignKeyViolationCount), ok: true },
      { code: "temporary_target_removed", detail: "exact_tool_created_target", ok: true },
      { code: "private_evidence_written", detail: reportRef, ok: true },
    ],
    drillId,
    environment: "production",
    executed: true,
    ok: true,
    reportRef,
  };
}

export const emptyBaselinePaths = Object.freeze({ reportRoot: EMPTY_BASELINE_REPORT_ROOT });
