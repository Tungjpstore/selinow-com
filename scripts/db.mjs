import process from "node:process";

import { runWrangler, writeOutput } from "./lib/cli.mjs";
import { assertFreshStagingBackupEvidence } from "./lib/backup.mjs";
import {
  assertProductionMigrationAdmission,
  parseDatabaseFlags,
  requiresProductionMigrationAdmission,
  requiresStagingDatabaseAdmission,
} from "./lib/db-admission.mjs";
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
} from "./lib/db-preflight.mjs";
import {
  assertStagingMutationAdmission,
  buildPinnedCloudflareEnvironment,
  repositoryRoot,
} from "./lib/platform.mjs";

const operation = process.argv[2];

try {
  if (!new Set(["migrate", "preflight", "seed", "status"]).has(operation)) {
    throw new Error(`unsupported_db_operation:${operation ?? "missing"}`);
  }

  const flags = parseDatabaseFlags(process.argv.slice(3));
  if (flags.environment === "production" && !flags.confirmProduction) {
    throw new Error("production_confirmation_required");
  }

  const targetFlags = flags.environment === "local"
    ? ["--local"]
    : ["--env", flags.environment, "--remote"];
  let wranglerArgs;

  if (operation === "migrate") {
    wranglerArgs = ["d1", "migrations", "apply", "PLATFORM_DB", ...targetFlags];
  } else if (operation === "status") {
    wranglerArgs = ["d1", "migrations", "list", "PLATFORM_DB", ...targetFlags];
  } else if (operation === "preflight") {
    wranglerArgs = ["d1", "execute", "PLATFORM_DB", ...targetFlags, "--command", PHASE7_PREFLIGHT_SQL, "--json"];
  } else {
    wranglerArgs = [
      "d1",
      "execute",
      "PLATFORM_DB",
      ...targetFlags,
      "--file",
      "./seeds/0001_platform_defaults.sql",
    ];
  }

  if (flags.dryRun) {
    const actions = operation === "preflight"
      ? [
          { action: "would_run", name: "phase_7_database_invariants", type: "database" },
          { action: "would_run", name: "legacy_payos_relationship_invariants", type: "database" },
          { action: "would_run", name: "payment_provider_schema_detection", type: "database" },
          { action: "would_run", name: "conditional_payment_provider_invariants", type: "database" },
        ]
      : [{ action: "would_run", name: `wrangler ${wranglerArgs.join(" ")}`, type: "database" }];
    writeOutput({
      actions,
      environment: flags.environment,
      ok: true,
    }, flags.json);
  } else if (operation === "preflight") {
    const baseArgs = ["d1", "execute", "PLATFORM_DB", ...targetFlags, "--command"];
    const phase7 = evaluatePhase7Preflight(parseD1PreflightOutput(
      runWrangler([...baseArgs, PHASE7_PREFLIGHT_SQL, "--json"], { cwd: repositoryRoot }).stdout,
    ));
    const payosRelationships = evaluatePayosRelationshipPreflight(
      parsePayosRelationshipPreflightOutput(
        runWrangler([...baseArgs, PAYOS_RELATIONSHIP_PREFLIGHT_SQL, "--json"], {
          cwd: repositoryRoot,
        }).stdout,
      ),
    );
    const providerSchema = parsePaymentProviderSchemaOutput(
      runWrangler([...baseArgs, PAYMENT_PROVIDER_SCHEMA_SQL, "--json"], { cwd: repositoryRoot }).stdout,
    );
    const provider = providerSchema.applied
      ? evaluatePaymentProviderPreflight(parsePaymentProviderPreflightOutput(
          runWrangler([...baseArgs, PAYMENT_PROVIDER_PREFLIGHT_SQL, "--json"], { cwd: repositoryRoot }).stdout,
        ))
      : {
          checks: [{ code: "payment_provider_projection", detail: "not_applied", ok: true }],
          ok: true,
        };
    const result = {
      checks: [...phase7.checks, ...payosRelationships.checks, ...provider.checks],
      ok: phase7.ok && payosRelationships.ok && provider.ok,
    };
    writeOutput({ ...result, environment: flags.environment }, flags.json);
    if (!result.ok) process.exitCode = 1;
  } else {
    let commandEnvironment = process.env;
    if (requiresProductionMigrationAdmission(operation, flags)) {
      if (!flags.releaseManifestPath) throw new Error("production_release_manifest_required");
      const workerSecretNames = (process.env.SELINOW_WORKER_SECRET_NAMES ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      const productionAdmission = await assertProductionMigrationAdmission({
        environment: process.env,
        manifestPath: flags.releaseManifestPath,
        repositoryRoot,
        workerSecretNames,
      });
      commandEnvironment = buildPinnedCloudflareEnvironment(
        process.env,
        productionAdmission.accountId,
      );
    }
    if (requiresStagingDatabaseAdmission(operation, flags)) {
      const backupAdmission = await assertStagingMutationAdmission();
      await assertFreshStagingBackupEvidence({
        accountId: backupAdmission.accountId,
        databaseId: backupAdmission.databaseId,
        databaseName: backupAdmission.databaseName,
      });
      const finalAdmission = await assertStagingMutationAdmission();
      if (
        finalAdmission.accountId !== backupAdmission.accountId
        || finalAdmission.databaseId !== backupAdmission.databaseId
        || finalAdmission.databaseName !== backupAdmission.databaseName
      ) {
        throw new Error("staging_backup_admission_changed");
      }
      commandEnvironment = buildPinnedCloudflareEnvironment(
        process.env,
        finalAdmission.accountId,
      );
    }
    runWrangler(wranglerArgs, {
      capture: false,
      cwd: repositoryRoot,
      env: commandEnvironment,
    });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown_error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
