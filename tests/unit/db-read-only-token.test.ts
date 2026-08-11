import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

const STAGING_ACCOUNT_ID = "ef250a88911fd24073cb73d1c07e0218";
const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;
const originalEnvironment = {
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_D1_API_TOKEN: process.env.CLOUDFLARE_D1_API_TOKEN,
  CLOUDFLARE_PLATFORM_API_TOKEN: process.env.CLOUDFLARE_PLATFORM_API_TOKEN,
  CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: process.env.CLOUDFLARE_ROUTE_AUDIT_API_TOKEN,
  KEEP_ME: process.env.KEEP_ME,
};

type RunnerOptions = {
  capture?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

function restoreEnvironment() {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
}

async function runReadOnlyDatabaseCli(
  operation: "preflight" | "status",
  options: { d1Token?: string | undefined } = { d1Token: "d1-token" },
) {
  const runner = vi.fn<(
    args: string[],
    options?: RunnerOptions,
  ) => { stderr: string; stdout: string }>((args) => {
    const sql = args[args.indexOf("--command") + 1] ?? "";
    if (operation === "status") return { stderr: "", stdout: "" };
    if (sql.includes("duplicate_primary_shops")) {
      return {
        stderr: "",
        stdout: JSON.stringify([{ results: [{
          canonical_null_shops: 0,
          duplicate_primary_shops: 0,
          duplicate_provider_ids: 0,
          invalid_canonical_links: 0,
          legacy_custom_domains: 0,
          unresolved_active_attempt_origins: 0,
        }] }]),
      };
    }
    if (sql.includes("invalid_payos_active_credential_links")) {
      return {
        stderr: "",
        stdout: JSON.stringify([{ results: [{
          invalid_payos_active_credential_links: 0,
          invalid_payos_attempt_links: 0,
          invalid_payos_credential_integration_links: 0,
          invalid_payos_event_links: 0,
          invalid_payos_exception_links: 0,
          invalid_payos_paid_event_links: 0,
        }] }]),
      };
    }
    if (sql.includes("sqlite_master")) {
      return { stderr: "", stdout: JSON.stringify([{ results: [] }]) };
    }
    throw new Error("unexpected_read_only_db_command");
  });
  vi.doMock("../../scripts/lib/cli.mjs", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    runWrangler: runner,
    writeOutput: vi.fn(),
  }));

  process.argv = [process.execPath, "scripts/db.mjs", operation, "--env", "staging"];
  process.env.CLOUDFLARE_API_TOKEN = "ambient-token-must-not-win";
  if (options.d1Token === undefined) delete process.env.CLOUDFLARE_D1_API_TOKEN;
  else process.env.CLOUDFLARE_D1_API_TOKEN = options.d1Token;
  process.env.CLOUDFLARE_PLATFORM_API_TOKEN = "platform-token";
  process.env.CLOUDFLARE_ROUTE_AUDIT_API_TOKEN = "route-token";
  process.env.KEEP_ME = "must-not-forward";
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  await import("../../scripts/db.mjs");
  return { runner, stderr };
}

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  restoreEnvironment();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../../scripts/lib/cli.mjs");
});

describe("read-only remote database CLI credentials", () => {
  for (const operation of ["status", "preflight"] as const) {
    it(`pins the D1 token for staging ${operation} without forwarding operator tokens`, async () => {
      const result = await runReadOnlyDatabaseCli(operation);

      expect(result.stderr).not.toHaveBeenCalled();
      expect(result.runner).toHaveBeenCalled();
      for (const [, options] of result.runner.mock.calls) {
        expect(options?.env).toMatchObject({
          CLOUDFLARE_ACCOUNT_ID: STAGING_ACCOUNT_ID,
          CLOUDFLARE_API_TOKEN: "d1-token",
        });
        expect(options?.env).not.toHaveProperty("CLOUDFLARE_D1_API_TOKEN");
        expect(options?.env).not.toHaveProperty("CLOUDFLARE_PLATFORM_API_TOKEN");
        expect(options?.env).not.toHaveProperty("CLOUDFLARE_ROUTE_AUDIT_API_TOKEN");
        expect(options?.env).not.toHaveProperty("KEEP_ME");
      }
    });
  }

  it("fails before invoking Wrangler when the dedicated D1 token is missing", async () => {
    const result = await runReadOnlyDatabaseCli("status", { d1Token: undefined });

    expect(result.runner).not.toHaveBeenCalled();
    expect(result.stderr).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
