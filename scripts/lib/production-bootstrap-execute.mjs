import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  assertExactMigrationLedger,
  assertFreshProductionBootstrapBackupEvidence,
} from "./backup.mjs";
import {
  assertProductionBootstrapSecretNames,
  assertProductionBootstrapSpecIdentity,
} from "./production-bootstrap.mjs";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40,64}$/u;
const CEREMONY_ID_PATTERN = /^bootstrap_[a-z0-9][a-z0-9._-]{7,72}$/u;
const MIGRATION_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/u;
const PLACEHOLDER_PATTERN = /(?:change-me|not-provisioned|placeholder|replace-with|<[^>]+>)/iu;
const RESOURCE_KEYS = [
  "d1",
  "deadLetterQueue",
  "integrationQueue",
  "notificationQueue",
  "platformCacheKv",
  "privateExports",
  "r2",
  "sessionKv",
];
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

export const PRODUCTION_BOOTSTRAP_MIGRATION_TOKEN_NAME = "CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN";

export function requireProductionBootstrapMigrationToken(environment = process.env) {
  const value = environment?.[PRODUCTION_BOOTSTRAP_MIGRATION_TOKEN_NAME];
  const token = typeof value === "string" ? value.trim() : "";
  if (!token) throw new Error("cloudflare_production_bootstrap_migration_api_token_missing");
  return token;
}

export function buildProductionBootstrapMigrationEnvironment(environment, accountId, token) {
  if (!ACCOUNT_ID_PATTERN.test(accountId ?? "")) throw new Error("production_bootstrap_account_invalid");
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("cloudflare_production_bootstrap_migration_api_token_invalid");
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

function configuredReference(value) {
  return typeof value === "string"
    && value.trim().length >= 8
    && value.length <= 240
    && !PLACEHOLDER_PATTERN.test(value);
}

function exactKeys(value, keys, code) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(code);
}

function assertRepositoryState(repositoryState, evidence) {
  exactKeys(repositoryState, ["clean", "commitSha", "treeSha"], "production_bootstrap_repository_state_invalid");
  if (repositoryState.clean !== true) throw new Error("production_bootstrap_source_dirty");
  if (!GIT_OBJECT_PATTERN.test(repositoryState.commitSha ?? "")) {
    throw new Error("production_bootstrap_commit_unavailable");
  }
  if (!GIT_OBJECT_PATTERN.test(repositoryState.treeSha ?? "")) {
    throw new Error("production_bootstrap_tree_unavailable");
  }
  if (evidence?.reviewedCommitSha !== repositoryState.commitSha) {
    throw new Error("production_bootstrap_reviewed_commit_mismatch");
  }
  if (evidence?.reviewedTreeSha !== repositoryState.treeSha) {
    throw new Error("production_bootstrap_reviewed_tree_mismatch");
  }
}

function assertEvidence(evidence, migrationNames, now) {
  const backupCompletedAt = new Date(evidence?.backup?.completedAt ?? "");
  const restoreCompletedAt = new Date(evidence?.backup?.restoreDrillCompletedAt ?? "");
  const nowTimestamp = now.getTime();
  if (
    evidence?.schemaVersion !== 1
    || evidence?.environment !== "production"
    || evidence?.phase !== "resources"
    || !CEREMONY_ID_PATTERN.test(evidence?.ceremonyId ?? "")
    || !configuredReference(evidence?.preBootstrapTrafficSnapshotRef)
    || !configuredReference(evidence?.resourceManifestRef)
    || !configuredReference(evidence?.backup?.snapshotReportRef)
    || evidence?.backup?.providerBookmarkRecorded !== true
    || evidence?.backup?.emptyDatabaseBaselineVerified !== true
    || !configuredReference(evidence?.backup?.restoreDrillReportRef)
    || evidence?.backup?.restoreDrillPassed !== true
    || !Number.isFinite(backupCompletedAt.getTime())
    || !Number.isFinite(restoreCompletedAt.getTime())
    || backupCompletedAt.getTime() > nowTimestamp
    || nowTimestamp - backupCompletedAt.getTime() > 24 * 60 * 60_000
    || restoreCompletedAt.getTime() < backupCompletedAt.getTime()
    || restoreCompletedAt.getTime() > nowTimestamp
    || evidence?.migrations?.direction !== "forward_only"
    || !Array.isArray(evidence?.migrations?.names)
    || evidence?.migrations?.appliedAt !== null
    || evidence?.previousWorkerVersion !== null
    || evidence?.rollback?.strategy !== "restore_pre_bootstrap_traffic_inventory"
    || evidence?.rollback?.snapshotRef !== evidence.preBootstrapTrafficSnapshotRef
    || JSON.stringify(evidence.migrations.names) !== JSON.stringify(migrationNames)
  ) {
    throw new Error("production_bootstrap_migration_evidence_incomplete");
  }
}

function assertGeneratedManifestIdentity(productionSpec, generatedManifest, wranglerConfig) {
  if (
    generatedManifest?.environment !== "production"
    || generatedManifest?.accountId !== productionSpec.accountId
    || generatedManifest?.zoneId !== productionSpec.zoneId
    || generatedManifest?.zoneName !== productionSpec.zoneName
    || generatedManifest?.workerName !== productionSpec.workerName
    || typeof generatedManifest?.version !== "string"
    || !/^[a-f0-9]{16,64}$/u.test(generatedManifest.version)
  ) {
    throw new Error("production_bootstrap_generated_manifest_invalid");
  }
  exactKeys(generatedManifest.resources, RESOURCE_KEYS, "production_bootstrap_generated_manifest_invalid");
  for (const key of RESOURCE_KEYS) {
    const resource = generatedManifest.resources[key];
    if (
      typeof resource !== "object"
      || resource === null
      || resource.name !== productionSpec.resources[key]
      || (key === "d1" && !UUID_PATTERN.test(resource.id ?? ""))
      || (["platformCacheKv", "sessionKv"].includes(key) && !ACCOUNT_ID_PATTERN.test(resource.id ?? ""))
    ) {
      throw new Error(`production_bootstrap_generated_resource_mismatch:${key}`);
    }
  }

  const production = wranglerConfig?.env?.production;
  const d1Bindings = Array.isArray(production?.d1_databases)
    ? production.d1_databases.filter((database) => database?.binding === "PLATFORM_DB")
    : [];
  if (
    production?.name !== productionSpec.workerName
    || d1Bindings.length !== 1
    || d1Bindings[0]?.database_name !== productionSpec.resources.d1
    || d1Bindings[0]?.database_id !== generatedManifest.resources.d1.id
    || d1Bindings[0]?.migrations_dir !== "./migrations"
  ) {
    throw new Error("production_bootstrap_database_binding_mismatch");
  }
  return {
    databaseId: generatedManifest.resources.d1.id,
    databaseName: generatedManifest.resources.d1.name,
  };
}

function assertLiveIdentity(expected, liveIdentity) {
  if (
    liveIdentity?.accountId !== expected.accountId
    || liveIdentity?.databaseId !== expected.databaseId
    || liveIdentity?.databaseName !== expected.databaseName
  ) {
    throw new Error("production_bootstrap_live_identity_mismatch");
  }
}

function assertLiveResourceInventory(productionSpec, generatedManifest, liveIdentity) {
  const inventory = liveIdentity?.resources;
  if (
    typeof inventory !== "object"
    || inventory === null
    || !Array.isArray(inventory.d1)
    || !Array.isArray(inventory.kv)
    || !Array.isArray(inventory.queue)
    || !Array.isArray(inventory.r2)
  ) {
    throw new Error("production_bootstrap_live_resource_inventory_unavailable");
  }
  try {
    assertProductionBootstrapSecretNames(liveIdentity.secretNames);
  } catch {
    throw new Error("production_bootstrap_live_secret_inventory_incomplete");
  }
  const expected = {
    d1: { id: generatedManifest.resources.d1.id, name: productionSpec.resources.d1 },
    kv: [
      { id: generatedManifest.resources.platformCacheKv.id, name: productionSpec.resources.platformCacheKv },
      { id: generatedManifest.resources.sessionKv.id, name: productionSpec.resources.sessionKv },
    ],
    queue: [
      { name: productionSpec.resources.deadLetterQueue },
      { name: productionSpec.resources.integrationQueue },
      { name: productionSpec.resources.notificationQueue },
    ],
    r2: [
      { name: productionSpec.resources.privateExports },
      { name: productionSpec.resources.r2 },
    ],
  };
  const d1Matches = inventory.d1.filter((resource) => resource?.name === expected.d1.name);
  if (d1Matches.length !== 1 || d1Matches[0]?.id !== expected.d1.id) {
    throw new Error("production_bootstrap_live_resource_identity_mismatch");
  }
  for (const resource of expected.kv) {
    const matches = inventory.kv.filter((candidate) => candidate?.name === resource.name);
    if (matches.length !== 1 || matches[0]?.id !== resource.id) {
      throw new Error(`production_bootstrap_live_resource_identity_mismatch:${resource.name}`);
    }
  }
  for (const resource of expected.queue) {
    const matches = inventory.queue.filter((candidate) => candidate?.name === resource.name);
    if (matches.length !== 1) {
      throw new Error(`production_bootstrap_live_resource_identity_mismatch:${resource.name}`);
    }
  }
  for (const resource of expected.r2) {
    const matches = inventory.r2.filter((candidate) => candidate?.name === resource.name);
    if (matches.length !== 1) {
      throw new Error(`production_bootstrap_live_resource_identity_mismatch:${resource.name}`);
    }
  }
}

function assertBackupEvidencePair(evidence, backupEvidence, restoreEvidence) {
  if (
    backupEvidence?.reportRef !== evidence?.backup?.snapshotReportRef
    || backupEvidence?.completedAt !== evidence?.backup?.completedAt
    || backupEvidence?.providerBookmarkRecorded !== true
    || restoreEvidence?.reportRef !== evidence?.backup?.restoreDrillReportRef
    || restoreEvidence?.completedAt !== evidence?.backup?.restoreDrillCompletedAt
    || restoreEvidence?.status !== "passed"
  ) {
    throw new Error("production_bootstrap_backup_restore_evidence_mismatch");
  }
}

async function readRestoreEvidence(input) {
  const reportRef = input?.evidence?.backup?.restoreDrillReportRef;
  const root = resolve(input?.repositoryRoot ?? process.cwd());
  const prefix = ".wrangler/restore-drills/production-bootstrap-empty-baseline/";
  if (typeof reportRef !== "string" || !reportRef.startsWith(prefix)) {
    throw new Error("production_bootstrap_restore_drill_report_invalid");
  }
  const reportPath = resolve(root, reportRef);
  if (!reportPath.startsWith(`${resolve(root, ".wrangler/restore-drills/production-bootstrap-empty-baseline")}/`)) {
    throw new Error("production_bootstrap_restore_drill_report_invalid");
  }
  let report;
  let reportStat;
  try {
    [report, reportStat] = await Promise.all([
      readFile(reportPath, "utf8").then((value) => JSON.parse(value)),
      lstat(reportPath),
    ]);
  } catch {
    throw new Error("production_bootstrap_restore_drill_report_invalid");
  }
  if (!reportStat.isFile() || (reportStat.mode & 0o077) !== 0) {
    throw new Error("production_bootstrap_restore_drill_report_permissions_invalid");
  }
  if (
    report?.report_version !== 2
    || report?.environment !== "production"
    || report?.mode !== "empty_baseline"
    || report?.status !== "passed"
    || report?.source?.account_id !== input.productionSpec.accountId
    || report?.source?.database_id !== input.generatedManifest.resources.d1.id
    || report?.source?.database_name !== input.productionSpec.resources.d1
    || report?.backup?.report_ref !== input.evidence.backup.snapshotReportRef
    || report?.backup?.completed_at !== input.evidence.backup.completedAt
    || report?.target?.deleted !== true
    || report?.verification?.applicationTableCount !== 0
    || report?.verification?.migrationLedgerCount !== 0
    || report?.verification?.foreignKeyViolationCount !== 0
    || !["ok", "remote_pragma_unavailable"].includes(report?.verification?.integrityStatus)
    || report?.updated_at !== input.evidence.backup.restoreDrillCompletedAt
  ) {
    throw new Error("production_bootstrap_restore_drill_evidence_invalid");
  }
  return {
    completedAt: report.updated_at,
    reportRef,
    status: report.status,
  };
}

function assertLiveEmptyBaseline(liveIdentity) {
  if (
    !Array.isArray(liveIdentity?.applicationTableNames)
    || liveIdentity.applicationTableNames.length !== 0
    || !Array.isArray(liveIdentity?.migrationNames)
    || liveIdentity.migrationNames.length !== 0
  ) {
    throw new Error("production_bootstrap_live_database_not_empty");
  }
}

function assertLiveMigrationLedger(liveIdentity, migrationNames) {
  if (!Array.isArray(liveIdentity?.migrationNames)) {
    throw new Error("production_bootstrap_migration_ledger_unavailable");
  }
  try {
    assertExactMigrationLedger(liveIdentity.migrationNames, migrationNames);
  } catch {
    throw new Error("production_bootstrap_migration_ledger_incomplete");
  }
}

export function parseProductionBootstrapExecuteFlags(argv) {
  let dryRunRequested = false;
  let executeRequested = false;
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
    }
    else if (argument === "--execute") {
      executeRequested = true;
      flags.execute = true;
      flags.dryRun = false;
    } else if (argument === "--json") flags.json = true;
    else if (argument === "--env") flags.environment = argv[++index] ?? "";
    else if (argument.startsWith("--env=")) flags.environment = argument.slice("--env=".length);
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (flags.environment !== "production") throw new Error("production_bootstrap_environment_required");
  if (dryRunRequested && executeRequested) throw new Error("production_bootstrap_mode_conflict");
  if (flags.execute && !flags.confirmProduction) throw new Error("production_confirmation_required");
  if (flags.execute && !flags.confirmFirstProductionBootstrap) {
    throw new Error("production_first_bootstrap_confirmation_required");
  }
  return flags;
}

export function validateProductionBootstrapMigrationAdmission(input) {
  if (input.releaseManifestPath !== undefined && input.releaseManifestPath !== null) {
    throw new Error("production_bootstrap_release_manifest_forbidden");
  }
  assertProductionBootstrapSpecIdentity(input.productionSpec);
  assertRepositoryState(input.repositoryState, input.evidence);
  const secretNames = assertProductionBootstrapSecretNames(input.secretNames);
  const migrationNames = [...input.migrationNames].sort();
  if (migrationNames.some((name) => !MIGRATION_PATTERN.test(name))) {
    throw new Error("production_bootstrap_migration_inventory_invalid");
  }
  assertEvidence(input.evidence, migrationNames, input.now);
  const target = assertGeneratedManifestIdentity(
    input.productionSpec,
    input.generatedManifest,
    input.wranglerConfig,
  );
  if (input.liveIdentity !== undefined && input.liveIdentity !== null) {
    assertLiveIdentity({ accountId: input.productionSpec.accountId, ...target }, input.liveIdentity);
    assertLiveResourceInventory(input.productionSpec, input.generatedManifest, input.liveIdentity);
  }
  return {
    accountId: input.productionSpec.accountId,
    databaseId: target.databaseId,
    databaseName: target.databaseName,
    migrationNames,
    secretNameCount: secretNames.length,
  };
}

export async function runProductionBootstrapMigrations(input) {
  if (!input.dryRun && input.confirmProduction !== true) {
    throw new Error("production_confirmation_required");
  }
  if (!input.dryRun && input.confirmFirstProductionBootstrap !== true) {
    throw new Error("production_first_bootstrap_confirmation_required");
  }
  const staticInput = { ...input, liveIdentity: undefined };
  const admission = validateProductionBootstrapMigrationAdmission(staticInput);
  if (input.dryRun) {
    return {
      actions: [
        { code: "backup_evidence_required", detail: "fresh_production_report_v2", ok: true },
        { code: "database_forward_only_migrations", detail: "wrangler d1 migrations apply", ok: true },
      ],
      databaseName: admission.databaseName,
      environment: "production",
      executed: false,
      migrationNames: admission.migrationNames,
      ok: true,
    };
  }

  const migrationToken = requireProductionBootstrapMigrationToken(input.operatorEnvironment ?? process.env);
  const commandEnvironment = buildProductionBootstrapMigrationEnvironment(
    input.operatorEnvironment ?? process.env,
    admission.accountId,
    migrationToken,
  );

  const backupEvidence = await (input.backupEvidenceImplementation ?? assertFreshProductionBootstrapBackupEvidence)({
    accountId: admission.accountId,
    backupRoot: input.backupRoot,
    databaseId: admission.databaseId,
    databaseName: admission.databaseName,
    now: input.now,
  });
  const restoreEvidence = await (input.restoreEvidenceImplementation ?? readRestoreEvidence)(input);
  assertBackupEvidencePair(input.evidence, backupEvidence, restoreEvidence);
  const identityImplementation = input.identityImplementation;
  if (identityImplementation === undefined) throw new Error("production_bootstrap_live_identity_unavailable");
  const initialIdentity = await identityImplementation(commandEnvironment);
  assertLiveIdentity({ accountId: admission.accountId, databaseId: admission.databaseId, databaseName: admission.databaseName }, initialIdentity);
  assertLiveResourceInventory(input.productionSpec, input.generatedManifest, initialIdentity);
  assertLiveEmptyBaseline(initialIdentity);

  const runner = input.runWranglerImplementation;
  if (runner === undefined) throw new Error("production_bootstrap_migration_runner_unavailable");
  runner([
    "d1",
    "migrations",
    "apply",
    "PLATFORM_DB",
    "--remote",
    "--env",
    "production",
  ], {
    cwd: input.repositoryRoot,
    env: commandEnvironment,
  });

  const finalIdentity = await identityImplementation(commandEnvironment);
  assertLiveIdentity({ accountId: admission.accountId, databaseId: admission.databaseId, databaseName: admission.databaseName }, finalIdentity);
  assertLiveResourceInventory(input.productionSpec, input.generatedManifest, finalIdentity);
  assertLiveMigrationLedger(finalIdentity, admission.migrationNames);
  return {
    actions: [
      { code: "backup_evidence_verified", detail: backupEvidence.reportRef, ok: true },
      { code: "live_identity_verified", detail: admission.databaseName, ok: true },
      { code: "database_forward_only_migrations_applied", detail: `${admission.migrationNames.length} migrations`, ok: true },
      { code: "live_identity_rechecked", detail: admission.databaseName, ok: true },
    ],
    databaseName: admission.databaseName,
    environment: "production",
    executed: true,
    migrationNames: admission.migrationNames,
    ok: true,
  };
}
