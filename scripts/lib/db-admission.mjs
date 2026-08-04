import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  assertFreshProductionContinuationEvidence,
  resolveDatabaseTarget,
} from "./backup.mjs";
import { parseFlags, runWrangler } from "./cli.mjs";
import {
  evaluatePaymentProviderPreflight,
  evaluatePayosRelationshipPreflight,
  evaluatePhase7Preflight,
  parseD1PreflightOutput,
  parsePaymentProviderPreflightOutput,
  parsePaymentProviderSchemaOutput,
  parsePayosRelationshipPreflightOutput,
  PAYMENT_PROVIDER_PREFLIGHT_SQL,
  PAYMENT_PROVIDER_SCHEMA_SQL,
  PAYOS_RELATIONSHIP_PREFLIGHT_SQL,
  PHASE7_PREFLIGHT_SQL,
} from "./db-preflight.mjs";
import { buildPinnedCloudflareEnvironment, repositoryRoot } from "./platform.mjs";
import { assertProductionDeployAdmission, listMigrationNames, readOptionalJson } from "./release.mjs";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;

export function parseDatabaseFlags(argv) {
  const commonArgv = [];
  let releaseManifestPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--release-manifest") {
      if (releaseManifestPath !== null) throw new Error("production_release_manifest_duplicate");
      releaseManifestPath = argv[++index] ?? "";
    } else if (argument.startsWith("--release-manifest=")) {
      if (releaseManifestPath !== null) throw new Error("production_release_manifest_duplicate");
      releaseManifestPath = argument.slice("--release-manifest=".length);
    } else {
      commonArgv.push(argument);
    }
  }
  if (releaseManifestPath !== null && releaseManifestPath.length === 0) {
    throw new Error("production_release_manifest_path_invalid");
  }
  return { ...parseFlags(commonArgv), releaseManifestPath };
}

export function requiresProductionMigrationAdmission(operation, flags) {
  return new Set(["migrate", "seed"]).has(operation)
    && flags.environment === "production"
    && !flags.dryRun;
}

export function requiresStagingDatabaseAdmission(operation, flags) {
  return new Set(["migrate", "seed"]).has(operation)
    && flags.environment === "staging"
    && !flags.dryRun;
}

export function requiresStagingReleaseManifest(operation, flags) {
  return requiresStagingDatabaseAdmission(operation, flags) && flags.releaseManifestPath === null;
}

export function resolveApprovedProductionDatabaseTarget(input) {
  if (input.productionSpec?.environment !== "production") {
    throw new Error("production_database_spec_invalid");
  }
  const accountId = input.productionSpec?.accountId;
  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("production_account_identity_invalid");
  }
  const target = resolveDatabaseTarget(input.wranglerConfig, "production");
  if (input.productionSpec?.resources?.d1 !== target.databaseName) {
    throw new Error("production_database_target_mismatch");
  }
  return { accountId, target };
}

export function assertProductionAccountIdentity(whoamiOutput, accountId) {
  const observed = String(whoamiOutput ?? "")
    .match(/(?<![a-f0-9])[a-f0-9]{32}(?![a-f0-9])/giu)
    ?.map((value) => value.toLowerCase()) ?? [];
  if (!observed.includes(accountId.toLowerCase())) {
    throw new Error("production_account_identity_mismatch");
  }
}

export function assertProductionDatabaseIdentity(d1ListOutput, databaseId, databaseName) {
  let databases;
  try {
    databases = JSON.parse(String(d1ListOutput ?? ""));
  } catch {
    throw new Error("production_database_identity_invalid");
  }
  if (!Array.isArray(databases)) {
    throw new Error("production_database_identity_invalid");
  }

  const rows = databases.map((database) => ({
    id: database?.uuid,
    name: database?.name,
  }));
  if (rows.some((database) => (
    typeof database.id !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(database.id)
      || typeof database.name !== "string"
      || database.name.length < 1
      || database.name.length > 128
  ))) {
    throw new Error("production_database_identity_invalid");
  }

  const matchingNames = rows.filter((database) => database.name === databaseName);
  if (matchingNames.length !== 1 || matchingNames[0]?.id !== databaseId) {
    throw new Error("production_database_identity_mismatch");
  }
}

export function parseProductionMigrationLedgerOutput(output) {
  let payload;
  try {
    payload = JSON.parse(String(output ?? ""));
  } catch {
    throw new Error("production_migration_ledger_invalid_json");
  }
  const envelopes = Array.isArray(payload) ? payload : [payload];
  if (envelopes.length === 0 || envelopes.some((envelope) => (
    envelope?.success !== true || !Array.isArray(envelope?.results)
  ))) {
    throw new Error("production_migration_ledger_invalid_result");
  }
  const names = envelopes.flatMap((envelope) => envelope.results).map((row) => row?.name);
  if (names.some((name) => typeof name !== "string") || new Set(names).size !== names.length) {
    throw new Error("production_migration_ledger_invalid_result");
  }
  return names;
}

async function readProductionMigrationLedger(input = {}) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const runner = input.runWranglerImplementation ?? runWrangler;
  try {
    return parseProductionMigrationLedgerOutput(runner([
      "d1", "execute", "PLATFORM_DB", "--env", "production", "--remote",
      "--command", "SELECT name FROM d1_migrations ORDER BY name;", "--json",
    ], { cwd: root, env: input.environment }).stdout);
  } catch {
    throw new Error("production_migration_ledger_unavailable");
  }
}

export async function assertProductionMigrationLedgerPrefix(input = {}) {
  const expected = input.migrationNames ?? await listMigrationNames(input.repositoryRoot ?? repositoryRoot);
  const expectedPrefix = input.expectedPrefix;
  if (expectedPrefix !== undefined && (
    !Array.isArray(expectedPrefix)
    || expectedPrefix.length === 0
    || expectedPrefix.length > expected.length
    || expectedPrefix.some((name, index) => name !== expected[index])
  )) {
    throw new Error("production_migration_ledger_baseline_invalid");
  }
  const observed = await readProductionMigrationLedger(input);
  if (observed.length === 0
    || observed.length > expected.length
    || observed.some((name, index) => name !== expected[index])
    || (expectedPrefix !== undefined && (
      observed.length !== expectedPrefix.length
      || observed.some((name, index) => name !== expectedPrefix[index])
    ))) {
    throw new Error("production_migration_ledger_prefix_invalid");
  }
  return { migrationNames: observed };
}

export async function assertProductionMigrationLedger(input = {}) {
  const expected = input.migrationNames ?? await listMigrationNames(input.repositoryRoot ?? repositoryRoot);
  const observed = await readProductionMigrationLedger(input);
  if (observed.length !== expected.length || observed.some((name, index) => name !== expected[index])) {
    throw new Error("production_migration_ledger_incomplete");
  }
  return { migrationNames: observed };
}

export function assertProductionDatabasePreflight(input = {}) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const runner = input.runWranglerImplementation ?? runWrangler;
  const environment = input.environment;
  const baseArgs = ["d1", "execute", "PLATFORM_DB", "--env", "production", "--remote", "--command"];
  try {
    const phase7 = evaluatePhase7Preflight(parseD1PreflightOutput(
      runner([...baseArgs, PHASE7_PREFLIGHT_SQL, "--json"], { cwd: root, env: environment }).stdout,
    ));
    const payosRelationships = evaluatePayosRelationshipPreflight(parsePayosRelationshipPreflightOutput(
      runner([...baseArgs, PAYOS_RELATIONSHIP_PREFLIGHT_SQL, "--json"], { cwd: root, env: environment }).stdout,
    ));
    const providerSchema = parsePaymentProviderSchemaOutput(
      runner([...baseArgs, PAYMENT_PROVIDER_SCHEMA_SQL, "--json"], { cwd: root, env: environment }).stdout,
    );
    if (input.requirePaymentProviderSchema === true && !providerSchema.applied) {
      throw new Error("production_database_preflight_failed");
    }
    const provider = providerSchema.applied
      ? evaluatePaymentProviderPreflight(parsePaymentProviderPreflightOutput(
        runner([...baseArgs, PAYMENT_PROVIDER_PREFLIGHT_SQL, "--json"], { cwd: root, env: environment }).stdout,
      ))
      : { checks: [{ code: "payment_provider_projection", detail: "not_applied", ok: true }], ok: true };
    const result = {
      checks: [...phase7.checks, ...payosRelationships.checks, ...provider.checks],
      ok: phase7.ok && payosRelationships.ok && provider.ok,
    };
    if (!result.ok) throw new Error("production_database_preflight_failed");
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "production_database_preflight_failed") throw error;
    throw new Error("production_database_preflight_failed", { cause: error });
  }
}

export async function assertProductionMigrationAdmission(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const releaseAdmission = input.assertReleaseAdmissionImplementation
    ?? assertProductionDeployAdmission;
  const runner = input.runWranglerImplementation ?? runWrangler;
  const operatorEnvironment = input.environment ?? process.env;
  const releaseInput = {
    manifestPath: input.manifestPath,
    repositoryRoot: root,
    workerSecretNames: input.workerSecretNames,
  };

  const initialAdmission = await releaseAdmission(releaseInput);
  const [wranglerConfig, productionSpec] = await Promise.all([
    input.wranglerConfig === undefined
      ? readFile(resolve(root, "wrangler.jsonc"), "utf8").then((text) => JSON.parse(text))
      : input.wranglerConfig,
    input.productionSpec === undefined
      ? readOptionalJson(resolve(root, "infra/environments/production.json"))
      : input.productionSpec,
  ]);
  if (productionSpec === null) throw new Error("production_spec_missing");
  const approved = resolveApprovedProductionDatabaseTarget({ productionSpec, wranglerConfig });
  const continuationEvidenceImplementation = input.assertContinuationEvidenceImplementation
    ?? assertFreshProductionContinuationEvidence;
  const initialContinuationEvidence = await continuationEvidenceImplementation({
    accountId: approved.accountId,
    databaseId: approved.target.databaseId,
    databaseName: approved.target.databaseName,
    repositoryRoot: root,
    reviewedCommitSha: initialAdmission.commitSha,
  });
  const runnerOptions = {
    cwd: root,
    env: buildPinnedCloudflareEnvironment(operatorEnvironment, approved.accountId),
  };
  const migrationNames = input.migrationNames ?? await listMigrationNames(root);
  const operation = input.operation ?? "migrate";
  const assertLedgerPrefix = input.assertMigrationLedgerPrefixImplementation
    ?? assertProductionMigrationLedgerPrefix;
  const assertLedgerComplete = input.assertMigrationLedgerImplementation
    ?? assertProductionMigrationLedger;
  const assertPreflight = input.assertDatabasePreflightImplementation
    ?? assertProductionDatabasePreflight;
  let whoami;
  try {
    whoami = runner(["whoami", "--json"], runnerOptions).stdout;
  } catch {
    throw new Error("production_account_identity_unavailable");
  }
  assertProductionAccountIdentity(whoami, approved.accountId);
  let d1List;
  try {
    d1List = runner(["d1", "list", "--env", "production", "--json"], runnerOptions).stdout;
  } catch {
    throw new Error("production_database_identity_unavailable");
  }
  assertProductionDatabaseIdentity(d1List, approved.target.databaseId, approved.target.databaseName);

  const expectedPrefix = initialAdmission.migrationLedgerPrefix;
  const initialLedger = operation === "seed"
    ? await assertLedgerComplete({ environment: runnerOptions.env, migrationNames, repositoryRoot: root, runWranglerImplementation: runner })
    : await assertLedgerPrefix({ environment: runnerOptions.env, expectedPrefix, migrationNames, repositoryRoot: root, runWranglerImplementation: runner });
  assertPreflight({ environment: runnerOptions.env, repositoryRoot: root, requirePaymentProviderSchema: true, runWranglerImplementation: runner });

  // Recheck the local release permit after the provider identity lookup and
  // immediately before the caller crosses into the migration subprocess.
  const finalAdmission = await releaseAdmission(releaseInput);
  if (initialAdmission.releaseId !== finalAdmission.releaseId
    || initialAdmission.commitSha !== finalAdmission.commitSha
    || JSON.stringify(initialAdmission.migrationLedgerPrefix) !== JSON.stringify(finalAdmission.migrationLedgerPrefix)) {
    throw new Error("production_release_admission_changed");
  }
  const finalContinuationEvidence = await continuationEvidenceImplementation({
    accountId: approved.accountId,
    databaseId: approved.target.databaseId,
    databaseName: approved.target.databaseName,
    repositoryRoot: root,
    reviewedCommitSha: finalAdmission.commitSha,
  });
  if (
    initialContinuationEvidence.backup.snapshotId !== finalContinuationEvidence.backup.snapshotId
    || initialContinuationEvidence.backup.checksumSha256 !== finalContinuationEvidence.backup.checksumSha256
    || initialContinuationEvidence.restore.reportRef !== finalContinuationEvidence.restore.reportRef
    || initialContinuationEvidence.restore.snapshotId !== finalContinuationEvidence.restore.snapshotId
  ) {
    throw new Error("production_continuation_evidence_changed");
  }
  const finalLedger = operation === "seed"
    ? await assertLedgerComplete({ environment: runnerOptions.env, migrationNames, repositoryRoot: root, runWranglerImplementation: runner })
    : await assertLedgerPrefix({ environment: runnerOptions.env, expectedPrefix, migrationNames, repositoryRoot: root, runWranglerImplementation: runner });
  if (finalLedger.migrationNames.length !== initialLedger.migrationNames.length
    || finalLedger.migrationNames.some((name, index) => name !== initialLedger.migrationNames[index])) {
    throw new Error("production_migration_ledger_changed");
  }
  assertPreflight({ environment: runnerOptions.env, repositoryRoot: root, requirePaymentProviderSchema: true, runWranglerImplementation: runner });
  return {
    accountId: approved.accountId,
    commitSha: finalAdmission.commitSha,
    databaseId: approved.target.databaseId,
    databaseName: approved.target.databaseName,
    releaseId: finalAdmission.releaseId,
  };
}
