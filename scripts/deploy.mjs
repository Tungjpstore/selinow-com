import process from "node:process";

import { parseDeployFlags, run, runWrangler } from "./lib/cli.mjs";
import { assertFreshStagingBackupEvidence } from "./lib/backup.mjs";
import {
  assertStagingMutationAdmission,
  buildPinnedCloudflareEnvironment,
  repositoryRoot,
} from "./lib/platform.mjs";
import {
  assertProductionPreActivationVersions,
  assertProductionWorkerDeployAdmission,
} from "./lib/release.mjs";

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
  delete buildEnvironment.CLOUDFLARE_RELEASE_WORKER_API_TOKEN;
  delete buildEnvironment.CLOUDFLARE_API_TOKEN;

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
  let stagingAdmission = null;
  if (requiresProductionAdmission) {
    productionAdmission = await assertProductionWorkerDeployAdmission({
      environment: process.env,
      manifestPath: flags.releaseManifestPath,
      repositoryRoot,
      workerSecretNames,
    });
    assertProductionPreActivationVersions(productionAdmission);
  }
  if (requiresStagingAdmission) {
    stagingAdmission = await assertStagingMutationAdmission();
  }

  run("npm", ["run", "build"], { capture: false, cwd: repositoryRoot, env: buildEnvironment });
  if (requiresProductionAdmission) {
    if (productionAdmission === null) throw new Error("production_deploy_admission_missing");
    const finalAdmission = await assertProductionWorkerDeployAdmission({
      environment: process.env,
      manifestPath: flags.releaseManifestPath,
      repositoryRoot,
      verifyLocalArtifact: true,
      workerSecretNames,
    });
    if (
      finalAdmission.accountId !== productionAdmission.accountId
      || finalAdmission.commitSha !== productionAdmission.commitSha
      || finalAdmission.databaseId !== productionAdmission.databaseId
      || finalAdmission.databaseName !== productionAdmission.databaseName
      || finalAdmission.activeWorkerVersion !== productionAdmission.activeWorkerVersion
      || finalAdmission.candidateWorkerVersion !== productionAdmission.candidateWorkerVersion
      || finalAdmission.releaseId !== productionAdmission.releaseId
      || finalAdmission.previousWorkerVersion !== productionAdmission.previousWorkerVersion
      || finalAdmission.workerName !== productionAdmission.workerName
      || finalAdmission.zoneId !== productionAdmission.zoneId
      || finalAdmission.zoneName !== productionAdmission.zoneName
    ) {
      throw new Error("production_deploy_admission_changed");
    }
    assertProductionPreActivationVersions(productionAdmission, finalAdmission);
    productionAdmission = finalAdmission;
  }
  if (requiresStagingAdmission) {
    if (stagingAdmission === null) throw new Error("staging_admission_missing");
    await assertFreshStagingBackupEvidence({
      accountId: stagingAdmission.accountId,
      databaseId: stagingAdmission.databaseId,
      databaseName: stagingAdmission.databaseName,
    });
    const finalAdmission = await assertStagingMutationAdmission();
    if (
      finalAdmission.accountId !== stagingAdmission.accountId
      || finalAdmission.databaseId !== stagingAdmission.databaseId
      || finalAdmission.databaseName !== stagingAdmission.databaseName
    ) {
      throw new Error("staging_backup_admission_changed");
    }
    stagingAdmission = finalAdmission;
  }
  if (!flags.buildOnly) {
    const deployArgs = requiresProductionAdmission
      ? [
          "versions", "deploy",
          `${productionAdmission.candidateWorkerVersion}@100%`,
          "--env", "production", "--yes",
          "--message", `release ${productionAdmission.releaseId}`,
        ]
      : ["deploy"];
    if (!requiresProductionAdmission && flags.environment !== "local") deployArgs.push("--env", flags.environment);
    if (!requiresProductionAdmission && flags.dryRun) {
      deployArgs.push("--dry-run", "--outdir", `.wrangler/dry-run-${flags.environment}`);
    }
    const admittedAccountId = stagingAdmission?.accountId ?? productionAdmission?.accountId;
    let wranglerEnvironment = admittedAccountId === undefined
      ? buildEnvironment
      : buildPinnedCloudflareEnvironment(buildEnvironment, admittedAccountId);
    if (requiresProductionAdmission) {
      const releaseWorkerToken = process.env.CLOUDFLARE_RELEASE_WORKER_API_TOKEN?.trim();
      if (!releaseWorkerToken) throw new Error("cloudflare_release_worker_api_token_missing");
      wranglerEnvironment = { ...wranglerEnvironment, CLOUDFLARE_API_TOKEN: releaseWorkerToken };
    }
    runWrangler(deployArgs, { cwd: repositoryRoot, env: wranglerEnvironment });
    if (requiresProductionAdmission) {
      const deployedAdmission = await assertProductionWorkerDeployAdmission({
        environment: process.env,
        manifestPath: flags.releaseManifestPath,
        repositoryRoot,
        verifyLocalArtifact: true,
        workerSecretNames,
      });
      if (
        deployedAdmission.activeWorkerVersion !== productionAdmission.candidateWorkerVersion
        || deployedAdmission.candidateWorkerVersion !== productionAdmission.candidateWorkerVersion
        || deployedAdmission.commitSha !== productionAdmission.commitSha
        || deployedAdmission.releaseId !== productionAdmission.releaseId
      ) {
        throw new Error("production_deploy_verification_failed");
      }
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown_error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
