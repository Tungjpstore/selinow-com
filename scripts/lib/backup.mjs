import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { runWrangler } from "./cli.mjs";
import {
  assertStagingMutationAdmission,
  buildPinnedCloudflareEnvironment,
  repositoryRoot,
} from "./platform.mjs";

const BACKUP_ROOT = resolve(repositoryRoot, ".wrangler/backups");
const DRILL_REPORT_ROOT = resolve(repositoryRoot, ".wrangler/restore-drills");
const RESTORE_TEMP_PREFIX = "selinow-restore-drill-";
const RESTORE_MARKER = ".selinow-restore-drill";
const LOCAL_D1_STATE_ROOT = resolve(
  repositoryRoot,
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
);
const EXPECTED_DATABASE_NAMES = {
  local: "selinow-local",
  production: "selinow-production",
  staging: "selinow-staging",
};
const STAGING_BACKUP_FRESHNESS_MS = 60 * 60_000;
const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const D1_DATABASE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const BILLING_ACTIVATION_TABLES = [
  "plans",
  "plan_prices",
  "shop_subscriptions",
  "subscription_change_requests",
  "billing_accounts",
  "billing_checkout_sessions",
  "billing_invoices",
  "billing_provider_events",
  "subscription_events",
  "usage_counters",
  "usage_events",
  "activation_milestones",
];
const CORE_COUNT_TABLES = [
  "api_credentials",
  "plans",
  "plan_prices",
  "shop_subscriptions",
  "billing_accounts",
  "billing_checkout_sessions",
  "billing_invoices",
  "billing_provider_events",
  "subscription_events",
  "usage_counters",
  "usage_events",
  "activation_milestones",
  "catalog_channel_visibility",
  "channel_customer_identities",
  "channel_connector_requests",
  "channel_oauth_states",
  "channel_provider_verification_evidence",
  "channel_provider_event_receipts",
  "customer_notes",
  "delivery_grant_claims",
  "delivery_grant_consumptions",
  "delivery_grants",
  "data_export_jobs",
  "digital_asset_versions",
  "digital_assets",
  "digital_entitlements",
  "entitlement_grants",
  "entitlement_resources",
  "entitlement_transitions",
  "entitlements",
  "encryption_rotation_items",
  "encryption_rotation_runs",
  "fulfillment_items",
  "fulfillments",
  "generated_license_provider_connections",
  "generated_license_provider_credentials",
  "generated_license_resource_bindings",
  "generated_license_requirement_snapshots",
  "generated_license_requests",
  "generated_license_attempts",
  "generated_license_artifacts",
  "generated_license_dead_letters",
  "manual_fulfillment_executions",
  "external_fulfillment_references",
  "iso_4217_currency_codes",
  "inventory_keys",
  "order_item_fulfillment_requirements",
  "order_item_entitlement_requirements",
  "order_items",
  "orders",
  "payment_attempts",
  "payment_credentials",
  "payment_events",
  "payment_exceptions",
  "payment_reversal_events",
  "payment_remediation_requests",
  "payment_integrations",
  "payment_method_codes",
  "payment_provider_connection_capabilities",
  "payment_provider_connection_currencies",
  "payment_provider_connection_methods",
  "payment_provider_connections",
  "product_fulfillment_policies",
  "product_entitlement_policies",
  "products",
  "shop_domains",
  "shop_deletion_requests",
  "shop_deletion_steps",
  "shop_member_invitations",
  "shops",
  "subscription_change_requests",
  "order_messages",
  "order_notes",
  "telegram_mini_app_sessions",
  "telegram_integrations",
];
const REQUIRED_TABLES = [
  ...CORE_COUNT_TABLES,
  "backup_snapshots",
  "channel_connection_grants",
  "channel_connections",
  "channel_credentials",
  "delivery_jobs",
  "domain_events",
  "restore_drills",
  "shop_channels",
];

// A migration file was briefly renamed after it had already been applied to
// the default Wrangler database. Restore drills may normalize that historical
// ledger row only inside their disposable target; the authoritative database
// is always opened read-only by the source-copy step.
const HISTORICAL_MIGRATION_ALIASES = Object.freeze([
  Object.freeze({
    canonical: "0062_zalo_oa_oauth_state_retry.sql",
    historical: "0062_zalo_oa_oauth_state_reissue.sql",
  }),
]);

export const restoreCountValidationTables = Object.freeze([...CORE_COUNT_TABLES]);
export const restoreValidationTables = Object.freeze([...REQUIRED_TABLES]);

export function assertRequiredRestoreTables(tableNames) {
  const names = new Set(tableNames);
  if (REQUIRED_TABLES.some((table) => !names.has(table))) {
    throw new Error("restore_schema_incomplete");
  }
}

function compactTimestamp(now) {
  return now.toISOString().replaceAll(/[-:.TZ]/gu, "").slice(0, 14);
}

function createOperationId(prefix, now, randomBytesImplementation = randomBytes) {
  return `${prefix}_${compactTimestamp(now)}_${randomBytesImplementation(6).toString("hex")}`;
}

async function loadWranglerConfig() {
  try {
    return JSON.parse(await readFile(resolve(repositoryRoot, "wrangler.jsonc"), "utf8"));
  } catch {
    throw new Error("wrangler_config_invalid");
  }
}

export function resolveDatabaseTarget(config, environment) {
  const databases = environment === "local"
    ? config?.d1_databases
    : config?.env?.[environment]?.d1_databases;
  const matches = Array.isArray(databases)
    ? databases.filter((database) => database?.binding === "PLATFORM_DB")
    : [];
  if (matches.length !== 1) throw new Error(`database_binding_missing:${environment}`);
  const database = matches[0];
  const expectedName = EXPECTED_DATABASE_NAMES[environment];
  if (database.database_name !== expectedName) {
    throw new Error(`database_target_mismatch:${environment}`);
  }
  if (environment === "local") {
    if (database.database_id !== "00000000-0000-0000-0000-000000000000") {
      throw new Error("local_database_id_invalid");
    }
  } else if (!/^[a-f0-9-]{32,36}$/u.test(database.database_id ?? "")) {
    throw new Error(`database_id_invalid:${environment}`);
  }
  return {
    binding: "PLATFORM_DB",
    databaseId: database.database_id,
    databaseName: database.database_name,
    environment,
    resourceRef: `d1:${database.database_name}`,
  };
}

export function assertDistinctRestoreTarget(sourceName, targetName, environment) {
  const expectedPrefix = `selinow-restore-drill-${environment}-`;
  if (sourceName === targetName) throw new Error("restore_target_matches_source");
  if (!targetName.startsWith(expectedPrefix) || !/^selinow-[a-z0-9-]+$/u.test(targetName)) {
    throw new Error("restore_target_invalid");
  }
}

function relativeReportPath(path) {
  const result = relative(repositoryRoot, path);
  if (result.startsWith(`..${sep}`) || result === "..") throw new Error("report_path_invalid");
  return result;
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  await chmod(path, 0o700);
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

async function resolveLocalDatabaseFile() {
  let entries;
  try {
    entries = await readdir(LOCAL_D1_STATE_ROOT, { withFileTypes: true });
  } catch {
    throw new Error("local_database_missing");
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sqlite") || entry.name === "metadata.sqlite") continue;
    const path = resolve(LOCAL_D1_STATE_ROOT, entry.name);
    assertPathInside(LOCAL_D1_STATE_ROOT, path);
    let database;
    try {
      database = new DatabaseSync(path, { readOnly: true });
      const rows = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('_cf_METADATA', 'd1_migrations', 'platform_settings')
      `).all();
      if (rows.length === 3) candidates.push(path);
    } catch {
      // Ignore unrelated SQLite state files.
    } finally {
      database?.close();
    }
  }
  if (candidates.length === 0) throw new Error("local_database_missing");
  if (candidates.length !== 1) throw new Error("local_database_ambiguous");
  return candidates[0];
}

async function copyLocalDatabase(destinationPath) {
  const sourcePath = await resolveLocalDatabaseFile();
  if (resolve(sourcePath) === resolve(destinationPath)) throw new Error("restore_target_matches_source");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.prepare("VACUUM INTO ?").run(destinationPath);
  } catch {
    throw new Error("local_database_copy_failed");
  } finally {
    source.close();
  }
}

export function normalizeHistoricalMigrationAliases(databasePath, repositoryMigrationNames) {
  const parentDirectory = basename(dirname(databasePath));
  if (
    basename(databasePath) !== "restored.sqlite"
    || !parentDirectory.startsWith(RESTORE_TEMP_PREFIX)
  ) {
    throw new Error("restore_target_invalid");
  }
  const repositoryNames = new Set(repositoryMigrationNames);
  const database = new DatabaseSync(databasePath);
  const normalized = [];
  try {
    const migrationTable = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
    ).get();
    if (migrationTable === undefined) throw new Error("restore_migration_ledger_missing");
    database.exec("PRAGMA foreign_keys = ON");
    const names = database.prepare("SELECT name FROM d1_migrations ORDER BY name").all()
      .map((row) => String(row.name));
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const alias of HISTORICAL_MIGRATION_ALIASES) {
        if (repositoryNames.has(alias.historical)) {
          throw new Error("restore_migration_alias_is_current");
        }
        if (!repositoryNames.has(alias.canonical)) {
          throw new Error("restore_migration_alias_canonical_missing");
        }
        const historicalCount = names.filter((name) => name === alias.historical).length;
        if (historicalCount === 0) continue;
        const canonicalCount = names.filter((name) => name === alias.canonical).length;
        if (historicalCount !== 1 || canonicalCount !== 1) {
          throw new Error("restore_migration_alias_unresolved");
        }
        database.prepare("DELETE FROM d1_migrations WHERE name = ?").run(alias.historical);
        normalized.push({ ...alias });
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return normalized;
  } finally {
    database.close();
  }
}

export function buildBackupSnapshotRecord(input) {
  return {
    checksum_sha256: input.checksumSha256 ?? null,
    completed_at: input.completedAt ?? null,
    created_at: input.createdAt,
    environment: input.environment,
    expires_at: input.expiresAt ?? null,
    id: input.id,
    item_count: input.itemCount ?? null,
    last_safe_error_code: input.lastSafeErrorCode ?? null,
    provider_reference: input.providerReference ?? null,
    request_id: input.requestId,
    requested_by_user_id: null,
    resource_kind: "d1",
    resource_ref: input.resourceRef,
    scope_key: `platform:${input.environment}`,
    shop_id: null,
    size_bytes: input.sizeBytes ?? null,
    snapshot_kind: input.snapshotKind,
    status: input.status,
    updated_at: input.updatedAt,
    version: 1,
  };
}

export function buildRestoreDrillRecord(input) {
  return {
    backup_snapshot_id: input.backupSnapshotId,
    completed_at: input.completedAt ?? null,
    created_at: input.createdAt,
    environment: input.environment,
    foreign_key_violation_count: input.foreignKeyViolationCount ?? 0,
    id: input.id,
    integrity_status: input.integrityStatus,
    last_safe_error_code: input.lastSafeErrorCode ?? null,
    request_id: input.requestId,
    requested_by_user_id: null,
    restored_item_count: input.restoredItemCount ?? null,
    shop_id: null,
    started_at: input.startedAt ?? null,
    status: input.status,
    target_resource_ref: input.targetResourceRef,
    updated_at: input.updatedAt,
    version: 1,
  };
}

function backupDryRun(environment, target) {
  const remote = environment !== "local";
  return {
    actions: [
      { code: "validate_source", detail: target.resourceRef, ok: true },
      ...(remote ? [{ code: "capture_time_travel_bookmark", detail: "provider_reference_redacted", ok: true }] : []),
      { code: "export_snapshot", detail: "protected_sql_artifact", ok: true },
      { code: "write_snapshot_report", detail: "private_metadata_only", ok: true },
    ],
    environment,
    ok: true,
  };
}

function safeRunner(runner, args, errorCode, options = {}) {
  try {
    return runner(args, { cwd: repositoryRoot, ...options });
  } catch {
    throw new Error(errorCode);
  }
}

function parseTimeTravelBookmark(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("time_travel_info_invalid");
  }
  const candidates = [payload, payload?.result, Array.isArray(payload) ? payload[0] : null];
  const bookmark = candidates.map((candidate) => candidate?.bookmark).find((value) => typeof value === "string");
  if (bookmark === undefined || bookmark.length < 8 || bookmark.length > 512) {
    throw new Error("time_travel_bookmark_missing");
  }
  return bookmark;
}

function exportArgs(target, environment, outputPath) {
  return [
    "d1",
    "export",
    target.databaseName,
    environment === "local" ? "--local" : "--remote",
    ...(environment === "local" ? [] : ["--env", environment]),
    "--output",
    outputPath,
    "--skip-confirmation",
  ];
}

export async function createBackup(options) {
  const environment = options.environment;
  const now = options.now ?? new Date();
  const config = options.config ?? await loadWranglerConfig();
  const target = resolveDatabaseTarget(config, environment);
  if (options.dryRun) return backupDryRun(environment, target);

  const runner = options.runner ?? runWrangler;
  const operatorEnvironment = options.operatorEnvironment ?? process.env;
  let stagingAdmission = null;
  let productionAdmission = null;
  let runnerOptions = {};
  if (environment === "staging") {
    stagingAdmission = await (options.stagingAdmissionImplementation ?? assertStagingMutationAdmission)({
      environment: operatorEnvironment,
      runWranglerImplementation: runner,
    });
    if (
      stagingAdmission.databaseId !== target.databaseId
      || stagingAdmission.databaseName !== target.databaseName
    ) {
      throw new Error("staging_backup_database_target_mismatch");
    }
    runnerOptions = {
      env: buildPinnedCloudflareEnvironment(operatorEnvironment, stagingAdmission.accountId),
    };
  } else if (environment === "production") {
    productionAdmission = await assertProductionBackupAdmission({
      environment: operatorEnvironment,
      identityImplementation: options.productionIdentityImplementation,
      runWranglerImplementation: runner,
      target,
    });
    if (
      productionAdmission.databaseId !== target.databaseId
      || productionAdmission.databaseName !== target.databaseName
    ) {
      throw new Error("production_backup_database_target_mismatch");
    }
    runnerOptions = approvedRemoteRunnerOptions(productionAdmission.accountId, operatorEnvironment);
  }
  const snapshotId = createOperationId("bkp", now, options.randomBytesImplementation);
  const requestId = randomUUID();
  const snapshotDirectory = resolve(BACKUP_ROOT, environment, snapshotId);
  const artifactName = environment === "local" ? "database.sqlite" : "database.sql";
  const artifactPath = resolve(snapshotDirectory, artifactName);
  const reportPath = resolve(snapshotDirectory, "snapshot.json");

  let providerReference = null;
  if (environment !== "local") {
    const timeTravel = safeRunner(runner, [
      "d1", "time-travel", "info", target.databaseName,
      "--env", environment,
      "--timestamp", now.toISOString(),
      "--json",
    ], "time_travel_info_failed", runnerOptions);
    providerReference = parseTimeTravelBookmark(timeTravel.stdout);
  }

  await ensurePrivateDirectory(snapshotDirectory);
  if (environment === "local") {
    await copyLocalDatabase(artifactPath);
  } else {
    safeRunner(
      runner,
      exportArgs(target, environment, artifactPath),
      "database_export_failed",
      runnerOptions,
    );
  }
  await chmod(artifactPath, 0o600);
  const artifactStat = await stat(artifactPath);
  if (!artifactStat.isFile() || artifactStat.size === 0) throw new Error("database_export_empty");
  const checksumSha256 = await sha256File(artifactPath);
  const completedAt = new Date().toISOString();
  const expiresAt = environment === "local"
    ? null
    : new Date(now.getTime() + 29 * 24 * 60 * 60_000).toISOString();
  const record = buildBackupSnapshotRecord({
    checksumSha256,
    completedAt,
    createdAt: now.toISOString(),
    environment,
    expiresAt,
    id: snapshotId,
    providerReference,
    requestId,
    resourceRef: target.resourceRef,
    sizeBytes: artifactStat.size,
    snapshotKind: environment === "local" ? "export" : "time_travel",
    status: "available",
    updatedAt: completedAt,
  });
  await writePrivateJson(reportPath, {
    artifact: { format: environment === "local" ? "sqlite" : "sql", path: artifactName },
    records: { backup_snapshots: [record], restore_drills: [] },
    report_version: 2,
    source: {
      account_id: stagingAdmission?.accountId ?? productionAdmission?.accountId ?? null,
      database_id: target.databaseId,
      database_name: target.databaseName,
      resource_ref: target.resourceRef,
    },
  });
  return {
    actions: [
      { code: "source_validated", detail: target.resourceRef, ok: true },
      { code: "snapshot_available", detail: snapshotId, ok: true },
      { code: "checksum_recorded", detail: checksumSha256, ok: true },
    ],
    environment,
    ok: true,
    reportRef: relativeReportPath(reportPath),
    snapshot: {
      checksumSha256,
      id: snapshotId,
      sizeBytes: artifactStat.size,
      snapshotKind: record.snapshot_kind,
      status: record.status,
    },
  };
}

export async function assertFreshStagingBackupEvidence(options) {
  const backupRoot = options.backupRoot ?? resolve(BACKUP_ROOT, "staging");
  let entries;
  try {
    entries = await readdir(backupRoot, { withFileTypes: true });
  } catch {
    throw new Error("staging_backup_evidence_missing");
  }
  const latestDirectory = entries
    .filter((entry) => entry.isDirectory() && /^bkp_\d{14}_[a-f0-9]{12}$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (latestDirectory === undefined) throw new Error("staging_backup_evidence_missing");

  const snapshotDirectory = resolve(backupRoot, latestDirectory);
  const reportPath = resolve(snapshotDirectory, "snapshot.json");
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    throw new Error("staging_backup_evidence_invalid");
  }
  const records = report?.records?.backup_snapshots;
  const record = Array.isArray(records) && records.length === 1 ? records[0] : null;
  const source = report?.source;
  if (
    report?.report_version !== 2
    || report?.artifact?.format !== "sql"
    || report?.artifact?.path !== "database.sql"
    || record?.id !== latestDirectory
    || record?.environment !== "staging"
    || record?.resource_ref !== `d1:${options.databaseName}`
    || record?.snapshot_kind !== "time_travel"
    || record?.status !== "available"
    || typeof record?.provider_reference !== "string"
    || record.provider_reference.length < 8
    || !/^[a-f0-9]{64}$/u.test(record?.checksum_sha256 ?? "")
    || !Number.isSafeInteger(record?.size_bytes)
    || record.size_bytes <= 0
  ) {
    throw new Error("staging_backup_evidence_invalid");
  }
  if (
    source?.account_id !== options.accountId
    || source?.database_id !== options.databaseId
    || source?.database_name !== options.databaseName
    || source?.resource_ref !== `d1:${options.databaseName}`
  ) {
    throw new Error("staging_backup_evidence_target_mismatch");
  }

  const completedAt = new Date(record.completed_at);
  const age = (options.now ?? new Date()).getTime() - completedAt.getTime();
  if (!Number.isFinite(completedAt.getTime()) || age < 0 || age > STAGING_BACKUP_FRESHNESS_MS) {
    throw new Error("staging_backup_evidence_stale");
  }

  const artifactPath = resolve(snapshotDirectory, report.artifact.path);
  assertPathInside(snapshotDirectory, artifactPath);
  let artifactStat;
  try {
    artifactStat = await stat(artifactPath);
  } catch {
    throw new Error("staging_backup_artifact_invalid");
  }
  if (!artifactStat.isFile() || artifactStat.size !== record.size_bytes) {
    throw new Error("staging_backup_artifact_invalid");
  }
  if (await sha256File(artifactPath) !== record.checksum_sha256) {
    throw new Error("staging_backup_artifact_invalid");
  }

  return {
    artifactPath,
    checksumSha256: record.checksum_sha256,
    completedAt: completedAt.toISOString(),
    reportRef: options.backupRoot === undefined ? relativeReportPath(reportPath) : reportPath,
    sizeBytes: record.size_bytes,
    snapshotId: record.id,
  };
}

export async function assertFreshStagingContinuationEvidence(options) {
  const reviewedCommitSha = options.reviewedCommitSha;
  if (typeof reviewedCommitSha !== "string" || !/^[a-f0-9]{40}$/u.test(reviewedCommitSha)) {
    throw new Error("staging_continuation_reviewed_commit_invalid");
  }

  const root = resolve(options.repositoryRoot ?? repositoryRoot);
  const backupRoot = options.backupRoot ?? resolve(root, ".wrangler/backups/staging");
  const restoreRoot = options.restoreRoot ?? resolve(root, ".wrangler/restore-drills/staging");
  const backup = await assertFreshStagingBackupEvidence({
    accountId: options.accountId,
    backupRoot,
    databaseId: options.databaseId,
    databaseName: options.databaseName,
    now: options.now,
  });
  let entries;
  try {
    entries = await readdir(restoreRoot, { withFileTypes: true });
  } catch {
    throw new Error("staging_continuation_restore_evidence_missing");
  }
  const latestReport = entries
    .filter((entry) => entry.isFile() && /^rdr_\d{14}_[a-f0-9]{12}\.json$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (latestReport === undefined) throw new Error("staging_continuation_restore_evidence_missing");

  const reportPath = resolve(restoreRoot, latestReport);
  let report;
  let reportStat;
  try {
    [report, reportStat] = await Promise.all([
      readFile(reportPath, "utf8").then((value) => JSON.parse(value)),
      lstat(reportPath),
    ]);
  } catch {
    throw new Error("staging_continuation_restore_evidence_invalid");
  }
  if (!reportStat.isFile() || (reportStat.mode & 0o077) !== 0) {
    throw new Error("staging_continuation_restore_permissions_invalid");
  }

  const snapshots = report?.records?.backup_snapshots;
  const drills = report?.records?.restore_drills;
  const snapshot = Array.isArray(snapshots) && snapshots.length === 1 ? snapshots[0] : null;
  const drill = Array.isArray(drills) && drills.length === 1 ? drills[0] : null;
  const source = report?.source;
  const repositoryMigrationNames = await expectedMigrationNames();
  const updatedAt = new Date(drill?.updated_at ?? "");
  const nowTimestamp = (options.now ?? new Date()).getTime();
  const restoreAge = nowTimestamp - updatedAt.getTime();
  const backupCompletedAt = new Date(backup.completedAt).getTime();
  const targetResourceRef = drill?.target_resource_ref;

  if (
    report?.report_version !== 1
    || report?.reviewed_commit_sha !== reviewedCommitSha
    || source?.account_id !== options.accountId
    || source?.database_id !== options.databaseId
    || source?.database_name !== options.databaseName
    || source?.resource_ref !== `d1:${options.databaseName}`
    || snapshot?.environment !== "staging"
    || snapshot?.resource_ref !== `d1:${options.databaseName}`
    || snapshot?.status !== "available"
    || snapshot?.checksum_sha256 !== backup.checksumSha256
    || snapshot?.size_bytes !== backup.sizeBytes
    || drill?.environment !== "staging"
    || drill?.status !== "passed"
    || drill?.backup_snapshot_id !== snapshot?.id
    || !/^d1:selinow-restore-drill-staging-[a-f0-9]{12}$/u.test(targetResourceRef ?? "")
    || targetResourceRef === `d1:${options.databaseName}`
    || drill?.foreign_key_violation_count !== 0
    || !Number.isSafeInteger(drill?.restored_item_count)
    || drill.restored_item_count < 1
    || report?.verification?.integrityOk !== true
    || report?.verification?.foreignKeyViolationCount !== 0
    || !Array.isArray(report?.verification?.migrationNames)
    || report.verification.migrationNames.length !== repositoryMigrationNames.length
    || report.verification.migrationNames.some((name, index) => name !== repositoryMigrationNames[index])
    || !Number.isFinite(updatedAt.getTime())
    || updatedAt.getTime() < backupCompletedAt
    || restoreAge < 0
    || restoreAge > STAGING_BACKUP_FRESHNESS_MS
  ) {
    throw new Error("staging_continuation_restore_evidence_invalid");
  }

  return {
    backup,
    reviewedCommitSha,
    restore: {
      completedAt: updatedAt.toISOString(),
      reportRef: reportPath,
      snapshotId: snapshot.id,
      targetResourceRef,
    },
  };
}

export async function assertFreshProductionBootstrapBackupEvidence(options) {
  const backupRoot = options.backupRoot ?? resolve(BACKUP_ROOT, "production");
  let entries;
  try {
    entries = await readdir(backupRoot, { withFileTypes: true });
  } catch {
    throw new Error("production_bootstrap_backup_evidence_missing");
  }
  const latestDirectory = entries
    .filter((entry) => entry.isDirectory() && /^bkp_\d{14}_[a-f0-9]{12}$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (latestDirectory === undefined) throw new Error("production_bootstrap_backup_evidence_missing");

  const snapshotDirectory = resolve(backupRoot, latestDirectory);
  const reportPath = resolve(snapshotDirectory, "snapshot.json");
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    throw new Error("production_bootstrap_backup_evidence_invalid");
  }
  const records = report?.records?.backup_snapshots;
  const record = Array.isArray(records) && records.length === 1 ? records[0] : null;
  const source = report?.source;
  if (
    report?.report_version !== 2
    || report?.artifact?.format !== "sql"
    || report?.artifact?.path !== "database.sql"
    || record?.id !== latestDirectory
    || record?.environment !== "production"
    || record?.resource_ref !== `d1:${options.databaseName}`
    || record?.snapshot_kind !== "time_travel"
    || record?.status !== "available"
    || typeof record?.provider_reference !== "string"
    || record.provider_reference.length < 8
    || !/^[a-f0-9]{64}$/u.test(record?.checksum_sha256 ?? "")
    || !Number.isSafeInteger(record?.size_bytes)
    || record.size_bytes <= 0
  ) {
    throw new Error("production_bootstrap_backup_evidence_invalid");
  }
  if (
    source?.account_id !== options.accountId
    || source?.database_id !== options.databaseId
    || source?.database_name !== options.databaseName
    || source?.resource_ref !== `d1:${options.databaseName}`
  ) {
    throw new Error("production_bootstrap_backup_target_mismatch");
  }

  const completedAt = new Date(record.completed_at);
  const age = (options.now ?? new Date()).getTime() - completedAt.getTime();
  if (!Number.isFinite(completedAt.getTime()) || age < 0 || age > 24 * 60 * 60_000) {
    throw new Error("production_bootstrap_backup_evidence_stale");
  }

  const artifactPath = resolve(snapshotDirectory, report.artifact.path);
  assertPathInside(snapshotDirectory, artifactPath);
  let artifactStat;
  try {
    artifactStat = await stat(artifactPath);
  } catch {
    throw new Error("production_bootstrap_backup_artifact_invalid");
  }
  if (!artifactStat.isFile() || artifactStat.size !== record.size_bytes) {
    throw new Error("production_bootstrap_backup_artifact_invalid");
  }
  if (await sha256File(artifactPath) !== record.checksum_sha256) {
    throw new Error("production_bootstrap_backup_artifact_invalid");
  }

  return {
    artifactPath,
    completedAt: completedAt.toISOString(),
    checksumSha256: record.checksum_sha256,
    providerBookmarkRecorded: true,
    reportRef: options.backupRoot === undefined ? relativeReportPath(reportPath) : reportPath,
    sizeBytes: record.size_bytes,
    snapshotId: record.id,
  };
}

/**
 * Continuation migrations use the non-empty production backup/restore path.
 * The historical empty-baseline ceremony cannot prove that the current
 * production schema and data survive a forward-only continuation.
 */
export async function assertFreshProductionContinuationEvidence(options) {
  const reviewedCommitSha = options.reviewedCommitSha;
  if (typeof reviewedCommitSha !== "string" || !/^[a-f0-9]{40}$/u.test(reviewedCommitSha)) {
    throw new Error("production_continuation_reviewed_commit_invalid");
  }

  const root = resolve(options.repositoryRoot ?? repositoryRoot);
  const backupRoot = options.backupRoot ?? resolve(root, ".wrangler/backups/production");
  const restoreRoot = options.restoreRoot ?? resolve(root, ".wrangler/restore-drills/production");
  const backup = await assertFreshProductionBootstrapBackupEvidence({
    accountId: options.accountId,
    backupRoot,
    databaseId: options.databaseId,
    databaseName: options.databaseName,
    now: options.now,
  });
  let backupReportStat;
  let backupArtifactStat;
  try {
    [backupReportStat, backupArtifactStat] = await Promise.all([
      lstat(backup.reportRef),
      lstat(backup.artifactPath),
    ]);
  } catch {
    throw new Error("production_continuation_backup_evidence_invalid");
  }
  if (
    !backupReportStat.isFile()
    || (backupReportStat.mode & 0o077) !== 0
    || !backupArtifactStat.isFile()
    || (backupArtifactStat.mode & 0o077) !== 0
  ) {
    throw new Error("production_continuation_backup_permissions_invalid");
  }

  let entries;
  try {
    entries = await readdir(restoreRoot, { withFileTypes: true });
  } catch {
    throw new Error("production_continuation_restore_evidence_missing");
  }
  const latestReport = entries
    .filter((entry) => entry.isFile() && /^rdr_\d{14}_[a-f0-9]{12}\.json$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (latestReport === undefined) throw new Error("production_continuation_restore_evidence_missing");

  const reportPath = resolve(restoreRoot, latestReport);
  let report;
  let reportStat;
  try {
    [report, reportStat] = await Promise.all([
      readFile(reportPath, "utf8").then((value) => JSON.parse(value)),
      lstat(reportPath),
    ]);
  } catch {
    throw new Error("production_continuation_restore_evidence_invalid");
  }
  if (!reportStat.isFile() || (reportStat.mode & 0o077) !== 0) {
    throw new Error("production_continuation_restore_permissions_invalid");
  }

  const snapshots = report?.records?.backup_snapshots;
  const drills = report?.records?.restore_drills;
  const snapshot = Array.isArray(snapshots) && snapshots.length === 1 ? snapshots[0] : null;
  const drill = Array.isArray(drills) && drills.length === 1 ? drills[0] : null;
  const source = report?.source;
  const repositoryMigrationNames = await expectedMigrationNames();
  const updatedAt = new Date(drill?.updated_at ?? "");
  const nowTimestamp = (options.now ?? new Date()).getTime();
  const restoreAge = nowTimestamp - updatedAt.getTime();
  const targetResourceRef = drill?.target_resource_ref;
  const reportCommit = report?.reviewed_commit_sha;

  if (
    report?.report_version !== 1
    || reportCommit !== reviewedCommitSha
    || source?.account_id !== options.accountId
    || source?.database_id !== options.databaseId
    || source?.database_name !== options.databaseName
    || source?.resource_ref !== `d1:${options.databaseName}`
    || snapshot?.environment !== "production"
    || snapshot?.resource_ref !== `d1:${options.databaseName}`
    || snapshot?.status !== "available"
    || snapshot?.checksum_sha256 !== backup.checksumSha256
    || snapshot?.size_bytes !== backup.sizeBytes
    || drill?.environment !== "isolated"
    || drill?.status !== "passed"
    || drill?.backup_snapshot_id !== snapshot?.id
    || !/^d1:selinow-restore-drill-production-[a-f0-9]{12}$/u.test(targetResourceRef ?? "")
    || targetResourceRef === `d1:${options.databaseName}`
    || drill?.foreign_key_violation_count !== 0
    || !Number.isSafeInteger(drill?.restored_item_count)
    || drill.restored_item_count < 1
    || report?.verification?.integrityOk !== true
    || report?.verification?.foreignKeyViolationCount !== 0
    || !Array.isArray(report?.verification?.migrationNames)
    || report.verification.migrationNames.length !== repositoryMigrationNames.length
    || report.verification.migrationNames.some((name, index) => name !== repositoryMigrationNames[index])
    || !Number.isFinite(updatedAt.getTime())
    || restoreAge < 0
    || restoreAge > 30 * 24 * 60 * 60_000
  ) {
    throw new Error("production_continuation_restore_evidence_invalid");
  }

  return {
    backup,
    reviewedCommitSha,
    restore: {
      completedAt: updatedAt.toISOString(),
      reportRef: reportPath,
      snapshotId: snapshot.id,
      targetResourceRef,
    },
  };
}

function assertPathInside(parent, child) {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  if (!normalizedChild.startsWith(`${normalizedParent}${sep}`)) throw new Error("restore_target_outside_temp");
}

function listApplicationTables(database) {
  return database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT IN ('_cf_METADATA', 'd1_migrations')
    ORDER BY name
  `).all().map((row) => String(row.name));
}

function quoteTable(name) {
  if (!/^[a-z][a-z0-9_]*$/u.test(name)) throw new Error("database_table_name_invalid");
  return `"${name}"`;
}

function readTableCounts(database, tables) {
  return Object.fromEntries(tables.map((table) => {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteTable(table)}`).get();
    const count = Number(row?.count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("database_count_invalid");
    return [table, count];
  }));
}

function sumCounts(counts) {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(total)) throw new Error("database_count_invalid");
  return total;
}

function verifyLocalDatabase(databasePath, baselineCounts) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrityRows = database.prepare("PRAGMA integrity_check").all();
    const integrityOk = integrityRows.length === 1 && String(Object.values(integrityRows[0] ?? {})[0]) === "ok";
    const foreignKeyViolationCount = database.prepare("PRAGMA foreign_key_check").all().length;
    const tables = new Set(listApplicationTables(database));
    const missingTables = REQUIRED_TABLES.filter((table) => !tables.has(table));
    const countTables = Object.keys(baselineCounts);
    const missingCountTables = countTables.filter((table) => !tables.has(table));
    const restoredCounts = missingCountTables.length === 0
      ? readTableCounts(database, countTables)
      : {};
    // Forward migrations may seed new catalog rows (for example paid plans),
    // but a restore must never contain fewer authoritative rows than the
    // snapshot baseline.
    const countMismatches = Object.entries(baselineCounts)
      .filter(([table, count]) => (restoredCounts[table] ?? -1) < count)
      .map(([table]) => table);
    const expectedMigrations = database.prepare("SELECT name FROM d1_migrations ORDER BY name").all().map((row) => String(row.name));
    const crossLedgerMismatches = readCrossLedgerMismatches(database);
    return {
      countMismatches,
      expectedMigrations,
      foreignKeyViolationCount,
      integrityOk,
      missingTables,
      missingCountTables,
      crossLedgerMismatches,
      restoredItemCount: sumCounts(restoredCounts),
    };
  } finally {
    database.close();
  }
}

// These relationships are not all expressible as SQLite foreign keys because
// provider payloads may legitimately omit tenant metadata. Keep the checks
// reference-only and fail closed when an explicit identity disagrees.
export function readCrossLedgerMismatches(database) {
  const rows = database.prepare(`
    SELECT 'subscription_event_provider_shop' AS code, events.id AS id
    FROM subscription_events AS events
    INNER JOIN billing_provider_events AS provider ON provider.id = events.provider_event_id
    WHERE events.source_kind = 'provider'
      AND provider.shop_id IS NOT NULL
      AND provider.shop_id != events.shop_id
    UNION ALL
    SELECT 'subscription_event_provider_ref_missing' AS code, events.id AS id
    FROM subscription_events AS events
    WHERE events.source_kind = 'provider' AND events.provider_event_id IS NULL
    UNION ALL
    SELECT 'invoice_billing_account_shop' AS code, invoices.id AS id
    FROM billing_invoices AS invoices
    INNER JOIN billing_accounts AS accounts ON accounts.id = invoices.billing_account_id
    WHERE invoices.billing_account_id IS NOT NULL
      AND (accounts.shop_id != invoices.shop_id
        OR accounts.provider_code != invoices.provider_code
        OR accounts.currency != invoices.currency)
    UNION ALL
    SELECT 'checkout_subscription_plan_price_provider' AS code, sessions.id AS id
    FROM billing_checkout_sessions AS sessions
    INNER JOIN shop_subscriptions AS subscriptions
      ON subscriptions.shop_id = sessions.shop_id AND subscriptions.id = sessions.subscription_id
    INNER JOIN plan_prices AS prices ON prices.id = sessions.price_id
    WHERE prices.plan_id != sessions.plan_id
      OR prices.provider_code != sessions.provider_code
      OR subscriptions.shop_id != sessions.shop_id
    UNION ALL
    SELECT 'activation_projection_invalid' AS code, milestones.id AS id
    FROM activation_milestones AS milestones
    WHERE json_type(milestones.projection_json) != 'object'
      OR EXISTS (
        SELECT 1
        FROM json_each(milestones.projection_json)
        WHERE key NOT IN ('channel', 'currency', 'fulfillment_type', 'trigger')
          OR type != 'text'
          OR (key = 'channel' AND value NOT IN ('website', 'telegram'))
          OR (key = 'currency' AND value NOT IN ('VND', 'USD', 'EUR', 'JPY'))
          OR (key = 'fulfillment_type' AND value NOT IN ('license_key', 'manual'))
          OR (key = 'trigger' AND value NOT IN ('manual', 'publish', 'test'))
      )
    UNION ALL
    SELECT 'trial_conversion_without_paid_event' AS code, milestones.id AS id
    FROM activation_milestones AS milestones
    WHERE milestones.milestone_code = 'trial_converted'
      AND NOT EXISTS (
        SELECT 1
        FROM subscription_events AS events
        INNER JOIN billing_provider_events AS provider ON provider.id = events.provider_event_id
        WHERE events.shop_id = milestones.shop_id
          AND events.to_state = 'active'
          AND events.source_kind = 'provider'
          AND provider.shop_id = milestones.shop_id
          AND provider.status = 'processed'
      )
  `).all();
  return rows.map((row) => ({ code: String(row.code), id: String(row.id) }));
}

export function verifyLocalIntegrity(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrityRows = database.prepare("PRAGMA integrity_check").all();
    return {
      foreignKeyViolationCount: database.prepare("PRAGMA foreign_key_check").all().length,
      integrityOk: integrityRows.length === 1 && String(Object.values(integrityRows[0] ?? {})[0]) === "ok",
    };
  } finally {
    database.close();
  }
}

async function expectedMigrationNames() {
  return (await readdir(resolve(repositoryRoot, "migrations")))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
}

async function applyPendingLocalMigrations(databasePath, migrationNames) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE IF NOT EXISTS d1_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
    const applied = new Set(database.prepare("SELECT name FROM d1_migrations").all().map((row) => String(row.name)));
    for (const migrationName of migrationNames) {
      if (applied.has(migrationName)) continue;
      const migrationSql = await readFile(resolve(repositoryRoot, "migrations", migrationName), "utf8");
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(migrationSql);
        database.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(migrationName);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw new Error(`restore_migration_failed:${migrationName}`, { cause: error });
      }
    }
  } finally {
    database.close();
  }
}

function assertLocalVerification(verification, migrationNames) {
  if (!verification.integrityOk) throw new Error("restore_integrity_failed");
  if (verification.foreignKeyViolationCount !== 0) throw new Error("restore_foreign_keys_failed");
  assertRequiredRestoreTables(REQUIRED_TABLES.filter((table) => !verification.missingTables.includes(table)));
  if (verification.missingCountTables.length !== 0) throw new Error("restore_count_tables_missing");
  if (verification.countMismatches.length !== 0) throw new Error("restore_count_mismatch");
  if (verification.crossLedgerMismatches.length !== 0) throw new Error("restore_cross_ledger_mismatch");
  assertExactMigrationLedger(verification.expectedMigrations, migrationNames);
}

export function assertExactMigrationLedger(appliedMigrationNames, repositoryMigrationNames) {
  if (
    appliedMigrationNames.length !== repositoryMigrationNames.length
    || appliedMigrationNames.some((name, index) => name !== repositoryMigrationNames[index])
  ) {
    throw new Error("restore_migrations_incomplete");
  }
}

export function resolvePendingMigrationNames(appliedMigrationNames, repositoryMigrationNames) {
  if (
    appliedMigrationNames.length > repositoryMigrationNames.length
    || appliedMigrationNames.some((name, index) => repositoryMigrationNames[index] !== name)
  ) {
    throw new Error("restore_migrations_incomplete");
  }
  return repositoryMigrationNames.slice(appliedMigrationNames.length);
}

function insertIsolatedReportRecords(databasePath, snapshot, drill) {
  const database = new DatabaseSync(databasePath);
  try {
    const tables = new Set(listApplicationTables(database));
    if (!tables.has("backup_snapshots") || !tables.has("restore_drills")) return;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`
        INSERT INTO backup_snapshots (
          id, shop_id, scope_key, environment, resource_kind, resource_ref,
          snapshot_kind, provider_reference, status, checksum_sha256, item_count,
          size_bytes, expires_at, last_safe_error_code, requested_by_user_id,
          request_id, completed_at, version, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
      `).run(
        snapshot.id, snapshot.scope_key, snapshot.environment, snapshot.resource_kind,
        snapshot.resource_ref, snapshot.snapshot_kind, snapshot.provider_reference,
        snapshot.status, snapshot.checksum_sha256, snapshot.item_count, snapshot.size_bytes,
        snapshot.expires_at, snapshot.last_safe_error_code, snapshot.request_id,
        snapshot.completed_at, snapshot.version, snapshot.created_at, snapshot.updated_at,
      );
      database.prepare(`
        INSERT INTO restore_drills (
          id, backup_snapshot_id, shop_id, environment, target_resource_ref,
          status, integrity_status, foreign_key_violation_count, restored_item_count,
          last_safe_error_code, requested_by_user_id, request_id, started_at,
          completed_at, version, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        drill.id, drill.backup_snapshot_id, drill.environment, drill.target_resource_ref,
        drill.status, drill.integrity_status, drill.foreign_key_violation_count,
        drill.restored_item_count, drill.last_safe_error_code, drill.request_id,
        drill.started_at, drill.completed_at, drill.version, drill.created_at, drill.updated_at,
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } catch {
    throw new Error("restore_report_record_failed");
  } finally {
    database.close();
  }
}

export async function cleanupRestoreTempDirectory(path, drillId) {
  const resolvedPath = resolve(path);
  const resolvedTmp = resolve(tmpdir());
  if (dirname(resolvedPath) !== resolvedTmp || !basename(resolvedPath).startsWith(RESTORE_TEMP_PREFIX)) {
    throw new Error("restore_cleanup_target_invalid");
  }
  let marker;
  try {
    marker = await readFile(resolve(resolvedPath, RESTORE_MARKER), "utf8");
  } catch {
    throw new Error("restore_cleanup_marker_missing");
  }
  if (marker.trim() !== drillId) throw new Error("restore_cleanup_marker_invalid");
  await rm(resolvedPath, { force: true, recursive: true });
}

function restoreDryRun(environment, target) {
  const targetRef = environment === "local"
    ? "isolated:temporary-local-d1"
    : `d1:selinow-restore-drill-${environment}-<generated>`;
  return {
    actions: [
      { code: "validate_source", detail: target.resourceRef, ok: true },
      { code: "create_isolated_target", detail: targetRef, ok: true },
      { code: "export_and_restore", detail: "source_to_isolated_target", ok: true },
      { code: "apply_migrations", detail: "all_pending_forward_migrations", ok: true },
      { code: "verify_restore", detail: "integrity_fk_schema_counts", ok: true },
      { code: "cleanup_isolated_target", detail: "exact_tool_created_target_only", ok: true },
    ],
    environment,
    ok: true,
  };
}

async function prepareRestoreReport(environment, drillId) {
  const directory = resolve(DRILL_REPORT_ROOT, environment);
  await ensurePrivateDirectory(directory);
  return resolve(directory, `${drillId}.json`);
}

async function runLocalRestoreDrill(target, identifiers) {
  const tempDirectory = await mkdtemp(join(tmpdir(), RESTORE_TEMP_PREFIX));
  const markerPath = resolve(tempDirectory, RESTORE_MARKER);
  await writeFile(markerPath, `${identifiers.drillId}\n`, { encoding: "utf8", mode: 0o600 });
  const databasePath = resolve(tempDirectory, "restored.sqlite");
  assertPathInside(tempDirectory, databasePath);
  let cleanupError = null;
  let operationError = null;
  let outcome;
  try {
    await copyLocalDatabase(databasePath);
    await chmod(databasePath, 0o600);
    const sourceStat = await stat(databasePath);
    const checksumSha256 = await sha256File(databasePath);
    const baselineDatabase = new DatabaseSync(databasePath, { readOnly: true });
    let baselineCounts;
    try {
      const tables = listApplicationTables(baselineDatabase);
      baselineCounts = readTableCounts(baselineDatabase, tables);
    } finally {
      baselineDatabase.close();
    }
    const migrationNames = await expectedMigrationNames();
    const normalizedMigrationAliases = normalizeHistoricalMigrationAliases(databasePath, migrationNames);
    await applyPendingLocalMigrations(databasePath, migrationNames);
    const verification = verifyLocalDatabase(databasePath, baselineCounts);
    assertLocalVerification(verification, migrationNames);
    const completedAt = new Date().toISOString();
    const snapshotRecord = buildBackupSnapshotRecord({
      checksumSha256,
      completedAt,
      createdAt: identifiers.startedAt,
      environment: "local",
      id: identifiers.snapshotId,
      itemCount: sumCounts(baselineCounts),
      requestId: identifiers.requestId,
      resourceRef: target.resourceRef,
      sizeBytes: sourceStat.size,
      snapshotKind: "export",
      status: "available",
      updatedAt: completedAt,
    });
    const drillRecord = buildRestoreDrillRecord({
      backupSnapshotId: identifiers.snapshotId,
      completedAt,
      createdAt: identifiers.startedAt,
      environment: "isolated",
      foreignKeyViolationCount: verification.foreignKeyViolationCount,
      id: identifiers.drillId,
      integrityStatus: "ok",
      requestId: identifiers.requestId,
      restoredItemCount: verification.restoredItemCount,
      startedAt: identifiers.startedAt,
      status: "passed",
      targetResourceRef: `isolated:${identifiers.drillId}`,
      updatedAt: completedAt,
    });
    insertIsolatedReportRecords(databasePath, snapshotRecord, drillRecord);
    outcome = {
      drillRecord,
      snapshotRecord,
      verification: { ...verification, normalizedMigrationAliases },
    };
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await cleanupRestoreTempDirectory(tempDirectory, identifiers.drillId);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError !== null) throw new Error("restore_cleanup_failed", { cause: operationError ?? cleanupError });
  if (operationError !== null) throw operationError;
  return outcome;
}

function parseWranglerRows(output, errorCode) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error(errorCode);
  }
  const envelopes = Array.isArray(payload) ? payload : [payload];
  const rows = envelopes.flatMap((envelope) => Array.isArray(envelope?.results) ? envelope.results : []);
  if (!Array.isArray(rows)) throw new Error(errorCode);
  return rows;
}

function remoteExecute(runner, databaseName, environment, sql, errorCode, options = {}) {
  return safeRunner(runner, [
    "d1", "execute", databaseName, "--remote", "--env", environment,
    "--command", sql, "--json",
  ], errorCode, options).stdout;
}

function remoteCountSql(tables = CORE_COUNT_TABLES) {
  return `SELECT ${tables.map((table) => `(SELECT COUNT(*) FROM ${table}) AS ${table}`).join(", ")};`;
}

function parseRemoteCounts(output, tables = CORE_COUNT_TABLES) {
  const row = parseWranglerRows(output, "restore_counts_invalid")[0];
  if (typeof row !== "object" || row === null) throw new Error("restore_counts_invalid");
  return Object.fromEntries(tables.map((table) => {
    const count = Number(row[table]);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("restore_counts_invalid");
    return [table, count];
  }));
}

function remoteCrossLedgerSql() {
  return `SELECT COUNT(*) AS mismatch_count FROM (
    SELECT events.id
    FROM subscription_events AS events
    INNER JOIN billing_provider_events AS provider ON provider.id = events.provider_event_id
    WHERE events.source_kind = 'provider'
      AND provider.shop_id IS NOT NULL
      AND provider.shop_id != events.shop_id
    UNION ALL
    SELECT events.id FROM subscription_events AS events
    WHERE events.source_kind = 'provider' AND events.provider_event_id IS NULL
    UNION ALL
    SELECT invoices.id
    FROM billing_invoices AS invoices
    INNER JOIN billing_accounts AS accounts ON accounts.id = invoices.billing_account_id
    WHERE invoices.billing_account_id IS NOT NULL AND accounts.shop_id != invoices.shop_id
    UNION ALL
    SELECT milestones.id FROM activation_milestones AS milestones
    WHERE milestones.milestone_code = 'trial_converted'
      AND NOT EXISTS (
        SELECT 1
        FROM subscription_events AS events
        INNER JOIN billing_provider_events AS provider ON provider.id = events.provider_event_id
        WHERE events.shop_id = milestones.shop_id
          AND events.to_state = 'active'
          AND events.source_kind = 'provider'
          AND provider.shop_id = milestones.shop_id
          AND provider.status = 'processed'
      )
  );`;
}

function parseRemoteCrossLedgerMismatchCount(output) {
  const row = parseWranglerRows(output, "restore_cross_ledger_invalid")[0];
  const count = Number(row?.mismatch_count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("restore_cross_ledger_invalid");
  return count;
}

function parseWranglerWhoami(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("cloudflare_identity_invalid");
  }
  if (payload?.loggedIn !== true || !Array.isArray(payload.accounts)) {
    throw new Error("cloudflare_identity_invalid");
  }
  const accountIds = payload.accounts.map((account) => account?.id);
  if (accountIds.some((accountId) => (
    typeof accountId !== "string" || !CLOUDFLARE_ACCOUNT_ID_PATTERN.test(accountId)
  ))) {
    throw new Error("cloudflare_identity_invalid");
  }
  return accountIds;
}

function parseD1List(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("database_list_invalid");
  }
  if (!Array.isArray(payload)) throw new Error("database_list_invalid");
  return payload.map((database) => {
    const id = database?.uuid;
    const name = database?.name;
    if (
      typeof id !== "string"
      || !D1_DATABASE_ID_PATTERN.test(id)
      || typeof name !== "string"
      || name.length < 1
      || name.length > 128
    ) {
      throw new Error("database_list_invalid");
    }
    return { id, name };
  });
}

async function loadApprovedRemoteRestoreIdentity(target) {
  const environment = target.environment;
  let specification;
  let manifest;
  try {
    specification = JSON.parse(await readFile(
      resolve(repositoryRoot, `infra/environments/${environment}.json`),
      "utf8",
    ));
    manifest = JSON.parse(await readFile(
      resolve(repositoryRoot, `infra/generated/${environment}.json`),
      "utf8",
    ));
  } catch {
    throw new Error(`restore_identity_manifest_invalid:${environment}`);
  }

  const accountId = manifest?.accountId;
  const database = manifest?.resources?.d1;
  if (
    specification?.environment !== environment
    || manifest?.environment !== environment
    || typeof accountId !== "string"
    || !CLOUDFLARE_ACCOUNT_ID_PATTERN.test(accountId)
    || specification?.accountId !== accountId
  ) {
    throw new Error(`restore_identity_manifest_invalid:${environment}`);
  }
  if (
    specification?.resources?.d1 !== target.databaseName
    || database?.name !== target.databaseName
    || database?.id !== target.databaseId
    || !D1_DATABASE_ID_PATTERN.test(database?.id ?? "")
  ) {
    throw new Error(`restore_database_mismatch:${environment}`);
  }
  return { accountId, databaseId: database.id, databaseName: database.name };
}

function approvedRemoteRunnerOptions(accountId, additionalEnvironment = {}) {
  return {
    env: buildPinnedCloudflareEnvironment(
      { ...process.env, ...additionalEnvironment },
      accountId,
    ),
  };
}

function normalizeRemoteMigrationAliases(
  runner,
  targetName,
  environment,
  runnerOptions,
  appliedMigrationNames,
  repositoryMigrationNames,
) {
  const repositoryNames = new Set(repositoryMigrationNames);
  const normalizedNames = [...appliedMigrationNames];
  const normalizedMigrationAliases = [];
  for (const alias of HISTORICAL_MIGRATION_ALIASES) {
    if (repositoryNames.has(alias.historical)) throw new Error("restore_migration_alias_is_current");
    if (!repositoryNames.has(alias.canonical)) throw new Error("restore_migration_alias_canonical_missing");
    const historicalCount = normalizedNames.filter((name) => name === alias.historical).length;
    if (historicalCount === 0) continue;
    const canonicalCount = normalizedNames.filter((name) => name === alias.canonical).length;
    if (historicalCount !== 1 || canonicalCount !== 1) throw new Error("restore_migration_alias_unresolved");
    remoteExecute(
      runner,
      targetName,
      environment,
      `DELETE FROM d1_migrations WHERE name = '${alias.historical}';`,
      "restore_migration_alias_normalization_failed",
      runnerOptions,
    );
    const historicalIndex = normalizedNames.indexOf(alias.historical);
    normalizedNames.splice(historicalIndex, 1);
    normalizedMigrationAliases.push({ ...alias });
  }
  return { migrationNames: normalizedNames, normalizedMigrationAliases };
}

function admitRemoteRestoreTarget(runner, target, approvedIdentity, runnerOptions) {
  const accountIds = parseWranglerWhoami(safeRunner(
    runner,
    ["whoami", "--json"],
    "cloudflare_credentials_missing",
    runnerOptions,
  ).stdout);
  if (!accountIds.includes(approvedIdentity.accountId)) {
    throw new Error(`restore_account_mismatch:${target.environment}`);
  }

  const databases = parseD1List(safeRunner(
    runner,
    ["d1", "list", "--env", target.environment, "--json"],
    "database_list_failed",
    runnerOptions,
  ).stdout);
  const exactSources = databases.filter((database) => (
    database.id === approvedIdentity.databaseId
    && database.name === approvedIdentity.databaseName
  ));
  if (exactSources.length !== 1) {
    throw new Error(`restore_database_mismatch:${target.environment}`);
  }
  return databases;
}

export async function assertProductionBackupAdmission(input = {}) {
  const approvedIdentity = await (input.identityImplementation ?? loadApprovedRemoteRestoreIdentity)(input.target);
  const runnerOptions = approvedRemoteRunnerOptions(
    approvedIdentity.accountId,
    input.environment ?? process.env,
  );
  admitRemoteRestoreTarget(
    input.runWranglerImplementation ?? runWrangler,
    input.target,
    approvedIdentity,
    runnerOptions,
  );
  return approvedIdentity;
}

async function runRemoteRestoreDrill(options, target, identifiers) {
  const environment = target.environment;
  const runner = options.runner ?? runWrangler;
  const targetName = `selinow-restore-drill-${environment}-${identifiers.drillId.slice(-12)}`;
  assertDistinctRestoreTarget(target.databaseName, targetName, environment);
  const approvedIdentity = await loadApprovedRemoteRestoreIdentity(target);
  const runnerOptions = approvedRemoteRunnerOptions(approvedIdentity.accountId);
  const databases = admitRemoteRestoreTarget(runner, target, approvedIdentity, runnerOptions);
  if (databases.some((database) => database.name === targetName)) {
    throw new Error("restore_target_already_exists");
  }
  const tempDirectory = await mkdtemp(join(tmpdir(), RESTORE_TEMP_PREFIX));
  await writeFile(resolve(tempDirectory, RESTORE_MARKER), `${identifiers.drillId}\n`, { encoding: "utf8", mode: 0o600 });
  const sourceExport = resolve(tempDirectory, "source.sql");
  const targetExport = resolve(tempDirectory, "target.sql");
  const targetVerificationDatabase = resolve(tempDirectory, "target-verification.sqlite");
  let createdTarget = false;
  let cleanupFailure = false;
  let operationError = null;
  let outcome;
  try {
    safeRunner(runner, [
      "d1", "create", targetName, "--env", environment, "--location", "apac",
    ], "restore_target_create_failed", runnerOptions);
    createdTarget = true;
    const sourceTableRows = parseWranglerRows(remoteExecute(
      runner,
      target.databaseName,
      environment,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${CORE_COUNT_TABLES.map((table) => `'${table}'`).join(", ")});`,
      "restore_source_tables_failed",
      runnerOptions,
    ), "restore_source_tables_invalid");
    const sourceTableNames = new Set(sourceTableRows
      .map((row) => row?.name)
      .filter((name) => typeof name === "string"));
    if (BILLING_ACTIVATION_TABLES.some((table) => !sourceTableNames.has(table))) {
      throw new Error("restore_source_schema_incomplete");
    }
    const sourceCountTables = CORE_COUNT_TABLES.filter((table) => sourceTableNames.has(table));
    if (sourceCountTables.length === 0) throw new Error("restore_source_tables_empty");
    const sourceCounts = parseRemoteCounts(remoteExecute(
      runner,
      target.databaseName,
      environment,
      remoteCountSql(sourceCountTables),
      "restore_source_counts_failed",
      runnerOptions,
    ), sourceCountTables);
    safeRunner(
      runner,
      exportArgs(target, environment, sourceExport),
      "database_export_failed",
      runnerOptions,
    );
    await chmod(sourceExport, 0o600);
    const sourceStat = await stat(sourceExport);
    if (!sourceStat.isFile() || sourceStat.size === 0) throw new Error("database_export_empty");
    const checksumSha256 = await sha256File(sourceExport);
    safeRunner(runner, [
      "d1", "execute", targetName, "--remote", "--env", environment,
      "--file", sourceExport, "--yes",
    ], "restore_import_failed", runnerOptions);
    const repositoryMigrationNames = await expectedMigrationNames();
    const initialMigrationRows = parseWranglerRows(remoteExecute(
      runner,
      targetName,
      environment,
      "SELECT name FROM d1_migrations ORDER BY name;",
      "restore_migration_ledger_query_failed",
      runnerOptions,
    ), "restore_migration_ledger_invalid");
    const initialMigrationNames = initialMigrationRows.map((row) => {
      if (typeof row?.name !== "string") throw new Error("restore_migration_ledger_invalid");
      return row.name;
    });
    const normalizedMigrationLedger = normalizeRemoteMigrationAliases(
      runner,
      targetName,
      environment,
      runnerOptions,
      initialMigrationNames,
      repositoryMigrationNames,
    );
    const pendingMigrationNames = resolvePendingMigrationNames(
      normalizedMigrationLedger.migrationNames,
      repositoryMigrationNames,
    );
    const migrationRunnerOptions = approvedRemoteRunnerOptions(approvedIdentity.accountId, { CI: "1" });
    for (const migrationName of pendingMigrationNames) {
      safeRunner(runner, [
        "d1", "execute", targetName, "--remote", "--env", environment,
        "--file", resolve(repositoryRoot, "migrations", migrationName), "--yes",
      ], `restore_migration_failed:${migrationName}`, migrationRunnerOptions);
      remoteExecute(
        runner,
        targetName,
        environment,
        `INSERT INTO d1_migrations (name) VALUES ('${migrationName}');`,
        `restore_migration_ledger_write_failed:${migrationName}`,
        migrationRunnerOptions,
      );
    }
    const appliedMigrationRows = parseWranglerRows(remoteExecute(
      runner,
      targetName,
      environment,
      "SELECT name FROM d1_migrations ORDER BY name;",
      "restore_migration_ledger_query_failed",
      runnerOptions,
    ), "restore_migration_ledger_invalid");
    const appliedMigrationNames = appliedMigrationRows.map((row) => {
      if (typeof row?.name !== "string") throw new Error("restore_migration_ledger_invalid");
      return row.name;
    });
    assertExactMigrationLedger(appliedMigrationNames, repositoryMigrationNames);
    const targetCounts = parseRemoteCounts(remoteExecute(
      runner,
      targetName,
      environment,
      remoteCountSql(sourceCountTables),
      "restore_target_counts_failed",
      runnerOptions,
    ), sourceCountTables);
    if (sourceCountTables.some((table) => (targetCounts[table] ?? -1) < sourceCounts[table])) {
      throw new Error("restore_count_mismatch");
    }
    const crossLedgerMismatchCount = parseRemoteCrossLedgerMismatchCount(remoteExecute(
      runner,
      targetName,
      environment,
      remoteCrossLedgerSql(),
      "restore_cross_ledger_query_failed",
      runnerOptions,
    ));
    if (crossLedgerMismatchCount !== 0) throw new Error("restore_cross_ledger_mismatch");
    safeRunner(runner, [
      "d1", "export", targetName, "--remote", "--env", environment,
      "--output", targetExport, "--skip-confirmation",
    ], "restore_target_export_failed", runnerOptions);
    await chmod(targetExport, 0o600);
    const targetExportStat = await stat(targetExport);
    if (!targetExportStat.isFile() || targetExportStat.size === 0) {
      throw new Error("restore_target_export_empty");
    }
    const targetDatabase = new DatabaseSync(targetVerificationDatabase);
    try {
      targetDatabase.exec(await readFile(targetExport, "utf8"));
    } catch (error) {
      throw new Error("restore_target_export_invalid", { cause: error });
    } finally {
      targetDatabase.close();
    }
    await chmod(targetVerificationDatabase, 0o600);
    const { foreignKeyViolationCount, integrityOk } = verifyLocalIntegrity(targetVerificationDatabase);
    const schemaRows = parseWranglerRows(remoteExecute(
      runner,
      targetName,
      environment,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map((table) => `'${table}'`).join(", ")});`,
      "restore_schema_query_failed",
      runnerOptions,
    ), "restore_schema_invalid");
    const schemaNames = new Set(schemaRows.map((row) => row?.name).filter((name) => typeof name === "string"));
    if (!integrityOk) throw new Error("restore_integrity_failed");
    if (foreignKeyViolationCount !== 0) throw new Error("restore_foreign_keys_failed");
    assertRequiredRestoreTables(schemaNames);
    const completedAt = new Date().toISOString();
    const snapshotRecord = buildBackupSnapshotRecord({
      checksumSha256,
      completedAt,
      createdAt: identifiers.startedAt,
      environment,
      id: identifiers.snapshotId,
      itemCount: sumCounts(sourceCounts),
      requestId: identifiers.requestId,
      resourceRef: target.resourceRef,
      sizeBytes: sourceStat.size,
      snapshotKind: "export",
      status: "available",
      updatedAt: completedAt,
    });
    const drillRecord = buildRestoreDrillRecord({
      backupSnapshotId: identifiers.snapshotId,
      completedAt,
      createdAt: identifiers.startedAt,
      environment: environment === "production" ? "isolated" : environment,
      foreignKeyViolationCount,
      id: identifiers.drillId,
      integrityStatus: "ok",
      requestId: identifiers.requestId,
      restoredItemCount: sumCounts(targetCounts),
      startedAt: identifiers.startedAt,
      status: "passed",
      targetResourceRef: `d1:${targetName}`,
      updatedAt: completedAt,
    });
    outcome = {
      drillRecord,
      snapshotRecord,
      source: {
        account_id: approvedIdentity.accountId,
        database_id: approvedIdentity.databaseId,
        database_name: approvedIdentity.databaseName,
        resource_ref: target.resourceRef,
      },
      verification: {
        foreignKeyViolationCount,
        integrityOk,
        migrationNames: appliedMigrationNames,
        normalizedMigrationAliases: normalizedMigrationLedger.normalizedMigrationAliases,
        crossLedgerMismatchCount,
      },
    };
  } catch (error) {
    operationError = error;
  } finally {
    if (createdTarget) {
      try {
        assertDistinctRestoreTarget(target.databaseName, targetName, environment);
        safeRunner(runner, [
          "d1", "delete", targetName, "--env", environment, "--skip-confirmation",
        ], "restore_cleanup_failed", runnerOptions);
      } catch {
        cleanupFailure = true;
      }
    }
    try {
      await cleanupRestoreTempDirectory(tempDirectory, identifiers.drillId);
    } catch {
      cleanupFailure = true;
    }
  }
  if (cleanupFailure) throw new Error(`restore_cleanup_failed:${targetName}`, { cause: operationError });
  if (operationError !== null) throw operationError;
  return outcome;
}

export async function runRestoreDrill(options) {
  const environment = options.environment;
  const now = options.now ?? new Date();
  if (
    environment !== "local"
    && !options.dryRun
    && !/^[a-f0-9]{40}$/u.test(options.reviewedCommitSha ?? "")
  ) {
    throw new Error("restore_reviewed_commit_required");
  }
  const config = options.config ?? await loadWranglerConfig();
  const target = resolveDatabaseTarget(config, environment);
  if (options.dryRun) return restoreDryRun(environment, target);

  const identifiers = {
    drillId: createOperationId("rdr", now, options.randomBytesImplementation),
    requestId: randomUUID(),
    snapshotId: createOperationId("bkp", now, options.randomBytesImplementation),
    startedAt: now.toISOString(),
  };
  const reportPath = await prepareRestoreReport(environment, identifiers.drillId);
  try {
    const result = environment === "local"
      ? await runLocalRestoreDrill(target, identifiers)
      : await runRemoteRestoreDrill(options, target, identifiers);
    await writePrivateJson(reportPath, {
      records: {
        backup_snapshots: [result.snapshotRecord],
        restore_drills: [result.drillRecord],
      },
      report_version: 1,
      reviewed_commit_sha: options.reviewedCommitSha ?? null,
      source: result.source ?? null,
      verification: result.verification,
    });
    return {
      actions: [
        { code: "isolated_restore_passed", detail: result.drillRecord.target_resource_ref, ok: true },
        { code: "integrity_check", detail: result.drillRecord.integrity_status, ok: true },
        { code: "foreign_key_violations", detail: String(result.drillRecord.foreign_key_violation_count), ok: true },
        { code: "restored_item_count", detail: String(result.drillRecord.restored_item_count), ok: true },
        { code: "temporary_target_removed", detail: "exact_tool_created_target", ok: true },
      ],
      drillId: identifiers.drillId,
      environment,
      ok: true,
      reportRef: relativeReportPath(reportPath),
    };
  } catch (error) {
    const message = error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message)
      ? error.message
      : "restore_drill_failed";
    const failedAt = new Date().toISOString();
    const snapshotRecord = buildBackupSnapshotRecord({
      createdAt: identifiers.startedAt,
      environment,
      id: identifiers.snapshotId,
      lastSafeErrorCode: message,
      requestId: identifiers.requestId,
      resourceRef: target.resourceRef,
      snapshotKind: "export",
      status: "failed",
      updatedAt: failedAt,
    });
    const drillRecord = buildRestoreDrillRecord({
      backupSnapshotId: identifiers.snapshotId,
      createdAt: identifiers.startedAt,
      environment: environment === "local" || environment === "production" ? "isolated" : environment,
      foreignKeyViolationCount: 0,
      id: identifiers.drillId,
      integrityStatus: "failed",
      lastSafeErrorCode: message,
      requestId: identifiers.requestId,
      startedAt: identifiers.startedAt,
      status: "failed",
      targetResourceRef: `isolated:${identifiers.drillId}`,
      updatedAt: failedAt,
    });
    await writePrivateJson(reportPath, {
      records: { backup_snapshots: [snapshotRecord], restore_drills: [drillRecord] },
      report_version: 1,
    });
    throw new Error(message, { cause: error });
  }
}

export const backupPaths = {
  backupRoot: BACKUP_ROOT,
  drillReportRoot: DRILL_REPORT_ROOT,
};
