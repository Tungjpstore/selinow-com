import process from "node:process";

import { runWrangler, writeOutput } from "./lib/cli.mjs";
import {
  assertFreshStagingContinuationEvidence,
  assertStagingContinuationEvidenceByReference,
} from "./lib/backup.mjs";
import {
  assertProductionDatabasePreflight,
  assertProductionMigrationLedger,
  assertProductionMigrationAdmission,
  parseDatabaseFlags,
  requiresMaintenanceDrainConfirmation,
  requiresProductionMigrationAdmission,
  requiresStagingDatabaseAdmission,
} from "./lib/db-admission.mjs";
import { assertRemotePostMigrationContract } from "./lib/db-post-migration-contract.mjs";
import { assertProductionDatabaseInvariantContract } from "./lib/release.mjs";
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
import {
  assertStagingContinuationBinding,
  assertStagingMigrationLedger,
  assertStagingDatabasePreflight,
  assertStagingMigrationCompletion,
  assertStagingPostMigrationEvidence,
  assertStagingReleaseAdmission,
  buildStagingMigrationCompletion,
  buildStagingPostMigrationEvidence,
  runStagingMigrationWithVerification,
  writeStagingMigrationCompletion,
  writeStagingPostMigrationEvidence,
} from "./lib/staging-release.mjs";

const operation = process.argv[2];

function databaseTargetFromAdmission(admission) {
  return {
    accountId: admission.accountId,
    databaseId: admission.databaseId,
    databaseName: admission.databaseName,
  };
}

try {
  if (!new Set(["complete-release", "migrate", "preflight", "seed", "status"]).has(operation)) {
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
  let stagingMigrationHandled = false;
  let stagingMigrationLedger = null;

  if (operation === "complete-release") {
    if (flags.environment !== "staging") throw new Error("staging_release_completion_environment_invalid");
    wranglerArgs = null;
  } else if (operation === "migrate") {
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

  if (operation === "complete-release") {
    if (!flags.releaseManifestPath) throw new Error("staging_release_manifest_required");
    if (flags.dryRun) {
      writeOutput({
        actions: [{ action: "would_write", name: "post-migration-evidence.json", type: "release_evidence" }],
        environment: "staging",
        ok: true,
      }, flags.json);
    } else {
      const releaseAdmission = await assertStagingReleaseAdmission({
        manifestPath: flags.releaseManifestPath,
        repositoryRoot,
      });
      const databaseTarget = databaseTargetFromAdmission(await assertStagingMutationAdmission());
      const preMigrationEvidence = await assertStagingContinuationEvidenceByReference({
        accountId: databaseTarget.accountId,
        continuationEvidence: releaseAdmission.continuationEvidence,
        databaseId: databaseTarget.databaseId,
        databaseName: databaseTarget.databaseName,
        evidenceRecordedAt: releaseAdmission.createdAt,
        repositoryRoot,
        reviewedCommitSha: releaseAdmission.commitSha,
      });
      assertStagingContinuationBinding(releaseAdmission, preMigrationEvidence, databaseTarget);
      const commandEnvironment = buildPinnedCloudflareEnvironment(process.env, databaseTarget.accountId);
      const migrationAdmission = await assertStagingMigrationLedger({
        environment: commandEnvironment,
        migrationNames: releaseAdmission.migrationNames,
        repositoryRoot,
      });
      assertStagingDatabasePreflight({ environment: commandEnvironment, repositoryRoot });
      assertRemotePostMigrationContract({
        environment: commandEnvironment,
        environmentName: "staging",
        repositoryRoot,
      });
      assertProductionDatabaseInvariantContract({
        environment: commandEnvironment,
        environmentName: "staging",
        migrationNames: migrationAdmission.migrationNames,
        repositoryRoot,
      });
      const migrationCompletion = await assertStagingMigrationCompletion({
        databaseTarget,
        migrationNames: migrationAdmission.migrationNames,
        releaseAdmission,
        repositoryRoot,
      });
      const postMigrationContinuation = await assertFreshStagingContinuationEvidence({
        accountId: databaseTarget.accountId,
        databaseId: databaseTarget.databaseId,
        databaseName: databaseTarget.databaseName,
        repositoryRoot,
        reviewedCommitSha: releaseAdmission.commitSha,
      });
      const postMigrationEvidence = buildStagingPostMigrationEvidence({
        continuationEvidence: postMigrationContinuation,
        databaseTarget,
        migrationCompletion,
        migrationNames: migrationAdmission.migrationNames,
        releaseAdmission,
      });
      const evidenceRef = await writeStagingPostMigrationEvidence(postMigrationEvidence, repositoryRoot);
      await assertStagingPostMigrationEvidence({
        continuationEvidence: postMigrationContinuation,
        databaseTarget,
        migrationCompletion,
        migrationNames: migrationAdmission.migrationNames,
        releaseAdmission,
        repositoryRoot,
      });
      writeOutput({
        actions: [{ code: "post_migration_evidence_written", detail: evidenceRef, ok: true }],
        environment: "staging",
        ok: true,
      }, flags.json);
    }
  } else if (flags.dryRun) {
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
      if (requiresMaintenanceDrainConfirmation(operation, flags)) {
        throw new Error("maintenance_drain_confirmation_required");
      }
      const workerSecretNames = (process.env.SELINOW_WORKER_SECRET_NAMES ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      const productionAdmission = await assertProductionMigrationAdmission({
        environment: process.env,
        manifestPath: flags.releaseManifestPath,
        operation,
        repositoryRoot,
        workerSecretNames,
      });
      commandEnvironment = buildPinnedCloudflareEnvironment(
        process.env,
        productionAdmission.accountId,
      );
    }
    if (requiresStagingDatabaseAdmission(operation, flags)) {
      if (!flags.releaseManifestPath) throw new Error("staging_release_manifest_required");
      if (requiresMaintenanceDrainConfirmation(operation, flags)) {
        throw new Error("maintenance_drain_confirmation_required");
      }
      const releaseAdmission = await assertStagingReleaseAdmission({
        manifestPath: flags.releaseManifestPath,
        repositoryRoot,
      });
      const backupAdmission = await assertStagingMutationAdmission();
      const continuationAdmission = await assertStagingContinuationEvidenceByReference({
        accountId: backupAdmission.accountId,
        continuationEvidence: releaseAdmission.continuationEvidence,
        databaseId: backupAdmission.databaseId,
        databaseName: backupAdmission.databaseName,
        evidenceRecordedAt: releaseAdmission.createdAt,
        repositoryRoot,
        reviewedCommitSha: releaseAdmission.commitSha,
      });
      assertStagingContinuationBinding(releaseAdmission, continuationAdmission, backupAdmission);
      const finalAdmission = await assertStagingMutationAdmission();
      if (
        finalAdmission.accountId !== backupAdmission.accountId
        || finalAdmission.databaseId !== backupAdmission.databaseId
        || finalAdmission.databaseName !== backupAdmission.databaseName
      ) {
        throw new Error("staging_backup_admission_changed");
      }
      const finalReleaseAdmission = await assertStagingReleaseAdmission({
        manifestPath: flags.releaseManifestPath,
        repositoryRoot,
      });
      const finalContinuationAdmission = await assertStagingContinuationEvidenceByReference({
        accountId: finalAdmission.accountId,
        continuationEvidence: finalReleaseAdmission.continuationEvidence,
        databaseId: finalAdmission.databaseId,
        databaseName: finalAdmission.databaseName,
        evidenceRecordedAt: finalReleaseAdmission.createdAt,
        repositoryRoot,
        reviewedCommitSha: finalReleaseAdmission.commitSha,
      });
      assertStagingContinuationBinding(finalReleaseAdmission, finalContinuationAdmission, finalAdmission);
      if (
        finalReleaseAdmission.commitSha !== releaseAdmission.commitSha
        || finalReleaseAdmission.treeSha !== releaseAdmission.treeSha
        || finalReleaseAdmission.releaseId !== releaseAdmission.releaseId
        || finalContinuationAdmission.backup.snapshotId !== continuationAdmission.backup.snapshotId
        || finalContinuationAdmission.restore.reportRef !== continuationAdmission.restore.reportRef
        || finalReleaseAdmission.migrationLedgerPrefix.length !== releaseAdmission.migrationLedgerPrefix.length
        || finalReleaseAdmission.migrationLedgerPrefix.some((name, index) => name !== releaseAdmission.migrationLedgerPrefix[index])
      ) {
        throw new Error("staging_release_admission_changed");
      }
      commandEnvironment = buildPinnedCloudflareEnvironment(
        process.env,
        finalAdmission.accountId,
      );
      if (operation === "migrate") {
        await runStagingMigrationWithVerification({
          environment: commandEnvironment,
          expectedPrefix: finalReleaseAdmission.migrationLedgerPrefix,
          migrationNames: finalReleaseAdmission.migrationNames,
          repositoryRoot,
          assertPostMigrationContractImplementation: (shared) => {
            assertRemotePostMigrationContract({
              environment: shared.environment,
              environmentName: "staging",
              repositoryRoot,
            });
            assertProductionDatabaseInvariantContract({
              environment: shared.environment,
              environmentName: "staging",
              migrationNames: shared.migrationNames,
              repositoryRoot,
            });
          },
          runMigrationImplementation: () => runWrangler(wranglerArgs, {
            capture: false,
            cwd: repositoryRoot,
            env: commandEnvironment,
          }),
        });
        let migrationCompletion;
        try {
          migrationCompletion = await assertStagingMigrationCompletion({
            databaseTarget: databaseTargetFromAdmission(finalAdmission),
            migrationNames: finalReleaseAdmission.migrationNames,
            releaseAdmission: finalReleaseAdmission,
            repositoryRoot,
          });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "staging_migration_completion_missing") throw error;
          migrationCompletion = buildStagingMigrationCompletion({
            databaseTarget: databaseTargetFromAdmission(finalAdmission),
            migrationNames: finalReleaseAdmission.migrationNames,
            releaseAdmission: finalReleaseAdmission,
          });
          await writeStagingMigrationCompletion(migrationCompletion, repositoryRoot);
        }
        stagingMigrationHandled = true;
      } else {
        stagingMigrationLedger = await assertStagingMigrationLedger({
          environment: commandEnvironment,
          repositoryRoot,
        });
        assertStagingDatabasePreflight({ environment: commandEnvironment, repositoryRoot });
        assertRemotePostMigrationContract({
          environment: commandEnvironment,
          environmentName: "staging",
          repositoryRoot,
        });
        assertProductionDatabaseInvariantContract({
          environment: commandEnvironment,
          environmentName: "staging",
          migrationNames: stagingMigrationLedger.migrationNames,
          repositoryRoot,
        });
      }
    }
    if (!stagingMigrationHandled) {
      runWrangler(wranglerArgs, {
        capture: false,
        cwd: repositoryRoot,
        env: commandEnvironment,
      });
      if (requiresProductionMigrationAdmission(operation, flags)) {
        const productionMigrationLedger = await assertProductionMigrationLedger({
          environment: commandEnvironment,
          repositoryRoot,
        });
        assertProductionDatabasePreflight({
          environment: commandEnvironment,
          requirePaymentProviderSchema: true,
          repositoryRoot,
        });
        assertRemotePostMigrationContract({
          environment: commandEnvironment,
          environmentName: "production",
          repositoryRoot,
        });
        assertProductionDatabaseInvariantContract({
          environment: commandEnvironment,
          environmentName: "production",
          migrationNames: productionMigrationLedger.migrationNames,
          repositoryRoot,
        });
      }
      if (requiresStagingDatabaseAdmission(operation, flags) && operation === "seed") {
        assertRemotePostMigrationContract({
          environment: commandEnvironment,
          environmentName: "staging",
          repositoryRoot,
        });
        assertProductionDatabaseInvariantContract({
          environment: commandEnvironment,
          environmentName: "staging",
          migrationNames: stagingMigrationLedger?.migrationNames,
          repositoryRoot,
        });
      }
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown_error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
