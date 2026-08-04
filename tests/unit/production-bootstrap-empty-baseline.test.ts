import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildProductionEmptyBaselineEnvironment,
  parseProductionBootstrapEmptyBaselineFlags,
  requireProductionEmptyBaselineToken,
  runProductionBootstrapEmptyBaselineDrill,
  validateProductionBootstrapEmptyBaselineAdmission,
} from "../../scripts/lib/production-bootstrap-empty-baseline.mjs";

const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const ZONE_ID = "1234567890abcdef1234567890abcdef";
const DATABASE_ID = "17ea8f2f-4c97-4337-8989-28b25a58ddeb";
const EMPTY_BASELINE_TOKEN = "dedicated-empty-baseline-token";
type Runner = (args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => { stderr: string; stdout: string };

const productionSpec = {
  accountId: ACCOUNT_ID,
  bootstrap: {
    canaryHostname: "canary.selinow.com",
    firstVersionRollback: "restore_pre_bootstrap_traffic_inventory",
    promotionStrategy: "canary_then_stable_domains",
  },
  environment: "production",
  hostnames: {
    api: "api.selinow.com",
    dashboard: "app.selinow.com",
    marketing: "selinow.com",
  },
  routing: {
    canaryOverrideRoute: "canary.selinow.com/*",
    externalCustomDomainFallbackRoute: "*/*",
    externalCustomDomainStrategy: "production_fallback_with_platform_staging_exceptions",
    platformApexRoute: "selinow.com/*",
    platformStorefrontWildcard: "*.selinow.com/*",
    routeHandoff: "atomic_shared_zone_route_replacement",
    stagingExternalCustomDomainInventory: "pending_inventory",
    stagingRouteExceptions: [
      "*.staging.selinow.com/*",
    ],
  },
  turnstile: {
    externalCustomDomainAdmission: "pending_runtime_lifecycle",
    externalCustomDomainStrategy: "exact_hostname_admission_before_activation",
    platformHostname: "selinow.com",
  },
  resources: {
    d1: "selinow-production",
    deadLetterQueue: "selinow-dlq-production",
    integrationQueue: "selinow-integration-production",
    notificationQueue: "selinow-notification-production",
    platformCacheKv: "selinow-cache-production",
    privateExports: "selinow-private-exports-production",
    r2: "selinow-media-production",
    sessionKv: "selinow-session-production",
  },
  workerName: "selinow-com-production",
  zoneId: ZONE_ID,
  zoneName: "selinow.com",
};

const generatedManifest = {
  accountId: ACCOUNT_ID,
  environment: "production",
  resources: { d1: { id: DATABASE_ID, name: "selinow-production" } },
  workerName: "selinow-com-production",
  zoneId: ZONE_ID,
  zoneName: "selinow.com",
};

const wranglerConfig = {
  env: {
    production: {
      d1_databases: [{
        binding: "PLATFORM_DB",
        database_id: DATABASE_ID,
        database_name: "selinow-production",
        migrations_dir: "./migrations",
      }],
      name: "selinow-com-production",
    },
  },
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    confirmFirstProductionBootstrap: true,
    confirmProduction: true,
    dryRun: false,
    environment: "production",
    generatedManifest,
    now: new Date("2026-07-30T04:00:00.000Z"),
    operatorEnvironment: {
      CLOUDFLARE_PRODUCTION_EMPTY_BASELINE_API_TOKEN: EMPTY_BASELINE_TOKEN,
    },
    productionSpec,
    repositoryRoot: process.cwd(),
    wranglerConfig,
    ...overrides,
  };
}

describe("production empty-baseline restore drill", () => {
  it("requires the dedicated empty-baseline token and strips unrelated secrets from Wrangler", () => {
    expect(requireProductionEmptyBaselineToken({
      CLOUDFLARE_PRODUCTION_EMPTY_BASELINE_API_TOKEN: ` ${EMPTY_BASELINE_TOKEN} `,
    })).toBe(EMPTY_BASELINE_TOKEN);
    expect(() => requireProductionEmptyBaselineToken({
      CLOUDFLARE_API_TOKEN: "generic-token",
    })).toThrow("cloudflare_production_empty_baseline_api_token_missing");

    const environment = buildProductionEmptyBaselineEnvironment({
      CLOUDFLARE_API_TOKEN: "generic-token",
      CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-token",
      CLOUDFLARE_PRODUCTION_EMPTY_BASELINE_API_TOKEN: EMPTY_BASELINE_TOKEN,
      DATABASE_URL: "database-secret",
      PATH: "/usr/bin",
    }, ACCOUNT_ID, EMPTY_BASELINE_TOKEN);
    expect(environment).toMatchObject({
      CI: "1",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: EMPTY_BASELINE_TOKEN,
      PATH: "/usr/bin",
    });
    expect(environment).not.toHaveProperty("CLOUDFLARE_ROUTE_AUDIT_API_TOKEN");
    expect(environment).not.toHaveProperty("CLOUDFLARE_PRODUCTION_EMPTY_BASELINE_API_TOKEN");
    expect(environment).not.toHaveProperty("DATABASE_URL");
  });

  it("requires production and both explicit confirmations", () => {
    expect(() => parseProductionBootstrapEmptyBaselineFlags([]))
      .toThrow("production_bootstrap_empty_baseline_environment_required");
    expect(parseProductionBootstrapEmptyBaselineFlags(["--env", "production", "--dry-run"]))
      .toMatchObject({ dryRun: true, execute: false, environment: "production" });
    expect(() => parseProductionBootstrapEmptyBaselineFlags(["--env", "production", "--execute"]))
      .toThrow("production_confirmation_required");
    expect(() => parseProductionBootstrapEmptyBaselineFlags([
      "--env", "production", "--execute", "--confirm-production",
    ])).toThrow("production_first_bootstrap_confirmation_required");
  });

  it("admits only the exact generated production D1 binding", () => {
    expect(validateProductionBootstrapEmptyBaselineAdmission(input())).toEqual({
      accountId: ACCOUNT_ID,
      databaseId: DATABASE_ID,
      databaseName: "selinow-production",
    });
    expect(() => validateProductionBootstrapEmptyBaselineAdmission(input({
      generatedManifest: { ...generatedManifest, accountId: "a".repeat(32) },
    }))).toThrow("production_bootstrap_empty_baseline_generated_identity_mismatch");
  });

  it("keeps dry-run network-free", async () => {
    const backup = vi.fn();
    const runner = vi.fn();
    const result = await runProductionBootstrapEmptyBaselineDrill(input({
      backupEvidenceImplementation: backup,
      dryRun: true,
      runWranglerImplementation: runner,
    }));
    expect(result).toMatchObject({ environment: "production", executed: false, ok: true });
    expect(backup).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("fails before backup and Wrangler when the dedicated empty-baseline token is missing", async () => {
    const backup = vi.fn();
    const runner = vi.fn();
    await expect(runProductionBootstrapEmptyBaselineDrill(input({
      backupEvidenceImplementation: backup,
      operatorEnvironment: { CLOUDFLARE_API_TOKEN: "generic-token" },
      runWranglerImplementation: runner,
    }))).rejects.toThrow("cloudflare_production_empty_baseline_api_token_missing");
    expect(backup).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("imports a fresh protected empty export, verifies it, deletes the exact target, and writes private evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-empty-baseline-test-"));
    const artifactPath = resolve(root, "database.sql");
    const reportRoot = resolve(root, "reports");
    const commands: string[][] = [];
    let targetExists = false;
    const targetId = "27ea8f2f-4c97-4337-8989-28b25a58ddeb";
    await writeFile(artifactPath, "-- protected empty export\n", { encoding: "utf8", mode: 0o600 });
    try {
      const result = await runProductionBootstrapEmptyBaselineDrill(input({
        backupEvidenceImplementation: () => ({
          artifactPath,
          completedAt: "2026-07-30T03:00:00.000Z",
          checksumSha256: createHash("sha256").update("-- protected empty export\n").digest("hex"),
          providerBookmarkRecorded: true,
          reportRef: "private/backup/report.json",
          sizeBytes: 26,
          snapshotId: "bkp_20260730030000_010101010101",
        }),
        randomBytesImplementation: () => Buffer.alloc(6, 0x11),
        reportRoot,
        runWranglerImplementation: ((args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
          commands.push(args);
          expect(options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT_ID);
          expect(options?.env?.CLOUDFLARE_API_TOKEN).toBe(EMPTY_BASELINE_TOKEN);
          expect(options?.env).not.toHaveProperty("CLOUDFLARE_PRODUCTION_EMPTY_BASELINE_API_TOKEN");
          if (args[0] === "whoami") {
            return { stderr: "", stdout: JSON.stringify({ accounts: [{ id: ACCOUNT_ID }], loggedIn: true }) };
          }
          if (args[0] === "d1" && args[1] === "list") {
            const target = targetExists;
            return {
              stderr: "",
              stdout: JSON.stringify(target
                ? [{ name: "selinow-production", uuid: DATABASE_ID }, { name: "selinow-restore-drill-production-empty-111111111111", uuid: targetId }]
                : [{ name: "selinow-production", uuid: DATABASE_ID }]),
            };
          }
          if (args[0] === "d1" && args[1] === "create") {
            targetExists = true;
            return { stderr: "", stdout: "" };
          }
          if (args[0] === "d1" && args[1] === "delete") {
            targetExists = false;
            return { stderr: "", stdout: "" };
          }
          if (args[0] === "d1" && args[1] === "execute" && args.includes("--command")) {
            const sql = args[args.indexOf("--command") + 1] ?? "";
            if (sql.includes("name NOT LIKE")) return { stderr: "", stdout: JSON.stringify([{ results: [] }]) };
            if (sql.includes("name = 'd1_migrations'")) return { stderr: "", stdout: JSON.stringify([{ results: [] }]) };
            if (sql === "PRAGMA integrity_check;") throw new Error("not authorized: SQLITE_AUTH");
            if (sql === "PRAGMA foreign_key_check;") return { stderr: "", stdout: JSON.stringify([{ results: [] }]) };
          }
          return { stderr: "", stdout: "" };
        }) satisfies Runner,
      }));
      const typedResult = result as { environment: string; executed: boolean; ok: boolean; reportRef: string };
      expect(typedResult).toMatchObject({ environment: "production", executed: true, ok: true });
      expect(commands.some((args) => args[0] === "d1" && args[1] === "create")).toBe(true);
      expect(commands.some((args) => args.includes("--file") && args.includes(artifactPath))).toBe(true);
      expect(commands.some((args) => args[0] === "d1" && args[1] === "delete" && args[2] === "selinow-restore-drill-production-empty-111111111111")).toBe(true);
      const reportPath = typedResult.reportRef;
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        status?: string;
        target?: { deleted?: boolean };
        verification?: { integrityStatus?: string };
      };
      expect(report.status).toBe("passed");
      expect(report.target?.deleted).toBe(true);
      expect(report.verification?.integrityStatus).toBe("remote_pragma_unavailable");
      expect(JSON.stringify(report)).not.toContain("bookmark");
      expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not claim deletion when cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-empty-baseline-cleanup-"));
    const artifactPath = resolve(root, "database.sql");
    await mkdir(resolve(root, "reports"), { recursive: true });
    await writeFile(artifactPath, "-- protected empty export\n", "utf8");
    let targetExists = false;
    let targetName = "";
    const targetId = "27ea8f2f-4c97-4337-8989-28b25a58ddeb";
    try {
      const failure = await runProductionBootstrapEmptyBaselineDrill(input({
        backupEvidenceImplementation: () => ({ artifactPath, completedAt: "2026-07-30T03:00:00.000Z", checksumSha256: "a".repeat(64), providerBookmarkRecorded: true, reportRef: "private/backup/report.json", sizeBytes: 26, snapshotId: "bkp_20260730030000_010101010101" }),
        reportRoot: resolve(root, "reports"),
        runWranglerImplementation: ((args: string[]) => {
          if (args[0] === "whoami") return { stderr: "", stdout: JSON.stringify({ accounts: [{ id: ACCOUNT_ID }], loggedIn: true }) };
          if (args[0] === "d1" && args[1] === "list") return {
            stderr: "",
            stdout: JSON.stringify(targetExists
              ? [{ name: "selinow-production", uuid: DATABASE_ID }, { name: targetName, uuid: targetId }]
              : [{ name: "selinow-production", uuid: DATABASE_ID }]),
          };
          if (args[0] === "d1" && args[1] === "create") {
            targetName = args[2] ?? "";
            targetExists = true;
            return { stderr: "", stdout: "" };
          }
          if (args[0] === "d1" && args[1] === "delete") return { stderr: "", stdout: "" };
          if (args[0] === "d1" && args[1] === "execute" && args.includes("--command")) return { stderr: "", stdout: JSON.stringify([{ results: [] }]) };
          return { stderr: "", stdout: "" };
        }) satisfies Runner,
      })).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("production_bootstrap_empty_baseline_cleanup_failed");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reconciles and deletes an exact target when create reports a timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-empty-baseline-timeout-"));
    const reportRoot = resolve(root, "reports");
    const targetId = "27ea8f2f-4c97-4337-8989-28b25a58ddeb";
    const commands: string[][] = [];
    let targetExists = false;
    try {
      const failure = await runProductionBootstrapEmptyBaselineDrill(input({
        backupEvidenceImplementation: () => ({
          artifactPath: resolve(root, "unused.sql"),
          completedAt: "2026-07-30T03:00:00.000Z",
          checksumSha256: "a".repeat(64),
          providerBookmarkRecorded: true,
          reportRef: "private/backup/report.json",
          sizeBytes: 1,
          snapshotId: "bkp_20260730030000_010101010101",
        }),
        randomBytesImplementation: () => Buffer.alloc(6, 0x22),
        reportRoot,
        runWranglerImplementation: ((args: string[]) => {
          commands.push(args);
          if (args[0] === "whoami") return { stderr: "", stdout: JSON.stringify({ accounts: [{ id: ACCOUNT_ID }], loggedIn: true }) };
          if (args[0] === "d1" && args[1] === "list") return {
            stderr: "",
            stdout: JSON.stringify(targetExists
              ? [{ name: "selinow-production", uuid: DATABASE_ID }, { name: "selinow-restore-drill-production-empty-222222222222", uuid: targetId }]
              : [{ name: "selinow-production", uuid: DATABASE_ID }]),
          };
          if (args[0] === "d1" && args[1] === "create") {
            targetExists = true;
            throw new Error("TimeoutError");
          }
          if (args[0] === "d1" && args[1] === "delete") {
            expect(args[2]).toBe("selinow-restore-drill-production-empty-222222222222");
            targetExists = false;
            return { stderr: "", stdout: "" };
          }
          if (args[0] === "d1" && args[1] === "execute" && args.includes("--command")) {
            return { stderr: "", stdout: JSON.stringify([{ results: [] }]) };
          }
          return { stderr: "", stdout: "" };
        }) satisfies Runner,
      })).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("production_bootstrap_empty_baseline_target_create_failed");
      expect(targetExists).toBe(false);
      expect(commands.some((args) => args[0] === "d1" && args[1] === "delete" && args[2] === "selinow-restore-drill-production-empty-222222222222")).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails cleanup when the exact name and UUID cannot be re-proved or deletion remains visible", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-empty-baseline-identity-"));
    const artifactPath = resolve(root, "database.sql");
    await writeFile(artifactPath, "-- protected empty export\n", "utf8");
    const targetId = "27ea8f2f-4c97-4337-8989-28b25a58ddeb";
    const replacementId = "37ea8f2f-4c97-4337-8989-28b25a58ddeb";
    let listCount = 0;
    const deleteRunner = vi.fn((args: string[]) => {
      if (args[0] === "whoami") return { stderr: "", stdout: JSON.stringify({ accounts: [{ id: ACCOUNT_ID }], loggedIn: true }) };
      if (args[0] === "d1" && args[1] === "list") {
        listCount += 1;
        if (listCount === 1) return { stderr: "", stdout: JSON.stringify([{ name: "selinow-production", uuid: DATABASE_ID }]) };
        if (listCount === 2) return { stderr: "", stdout: JSON.stringify([{ name: "selinow-production", uuid: DATABASE_ID }, { name: "selinow-restore-drill-production-empty-333333333333", uuid: targetId }]) };
        return { stderr: "", stdout: JSON.stringify([{ name: "selinow-production", uuid: DATABASE_ID }, { name: "selinow-restore-drill-production-empty-333333333333", uuid: replacementId }]) };
      }
      if (args[0] === "d1" && args[1] === "execute" && args.includes("--command")) return { stderr: "", stdout: JSON.stringify([{ results: [] }]) };
      return { stderr: "", stdout: "" };
    });
    try {
      const failure = await runProductionBootstrapEmptyBaselineDrill(input({
        backupEvidenceImplementation: () => ({ artifactPath, completedAt: "2026-07-30T03:00:00.000Z", checksumSha256: "a".repeat(64), providerBookmarkRecorded: true, reportRef: "private/backup/report.json", sizeBytes: 26, snapshotId: "bkp_20260730030000_010101010101" }),
        randomBytesImplementation: () => Buffer.alloc(6, 0x33),
        reportRoot: resolve(root, "reports"),
        runWranglerImplementation: deleteRunner satisfies Runner,
      })).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("production_bootstrap_empty_baseline_cleanup_failed");
      expect(deleteRunner.mock.calls.some(([args]) => args[0] === "d1" && args[1] === "delete")).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
