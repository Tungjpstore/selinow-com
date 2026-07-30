import { stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertProductionBootstrapExecutionAdmission,
  buildProductionBootstrapPlan,
  buildProductionRouteHandoff,
  inspectProductionBootstrapCutoverBlockers,
  type ProductionBootstrapEvidence,
  type ProductionBootstrapInput,
  type ProductionBootstrapInventory,
  writeProductionBootstrapPlan,
} from "../../scripts/lib/production-bootstrap.mjs";
import { REQUIRED_WORKER_SECRET_NAMES } from "../../scripts/lib/release.mjs";

const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const ZONE_ID = "1234567890abcdef1234567890abcdef";
const D1_ID = "17ea8f2f-4c97-4337-8989-28b25a58ddeb";

const stagingSpec = {
  accountId: ACCOUNT_ID,
  environment: "staging",
  hostnames: [
    "staging.selinow.com",
    "app-staging.selinow.com",
    "api-staging.selinow.com",
    "signal.staging.selinow.com",
    "canvas.staging.selinow.com",
    "coming-soon.staging.selinow.com",
    "paused.staging.selinow.com",
  ],
  sharedZoneDisabledRoutes: ["selinow.com/*", "*.selinow.com/*"],
  wildcardRoute: "*.staging.selinow.com/*",
  workerName: "selinow-com-staging",
  workerRoutes: [
    { custom_domain: true, pattern: "staging.selinow.com" },
    { custom_domain: true, pattern: "app-staging.selinow.com" },
    { custom_domain: true, pattern: "api-staging.selinow.com" },
    { custom_domain: true, pattern: "signal.staging.selinow.com" },
    { custom_domain: true, pattern: "canvas.staging.selinow.com" },
    { custom_domain: true, pattern: "coming-soon.staging.selinow.com" },
    { custom_domain: true, pattern: "paused.staging.selinow.com" },
    { pattern: "*.staging.selinow.com/*", zone_name: "selinow.com" },
    { pattern: "*/*", zone_name: "selinow.com" },
  ],
  zoneId: ZONE_ID,
  zoneName: "selinow.com",
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
  routing: {
    canaryOverrideRoute: "canary.selinow.com/*",
    externalCustomDomainFallbackRoute: "*/*",
    externalCustomDomainStrategy: "platform_only_staging_fallback",
    platformApexRoute: "selinow.com/*",
    platformStorefrontWildcard: "*.selinow.com/*",
    routeHandoff: "atomic_platform_route_replacement",
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
  workerName: "selinow-com-production",
  zoneId: ZONE_ID,
  zoneName: "selinow.com",
};

const routes = [
  { pattern: "selinow.com/*", script: null },
  { pattern: "*.selinow.com/*", script: null },
  { pattern: "*.staging.selinow.com/*", script: "selinow-com-staging" },
  { pattern: "*/*", script: "selinow-com-staging" },
];

const stagingDomains = stagingSpec.hostnames.map((hostname) => ({
  hostname,
  service: stagingSpec.workerName,
  zoneId: ZONE_ID,
  zoneName: "selinow.com",
}));

function emptyInventory(): ProductionBootstrapInventory {
  return {
    accountId: ACCOUNT_ID,
    domains: stagingDomains,
    resources: { d1: [], kv: [], queue: [], r2: [] },
    routes,
    zoneId: ZONE_ID,
    zoneName: "selinow.com",
  };
}

function reconciledResources() {
  return {
    d1: [{ id: D1_ID, name: "selinow-production" }],
    kv: [
      { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "selinow-cache-production" },
      { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "selinow-session-production" },
    ],
    queue: [
      { name: "selinow-integration-production" },
      { name: "selinow-notification-production" },
      { name: "selinow-dlq-production" },
    ],
    r2: [
      { name: "selinow-media-production" },
      { name: "selinow-private-exports-production" },
    ],
  };
}

function evidence(phase: "resources" | "canary" | "promote"): ProductionBootstrapEvidence {
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
    candidateWorkerVersion: phase === "promote" ? "worker-version-candidate-001" : null,
    canary: {
      accepted: phase === "promote",
      acceptedAt: phase === "promote" ? "2026-07-30T03:00:00.000Z" : null,
      smokeReportRef: phase === "promote" ? "private/canary/smoke.json" : null,
      stagingRoutesPreserved: phase === "promote",
      workerVersion: phase === "promote" ? "worker-version-candidate-001" : null,
    },
    ceremonyId: "bootstrap_20260730_reviewed",
    environment: "production",
    migrations: {
      appliedAt: "2026-07-30T02:00:00.000Z",
      direction: "forward_only",
      names: ["0001_platform.sql", "0002_orders.sql"],
    },
    monitoring: { alertsReady: phase === "promote", dashboardReady: phase === "promote" },
    phase,
    preBootstrapTrafficSnapshotRef: "private/traffic/before.json",
    previousWorkerVersion: null,
    resourceManifestRef: "private/resources/manifest.json",
    reviewedCommitSha: "a".repeat(40),
    reviewedTreeSha: "b".repeat(40),
    rollback: {
      snapshotRef: "private/traffic/before.json",
      strategy: "restore_pre_bootstrap_traffic_inventory",
    },
    schemaVersion: 1,
  };
}

function input(phase: "resources" | "canary" | "promote"): ProductionBootstrapInput {
  const inventory = emptyInventory();
  if (phase !== "resources") {
    inventory.resources = reconciledResources();
  }
  if (phase === "promote") {
    inventory.routes = [
      ...inventory.routes,
      { pattern: "canary.selinow.com/*", script: "selinow-com-production" },
    ];
  }
  return {
    evidence: evidence(phase),
    inventory,
    migrationNames: ["0001_platform.sql", "0002_orders.sql"],
    now: new Date("2026-07-30T04:00:00.000Z"),
    phase,
    productionSpec: structuredClone(productionSpec),
    repositoryState: { clean: true, commitSha: "a".repeat(40), treeSha: "b".repeat(40) },
    secretNames: [...REQUIRED_WORKER_SECRET_NAMES],
    stagingSpec: structuredClone(stagingSpec),
  };
}

describe("first-production bootstrap ceremony", () => {
  it("builds a specificity-safe route handoff that preserves staging before the production fallback", () => {
    const handoff = buildProductionRouteHandoff(productionSpec, stagingSpec);

    expect(handoff.canary).toEqual([
      { pattern: "canary.selinow.com/*", script: "selinow-com-production" },
    ]);
    expect(handoff.promote).toEqual([
      { pattern: "selinow.com/*", script: "selinow-com-production" },
      { pattern: "*.selinow.com/*", script: "selinow-com-production" },
      { pattern: "staging.selinow.com/*", script: "selinow-com-staging" },
      { pattern: "app-staging.selinow.com/*", script: "selinow-com-staging" },
      { pattern: "api-staging.selinow.com/*", script: "selinow-com-staging" },
      { pattern: "*.staging.selinow.com/*", script: "selinow-com-staging" },
      { pattern: "*/*", script: "selinow-com-staging" },
    ]);
    expect(handoff.stagingExceptions).not.toContain("canary.selinow.com/*");
  });

  it("plans only exact named resource creates and records name-only secret admission", () => {
    const plan = buildProductionBootstrapPlan(input("resources"));

    expect(plan.actions.filter((action: { action: string }) => action.action === "create")).toHaveLength(8);
    expect(plan.safeguards).toMatchObject({
      allowedMutations: ["named_production_resources"],
      cutoverBlockers: [
        "platform_storefront_wildcard_disabled_by_staging_guard",
        "platform_apex_route_disabled_by_staging_guard",
      ],
      forwardOnlyMigrations: true,
      secretNameCount: REQUIRED_WORKER_SECRET_NAMES.length,
      secretValuesAccepted: false,
      stagingTrafficImmutable: true,
    });
    expect(JSON.stringify(plan)).not.toContain("SESSION_SECRET");
    expect(plan.firstVersionRollback).toEqual({
      previousWorkerVersion: null,
      snapshotRef: "private/traffic/before.json",
      strategy: "restore_pre_bootstrap_traffic_inventory",
    });
  });

  it("is idempotent and reuses exact existing resource identities", () => {
    const candidate = input("resources");
    candidate.inventory.resources = reconciledResources();

    const plan = buildProductionBootstrapPlan(candidate);
    expect(plan.actions.filter((action: { code: string }) => action.code.startsWith("resource.")))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "reuse", code: "resource.d1", id: D1_ID }),
        expect.objectContaining({ action: "reuse", code: "resource.r2" }),
        expect.objectContaining({ action: "reuse", code: "resource.sessionKv" }),
      ]));

    const wrongType = input("resources");
    wrongType.inventory.resources.r2.push({ name: "selinow-production" });
    expect(() => buildProductionBootstrapPlan(wrongType))
      .toThrow("production_bootstrap_resource_type_conflict:d1");
  });

  it("requires clean reviewed Git content and accepts secret names without values only", () => {
    const dirty = input("resources");
    dirty.repositoryState.clean = false;
    expect(() => buildProductionBootstrapPlan(dirty)).toThrow("production_bootstrap_source_dirty");

    const mismatchedTree = input("resources");
    mismatchedTree.repositoryState.treeSha = "c".repeat(40);
    expect(() => buildProductionBootstrapPlan(mismatchedTree))
      .toThrow("production_bootstrap_reviewed_tree_mismatch");

    const secretValue = input("resources");
    secretValue.secretNames = [...REQUIRED_WORKER_SECRET_NAMES, "SESSION_SECRET=plaintext"];
    expect(() => buildProductionBootstrapPlan(secretValue))
      .toThrow("production_bootstrap_secret_names_invalid");
  });

  it("rejects account drift, staging route drift, and premature stable-domain ownership", () => {
    const accountDrift = input("resources");
    accountDrift.inventory.accountId = "f".repeat(32);
    expect(() => buildProductionBootstrapPlan(accountDrift))
      .toThrow("production_bootstrap_inventory_identity_mismatch");

    const routeDrift = input("resources");
    routeDrift.inventory.routes = routes.map((route) => (
      route.pattern === "*/*" ? { ...route, script: "selinow-com-production" } : route
    ));
    expect(() => buildProductionBootstrapPlan(routeDrift))
      .toThrow(/production_bootstrap_staging_route_drift/u);

    const domainDrift = input("resources");
    domainDrift.inventory.domains = [
      ...stagingDomains,
      {
        hostname: "selinow.com",
        service: "selinow-com-production",
        zoneId: ZONE_ID,
        zoneName: "selinow.com",
      },
    ];
    expect(() => buildProductionBootstrapPlan(domainDrift))
      .toThrow("production_bootstrap_domain_drift:selinow.com");
  });

  it("requires a fresh empty-D1 baseline, restore evidence, and exact forward-only migrations", () => {
    const candidate = input("canary");
    const plan = buildProductionBootstrapPlan(candidate);
    expect(candidate.evidence.candidateWorkerVersion).toBeNull();
    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "create", code: "traffic.canary_route" }),
      expect.objectContaining({ action: "deploy", code: "worker.candidate_canary_only" }),
    ]));
    expect(plan.safeguards.allowedMutations).toEqual([
      "production_candidate_worker_version",
      "production_canary_worker_route",
    ]);

    candidate.evidence.migrations.direction = "down_then_up";
    expect(() => buildProductionBootstrapPlan(candidate))
      .toThrow("production_bootstrap_canary_prerequisites_incomplete");
  });

  it("admits only the staging-bound bootstrap canary DNS carrier", () => {
    const candidate = input("canary");
    candidate.inventory.domains = [
      ...stagingDomains,
      {
        hostname: productionSpec.bootstrap.canaryHostname,
        service: stagingSpec.workerName,
        zoneId: ZONE_ID,
        zoneName: productionSpec.zoneName,
      },
    ];

    expect(buildProductionBootstrapPlan(candidate).actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "create",
        code: "traffic.canary_route",
        pattern: "canary.selinow.com/*",
        script: productionSpec.workerName,
      }),
    ]));

    candidate.inventory.domains[candidate.inventory.domains.length - 1].service = "unapproved-worker";
    expect(() => buildProductionBootstrapPlan(candidate))
      .toThrow("production_bootstrap_domain_drift:canary.selinow.com");
  });

  it("keeps the reviewed canary plan stable across the upload evidence transition", () => {
    const beforeUpload = input("canary");
    const planBeforeUpload = buildProductionBootstrapPlan(beforeUpload);

    const afterUpload = input("canary");
    afterUpload.evidence.candidateWorkerVersion = "worker-version-candidate-001";
    expect(buildProductionBootstrapPlan(afterUpload)).toEqual(planBeforeUpload);

    afterUpload.evidence.candidateWorkerVersion = "bad";
    expect(() => buildProductionBootstrapPlan(afterUpload))
      .toThrow("production_bootstrap_canary_prerequisites_incomplete");
  });

  it("blocks stable cutover while staging owns wildcard traffic", () => {
    expect(() => buildProductionBootstrapPlan(input("promote")))
      .toThrow(
        "production_bootstrap_cutover_blocked:platform_storefront_wildcard_disabled_by_staging_guard",
      );
  });

  it("detects missing external-domain routing and Turnstile hostname admission", () => {
    const blockers = inspectProductionBootstrapCutoverBlockers({
      productionSpec: {
        ...productionSpec,
        routing: {
          routeHandoff: "atomic_shared_zone_route_replacement",
          externalCustomDomainStrategy: "not_admitted",
          platformStorefrontWildcard: "*.selinow.com/*",
        },
        turnstile: { externalCustomDomainStrategy: "not_admitted" },
      },
      stagingSpec,
    });

    expect(blockers).toEqual(expect.arrayContaining([
      "external_custom_domains_captured_by_staging_catch_all",
      "external_custom_domain_route_strategy_missing",
      "turnstile_external_hostname_strategy_missing",
      "turnstile_external_hostname_admission_unverified",
    ]));
  });

  it("keeps external custom-domain fallback on staging in platform-only mode", () => {
    const platformOnly = input("promote");
    platformOnly.productionSpec.routing.stagingExternalCustomDomainInventory = "pending_inventory";
    platformOnly.stagingSpec.sharedZoneDisabledRoutes = [];
    platformOnly.stagingSpec.workerRoutes = platformOnly.stagingSpec.workerRoutes.filter(
      (route: { pattern?: string }) => route.pattern !== "*/*",
    );
    const plan = buildProductionBootstrapPlan(platformOnly);
    expect(plan.safeguards.cutoverBlockers).toEqual([]);
    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "traffic.shared_zone_route", pattern: "*/*", script: "selinow-com-staging" }),
    ]));
  });

  it("requires both confirmations and an unchanged final admission snapshot", () => {
    const initial = input("resources");
    expect(() => assertProductionBootstrapExecutionAdmission({
      confirmFirstProductionBootstrap: false,
      confirmProduction: true,
      final: initial,
      initial,
    })).toThrow("production_first_bootstrap_confirmation_required");

    const final = input("resources");
    final.inventory.resources.r2.push({ name: "selinow-media-production" });
    expect(() => assertProductionBootstrapExecutionAdmission({
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      final,
      initial,
    })).toThrow("production_bootstrap_admission_changed");
  });

  it("writes private local plan artifacts with mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-production-bootstrap-"));
    const plan = buildProductionBootstrapPlan(input("resources"));
    const ref = await writeProductionBootstrapPlan(plan, root);
    const metadata = await stat(join(root, ref));

    expect(ref).toBe(".wrangler/bootstrap/bootstrap_20260730_reviewed/resources-plan.json");
    expect(metadata.mode & 0o777).toBe(0o600);
  });
});
