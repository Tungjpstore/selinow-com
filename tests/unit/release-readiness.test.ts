import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertProductionWorkerDeployAdmission,
  buildProductionRollbackRehearsalArtifact,
  buildReleaseArtifacts,
  evaluateBackupPrerequisites,
  inspectProductionReadiness,
  REQUIRED_PRODUCTION_ROLLBACK_INVARIANTS,
  REQUIRED_PRODUCTION_VARS,
  REQUIRED_WORKER_SECRET_NAMES,
  runPilotSmoke,
  validateProductionDeployAdmission,
  validateProductionRollbackArtifact,
  validatePilotSmokePlan,
  writeProductionRollbackRehearsalArtifact,
} from "../../scripts/lib/release.mjs";
import {
  collectDodoStagingUatEvidence,
  DODO_SCENARIO_EXECUTION_CONTRACTS,
  DODO_STAGING_UAT_SCENARIO_IDS,
  fingerprintDodoUatExecutionProofPublicKey,
  serializeDodoUatExecutionProofPayload,
} from "../../scripts/lib/dodo-uat-evidence.mjs";
import { validateCommerceUatArtifactsSync } from "../../scripts/lib/commerce-uat-evidence.mjs";
import {
  PAYOS_STAGING_UAT_SCENARIO_IDS,
  serializePayosOwnerAttestationPayload,
  serializePayosRunnerAttestationPayload,
} from "../../scripts/lib/payos-uat-evidence.mjs";

const now = new Date("2026-07-26T03:00:00.000Z");
const providerAcceptanceKeys = ["telegramBot", "telegramMiniApp", "zaloMiniApp", "zaloOa", "whatsappCloud", "discord"] as const;
const payosProviderRequiredScenarioIds = ["signed_exact_payment", "direct_reconciliation"] as const;
const payosLocalAssuranceScenarioIds = [
  "invalid_signature",
  "duplicate_replay",
  "conflicting_replay",
  "partial_payment",
  "overpayment",
  "late_payment",
  "amount_mismatch",
  "currency_mismatch",
  "tenant_isolation",
  "fulfillment_exactly_once",
] as const;
const payosProviderUnsupportedScenarioIds = ["signed_refund", "signed_chargeback"] as const;
const rollbackInvariants = [...REQUIRED_PRODUCTION_ROLLBACK_INVARIANTS];
const sourceMigrationNames = readdirSync("migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort();

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readyWranglerConfig(): Record<string, unknown> {
  const vars = Object.fromEntries(REQUIRED_PRODUCTION_VARS.map((name) => [name, name === "APP_ENV" ? "production" : `configured-${name.toLowerCase()}`]));
  Object.assign(vars, {
    API_ORIGIN: "https://api.selinow.com",
    CANARY_HOSTNAME: "canary.selinow.com",
    CLOUDFLARE_ZONE_ID: "0123456789abcdef0123456789abcdef",
    DASHBOARD_ORIGIN: "https://app.selinow.com",
    EMAIL_FROM_ADDRESS: "no-reply@selinow.com",
    EMAIL_FROM_NAME: "Selinow",
    GOOGLE_OAUTH_REDIRECT_URI: "https://app.selinow.com/api/auth/google/callback",
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
          consumers: [
            { queue: "selinow-integration-production" },
            { queue: "selinow-notification-production" },
            { queue: "selinow-dlq-production" },
          ],
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
          { pattern: "selinow.com/*", zone_name: "selinow.com" },
          { pattern: "*.selinow.com/*", zone_name: "selinow.com" },
          { pattern: "*/*", zone_name: "selinow.com" },
          { pattern: "app.selinow.com" },
          { pattern: "api.selinow.com" },
        ],
        triggers: { crons: ["*/15 * * * *"] },
        vars,
        workers_dev: false,
      },
      staging: {
        routes: [
          { pattern: "*.staging.selinow.com/*", zone_name: "selinow.com" },
          { pattern: "staging.selinow.com" },
        ],
      },
    },
  };
}

function readyProductionSpec(): Record<string, unknown> {
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
    routing: {
      externalCustomDomainFallbackRoute: "*/*",
      externalCustomDomainStrategy: "production_fallback_with_platform_staging_exceptions",
      routeHandoff: "atomic_shared_zone_route_replacement",
    },
    turnstile: {
      externalCustomDomainAdmission: "verified_before_domain_activation",
      externalCustomDomainStrategy: "exact_hostname_admission_before_activation",
    },
    workerName: "selinow-com-production",
    zoneId: "0123456789abcdef0123456789abcdef",
    zoneName: "selinow.com",
  };
}

function readyEvidence(migrationNames = sourceMigrationNames): Record<string, unknown> {
  return {
    schemaVersion: 2,
    environment: "production",
    approvals: {
      dataOwner: "data-team",
      paymentOwner: "payment-team",
      releaseOwner: "release-team",
      securityOwner: "security-team",
      supportOwner: "support-team",
    },
    backup: {
      completedAt: "2026-07-26T02:30:00.000Z",
      providerBookmarkRecorded: true,
      restoreDrillCompletedAt: "2026-07-20T02:30:00.000Z",
      restoreDrillPassed: true,
      restoreDrillReportRef: "private-restore-report",
      snapshotReportRef: "private-backup-report",
    },
    candidateWorkerVersion: "33333333-3333-4333-8333-333333333333",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    commerceAcceptance: Object.fromEntries(["payos", "dodo"].map((provider) => [provider, {
      accepted: true,
      evidenceRef: `private/commerce-acceptance/${provider}.json`,
      observedAt: "2026-07-25T12:00:00.000Z",
    }])),
    manualAcceptance: {
      customDomain: true,
      evidenceRef: "private/manual-acceptance/report.json",
      observedAt: "2026-07-25T12:00:00.000Z",
      paymentSignedEvent: true,
      telegram: true,
      website: true,
    },
    migrationLedgerPrefix: [migrationNames[0]],
    monitoring: {
      alertsReady: true,
      budgetAlertsReady: true,
      dashboardReady: true,
      evidenceRef: "private/monitoring/report.json",
      observedAt: "2026-07-26T02:00:00.000Z",
    },
    pilot: { completedAt: "2026-07-24T12:00:00.000Z", evidenceRef: "private/pilot/report.json", shopCount: 2 },
    previousWorkerVersion: "11111111-1111-4111-8111-111111111111",
    providerAcceptance: Object.fromEntries(providerAcceptanceKeys.map((provider) => [provider, {
      accepted: true,
      evidenceRef: `private/provider-acceptance/${provider}.json`,
      observedAt: "2026-07-25T12:00:00.000Z",
    }])),
    quality: {
      auditHigh: true,
      build: true,
      buildStaging: true,
      check: true,
      deployDryRun: true,
      deployStagingDryRun: true,
      gitDiffCheck: true,
      lint: true,
      schemaVersion: 2,
      test: true,
      tscNoEmit: true,
    },
    releaseScope: {
      activeChannels: ["website", ...providerAcceptanceKeys],
      deferredChannels: [],
    },
    releaseId: "release_20260726_abcdef12",
    rollback: {
      candidate: {
        accepted: true,
        artifactSha256: "b".repeat(64),
        commitSha: "abcdef0123456789abcdef0123456789abcdef01",
        evidenceRef: "private/rollback/schema-compatible-candidate.json",
        invariants: [...rollbackInvariants],
        migrationLedgerSha256: fingerprint(migrationNames),
        migrationName: migrationNames.at(-1),
        rehearsalPassed: true,
        rehearsedAt: "2026-07-20T12:00:00.000Z",
        schemaVersion: 2,
        treeSha: "fedcba9876543210fedcba9876543210fedcba98",
        workerVersion: "22222222-2222-4222-8222-222222222222",
      },
      rehearsalEvidenceRef: "private/rollback/report.json",
      rehearsedAt: "2026-07-20T12:00:00.000Z",
    },
    security: { criticalOpen: 0, highOpen: 0 },
    staging: {
      accepted: true,
      acceptedAt: "2026-07-26T01:00:00.000Z",
      manifestRef: ".wrangler/releases/staging/stg_20260726T010000Z_0123456789ab/release-manifest.json",
      manifestSha256: "a".repeat(64),
      releaseId: "stg_20260726T010000Z_0123456789ab",
      workerVersion: "staging-worker-version",
    },
    treeSha: "89abcdef0123456789abcdef0123456789abcdef",
  };
}

it("rejects pending owner approvals", () => {
  const evidence = readyEvidence();
  evidence.approvals = {
    dataOwner: "pending",
    paymentOwner: "pending",
    releaseOwner: "pending",
    securityOwner: "pending",
    supportOwner: "pending",
  };

  const result = inspectProductionReadiness({
    evidence,
    now: new Date("2026-07-26T03:00:00.000Z"),
    productionSpec: readyProductionSpec(),
    workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
    wranglerConfig: readyWranglerConfig(),
  });

  for (const owner of ["dataOwner", "paymentOwner", "releaseOwner", "securityOwner", "supportOwner"]) {
    expect(result.checks).toContainEqual({ name: `evidence.approvals.${owner}`, ok: false });
  }
});

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

  it("requires the exact production cron schedule", () => {
    const config = readyWranglerConfig();
    const production = (config.env as { production: { triggers: { crons: string[] } } }).production;
    production.triggers.crons = ["*/15 * * * *", "0 * * * *"];

    const result = inspectProductionReadiness({
      evidence: readyEvidence(),
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: config,
    });

    expect(result.missing).toContain("wrangler.env.production.triggers");
  });

  it("requires the exact production Google callback and both OAuth secrets", () => {
    const config = readyWranglerConfig();
    const production = (config.env as { production: { vars: Record<string, string> } }).production;
    production.vars.GOOGLE_OAUTH_REDIRECT_URI = "https://selinow.com/api/auth/google/callback";
    const secrets = REQUIRED_WORKER_SECRET_NAMES.filter((name) => name !== "GOOGLE_OAUTH_CLIENT_SECRET");

    const result = inspectProductionReadiness({
      evidence: readyEvidence(),
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: secrets,
      wranglerConfig: config,
    });

    expect(result.missing).toContain("var.GOOGLE_OAUTH_REDIRECT_URI");
    expect(result.missing).toContain("secret.GOOGLE_OAUTH_CLIENT_SECRET");
    expect(REQUIRED_WORKER_SECRET_NAMES).toContain("GOOGLE_OAUTH_CLIENT_ID");
  });

  it("requires each configured production queue consumer by name", () => {
    const config = readyWranglerConfig();
    const production = (config.env as {
      production: { queues: { consumers: Array<{ queue: string }> } };
    }).production;
    production.queues.consumers = [
      { queue: "selinow-notification-production" },
      { queue: "selinow-dlq-production" },
      { queue: "unrelated-production" },
    ];

    const result = inspectProductionReadiness({
      evidence: readyEvidence(),
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: config,
    });

    expect(result.checks.find((check) => check.name === "queue.consumer.integration")?.ok).toBe(false);
  });

  it("requires the configured production dead-letter queue consumer", () => {
    const config = readyWranglerConfig();
    const production = (config.env as {
      production: { queues: { consumers: Array<{ queue: string }> } };
    }).production;
    production.queues.consumers = production.queues.consumers
      .filter((consumer) => consumer.queue !== "selinow-dlq-production");

    const result = inspectProductionReadiness({
      evidence: readyEvidence(),
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: config,
    });

    expect(result.missing).toEqual(expect.arrayContaining([
      "alignment.queue.deadLetter",
      "queue.consumer.deadLetter",
    ]));
  });

  it("rejects legacy quality evidence schema v1 for a new candidate", () => {
    const evidence = readyEvidence();
    (evidence.quality as Record<string, unknown>).schemaVersion = 1;

    const result = inspectProductionReadiness({
      evidence,
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });

    expect(result.missing).toContain("evidence.quality.schemaVersion");
  });

  it("requires an immutable current production Worker version ID", () => {
    const evidence = readyEvidence();
    evidence.previousWorkerVersion = "phase-6-worker";

    const result = inspectProductionReadiness({
      evidence,
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });

    expect(result.missing).toContain("evidence.previousWorkerVersion");
  });

  it.each([
    "auditHigh",
    "buildStaging",
    "deployStagingDryRun",
    "gitDiffCheck",
    "tscNoEmit",
  ])("requires the quality.%s sequential gate", (gate) => {
    const evidence = readyEvidence();
    (evidence.quality as Record<string, unknown>)[gate] = false;

    const result = inspectProductionReadiness({
      evidence,
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });

    expect(result.missing).toContain(`evidence.quality.${gate}`);
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

  it("requires private acceptance references and fresh operational timestamps", () => {
    const evidence = readyEvidence();
    const manualAcceptance = evidence.manualAcceptance as Record<string, unknown>;
    const monitoring = evidence.monitoring as Record<string, unknown>;
    const pilot = evidence.pilot as Record<string, unknown>;
    const rollback = evidence.rollback as Record<string, unknown>;
    delete manualAcceptance.evidenceRef;
    monitoring.observedAt = "2026-07-24T00:00:00.000Z";
    delete pilot.evidenceRef;
    rollback.rehearsedAt = "2026-06-01T00:00:00.000Z";

    const result = inspectProductionReadiness({
      evidence,
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining([
      "evidence.manualAcceptance.evidenceRef",
      "evidence.monitoring.observedAtFresh",
      "evidence.pilot.evidenceRef",
      "evidence.rollback.rehearsedAtFresh",
    ]));
  });

  it("requires independent acceptance evidence for every channel provider", () => {
    const evidence = readyEvidence();
    const providerAcceptance = evidence.providerAcceptance as Record<string, Record<string, unknown>>;
    delete providerAcceptance.discord;

    const result = inspectProductionReadiness({
      evidence,
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining([
      "evidence.providerAcceptance.discord.accepted",
      "evidence.providerAcceptance.discord.evidenceRef",
      "evidence.providerAcceptance.discord.observedAt",
      "evidence.providerAcceptance.discord.observedAtFresh",
    ]));
  });

  it("requires acceptance only for active providers and rejects accepted deferred providers", () => {
    const evidence = readyEvidence();
    evidence.releaseScope = {
      activeChannels: ["website", "telegramBot"],
      deferredChannels: ["telegramMiniApp", "zaloMiniApp", "zaloOa", "whatsappCloud", "discord"],
    };
    const providerAcceptance = evidence.providerAcceptance as Record<string, Record<string, unknown>>;
    for (const provider of providerAcceptanceKeys.slice(1)) Reflect.deleteProperty(providerAcceptance, provider);

    const accepted = inspectProductionReadiness({
      evidence,
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });
    expect(accepted.ok).toBe(true);

    providerAcceptance.discord = {
      accepted: true,
      evidenceRef: "private/provider-acceptance/discord.json",
      observedAt: "2026-07-25T12:00:00.000Z",
    };
    const rejected = inspectProductionReadiness({
      evidence,
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });
    expect(rejected.missing).toEqual(expect.arrayContaining([
      "evidence.providerAcceptance.discord.deferredNotAccepted",
      "evidence.releaseScope.deferredProvidersNotAccepted",
    ]));
  });

  it("fails closed for incomplete channel scope and commerce acceptance", () => {
    const evidence = readyEvidence();
    evidence.releaseScope = {
      activeChannels: ["website", "telegramBot", "telegramBot"],
      deferredChannels: ["telegramMiniApp", "zaloMiniApp", "zaloOa", "whatsappCloud"],
    };
    const commerceAcceptance = evidence.commerceAcceptance as {
      dodo: Record<string, unknown>;
      payos: Record<string, unknown>;
    };
    delete commerceAcceptance.dodo.evidenceRef;
    commerceAcceptance.payos.observedAt = "2026-06-01T00:00:00.000Z";

    const result = inspectProductionReadiness({
      evidence,
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });

    expect(result.missing).toEqual(expect.arrayContaining([
      "evidence.releaseScope.channelsComplete",
      "evidence.commerceAcceptance.dodo.evidenceRef",
      "evidence.commerceAcceptance.payos.observedAtFresh",
    ]));
  });

  it("requires distinct evidence references for independent acceptance lanes", () => {
    const evidence = readyEvidence();
    const providers = evidence.providerAcceptance as {
      discord: Record<string, unknown>;
      telegramBot: Record<string, unknown>;
    };
    const commerce = evidence.commerceAcceptance as {
      dodo: Record<string, unknown>;
      payos: Record<string, unknown>;
    };
    providers.discord.evidenceRef = providers.telegramBot.evidenceRef;
    commerce.dodo.evidenceRef = commerce.payos.evidenceRef;

    const result = inspectProductionReadiness({
      evidence,
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });

    expect(result.missing).toEqual(expect.arrayContaining([
      "evidence.providerAcceptance.activeEvidenceRefsUnique",
      "evidence.commerceAcceptance.evidenceRefsUnique",
    ]));
  });

  it("rejects evidence references reused across provider and commerce lanes", () => {
    const evidence = readyEvidence();
    const providers = evidence.providerAcceptance as { telegramBot: Record<string, unknown> };
    const commerce = evidence.commerceAcceptance as { payos: Record<string, unknown> };
    commerce.payos.evidenceRef = providers.telegramBot.evidenceRef;

    const result = inspectProductionReadiness({
      evidence,
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });

    expect(result.missing).toContain("evidence.acceptanceRefs.crossLaneUnique");
  });

  it("builds a value-safe manifest and rollback matrix after readiness passes", () => {
    const migrationNames = ["0001_first.sql", "0002_second.sql"];
    const evidence = readyEvidence(migrationNames);
    const result = buildReleaseArtifacts({
      evidence,
      migrationNames: [...migrationNames].reverse(),
      now,
      packageVersion: "0.0.0",
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });

    expect(result.manifest.releaseId).toBe("release_20260726_abcdef12");
    expect(result.manifest.migrationNames).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect(result.manifest.migrationLedgerPrefix).toEqual(["0001_first.sql"]);
    expect(result.manifest.schemaVersion).toBe(2);
    expect(result.manifest.releaseScope).toEqual({
      activeChannels: ["website", ...providerAcceptanceKeys],
      deferredChannels: [],
    });
    expect(result.manifest.commerceAcceptance).toEqual(evidence.commerceAcceptance);
    expect(result.manifest.rollbackCandidate).toEqual((evidence.rollback as {
      candidate: Record<string, unknown>;
    }).candidate);
    expect(result.manifest.releaseEvidenceFingerprintSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.rollbackMatrix).toHaveLength(6);
    expect(JSON.stringify(result)).not.toContain("snapshotReportRef");
  });

  it("builds and writes the canonical rollback rehearsal artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-rollback-rehearsal-"));
    try {
      await mkdir(join(root, "migrations"), { recursive: true });
      await writeFile(join(root, "migrations/0001_first.sql"), "SELECT 1;\n");
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["config", "user.email", "release-test@selinow.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Selinow Release Test"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "rollback source"], { cwd: root });
      const rollbackCommitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      const rollbackTreeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
      await writeFile(join(root, "release.txt"), "candidate\n");
      execFileSync("git", ["add", "release.txt"], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "release source"], { cwd: root });
      const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
      const releaseEvidence = readyEvidence(["0001_first.sql"]);
      releaseEvidence.commitSha = commitSha;
      releaseEvidence.treeSha = treeSha;
      const rollback = releaseEvidence.rollback as { candidate: Record<string, unknown>; rehearsedAt: string };
      rollback.candidate.commitSha = rollbackCommitSha;
      rollback.candidate.treeSha = rollbackTreeSha;

      const artifact = buildProductionRollbackRehearsalArtifact({
        evidence: releaseEvidence,
        migrationNames: ["0001_first.sql"],
        now,
      });
      expect(artifact).toMatchObject({
        releaseSource: { commitSha, treeSha },
        rollbackSource: { commitSha: rollbackCommitSha, treeSha: rollbackTreeSha },
        rehearsal: {
          authorizesProductionAdmission: false,
          kind: "schema_compatibility_validation",
          result: "validated",
        },
        schemaVersion: 1,
      });

      const written = await writeProductionRollbackRehearsalArtifact({
        evidence: releaseEvidence,
        migrationNames: ["0001_first.sql"],
        now,
        repositoryRoot: root,
      });
      expect(written.artifactSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(written.evidenceRef).toBe(`.wrangler/releases/${String(releaseEvidence.releaseId)}/rollback-rehearsal.json`);
      const rollbackEvidence = releaseEvidence.rollback as {
        candidate: Record<string, unknown>;
        rehearsalEvidenceRef: string;
      };
      rollbackEvidence.candidate.artifactSha256 = written.artifactSha256;
      rollbackEvidence.candidate.evidenceRef = written.evidenceRef;
      rollbackEvidence.rehearsalEvidenceRef = written.evidenceRef;
      expect(() => validateProductionRollbackArtifact({
        evidence: releaseEvidence,
        migrationNames: ["0001_first.sql"],
        repositoryRoot: root,
      })).toThrow("production_rollback_artifact_binding_mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a reviewed migration baseline that is not the exact source prefix", () => {
    const migrationNames = ["0001_first.sql", "0002_second.sql"];
    const evidence = readyEvidence(migrationNames);
    evidence.migrationLedgerPrefix = ["0002_second.sql"];

    expect(() => buildReleaseArtifacts({
      evidence,
      migrationNames,
      now,
      packageVersion: "0.0.0",
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    })).toThrow("release_prerequisites_incomplete:evidence.migrationLedgerPrefix");
  });

  it("rejects an observed migration list that is not the exact source prefix", () => {
    const migrationNames = ["0001_first.sql", "0002_second.sql"];
    const evidence = readyEvidence(migrationNames);
    evidence.migrationLedgerPrefix = ["0002_second.sql"];

    const result = inspectProductionReadiness({
      evidence,
      migrationNames,
      now,
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });

    expect(result.missing).toContain("evidence.migrationLedgerPrefix");
  });

  it("projects only allowlisted acceptance fields into the release manifest", () => {
    const migrationNames = ["0001_first.sql", "0002_second.sql"];
    const evidence = readyEvidence(migrationNames);
    (evidence.manualAcceptance as Record<string, unknown>).token = "manual-secret";
    ((evidence.providerAcceptance as { telegramBot: Record<string, unknown> }).telegramBot).token = "provider-secret";
    ((evidence.commerceAcceptance as { payos: Record<string, unknown> }).payos).rawPayload = "commerce-secret";
    (evidence.releaseScope as Record<string, unknown>).credential = "scope-secret";

    const result = buildReleaseArtifacts({
      evidence,
      migrationNames,
      now,
      packageVersion: "0.0.0",
      productionSpec: readyProductionSpec(),
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    });

    expect(JSON.stringify(result.manifest)).not.toMatch(/manual-secret|provider-secret|commerce-secret|scope-secret/u);
  });

  it("admits only a clean source tree matching the reviewed release manifest", () => {
    const migrationNames = ["0001_first.sql", "0002_second.sql"];
    const evidence = readyEvidence(migrationNames);
    const wranglerConfig = readyWranglerConfig();
    const productionSpec = readyProductionSpec();
    const staging = evidence.staging as {
      manifestRef: string;
      manifestSha256: string;
      releaseId: string;
      workerVersion: string;
    };
    const commerce = evidence.commerceAcceptance as {
      dodo: Record<string, unknown>;
      payos: Record<string, unknown>;
    };
    commerce.dodo.evidenceRef = `.wrangler/releases/staging/${staging.releaseId}/dodo-uat-evidence.json`;
    commerce.dodo.artifactSha256 = "c".repeat(64);
    commerce.payos.evidenceRef = `.wrangler/releases/staging/${staging.releaseId}/payos-uat-evidence.json`;
    commerce.payos.artifactSha256 = "d".repeat(64);
    const commerceEvidenceValidation = {
      dodo: {
        accepted: true,
        artifactFingerprintSha256: "c".repeat(64),
        manifestRef: staging.manifestRef,
        manifestSha256: staging.manifestSha256,
        releaseId: staging.releaseId,
        workerVersion: staging.workerVersion,
      },
      payos: {
        accepted: true,
        artifactFingerprintSha256: "d".repeat(64),
        manifestRef: staging.manifestRef,
        manifestSha256: staging.manifestSha256,
        releaseId: staging.releaseId,
        workerVersion: staging.workerVersion,
      },
    };
    const manifest = buildReleaseArtifacts({
      commerceEvidenceValidation,
      evidence,
      migrationNames,
      now,
      packageVersion: "0.0.0",
      productionSpec,
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig,
    }).manifest;

    expect(validateProductionDeployAdmission({
      commerceEvidenceValidation,
      evidence,
      manifest,
      migrationNames,
      now,
      packageVersion: "0.0.0",
      productionSpec,
      repositoryClean: true,
      repositoryCommitSha: "0123456789abcdef0123456789abcdef01234567",
      ...{ repositoryTreeSha: evidence.treeSha },
      requireRollbackArtifact: true,
      rollbackArtifactValidation: { accepted: true },
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig,
    })).toEqual({
      candidateWorkerVersion: "33333333-3333-4333-8333-333333333333",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      migrationLedgerSha256: fingerprint(migrationNames),
      migrationLedgerPrefix: ["0001_first.sql"],
      previousWorkerVersion: "11111111-1111-4111-8111-111111111111",
      releaseId: "release_20260726_abcdef12",
      rollbackArtifactSha256: "b".repeat(64),
      rollbackCandidateWorkerVersion: "22222222-2222-4222-8222-222222222222",
      treeSha: evidence.treeSha,
    });

    expect(() => validateProductionDeployAdmission({
      commerceEvidenceValidation,
      evidence,
      manifest,
      migrationNames,
      now,
      packageVersion: "0.0.0",
      productionSpec,
      repositoryClean: false,
      repositoryCommitSha: "0123456789abcdef0123456789abcdef01234567",
      ...{ repositoryTreeSha: evidence.treeSha },
      requireRollbackArtifact: true,
      rollbackArtifactValidation: { accepted: true },
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig,
    })).toThrow("production_release_source_dirty");

    const tamperedManifest = structuredClone(manifest) as {
      rollbackCandidate: Record<string, unknown>;
    } & Record<string, unknown>;
    tamperedManifest.rollbackCandidate.artifactSha256 = "e".repeat(64);
    expect(() => validateProductionDeployAdmission({
      commerceEvidenceValidation,
      evidence,
      manifest: tamperedManifest,
      migrationNames,
      now,
      packageVersion: "0.0.0",
      productionSpec,
      repositoryClean: true,
      repositoryCommitSha: "0123456789abcdef0123456789abcdef01234567",
      repositoryTreeSha: evidence.treeSha,
      requireRollbackArtifact: true,
      rollbackArtifactValidation: { accepted: true },
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig,
    })).toThrow("production_release_manifest_mismatch:rollbackCandidate");
  });

  it("rejects a manifest when reviewed evidence or repository identity drifts", () => {
    const migrationNames = ["0001_first.sql", "0002_second.sql"];
    const evidence = readyEvidence(migrationNames);
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
      repositoryTreeSha: evidence.treeSha,
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
    })).toThrow("release_prerequisites_incomplete:evidence.rollback.candidate.migrationLedgerSha256");
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

  it("admits PayOS payment acceptance while preserving unsupported reversal capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-release-admission-"));
    const previousAttestationKeyId = process.env.SELINOW_PAYOS_UAT_ATTESTATION_KEY_ID;
    const previousAttestationPublicKey = process.env.SELINOW_PAYOS_UAT_ATTESTATION_PUBLIC_KEY_PEM_BASE64;
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
      execFileSync("git", ["commit", "--quiet", "-m", "rollback fixture"], { cwd: root });
      const rollbackCommitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      const rollbackTreeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
      await writeFile(join(root, "release-marker.txt"), "release candidate\n");
      execFileSync("git", ["add", "release-marker.txt"], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "release fixture"], { cwd: root });
      const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
      const evidence = readyEvidence(["0001_first.sql"]);
      evidence.commitSha = commitSha;
      evidence.treeSha = treeSha;
      const rollback = evidence.rollback as {
        candidate: Record<string, unknown>;
        rehearsalEvidenceRef: string;
        rehearsedAt: string;
      };
      rollback.candidate.commitSha = rollbackCommitSha;
      rollback.candidate.treeSha = rollbackTreeSha;
      rollback.candidate.evidenceRef = `.wrangler/releases/${releaseId}/rollback-rehearsal.json`;
      rollback.rehearsalEvidenceRef = String(rollback.candidate.evidenceRef);
      const stagingReleaseId = `stg_20260726T010000Z_${commitSha.slice(0, 12)}`;
      const stagingDirectory = join(root, ".wrangler/releases/staging", stagingReleaseId);
      await mkdir(stagingDirectory, { recursive: true });
      const stagingManifestRef = `.wrangler/releases/staging/${stagingReleaseId}/release-manifest.json`;
      const stagingManifest = JSON.stringify({
        commitSha,
        createdAt: "2026-07-25T11:00:00.000Z",
        environment: "staging",
        expiresAt: "2026-07-26T11:00:00.000Z",
        releaseId: stagingReleaseId,
        schemaVersion: 3,
        treeSha,
      });
      const stagingManifestSha256 = createHash("sha256").update(stagingManifest).digest("hex");
      await writeFile(join(root, stagingManifestRef), stagingManifest, { mode: 0o600 });
      const staging = evidence.staging as Record<string, unknown>;
      Object.assign(staging, {
        manifestRef: stagingManifestRef,
        manifestSha256: stagingManifestSha256,
        releaseId: stagingReleaseId,
        workerVersion: "staging-worker-version",
      });
      const releaseBinding = {
        commitSha,
        manifestRef: stagingManifestRef,
        manifestSha256: stagingManifestSha256,
        releaseId: stagingReleaseId,
        treeSha,
        workerVersion: "staging-worker-version",
      };
      type PayosScenarioRecord = {
        classification: "provider_supported" | "provider_unsupported" | "selinow_local_assurance";
        eventReference: string;
        evidenceFingerprintSha256: string;
        observedAt: string;
        reasonCode: "payos_signed_chargeback_not_supported" | "payos_signed_refund_not_supported" | null;
        requestReference: string;
        status: "passed" | "unsupported";
        verificationMethod: "local_contract" | "provider_capability_audit" | "signed_webhook" | "verified_provider_response";
      };
      const dodoRunnerKeyId = "dodo-staging-runner-test";
      const dodoRunnerKeys = generateKeyPairSync("ed25519");
      const dodoRunnerPublicKey = dodoRunnerKeys.publicKey.export({ format: "pem", type: "spki" });
      const dodoApprovedExecutionProofTrust = {
        keyId: dodoRunnerKeyId,
        spkiSha256: fingerprintDodoUatExecutionProofPublicKey(dodoRunnerPublicKey),
      };
      const dodoProofArtifacts: Record<string, { artifactRef: string; artifactSha256: string }> = {};
      const dodoProofState = new Map<string, {
        afterSha256: string;
        eventReference: string | null;
        providerEventSha256: string | null;
        providerSignatureSha256: string | null;
        sessionReference: string | null;
      }>();
      for (const [index, id] of DODO_STAGING_UAT_SCENARIO_IDS.entries()) {
        const contract = DODO_SCENARIO_EXECUTION_CONTRACTS[id];
        if (contract === undefined) throw new Error("missing_dodo_execution_contract");
        const providerEvidenceRequired = contract.signatureAuthority !== "none";
        const relatedProof = contract.relatedScenarioId === null
          ? undefined
          : dodoProofState.get(contract.relatedScenarioId);
        if (contract.relatedScenarioId !== null && relatedProof === undefined) {
          throw new Error("missing_related_dodo_execution_proof");
        }
        const uniqueBeforeSha256 = (index * 10 + 4).toString(16).padStart(64, "0");
        const d1BeforeSha256 = relatedProof?.afterSha256 ?? uniqueBeforeSha256;
        const d1AfterSha256 = contract.stateEffect === "no_op"
          ? d1BeforeSha256
          : (index * 10 + 5).toString(16).padStart(64, "0");
        const observedAt = new Date(Date.parse("2026-07-25T12:00:00.000Z") + index * 60_000).toISOString();
        const isReplay = contract.relationship === "same_event_replay";
        const isConflict = contract.relationship === "same_event_conflicting_payload";
        const eventReference = contract.requiresEventReference
          ? (isReplay || isConflict ? relatedProof?.eventReference : `event:evt_${String(index).padStart(4, "0")}`) ?? null
          : null;
        const sessionReference = contract.requiresSessionReference
          ? relatedProof?.sessionReference ?? `session:ses_${String(index).padStart(4, "0")}`
          : null;
        const providerEventSha256 = providerEvidenceRequired
          ? isReplay
            ? relatedProof?.providerEventSha256 ?? null
            : (index * 10 + 2).toString(16).padStart(64, "0")
          : null;
        const providerSignatureSha256 = providerEvidenceRequired
          ? isReplay
            ? relatedProof?.providerSignatureSha256 ?? null
            : (index * 10 + 3).toString(16).padStart(64, "0")
          : null;
        const proof = {
          artifactKind: "dodo_uat_execution_proof",
          attestation: {
            algorithm: "ed25519",
            keyId: dodoRunnerKeyId,
            signatureBase64: "",
            signedAt: observedAt,
          },
          authority: {
            controlledInjection: contract.controlledInjection,
            eventSource: contract.eventSource,
            runnerId: "selinow-dodo-staging-runner-test",
            signatureAuthority: contract.signatureAuthority,
          },
          environment: "staging",
          executionMode: contract.executionMode,
          fingerprints: {
            d1AfterSha256,
            d1BeforeSha256,
            d1TransitionSha256: (index * 10 + 6).toString(16).padStart(64, "0"),
            executionTranscriptSha256: (index * 10 + 1).toString(16).padStart(64, "0"),
            providerEventSha256,
            providerSignatureSha256,
          },
          observedAt,
          outcome: contract.outcome,
          provider: "dodo",
          providerEnvironment: "test_mode",
          redaction: { noCustomerData: true, noPaymentInstrumentData: true, noRawPayload: true, noSensitiveValues: true },
          references: {
            eventReference,
            requestReference: `request:req_${String(index).padStart(4, "0")}`,
            sessionReference,
          },
          relatedScenario: contract.relatedScenarioId === null
            ? null
            : { relationship: contract.relationship, scenarioId: contract.relatedScenarioId },
          release: releaseBinding,
          result: "passed",
          scenarioId: id,
          schemaVersion: 2,
          state: { after: contract.stateAfter, before: contract.stateBefore, effect: contract.stateEffect },
          verificationMethod: contract.verificationMethod,
        };
        proof.attestation.signatureBase64 = sign(
          null,
          Buffer.from(serializeDodoUatExecutionProofPayload(proof)),
          dodoRunnerKeys.privateKey,
        ).toString("base64");
        const artifactRef = `artifact:.wrangler/releases/staging/${stagingReleaseId}/dodo-uat-execution-proofs/${id}.json`;
        const bytes = `${JSON.stringify(proof, null, 2)}\n`;
        await mkdir(join(root, `.wrangler/releases/staging/${stagingReleaseId}/dodo-uat-execution-proofs`), { recursive: true });
        await writeFile(join(root, artifactRef.slice("artifact:".length)), bytes, { mode: 0o600 });
        dodoProofArtifacts[id] = { artifactRef, artifactSha256: createHash("sha256").update(bytes).digest("hex") };
        dodoProofState.set(id, {
          afterSha256: d1AfterSha256,
          eventReference,
          providerEventSha256,
          providerSignatureSha256,
          sessionReference,
        });
      }
      await writeFile(join(stagingDirectory, "dodo-uat-trusted-public-keys.json"), JSON.stringify({
        environment: "staging",
        keys: [{
          keyId: dodoRunnerKeyId,
          publicKeyPem: dodoRunnerPublicKey,
        }],
        provider: "dodo",
        schemaVersion: 1,
      }), { mode: 0o600 });
      const payosControlledAccountFingerprintSha256 = "a".repeat(64);
      const payosRunnerKeyId = "payos-staging-runner-test";
      const payosRunnerKeys = generateKeyPairSync("ed25519");
      const payosRunnerPublicKey = payosRunnerKeys.publicKey.export({ format: "pem", type: "spki" });
      const payosRunnerSpkiSha256 = createHash("sha256")
        .update(payosRunnerKeys.publicKey.export({ format: "der", type: "spki" }))
        .digest("hex");
      const payosExecutionFingerprints: Record<string, string> = {};
      await mkdir(join(stagingDirectory, "execution"), { recursive: true });
      for (const [index, id] of payosProviderRequiredScenarioIds.entries()) {
        const suffix = String(index + 1);
        const executionArtifact = {
          authority: {
            attemptReference: `attempt:pay_00000000-0000-4000-8000-00000000000${suffix}`,
            authoritySource: id === "signed_exact_payment" ? "staging_d1_verified_event" : "staging_exact_attempt_reconciliation",
            eventReference: `event:pev_00000000-0000-4000-8000-00000000000${suffix}`,
            providerAuthority: id === "signed_exact_payment" ? "provider_signed_webhook" : "provider_signed_response",
            providerReference: `provider:${suffix.repeat(64)}`,
            requestReference: `request:payos-uat-${id}`,
          },
          controlledAccountFingerprintSha256: payosControlledAccountFingerprintSha256,
          environment: "staging",
          evidenceKind: "provider_execution",
          observedAt: "2026-07-25T12:00:00.000Z",
          provider: "payos",
          providerEnvironment: "production_controlled",
          redaction: { noCredentialData: true, noCustomerData: true, noFinancialDetails: true, noRawPayload: true },
          release: releaseBinding,
          result: { duplicate: false, processed: true, state: "paid_exact" },
          runnerAttestation: {
            algorithm: "ed25519",
            keyId: payosRunnerKeyId,
            publicKeySpkiSha256: payosRunnerSpkiSha256,
            signatureBase64: "",
            signedAt: "2026-07-25T12:00:00.000Z",
          },
          scenarioId: id,
          schemaVersion: 1,
          verificationMethod: id === "signed_exact_payment" ? "signed_webhook" : "verified_provider_response",
        };
        executionArtifact.runnerAttestation.signatureBase64 = sign(
          null,
          Buffer.from(serializePayosRunnerAttestationPayload(executionArtifact)),
          payosRunnerKeys.privateKey,
        ).toString("base64");
        const executionArtifactBytes = JSON.stringify(executionArtifact);
        await writeFile(join(stagingDirectory, "execution", `payos-${id}.json`), executionArtifactBytes, { mode: 0o600 });
        payosExecutionFingerprints[id] = createHash("sha256").update(executionArtifactBytes).digest("hex");
      }
      const payosTransactionEvidenceFingerprintSha256 = createHash("sha256")
        .update(JSON.stringify(Object.values(payosExecutionFingerprints).sort()))
        .digest("hex");
      const payosScenarios: Record<string, PayosScenarioRecord> = {};
      await mkdir(join(stagingDirectory, "scenarios"), { recursive: true });
      for (const id of PAYOS_STAGING_UAT_SCENARIO_IDS) {
        const providerRequired = payosProviderRequiredScenarioIds.includes(id as typeof payosProviderRequiredScenarioIds[number]);
        const providerUnsupported = payosProviderUnsupportedScenarioIds.includes(id as typeof payosProviderUnsupportedScenarioIds[number]);
        const classification = providerUnsupported
          ? "provider_unsupported"
          : providerRequired
            ? "provider_supported"
            : "selinow_local_assurance";
        const status = providerUnsupported ? "unsupported" : "passed";
        const verificationMethod = id === "signed_exact_payment"
          ? "signed_webhook"
          : id === "direct_reconciliation"
            ? "verified_provider_response"
            : providerUnsupported
              ? "provider_capability_audit"
              : "local_contract";
        const observedAt = "2026-07-25T12:00:00.000Z";
        const artifactRef = `.wrangler/releases/staging/${stagingReleaseId}/scenarios/payos-${id}.json`;
        const artifact = JSON.stringify({
          classification,
          controlledAccountFingerprintSha256: providerRequired ? payosControlledAccountFingerprintSha256 : null,
          evidenceKind: "provider_acceptance",
          environment: "staging",
          observedAt,
          provider: "payos",
          proofOfExecutionFingerprintSha256: providerRequired ? payosExecutionFingerprints[id] : null,
          redaction: { noRawPayload: true, noSensitiveValues: true },
          release: releaseBinding,
          result: status,
          scenarioId: id,
          schemaVersion: 1,
          verificationMethod,
        });
        await writeFile(join(root, artifactRef), artifact, { mode: 0o600 });
        payosScenarios[id] = {
          classification,
          eventReference: `artifact:${artifactRef}`,
          evidenceFingerprintSha256: createHash("sha256").update(artifact).digest("hex"),
          observedAt,
          reasonCode: id === "signed_refund"
            ? "payos_signed_refund_not_supported"
            : id === "signed_chargeback"
              ? "payos_signed_chargeback_not_supported"
              : null,
          requestReference: `artifact:${artifactRef}`,
          status,
          verificationMethod,
        };
      }
      const dodoCollected = await collectDodoStagingUatEvidence({
        approvedExecutionProofTrust: dodoApprovedExecutionProofTrust,
        completedAt: "2026-07-25T13:00:00.000Z",
        createdAt: "2026-07-25T11:00:00.000Z",
        endpointFingerprintSha256: "e".repeat(64),
        executionProofPublicKeys: {
          [dodoRunnerKeyId]: dodoRunnerPublicKey,
        },
        offers: [
          { planCode: "starter", marketCode: "vn", currency: "VND", amountMinor: 99_000, interval: "month", providerReferenceFingerprintSha256: "1".repeat(64) },
          { planCode: "pro", marketCode: "vn", currency: "VND", amountMinor: 299_000, interval: "month", providerReferenceFingerprintSha256: "2".repeat(64) },
          { planCode: "starter", marketCode: "global", currency: "USD", amountMinor: 500, interval: "month", providerReferenceFingerprintSha256: "3".repeat(64) },
          { planCode: "pro", marketCode: "global", currency: "USD", amountMinor: 1_500, interval: "month", providerReferenceFingerprintSha256: "4".repeat(64) },
        ],
        proofArtifacts: dodoProofArtifacts,
        release: releaseBinding,
        repositoryRoot: root,
      });
      const payosOwnerKeyId = "release-owner-test";
      const payosOwnerKeys = generateKeyPairSync("ed25519");
      const payosArtifact = {
        acceptanceReasonCode: null,
        channel: "seller_payment",
        completedAt: "2026-07-25T13:00:00.000Z",
        createdAt: "2026-07-25T11:00:00.000Z",
        environment: "staging",
        evidenceKind: "provider_acceptance",
        ownerAttestation: {
          algorithm: "ed25519",
          keyId: payosOwnerKeyId,
          signatureBase64: "",
          signedAt: "2026-07-25T13:00:00.000Z",
        },
        provider: "payos",
        providerEnvironment: "production_controlled",
        providerExecution: {
          controlledAccountFingerprintSha256: payosControlledAccountFingerprintSha256,
          paymentInstrument: "controlled_real_bank",
          realLowValueTransactionObserved: true,
          signatureSource: "provider_signed_webhook_and_verified_response",
          syntheticSignatureUsed: false,
          transactionEvidenceFingerprintSha256: payosTransactionEvidenceFingerprintSha256,
        },
        redaction: { auditNoSensitiveValues: true, d1NoRawPayload: true, d1NoSecretValues: true, evidenceFingerprintSha256: "f".repeat(64), logsNoSensitiveValues: true, queuesNoSensitiveValues: true },
        release: releaseBinding,
        scenarioPolicy: {
          localRequired: payosLocalAssuranceScenarioIds,
          providerRequired: payosProviderRequiredScenarioIds,
          providerUnsupported: payosProviderUnsupportedScenarioIds,
        },
        scenarios: payosScenarios,
        schemaVersion: 2,
        unsupportedCapabilities: {
          signedChargeback: {
            documentationReference: "payos_docs:payment_webhook",
            reasonCode: "payos_signed_chargeback_not_supported",
            status: "unsupported",
          },
          signedRefund: {
            documentationReference: "payos_docs:payment_webhook",
            reasonCode: "payos_signed_refund_not_supported",
            status: "unsupported",
          },
        },
      };
      payosArtifact.ownerAttestation.signatureBase64 = sign(
        null,
        Buffer.from(serializePayosOwnerAttestationPayload(payosArtifact)),
        payosOwnerKeys.privateKey,
      ).toString("base64");
      const commerce = evidence.commerceAcceptance as Record<string, Record<string, unknown>>;
      const dodoCommerce = commerce.dodo;
      const payosCommerce = commerce.payos;
      if (dodoCommerce === undefined || payosCommerce === undefined) throw new Error("missing_commerce_fixture");
      dodoCommerce.evidenceRef = dodoCollected.evidenceRef;
      payosCommerce.evidenceRef = `.wrangler/releases/staging/${stagingReleaseId}/payos-uat-evidence.json`;
      const payosBytes = JSON.stringify(payosArtifact);
      await writeFile(join(root, String(payosCommerce.evidenceRef)), payosBytes, { mode: 0o600 });
      dodoCommerce.artifactSha256 = dodoCollected.artifactSha256;
      payosCommerce.artifactSha256 = createHash("sha256").update(payosBytes).digest("hex");
      const rollbackArtifact = JSON.stringify({
        environment: "production",
        invariants: rollback.candidate.invariants,
        migrationLedger: {
          latest: "0001_first.sql",
          sha256: rollback.candidate.migrationLedgerSha256,
        },
        rehearsal: {
          authorizesProductionAdmission: true,
          completedAt: rollback.rehearsedAt,
          kind: "live_rollback_rehearsal",
          result: "passed",
        },
        releaseSource: { commitSha, treeSha },
        rollbackSource: { commitSha: rollbackCommitSha, treeSha: rollbackTreeSha },
        schemaVersion: 1,
        workerVersions: {
          candidate: evidence.candidateWorkerVersion,
          current: evidence.previousWorkerVersion,
          rollback: rollback.candidate.workerVersion,
        },
      });
      rollback.candidate.artifactSha256 = createHash("sha256").update(rollbackArtifact).digest("hex");
      await writeFile(join(root, rollback.rehearsalEvidenceRef), rollbackArtifact, { mode: 0o600 });
      process.env.SELINOW_PAYOS_UAT_ATTESTATION_KEY_ID = payosOwnerKeyId;
      process.env.SELINOW_PAYOS_UAT_ATTESTATION_PUBLIC_KEY_PEM_BASE64 = Buffer.from(
        payosOwnerKeys.publicKey.export({ format: "pem", type: "spki" }),
      ).toString("base64");
      const commerceEvidenceValidation = validateCommerceUatArtifactsSync({
        dodoApprovedExecutionProofTrust,
        evidence,
        now,
        repositoryRoot: root,
        payosOwnerAttestationPublicKeys: {
          [payosOwnerKeyId]: payosOwnerKeys.publicKey.export({ format: "pem", type: "spki" }),
        },
        payosStagingRunnerPublicKeys: { [payosRunnerKeyId]: payosRunnerPublicKey },
        payosStagingRunnerSpkiFingerprints: { [payosRunnerKeyId]: payosRunnerSpkiSha256 },
        trustedStagingWorkerVersion: releaseBinding.workerVersion,
      });
      expect(commerceEvidenceValidation.payos).toMatchObject({
        accepted: true,
        fullCommerceAccepted: false,
        paymentLaneAccepted: true,
        reasonCodes: [
          "payos_signed_refund_not_supported",
          "payos_signed_chargeback_not_supported",
        ],
      });
      const releaseInput = {
        commerceEvidenceValidation,
        evidence,
        migrationNames: ["0001_first.sql"],
        now,
        packageVersion: "0.0.0",
        productionSpec: readyProductionSpec(),
        repositoryRoot: root,
        workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
        wranglerConfig: readyWranglerConfig(),
      };
      const releaseArtifacts = buildReleaseArtifacts(releaseInput);
      const projectedCommerce = releaseArtifacts.manifest.commerceAcceptance as Record<string, Record<string, unknown>>;
      expect(projectedCommerce.payos).toMatchObject({
        accepted: true,
        artifactFingerprintSha256: payosCommerce.artifactSha256,
        artifactReleaseId: stagingReleaseId,
        paymentLaneAccepted: true,
        fullCommerceAccepted: false,
        reasonCodes: [
          "payos_signed_refund_not_supported",
          "payos_signed_chargeback_not_supported",
        ],
      });

      const productionDeployInput = {
        commerceEvidenceValidation,
        evidence,
        manifest: releaseArtifacts.manifest,
        migrationNames: ["0001_first.sql"],
        now,
        packageVersion: "0.0.0",
        productionSpec: readyProductionSpec(),
        repositoryClean: true,
        repositoryCommitSha: commitSha,
        repositoryRoot: root,
        repositoryTreeSha: treeSha,
        requireRollbackArtifact: true,
        rollbackArtifactValidation: validateProductionRollbackArtifact({
          evidence,
          migrationNames: ["0001_first.sql"],
          repositoryRoot: root,
        }),
        workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
        wranglerConfig: readyWranglerConfig(),
      };
      expect(validateProductionDeployAdmission(productionDeployInput)).toMatchObject({ releaseId });

      await writeFile(join(root, rollback.rehearsalEvidenceRef), `${rollbackArtifact}\n`, { mode: 0o600 });
      expect(() => validateProductionRollbackArtifact({
        evidence,
        migrationNames: ["0001_first.sql"],
        repositoryRoot: root,
      })).toThrow("production_rollback_artifact_hash_mismatch");
      await writeFile(join(root, rollback.rehearsalEvidenceRef), rollbackArtifact, { mode: 0o600 });

      expect(() => validateProductionDeployAdmission({
        ...productionDeployInput,
        repositoryClean: false,
      })).toThrow("production_release_source_dirty");
    } finally {
      if (previousAttestationKeyId === undefined) delete process.env.SELINOW_PAYOS_UAT_ATTESTATION_KEY_ID;
      else process.env.SELINOW_PAYOS_UAT_ATTESTATION_KEY_ID = previousAttestationKeyId;
      if (previousAttestationPublicKey === undefined) delete process.env.SELINOW_PAYOS_UAT_ATTESTATION_PUBLIC_KEY_PEM_BASE64;
      else process.env.SELINOW_PAYOS_UAT_ATTESTATION_PUBLIC_KEY_PEM_BASE64 = previousAttestationPublicKey;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("combines reviewed release evidence with the exact live production target", async () => {
    const currentWorkerVersion = "11111111-1111-4111-8111-111111111111";
    const rollbackCandidateWorkerVersion = "22222222-2222-4222-8222-222222222222";
    const candidateWorkerVersion = "33333333-3333-4333-8333-333333333333";
    const releaseAdmission = vi.fn(() => Promise.resolve({
      candidateWorkerVersion,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      previousWorkerVersion: currentWorkerVersion,
      releaseId: "release_20260726_abcdef12",
      rollbackCandidateWorkerVersion,
    }));
    const workerIdentity = vi.fn(() => Promise.resolve({
      accountId: "abcdef0123456789abcdef0123456789",
      currentWorkerVersion,
      databaseId: "17ea8f2f-4c97-4337-8989-28b25a58ddeb",
      databaseName: "selinow-production",
      deployableWorkerVersionIds: [candidateWorkerVersion, rollbackCandidateWorkerVersion],
      workerName: "selinow-com-production",
      zoneId: "0123456789abcdef0123456789abcdef",
      zoneName: "selinow.com",
    }));

    await expect(assertProductionWorkerDeployAdmission({
      assertReleaseAdmissionImplementation: releaseAdmission,
      environment: { CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-audit-token" },
      manifestPath: ".wrangler/releases/release_20260726_abcdef12/release-manifest.json",
      productionSpec: readyProductionSpec(),
      repositoryRoot: process.cwd(),
      stagingSpec: { environment: "staging" },
      workerIdentityImplementation: workerIdentity,
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    })).resolves.toEqual({
      accountId: "abcdef0123456789abcdef0123456789",
      candidateWorkerVersion,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      databaseId: "17ea8f2f-4c97-4337-8989-28b25a58ddeb",
      databaseName: "selinow-production",
      previousWorkerVersion: currentWorkerVersion,
      releaseId: "release_20260726_abcdef12",
      rollbackCandidateWorkerVersion,
      workerName: "selinow-com-production",
      zoneId: "0123456789abcdef0123456789abcdef",
      zoneName: "selinow.com",
    });
    expect(releaseAdmission).toHaveBeenCalledTimes(1);
    expect(workerIdentity).toHaveBeenCalledWith(expect.objectContaining({
      productionSpec: readyProductionSpec(),
      requireCurrentWorkerVersion: true,
      token: undefined,
      wranglerConfig: readyWranglerConfig(),
    }));
  });

  it("requires a dedicated deploy token and candidate provenance at the production sink", async () => {
    const currentWorkerVersion = "11111111-1111-4111-8111-111111111111";
    const rollbackCandidateWorkerVersion = "22222222-2222-4222-8222-222222222222";
    const candidateWorkerVersion = "33333333-3333-4333-8333-333333333333";
    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    const treeSha = "89abcdef0123456789abcdef0123456789abcdef";
    const releaseId = "release_20260726_abcdef12";
    const releaseAdmission = () => Promise.resolve({
      candidateWorkerVersion,
      commitSha,
      previousWorkerVersion: currentWorkerVersion,
      releaseId,
      rollbackCandidateWorkerVersion,
      treeSha,
    });
    const workerIdentity = () => Promise.resolve({
      accountId: "abcdef0123456789abcdef0123456789",
      currentWorkerVersion,
      databaseId: "17ea8f2f-4c97-4337-8989-28b25a58ddeb",
      databaseName: "selinow-production",
      deployableWorkerVersionIds: [candidateWorkerVersion, rollbackCandidateWorkerVersion],
      deployableWorkerVersionInventory: [{
        binding: {
          commitSha,
          manifestRef: `.wrangler/releases/${releaseId}/release-manifest.json`,
          manifestSha256: null,
          releaseId,
          role: "candidate",
          treeSha,
        },
        id: candidateWorkerVersion,
      }, {
        binding: {
          commitSha: "rollback-commit-sha",
          manifestRef: `.wrangler/releases/${releaseId}/rollback-manifest.json`,
          releaseId: `${releaseId}_rollback`,
          role: "rollback",
          treeSha: "rollback-tree-sha",
        },
        id: rollbackCandidateWorkerVersion,
      }],
      workerName: "selinow-com-production",
      zoneId: "0123456789abcdef0123456789abcdef",
      zoneName: "selinow.com",
    });
    const common = {
      assertReleaseAdmissionImplementation: releaseAdmission,
      manifestPath: `.wrangler/releases/${releaseId}/release-manifest.json`,
      productionSpec: readyProductionSpec(),
      repositoryRoot: process.cwd(),
      requireDedicatedWorkerDeployToken: true,
      requireWorkerVersionBinding: true,
      stagingSpec: { environment: "staging" },
      workerIdentityImplementation: workerIdentity,
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig: readyWranglerConfig(),
    };
    await expect(assertProductionWorkerDeployAdmission({
      ...common,
      environment: { CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-audit-token" },
    })).rejects.toThrow("cloudflare_worker_deploy_api_token_missing");
    await expect(assertProductionWorkerDeployAdmission({
      ...common,
      environment: {
        CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-audit-token",
        CLOUDFLARE_WORKER_DEPLOY_API_TOKEN: "dedicated-worker-token",
      },
    })).rejects.toThrow("production_rollback_worker_version_binding_invalid");

    await expect(assertProductionWorkerDeployAdmission({
      ...common,
      rollbackWorkerVersionBinding: {
        commitSha: "rollback-commit-sha",
        manifestRef: `.wrangler/releases/${releaseId}/rollback-manifest.json`,
        releaseId: `${releaseId}_rollback`,
        treeSha: "rollback-tree-sha",
      },
      environment: {
        CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-audit-token",
        CLOUDFLARE_WORKER_DEPLOY_API_TOKEN: "dedicated-worker-token",
      },
    })).resolves.toMatchObject({ candidateWorkerVersion, commitSha, releaseId, treeSha });
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
