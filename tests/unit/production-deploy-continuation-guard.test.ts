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

  it("proves the reviewed 0087 through 0096 schema definitions and live data invariants", () => {
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
      "order_access_recovery_tokens_consume_rotate_order",
      "order_access_recovery_tokens_customer_anonymize",
      "idx_order_access_recovery_tokens_active_order",
      "idx_order_access_recovery_tokens_previous",
      "idx_order_access_recovery_tokens_replacement",
      "idx_order_access_recovery_tokens_retention",
      "shop_domains_identity_update_guard",
      "shop_domains_turnstile_active_insert_guard",
      "shop_domains_turnstile_active_update_guard",
      "shops_turnstile_canonical_insert_guard",
      "shops_turnstile_canonical_update_guard",
      "auth_request_admissions",
      "idx_auth_request_admissions_window",
      "idx_auth_request_admissions_requester_window",
      "idx_auth_request_admissions_expiry",
      "idx_auth_request_admissions_subject_window",
      "telegram_updates",
      "idx_telegram_integrations_shop_generation",
      "idx_telegram_updates_generation_processing",
      "outbox_jobs_quarantine_legacy_order_paid_insert",
      "telegram_integrations_generation_switch_required",
      "telegram_updates_generation_insert_guard",
    ]));
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner.mock.calls.every(([args]) => args[4] === "production")).toBe(true);
  });

  it("pins staging invariant queries to the staging D1 environment", () => {
    const assertInvariants = (releaseModule as Record<string, unknown>).assertProductionDatabaseInvariantContract;
    expect(typeof assertInvariants).toBe("function");
    if (typeof assertInvariants !== "function") return;
    const migrationNames = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort();
    const database = new DatabaseSync(":memory:");
    for (const name of migrationNames) {
      database.exec(readFileSync(join("migrations", name), "utf8"));
    }
    const runner = vi.fn((args: string[]) => {
      const sql = args[args.indexOf("--command") + 1];
      if (sql === undefined) throw new Error("missing_sql");
      return { stdout: JSON.stringify([{ results: database.prepare(sql).all(), success: true }]) };
    });
    try {
      const result = (assertInvariants as (input: Record<string, unknown>) => { ok: boolean })({
        environmentName: "staging",
        migrationNames,
        repositoryRoot: process.cwd(),
        runWranglerImplementation: runner,
      });
      expect(result.ok).toBe(true);
      expect(runner.mock.calls.every(([args]) => args[4] === "staging")).toBe(true);
    } finally {
      database.close();
    }
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

    const invalidDomainAdmission = runner((rows, sql) => {
      if (sql.includes("integrity_0093_custom_domain_turnstile") && rows[0] !== undefined) {
        rows[0].integrity_0093_custom_domain_turnstile = 1;
      }
    });
    expect(() => (assertInvariants as (input: Record<string, unknown>) => unknown)({
      migrationNames,
      runWranglerImplementation: invalidDomainAdmission,
    })).toThrow("production_database_invariant_data_violation:integrity_0093_custom_domain_turnstile");

    const invalidAuthAdmission = runner((rows, sql) => {
      if (sql.includes("integrity_0094_auth_request_admission") && rows[0] !== undefined) {
        rows[0].integrity_0094_auth_request_admission = 1;
      }
    });
    expect(() => (assertInvariants as (input: Record<string, unknown>) => unknown)({
      migrationNames,
      runWranglerImplementation: invalidAuthAdmission,
    })).toThrow("production_database_invariant_data_violation:integrity_0094_auth_request_admission");

    const invalidTelegramGeneration = runner((rows, sql) => {
      if (sql.includes("integrity_0095_telegram_update_generation") && rows[0] !== undefined) {
        rows[0].integrity_0095_telegram_update_generation = 1;
      }
    });
    expect(() => (assertInvariants as (input: Record<string, unknown>) => unknown)({
      migrationNames,
      runWranglerImplementation: invalidTelegramGeneration,
    })).toThrow("production_database_invariant_data_violation:integrity_0095_telegram_update_generation");

    const unreviewedMigration = `${String(migrationNames.length + 1).padStart(4, "0")}_future.sql`;
    expect(() => (assertInvariants as (input: Record<string, unknown>) => unknown)({
      migrationNames: [...migrationNames, unreviewedMigration],
      runWranglerImplementation: vi.fn(),
    })).toThrow(`production_database_invariant_registry_incomplete:${unreviewedMigration}`);
  });

  it("rejects same-name replacements for the reviewed billing, catalog, PayOS and admission guards", () => {
    const assertInvariants = (releaseModule as Record<string, unknown>).assertProductionDatabaseInvariantContract;
    expect(typeof assertInvariants).toBe("function");
    if (typeof assertInvariants !== "function") return;
    const migrationNames = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort();
    const database = new DatabaseSync(":memory:");
    for (const name of migrationNames) {
      database.exec(readFileSync(join("migrations", name), "utf8"));
    }
    const triggerNames = [
      "billing_checkout_sessions_scope_guard",
      "billing_checkout_sessions_scope_update_guard",
      "shop_subscriptions_provider_ref_guard",
      "shop_subscriptions_provider_ref_update_guard",
      "plan_prices_published_reference_guard",
      "plans_public_assignable_insert_guard",
      "plans_public_assignable_update_guard",
      "shop_subscriptions_price_snapshot_presence_guard",
      "shop_subscriptions_price_snapshot_presence_update_guard",
      "shop_subscriptions_price_snapshot_scope_guard",
      "shop_subscriptions_price_snapshot_scope_update_guard",
      "payment_integrations_payos_claim_fingerprint_clear_guard",
      "payment_credentials_payos_claim_fingerprint_clear_guard",
      "order_access_recovery_tokens_consume_rotate_order",
      "order_access_recovery_tokens_customer_anonymize",
      "order_access_recovery_tokens_identity_immutable",
      "order_access_recovery_tokens_redaction_guard",
      "order_access_recovery_tokens_scope_insert_guard",
      "order_access_recovery_tokens_terminal_immutable",
      "shop_domains_identity_update_guard",
      "shop_domains_turnstile_active_insert_guard",
      "shop_domains_turnstile_active_update_guard",
      "shops_turnstile_canonical_insert_guard",
      "shops_turnstile_canonical_update_guard",
    ];
    for (const triggerName of triggerNames) {
      const runner = vi.fn((args: string[]) => {
        const sql = args[args.indexOf("--command") + 1];
        if (sql === undefined) throw new Error("missing_sql");
        const rows = database.prepare(sql).all() as Array<Record<string, unknown>>;
        const row = rows.find((entry) => entry.name === triggerName);
        if (row !== undefined) row.sql = `CREATE TRIGGER ${triggerName} AFTER INSERT ON sqlite_schema BEGIN SELECT 1; END`;
        return { stdout: JSON.stringify([{ results: rows, success: true }]) };
      });
      expect(() => (assertInvariants as (input: Record<string, unknown>) => unknown)({
        migrationNames,
        runWranglerImplementation: runner,
      })).toThrow(`production_database_invariant_definition_mismatch:trigger:${triggerName}`);
    }

    const admissionObjectReplacements = [
      ["table", "auth_request_admissions", "CREATE TABLE auth_request_admissions (id TEXT)"],
      ["index", "idx_auth_request_admissions_window", "CREATE INDEX idx_auth_request_admissions_window ON auth_request_admissions(id)"],
      ["index", "idx_auth_request_admissions_requester_window", "CREATE INDEX idx_auth_request_admissions_requester_window ON auth_request_admissions(id)"],
      ["index", "idx_auth_request_admissions_expiry", "CREATE INDEX idx_auth_request_admissions_expiry ON auth_request_admissions(id)"],
      ["index", "idx_auth_request_admissions_subject_window", "CREATE INDEX idx_auth_request_admissions_subject_window ON auth_request_admissions(id)"],
    ] as const;
    for (const [type, name, replacementSql] of admissionObjectReplacements) {
      const runner = vi.fn((args: string[]) => {
        const sql = args[args.indexOf("--command") + 1];
        if (sql === undefined) throw new Error("missing_sql");
        const rows = database.prepare(sql).all() as Array<Record<string, unknown>>;
        const row = rows.find((entry) => entry.name === name);
        if (row !== undefined) row.sql = replacementSql;
        return { stdout: JSON.stringify([{ results: rows, success: true }]) };
      });
      expect(() => (assertInvariants as (input: Record<string, unknown>) => unknown)({
        migrationNames,
        runWranglerImplementation: runner,
      })).toThrow(`production_database_invariant_definition_mismatch:${type}:${name}`);
    }
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
    const deployCommand = source.slice(deploySink - 120, deploySink + 240);
    expect(deployCommand).toContain('"versions"');
    expect(deployCommand).toContain('"deploy"');
    expect(deployCommand).toContain('"--env"');
    expect(deployCommand).toContain('"production"');
    expect(deployCommand).toContain('"--yes"');
    expect(genericDeploy).toBeGreaterThan(deploySink);
    expect(source.match(/assertMigrationLedgerImplementation: assertProductionMigrationLedger/gu)).toHaveLength(3);
    expect(source.match(/assertDatabasePreflightImplementation: assertProductionDatabasePreflight/gu)).toHaveLength(3);
    expect(source.match(/assertPostMigrationContractImplementation: assertRemotePostMigrationContract/gu)).toHaveLength(3);
    const candidateActiveAdmission = source.indexOf('workerVersionAdmissionMode: "candidate_active"', deploySink);
    const triggerHandoff = source.indexOf('"scripts/production-trigger.mjs"', candidateActiveAdmission);
    const routeHandoff = source.indexOf('"scripts/production-continuation-route.mjs"', triggerHandoff);
    const exactAdmission = source.indexOf('infrastructureAdmissionMode: "exact"', routeHandoff);
    const postHandoffDatabaseAdmission = source.indexOf(
      "await assertProductionDatabaseDeployAdmission",
      exactAdmission,
    );
    expect(candidateActiveAdmission).toBeGreaterThan(deploySink);
    expect(triggerHandoff).toBeGreaterThan(candidateActiveAdmission);
    expect(routeHandoff).toBeGreaterThan(triggerHandoff);
    expect(exactAdmission).toBeGreaterThan(routeHandoff);
    expect(postHandoffDatabaseAdmission).toBeGreaterThan(exactAdmission);
  });
});
