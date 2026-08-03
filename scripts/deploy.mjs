import process from "node:process";

import { parseDeployFlags, run } from "./lib/cli.mjs";
import { assertFreshStagingContinuationEvidence } from "./lib/backup.mjs";
import {
  assertStagingMutationAdmission,
  buildPinnedCloudflareEnvironment,
  repositoryRoot,
} from "./lib/platform.mjs";
import {
  assertProductionContinuationDeployAdmission,
  assertProductionWorkerDeployAdmission,
} from "./lib/release.mjs";
import { assertStagingReleaseAdmission } from "./lib/staging-release.mjs";

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
  let stagingAdmission = null;
  let stagingReleaseAdmission = null;
  let stagingContinuationAdmission = null;
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
  }
  if (requiresStagingAdmission) {
    stagingReleaseAdmission = await assertStagingReleaseAdmission({
      manifestPath: flags.releaseManifestPath,
      repositoryRoot,
    });
    stagingAdmission = await assertStagingMutationAdmission();
    stagingContinuationAdmission = await assertFreshStagingContinuationEvidence({
      accountId: stagingAdmission.accountId,
      databaseId: stagingAdmission.databaseId,
      databaseName: stagingAdmission.databaseName,
      reviewedCommitSha: stagingReleaseAdmission.commitSha,
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
    if (
      finalAdmission.accountId !== productionAdmission.accountId
      || finalAdmission.commitSha !== productionAdmission.commitSha
      || finalAdmission.databaseId !== productionAdmission.databaseId
      || finalAdmission.databaseName !== productionAdmission.databaseName
      || finalAdmission.releaseId !== productionAdmission.releaseId
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
    productionAdmission = finalAdmission;
  }
  if (requiresStagingAdmission) {
    if (stagingAdmission === null) throw new Error("staging_admission_missing");
    if (stagingReleaseAdmission === null || stagingContinuationAdmission === null) {
      throw new Error("staging_release_admission_missing");
    }
    const finalReleaseAdmission = await assertStagingReleaseAdmission({
      manifestPath: flags.releaseManifestPath,
      repositoryRoot,
    });
    const finalContinuationAdmission = await assertFreshStagingContinuationEvidence({
      accountId: stagingAdmission.accountId,
      databaseId: stagingAdmission.databaseId,
      databaseName: stagingAdmission.databaseName,
      reviewedCommitSha: finalReleaseAdmission.commitSha,
    });
    const finalAdmission = await assertStagingMutationAdmission();
    if (
      finalAdmission.accountId !== stagingAdmission.accountId
      || finalAdmission.databaseId !== stagingAdmission.databaseId
      || finalAdmission.databaseName !== stagingAdmission.databaseName
      || finalReleaseAdmission.commitSha !== stagingReleaseAdmission.commitSha
      || finalReleaseAdmission.treeSha !== stagingReleaseAdmission.treeSha
      || finalReleaseAdmission.releaseId !== stagingReleaseAdmission.releaseId
      || finalContinuationAdmission.backup.snapshotId !== stagingContinuationAdmission.backup.snapshotId
      || finalContinuationAdmission.restore.reportRef !== stagingContinuationAdmission.restore.reportRef
    ) {
      throw new Error("staging_release_admission_changed");
    }
    stagingAdmission = finalAdmission;
    stagingReleaseAdmission = finalReleaseAdmission;
    stagingContinuationAdmission = finalContinuationAdmission;
  }
  if (!flags.buildOnly) {
    const deployArgs = ["wrangler", "deploy"];
    if (flags.environment !== "local") {
      deployArgs.push("--env", flags.environment);
    }
    if (flags.dryRun) {
      deployArgs.push("--dry-run", "--outdir", `.wrangler/dry-run-${flags.environment}`);
    }
    const admittedAccountId = stagingAdmission?.accountId ?? productionAdmission?.accountId;
    const wranglerEnvironment = admittedAccountId === undefined
      ? buildEnvironment
      : buildPinnedCloudflareEnvironment(buildEnvironment, admittedAccountId);
    run("npx", deployArgs, { capture: false, cwd: repositoryRoot, env: wranglerEnvironment });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown_error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
