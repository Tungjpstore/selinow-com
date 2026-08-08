import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  assertProductionAccountIdentity,
  assertProductionDatabasePreflight,
  assertProductionDatabaseIdentity,
  assertProductionMigrationLedger,
  assertProductionMigrationAdmission,
  assertProductionMigrationLedgerPrefix,
  parseProductionMigrationLedgerOutput,
  parseDatabaseFlags,
  requiresMaintenanceDrainConfirmation,
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
      maintenanceDrainConfirmed: false,
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
    const drainedStagingFlags = parseDatabaseFlags(["--env", "staging", "--confirm-maintenance-drain"]);
    expect(drainedStagingFlags.maintenanceDrainConfirmed).toBe(true);
    expect(requiresMaintenanceDrainConfirmation("migrate", stagingFlags)).toBe(true);
    expect(requiresMaintenanceDrainConfirmation("migrate", drainedStagingFlags)).toBe(false);
    expect(requiresMaintenanceDrainConfirmation("seed", stagingFlags)).toBe(false);
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

  it("requires an explicit maintenance drain after manifest presence is established", () => {
    const cases = [
      ["staging"],
      ["production", "--confirm-production"],
    ];
    for (const [environment, ...extra] of cases) {
      const result = spawnSync(process.execPath, [
        "scripts/db.mjs",
        "migrate",
        "--env",
        environment ?? "missing",
        ...extra,
        "--release-manifest",
        ".wrangler/releases/test/release-manifest.json",
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe("maintenance_drain_confirmation_required");
    }
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

  it("accepts only an exact ordered production ledger prefix and requires completeness after migration", async () => {
    const migrationNames = [
      "0001_platform_foundation.sql",
      "0002_tenant_auth_subscription.sql",
      "0003_catalog_inventory_orders.sql",
    ];
    const runner = (observed: string[]) => () => ({
      stderr: "",
      stdout: JSON.stringify([{ success: true, results: observed.map((name) => ({ name })) }]),
    });

    await expect(assertProductionMigrationLedgerPrefix({
      expectedPrefix: migrationNames.slice(0, 2),
      migrationNames,
      runWranglerImplementation: runner(migrationNames.slice(0, 2)),
    })).resolves.toEqual({ migrationNames: migrationNames.slice(0, 2) });
    await expect(assertProductionMigrationLedgerPrefix({
      expectedPrefix: migrationNames.slice(0, 1),
      migrationNames,
      runWranglerImplementation: runner(migrationNames.slice(0, 2)),
    })).rejects.toThrow("production_migration_ledger_prefix_invalid");
    await expect(assertProductionMigrationLedgerPrefix({
      migrationNames,
      runWranglerImplementation: runner([
        "0002_tenant_auth_subscription.sql",
        "0001_platform_foundation.sql",
      ]),
    })).rejects.toThrow("production_migration_ledger_prefix_invalid");
    await expect(assertProductionMigrationLedger({
      migrationNames,
      runWranglerImplementation: runner(migrationNames.slice(0, 2)),
    })).rejects.toThrow("production_migration_ledger_incomplete");
    await expect(assertProductionMigrationLedger({
      migrationNames,
      runWranglerImplementation: runner(migrationNames),
    })).resolves.toEqual({ migrationNames });
    expect(() => parseProductionMigrationLedgerOutput(JSON.stringify([{
      results: migrationNames.map((name) => ({ name })),
      success: false,
    }]))).toThrow("production_migration_ledger_invalid_result");
  });

  it("runs every production database invariant query and fails closed on violations", () => {
    const runner = vi.fn((args: string[]) => {
      const sql = args[args.indexOf("--command") + 1] ?? "";
      if (sql.includes("sqlite_master")) return { stderr: "", stdout: JSON.stringify([{ results: [] }]) };
      if (sql.includes("missing_payos_connections")) throw new Error("provider query should be skipped");
      if (sql.includes("invalid_payos_active_credential_links")) {
        return { stderr: "", stdout: JSON.stringify([{ results: [{
          invalid_payos_active_credential_links: 0,
          invalid_payos_attempt_links: 0,
          invalid_payos_credential_integration_links: 0,
          invalid_payos_event_links: 0,
          invalid_payos_exception_links: 0,
          invalid_payos_paid_event_links: 0,
        }] }]) };
      }
      return { stderr: "", stdout: JSON.stringify([{ results: [{
        canonical_null_shops: 0,
        duplicate_primary_shops: 0,
        duplicate_provider_ids: 0,
        invalid_canonical_links: 0,
        legacy_custom_domains: 0,
        unresolved_active_attempt_origins: 0,
      }] }]) };
    });

    expect(assertProductionDatabasePreflight({ runWranglerImplementation: runner })).toMatchObject({ ok: true });
    expect(runner).toHaveBeenCalledTimes(3);
    expect(() => assertProductionDatabasePreflight({
      requirePaymentProviderSchema: true,
      runWranglerImplementation: runner,
    })).toThrow("production_database_preflight_failed");
    expect(() => assertProductionDatabasePreflight({
      runWranglerImplementation: () => {
        throw new Error("provider output");
      },
    })).toThrow("production_database_preflight_failed");
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
        migrationLedgerPrefix: ["0001_platform_foundation.sql"],
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
      assertDatabasePreflightImplementation: () => {
        events.push("preflight");
        return { checks: [], ok: true };
      },
      assertMigrationLedgerPrefixImplementation: (input) => {
        expect(input.expectedPrefix).toEqual(["0001_platform_foundation.sql"]);
        events.push("ledger");
        return Promise.resolve({ migrationNames: ["0001_platform_foundation.sql"] });
      },
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
    expect(events).toEqual([
      "release",
      "whoami --json",
      "d1 list --env production --json",
      "ledger",
      "preflight",
      "release",
      "ledger",
      "preflight",
    ]);
  });

  it("fails closed when the production migration ledger changes during admission", async () => {
    let ledgerRead = 0;
    await expect(assertProductionMigrationAdmission({
      assertReleaseAdmissionImplementation: () => Promise.resolve({
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        releaseId: "release_20260729_abcdef12",
      }),
      assertDatabasePreflightImplementation: () => ({ checks: [], ok: true }),
      assertMigrationLedgerPrefixImplementation: () => Promise.resolve({
        migrationNames: ledgerRead++ === 0
          ? ["0001_platform_foundation.sql"]
          : ["0001_platform_foundation.sql", "0002_tenant_auth_subscription.sql"],
      }),
      manifestPath: ".wrangler/releases/release_20260729_abcdef12/release-manifest.json",
      assertContinuationEvidenceImplementation: () => Promise.resolve(continuationEvidence()),
      productionSpec: productionSpec(),
      repositoryRoot: process.cwd(),
      runWranglerImplementation: (args) => ({
        stderr: "",
        stdout: args[0] === "d1"
          ? JSON.stringify([{ name: "selinow-production", uuid: databaseId }])
          : `Account ID: ${accountId}`,
      }),
      workerSecretNames: [],
      wranglerConfig: wranglerConfig(),
    })).rejects.toThrow("production_migration_ledger_changed");
  });

  it("places admission immediately before the production migration sink", () => {
    const source = readFileSync("scripts/db.mjs", "utf8");
    const gate = source.indexOf("await assertProductionMigrationAdmission");
    const pin = source.indexOf("buildPinnedCloudflareEnvironment", gate);
    const sink = source.indexOf("runWrangler(wranglerArgs", gate);
    const postLedger = source.indexOf("await assertProductionMigrationLedger", sink);
    const postPreflight = source.indexOf("assertProductionDatabasePreflight", postLedger);
    const strictProviderSchema = source.indexOf("requirePaymentProviderSchema: true", postPreflight);

    expect(gate).toBeGreaterThan(-1);
    expect(pin).toBeGreaterThan(gate);
    expect(sink).toBeGreaterThan(gate);
    expect(postLedger).toBeGreaterThan(sink);
    expect(postPreflight).toBeGreaterThan(postLedger);
    expect(strictProviderSchema).toBeGreaterThan(postPreflight);
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

  it("rechecks manifest-pinned staging evidence before mutation and records migration completion", () => {
    const source = readFileSync("scripts/db.mjs", "utf8");
    const stagingGate = source.indexOf("if (requiresStagingDatabaseAdmission(operation, flags))");
    const firstRelease = source.indexOf("await assertStagingReleaseAdmission", stagingGate);
    const firstGate = source.indexOf("await assertStagingMutationAdmission", firstRelease);
    const continuation = source.indexOf("await assertStagingContinuationEvidenceByReference", firstGate);
    const finalGate = source.indexOf("await assertStagingMutationAdmission", firstGate + 1);
    const finalRelease = source.indexOf("await assertStagingReleaseAdmission", firstRelease + 1);
    const finalContinuation = source.indexOf("await assertStagingContinuationEvidenceByReference", continuation + 1);
    const stableTargetGuard = source.indexOf("staging_release_admission_changed", finalContinuation);
    const pin = source.indexOf("buildPinnedCloudflareEnvironment", finalGate);
    const migrationVerification = source.indexOf("await runStagingMigrationWithVerification", pin);
    const completeLedger = source.indexOf("await assertStagingMigrationLedger({", pin);
    const preflight = source.indexOf("assertStagingDatabasePreflight", completeLedger);
    const migrationSink = source.indexOf("runWrangler(wranglerArgs", migrationVerification);
    const migrationCompletion = source.indexOf("buildStagingMigrationCompletion", migrationSink);
    const projectedCompletionTarget = source.indexOf(
      "databaseTarget: databaseTargetFromAdmission(finalAdmission)",
      migrationSink,
    );
    const migrationCompletionWrite = source.indexOf("writeStagingMigrationCompletion", migrationCompletion);
    const seedSink = source.indexOf("runWrangler(wranglerArgs", migrationSink + 1);

    expect(firstRelease).toBeGreaterThan(-1);
    expect(firstRelease).toBeLessThan(firstGate);
    expect(firstGate).toBeGreaterThan(-1);
    expect(continuation).toBeGreaterThan(firstGate);
    expect(finalGate).toBeGreaterThan(continuation);
    expect(finalRelease).toBeGreaterThan(finalGate);
    expect(finalContinuation).toBeGreaterThan(finalRelease);
    expect(stableTargetGuard).toBeGreaterThan(finalContinuation);
    expect(pin).toBeGreaterThan(stableTargetGuard);
    expect(migrationVerification).toBeGreaterThan(pin);
    expect(migrationVerification).toBeLessThan(migrationSink);
    expect(completeLedger).toBeGreaterThan(pin);
    expect(completeLedger).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(seedSink);
    expect(migrationSink).toBeGreaterThan(pin);
    expect(migrationCompletion).toBeGreaterThan(migrationSink);
    expect(projectedCompletionTarget).toBeGreaterThan(migrationSink);
    expect(projectedCompletionTarget).toBeLessThan(migrationCompletionWrite);
    expect(migrationCompletionWrite).toBeGreaterThan(migrationCompletion);
    expect(seedSink).toBeGreaterThan(preflight);
  });

  it("finalizes staging only from a completed ledger and post-migration backup/restore", () => {
    const source = readFileSync("scripts/db.mjs", "utf8");
    const completionBranch = source.indexOf('if (operation === "complete-release")');
    const releaseAdmission = source.indexOf("await assertStagingReleaseAdmission", completionBranch);
    const projectedTarget = source.indexOf(
      "databaseTargetFromAdmission(await assertStagingMutationAdmission())",
      releaseAdmission,
    );
    const preEvidence = source.indexOf("await assertStagingContinuationEvidenceByReference", releaseAdmission);
    const completeLedger = source.indexOf("await assertStagingMigrationLedger", preEvidence);
    const migrationCompletion = source.indexOf("await assertStagingMigrationCompletion", completeLedger);
    const postEvidence = source.indexOf("await assertFreshStagingContinuationEvidence", migrationCompletion);
    const buildEvidence = source.indexOf("buildStagingPostMigrationEvidence", postEvidence);
    const writeEvidence = source.indexOf("writeStagingPostMigrationEvidence", buildEvidence);
    const validateEvidence = source.indexOf("await assertStagingPostMigrationEvidence", writeEvidence);

    expect(completionBranch).toBeGreaterThan(-1);
    expect(releaseAdmission).toBeGreaterThan(completionBranch);
    expect(projectedTarget).toBeGreaterThan(releaseAdmission);
    expect(projectedTarget).toBeLessThan(preEvidence);
    expect(preEvidence).toBeGreaterThan(releaseAdmission);
    expect(completeLedger).toBeGreaterThan(preEvidence);
    expect(migrationCompletion).toBeGreaterThan(completeLedger);
    expect(postEvidence).toBeGreaterThan(migrationCompletion);
    expect(buildEvidence).toBeGreaterThan(postEvidence);
    expect(writeEvidence).toBeGreaterThan(buildEvidence);
    expect(validateEvidence).toBeGreaterThan(writeEvidence);
  });
});
