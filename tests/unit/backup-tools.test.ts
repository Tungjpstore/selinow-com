import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  assertExactMigrationLedger,
  assertDistinctRestoreTarget,
  assertFreshStagingBackupEvidence,
  assertFreshProductionBootstrapBackupEvidence,
  buildBackupSnapshotRecord,
  buildRestoreDrillRecord,
  cleanupRestoreTempDirectory,
  createBackup,
  resolveDatabaseTarget,
  resolvePendingMigrationNames,
  restoreCountValidationTables,
  restoreValidationTables,
  runRestoreDrill,
} from "../../scripts/lib/backup.mjs";

const STAGING_ACCOUNT_ID = "ef250a88911fd24073cb73d1c07e0218";
const STAGING_DATABASE_ID = "c86d76a0-7407-42b6-ba92-f9f9623d0730";
const PRODUCTION_ACCOUNT_ID = "ab250a88911fd24073cb73d1c07e0218";
const PRODUCTION_DATABASE_ID = "d86d76a0-7407-42b6-ba92-f9f9623d0730";
const GENERATED_LICENSE_TABLES = [
  "generated_license_provider_connections",
  "generated_license_provider_credentials",
  "generated_license_resource_bindings",
  "generated_license_requirement_snapshots",
  "generated_license_requests",
  "generated_license_attempts",
  "generated_license_artifacts",
  "generated_license_dead_letters",
] as const;

const CONFIG = {
  d1_databases: [{
    binding: "PLATFORM_DB",
    database_id: "00000000-0000-0000-0000-000000000000",
    database_name: "selinow-local",
  }],
  env: {
    staging: {
      d1_databases: [{
        binding: "PLATFORM_DB",
        database_id: STAGING_DATABASE_ID,
        database_name: "selinow-staging",
      }],
    },
  },
};

const PRODUCTION_CONFIG = {
  ...CONFIG,
  env: {
    ...CONFIG.env,
    production: {
      d1_databases: [{
        binding: "PLATFORM_DB",
        database_id: PRODUCTION_DATABASE_ID,
        database_name: "selinow-production",
      }],
    },
  },
};

async function writeStagingBackupEvidence(root: string, completedAt: string) {
  const snapshotId = "bkp_20260726000000_010101010101";
  const snapshotDirectory = resolve(root, snapshotId);
  const artifact = "-- protected staging backup fixture\n";
  const checksum = createHash("sha256").update(artifact).digest("hex");
  await mkdir(snapshotDirectory, { recursive: true });
  await writeFile(resolve(snapshotDirectory, "database.sql"), artifact, "utf8");
  await writeFile(resolve(snapshotDirectory, "snapshot.json"), JSON.stringify({
    artifact: { format: "sql", path: "database.sql" },
    records: {
      backup_snapshots: [{
        checksum_sha256: checksum,
        completed_at: completedAt,
        environment: "staging",
        id: snapshotId,
        provider_reference: "bookmark-1234",
        resource_ref: "d1:selinow-staging",
        size_bytes: Buffer.byteLength(artifact),
        snapshot_kind: "time_travel",
        status: "available",
      }],
    },
    report_version: 2,
    source: {
      account_id: STAGING_ACCOUNT_ID,
      database_id: STAGING_DATABASE_ID,
      database_name: "selinow-staging",
      resource_ref: "d1:selinow-staging",
    },
  }), "utf8");
  return { snapshotDirectory, snapshotId };
}

async function writeProductionBackupEvidence(root: string, completedAt: string) {
  const snapshotId = "bkp_20260730000000_020202020202";
  const snapshotDirectory = resolve(root, snapshotId);
  const artifact = "-- protected production bootstrap backup fixture\n";
  const checksum = createHash("sha256").update(artifact).digest("hex");
  await mkdir(snapshotDirectory, { recursive: true });
  await writeFile(resolve(snapshotDirectory, "database.sql"), artifact, "utf8");
  await writeFile(resolve(snapshotDirectory, "snapshot.json"), JSON.stringify({
    artifact: { format: "sql", path: "database.sql" },
    records: {
      backup_snapshots: [{
        checksum_sha256: checksum,
        completed_at: completedAt,
        environment: "production",
        id: snapshotId,
        provider_reference: "bookmark-prod-1234",
        resource_ref: "d1:selinow-production",
        size_bytes: Buffer.byteLength(artifact),
        snapshot_kind: "time_travel",
        status: "available",
      }],
    },
    report_version: 2,
    source: {
      account_id: PRODUCTION_ACCOUNT_ID,
      database_id: PRODUCTION_DATABASE_ID,
      database_name: "selinow-production",
      resource_ref: "d1:selinow-production",
    },
  }), "utf8");
  return { snapshotDirectory, snapshotId };
}

describe("backup target safety", () => {
  it("resolves only the exact environment-owned PLATFORM_DB", () => {
    expect(resolveDatabaseTarget(CONFIG, "local")).toMatchObject({
      databaseName: "selinow-local",
      resourceRef: "d1:selinow-local",
    });
    expect(resolveDatabaseTarget(CONFIG, "staging")).toMatchObject({
      databaseId: STAGING_DATABASE_ID,
      databaseName: "selinow-staging",
    });
    expect(() => resolveDatabaseTarget(CONFIG, "production"))
      .toThrow("database_binding_missing:production");
    expect(() => resolveDatabaseTarget({
      ...CONFIG,
      env: { staging: { d1_databases: [{ binding: "PLATFORM_DB", database_id: STAGING_DATABASE_ID, database_name: "other-product" }] } },
    }, "staging")).toThrow("database_target_mismatch:staging");
  });

  it("never permits a restore target to equal or escape the generated product prefix", () => {
    expect(() => {
      assertDistinctRestoreTarget(
        "selinow-staging",
        "selinow-restore-drill-staging-a1b2c3d4e5f6",
        "staging",
      );
    }).not.toThrow();
    expect(() => {
      assertDistinctRestoreTarget("selinow-staging", "selinow-staging", "staging");
    })
      .toThrow("restore_target_matches_source");
    expect(() => {
      assertDistinctRestoreTarget("selinow-staging", "unowned-restore-target", "staging");
    })
      .toThrow("restore_target_invalid");
  });

  it("derives pending restore migrations only from an exact ledger prefix", () => {
    expect(resolvePendingMigrationNames(
      ["0001_platform.sql"],
      ["0001_platform.sql", "0002_catalog.sql"],
    )).toEqual(["0002_catalog.sql"]);
    expect(() => resolvePendingMigrationNames(
      ["0002_catalog.sql"],
      ["0001_platform.sql", "0002_catalog.sql"],
    )).toThrow("restore_migrations_incomplete");
    expect(() => resolvePendingMigrationNames(
      ["0001_platform.sql", "0002_catalog.sql", "0003_extra.sql"],
      ["0001_platform.sql", "0002_catalog.sql"],
    )).toThrow("restore_migrations_incomplete");
  });

  it("cleans only a direct temp child carrying the matching tool marker", async () => {
    const drillId = `rdr_test_${randomBytes(6).toString("hex")}`;
    const directory = await mkdtemp(join(tmpdir(), "selinow-restore-drill-"));
    await writeFile(resolve(directory, ".selinow-restore-drill"), `${drillId}\n`, "utf8");
    await mkdir(resolve(directory, "nested"));
    await cleanupRestoreTempDirectory(directory, drillId);
    expect(existsSync(directory)).toBe(false);

    const unrelated = await mkdtemp(join(tmpdir(), "unrelated-backup-test-"));
    try {
      await expect(cleanupRestoreTempDirectory(unrelated, drillId))
        .rejects.toThrow("restore_cleanup_target_invalid");
    } finally {
      await rm(unrelated, { force: true, recursive: true });
    }
  });
});

describe("operations report compatibility", () => {
  it("requires generic channel and domain delivery tables in every restored schema", () => {
    expect(restoreValidationTables).toEqual(expect.arrayContaining([
      "api_credentials",
      "shop_channels",
      "channel_connections",
      "channel_connection_grants",
      "channel_credentials",
      "delivery_grant_claims",
      "domain_events",
      "delivery_jobs",
      "digital_assets",
      "digital_asset_versions",
      "product_fulfillment_policies",
      "order_item_fulfillment_requirements",
      "digital_entitlements",
      "delivery_grants",
      "delivery_grant_consumptions",
      "entitlement_resources",
      "product_entitlement_policies",
      "order_item_entitlement_requirements",
      "entitlements",
      "entitlement_grants",
      "entitlement_transitions",
      "manual_fulfillment_executions",
      "external_fulfillment_references",
      "iso_4217_currency_codes",
      "payment_integrations",
      "payment_attempts",
      "payment_credentials",
      "payment_events",
      "payment_exceptions",
      "payment_reversal_events",
      "payment_method_codes",
      "payment_provider_connections",
      "payment_provider_connection_capabilities",
      "payment_provider_connection_currencies",
      "payment_provider_connection_methods",
      "data_export_jobs",
      "encryption_rotation_items",
      "encryption_rotation_runs",
      "fulfillment_items",
      "fulfillments",
      ...GENERATED_LICENSE_TABLES,
      "manual_fulfillment_executions",
      "external_fulfillment_references",
      "order_items",
      "shop_deletion_requests",
      "shop_deletion_steps",
    ]));
    expect(restoreCountValidationTables).toEqual(expect.arrayContaining([
      "data_export_jobs",
      "encryption_rotation_items",
      "encryption_rotation_runs",
      "fulfillment_items",
      "fulfillments",
      ...GENERATED_LICENSE_TABLES,
      "entitlement_resources",
      "product_entitlement_policies",
      "order_item_entitlement_requirements",
      "entitlements",
      "entitlement_grants",
      "entitlement_transitions",
      "payment_reversal_events",
      "order_items",
      "shop_deletion_requests",
      "shop_deletion_steps",
    ]));
  });

  it("accepts only the exact ordered repository migration ledger", () => {
    const firstMigration = "0025_backfill.sql";
    const repository = [firstMigration, "0026_outbox.sql"];
    expect(() => {
      assertExactMigrationLedger([...repository], repository);
    }).not.toThrow();
    expect(() => {
      assertExactMigrationLedger([firstMigration], repository);
    })
      .toThrow("restore_migrations_incomplete");
    expect(() => {
      assertExactMigrationLedger([...repository, "9999_unknown.sql"], repository);
    })
      .toThrow("restore_migrations_incomplete");
    expect(() => {
      assertExactMigrationLedger([...repository].reverse(), repository);
    })
      .toThrow("restore_migrations_incomplete");
  });

  it("builds records matching the Phase 9 backup_snapshots and restore_drills columns", () => {
    const snapshot = buildBackupSnapshotRecord({
      checksumSha256: "a".repeat(64),
      completedAt: "2026-07-26T00:01:00.000Z",
      createdAt: "2026-07-26T00:00:00.000Z",
      environment: "local",
      id: "bkp_test",
      itemCount: 7,
      requestId: "request-test",
      resourceRef: "d1:selinow-local",
      sizeBytes: 123,
      snapshotKind: "export",
      status: "available",
      updatedAt: "2026-07-26T00:01:00.000Z",
    });
    const drill = buildRestoreDrillRecord({
      backupSnapshotId: snapshot.id,
      completedAt: "2026-07-26T00:02:00.000Z",
      createdAt: "2026-07-26T00:00:00.000Z",
      environment: "isolated",
      foreignKeyViolationCount: 0,
      id: "rdr_test",
      integrityStatus: "ok",
      requestId: "request-test",
      restoredItemCount: 7,
      startedAt: "2026-07-26T00:01:00.000Z",
      status: "passed",
      targetResourceRef: "isolated:rdr_test",
      updatedAt: "2026-07-26T00:02:00.000Z",
    });

    expect(Object.keys(snapshot).sort()).toEqual([
      "checksum_sha256", "completed_at", "created_at", "environment", "expires_at",
      "id", "item_count", "last_safe_error_code", "provider_reference", "request_id",
      "requested_by_user_id", "resource_kind", "resource_ref", "scope_key", "shop_id",
      "size_bytes", "snapshot_kind", "status", "updated_at", "version",
    ].sort());
    expect(Object.keys(drill).sort()).toEqual([
      "backup_snapshot_id", "completed_at", "created_at", "environment",
      "foreign_key_violation_count", "id", "integrity_status", "last_safe_error_code",
      "request_id", "requested_by_user_id", "restored_item_count", "shop_id", "started_at",
      "status", "target_resource_ref", "updated_at", "version",
    ].sort());
  });
});

describe("backup CLI dry runs", () => {
  it("plans staging backup and restore without credentials or mutation", () => {
    for (const [script, expectedCode] of [
      ["scripts/backup.mjs", "capture_time_travel_bookmark"],
      ["scripts/restore-drill.mjs", "create_isolated_target"],
    ] as const) {
      const result = spawnSync(process.execPath, [script, "--env", "staging", "--dry-run", "--json"], {
        cwd: resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
        env: {},
      });
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as { actions: Array<{ code: string }>; ok: boolean };
      expect(payload.ok).toBe(true);
      expect(payload.actions.map((action) => action.code)).toContain(expectedCode);
      expect(result.stdout).not.toContain("token");
    }
  });

  it("requires explicit production confirmation before target discovery", () => {
    const result = spawnSync(process.execPath, ["scripts/backup.mjs", "--env", "production", "--dry-run", "--json"], {
      cwd: resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("production_confirmation_required");
  });

  it("admits only a fresh protected staging backup bound to the exact D1 target", async () => {
    const backupRoot = await mkdtemp(join(tmpdir(), "selinow-staging-backup-evidence-"));
    try {
      const completedAt = "2026-07-26T00:30:00.000Z";
      const { snapshotId } = await writeStagingBackupEvidence(backupRoot, completedAt);
      await expect(assertFreshStagingBackupEvidence({
        accountId: STAGING_ACCOUNT_ID,
        backupRoot,
        databaseId: STAGING_DATABASE_ID,
        databaseName: "selinow-staging",
        now: new Date("2026-07-26T01:00:00.000Z"),
      })).resolves.toMatchObject({ completedAt, snapshotId });

      await expect(assertFreshStagingBackupEvidence({
        accountId: STAGING_ACCOUNT_ID,
        backupRoot,
        databaseId: "11111111-1111-4111-8111-111111111111",
        databaseName: "selinow-staging",
        now: new Date("2026-07-26T01:00:00.000Z"),
      })).rejects.toThrow("staging_backup_evidence_target_mismatch");

      await expect(assertFreshStagingBackupEvidence({
        accountId: STAGING_ACCOUNT_ID,
        backupRoot,
        databaseId: STAGING_DATABASE_ID,
        databaseName: "selinow-staging",
        now: new Date("2026-07-26T02:00:00.001Z"),
      })).rejects.toThrow("staging_backup_evidence_stale");
    } finally {
      await rm(backupRoot, { force: true, recursive: true });
    }
  });

  it("rejects a modified or incomplete latest staging backup artifact", async () => {
    const backupRoot = await mkdtemp(join(tmpdir(), "selinow-staging-backup-evidence-"));
    try {
      const { snapshotDirectory } = await writeStagingBackupEvidence(
        backupRoot,
        "2026-07-26T00:30:00.000Z",
      );
      await writeFile(resolve(snapshotDirectory, "database.sql"), "modified", "utf8");
      await expect(assertFreshStagingBackupEvidence({
        accountId: STAGING_ACCOUNT_ID,
        backupRoot,
        databaseId: STAGING_DATABASE_ID,
        databaseName: "selinow-staging",
        now: new Date("2026-07-26T01:00:00.000Z"),
      })).rejects.toThrow("staging_backup_artifact_invalid");
    } finally {
      await rm(backupRoot, { force: true, recursive: true });
    }
  });

  it("admits a fresh production report-v2 backup only for the exact bootstrap D1 target", async () => {
    const backupRoot = await mkdtemp(join(tmpdir(), "selinow-production-backup-evidence-"));
    try {
      const completedAt = "2026-07-30T00:30:00.000Z";
      const { snapshotId } = await writeProductionBackupEvidence(backupRoot, completedAt);
      await expect(assertFreshProductionBootstrapBackupEvidence({
        accountId: PRODUCTION_ACCOUNT_ID,
        backupRoot,
        databaseId: PRODUCTION_DATABASE_ID,
        databaseName: "selinow-production",
        now: new Date("2026-07-30T01:00:00.000Z"),
      })).resolves.toMatchObject({ completedAt, providerBookmarkRecorded: true, snapshotId });

      await expect(assertFreshProductionBootstrapBackupEvidence({
        accountId: PRODUCTION_ACCOUNT_ID,
        backupRoot,
        databaseId: "11111111-1111-4111-8111-111111111111",
        databaseName: "selinow-production",
        now: new Date("2026-07-30T01:00:00.000Z"),
      })).rejects.toThrow("production_bootstrap_backup_target_mismatch");

      await expect(assertFreshProductionBootstrapBackupEvidence({
        accountId: PRODUCTION_ACCOUNT_ID,
        backupRoot,
        databaseId: PRODUCTION_DATABASE_ID,
        databaseName: "selinow-production",
        now: new Date("2026-07-31T01:00:00.001Z"),
      })).rejects.toThrow("production_bootstrap_backup_evidence_stale");
    } finally {
      await rm(backupRoot, { force: true, recursive: true });
    }
  });

  it("maps absent remote credentials to an actionable safe error", async () => {
    const secret = "MUST-NOT-ESCAPE";
    const failure = await createBackup({
      config: CONFIG,
      dryRun: false,
      environment: "staging",
      now: new Date("2026-07-26T00:00:00.000Z"),
      randomBytesImplementation: () => Buffer.alloc(6, 1),
      runner: () => {
        throw new Error(`provider rejected ${secret}`);
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("cloudflare_route_audit_api_token_missing");
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it("admits staging backup against live routes and pins every export command", async () => {
    const reportDirectory = resolve(
      import.meta.dirname,
      "../../.wrangler/backups/staging/bkp_20260726000000_010101010101",
    );
    const commands: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const operatorEnvironment = {
      CLOUDFLARE_PLATFORM_API_TOKEN: "platform-token",
      CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-token",
      KEEP_ME: "safe",
    };
    try {
      const result = await createBackup({
        config: CONFIG,
        dryRun: false,
        environment: "staging",
        now: new Date("2026-07-26T00:00:00.000Z"),
        operatorEnvironment,
        randomBytesImplementation: () => Buffer.alloc(6, 1),
        runner: (args, options) => {
          if (options?.env === undefined) throw new Error("test_runner_environment_missing");
          commands.push({ args, env: options.env });
          if (args[0] === "d1" && args[1] === "time-travel") {
            return { stderr: "", stdout: JSON.stringify({ bookmark: "bookmark-1234" }) };
          }
          if (args[0] === "d1" && args[1] === "export") {
            const outputPath = args[args.indexOf("--output") + 1];
            if (typeof outputPath !== "string") throw new Error("test_output_path_missing");
            writeFileSync(outputPath, "-- staging backup fixture\n");
          }
          return { stderr: "", stdout: "" };
        },
        stagingAdmissionImplementation: (input) => {
          expect(input.environment).toEqual(operatorEnvironment);
          expect(input.runWranglerImplementation).toBeDefined();
          return Promise.resolve({
            accountId: STAGING_ACCOUNT_ID,
            databaseId: STAGING_DATABASE_ID,
            databaseName: "selinow-staging",
          });
        },
      });

      expect(result.ok).toBe(true);
      const report: unknown = JSON.parse(
        await readFile(resolve(reportDirectory, "snapshot.json"), "utf8"),
      );
      expect(report).toMatchObject({
        report_version: 2,
        source: {
          account_id: STAGING_ACCOUNT_ID,
          database_id: STAGING_DATABASE_ID,
          database_name: "selinow-staging",
          resource_ref: "d1:selinow-staging",
        },
      });
      expect(commands.map(({ args }) => args.slice(0, 2))).toEqual([
        ["d1", "time-travel"],
        ["d1", "export"],
      ]);
      expect(commands.every(({ env }) => (
        env.CLOUDFLARE_ACCOUNT_ID === STAGING_ACCOUNT_ID
        && !Object.prototype.hasOwnProperty.call(env, "CLOUDFLARE_PLATFORM_API_TOKEN")
        && !Object.prototype.hasOwnProperty.call(env, "CLOUDFLARE_ROUTE_AUDIT_API_TOKEN")
        && env.KEEP_ME === "safe"
      ))).toBe(true);
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  });

  it("rejects a staging backup when the admitted database differs from the configured target", async () => {
    const runner = vi.fn();
    await expect(createBackup({
      config: CONFIG,
      dryRun: false,
      environment: "staging",
      operatorEnvironment: {
        CLOUDFLARE_PLATFORM_API_TOKEN: "platform-token",
        CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-token",
      },
      runner,
      stagingAdmissionImplementation: () => Promise.resolve({
        accountId: STAGING_ACCOUNT_ID,
        databaseId: "11111111-1111-4111-8111-111111111111",
        databaseName: "selinow-staging",
      }),
    })).rejects.toThrow("staging_backup_database_target_mismatch");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a wrong ambient production account before any backup sink", async () => {
    const commands: Array<{ accountId: string | undefined; args: string[] }> = [];
    const operatorEnvironment = {
      CLOUDFLARE_PLATFORM_API_TOKEN: "platform-token",
      KEEP_ME: "safe",
    };
    const runner = (args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      commands.push({ accountId: options?.env?.CLOUDFLARE_ACCOUNT_ID, args });
      if (args[0] === "whoami") {
        return {
          stderr: "",
          stdout: JSON.stringify({
            accounts: [{ id: "b".repeat(32), name: "Wrong ambient account" }],
            loggedIn: true,
          }),
        };
      }
      if (args[0] === "d1" && args[1] === "list") {
        return {
          stderr: "",
          stdout: JSON.stringify([{ name: "selinow-production", uuid: PRODUCTION_DATABASE_ID }]),
        };
      }
      throw new Error("backup_sink_reached");
    };

    await expect(createBackup({
      config: PRODUCTION_CONFIG,
      dryRun: false,
      environment: "production",
      operatorEnvironment,
      productionIdentityImplementation: () => Promise.resolve({
        accountId: PRODUCTION_ACCOUNT_ID,
        databaseId: PRODUCTION_DATABASE_ID,
        databaseName: "selinow-production",
      }),
      runner,
    })).rejects.toThrow("restore_account_mismatch:production");
    expect(commands).toEqual([{
      accountId: PRODUCTION_ACCOUNT_ID,
      args: ["whoami", "--json"],
    }]);
  });

  it("rejects a same-name production D1 with the wrong UUID before any backup sink", async () => {
    const commands: Array<{ accountId: string | undefined; args: string[] }> = [];
    const runner = (args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      commands.push({ accountId: options?.env?.CLOUDFLARE_ACCOUNT_ID, args });
      if (args[0] === "whoami") {
        return {
          stderr: "",
          stdout: JSON.stringify({
            accounts: [{ id: PRODUCTION_ACCOUNT_ID, name: "Approved account" }],
            loggedIn: true,
          }),
        };
      }
      if (args[0] === "d1" && args[1] === "list") {
        return {
          stderr: "",
          stdout: JSON.stringify([{
            name: "selinow-production",
            uuid: "11111111-1111-4111-8111-111111111111",
          }]),
        };
      }
      throw new Error("backup_sink_reached");
    };

    await expect(createBackup({
      config: PRODUCTION_CONFIG,
      dryRun: false,
      environment: "production",
      productionIdentityImplementation: () => Promise.resolve({
        accountId: PRODUCTION_ACCOUNT_ID,
        databaseId: PRODUCTION_DATABASE_ID,
        databaseName: "selinow-production",
      }),
      runner,
    })).rejects.toThrow("restore_database_mismatch:production");
    expect(commands.map(({ args }) => args.slice(0, 2))).toEqual([
      ["whoami", "--json"],
      ["d1", "list"],
    ]);
    expect(commands.every(({ accountId }) => accountId === PRODUCTION_ACCOUNT_ID)).toBe(true);
  });

  it("pins every admitted production backup command and records the approved identity", async () => {
    const reportDirectory = resolve(
      import.meta.dirname,
      "../../.wrangler/backups/production/bkp_20260726000000_060606060606",
    );
    const commands: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const operatorEnvironment = {
      CLOUDFLARE_PLATFORM_API_TOKEN: "platform-token",
      CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-token",
      KEEP_ME: "safe",
    };
    try {
      const result = await createBackup({
        config: PRODUCTION_CONFIG,
        dryRun: false,
        environment: "production",
        now: new Date("2026-07-26T00:00:00.000Z"),
        operatorEnvironment,
        productionIdentityImplementation: () => Promise.resolve({
          accountId: PRODUCTION_ACCOUNT_ID,
          databaseId: PRODUCTION_DATABASE_ID,
          databaseName: "selinow-production",
        }),
        randomBytesImplementation: () => Buffer.alloc(6, 6),
        runner: (args, options) => {
          if (options?.env === undefined) throw new Error("test_runner_environment_missing");
          commands.push({ args, env: options.env });
          if (args[0] === "whoami") {
            return {
              stderr: "",
              stdout: JSON.stringify({
                accounts: [{ id: PRODUCTION_ACCOUNT_ID, name: "Approved account" }],
                loggedIn: true,
              }),
            };
          }
          if (args[0] === "d1" && args[1] === "list") {
            return {
              stderr: "",
              stdout: JSON.stringify([{ name: "selinow-production", uuid: PRODUCTION_DATABASE_ID }]),
            };
          }
          if (args[0] === "d1" && args[1] === "time-travel") {
            return { stderr: "", stdout: JSON.stringify({ bookmark: "bookmark-production" }) };
          }
          if (args[0] === "d1" && args[1] === "export") {
            const outputPath = args[args.indexOf("--output") + 1];
            if (typeof outputPath !== "string") throw new Error("test_output_path_missing");
            writeFileSync(outputPath, "-- production backup fixture\n");
          }
          return { stderr: "", stdout: "" };
        },
      });

      expect(result.ok).toBe(true);
      const report: unknown = JSON.parse(
        await readFile(resolve(reportDirectory, "snapshot.json"), "utf8"),
      );
      expect(report).toMatchObject({
        report_version: 2,
        source: {
          account_id: PRODUCTION_ACCOUNT_ID,
          database_id: PRODUCTION_DATABASE_ID,
          database_name: "selinow-production",
          resource_ref: "d1:selinow-production",
        },
      });
      expect(commands.map(({ args }) => args.slice(0, 2))).toEqual([
        ["whoami", "--json"],
        ["d1", "list"],
        ["d1", "time-travel"],
        ["d1", "export"],
      ]);
      expect(commands.every(({ env }) => (
        env.CLOUDFLARE_ACCOUNT_ID === PRODUCTION_ACCOUNT_ID
        && !Object.prototype.hasOwnProperty.call(env, "CLOUDFLARE_PLATFORM_API_TOKEN")
        && !Object.prototype.hasOwnProperty.call(env, "CLOUDFLARE_ROUTE_AUDIT_API_TOKEN")
        && env.KEEP_ME === "safe"
      ))).toBe(true);
      expect(JSON.stringify(report)).not.toContain("platform-token");
      expect(JSON.stringify(report)).not.toContain("route-token");
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  });

  it("rejects an ambient Wrangler account before creating a remote restore target", async () => {
    const reportPath = resolve(
      import.meta.dirname,
      "../../.wrangler/restore-drills/staging/rdr_20260726000000_030303030303.json",
    );
    const commands: Array<{ args: string[]; accountId: string | undefined }> = [];
    try {
      const failure = await runRestoreDrill({
        config: CONFIG,
        dryRun: false,
        environment: "staging",
        now: new Date("2026-07-26T00:00:00.000Z"),
        randomBytesImplementation: () => Buffer.alloc(6, 3),
        runner: (args, options) => {
          commands.push({ args, accountId: options?.env?.CLOUDFLARE_ACCOUNT_ID });
          if (args[0] === "whoami") {
            return {
              stderr: "",
              stdout: JSON.stringify({
                accounts: [{ id: "a".repeat(32), name: "Wrong account" }],
                loggedIn: true,
              }),
            };
          }
          if (args[0] === "d1" && args[1] === "list") {
            return {
              stderr: "",
              stdout: JSON.stringify([{ name: "selinow-staging", uuid: STAGING_DATABASE_ID }]),
            };
          }
          return { stderr: "", stdout: "" };
        },
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("restore_account_mismatch:staging");
      expect(commands.some(({ args }) => args[0] === "d1" && args[1] === "create"))
        .toBe(false);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        accountId: STAGING_ACCOUNT_ID,
        args: ["whoami", "--json"],
      });
    } finally {
      await rm(reportPath, { force: true });
    }
  });

  it("rejects a same-name D1 from the approved account before target creation", async () => {
    const reportPath = resolve(
      import.meta.dirname,
      "../../.wrangler/restore-drills/staging/rdr_20260726000000_040404040404.json",
    );
    const commands: Array<{ args: string[]; accountId: string | undefined }> = [];
    try {
      const failure = await runRestoreDrill({
        config: CONFIG,
        dryRun: false,
        environment: "staging",
        now: new Date("2026-07-26T00:00:00.000Z"),
        randomBytesImplementation: () => Buffer.alloc(6, 4),
        runner: (args, options) => {
          commands.push({ args, accountId: options?.env?.CLOUDFLARE_ACCOUNT_ID });
          if (args[0] === "whoami") {
            return {
              stderr: "",
              stdout: JSON.stringify({
                accounts: [{ id: STAGING_ACCOUNT_ID, name: "Approved account" }],
                loggedIn: true,
              }),
            };
          }
          if (args[0] === "d1" && args[1] === "list") {
            return {
              stderr: "",
              stdout: JSON.stringify([{
                name: "selinow-staging",
                uuid: "11111111-1111-4111-8111-111111111111",
              }]),
            };
          }
          return { stderr: "", stdout: "" };
        },
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("restore_database_mismatch:staging");
      expect(commands.some(({ args }) => args[0] === "d1" && args[1] === "create"))
        .toBe(false);
      expect(commands.map(({ args }) => args.slice(0, 2))).toEqual([
        ["whoami", "--json"],
        ["d1", "list"],
      ]);
      expect(commands.every(({ accountId }) => accountId === STAGING_ACCOUNT_ID)).toBe(true);
    } finally {
      await rm(reportPath, { force: true });
    }
  });

  it("pins every successful remote restore command to the approved account", async () => {
    const reportPath = resolve(
      import.meta.dirname,
      "../../.wrangler/restore-drills/staging/rdr_20260726000000_050505050505.json",
    );
    const migrationNames = readdirSync(resolve(import.meta.dirname, "../../migrations"))
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .sort();
    const latestMigration = migrationNames.at(-1);
    if (latestMigration === undefined) throw new Error("migration_ledger_empty");
    expect(migrationNames).toContain("0030_order_checkout_cart_reference.sql");
    const commands: Array<{
      accountId: string | undefined;
      args: string[];
      ci: string | undefined;
    }> = [];
    let migrationLedgerQueries = 0;
    try {
      const result = await runRestoreDrill({
        config: CONFIG,
        dryRun: false,
        environment: "staging",
        now: new Date("2026-07-26T00:00:00.000Z"),
        randomBytesImplementation: () => Buffer.alloc(6, 5),
        runner: (args, options) => {
          commands.push({
            accountId: options?.env?.CLOUDFLARE_ACCOUNT_ID,
            args,
            ci: options?.env?.CI,
          });
          if (args[0] === "whoami") {
            return {
              stderr: "",
              stdout: JSON.stringify({
                accounts: [{ id: STAGING_ACCOUNT_ID, name: "Approved account" }],
                loggedIn: true,
              }),
            };
          }
          if (args[0] === "d1" && args[1] === "list") {
            return {
              stderr: "",
              stdout: JSON.stringify([{ name: "selinow-staging", uuid: STAGING_DATABASE_ID }]),
            };
          }
          if (args[0] === "d1" && args[1] === "export") {
            const outputIndex = args.indexOf("--output");
            const outputPath = args[outputIndex + 1];
            if (typeof outputPath !== "string") throw new Error("test_output_path_missing");
            writeFileSync(outputPath, "CREATE TABLE restored_fixture (id TEXT);\n");
            return { stderr: "", stdout: "" };
          }
          if (args[0] === "d1" && args[1] === "execute" && args.includes("--command")) {
            const sql = args[args.indexOf("--command") + 1] ?? "";
            if (sql.includes("FROM d1_migrations")) {
              migrationLedgerQueries += 1;
              return {
                stderr: "",
                stdout: JSON.stringify([{
                  results: (migrationLedgerQueries === 1 ? migrationNames.slice(0, -1) : migrationNames)
                    .map((name) => ({ name })),
                }]),
              };
            }
            if (sql.startsWith("INSERT INTO d1_migrations")) {
              return { stderr: "", stdout: JSON.stringify([{ results: [] }]) };
            }
            if (sql.includes("FROM sqlite_master")) {
              const source = args[2] === "selinow-staging";
              return {
                stderr: "",
                stdout: JSON.stringify([{
                  results: (source ? ["shops"] : restoreValidationTables).map((name) => ({ name })),
                }]),
              };
            }
            if (args[2] === "selinow-staging") {
              return {
                stderr: "",
                stdout: JSON.stringify([{ results: [{ shops: 6 }] }]),
              };
            }
            return {
              stderr: "",
              stdout: JSON.stringify([{
                results: [{
                  delivery_grant_consumptions: 8,
                  delivery_grants: 9,
                  external_fulfillment_references: 15,
                  digital_asset_versions: 10,
                  digital_assets: 11,
                  digital_entitlements: 12,
                  manual_fulfillment_executions: 16,
                  inventory_keys: 1,
                  order_item_fulfillment_requirements: 13,
                  orders: 2,
                  payment_attempts: 3,
                  product_fulfillment_policies: 14,
                  products: 4,
                  shop_domains: 5,
                  shops: 6,
                  telegram_integrations: 7,
                }],
              }]),
            };
          }
          return { stderr: "", stdout: "" };
        },
      });

      expect(result.ok).toBe(true);
      expect(commands.every(({ accountId }) => accountId === STAGING_ACCOUNT_ID)).toBe(true);
      expect(commands.some(({ args }) => args[0] === "d1" && args[1] === "create")).toBe(true);
      expect(commands.some(({ args }) => args[0] === "d1" && args[1] === "export")).toBe(true);
      expect(commands.some(({ args }) => args[0] === "d1" && args[1] === "execute" && args.includes("--file")))
        .toBe(true);
      expect(commands.some(({ args }) => args[0] === "d1" && args[1] === "migrations"))
        .toBe(false);
      expect(commands.some(({ args, ci }) => (
        args[0] === "d1"
        && args[1] === "execute"
        && args.includes("--file")
        && args.some((argument) => argument.endsWith(latestMigration))
        && ci === "1"
      ))).toBe(true);
      expect(commands.filter(({ args }) => args[0] === "d1" && args[1] === "execute" && args.includes("--command")))
        .toHaveLength(7);
      expect(commands.some(({ args }) => args[0] === "d1" && args[1] === "delete")).toBe(true);
    } finally {
      await rm(reportPath, { force: true });
    }
  });

  it("rejects a remote restore when an authoritative table loses a row", async () => {
    const reportPath = resolve(
      import.meta.dirname,
      "../../.wrangler/restore-drills/staging/rdr_20260726000000_060606060606.json",
    );
    const migrationNames = readdirSync(resolve(import.meta.dirname, "../../migrations"))
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .sort();
    const sourceCounts: Record<string, number> = Object.fromEntries(
      restoreCountValidationTables.map((table, index) => [table, index + 1]),
    );
    const commands: string[][] = [];
    try {
      const failure = await runRestoreDrill({
        config: CONFIG,
        dryRun: false,
        environment: "staging",
        now: new Date("2026-07-26T00:00:00.000Z"),
        randomBytesImplementation: () => Buffer.alloc(6, 6),
        runner: (args) => {
          commands.push(args);
          if (args[0] === "whoami") {
            return {
              stderr: "",
              stdout: JSON.stringify({
                accounts: [{ id: STAGING_ACCOUNT_ID, name: "Approved account" }],
                loggedIn: true,
              }),
            };
          }
          if (args[0] === "d1" && args[1] === "list") {
            return {
              stderr: "",
              stdout: JSON.stringify([{ name: "selinow-staging", uuid: STAGING_DATABASE_ID }]),
            };
          }
          if (args[0] === "d1" && args[1] === "export") {
            const outputPath = args[args.indexOf("--output") + 1];
            if (typeof outputPath !== "string") throw new Error("test_output_path_missing");
            writeFileSync(outputPath, "CREATE TABLE restored_fixture (id TEXT);\n");
            return { stderr: "", stdout: "" };
          }
          if (args[0] === "d1" && args[1] === "execute" && args.includes("--command")) {
            const sql = args[args.indexOf("--command") + 1] ?? "";
            if (sql.includes("FROM d1_migrations")) {
              return {
                stderr: "",
                stdout: JSON.stringify([{ results: migrationNames.map((name) => ({ name })) }]),
              };
            }
            if (sql === "PRAGMA integrity_check;") {
              return {
                stderr: "",
                stdout: JSON.stringify([{ results: [{ integrity_check: "ok" }] }]),
              };
            }
            if (sql === "PRAGMA foreign_key_check;") {
              return { stderr: "", stdout: JSON.stringify([{ results: [] }]) };
            }
            if (sql.includes("FROM sqlite_master")) {
              const source = args[2] === "selinow-staging";
              return {
                stderr: "",
                stdout: JSON.stringify([{
                  results: (source ? restoreCountValidationTables : restoreValidationTables)
                    .map((name) => ({ name })),
                }]),
              };
            }
            if (!sql.includes("COUNT(*)")) return { stderr: "", stdout: "" };
            const aliases = Array.from(sql.matchAll(/\) AS ([a-z][a-z0-9_]*)/gu), (match) => match[1])
              .filter((table): table is string => table !== undefined);
            const counts: Record<string, number> = Object.fromEntries(
              aliases.map((table) => [table, sourceCounts[table] ?? 0]),
            );
            if (args[2] !== "selinow-staging") {
              counts.generated_license_requests = (counts.generated_license_requests ?? 0) - 1;
            }
            return {
              stderr: "",
              stdout: JSON.stringify([{ results: [counts] }]),
            };
          }
          return { stderr: "", stdout: "" };
        },
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("restore_count_mismatch");
      expect(commands.some((args) => args[0] === "d1" && args[1] === "delete")).toBe(true);
      const countQuery = commands.find((args) => (
        args[0] === "d1" && args[1] === "execute" && args.includes("--command")
        && (args[args.indexOf("--command") + 1] ?? "").includes("COUNT(*)")
      ));
      const countSql = countQuery?.[countQuery.indexOf("--command") + 1];
      for (const table of GENERATED_LICENSE_TABLES) expect(countSql).toContain(table);
      expect(countSql).toContain("payment_reversal_events");
      expect(countQuery?.[countQuery.indexOf("--command") + 1]).toContain("data_export_jobs");
      expect(countQuery?.[countQuery.indexOf("--command") + 1]).toContain("manual_fulfillment_executions");
      expect(countQuery?.[countQuery.indexOf("--command") + 1]).toContain("external_fulfillment_references");
    } finally {
      await rm(reportPath, { force: true });
    }
  });

  it("rejects an empty remote export before importing the isolated target", async () => {
    const now = new Date("2026-07-26T00:00:00.000Z");
    const reportPath = resolve(
      import.meta.dirname,
      "../../.wrangler/restore-drills/staging/rdr_20260726000000_020202020202.json",
    );
    const commands: Array<{ args: string[]; accountId: string | undefined }> = [];
    try {
      const failure = await runRestoreDrill({
        config: CONFIG,
        dryRun: false,
        environment: "staging",
        now,
        randomBytesImplementation: () => Buffer.alloc(6, 2),
        runner: (args, options) => {
          commands.push({ args, accountId: options?.env?.CLOUDFLARE_ACCOUNT_ID });
          if (args[0] === "whoami") {
            return {
              stderr: "",
              stdout: JSON.stringify({
                accounts: [{ id: STAGING_ACCOUNT_ID, name: "Approved account" }],
                loggedIn: true,
              }),
            };
          }
          if (args[0] === "d1" && args[1] === "list") {
            return {
              stderr: "",
              stdout: JSON.stringify([{ name: "selinow-staging", uuid: STAGING_DATABASE_ID }]),
            };
          }
          if (args[0] === "d1" && args[1] === "execute" && args.includes("--command")) {
            const sql = args[args.indexOf("--command") + 1] ?? "";
            if (sql.includes("FROM sqlite_master")) {
              return {
                stderr: "",
                stdout: JSON.stringify([{ results: [{ name: "shops" }] }]),
              };
            }
            return {
              stderr: "",
              stdout: JSON.stringify([{
                results: [{
                  delivery_grant_consumptions: 0,
                  delivery_grants: 0,
                  external_fulfillment_references: 0,
                  digital_asset_versions: 0,
                  digital_assets: 0,
                  digital_entitlements: 0,
                  manual_fulfillment_executions: 0,
                  inventory_keys: 0,
                  order_item_fulfillment_requirements: 0,
                  orders: 0,
                  payment_attempts: 0,
                  product_fulfillment_policies: 0,
                  products: 0,
                  shop_domains: 0,
                  shops: 0,
                  telegram_integrations: 0,
                }],
              }]),
            };
          }
          if (args[0] === "d1" && args[1] === "export") {
            const outputIndex = args.indexOf("--output");
            const outputPath = args[outputIndex + 1];
            if (typeof outputPath !== "string") throw new Error("test_output_path_missing");
            writeFileSync(outputPath, "");
          }
          return { stderr: "", stdout: "" };
        },
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("database_export_empty");
      expect(commands.some(({ args }) => args[0] === "d1" && args[1] === "execute" && args.includes("--file")))
        .toBe(false);
      expect(commands.some(({ args }) => args[0] === "d1" && args[1] === "delete"))
        .toBe(true);
      expect(commands.every(({ accountId }) => accountId === STAGING_ACCOUNT_ID)).toBe(true);
    } finally {
      await rm(reportPath, { force: true });
    }
  });
});
