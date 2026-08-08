import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as CliModule from "../../scripts/lib/cli.mjs";
import type * as PlatformAdminBootstrapModule from "../../scripts/lib/platform-admin-bootstrap.mjs";
import {
  assertPlatformAdminBootstrapContinuationFreshness,
  buildPlatformAdminBootstrapSql,
  parsePlatformAdminBootstrapFlags,
  parsePlatformAdminBootstrapOutput,
  runPlatformAdminBootstrap,
} from "../../scripts/lib/platform-admin-bootstrap.mjs";

const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const DATABASE_ID = "17ea8f2f-4c97-4337-8989-28b25a58ddeb";
const USER_ID = "user-bootstrap-owner";
const EMAIL = "owner@example.test";
const REQUEST_ID = "bootstrap-request-1";
const RELEASE_MANIFEST = ".wrangler/releases/release_20260809_abcdef12/release-manifest.json";
const REQUIRED_MIGRATION = "0086_platform_admin_bootstrap_receipt.sql";
const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;

type RunnerOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type RunnerResult = {
  stderr: string;
  stdout: string;
};

function productionFlags(
  overrides: Partial<PlatformAdminBootstrapModule.PlatformAdminBootstrapFlags> = {},
): PlatformAdminBootstrapModule.PlatformAdminBootstrapFlags {
  return {
    confirm: true,
    confirmProduction: true,
    dryRun: false,
    environment: "production",
    json: true,
    releaseManifestPath: RELEASE_MANIFEST,
    userEmail: EMAIL,
    userId: USER_ID,
    ...overrides,
  };
}

function successOutput() {
  return JSON.stringify([{ results: [{ adminCount: 1, candidateOwnerCount: 1, receiptCount: 1 }] }]);
}

function executeBootstrapSql(database: DatabaseSync, input: { requestId: string; userEmail: string; userId: string }) {
  const statements = buildPlatformAdminBootstrapSql(input)
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  database.exec(`${statements[0] ?? ""};${statements[1] ?? ""};`);
  return database.prepare(statements[2] ?? "").get();
}

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../../scripts/lib/cli.mjs");
  vi.doUnmock("../../scripts/lib/platform-admin-bootstrap.mjs");
});

describe("platform admin bootstrap guard", () => {
  it("requires exact identity and explicit execution confirmation", () => {
    expect(() => parsePlatformAdminBootstrapFlags(["--env", "staging", "--user-id", USER_ID, "--user-email", EMAIL]))
      .toThrow("platform_admin_bootstrap_confirmation_required");
    expect(parsePlatformAdminBootstrapFlags(["--env", "staging", "--user-id", USER_ID, "--user-email", EMAIL, "--dry-run"]))
      .toMatchObject({ dryRun: true, userEmail: EMAIL, userId: USER_ID });
  });

  it("requires a separate production confirmation even for an admission-only dry run", () => {
    expect(() => parsePlatformAdminBootstrapFlags([
      "--env", "production", "--user-id", USER_ID, "--user-email", EMAIL, "--dry-run",
    ])).toThrow("production_confirmation_required");
  });

  it("requires one explicit release manifest for production execution", () => {
    expect(() => parsePlatformAdminBootstrapFlags([
      "--env", "production", "--user-id", USER_ID, "--user-email", EMAIL,
      "--confirm-production", "--confirm-first-admin-bootstrap",
    ])).toThrow("production_release_manifest_required");
    expect(() => parsePlatformAdminBootstrapFlags([
      "--env", "production", "--user-id", USER_ID, "--user-email", EMAIL,
      "--confirm-production", "--confirm-first-admin-bootstrap",
      "--release-manifest", RELEASE_MANIFEST, `--release-manifest=${RELEASE_MANIFEST}`,
    ])).toThrow("production_release_manifest_duplicate");
  });

  it("builds a one-time transaction guarded by both empty admin state and active exact user", () => {
    const sql = buildPlatformAdminBootstrapSql({ requestId: REQUEST_ID, userEmail: EMAIL, userId: USER_ID });
    expect(sql).toContain("(SELECT COUNT(*) FROM platform_admins) = 0");
    expect(sql).toContain("(SELECT COUNT(*) FROM platform_admin_bootstrap_receipts) = 0");
    expect(sql).toContain("email_normalized = 'owner@example.test' AND status = 'active'");
    expect(sql).not.toMatch(/secret|token|password|credential/iu);
  });

  it("does not report a repeated ceremony with a different request as successful", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE platform_users (
          id TEXT PRIMARY KEY NOT NULL,
          email_normalized TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL
        ) STRICT;
        CREATE TABLE platform_admins (
          user_id TEXT PRIMARY KEY NOT NULL REFERENCES platform_users(id),
          role TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) WITHOUT ROWID, STRICT;
        CREATE TABLE platform_admin_bootstrap_receipts (
          ceremony_key TEXT PRIMARY KEY NOT NULL,
          user_id TEXT NOT NULL UNIQUE REFERENCES platform_users(id),
          role TEXT NOT NULL,
          request_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) WITHOUT ROWID, STRICT;
        INSERT INTO platform_users (id, email_normalized, status)
        VALUES ('user-bootstrap-owner', 'owner@example.test', 'active');
      `);

      expect(executeBootstrapSql(database, {
        requestId: "bootstrap-request-one",
        userEmail: EMAIL,
        userId: USER_ID,
      })).toEqual({ adminCount: 1, candidateOwnerCount: 1, receiptCount: 1 });
      expect(executeBootstrapSql(database, {
        requestId: "bootstrap-request-two",
        userEmail: EMAIL,
        userId: USER_ID,
      })).toEqual({ adminCount: 1, candidateOwnerCount: 1, receiptCount: 0 });
    } finally {
      database.close();
    }
  });

  it("requires the privileged restore to be fresh and follow its backup", () => {
    const now = new Date("2026-08-09T12:00:00.000Z");
    const freshEvidence = {
      backup: { completedAt: "2026-08-09T10:00:00.000Z" },
      restore: { completedAt: "2026-08-09T11:00:00.000Z" },
    };
    expect(assertPlatformAdminBootstrapContinuationFreshness(freshEvidence, now)).toBe(freshEvidence);
    expect(() => assertPlatformAdminBootstrapContinuationFreshness({
      backup: { completedAt: "2026-08-09T10:00:00.000Z" },
      restore: { completedAt: "2026-08-09T09:00:00.000Z" },
    }, now)).toThrow("platform_admin_bootstrap_production_backup_restore_invalid");
    expect(() => assertPlatformAdminBootstrapContinuationFreshness({
      backup: { completedAt: "2026-08-08T10:00:00.000Z" },
      restore: { completedAt: "2026-08-08T11:00:00.000Z" },
    }, now)).toThrow("platform_admin_bootstrap_production_backup_restore_invalid");
  });

  it("reasserts production confirmations at the exported mutation boundary", async () => {
    const runner = vi.fn<(args: string[], options?: RunnerOptions) => RunnerResult>(
      () => ({ stderr: "", stdout: successOutput() }),
    );
    const productionAdmission = vi.fn();

    await expect(runPlatformAdminBootstrap({
      flags: productionFlags({ confirmProduction: false }),
      productionAdmissionImplementation: productionAdmission,
      requestId: REQUEST_ID,
      runner,
    })).rejects.toThrow("production_confirmation_required");
    await expect(runPlatformAdminBootstrap({
      flags: productionFlags({ confirm: false }),
      productionAdmissionImplementation: productionAdmission,
      requestId: REQUEST_ID,
      runner,
    })).rejects.toThrow("platform_admin_bootstrap_confirmation_required");
    await expect(runPlatformAdminBootstrap({
      flags: productionFlags({ releaseManifestPath: null }),
      productionAdmissionImplementation: productionAdmission,
      requestId: REQUEST_ID,
      runner,
    })).rejects.toThrow("production_release_manifest_required");
    expect(productionAdmission).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("fails before the mutation sink when production admission rejects", async () => {
    const runner = vi.fn<(args: string[], options?: RunnerOptions) => RunnerResult>(
      () => ({ stderr: "", stdout: successOutput() }),
    );
    const productionAdmission = vi.fn(() => Promise.reject(new Error("production_account_identity_mismatch")));

    await expect(runPlatformAdminBootstrap({
      flags: productionFlags(),
      productionAdmissionImplementation: productionAdmission,
      requestId: REQUEST_ID,
      runner,
    })).rejects.toThrow("production_account_identity_mismatch");
    expect(productionAdmission).toHaveBeenCalledWith(expect.objectContaining({
      manifestPath: RELEASE_MANIFEST,
      operation: "seed",
    }));
    expect(runner).not.toHaveBeenCalled();
  });

  it("requires a complete 0086+ ledger after production candidate admission", async () => {
    const runner = vi.fn<(args: string[], options?: RunnerOptions) => RunnerResult>(
      () => ({ stderr: "", stdout: successOutput() }),
    );

    await expect(runPlatformAdminBootstrap({
      flags: productionFlags(),
      productionAdmissionImplementation: () => Promise.resolve({
        accountId: ACCOUNT_ID,
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        databaseId: DATABASE_ID,
        databaseName: "selinow-production",
        releaseId: "release_20260809_abcdef12",
      }),
      productionLedgerImplementation: () => Promise.resolve({ migrationNames: ["0085_platform_admins.sql"] }),
      requestId: REQUEST_ID,
      runner,
    })).rejects.toThrow("platform_admin_bootstrap_migration_0086_required");
    expect(runner).not.toHaveBeenCalled();
  });

  it("pins the admitted production account at the mutation sink", async () => {
    const runner = vi.fn<(args: string[], options?: RunnerOptions) => RunnerResult>(
      () => ({ stderr: "", stdout: successOutput() }),
    );
    const productionAdmission = vi.fn(() => Promise.resolve({
      accountId: ACCOUNT_ID,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      databaseId: DATABASE_ID,
      databaseName: "selinow-production",
      releaseId: "release_20260809_abcdef12",
    }));
    const productionLedger = vi.fn(() => Promise.resolve({ migrationNames: [REQUIRED_MIGRATION] }));

    await expect(runPlatformAdminBootstrap({
      environment: { CLOUDFLARE_ACCOUNT_ID: "wrong-account", SECRET_VALUE: "must-not-print" },
      flags: productionFlags(),
      productionAdmissionImplementation: productionAdmission,
      productionLedgerImplementation: productionLedger,
      requestId: REQUEST_ID,
      runner,
    })).resolves.toMatchObject({ environment: "production", ok: true });
    expect(productionLedger).toHaveBeenCalledOnce();
    const [args, options] = runner.mock.calls[0] ?? [];
    expect(args).toContain("--remote");
    expect(options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT_ID);
  });

  it("accepts only the exact single-owner verification result", async () => {
    const output = JSON.stringify([{ results: [{ adminCount: 1, candidateOwnerCount: 1, receiptCount: 1 }] }]);
    expect(parsePlatformAdminBootstrapOutput(output)).toEqual({ adminCount: 1, candidateOwnerCount: 1, receiptCount: 1 });
    expect(() => parsePlatformAdminBootstrapOutput(JSON.stringify([{
      results: [{ adminCount: true, candidateOwnerCount: true, receiptCount: true }],
    }]))).toThrow("platform_admin_bootstrap_output_invalid");
    await expect(runPlatformAdminBootstrap({
      flags: {
        confirm: true,
        confirmProduction: false,
        dryRun: false,
        environment: "staging",
        json: true,
        releaseManifestPath: null,
        userEmail: EMAIL,
        userId: USER_ID,
      },
      requestId: REQUEST_ID,
      runner: () => ({ stdout: JSON.stringify([{ results: [{ adminCount: 2, candidateOwnerCount: 0, receiptCount: 0 }] }]) }),
    })).rejects.toThrow("platform_admin_bootstrap_exact_empty_state_required");
  });

  it("redacts raw command output and secret-bearing errors at the CLI boundary", async () => {
    const runner = vi.fn(() => {
      throw new Error("command_failed:npx:--no-install:Bearer production-super-secret-token");
    });
    const writeOutput = vi.fn();
    vi.doMock("../../scripts/lib/cli.mjs", async (importOriginal) => ({
      ...await importOriginal<typeof CliModule>(),
      runWrangler: runner,
      writeOutput,
    }));
    process.argv = [
      process.execPath,
      "scripts/platform-admin-bootstrap.mjs",
      "--env", "staging",
      "--user-id", USER_ID,
      "--user-email", EMAIL,
      "--confirm-first-admin-bootstrap",
      "--json",
    ];

    await import("../../scripts/platform-admin-bootstrap.mjs");

    expect(process.exitCode).toBe(1);
    expect(writeOutput).toHaveBeenCalledWith({
      actions: [{ code: "platform_admin_bootstrap_failed", ok: false }],
      environment: "unknown",
      ok: false,
    }, true);
  });

  it("collapses token-shaped production admission errors to a stable safe code", async () => {
    const writeOutput = vi.fn();
    vi.doMock("../../scripts/lib/cli.mjs", async (importOriginal) => ({
      ...await importOriginal<typeof CliModule>(),
      runWrangler: vi.fn(),
      writeOutput,
    }));
    vi.doMock("../../scripts/lib/platform-admin-bootstrap.mjs", async (importOriginal) => ({
      ...await importOriginal<typeof PlatformAdminBootstrapModule>(),
      runPlatformAdminBootstrap: vi.fn(() => Promise.reject(
        new Error("production_database_lookup:supersecrettoken"),
      )),
    }));
    process.argv = [
      process.execPath,
      "scripts/platform-admin-bootstrap.mjs",
      "--env", "production",
      "--user-id", USER_ID,
      "--user-email", EMAIL,
      "--confirm-production",
      "--confirm-first-admin-bootstrap",
      "--release-manifest", RELEASE_MANIFEST,
      "--json",
    ];

    await import("../../scripts/platform-admin-bootstrap.mjs");

    expect(writeOutput).toHaveBeenCalledWith({
      actions: [{ code: "platform_admin_bootstrap_production_admission_failed", ok: false }],
      environment: "unknown",
      ok: false,
    }, true);
  });
});
