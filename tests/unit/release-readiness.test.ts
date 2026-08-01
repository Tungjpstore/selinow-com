import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertProductionDeployAdmission,
  assertProductionPreActivationVersions,
  assertProductionWranglerToolchain,
  assertProductionWorkerDeployAdmission,
  buildProductionReleaseGitEnvironment,
  buildProductionReleaseAuditEnvironment,
  buildProductionReleaseEditEnvironment,
  buildReleaseArtifacts,
  captureProductionCandidateVersion,
  createProductionWranglerToolchainAttestation,
  evaluateBackupPrerequisites,
  fingerprintProductionUploadInputs,
  inspectProductionReadiness,
  productionDeploymentVersion,
  removeProductionUploadStage,
  REQUIRED_PRODUCTION_VARS,
  REQUIRED_WORKER_SECRET_NAMES,
  runPilotSmoke,
  runAttestedProductionWrangler,
  runProductionReleaseGit,
  stageProductionUploadInputs,
  validateProductionGeneratedUploadConfig,
  validateProductionCandidateUploadAdmission,
  validateProductionCandidateVersionView,
  validateProductionDeployAdmission,
  validatePilotSmokePlan,
} from "../../scripts/lib/release.mjs";

const now = new Date("2026-07-26T03:00:00.000Z");
const CANDIDATE_VERSION = "22222222-2222-4222-8222-222222222222";
const PREVIOUS_VERSION = "11111111-1111-4111-8111-111111111111";

type ProductionSpecFixture = {
  accountId: string;
  environment: string;
  hostnames: { api: string; dashboard: string; marketing: string };
  resources: {
    d1: string;
    deadLetterQueue: string;
    integrationQueue: string;
    notificationQueue: string;
    platformCacheKv: string;
    privateExports: string;
    r2: string;
    sessionKv: string;
  };
  saas: { cnameTarget: string; fallbackOrigin: string };
  workerName: string;
  zoneId: string;
  zoneName: string;
};

type WranglerFixture = {
  env: {
    production: {
      send_email: Array<{ allowed_sender_addresses: string[]; name: string; remote: boolean }>;
      vars: Record<string, string>;
      [key: string]: unknown;
    };
  };
};

type GeneratedManifestFixture = {
  accountId: string;
  environment: string;
  resources: {
    d1: { id: string; name: string };
    platformCacheKv: { id: string; name: string };
    sessionKv: { id: string; name: string };
  };
  workerName: string;
  zoneId: string;
  zoneName: string;
};

type CandidateViewFixture = {
  annotations: Record<string, string>;
  id: string;
  metadata: Record<string, string>;
  resources: {
    bindings: Array<Record<string, unknown>>;
    script: { handlers: string[] };
  };
};

function readyWranglerConfig(): WranglerFixture {
  const vars = Object.fromEntries(REQUIRED_PRODUCTION_VARS.map((name) => [name, name === "APP_ENV" ? "production" : `configured-${name.toLowerCase()}`]));
  Object.assign(vars, {
    API_ORIGIN: "https://api.selinow.com",
    CANARY_HOSTNAME: "canary.selinow.com",
    CLOUDFLARE_ZONE_ID: "0123456789abcdef0123456789abcdef",
    DASHBOARD_ORIGIN: "https://app.selinow.com",
    EMAIL_FROM_ADDRESS: "no-reply@selinow.com",
    EMAIL_FROM_NAME: "Selinow",
    MEDIA_PUBLIC_BASE_URL: "https://media.selinow.com",
    PLATFORM_BASE_DOMAIN: "selinow.com",
    PLATFORM_ORIGIN: "https://selinow.com",
    RESOURCE_MANIFEST_VERSION: "0123456789abcdef",
    SAAS_CNAME_TARGET: "customers.selinow.com",
    SESSION_COOKIE_NAME: "selinow_session",
  });
  return {
    env: {
      production: {
        assets: { binding: "ASSETS", directory: "./dist" },
        d1_databases: [{ binding: "PLATFORM_DB", database_id: "configured", database_name: "selinow-production" }],
        send_email: [{
          allowed_sender_addresses: ["no-reply@selinow.com"],
          name: "EMAIL",
          remote: true,
        }],
        kv_namespaces: [
          { binding: "PLATFORM_CACHE", id: "configured" },
          { binding: "SESSION", id: "configured" },
        ],
        name: "selinow-com-production",
        observability: { enabled: true },
        preview_urls: false,
        queues: {
          consumers: [{ queue: "selinow-integration-production" }, { queue: "selinow-notification-production" }],
          producers: [
            { binding: "INTEGRATION_QUEUE", queue: "selinow-integration-production" },
            { binding: "NOTIFICATION_QUEUE", queue: "selinow-notification-production" },
          ],
        },
        r2_buckets: [
          { binding: "MEDIA", bucket_name: "selinow-media-production" },
          { binding: "PRIVATE_EXPORTS", bucket_name: "selinow-private-exports-production" },
        ],
        routes: [
          { pattern: "selinow.com" },
          { pattern: "app.selinow.com" },
          { pattern: "api.selinow.com" },
        ],
        triggers: { crons: ["*/15 * * * *"] },
        vars,
        workers_dev: false,
      },
    },
  };
}

function readyProductionSpec(): ProductionSpecFixture {
  return {
    accountId: "abcdef0123456789abcdef0123456789",
    environment: "production",
    hostnames: {
      api: "api.selinow.com",
      dashboard: "app.selinow.com",
      marketing: "selinow.com",
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
    saas: {
      cnameTarget: "customers.selinow.com",
      fallbackOrigin: "proxy-fallback.selinow.com",
    },
    workerName: "selinow-com-production",
    zoneId: "0123456789abcdef0123456789abcdef",
    zoneName: "selinow.com",
  };
}

function readyGeneratedManifest(): GeneratedManifestFixture {
  const spec = readyProductionSpec();
  return {
    accountId: spec.accountId,
    environment: "production",
    resources: {
      d1: { id: "17ea8f2f-4c97-4337-8989-28b25a58ddeb", name: spec.resources.d1 },
      platformCacheKv: { id: "a".repeat(32), name: spec.resources.platformCacheKv },
      sessionKv: { id: "b".repeat(32), name: spec.resources.sessionKv },
    },
    workerName: spec.workerName,
    zoneId: spec.zoneId,
    zoneName: spec.zoneName,
  };
}

function candidateBindings(): Array<Record<string, unknown>> {
  const config = readyWranglerConfig();
  const production = config.env.production;
  const spec = readyProductionSpec();
  const generated = readyGeneratedManifest();
  return [
    ...REQUIRED_PRODUCTION_VARS.map((name) => ({ name, text: production.vars[name], type: "plain_text" })),
    ...REQUIRED_WORKER_SECRET_NAMES.map((name) => ({ name, type: "secret_text" })),
    { name: "ASSETS", type: "assets" },
    { allowed_sender_addresses: ["no-reply@selinow.com"], name: "EMAIL", type: "send_email" },
    { name: "INTEGRATION_QUEUE", queue_name: spec.resources.integrationQueue, type: "queue" },
    { name: "NOTIFICATION_QUEUE", queue_name: spec.resources.notificationQueue, type: "queue" },
    { bucket_name: spec.resources.r2, name: "MEDIA", type: "r2_bucket" },
    { bucket_name: spec.resources.privateExports, name: "PRIVATE_EXPORTS", type: "r2_bucket" },
    { name: "PLATFORM_CACHE", namespace_id: generated.resources.platformCacheKv.id, type: "kv_namespace" },
    { name: "SESSION", namespace_id: generated.resources.sessionKv.id, type: "kv_namespace" },
    {
      database_id: generated.resources.d1.id,
      id: generated.resources.d1.id,
      name: "PLATFORM_DB",
      type: "d1",
    },
  ];
}

function candidateVersionView(overrides: Partial<CandidateViewFixture> = {}): CandidateViewFixture {
  return {
    annotations: {
      "workers/message": "normal release candidate 0123456789abcdef0123456789abcdef01234567",
      "workers/tag": "release_20260726_abcdef12",
      "workers/triggered_by": "version_upload",
    },
    id: CANDIDATE_VERSION,
    metadata: { source: "wrangler" },
    resources: {
      bindings: candidateBindings(),
      script: { handlers: ["fetch", "queue", "scheduled"] },
    },
    ...overrides,
  };
}

function liveCandidateReport(): Record<string, unknown> {
  return {
    accountId: "abcdef0123456789abcdef0123456789",
    artifactSha256: "c".repeat(64),
    bindingNames: candidateBindings().map((binding) => binding.name).sort(),
    candidateWorkerVersion: CANDIDATE_VERSION,
    createdAt: "2026-07-26T02:45:00.000Z",
    environment: "production",
    mode: "normal_release_candidate_upload",
    previousWorkerVersion: PREVIOUS_VERSION,
    releaseId: "release_20260726_abcdef12",
    reviewedCommitSha: "0123456789abcdef0123456789abcdef01234567",
    reviewedTreeSha: "a".repeat(40),
    schemaVersion: 1,
    tag: "release_20260726_abcdef12",
    workerName: "selinow-com-production",
    zoneId: "0123456789abcdef0123456789abcdef",
  };
}

function readyEvidence(): Record<string, unknown> {
  return {
    approvals: { releaseOwner: "release-team", supportOwner: "support-team" },
    backup: {
      completedAt: "2026-07-26T02:30:00.000Z",
      providerBookmarkRecorded: true,
      restoreDrillCompletedAt: "2026-07-20T02:30:00.000Z",
      restoreDrillPassed: true,
      restoreDrillReportRef: "private-restore-report",
      snapshotReportRef: "private-backup-report",
    },
    candidateUpload: {
      completedAt: "2026-07-26T02:45:00.000Z",
      reportRef: "private-candidate-upload-report",
      reportSha256: "a".repeat(64),
      reviewedCommitSha: "0123456789abcdef0123456789abcdef01234567",
    },
    candidateWorkerVersion: CANDIDATE_VERSION,
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    manualAcceptance: { customDomain: true, paymentSignedEvent: true, telegram: true, website: true },
    monitoring: { alertsReady: true, budgetAlertsReady: true, dashboardReady: true },
    pilot: { shopCount: 2 },
    previousWorkerVersion: PREVIOUS_VERSION,
    quality: { build: true, check: true, deployDryRun: true, lint: true, test: true },
    releaseId: "release_20260726_abcdef12",
    security: { criticalOpen: 0, highOpen: 0 },
    staging: { accepted: true, acceptedAt: "2026-07-26T01:00:00.000Z" },
  };
}

function smokePlan(): Record<string, unknown> {
  return {
    checks: [
      {
        bodyMarker: "Selinow",
        expectedStatus: 200,
        kind: "pilot_storefront",
        name: "pilot_one",
        requiredHeaders: ["x-request-id"],
        url: "https://pilot-one.selinow.com/",
      },
      {
        expectedStatus: 200,
        kind: "pilot_storefront",
        name: "pilot_two",
        requiredHeaders: ["x-request-id"],
        url: "https://pilot-two.selinow.com/",
      },
    ],
    environment: "production",
    releaseId: "release_20260726_abcdef12",
  };
}

describe("production release readiness", () => {
  it("passes only when config, secret names and release evidence are complete", () => {
    const result = inspectProductionReadiness({
      evidence: readyEvidence(),
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("reports missing names without echoing configuration values", () => {
    const config = readyWranglerConfig();
    const production = (config.env as { production: { vars: Record<string, string> } }).production;
    production.vars.CLOUDFLARE_ZONE_ID = "top-secret-looking-value";
    delete production.vars.EMAIL_FROM_ADDRESS;

    const result = inspectProductionReadiness({
      evidence: null,
      now,
      productionSpec: null,
      workerSecretNames: [],
      wranglerConfig: config,
    });
    const output = JSON.stringify(result);

    expect(result.ok).toBe(false);
    expect(result.missing).toContain("var.EMAIL_FROM_ADDRESS");
    expect(output).not.toContain("top-secret-looking-value");
  });

  it("fails stale backup and restore evidence closed", () => {
    const evidence = readyEvidence();
    const backup = evidence.backup as Record<string, unknown>;
    backup.completedAt = "2026-07-24T00:00:00.000Z";
    backup.restoreDrillCompletedAt = "2026-05-01T00:00:00.000Z";

    const checks = evaluateBackupPrerequisites(evidence, now);

    expect(checks.find((check) => check.name === "backup.completedAt")?.ok).toBe(false);
    expect(checks.find((check) => check.name === "backup.restoreDrillCompletedAt")?.ok).toBe(false);
  });

  it("admits a candidate upload only while the candidate fields are pending", () => {
    const evidence = readyEvidence();
    evidence.candidateWorkerVersion = null;
    evidence.candidateUpload = null;

    expect(validateProductionCandidateUploadAdmission({
      evidence,
      migrationNames: ["0001_first.sql"],
      now,
      packageVersion: "0.0.0",
      productionSpec: readyProductionSpec(),
      repositoryClean: true,
      repositoryCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    })).toEqual({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      previousWorkerVersion: PREVIOUS_VERSION,
      releaseId: "release_20260726_abcdef12",
    });

    evidence.previousWorkerVersion = "worker-current";
    expect(() => validateProductionCandidateUploadAdmission({
      evidence,
      migrationNames: ["0001_first.sql"],
      now,
      packageVersion: "0.0.0",
      productionSpec: readyProductionSpec(),
      repositoryClean: true,
      repositoryCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    })).toThrow("production_candidate_prerequisites_incomplete:evidence.previousWorkerVersion");
  });

  it("captures exactly one new candidate without changing the active deployment", () => {
    expect(captureProductionCandidateVersion({
      activeVersionId: PREVIOUS_VERSION,
      afterVersions: [{ id: PREVIOUS_VERSION }, { id: CANDIDATE_VERSION }],
      beforeVersions: [{ id: PREVIOUS_VERSION }],
    })).toBe(CANDIDATE_VERSION);
    expect(() => captureProductionCandidateVersion({
      activeVersionId: PREVIOUS_VERSION,
      afterVersions: [
        { id: PREVIOUS_VERSION },
        { id: CANDIDATE_VERSION },
        { id: "33333333-3333-4333-8333-333333333333" },
      ],
      beforeVersions: [{ id: PREVIOUS_VERSION }],
    })).toThrow("production_candidate_capture_invalid");
  });

  it("requires the complete production handler and binding contract", () => {
    expect(validateProductionCandidateVersionView(candidateVersionView(), CANDIDATE_VERSION, {
      generatedManifest: readyGeneratedManifest(),
      productionSpec: readyProductionSpec(),
      wranglerConfig: readyWranglerConfig(),
    })).toEqual(candidateBindings().map((binding) => binding.name).sort());
    const mismatch = candidateVersionView();
    const appEnvBinding = mismatch.resources.bindings.find((binding) => binding.name === "APP_ENV");
    if (appEnvBinding === undefined) throw new Error("test_fixture_binding_missing");
    appEnvBinding.text = "staging";
    expect(() => validateProductionCandidateVersionView(mismatch, CANDIDATE_VERSION, {
      generatedManifest: readyGeneratedManifest(),
      productionSpec: readyProductionSpec(),
      wranglerConfig: readyWranglerConfig(),
    })).toThrow("production_candidate_binding_mismatch:APP_ENV:text");
    const missingHandler = candidateVersionView();
    missingHandler.resources.script.handlers = ["fetch", "queue"];
    expect(() => validateProductionCandidateVersionView(missingHandler, CANDIDATE_VERSION, {
      generatedManifest: readyGeneratedManifest(),
      productionSpec: readyProductionSpec(),
      wranglerConfig: readyWranglerConfig(),
    })).toThrow("production_candidate_view_invalid");
  });

  it("rejects an already-active candidate and active-version drift before activation", () => {
    const baseline = {
      activeWorkerVersion: PREVIOUS_VERSION,
      previousWorkerVersion: PREVIOUS_VERSION,
    };
    expect(assertProductionPreActivationVersions(baseline)).toBe(PREVIOUS_VERSION);
    expect(() => assertProductionPreActivationVersions({
      activeWorkerVersion: CANDIDATE_VERSION,
      previousWorkerVersion: PREVIOUS_VERSION,
    })).toThrow("production_deploy_previous_version_mismatch");
    expect(() => assertProductionPreActivationVersions(baseline, {
      activeWorkerVersion: CANDIDATE_VERSION,
      previousWorkerVersion: PREVIOUS_VERSION,
    })).toThrow("production_deploy_active_version_changed");
  });

  it("pins release audit subprocesses to the audit token and strips broader credentials", () => {
    const environment = buildProductionReleaseAuditEnvironment({
      CLOUDFLARE_OAUTH_TOKEN: "oauth-token",
      CLOUDFLARE_PLATFORM_API_TOKEN: "platform-token",
      CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN: "bootstrap-token",
      CLOUDFLARE_PRODUCTION_EMPTY_BASELINE_API_TOKEN: "baseline-token",
      CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN: "promotion-audit-token",
      CLOUDFLARE_PRODUCTION_PROMOTION_ROUTE_API_TOKEN: "promotion-route-token",
      CLOUDFLARE_RELEASE_WORKER_API_TOKEN: "edit-token",
      CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "audit-custom-token",
    }, "abcdef0123456789abcdef0123456789", "audit-token");
    expect(environment.CLOUDFLARE_API_TOKEN).toBe("audit-token");
    expect(environment.CLOUDFLARE_ACCOUNT_ID).toBe("abcdef0123456789abcdef0123456789");
    expect(environment.CLOUDFLARE_OAUTH_TOKEN).toBeUndefined();
    expect(environment.CLOUDFLARE_RELEASE_WORKER_API_TOKEN).toBeUndefined();
    expect(JSON.stringify(environment)).not.toContain("edit-token");
    expect(JSON.stringify(environment)).not.toContain("oauth-token");
    expect(JSON.stringify(environment)).not.toContain("bootstrap-token");
    expect(JSON.stringify(environment)).not.toContain("promotion-route-token");
  });

  it("isolates release edit subprocesses from every competing credential", () => {
    const environment = buildProductionReleaseEditEnvironment({
      CF_API_KEY: "cf-key",
      CF_API_TOKEN: "cf-token",
      CLOUDFLARE_API_KEY: "api-key",
      CLOUDFLARE_CANARY_WORKER_API_TOKEN: "canary-token",
      CLOUDFLARE_EMAIL: "operator@example.com",
      CLOUDFLARE_OAUTH_TOKEN: "oauth-token",
      CLOUDFLARE_PLATFORM_API_TOKEN: "platform-token",
      CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN: "bootstrap-token",
      CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN: "promotion-token",
      CLOUDFLARE_RELEASE_WORKER_API_TOKEN: "named-edit-token",
      CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "audit-token",
    }, "abcdef0123456789abcdef0123456789", "edit-token");
    expect(environment.CLOUDFLARE_API_TOKEN).toBe("edit-token");
    expect(environment.CLOUDFLARE_ACCOUNT_ID).toBe("abcdef0123456789abcdef0123456789");
    expect(environment.CLOUDFLARE_RELEASE_WORKER_API_TOKEN).toBeUndefined();
    expect(environment.CLOUDFLARE_ROUTE_AUDIT_API_TOKEN).toBeUndefined();
    expect(JSON.stringify(environment)).not.toContain("oauth-token");
    expect(JSON.stringify(environment)).not.toContain("platform-token");
    expect(JSON.stringify(environment)).not.toContain("named-edit-token");
  });

  it("fingerprints all immutable upload inputs and detects post-build drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-upload-inputs-"));
    try {
      await mkdir(join(root, "dist/assets"), { recursive: true });
      await mkdir(join(root, "dist/server"), { recursive: true });
      await writeFile(join(root, "wrangler.jsonc"), "{\"name\":\"candidate\"}\n");
      await writeFile(join(root, "dist/_worker.js"), "export default {};\n");
      await writeFile(join(root, "dist/server/wrangler.json"), "{\"name\":\"candidate\"}\n");
      await writeFile(join(root, "dist/assets/app.css"), "body{}\n");
      const before = await fingerprintProductionUploadInputs(root);
      await writeFile(join(root, "dist/assets/app.css"), "body{color:red}\n");
      const after = await fingerprintProductionUploadInputs(root);
      expect(before).toMatch(/^[a-f0-9]{64}$/u);
      expect(after).not.toBe(before);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("stages sealed upload inputs without inheriting Wrangler redirect state", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-upload-stage-"));
    const releaseId = "release_20260801_uploadseal";
    let stageRoot: string | null = null;
    try {
      await mkdir(join(root, ".wrangler/deploy"), { recursive: true });
      await mkdir(join(root, "dist/server"), { recursive: true });
      await mkdir(join(root, "dist/client"), { recursive: true });
      await writeFile(join(root, "wrangler.jsonc"), "{\"name\":\"candidate\"}\n");
      await writeFile(join(root, ".wrangler/deploy/config.json"), JSON.stringify({
        configPath: "../../hostile.json",
      }));
      await writeFile(join(root, "dist/server/entry.mjs"), "export default {};\n");
      await writeFile(join(root, "dist/server/wrangler.json"), "{\"name\":\"candidate\"}\n");
      await writeFile(join(root, "dist/client/app.css"), "body{}\n");
      const sourceBefore = await fingerprintProductionUploadInputs(root);
      const staged = await stageProductionUploadInputs(root, releaseId);
      stageRoot = staged.stageRoot;
      expect(staged.artifactSha256).toBe(sourceBefore);
      expect(await fingerprintProductionUploadInputs(stageRoot)).toBe(sourceBefore);
      await expect(readFile(join(stageRoot, ".wrangler/deploy/config.json"))).rejects.toThrow();
      await writeFile(join(root, "wrangler.jsonc"), "{\"name\":\"drifted\"}\n");
      expect(await fingerprintProductionUploadInputs(root)).not.toBe(sourceBefore);
      expect(await fingerprintProductionUploadInputs(stageRoot)).toBe(sourceBefore);
      await expect(writeFile(join(stageRoot, "wrangler.jsonc"), "{}\n")).rejects.toThrow();
    } finally {
      if (stageRoot !== null) {
        await removeProductionUploadStage(stageRoot, root, releaseId);
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  it("validates the generated production upload config and module rules", () => {
    const productionSpec = readyProductionSpec();
    const generatedManifest = readyGeneratedManifest();
    const config = {
      assets: { binding: "ASSETS", directory: "../client", run_worker_first: false },
      d1_databases: [{
        binding: "PLATFORM_DB",
        database_id: generatedManifest.resources.d1.id,
        database_name: generatedManifest.resources.d1.name,
      }],
      main: "entry.mjs",
      name: productionSpec.workerName,
      no_bundle: true,
      rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
      vars: { APP_ENV: "production" },
    };
    const input = { generatedManifest, productionSpec };
    expect(validateProductionGeneratedUploadConfig(config, input)).toBe(true);
    expect(() => validateProductionGeneratedUploadConfig({ ...config, rules: [] }, input)).toThrow(
      "production_candidate_upload_config_invalid",
    );
    for (const executableConfig of [
      { ...config, build: { command: "touch marker" } },
      { ...config, build: {} },
      { ...config, build: null },
      { ...config, "build.command": "touch marker" },
    ]) {
      expect(() => validateProductionGeneratedUploadConfig(executableConfig, input)).toThrow(
        "production_candidate_upload_config_executable_field_forbidden",
      );
    }
  });

  it("rejects generated Wrangler build commands before hashing or staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-upload-command-"));
    try {
      await mkdir(join(root, "dist/server"), { recursive: true });
      await mkdir(join(root, "dist/client"), { recursive: true });
      await writeFile(join(root, "wrangler.jsonc"), "{}\n");
      await writeFile(join(root, "dist/server/entry.mjs"), "export default {};\n");
      await writeFile(join(root, "dist/client/app.css"), "body{}\n");
      await writeFile(join(root, "dist/server/wrangler.json"), JSON.stringify({
        build: { command: "touch should-not-run" },
        main: "entry.mjs",
      }));
      await expect(fingerprintProductionUploadInputs(root)).rejects.toThrow(
        "production_candidate_upload_config_executable_field_forbidden",
      );
      await expect(stageProductionUploadInputs(root, "release_20260801_buildguard")).rejects.toThrow(
        "production_candidate_upload_config_executable_field_forbidden",
      );
      await expect(readFile(join(root, ".wrangler/releases/release_20260801_buildguard"))).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("sanitizes Git repository and config redirects for release checks", async () => {
    const hostileEnvironment = {
      ...process.env,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/hostile/objects",
      GIT_COMMON_DIR: "/hostile/common",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_GLOBAL: "/hostile/gitconfig",
      GIT_CONFIG_KEY_0: "core.sshCommand",
      GIT_CONFIG_SYSTEM: "/hostile/system",
      GIT_CONFIG_VALUE_0: "hostile",
      GIT_DIR: "/hostile/repo/.git",
      GIT_EXEC_PATH: "/hostile/exec",
      GIT_INDEX_FILE: "/hostile/index",
      GIT_OBJECT_DIRECTORY: "/hostile/object-dir",
      GIT_WORK_TREE: "/hostile/worktree",
      XDG_CONFIG_HOME: "/hostile/xdg",
    };
    const sanitized = buildProductionReleaseGitEnvironment(hostileEnvironment);
    expect(sanitized.GIT_DIR).toBeUndefined();
    expect(sanitized.GIT_WORK_TREE).toBeUndefined();
    expect(sanitized.GIT_INDEX_FILE).toBeUndefined();
    expect(sanitized.GIT_OBJECT_DIRECTORY).toBeUndefined();
    expect(sanitized.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
    expect(sanitized.GIT_COMMON_DIR).toBeUndefined();
    expect(sanitized.GIT_CONFIG_COUNT).toBeUndefined();
    expect(sanitized.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(sanitized.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(sanitized.GIT_EXEC_PATH).toBeUndefined();
    expect(sanitized.XDG_CONFIG_HOME).toBeUndefined();
    expect(sanitized.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(sanitized.GIT_CONFIG_GLOBAL).toBe(process.platform === "win32" ? "NUL" : "/dev/null");

    const root = await mkdtemp(join(tmpdir(), "selinow-git-env-"));
    const repositoryA = join(root, "a");
    const repositoryB = join(root, "b");
    const initialize = async (repository: string, content: string) => {
      await mkdir(repository);
      execFileSync("git", ["init", "-q"], { cwd: repository, env: sanitized });
      await writeFile(join(repository, "value.txt"), content);
      execFileSync("git", ["add", "value.txt"], { cwd: repository, env: sanitized });
      execFileSync("git", ["-c", "user.name=Selinow Test", "-c", "user.email=test@selinow.invalid", "commit", "-q", "-m", "fixture"], {
        cwd: repository,
        env: sanitized,
      });
    };
    try {
      await initialize(repositoryA, "a\n");
      await initialize(repositoryB, "b\n");
      const expected = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryA,
        encoding: "utf8",
        env: sanitized,
      }).trim();
      const result = runProductionReleaseGit(["rev-parse", "HEAD"], {
        cwd: repositoryA,
        environment: {
          ...hostileEnvironment,
          GIT_DIR: join(repositoryB, ".git"),
          GIT_WORK_TREE: repositoryB,
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("captures binary Git diffs larger than the Node default subprocess buffer", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-git-buffer-"));
    try {
      await writeFile(join(root, "empty.bin"), Buffer.alloc(0));
      await writeFile(join(root, "large.bin"), randomBytes(2 * 1024 * 1024));
      const result = runProductionReleaseGit([
        "diff", "--no-index", "--binary", "--", "empty.bin", "large.bin",
      ], { cwd: root });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(1024 * 1024);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("attests and directly executes the pinned Wrangler package without Node preload hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-wrangler-attestation-"));
    try {
      await mkdir(join(root, "node_modules/.bin"), { recursive: true });
      await mkdir(join(root, "node_modules/wrangler/bin"), { recursive: true });
      await mkdir(join(root, "node_modules/wrangler/wrangler-dist"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { wrangler: "4.114.0" } }));
      await writeFile(join(root, "package-lock.json"), JSON.stringify({
        packages: { "node_modules/wrangler": { integrity: "sha512-fixture", version: "4.114.0" } },
      }));
      await writeFile(join(root, "node_modules/wrangler/package.json"), JSON.stringify({
        bin: { wrangler: "./bin/wrangler.js" },
        main: "wrangler-dist/cli.js",
        name: "wrangler",
        version: "4.114.0",
      }));
      await writeFile(join(root, "node_modules/wrangler/bin/wrangler.js"), "#!/usr/bin/env node\n");
      await writeFile(join(root, "node_modules/wrangler/wrangler-dist/cli.js"), "process.stdout.write(`fixture:${process.argv.slice(2).join(',')}`);\n");
      await symlink("../wrangler/bin/wrangler.js", join(root, "node_modules/.bin/wrangler"));
      const attestation = await createProductionWranglerToolchainAttestation(root);
      expect(attestation).toMatchObject({ packageVersion: "4.114.0" });
      const marker = join(root, "node-preload-marker");
      const preload = join(root, "preload.cjs");
      await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe");\n`);
      const result = await runAttestedProductionWrangler(attestation, ["versions", "list"], {
        cwd: root,
        env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, NODE_PATH: root },
        repositoryRoot: root,
      });
      expect(result.stdout).toBe("fixture:versions,list");
      await expect(readFile(marker)).rejects.toThrow();
      await writeFile(join(root, "node_modules/wrangler/wrangler-dist/cli.js"), "process.stdout.write('mutated');\n");
      await expect(assertProductionWranglerToolchain(attestation, root)).rejects.toThrow(
        "production_release_wrangler_toolchain_drift",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });


  it("requires one unambiguous 100 percent active deployment", () => {
    expect(productionDeploymentVersion([{ created_on: now.toISOString(), versions: [{
      percentage: 100,
      version_id: PREVIOUS_VERSION,
    }] }])).toBe(PREVIOUS_VERSION);
    expect(() => productionDeploymentVersion([{ created_on: now.toISOString(), versions: [
      { percentage: 50, version_id: PREVIOUS_VERSION },
      { percentage: 50, version_id: CANDIDATE_VERSION },
    ] }])).toThrow("production_worker_deployments_invalid");
  });

  it("builds a value-safe manifest and rollback matrix after readiness passes", () => {
    const result = buildReleaseArtifacts({
      evidence: readyEvidence(),
      migrationNames: ["0002_second.sql", "0001_first.sql"],
      now,
      packageVersion: "0.0.0",
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });

    expect(result.manifest.releaseId).toBe("release_20260726_abcdef12");
    expect(result.manifest.migrationNames).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect(result.manifest.schemaVersion).toBe(3);
    expect(result.manifest.candidateUpload).toEqual({
      completedAt: "2026-07-26T02:45:00.000Z",
      reportRef: "private-candidate-upload-report",
      reportSha256: "a".repeat(64),
    });
    expect(result.manifest.releaseEvidenceFingerprintSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.rollbackMatrix).toHaveLength(6);
    expect(JSON.stringify(result)).not.toContain("snapshotReportRef");
  });

  it("admits only a clean source tree matching the reviewed release manifest", () => {
    const evidence = readyEvidence();
    const migrationNames = ["0001_first.sql", "0002_second.sql"];
    const wranglerConfig = readyWranglerConfig();
    const productionSpec = readyProductionSpec();
    const manifest = buildReleaseArtifacts({
      evidence,
      migrationNames,
      now,
      packageVersion: "0.0.0",
      productionSpec,
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig,
    }).manifest;

    expect(validateProductionDeployAdmission({
      evidence,
      manifest,
      migrationNames,
      now,
      packageVersion: "0.0.0",
      productionSpec,
      repositoryClean: true,
      repositoryCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig,
    })).toEqual({
      candidateWorkerVersion: CANDIDATE_VERSION,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      previousWorkerVersion: PREVIOUS_VERSION,
      releaseId: "release_20260726_abcdef12",
    });

    expect(() => validateProductionDeployAdmission({
      evidence,
      manifest,
      migrationNames,
      now,
      packageVersion: "0.0.0",
      productionSpec,
      repositoryClean: false,
      repositoryCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig,
    })).toThrow("production_release_source_dirty");
  });

  it("rejects a manifest when reviewed evidence or repository identity drifts", () => {
    const evidence = readyEvidence();
    const migrationNames = ["0001_first.sql", "0002_second.sql"];
    const wranglerConfig = readyWranglerConfig();
    const productionSpec = readyProductionSpec();
    const manifest = buildReleaseArtifacts({
      evidence,
      migrationNames,
      now,
      packageVersion: "0.0.0",
      productionSpec,
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig,
    }).manifest;
    const changedEvidence = structuredClone(evidence);
    (changedEvidence.approvals as Record<string, unknown>).releaseOwner = "different-release-team";

    const input = {
      evidence: changedEvidence,
      manifest,
      migrationNames,
      now,
      packageVersion: "0.0.0",
      productionSpec,
      repositoryClean: true,
      repositoryCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig,
    };
    expect(() => validateProductionDeployAdmission(input))
      .toThrow("production_release_manifest_mismatch:releaseEvidenceFingerprintSha256");
    expect(() => validateProductionDeployAdmission({
      ...input,
      evidence,
      repositoryCommitSha: "abcdef0123456789abcdef0123456789abcdef01",
    })).toThrow("production_release_evidence_commit_mismatch");
    expect(() => validateProductionDeployAdmission({
      ...input,
      evidence,
      migrationNames: [...migrationNames, "0003_new.sql"],
    })).toThrow("production_release_manifest_mismatch:migrationNames");
    const changedConfig = structuredClone(wranglerConfig);
    ((changedConfig.env as Record<string, unknown>).production as {
      vars: Record<string, string>;
    }).vars.LOG_LEVEL = "info";
    expect(() => validateProductionDeployAdmission({
      ...input,
      evidence,
      wranglerConfig: changedConfig,
    })).toThrow("production_release_manifest_mismatch:configFingerprintSha256");
  });

  it("checks the canonical private manifest and clean Git identity at deploy admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-release-admission-"));
    try {
      const releaseId = "release_20260726_abcdef12";
      await Promise.all([
        mkdir(join(root, "infra/environments"), { recursive: true }),
        mkdir(join(root, "migrations"), { recursive: true }),
        mkdir(join(root, ".wrangler/release"), { recursive: true }),
        mkdir(join(root, ".wrangler/releases", releaseId), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, ".gitignore"), ".wrangler/\n"),
        writeFile(join(root, "package.json"), JSON.stringify({ version: "0.0.0" })),
        writeFile(join(root, "wrangler.jsonc"), JSON.stringify(readyWranglerConfig())),
        writeFile(join(root, "infra/environments/production.json"), JSON.stringify(readyProductionSpec())),
        writeFile(join(root, "migrations/0001_first.sql"), "SELECT 1;\n"),
      ]);
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["config", "user.email", "release-test@selinow.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Selinow Release Test"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "release fixture"], { cwd: root });
      const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
      const evidence = readyEvidence();
      evidence.commitSha = commitSha;
      const candidateReport = {
        accountId: "abcdef0123456789abcdef0123456789",
        artifactSha256: "c".repeat(64),
        bindingNames: candidateBindings().map((binding) => binding.name).sort(),
        candidateWorkerVersion: CANDIDATE_VERSION,
        createdAt: "2026-07-26T02:45:00.000Z",
        environment: "production",
        mode: "normal_release_candidate_upload",
        previousWorkerVersion: PREVIOUS_VERSION,
        releaseId,
        reviewedCommitSha: commitSha,
        reviewedTreeSha: treeSha,
        schemaVersion: 1,
        tag: releaseId,
        workerName: "selinow-com-production",
        zoneId: "0123456789abcdef0123456789abcdef",
      };
      const candidateReportText = `${JSON.stringify(candidateReport, null, 2)}\n`;
      evidence.candidateUpload = {
        completedAt: candidateReport.createdAt,
        reportRef: `.wrangler/releases/${releaseId}/candidate-upload.json`,
        reportSha256: createHash("sha256").update(candidateReportText).digest("hex"),
        reviewedCommitSha: commitSha,
      };
      const manifest = buildReleaseArtifacts({
        evidence,
        migrationNames: ["0001_first.sql"],
        now,
        packageVersion: "0.0.0",
        productionSpec: readyProductionSpec(),
        workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
        wranglerConfig: readyWranglerConfig(),
      }).manifest;
      const evidencePath = join(root, ".wrangler/release/production-evidence.json");
      const manifestPath = join(root, ".wrangler/releases", releaseId, "release-manifest.json");
      await writeFile(join(root, ".wrangler/releases", releaseId, "candidate-upload.json"), candidateReportText, { mode: 0o600 });
      await writeFile(evidencePath, JSON.stringify(evidence), { mode: 0o600 });
      await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });

      await expect(assertProductionDeployAdmission({
        manifestPath,
        now,
        repositoryRoot: root,
        workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      })).resolves.toMatchObject({
        candidateReport,
        candidateWorkerVersion: CANDIDATE_VERSION,
        commitSha,
        previousWorkerVersion: PREVIOUS_VERSION,
        releaseId,
      });

      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.0.1" }));
      await expect(assertProductionDeployAdmission({
        manifestPath,
        now,
        repositoryRoot: root,
        workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      })).rejects.toThrow("production_release_source_dirty");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("combines reviewed release evidence with the exact live production target", async () => {
    const releaseAdmission = vi.fn(() => Promise.resolve({
      candidateReport: liveCandidateReport(),
      candidateWorkerVersion: CANDIDATE_VERSION,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      previousWorkerVersion: PREVIOUS_VERSION,
      releaseId: "release_20260726_abcdef12",
    }));
    const workerIdentity = vi.fn(() => Promise.resolve({
      accountId: "abcdef0123456789abcdef0123456789",
      databaseId: "17ea8f2f-4c97-4337-8989-28b25a58ddeb",
      databaseName: "selinow-production",
      workerName: "selinow-com-production",
      zoneId: "0123456789abcdef0123456789abcdef",
      zoneName: "selinow.com",
    }));

    await expect(assertProductionWorkerDeployAdmission({
      assertReleaseAdmissionImplementation: releaseAdmission,
      candidateVersionViewImplementation: vi.fn(() => Promise.resolve(candidateVersionView())),
      deploymentInventoryImplementation: vi.fn(() => Promise.resolve({
        deployments: [{
          created_on: "2026-07-26T02:00:00.000Z",
          versions: [{ percentage: 100, version_id: PREVIOUS_VERSION }],
        }],
      })),
      environment: { CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-audit-token" },
      generatedManifest: readyGeneratedManifest(),
      manifestPath: ".wrangler/releases/release_20260726_abcdef12/release-manifest.json",
      productionSpec: readyProductionSpec(),
      repositoryRoot: process.cwd(),
      stagingSpec: { environment: "staging" },
      workerIdentityImplementation: workerIdentity,
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    })).resolves.toEqual({
      accountId: "abcdef0123456789abcdef0123456789",
      activeWorkerVersion: PREVIOUS_VERSION,
      bindingNames: candidateBindings().map((binding) => binding.name).sort(),
      candidateReport: liveCandidateReport(),
      candidateWorkerVersion: CANDIDATE_VERSION,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      databaseId: "17ea8f2f-4c97-4337-8989-28b25a58ddeb",
      databaseName: "selinow-production",
      previousWorkerVersion: PREVIOUS_VERSION,
      releaseId: "release_20260726_abcdef12",
      workerName: "selinow-com-production",
      zoneId: "0123456789abcdef0123456789abcdef",
      zoneName: "selinow.com",
    });
    expect(releaseAdmission).toHaveBeenCalledTimes(1);
    expect(workerIdentity).toHaveBeenCalledWith(expect.objectContaining({
      productionSpec: readyProductionSpec(),
      token: "route-audit-token",
      wranglerConfig: readyWranglerConfig(),
    }));
  });

  it("rejects a missing or binding-mismatched live candidate version", async () => {
    const releaseAdmission = vi.fn(() => Promise.resolve({
      candidateReport: liveCandidateReport(),
      candidateWorkerVersion: CANDIDATE_VERSION,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      previousWorkerVersion: PREVIOUS_VERSION,
      releaseId: "release_20260726_abcdef12",
    }));
    const common = {
      assertReleaseAdmissionImplementation: releaseAdmission,
      deploymentInventoryImplementation: vi.fn(() => Promise.resolve({
        deployments: [{
          created_on: "2026-07-26T02:00:00.000Z",
          versions: [{ percentage: 100, version_id: PREVIOUS_VERSION }],
        }],
      })),
      environment: { CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-audit-token" },
      generatedManifest: readyGeneratedManifest(),
      manifestPath: ".wrangler/releases/release_20260726_abcdef12/release-manifest.json",
      productionSpec: readyProductionSpec(),
      repositoryRoot: process.cwd(),
      stagingSpec: { environment: "staging" },
      workerIdentityImplementation: vi.fn(() => Promise.resolve({
        accountId: "abcdef0123456789abcdef0123456789",
        databaseId: "17ea8f2f-4c97-4337-8989-28b25a58ddeb",
        databaseName: "selinow-production",
        workerName: "selinow-com-production",
        zoneId: "0123456789abcdef0123456789abcdef",
        zoneName: "selinow.com",
      })),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    };
    await expect(assertProductionWorkerDeployAdmission({
      ...common,
      candidateVersionViewImplementation: vi.fn(() => Promise.reject(new Error("missing"))),
    })).rejects.toThrow("production_candidate_version_unavailable");
    const mismatch = candidateVersionView();
    const appEnvBinding = mismatch.resources.bindings.find((binding) => binding.name === "APP_ENV");
    if (appEnvBinding === undefined) throw new Error("test_fixture_binding_missing");
    appEnvBinding.text = "staging";
    await expect(assertProductionWorkerDeployAdmission({
      ...common,
      candidateVersionViewImplementation: vi.fn(() => Promise.resolve(mismatch)),
    })).rejects.toThrow("production_candidate_binding_mismatch:APP_ENV:text");
  });

  it("keeps pilot smoke in plan mode without network access by default", async () => {
    const fetchImplementation = vi.fn();

    const result = await runPilotSmoke({
      confirmProduction: false,
      execute: false,
      fetchImplementation,
      plan: smokePlan(),
    });

    expect(result.executed).toBe(false);
    expect(result.ok).toBe(true);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("requires explicit production confirmation before smoke network calls", async () => {
    await expect(runPilotSmoke({
      confirmProduction: false,
      execute: true,
      plan: smokePlan(),
    })).rejects.toThrow("pilot_production_confirmation_required");
  });

  it("runs bounded GET-only smoke checks without returning response bodies", async () => {
    const fetchImplementation = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      return Promise.resolve(new Response("Selinow storefront", {
        headers: { "X-Request-Id": "request-safe" },
        status: 200,
      }));
    }) as unknown as typeof fetch;

    const result = await runPilotSmoke({
      confirmProduction: true,
      execute: true,
      fetchImplementation,
      plan: smokePlan(),
    });

    expect(result.ok).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("Selinow storefront");
  });

  it("rejects query-bearing URLs and plans without two pilot hosts", () => {
    const queryPlan = smokePlan();
    ((queryPlan.checks as Array<Record<string, unknown>>)[0] as Record<string, unknown>).url = "https://pilot-one.selinow.com/?token=unsafe";
    expect(() => validatePilotSmokePlan(queryPlan)).toThrow("pilot_check_url_invalid:pilot_one");

    const oneHostPlan = smokePlan();
    ((oneHostPlan.checks as Array<Record<string, unknown>>)[1] as Record<string, unknown>).url = "https://pilot-one.selinow.com/other";
    expect(() => validatePilotSmokePlan(oneHostPlan)).toThrow("pilot_plan_two_shop_hosts_required");

    const placeholderPlan = smokePlan();
    placeholderPlan.releaseId = "replace-with-release-id";
    expect(() => validatePilotSmokePlan(placeholderPlan)).toThrow("pilot_plan_release_id_invalid");
  });
});
