import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  buildProductionBootstrapMigrationEnvironment,
  parseProductionBootstrapExecuteFlags,
  requireProductionBootstrapMigrationToken,
  runProductionBootstrapMigrations,
  validateProductionBootstrapMigrationAdmission,
} from "../../scripts/lib/production-bootstrap-execute.mjs";
import { REQUIRED_WORKER_SECRET_NAMES } from "../../scripts/lib/release.mjs";

const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const ZONE_ID = "1234567890abcdef1234567890abcdef";
const DATABASE_ID = "17ea8f2f-4c97-4337-8989-28b25a58ddeb";
const MIGRATIONS = ["0001_platform.sql", "0002_orders.sql"];
const MIGRATION_TOKEN = "dedicated-production-migration-token";
const repositoryState = {
  clean: true,
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
};

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
      "staging.selinow.com/*",
      "app-staging.selinow.com/*",
      "api-staging.selinow.com/*",
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
  resources: {
    d1: { id: DATABASE_ID, name: "selinow-production" },
    deadLetterQueue: { name: "selinow-dlq-production" },
    integrationQueue: { name: "selinow-integration-production" },
    notificationQueue: { name: "selinow-notification-production" },
    platformCacheKv: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "selinow-cache-production" },
    privateExports: { name: "selinow-private-exports-production" },
    r2: { name: "selinow-media-production" },
    sessionKv: { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "selinow-session-production" },
  },
  version: "c".repeat(16),
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

const liveResources = {
  d1: [{ id: DATABASE_ID, name: "selinow-production" }],
  kv: [
    { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "selinow-cache-production" },
    { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "selinow-session-production" },
  ],
  queue: [
    { name: "selinow-dlq-production" },
    { name: "selinow-integration-production" },
    { name: "selinow-notification-production" },
  ],
  r2: [
    { name: "selinow-media-production" },
    { name: "selinow-private-exports-production" },
  ],
};

const liveSecretNames = [...REQUIRED_WORKER_SECRET_NAMES];

function evidence() {
  return {
    approvals: { releaseOwner: "release-owner", supportOwner: "support-owner" },
    backup: {
      completedAt: "2026-07-30T01:00:00.000Z",
      emptyDatabaseBaselineVerified: true,
      providerBookmarkRecorded: true,
      restoreDrillCompletedAt: "2026-07-30T01:30:00.000Z",
      restoreDrillPassed: true,
      restoreDrillReportRef: "private/restore/report.json",
      snapshotReportRef: "private/backup/report.json",
    },
    candidateWorkerVersion: null,
    canary: {
      accepted: false,
      acceptedAt: null,
      smokeReportRef: null,
      stagingRoutesPreserved: false,
      workerVersion: null,
    },
    ceremonyId: "bootstrap_20260730_reviewed",
    environment: "production",
    migrations: {
      appliedAt: null,
      direction: "forward_only",
      names: MIGRATIONS,
    },
    monitoring: { alertsReady: false, dashboardReady: false },
    phase: "resources",
    preBootstrapTrafficSnapshotRef: "private/traffic/before.json",
    previousWorkerVersion: null,
    resourceManifestRef: "private/resources/manifest.json",
    reviewedCommitSha: repositoryState.commitSha,
    reviewedTreeSha: repositoryState.treeSha,
    rollback: {
      snapshotRef: "private/traffic/before.json",
      strategy: "restore_pre_bootstrap_traffic_inventory",
    },
    schemaVersion: 1,
  };
}

function runtimeBackupEvidence() {
  return {
    completedAt: "2026-07-30T01:00:00.000Z",
    providerBookmarkRecorded: true,
    reportRef: "private/backup/report.json",
  };
}

function runtimeRestoreEvidence() {
  return {
    completedAt: "2026-07-30T01:30:00.000Z",
    reportRef: "private/restore/report.json",
    status: "passed",
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    evidence: evidence(),
    generatedManifest,
    migrationNames: MIGRATIONS,
    now: new Date("2026-07-30T04:00:00.000Z"),
    operatorEnvironment: {
      CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN: MIGRATION_TOKEN,
    },
    productionSpec,
    repositoryRoot: process.cwd(),
    repositoryState,
    restoreEvidenceImplementation: () => Promise.resolve(runtimeRestoreEvidence()),
    secretNames: [...REQUIRED_WORKER_SECRET_NAMES],
    wranglerConfig,
    ...overrides,
  };
}

describe("first-production migration execution path", () => {
  it("requires the dedicated migration token and strips unrelated secrets from Wrangler", () => {
    expect(requireProductionBootstrapMigrationToken({
      CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN: ` ${MIGRATION_TOKEN} `,
    })).toBe(MIGRATION_TOKEN);
    expect(() => requireProductionBootstrapMigrationToken({
      CLOUDFLARE_API_TOKEN: "generic-token",
    })).toThrow("cloudflare_production_bootstrap_migration_api_token_missing");

    const environment = buildProductionBootstrapMigrationEnvironment({
      CLOUDFLARE_API_TOKEN: "generic-token",
      CLOUDFLARE_PLATFORM_API_TOKEN: "platform-token",
      CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN: MIGRATION_TOKEN,
      DATABASE_URL: "database-secret",
      PATH: "/usr/bin",
    }, ACCOUNT_ID, MIGRATION_TOKEN);
    expect(environment).toMatchObject({
      CI: "1",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: MIGRATION_TOKEN,
      PATH: "/usr/bin",
    });
    expect(environment).not.toHaveProperty("CLOUDFLARE_PLATFORM_API_TOKEN");
    expect(environment).not.toHaveProperty("CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN");
    expect(environment).not.toHaveProperty("DATABASE_URL");
  });

  it("requires explicit production environment and dual confirmation for execution", () => {
    expect(() => parseProductionBootstrapExecuteFlags([]))
      .toThrow("production_bootstrap_environment_required");
    expect(parseProductionBootstrapExecuteFlags(["--env", "production", "--dry-run"]))
      .toMatchObject({ dryRun: true, execute: false, environment: "production" });
    expect(() => parseProductionBootstrapExecuteFlags(["--env", "production", "--execute"]))
      .toThrow("production_confirmation_required");
    expect(() => parseProductionBootstrapExecuteFlags([
      "--env", "production", "--dry-run", "--execute",
    ])).toThrow("production_bootstrap_mode_conflict");
    expect(parseProductionBootstrapExecuteFlags([
      "--env", "production", "--execute", "--confirm-production",
      "--confirm-first-production-bootstrap",
    ])).toMatchObject({ dryRun: false, execute: true });
  });

  it("admits exact generated manifest/config identity without a regular release manifest", () => {
    expect(validateProductionBootstrapMigrationAdmission(input())).toMatchObject({
      accountId: ACCOUNT_ID,
      databaseId: DATABASE_ID,
      databaseName: "selinow-production",
      migrationNames: MIGRATIONS,
      secretNameCount: REQUIRED_WORKER_SECRET_NAMES.length,
    });

    expect(() => validateProductionBootstrapMigrationAdmission(input({
      releaseManifestPath: ".wrangler/releases/not-allowed/release-manifest.json",
    }))).toThrow("production_bootstrap_release_manifest_forbidden");
    expect(() => validateProductionBootstrapMigrationAdmission(input({
      generatedManifest: {
        ...generatedManifest,
        resources: {
          ...generatedManifest.resources,
          d1: { id: "11111111-1111-4111-8111-111111111111", name: "selinow-production" },
        },
      },
    }))).toThrow("production_bootstrap_database_binding_mismatch");
    expect(() => validateProductionBootstrapMigrationAdmission(input({
      generatedManifest: {
        ...generatedManifest,
        resources: {
          ...generatedManifest.resources,
          platformCacheKv: { id: "invalid", name: "selinow-cache-production" },
        },
      },
    }))).toThrow("production_bootstrap_generated_resource_mismatch:platformCacheKv");
  });

  it("keeps dry-run network-free and does not ask for backup or identity calls", async () => {
    const backup = vi.fn();
    const identity = vi.fn();
    const runner = vi.fn();
    const result = await runProductionBootstrapMigrations(input({
      backupEvidenceImplementation: backup,
      dryRun: true,
      identityImplementation: identity,
      runWranglerImplementation: runner,
    }));

    expect(result).toMatchObject({ databaseName: "selinow-production", executed: false, ok: true });
    expect(backup).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("checks backup first, pins exact identity, applies only forward migrations, then rechecks identity", async () => {
    const events: string[] = [];
    const runner = vi.fn((args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      events.push(`wrangler:${args.join(" ")}`);
      expect(options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT_ID);
      expect(options?.env?.CLOUDFLARE_API_TOKEN).toBe(MIGRATION_TOKEN);
      expect(options?.env).not.toHaveProperty("CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN");
      expect(options?.env).not.toHaveProperty("DATABASE_URL");
      return { stderr: "", stdout: "" };
    });
    let identityCall = 0;
    const identity = vi.fn(() => {
      events.push("identity");
      const migrationNames = identityCall === 0 ? [] : MIGRATIONS;
      identityCall += 1;
      return {
        accountId: ACCOUNT_ID,
        applicationTableNames: [],
        databaseId: DATABASE_ID,
        databaseName: "selinow-production",
        migrationNames,
        secretNames: liveSecretNames,
        resources: liveResources,
      };
    });
    const backup = vi.fn(() => {
      events.push("backup");
      return runtimeBackupEvidence();
    });
    const result = await runProductionBootstrapMigrations(input({
      backupEvidenceImplementation: backup,
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      dryRun: false,
      identityImplementation: identity,
      operatorEnvironment: {
        CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN: MIGRATION_TOKEN,
        DATABASE_URL: "must-not-reach-child",
      },
      runWranglerImplementation: runner,
    }));

    expect(result).toMatchObject({ executed: true, ok: true });
    expect(events).toEqual([
      "backup",
      "identity",
      "wrangler:d1 migrations apply PLATFORM_DB --remote --env production",
      "identity",
    ]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("fails before backup and Wrangler when the dedicated migration token is missing", async () => {
    const backup = vi.fn();
    const identity = vi.fn();
    const runner = vi.fn();
    await expect(runProductionBootstrapMigrations(input({
      backupEvidenceImplementation: backup,
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      dryRun: false,
      identityImplementation: identity,
      operatorEnvironment: { CLOUDFLARE_API_TOKEN: "generic-token" },
      runWranglerImplementation: runner,
    }))).rejects.toThrow("cloudflare_production_bootstrap_migration_api_token_missing");
    expect(backup).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("fails before Wrangler when backup or live identity is not exact", async () => {
    const runner = vi.fn(() => ({ stderr: "", stdout: "" }));
    await expect(runProductionBootstrapMigrations(input({
      backupEvidenceImplementation: () => Promise.reject(new Error("production_bootstrap_backup_target_mismatch")),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      dryRun: false,
      identityImplementation: vi.fn(),
      runWranglerImplementation: runner,
    }))).rejects.toThrow("production_bootstrap_backup_target_mismatch");
    expect(runner).not.toHaveBeenCalled();

    await expect(runProductionBootstrapMigrations(input({
      backupEvidenceImplementation: () => Promise.resolve(runtimeBackupEvidence()),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      dryRun: false,
      identityImplementation: () => Promise.resolve({
        accountId: ACCOUNT_ID,
        applicationTableNames: [],
        databaseId: "11111111-1111-4111-8111-111111111111",
        databaseName: "selinow-production",
        migrationNames: [],
        secretNames: liveSecretNames,
        resources: liveResources,
      }),
      runWranglerImplementation: runner,
    }))).rejects.toThrow("production_bootstrap_live_identity_mismatch");
    expect(runner).not.toHaveBeenCalled();

    await expect(runProductionBootstrapMigrations(input({
      backupEvidenceImplementation: () => Promise.resolve(runtimeBackupEvidence()),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      dryRun: false,
      identityImplementation: () => Promise.resolve({
        accountId: ACCOUNT_ID,
        applicationTableNames: [],
        databaseId: DATABASE_ID,
        databaseName: "selinow-production",
        migrationNames: [],
        secretNames: liveSecretNames,
        resources: { ...liveResources, r2: [] },
      }),
      runWranglerImplementation: runner,
    }))).rejects.toThrow("production_bootstrap_live_resource_identity_mismatch");
    expect(runner).not.toHaveBeenCalled();

    await expect(runProductionBootstrapMigrations(input({
      backupEvidenceImplementation: () => Promise.resolve(runtimeBackupEvidence()),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      dryRun: false,
      identityImplementation: () => Promise.resolve({
        accountId: ACCOUNT_ID,
        applicationTableNames: [],
        databaseId: DATABASE_ID,
        databaseName: "selinow-production",
        migrationNames: [],
        secretNames: liveSecretNames.filter((name) => name !== "CLOUDFLARE_API_TOKEN"),
        resources: liveResources,
      }),
      runWranglerImplementation: runner,
    }))).rejects.toThrow("production_bootstrap_live_secret_inventory_incomplete");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a backup/restore pair that does not match the reviewed ceremony evidence", async () => {
    const runner = vi.fn(() => ({ stderr: "", stdout: "" }));
    await expect(runProductionBootstrapMigrations(input({
      backupEvidenceImplementation: () => Promise.resolve({
        ...runtimeBackupEvidence(),
        reportRef: "private/backup/unreviewed.json",
      }),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      dryRun: false,
      identityImplementation: vi.fn(),
      runWranglerImplementation: runner,
    }))).rejects.toThrow("production_bootstrap_backup_restore_evidence_mismatch");
    expect(runner).not.toHaveBeenCalled();
  });

  it("requires an empty live baseline before apply and the exact ledger afterward", async () => {
    const runner = vi.fn(() => ({ stderr: "", stdout: "" }));
    const baseIdentity = {
      accountId: ACCOUNT_ID,
      applicationTableNames: [],
      databaseId: DATABASE_ID,
      databaseName: "selinow-production",
      migrationNames: [],
      secretNames: liveSecretNames,
      resources: liveResources,
    };
    await expect(runProductionBootstrapMigrations(input({
      backupEvidenceImplementation: () => Promise.resolve(runtimeBackupEvidence()),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      dryRun: false,
      identityImplementation: () => Promise.resolve({
        ...baseIdentity,
        applicationTableNames: ["shops"],
      }),
      runWranglerImplementation: runner,
    }))).rejects.toThrow("production_bootstrap_live_database_not_empty");
    expect(runner).not.toHaveBeenCalled();

    const identity = vi.fn()
      .mockResolvedValueOnce(baseIdentity)
      .mockResolvedValueOnce({ ...baseIdentity, applicationTableNames: ["shops"], migrationNames: [MIGRATIONS[0]] });
    await expect(runProductionBootstrapMigrations(input({
      backupEvidenceImplementation: () => Promise.resolve(runtimeBackupEvidence()),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      dryRun: false,
      identityImplementation: identity,
      runWranglerImplementation: runner,
    }))).rejects.toThrow("production_bootstrap_migration_ledger_incomplete");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("does not contain a Worker deploy or route/cutover sink", () => {
    for (const path of [
      "scripts/production-bootstrap-execute.mjs",
      "scripts/lib/production-bootstrap-execute.mjs",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain("wrangler deploy");
      expect(source).not.toContain("workers routes");
      expect(source).not.toContain("dns");
    }
  });
});
