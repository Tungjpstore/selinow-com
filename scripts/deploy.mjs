import process from "node:process";

import { parseDeployFlags, run } from "./lib/cli.mjs";
import { assertStagingContinuationEvidenceByReference } from "./lib/backup.mjs";
import {
  assertStagingMutationAdmission,
  buildPinnedCloudflareEnvironment,
  repositoryRoot,
} from "./lib/platform.mjs";
import {
  assertProductionDatabasePreflight,
  assertProductionMigrationLedger,
} from "./lib/db-admission.mjs";
import { assertRemotePostMigrationContract } from "./lib/db-post-migration-contract.mjs";
import {
  assertProductionDatabaseDeployAdmission,
  assertProductionContinuationDeployAdmission,
  assertProductionWorkerDeployAdmission,
} from "./lib/release.mjs";
import {
  assertStagingContinuationBinding,
  assertStagingDatabasePreflight,
  assertStagingMigrationLedger,
  assertStagingMigrationCompletion,
  assertStagingPostMigrationEvidence,
  assertStagingReleaseAdmission,
  readStagingPostMigrationEvidence,
} from "./lib/staging-release.mjs";

function databaseTargetFromAdmission(admission) {
  return {
    accountId: admission.accountId,
    databaseId: admission.databaseId,
    databaseName: admission.databaseName,
  };
}

try {
  const flags = parseDeployFlags(process.argv.slice(2));

  const buildEnvironment = { ...process.env };
  if (flags.environment !== "local") {
    buildEnvironment.CLOUDFLARE_ENV = flags.environment;
  } else {
    delete buildEnvironment.CLOUDFLARE_ENV;
  }
  // Keep the read-only admission credential outside the application build process.
  delete buildEnvironment.CLOUDFLARE_PLATFORM_API_TOKEN;
  delete buildEnvironment.CLOUDFLARE_ROUTE_AUDIT_API_TOKEN;

  const requiresProductionAdmission = flags.environment === "production"
    && !flags.dryRun
    && !flags.buildOnly;
  const requiresStagingAdmission = flags.environment === "staging"
    && !flags.dryRun
    && !flags.buildOnly;
  const workerSecretNames = (process.env.SELINOW_WORKER_SECRET_NAMES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  let productionAdmission = null;
  let productionContinuationAdmission = null;
  let productionDatabaseAdmission = null;
  let stagingAdmission = null;
  let stagingReleaseAdmission = null;
  let stagingPreMigrationContinuationAdmission = null;
  let stagingMigrationCompletionAdmission = null;
  let stagingPostMigrationContinuationAdmission = null;
  let stagingPostMigrationEvidenceAdmission = null;
  let stagingMigrationAdmission = null;
  let stagingPreflightAdmission = null;
  if (requiresProductionAdmission) {
    productionAdmission = await assertProductionWorkerDeployAdmission({
      environment: process.env,
      manifestPath: flags.releaseManifestPath,
      repositoryRoot,
      workerSecretNames,
    });
    productionContinuationAdmission = await assertProductionContinuationDeployAdmission({
      accountId: productionAdmission.accountId,
      databaseId: productionAdmission.databaseId,
      databaseName: productionAdmission.databaseName,
      repositoryRoot,
      reviewedCommitSha: productionAdmission.commitSha,
    });
    productionDatabaseAdmission = await assertProductionDatabaseDeployAdmission({
      assertDatabasePreflightImplementation: assertProductionDatabasePreflight,
      assertMigrationLedgerImplementation: assertProductionMigrationLedger,
      assertPostMigrationContractImplementation: assertRemotePostMigrationContract,
      environment: buildPinnedCloudflareEnvironment(process.env, productionAdmission.accountId),
      repositoryRoot,
    });
  }
  if (requiresStagingAdmission) {
    stagingReleaseAdmission = await assertStagingReleaseAdmission({
      manifestPath: flags.releaseManifestPath,
      repositoryRoot,
    });
    stagingAdmission = await assertStagingMutationAdmission();
    stagingPreMigrationContinuationAdmission = await assertStagingContinuationEvidenceByReference({
      accountId: stagingAdmission.accountId,
      continuationEvidence: stagingReleaseAdmission.continuationEvidence,
      databaseId: stagingAdmission.databaseId,
      databaseName: stagingAdmission.databaseName,
      evidenceRecordedAt: stagingReleaseAdmission.createdAt,
      repositoryRoot,
      reviewedCommitSha: stagingReleaseAdmission.commitSha,
    });
    assertStagingContinuationBinding(
      stagingReleaseAdmission,
      stagingPreMigrationContinuationAdmission,
      stagingAdmission,
    );
    const stagingCommandEnvironment = buildPinnedCloudflareEnvironment(process.env, stagingAdmission.accountId);
    stagingMigrationAdmission = await assertStagingMigrationLedger({
      environment: stagingCommandEnvironment,
      migrationNames: stagingReleaseAdmission.migrationNames,
      repositoryRoot,
    });
    stagingPreflightAdmission = assertStagingDatabasePreflight({
      environment: stagingCommandEnvironment,
      repositoryRoot,
    });
    stagingMigrationCompletionAdmission = await assertStagingMigrationCompletion({
      databaseTarget: databaseTargetFromAdmission(stagingAdmission),
      migrationNames: stagingMigrationAdmission.migrationNames,
      releaseAdmission: stagingReleaseAdmission,
      repositoryRoot,
    });
    const postMigrationRecord = await readStagingPostMigrationEvidence({
      databaseTarget: databaseTargetFromAdmission(stagingAdmission),
      migrationCompletion: stagingMigrationCompletionAdmission,
      migrationNames: stagingMigrationAdmission.migrationNames,
      releaseAdmission: stagingReleaseAdmission,
      repositoryRoot,
    });
    stagingPostMigrationContinuationAdmission = await assertStagingContinuationEvidenceByReference({
      accountId: stagingAdmission.accountId,
      continuationEvidence: postMigrationRecord.continuationEvidence,
      databaseId: stagingAdmission.databaseId,
      databaseName: stagingAdmission.databaseName,
      evidenceRecordedAt: postMigrationRecord.completedAt,
      repositoryRoot,
      reviewedCommitSha: stagingReleaseAdmission.commitSha,
    });
    stagingPostMigrationEvidenceAdmission = await assertStagingPostMigrationEvidence({
      continuationEvidence: stagingPostMigrationContinuationAdmission,
      databaseTarget: databaseTargetFromAdmission(stagingAdmission),
      migrationCompletion: stagingMigrationCompletionAdmission,
      migrationNames: stagingMigrationAdmission.migrationNames,
      releaseAdmission: stagingReleaseAdmission,
      repositoryRoot,
    });
  }

  run("npm", ["run", "build"], { capture: false, cwd: repositoryRoot, env: buildEnvironment });
  if (requiresProductionAdmission) {
    if (productionAdmission === null) throw new Error("production_deploy_admission_missing");
    const finalAdmission = await assertProductionWorkerDeployAdmission({
      environment: process.env,
      manifestPath: flags.releaseManifestPath,
      repositoryRoot,
      workerSecretNames,
    });
    const finalContinuationAdmission = await assertProductionContinuationDeployAdmission({
      accountId: finalAdmission.accountId,
      databaseId: finalAdmission.databaseId,
      databaseName: finalAdmission.databaseName,
      repositoryRoot,
      reviewedCommitSha: finalAdmission.commitSha,
    });
    const finalDatabaseAdmission = await assertProductionDatabaseDeployAdmission({
      assertDatabasePreflightImplementation: assertProductionDatabasePreflight,
      assertMigrationLedgerImplementation: assertProductionMigrationLedger,
      assertPostMigrationContractImplementation: assertRemotePostMigrationContract,
      environment: buildPinnedCloudflareEnvironment(process.env, finalAdmission.accountId),
      repositoryRoot,
    });
    if (
      finalAdmission.accountId !== productionAdmission.accountId
      || finalAdmission.candidateWorkerVersion !== productionAdmission.candidateWorkerVersion
      || finalAdmission.commitSha !== productionAdmission.commitSha
      || finalAdmission.databaseId !== productionAdmission.databaseId
      || finalAdmission.databaseName !== productionAdmission.databaseName
      || finalAdmission.migrationLedgerSha256 !== productionAdmission.migrationLedgerSha256
      || finalAdmission.previousWorkerVersion !== productionAdmission.previousWorkerVersion
      || finalAdmission.releaseId !== productionAdmission.releaseId
      || finalAdmission.rollbackArtifactSha256 !== productionAdmission.rollbackArtifactSha256
      || finalAdmission.rollbackCandidateWorkerVersion !== productionAdmission.rollbackCandidateWorkerVersion
      || finalAdmission.treeSha !== productionAdmission.treeSha
      || finalAdmission.workerName !== productionAdmission.workerName
      || finalAdmission.zoneId !== productionAdmission.zoneId
      || finalAdmission.zoneName !== productionAdmission.zoneName
    ) {
      throw new Error("production_deploy_admission_changed");
    }
    if (
      productionContinuationAdmission === null
      || finalContinuationAdmission.backupSnapshotId !== productionContinuationAdmission.backupSnapshotId
      || finalContinuationAdmission.backupChecksumSha256 !== productionContinuationAdmission.backupChecksumSha256
      || finalContinuationAdmission.restoreReportRef !== productionContinuationAdmission.restoreReportRef
      || finalContinuationAdmission.restoreSnapshotId !== productionContinuationAdmission.restoreSnapshotId
      || finalContinuationAdmission.reviewedCommitSha !== productionContinuationAdmission.reviewedCommitSha
    ) {
      throw new Error("production_continuation_evidence_changed");
    }
    if (
      productionDatabaseAdmission === null
      || finalDatabaseAdmission.preflightFingerprintSha256 !== productionDatabaseAdmission.preflightFingerprintSha256
      || finalDatabaseAdmission.postMigrationFingerprintSha256 !== productionDatabaseAdmission.postMigrationFingerprintSha256
      || JSON.stringify(finalDatabaseAdmission.migrationNames) !== JSON.stringify(productionDatabaseAdmission.migrationNames)
    ) {
      throw new Error("production_database_admission_changed");
    }
    const sinkAdmission = await assertProductionWorkerDeployAdmission({
      environment: process.env,
      manifestPath: flags.releaseManifestPath,
      repositoryRoot,
      workerSecretNames,
    });
    if (
      sinkAdmission.accountId !== finalAdmission.accountId
      || sinkAdmission.candidateWorkerVersion !== finalAdmission.candidateWorkerVersion
      || sinkAdmission.commitSha !== finalAdmission.commitSha
      || sinkAdmission.databaseId !== finalAdmission.databaseId
      || sinkAdmission.databaseName !== finalAdmission.databaseName
      || sinkAdmission.migrationLedgerSha256 !== finalAdmission.migrationLedgerSha256
      || sinkAdmission.previousWorkerVersion !== finalAdmission.previousWorkerVersion
      || sinkAdmission.releaseId !== finalAdmission.releaseId
      || sinkAdmission.rollbackArtifactSha256 !== finalAdmission.rollbackArtifactSha256
      || sinkAdmission.rollbackCandidateWorkerVersion !== finalAdmission.rollbackCandidateWorkerVersion
      || sinkAdmission.treeSha !== finalAdmission.treeSha
      || sinkAdmission.workerName !== finalAdmission.workerName
      || sinkAdmission.zoneId !== finalAdmission.zoneId
      || sinkAdmission.zoneName !== finalAdmission.zoneName
    ) {
      throw new Error("production_sink_admission_changed");
    }
    productionAdmission = sinkAdmission;
  }
  if (requiresStagingAdmission) {
    if (stagingAdmission === null) throw new Error("staging_admission_missing");
    if (stagingReleaseAdmission === null
      || stagingPreMigrationContinuationAdmission === null
      || stagingMigrationCompletionAdmission === null
      || stagingPostMigrationContinuationAdmission === null
      || stagingPostMigrationEvidenceAdmission === null) {
      throw new Error("staging_release_admission_missing");
    }
    const finalReleaseAdmission = await assertStagingReleaseAdmission({
      manifestPath: flags.releaseManifestPath,
      repositoryRoot,
    });
    const finalAdmission = await assertStagingMutationAdmission();
    const finalPreMigrationContinuationAdmission = await assertStagingContinuationEvidenceByReference({
      accountId: finalAdmission.accountId,
      continuationEvidence: finalReleaseAdmission.continuationEvidence,
      databaseId: finalAdmission.databaseId,
      databaseName: finalAdmission.databaseName,
      evidenceRecordedAt: finalReleaseAdmission.createdAt,
      repositoryRoot,
      reviewedCommitSha: finalReleaseAdmission.commitSha,
    });
    assertStagingContinuationBinding(
      finalReleaseAdmission,
      finalPreMigrationContinuationAdmission,
      finalAdmission,
    );
    const finalStagingCommandEnvironment = buildPinnedCloudflareEnvironment(process.env, finalAdmission.accountId);
    const finalMigrationAdmission = await assertStagingMigrationLedger({
      environment: finalStagingCommandEnvironment,
      migrationNames: finalReleaseAdmission.migrationNames,
      repositoryRoot,
    });
    const finalPreflightAdmission = assertStagingDatabasePreflight({
      environment: finalStagingCommandEnvironment,
      repositoryRoot,
    });
    const finalMigrationCompletionAdmission = await assertStagingMigrationCompletion({
      databaseTarget: databaseTargetFromAdmission(finalAdmission),
      migrationNames: finalMigrationAdmission.migrationNames,
      releaseAdmission: finalReleaseAdmission,
      repositoryRoot,
    });
    const finalPostMigrationRecord = await readStagingPostMigrationEvidence({
      databaseTarget: databaseTargetFromAdmission(finalAdmission),
      migrationCompletion: finalMigrationCompletionAdmission,
      migrationNames: finalMigrationAdmission.migrationNames,
      releaseAdmission: finalReleaseAdmission,
      repositoryRoot,
    });
    const finalPostMigrationContinuationAdmission = await assertStagingContinuationEvidenceByReference({
      accountId: finalAdmission.accountId,
      continuationEvidence: finalPostMigrationRecord.continuationEvidence,
      databaseId: finalAdmission.databaseId,
      databaseName: finalAdmission.databaseName,
      evidenceRecordedAt: finalPostMigrationRecord.completedAt,
      repositoryRoot,
      reviewedCommitSha: finalReleaseAdmission.commitSha,
    });
    const finalPostMigrationEvidenceAdmission = await assertStagingPostMigrationEvidence({
      continuationEvidence: finalPostMigrationContinuationAdmission,
      databaseTarget: databaseTargetFromAdmission(finalAdmission),
      migrationCompletion: finalMigrationCompletionAdmission,
      migrationNames: finalMigrationAdmission.migrationNames,
      releaseAdmission: finalReleaseAdmission,
      repositoryRoot,
    });
    if (
      finalAdmission.accountId !== stagingAdmission.accountId
      || finalAdmission.databaseId !== stagingAdmission.databaseId
      || finalAdmission.databaseName !== stagingAdmission.databaseName
      || finalReleaseAdmission.commitSha !== stagingReleaseAdmission.commitSha
      || finalReleaseAdmission.treeSha !== stagingReleaseAdmission.treeSha
      || finalReleaseAdmission.releaseId !== stagingReleaseAdmission.releaseId
      || finalPreMigrationContinuationAdmission.backup.snapshotId !== stagingPreMigrationContinuationAdmission.backup.snapshotId
      || finalPreMigrationContinuationAdmission.restore.reportRef !== stagingPreMigrationContinuationAdmission.restore.reportRef
      || JSON.stringify(finalMigrationCompletionAdmission) !== JSON.stringify(stagingMigrationCompletionAdmission)
      || JSON.stringify(finalPostMigrationEvidenceAdmission) !== JSON.stringify(stagingPostMigrationEvidenceAdmission)
      || stagingMigrationAdmission === null
      || stagingPreflightAdmission === null
      || finalMigrationAdmission.migrationNames.length !== stagingMigrationAdmission.migrationNames.length
      || finalMigrationAdmission.migrationNames.some((name, index) => name !== stagingMigrationAdmission.migrationNames[index])
      || JSON.stringify(finalPreflightAdmission.checks) !== JSON.stringify(stagingPreflightAdmission.checks)
    ) {
      throw new Error("staging_release_admission_changed");
    }
    stagingAdmission = finalAdmission;
    stagingReleaseAdmission = finalReleaseAdmission;
    stagingPreMigrationContinuationAdmission = finalPreMigrationContinuationAdmission;
    stagingMigrationCompletionAdmission = finalMigrationCompletionAdmission;
    stagingPostMigrationContinuationAdmission = finalPostMigrationContinuationAdmission;
    stagingPostMigrationEvidenceAdmission = finalPostMigrationEvidenceAdmission;
  }
  if (!flags.buildOnly) {
    const admittedAccountId = stagingAdmission?.accountId ?? productionAdmission?.accountId;
    const wranglerEnvironment = admittedAccountId === undefined
      ? buildEnvironment
      : buildPinnedCloudflareEnvironment(buildEnvironment, admittedAccountId);
    if (requiresProductionAdmission) {
      if (productionAdmission === null) throw new Error("production_deploy_admission_missing");
      run("npx", [
        "wrangler",
        "versions",
        "deploy",
        `${productionAdmission.candidateWorkerVersion}@100%`,
        "--env",
        "production",
        "--yes",
      ], { capture: false, cwd: repositoryRoot, env: wranglerEnvironment });
    } else {
      const deployArgs = ["wrangler", "deploy"];
      if (flags.environment !== "local") {
        deployArgs.push("--env", flags.environment);
      }
      if (flags.dryRun) {
        deployArgs.push("--dry-run", "--outdir", `.wrangler/dry-run-${flags.environment}`);
      }
      run("npx", deployArgs, { capture: false, cwd: repositoryRoot, env: wranglerEnvironment });
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown_error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
