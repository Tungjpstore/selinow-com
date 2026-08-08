import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseDatabaseFlags,
  requiresProductionMigrationAdmission,
  requiresStagingDatabaseAdmission,
} from "../../scripts/lib/db-admission.mjs";

const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const DATABASE_ID = "17ea8f2f-4c97-4337-8989-28b25a58ddeb";

const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;

type AdmissionResult = {
  accountId: string;
  commitSha: string;
  databaseId: string;
  databaseName: string;
  releaseId: string;
};

type AdmissionInput = {
  environment?: NodeJS.ProcessEnv;
  manifestPath: string;
  repositoryRoot: string;
  workerSecretNames: string[];
};

type RunnerOptions = {
  capture?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type RunnerResult = {
  stderr: string;
  stdout: string;
};

async function runDatabaseCli(input: {
  admission: (input: AdmissionInput) => Promise<AdmissionResult>;
  runner: (args: string[], options?: RunnerOptions) => RunnerResult;
}) {
  const admission = vi.fn(input.admission);
  const runner = vi.fn(input.runner);
  vi.doMock("../../scripts/lib/db-admission.mjs", () => {
    return {
      assertProductionDatabasePreflight: vi.fn(() => ({ checks: [], ok: true })),
      assertProductionMigrationLedger: vi.fn(() => Promise.resolve({ migrationNames: [] })),
      assertProductionMigrationAdmission: admission,
      parseDatabaseFlags,
      requiresMaintenanceDrainConfirmation: vi.fn(() => false),
      requiresProductionMigrationAdmission,
      requiresStagingDatabaseAdmission,
    };
  });
  vi.doMock("../../scripts/lib/cli.mjs", () => {
    return {
      runWrangler: runner,
      writeOutput: vi.fn(),
    };
  });
  vi.doMock("../../scripts/lib/db-post-migration-contract.mjs", () => ({
    assertRemotePostMigrationContract: vi.fn(() => ({ ok: true })),
  }));

  process.argv = [
    process.execPath,
    "scripts/db.mjs",
    "seed",
    "--env",
    "production",
    "--confirm-production",
    "--release-manifest",
    ".wrangler/releases/release_20260729_abcdef12/release-manifest.json",
  ];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await import("../../scripts/db.mjs");
  return { admission, runner, stderr, status: process.exitCode };
}

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../../scripts/lib/db-admission.mjs");
  vi.doUnmock("../../scripts/lib/cli.mjs");
  vi.doUnmock("../../scripts/lib/db-post-migration-contract.mjs");
});

describe("production seed admission CLI", () => {
  it("fails closed before Wrangler when production admission rejects", async () => {
    const result = await runDatabaseCli({
      admission: () => Promise.reject(new Error("production_account_identity_mismatch")),
      runner: () => ({ stderr: "", stdout: "" }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toHaveBeenCalledWith("production_account_identity_mismatch\n");
    expect(result.admission).toHaveBeenCalledOnce();
    expect(result.runner).not.toHaveBeenCalled();
  });

  it("passes the admitted account pin to the seed Wrangler sink", async () => {
    const result = await runDatabaseCli({
      admission: () => Promise.resolve({
        accountId: ACCOUNT_ID,
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        databaseId: DATABASE_ID,
        databaseName: "selinow-production",
        releaseId: "release_20260729_abcdef12",
      }),
      runner: () => ({ stderr: "", stdout: "" }),
    });

    expect(result.status).toBeUndefined();
    expect(result.stderr).not.toHaveBeenCalled();
    expect(result.admission).toHaveBeenCalledWith(expect.objectContaining({
      manifestPath: ".wrangler/releases/release_20260729_abcdef12/release-manifest.json",
    }));
    expect(result.runner).toHaveBeenCalledOnce();
    const [runnerArgs, runnerOptions] = result.runner.mock.calls[0] ?? [];
    expect(runnerArgs).toEqual([
      "d1",
      "execute",
      "PLATFORM_DB",
      "--env",
      "production",
      "--remote",
      "--file",
      "./seeds/0001_platform_defaults.sql",
    ]);
    expect(runnerOptions?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT_ID);
  });
});
