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
    expect(parseDeployFlags(["--env", "staging"])).toMatchObject({
      dryRun: false,
      environment: "staging",
    });
  });

  it("fails a real staging deploy before build when live route audit is unavailable", () => {
    const environment = { ...process.env };
    delete environment.CLOUDFLARE_ROUTE_AUDIT_API_TOKEN;
    const result = spawnSync(process.execPath, ["scripts/deploy.mjs", "--env", "staging"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("cloudflare_route_audit_api_token_missing");
  });

  it("requires the platform doctor token before a real staging deploy can build", () => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-audit-token",
    };
    delete environment.CLOUDFLARE_PLATFORM_API_TOKEN;
    const result = spawnSync(process.execPath, ["scripts/deploy.mjs", "--env", "staging"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("cloudflare_platform_api_token_missing");
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
    const deploySink = source.indexOf('"versions", "deploy"');

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
    expect(source).toContain("buildProductionReleaseEditEnvironment(");
    expect(source).toContain("buildCanaryBuildEnvironment(process.env)");
    expect(source).toContain("`${productionAdmission.candidateWorkerVersion}@100%`");
    expect(source).toContain("CLOUDFLARE_RELEASE_WORKER_API_TOKEN");
    expect(source).toContain("assertProductionPreActivationVersions(productionAdmission, finalAdmission)");
    expect(source).toContain("finalAdmission.activeWorkerVersion !== productionAdmission.activeWorkerVersion");
    expect(source).toContain("runWrangler(deployArgs");
    expect(source).not.toContain('run("npx", deployArgs');
  });

  it("enforces backup evidence and final staging admission immediately before deploy", () => {
    const source = readFileSync("scripts/deploy.mjs", "utf8");
    const firstAdmission = source.indexOf("await assertStagingMutationAdmission");
    const build = source.indexOf('run("npm", ["run", "build"]');
    const backup = source.indexOf("await assertFreshStagingBackupEvidence", build);
    const secondAdmission = source.indexOf("await assertStagingMutationAdmission", firstAdmission + 1);
    const stableTargetGuard = source.indexOf("staging_backup_admission_changed", secondAdmission);
    const deploySink = source.indexOf(': ["deploy"]');

    expect(firstAdmission).toBeGreaterThan(-1);
    expect(firstAdmission).toBeLessThan(build);
    expect(backup).toBeGreaterThan(build);
    expect(secondAdmission).toBeGreaterThan(backup);
    expect(secondAdmission).toBeLessThan(deploySink);
    expect(stableTargetGuard).toBeGreaterThan(secondAdmission);
    expect(stableTargetGuard).toBeLessThan(deploySink);
    expect(source).toContain("delete buildEnvironment.CLOUDFLARE_PLATFORM_API_TOKEN");
    expect(source).toContain("delete buildEnvironment.CLOUDFLARE_ROUTE_AUDIT_API_TOKEN");
    expect(source).toContain("buildPinnedCloudflareEnvironment");
  });

  it("pins candidate identity reads to the audit token without OAuth fallback", () => {
    const source = readFileSync("scripts/release-candidate.mjs", "utf8");
    expect(source).toContain("identityEnvironment: auditEnvironment");
    expect(source).not.toContain("identityEnvironment: operatorEnvironment");
    expect(source).toContain("buildProductionReleaseEditEnvironment(");
    expect(source).not.toContain("buildCanaryWranglerEnvironment");
    expect(source).toContain("stageProductionUploadInputs(");
    expect(source).toContain("fingerprintProductionUploadInputs(repositoryRoot)");
    expect(source).toContain('"dist/server/entry.mjs"');
    expect(source).toContain('"--config", "production-upload-wrangler.json"');
    expect(source).toContain('"--assets", "dist/client"');
    expect(source).toContain('"--no-bundle"');
    expect(source).toContain("cwd: stageRoot");
    expect(source).not.toContain(".wrangler/deploy/config.json");
    expect(source).toContain("production_candidate_upload_inputs_changed_during_upload");
  });
});
