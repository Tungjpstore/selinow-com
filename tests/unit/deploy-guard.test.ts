import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseDeployFlags } from "../../scripts/lib/cli.mjs";

describe("deploy command safety", () => {
  it("requires an explicit environment before build or Wrangler can run", () => {
    expect(() => parseDeployFlags([])).toThrow("deploy_environment_required");
    expect(() => parseDeployFlags(["--dry-run"])).toThrow("deploy_environment_required");

    const result = spawnSync(process.execPath, ["scripts/deploy.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("deploy_environment_required");
  });

  it("forbids a real remote deploy through the local Wrangler configuration", () => {
    expect(() => parseDeployFlags(["--env", "local"]))
      .toThrow("remote_deploy_target_required");

    expect(parseDeployFlags(["--env", "local", "--dry-run"])).toMatchObject({
      dryRun: true,
      environment: "local",
    });
  });

  it("preserves explicit staging build, dry-run, and deploy targets", () => {
    expect(parseDeployFlags(["--env", "staging", "--build-only"])).toMatchObject({
      buildOnly: true,
      environment: "staging",
    });
    expect(parseDeployFlags(["--env=staging", "--dry-run"])).toMatchObject({
      dryRun: true,
      environment: "staging",
    });
    expect(() => parseDeployFlags(["--env", "staging"]))
      .toThrow("staging_release_manifest_required");
    expect(parseDeployFlags([
      "--env", "staging",
      "--release-manifest", ".wrangler/releases/staging/stg_test/release-manifest.json",
    ])).toMatchObject({
      dryRun: false,
      environment: "staging",
      releaseManifestPath: ".wrangler/releases/staging/stg_test/release-manifest.json",
    });
  });

  it("requires reviewed release evidence before a real staging deploy", () => {
    const result = spawnSync(process.execPath, ["scripts/deploy.mjs", "--env", "staging"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("staging_release_manifest_required");
  });

  it("keeps production behind explicit environment and confirmation flags", () => {
    expect(() => parseDeployFlags(["--env", "production", "--dry-run"]))
      .toThrow("production_confirmation_required");
    expect(parseDeployFlags([
      "--env", "production", "--dry-run", "--confirm-production",
    ])).toMatchObject({
      confirmProduction: true,
      dryRun: true,
      environment: "production",
    });
  });

  it("requires reviewed release evidence before a real production deploy", () => {
    expect(() => parseDeployFlags([
      "--env", "production", "--confirm-production",
    ])).toThrow("production_release_manifest_required");

    expect(parseDeployFlags([
      "--env", "production", "--confirm-production",
      "--release-manifest", ".wrangler/releases/release_20260729/release-manifest.json",
    ])).toMatchObject({
      confirmProduction: true,
      dryRun: false,
      environment: "production",
      releaseManifestPath: ".wrangler/releases/release_20260729/release-manifest.json",
    });

    const result = spawnSync(process.execPath, [
      "scripts/deploy.mjs", "--env", "production", "--confirm-production",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("production_release_manifest_required");

    const missingManifest = spawnSync(process.execPath, [
      "scripts/deploy.mjs", "--env", "production", "--confirm-production",
      "--release-manifest", ".wrangler/releases/missing_release/release-manifest.json",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(missingManifest.status).toBe(1);
    expect(missingManifest.stdout).toBe("");
    expect(missingManifest.stderr.trim()).toBe("production_release_manifest_missing");
  });

  it("enforces release admission both before build and before the production sink", () => {
    const source = readFileSync("scripts/deploy.mjs", "utf8");
    const firstAdmission = source.indexOf("await assertProductionWorkerDeployAdmission");
    const build = source.indexOf('run("npm", ["run", "build"]');
    const secondAdmission = source.indexOf("await assertProductionWorkerDeployAdmission", firstAdmission + 1);
    const stableTargetGuard = source.indexOf("production_deploy_admission_changed", secondAdmission);
    const deploySink = source.indexOf('const deployArgs = ["wrangler", "deploy"]');

    expect(firstAdmission).toBeGreaterThan(-1);
    expect(firstAdmission).toBeLessThan(build);
    expect(secondAdmission).toBeGreaterThan(build);
    expect(secondAdmission).toBeLessThan(deploySink);
    expect(stableTargetGuard).toBeGreaterThan(secondAdmission);
    expect(stableTargetGuard).toBeLessThan(deploySink);
    expect(source).toContain("finalAdmission.databaseId !== productionAdmission.databaseId");
    expect(source).toContain("finalAdmission.databaseName !== productionAdmission.databaseName");
    expect(source).toContain("productionAdmission?.accountId");
    expect(source).toContain("buildPinnedCloudflareEnvironment(buildEnvironment, admittedAccountId)");
  });

  it("enforces candidate, restore evidence, and final staging admission before deploy", () => {
    const source = readFileSync("scripts/deploy.mjs", "utf8");
    const firstRelease = source.indexOf("await assertStagingReleaseAdmission");
    const firstAdmission = source.indexOf("await assertStagingMutationAdmission");
    const build = source.indexOf('run("npm", ["run", "build"]');
    const firstContinuation = source.indexOf("await assertFreshStagingContinuationEvidence");
    const firstMigrationLedger = source.indexOf("await assertStagingMigrationLedger");
    const firstDatabasePreflight = source.indexOf("stagingPreflightAdmission = assertStagingDatabasePreflight");
    const secondRelease = source.indexOf("await assertStagingReleaseAdmission", firstRelease + 1);
    const secondContinuation = source.indexOf("await assertFreshStagingContinuationEvidence", firstContinuation + 1);
    const secondMigrationLedger = source.indexOf("await assertStagingMigrationLedger", firstMigrationLedger + 1);
    const secondDatabasePreflight = source.indexOf("finalPreflightAdmission = assertStagingDatabasePreflight");
    const secondAdmission = source.indexOf("await assertStagingMutationAdmission", firstAdmission + 1);
    const stableTargetGuard = source.indexOf("staging_release_admission_changed", secondAdmission);
    const deploySink = source.indexOf('const deployArgs = ["wrangler", "deploy"]');

    expect(firstRelease).toBeGreaterThan(-1);
    expect(firstRelease).toBeLessThan(firstAdmission);
    expect(firstAdmission).toBeGreaterThan(-1);
    expect(firstAdmission).toBeLessThan(build);
    expect(firstContinuation).toBeGreaterThan(firstAdmission);
    expect(firstContinuation).toBeLessThan(build);
    expect(firstMigrationLedger).toBeGreaterThan(firstContinuation);
    expect(firstMigrationLedger).toBeLessThan(build);
    expect(firstDatabasePreflight).toBeGreaterThan(firstMigrationLedger);
    expect(firstDatabasePreflight).toBeLessThan(build);
    expect(secondRelease).toBeGreaterThan(build);
    expect(secondContinuation).toBeGreaterThan(secondRelease);
    expect(secondAdmission).toBeGreaterThan(secondContinuation);
    expect(secondAdmission).toBeLessThan(deploySink);
    expect(secondMigrationLedger).toBeGreaterThan(secondAdmission);
    expect(secondMigrationLedger).toBeLessThan(deploySink);
    expect(secondDatabasePreflight).toBeGreaterThan(secondMigrationLedger);
    expect(secondDatabasePreflight).toBeLessThan(deploySink);
    expect(stableTargetGuard).toBeGreaterThan(secondAdmission);
    expect(stableTargetGuard).toBeLessThan(deploySink);
    expect(source).toContain("delete buildEnvironment.CLOUDFLARE_PLATFORM_API_TOKEN");
    expect(source).toContain("delete buildEnvironment.CLOUDFLARE_ROUTE_AUDIT_API_TOKEN");
    expect(source).toContain("buildPinnedCloudflareEnvironment");
  });
});
