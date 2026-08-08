import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import * as releaseModule from "../../scripts/lib/release.mjs";
import {
  assertProductionContinuationDeployAdmission,
} from "../../scripts/lib/release.mjs";

const identity = {
  accountId: "abcdef0123456789abcdef0123456789",
  databaseId: "17ea8f2f-4c97-4337-8989-28b25a58ddeb",
  databaseName: "selinow-production",
  reviewedCommitSha: "c".repeat(40),
};

describe("production Worker continuation deploy admission", () => {
  it("returns stable backup and restore fingerprints for deploy rechecks", async () => {
    const implementation = vi.fn(() => Promise.resolve({
      backup: {
        checksumSha256: "a".repeat(64),
        snapshotId: "bkp_20260802000000_aaaaaaaaaaaa",
      },
      restore: {
        reportRef: ".wrangler/restore-drills/production/rdr_20260802010000_bbbbbbbbbbbb.json",
        snapshotId: "bkp_20260802010000_bbbbbbbbbbbb",
      },
    }));

    await expect(assertProductionContinuationDeployAdmission({
      ...identity,
      assertContinuationEvidenceImplementation: implementation,
      repositoryRoot: process.cwd(),
    })).resolves.toEqual({
      backupChecksumSha256: "a".repeat(64),
      backupSnapshotId: "bkp_20260802000000_aaaaaaaaaaaa",
      restoreReportRef: ".wrangler/restore-drills/production/rdr_20260802010000_bbbbbbbbbbbb.json",
      restoreSnapshotId: "bkp_20260802010000_bbbbbbbbbbbb",
      reviewedCommitSha: identity.reviewedCommitSha,
    });
    expect(implementation).toHaveBeenCalledWith(expect.objectContaining(identity));
  });

  it("fails closed when an injected continuation validator returns incomplete evidence", async () => {
    await expect(assertProductionContinuationDeployAdmission({
      ...identity,
      assertContinuationEvidenceImplementation: () => Promise.resolve({
        backup: { checksumSha256: "invalid", snapshotId: "historical" },
        restore: { reportRef: "restore-report", snapshotId: "restore" },
      }),
      repositoryRoot: process.cwd(),
    })).rejects.toThrow("production_continuation_evidence_invalid");
  });

  it("requires the complete live production ledger, preflight and post-migration contract", async () => {
    const admission = (releaseModule as Record<string, unknown>).assertProductionDatabaseDeployAdmission;
    expect(typeof admission).toBe("function");
    if (typeof admission !== "function") return;

    const migrationNames = readdirSync("migrations")
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
      .sort();
    expect(migrationNames).not.toHaveLength(0);
    expect(migrationNames.every((name, index) => Number(name.slice(0, 4)) === index + 1)).toBe(true);
    const events: string[] = [];
    const result = await (admission as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      assertDatabaseInvariantContractImplementation: () => {
        events.push("invariants");
        return { checks: [{ code: "production_invariants", ok: true }], ok: true };
      },
      assertDatabasePreflightImplementation: () => {
        events.push("preflight");
        return { checks: [{ code: "production_preflight", ok: true }], ok: true };
      },
      assertMigrationLedgerImplementation: () => {
        events.push("ledger");
        return Promise.resolve({ migrationNames });
      },
      assertPostMigrationContractImplementation: () => {
        events.push("post-migration");
        return { columnCount: 10, mismatchCount: 0, objectCount: 10, ok: true, violationCount: 0 };
      },
      environment: { CLOUDFLARE_ACCOUNT_ID: identity.accountId },
      migrationNames,
      repositoryRoot: process.cwd(),
    });

    expect(events).toEqual(["ledger", "preflight", "post-migration", "invariants"]);
    expect(result).toMatchObject({ migrationNames });
    expect(result.preflightFingerprintSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.postMigrationFingerprintSha256).toMatch(/^[a-f0-9]{64}$/u);

    const changedInformationalDetail = await (admission as (
      input: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>)({
      assertDatabaseInvariantContractImplementation: () => ({ checks: [{ code: "production_invariants", ok: true }], ok: true }),
      assertDatabasePreflightImplementation: () => ({
        checks: [{ code: "production_preflight", detail: "normal_live_count_changed", ok: true }],
        ok: true,
      }),
      assertMigrationLedgerImplementation: () => Promise.resolve({ migrationNames }),
      assertPostMigrationContractImplementation: () => ({ columnCount: 10, mismatchCount: 0, objectCount: 10, ok: true, violationCount: 0 }),
      repositoryRoot: process.cwd(),
    });
    expect(changedInformationalDetail.preflightFingerprintSha256).toBe(result.preflightFingerprintSha256);
  });

  it("rejects a partial live production ledger before preflight", async () => {
    const admission = (releaseModule as Record<string, unknown>).assertProductionDatabaseDeployAdmission;
    expect(typeof admission).toBe("function");
    if (typeof admission !== "function") return;

    const migrationNames = [
      "0001_first.sql",
      "0002_second.sql",
      "0003_third.sql",
      "0004_fourth.sql",
    ];
    const preflight = vi.fn();
    await expect((admission as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      assertDatabasePreflightImplementation: preflight,
      assertMigrationLedgerImplementation: () => Promise.resolve({ migrationNames: migrationNames.slice(0, -1) }),
      assertPostMigrationContractImplementation: vi.fn(),
      migrationNames,
      repositoryRoot: process.cwd(),
    })).rejects.toThrow("production_deploy_migration_ledger_incomplete");
    expect(preflight).not.toHaveBeenCalled();
  });

  it("rejects a non-contiguous source ledger before querying production", async () => {
    const admission = (releaseModule as Record<string, unknown>).assertProductionDatabaseDeployAdmission;
    expect(typeof admission).toBe("function");
    if (typeof admission !== "function") return;

    const root = mkdtempSync(join(tmpdir(), "selinow-noncontiguous-ledger-"));
    try {
      mkdirSync(join(root, "migrations"));
      writeFileSync(join(root, "migrations/0001_first.sql"), "SELECT 1;\n");
      writeFileSync(join(root, "migrations/0003_third.sql"), "SELECT 3;\n");
      const ledger = vi.fn();
      await expect((admission as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
        assertDatabasePreflightImplementation: vi.fn(),
        assertMigrationLedgerImplementation: ledger,
        assertPostMigrationContractImplementation: vi.fn(),
        repositoryRoot: root,
      })).rejects.toThrow("production_deploy_source_migration_ledger_invalid");
      expect(ledger).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("proves the reviewed 0087 through 0089 schema definitions and live data invariants", () => {
    const assertInvariants = (releaseModule as Record<string, unknown>).assertProductionDatabaseInvariantContract;
    expect(typeof assertInvariants).toBe("function");
    if (typeof assertInvariants !== "function") return;
    const migrationNames = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort();
    const database = new DatabaseSync(":memory:");
    for (const name of migrationNames) {
      database.exec(readFileSync(join("migrations", name), "utf8"));
    }
    const runner = vi.fn((args: string[]) => {
      const commandIndex = args.indexOf("--command");
      const sql = args[commandIndex + 1];
      if (sql === undefined) throw new Error("missing_sql");
      return {
        stdout: JSON.stringify([{ results: database.prepare(sql).all(), success: true }]),
      };
    });

    const result = (assertInvariants as (input: Record<string, unknown>) => {
      checks: Array<{ ok: boolean }>;
      invariantNames: string[];
      ok: boolean;
    })({ migrationNames, repositoryRoot: process.cwd(), runWranglerImplementation: runner });

    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(result.invariantNames).toEqual(expect.arrayContaining([
      "shop_subscriptions_trial_claim_insert_guard",
      "payment_integrations_payos_claim_state_insert_guard",
      "idx_payment_integrations_provider_claim_nonce",
      "payment_integrations_payos_claim_fingerprint_update_guard",
    ]));
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("rejects altered invariant definitions, live violations and unreviewed migration slots", () => {
    const assertInvariants = (releaseModule as Record<string, unknown>).assertProductionDatabaseInvariantContract;
    expect(typeof assertInvariants).toBe("function");
    if (typeof assertInvariants !== "function") return;
    const migrationNames = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort();
    const database = new DatabaseSync(":memory:");
    for (const name of migrationNames) {
      database.exec(readFileSync(join("migrations", name), "utf8"));
    }
    const runner = (mutate: (rows: Array<Record<string, unknown>>, sql: string) => void) => vi.fn((args: string[]) => {
      const sql = args[args.indexOf("--command") + 1];
      if (sql === undefined) throw new Error("missing_sql");
      const rows = database.prepare(sql).all() as Array<Record<string, unknown>>;
      mutate(rows, sql);
      return { stdout: JSON.stringify([{ results: rows, success: true }]) };
    });
    const alteredDefinition = runner((rows) => {
      const trigger = rows.find((row) => row.name === "shop_subscriptions_trial_claim_insert_guard");
      if (trigger !== undefined) trigger.sql = "CREATE TRIGGER shop_subscriptions_trial_claim_insert_guard AFTER INSERT ON shop_subscriptions BEGIN SELECT 1; END";
    });
    expect(() => (assertInvariants as (input: Record<string, unknown>) => unknown)({
      migrationNames,
      runWranglerImplementation: alteredDefinition,
    })).toThrow("production_database_invariant_definition_mismatch:trigger:shop_subscriptions_trial_claim_insert_guard");

    const violation = runner((rows, sql) => {
      if (sql.includes("integrity_0088_provider_claim_state") && rows[0] !== undefined) {
        rows[0].integrity_0088_provider_claim_state = 1;
      }
    });
    expect(() => (assertInvariants as (input: Record<string, unknown>) => unknown)({
      migrationNames,
      runWranglerImplementation: violation,
    })).toThrow("production_database_invariant_data_violation:integrity_0088_provider_claim_state");

    expect(() => (assertInvariants as (input: Record<string, unknown>) => unknown)({
      migrationNames: [...migrationNames, "0090_future.sql"],
      runWranglerImplementation: vi.fn(),
    })).toThrow("production_database_invariant_registry_incomplete:0090_future.sql");
  });

  it("places complete production database admission before and after the build", () => {
    const source = readFileSync("scripts/deploy.mjs", "utf8");
    const build = source.indexOf('run("npm", ["run", "build"]');
    const firstDatabaseAdmission = source.indexOf("await assertProductionDatabaseDeployAdmission");
    const secondDatabaseAdmission = source.indexOf(
      "await assertProductionDatabaseDeployAdmission",
      firstDatabaseAdmission + 1,
    );
    const stableDatabaseGuard = source.indexOf("production_database_admission_changed", secondDatabaseAdmission);
    const candidateDriftGuard = source.indexOf(
      "finalAdmission.candidateWorkerVersion !== productionAdmission.candidateWorkerVersion",
      secondDatabaseAdmission,
    );
    const rollbackArtifactDriftGuard = source.indexOf(
      "finalAdmission.rollbackArtifactSha256 !== productionAdmission.rollbackArtifactSha256",
      secondDatabaseAdmission,
    );
    const sinkAdmission = source.indexOf("const sinkAdmission = await assertProductionWorkerDeployAdmission", stableDatabaseGuard);
    const deploySink = source.indexOf("`${productionAdmission.candidateWorkerVersion}@100%`");
    const genericDeploy = source.indexOf('const deployArgs = ["wrangler", "deploy"]', deploySink);

    expect(firstDatabaseAdmission).toBeGreaterThan(-1);
    expect(firstDatabaseAdmission).toBeLessThan(build);
    expect(secondDatabaseAdmission).toBeGreaterThan(build);
    expect(secondDatabaseAdmission).toBeLessThan(deploySink);
    expect(stableDatabaseGuard).toBeGreaterThan(secondDatabaseAdmission);
    expect(stableDatabaseGuard).toBeLessThan(deploySink);
    expect(candidateDriftGuard).toBeGreaterThan(secondDatabaseAdmission);
    expect(candidateDriftGuard).toBeLessThan(deploySink);
    expect(rollbackArtifactDriftGuard).toBeGreaterThan(secondDatabaseAdmission);
    expect(rollbackArtifactDriftGuard).toBeLessThan(deploySink);
    expect(sinkAdmission).toBeGreaterThan(stableDatabaseGuard);
    expect(sinkAdmission).toBeLessThan(deploySink);
    const sinkDriftGuard = source.indexOf("production_sink_admission_changed", sinkAdmission);
    expect(sinkDriftGuard).toBeGreaterThan(sinkAdmission);
    expect(sinkDriftGuard).toBeLessThan(deploySink);
    expect(source.slice(deploySink - 80, deploySink + 160)).toContain('"versions",\n        "deploy"');
    expect(source.slice(deploySink, deploySink + 180)).toContain('"--env",\n        "production",\n        "--yes"');
    expect(genericDeploy).toBeGreaterThan(deploySink);
    expect(source.match(/assertMigrationLedgerImplementation: assertProductionMigrationLedger/gu)).toHaveLength(2);
    expect(source.match(/assertDatabasePreflightImplementation: assertProductionDatabasePreflight/gu)).toHaveLength(2);
    expect(source.match(/assertPostMigrationContractImplementation: assertRemotePostMigrationContract/gu)).toHaveLength(2);
  });
});
