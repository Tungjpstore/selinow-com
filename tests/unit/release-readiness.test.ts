import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertProductionDeployAdmission,
  assertProductionWorkerDeployAdmission,
  buildProductionRollbackRehearsalArtifact,
  buildReleaseArtifacts,
  evaluateBackupPrerequisites,
  inspectProductionReadiness,
  REQUIRED_PRODUCTION_VARS,
  REQUIRED_WORKER_SECRET_NAMES,
  runPilotSmoke,
  validateProductionDeployAdmission,
  validateProductionRollbackArtifact,
  validatePilotSmokePlan,
  writeProductionRollbackRehearsalArtifact,
} from "../../scripts/lib/release.mjs";
import { DODO_STAGING_UAT_SCENARIO_IDS } from "../../scripts/lib/dodo-uat-evidence.mjs";
import { PAYOS_STAGING_UAT_SCENARIO_IDS, serializePayosOwnerAttestationPayload } from "../../scripts/lib/payos-uat-evidence.mjs";

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
const rollbackInvariants = [
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
  "shop_subscriptions_trial_claim_insert_guard",
  "shop_subscriptions_trial_claim_update_guard",
  "shop_customers_anonymized_insert_guard",
  "shop_customers_anonymized_update_guard",
  "checkout_recovery_capabilities_tenant_order_insert_guard",
  "checkout_recovery_capabilities_tenant_order_guard",
  "payment_integrations_provider_claim_generation",
  "payment_integrations_provider_claim_nonce",
  "payment_integrations_provider_claim_state",
  "payment_integrations_provider_claim_target_fingerprint",
  "payment_credentials_provider_claim_nonce",
  "idx_payment_integrations_provider_claim_nonce",
  "payment_integrations_payos_claim_state_insert_guard",
  "payment_integrations_payos_claim_state_update_guard",
  "payment_credentials_payos_claim_scope_insert_guard",
  "payment_credentials_payos_claim_scope_update_guard",
  "payment_integrations_payos_claim_fingerprint_update_guard",
  "payment_credentials_payos_claim_fingerprint_update_guard",
  "payment_integrations_payos_claim_fingerprint_clear_guard",
  "payment_credentials_payos_claim_fingerprint_clear_guard",
];
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
      ...{ repositoryTreeSha: evidence.treeSha },
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
      evidence,
      manifest,
      migrationNames,
      now,
      packageVersion: "0.0.0",
      productionSpec,
      repositoryClean: false,
      repositoryCommitSha: "0123456789abcdef0123456789abcdef01234567",
      ...{ repositoryTreeSha: evidence.treeSha },
      workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      wranglerConfig,
    })).toThrow("production_release_source_dirty");
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

  it("checks the canonical private manifest and clean Git identity at deploy admission", async () => {
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
      type ScenarioRecord = {
        eventReference: string;
        evidenceFingerprintSha256: string;
        observedAt: string;
        requestReference: string;
        status: "passed" | "unsupported";
      };
      type PayosScenarioRecord = ScenarioRecord & {
        classification: "provider_supported" | "provider_unsupported" | "selinow_local_assurance";
        reasonCode: "payos_signed_chargeback_not_supported" | "payos_signed_refund_not_supported" | null;
        status: "passed" | "unsupported";
        verificationMethod: "local_contract" | "provider_capability_audit" | "signed_webhook" | "verified_provider_response";
      };
      const scenarioRecord = async (provider: string, id: string): Promise<ScenarioRecord> => {
        const artifactRef = `.wrangler/releases/staging/${stagingReleaseId}/scenarios/${provider}-${id}.json`;
        const artifact = JSON.stringify({ environment: "staging", provider, release: releaseBinding, scenarioId: id });
        await mkdir(join(root, ".wrangler/releases/staging", stagingReleaseId, "scenarios"), { recursive: true });
        await writeFile(join(root, artifactRef), artifact, { mode: 0o600 });
        return {
          eventReference: `artifact:${artifactRef}`,
          evidenceFingerprintSha256: createHash("sha256").update(artifact).digest("hex"),
          observedAt: "2026-07-25T12:00:00.000Z",
          requestReference: `artifact:${artifactRef}`,
          status: "passed",
        };
      };
      const dodoScenarios: Record<string, ScenarioRecord & { sessionReference: null }> = {};
      for (const id of DODO_STAGING_UAT_SCENARIO_IDS) {
        dodoScenarios[id] = { ...(await scenarioRecord("dodo", id)), sessionReference: null };
      }
      const payosControlledAccountFingerprintSha256 = "a".repeat(64);
      const payosTransactionEvidenceFingerprintSha256 = "b".repeat(64);
      const payosScenarios: Record<string, PayosScenarioRecord> = {};
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
          proofOfExecutionFingerprintSha256: providerRequired ? payosTransactionEvidenceFingerprintSha256 : null,
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
      const dodoArtifact = {
        completedAt: "2026-07-25T13:00:00.000Z",
        createdAt: "2026-07-25T11:00:00.000Z",
        endpointFingerprintSha256: "e".repeat(64),
        environment: "staging",
        offers: [
          { planCode: "starter", marketCode: "vn", currency: "VND", amountMinor: 99_000, interval: "month", providerReferenceFingerprintSha256: "1".repeat(64) },
          { planCode: "pro", marketCode: "vn", currency: "VND", amountMinor: 299_000, interval: "month", providerReferenceFingerprintSha256: "2".repeat(64) },
          { planCode: "starter", marketCode: "global", currency: "USD", amountMinor: 500, interval: "month", providerReferenceFingerprintSha256: "3".repeat(64) },
          { planCode: "pro", marketCode: "global", currency: "USD", amountMinor: 1_500, interval: "month", providerReferenceFingerprintSha256: "4".repeat(64) },
        ],
        provider: "dodo",
        providerEnvironment: "test_mode",
        redaction: { auditNoSensitiveValues: true, d1NoHostedCheckoutUrl: true, d1NoRawPayload: true, d1NoSecretValues: true, evidenceFingerprintSha256: "f".repeat(64), logsNoSensitiveValues: true, queuesNoSensitiveValues: true },
        release: releaseBinding,
        scenarios: dodoScenarios,
        schemaVersion: 1,
      };
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
      dodoCommerce.evidenceRef = `.wrangler/releases/staging/${stagingReleaseId}/dodo-uat-evidence.json`;
      payosCommerce.evidenceRef = `.wrangler/releases/staging/${stagingReleaseId}/payos-uat-evidence.json`;
      const dodoBytes = JSON.stringify(dodoArtifact);
      const payosBytes = JSON.stringify(payosArtifact);
      await Promise.all([
        writeFile(join(root, String(dodoCommerce.evidenceRef)), dodoBytes, { mode: 0o600 }),
        writeFile(join(root, String(payosCommerce.evidenceRef)), payosBytes, { mode: 0o600 }),
      ]);
      dodoCommerce.artifactSha256 = createHash("sha256").update(dodoBytes).digest("hex");
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
      const manifest = buildReleaseArtifacts({
        evidence,
        migrationNames: ["0001_first.sql"],
        now,
        packageVersion: "0.0.0",
        productionSpec: readyProductionSpec(),
        workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
        repositoryRoot: root,
        wranglerConfig: readyWranglerConfig(),
      }).manifest;
      const evidencePath = join(root, ".wrangler/release/production-evidence.json");
      const manifestPath = join(root, ".wrangler/releases", releaseId, "release-manifest.json");
      await writeFile(evidencePath, JSON.stringify(evidence), { mode: 0o600 });
      await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });

      await expect(assertProductionDeployAdmission({
        manifestPath,
        now,
        repositoryRoot: root,
        workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      })).resolves.toEqual({
        candidateWorkerVersion: "33333333-3333-4333-8333-333333333333",
        commitSha,
        migrationLedgerSha256: fingerprint(["0001_first.sql"]),
        migrationLedgerPrefix: ["0001_first.sql"],
        previousWorkerVersion: "11111111-1111-4111-8111-111111111111",
        releaseId,
        rollbackArtifactSha256: rollback.candidate.artifactSha256,
        rollbackCandidateWorkerVersion: "22222222-2222-4222-8222-222222222222",
        treeSha,
      });

      await writeFile(join(root, rollback.rehearsalEvidenceRef), `${rollbackArtifact}\n`, { mode: 0o600 });
      await expect(assertProductionDeployAdmission({
        manifestPath,
        now,
        repositoryRoot: root,
        workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      })).rejects.toThrow("production_rollback_artifact_hash_mismatch");
      await writeFile(join(root, rollback.rehearsalEvidenceRef), rollbackArtifact, { mode: 0o600 });

      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.0.1" }));
      await expect(assertProductionDeployAdmission({
        manifestPath,
        now,
        repositoryRoot: root,
        workerSecretNames: REQUIRED_WORKER_SECRET_NAMES,
      })).rejects.toThrow("production_release_source_dirty");
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
