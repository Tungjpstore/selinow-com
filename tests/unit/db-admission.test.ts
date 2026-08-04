import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  assertProductionAccountIdentity,
  assertProductionDatabaseIdentity,
  assertProductionMigrationAdmission,
  parseDatabaseFlags,
  requiresProductionMigrationAdmission,
  requiresStagingDatabaseAdmission,
  resolveApprovedProductionDatabaseTarget,
} from "../../scripts/lib/db-admission.mjs";

const accountId = "abcdef0123456789abcdef0123456789";
const databaseId = "17ea8f2f-4c97-4337-8989-28b25a58ddeb";

function productionSpec(): Record<string, unknown> {
  return {
    accountId,
    environment: "production",
    resources: { d1: "selinow-production" },
  };
}

function wranglerConfig(): Record<string, unknown> {
  return {
    env: {
      production: {
        d1_databases: [{
          binding: "PLATFORM_DB",
          database_id: databaseId,
          database_name: "selinow-production",
        }],
      },
    },
  };
}

function continuationEvidence() {
  return {
    backup: { checksumSha256: "a".repeat(64), snapshotId: "bkp_continuation" },
    restore: { reportRef: "restore-report", snapshotId: "rdr_continuation" },
  };
}

describe("production database migration admission", () => {
  it("preserves local, staging, dry-run, and read-only command behavior", () => {
    expect(parseDatabaseFlags(["--env", "local"])).toMatchObject({
      environment: "local",
      releaseManifestPath: null,
    });
    expect(parseDatabaseFlags(["--env", "staging", "--dry-run"])).toMatchObject({
      dryRun: true,
      environment: "staging",
    });
    expect(parseDatabaseFlags([
      "--env", "staging",
      "--release-manifest", ".wrangler/releases/staging/stg_test/release-manifest.json",
    ])).toMatchObject({
      environment: "staging",
      releaseManifestPath: ".wrangler/releases/staging/stg_test/release-manifest.json",
    });
    const productionDryRun = parseDatabaseFlags([
      "--env", "production", "--confirm-production", "--dry-run",
    ]);
    expect(requiresProductionMigrationAdmission("migrate", productionDryRun)).toBe(false);
    expect(requiresProductionMigrationAdmission("seed", {
      ...productionDryRun,
      dryRun: false,
    })).toBe(true);
    expect(requiresProductionMigrationAdmission("status", {
      ...productionDryRun,
      dryRun: false,
    })).toBe(false);
    expect(requiresProductionMigrationAdmission("preflight", {
      ...productionDryRun,
      dryRun: false,
    })).toBe(false);
    const stagingFlags = parseDatabaseFlags(["--env", "staging"]);
    expect(requiresStagingDatabaseAdmission("migrate", stagingFlags)).toBe(true);
    expect(requiresStagingDatabaseAdmission("seed", stagingFlags)).toBe(true);
    expect(requiresStagingDatabaseAdmission("status", stagingFlags)).toBe(false);
    expect(requiresStagingDatabaseAdmission("preflight", stagingFlags)).toBe(false);
    expect(requiresStagingDatabaseAdmission("migrate", {
      ...stagingFlags,
      dryRun: true,
    })).toBe(false);
  });

  it("requires reviewed release evidence before staging database mutation", () => {
    for (const operation of ["migrate", "seed"]) {
      const result = spawnSync(process.execPath, [
        "scripts/db.mjs",
        operation,
        "--env",
        "staging",
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe("staging_release_manifest_required");
    }
  });

  it("requires a reviewed manifest before a real production migration", () => {
    const result = spawnSync(process.execPath, [
      "scripts/db.mjs",
      "migrate",
      "--env",
      "production",
      "--confirm-production",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("production_release_manifest_required");
  });

  it("keeps production migration and status dry-runs network-free without a manifest", () => {
    for (const operation of ["migrate", "status"]) {
      const result = spawnSync(process.execPath, [
        "scripts/db.mjs",
        operation,
        "--env",
        "production",
        "--confirm-production",
        "--dry-run",
        "--json",
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        environment: "production",
        ok: true,
      });
      expect(result.stderr).toBe("");
    }
  });

  it("binds the approved production database name and configured database ID", () => {
    expect(resolveApprovedProductionDatabaseTarget({
      productionSpec: productionSpec(),
      wranglerConfig: wranglerConfig(),
    })).toEqual({
      accountId,
      target: {
        binding: "PLATFORM_DB",
        databaseId,
        databaseName: "selinow-production",
        environment: "production",
        resourceRef: "d1:selinow-production",
      },
    });

    const wrongSpec = productionSpec();
    (wrongSpec.resources as Record<string, unknown>).d1 = "selinow-other-production";
    expect(() => resolveApprovedProductionDatabaseTarget({
      productionSpec: wrongSpec,
      wranglerConfig: wranglerConfig(),
    })).toThrow("production_database_target_mismatch");

    const wrongConfig = wranglerConfig();
    const production = (wrongConfig.env as {
      production: { d1_databases: Array<Record<string, unknown>> };
    }).production;
    const [database] = production.d1_databases;
    if (database === undefined) throw new Error("test_database_binding_missing");
    database.database_id = "invalid";
    expect(() => resolveApprovedProductionDatabaseTarget({
      productionSpec: productionSpec(),
      wranglerConfig: wrongConfig,
    })).toThrow("database_id_invalid:production");
  });

  it("requires the authenticated Wrangler account to match the approved account", () => {
    expect(() => {
      assertProductionAccountIdentity(`Account ID: ${accountId}`, accountId);
    }).not.toThrow();
    expect(() => {
      assertProductionAccountIdentity("Account ID: 11111111111111111111111111111111", accountId);
    }).toThrow("production_account_identity_mismatch");
  });

  it("requires the live production D1 name and UUID to match the approved target", () => {
    expect(() => {
      assertProductionDatabaseIdentity(JSON.stringify([
        { name: "selinow-production", uuid: databaseId },
      ]), databaseId, "selinow-production");
    }).not.toThrow();
    expect(() => {
      assertProductionDatabaseIdentity(JSON.stringify([
        { name: "selinow-production", uuid: "11111111-1111-4111-8111-111111111111" },
      ]), databaseId, "selinow-production");
    }).toThrow("production_database_identity_mismatch");
  });

  it("does not expose provider output when account lookup fails", async () => {
    await expect(assertProductionMigrationAdmission({
      assertReleaseAdmissionImplementation: () => Promise.resolve({
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        releaseId: "release_20260729_abcdef12",
      }),
      manifestPath: ".wrangler/releases/release_20260729_abcdef12/release-manifest.json",
      assertContinuationEvidenceImplementation: () => Promise.resolve(continuationEvidence()),
      productionSpec: productionSpec(),
      repositoryRoot: process.cwd(),
      runWranglerImplementation: () => {
        throw new Error("provider output containing operator identity");
      },
      workerSecretNames: [],
      wranglerConfig: wranglerConfig(),
    })).rejects.toThrow("production_account_identity_unavailable");
  });

  it("does not expose provider output when production D1 lookup fails", async () => {
    await expect(assertProductionMigrationAdmission({
      assertReleaseAdmissionImplementation: () => Promise.resolve({
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        releaseId: "release_20260729_abcdef12",
      }),
      manifestPath: ".wrangler/releases/release_20260729_abcdef12/release-manifest.json",
      assertContinuationEvidenceImplementation: () => Promise.resolve(continuationEvidence()),
      productionSpec: productionSpec(),
      repositoryRoot: process.cwd(),
      runWranglerImplementation: (args) => {
        if (args[0] === "whoami") return { stderr: "", stdout: `Account ID: ${accountId}` };
        throw new Error("provider output containing database details");
      },
      workerSecretNames: [],
      wranglerConfig: wranglerConfig(),
    })).rejects.toThrow("production_database_identity_unavailable");
  });

  it("rechecks the release permit around the account lookup before admitting migration", async () => {
    const events: string[] = [];
    const releaseAdmission = vi.fn(() => {
      events.push("release");
      return Promise.resolve({
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        releaseId: "release_20260729_abcdef12",
      });
    });
    const runner = vi.fn((args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      events.push(args.join(" "));
      expect(options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(accountId);
      return {
        stderr: "",
        stdout: args[0] === "d1"
          ? JSON.stringify([{ name: "selinow-production", uuid: databaseId }])
          : `Account ID: ${accountId}`,
      };
    });

    await expect(assertProductionMigrationAdmission({
      assertReleaseAdmissionImplementation: releaseAdmission,
      manifestPath: ".wrangler/releases/release_20260729_abcdef12/release-manifest.json",
      assertContinuationEvidenceImplementation: () => Promise.resolve(continuationEvidence()),
      productionSpec: productionSpec(),
      repositoryRoot: process.cwd(),
      runWranglerImplementation: runner,
      workerSecretNames: [],
      wranglerConfig: wranglerConfig(),
    })).resolves.toEqual({
      accountId,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      databaseId,
      databaseName: "selinow-production",
      releaseId: "release_20260729_abcdef12",
    });
    expect(events).toEqual(["release", "whoami --json", "d1 list --env production --json", "release"]);
  });

  it("places admission immediately before the production migration sink", () => {
    const source = readFileSync("scripts/db.mjs", "utf8");
    const gate = source.indexOf("await assertProductionMigrationAdmission");
    const pin = source.indexOf("buildPinnedCloudflareEnvironment", gate);
    const sink = source.indexOf("runWrangler(wranglerArgs", gate);

    expect(gate).toBeGreaterThan(-1);
    expect(pin).toBeGreaterThan(gate);
    expect(sink).toBeGreaterThan(gate);
  });

  it("places the same production admission immediately before the seed sink", () => {
    const source = readFileSync("scripts/db.mjs", "utf8");
    const gate = source.indexOf("requiresProductionMigrationAdmission");
    const admission = source.indexOf("await assertProductionMigrationAdmission", gate);
    const pin = source.indexOf("buildPinnedCloudflareEnvironment", admission);
    const seedFile = source.indexOf("./seeds/0001_platform_defaults.sql");
    const sink = source.indexOf("runWrangler(wranglerArgs", admission);

    expect(gate).toBeGreaterThan(-1);
    expect(admission).toBeGreaterThan(gate);
    expect(pin).toBeGreaterThan(admission);
    expect(seedFile).toBeGreaterThan(-1);
    expect(sink).toBeGreaterThan(pin);
  });

  it("rechecks staging release and restore evidence before mutation sinks", () => {
    const source = readFileSync("scripts/db.mjs", "utf8");
    const firstRelease = source.indexOf("await assertStagingReleaseAdmission");
    const firstGate = source.indexOf("await assertStagingMutationAdmission");
    const continuation = source.indexOf("await assertFreshStagingContinuationEvidence", firstGate);
    const finalGate = source.indexOf("await assertStagingMutationAdmission", firstGate + 1);
    const finalRelease = source.indexOf("await assertStagingReleaseAdmission", firstRelease + 1);
    const finalContinuation = source.indexOf("await assertFreshStagingContinuationEvidence", continuation + 1);
    const stableTargetGuard = source.indexOf("staging_release_admission_changed", finalContinuation);
    const pin = source.indexOf("buildPinnedCloudflareEnvironment", finalGate);
    const prefixLedger = source.indexOf("await assertStagingMigrationLedgerPrefix", pin);
    const completeLedger = source.indexOf("await assertStagingMigrationLedger({", pin);
    const preflight = source.indexOf("assertStagingDatabasePreflight", completeLedger);
    const sink = source.indexOf("runWrangler(wranglerArgs", finalGate);

    expect(firstRelease).toBeGreaterThan(-1);
    expect(firstRelease).toBeLessThan(firstGate);
    expect(firstGate).toBeGreaterThan(-1);
    expect(continuation).toBeGreaterThan(firstGate);
    expect(finalGate).toBeGreaterThan(continuation);
    expect(finalRelease).toBeGreaterThan(finalGate);
    expect(finalContinuation).toBeGreaterThan(finalRelease);
    expect(stableTargetGuard).toBeGreaterThan(finalContinuation);
    expect(pin).toBeGreaterThan(stableTargetGuard);
    expect(prefixLedger).toBeGreaterThan(pin);
    expect(prefixLedger).toBeLessThan(sink);
    expect(completeLedger).toBeGreaterThan(pin);
    expect(completeLedger).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(sink);
    expect(sink).toBeGreaterThan(pin);
  });
});
