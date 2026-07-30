import { stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildProductionPromotionAuditEnvironment,
  createProductionPromotionRoute,
  deleteProductionPromotionRoute,
  fingerprint,
  runProductionPromotion,
  runProductionPromotionRollback,
  updateProductionPromotionRoute,
  validateProductionPromotionPlan,
  writeProductionPromotionReport,
} from "../../scripts/lib/production-promotion.mjs";
import { buildProductionRouteHandoff } from "../../scripts/lib/production-bootstrap.mjs";

const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const ZONE_ID = "1234567890abcdef1234567890abcdef";
const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-30T12:30:00.000Z");

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
  sharedZoneDisabledRoutes: [],
  wildcardRoute: "*.staging.selinow.com/*",
  workerName: "selinow-com-staging",
  workerRoutes: [
    { custom_domain: true, pattern: "staging.selinow.com" },
    { custom_domain: true, pattern: "app-staging.selinow.com" },
    { custom_domain: true, pattern: "api-staging.selinow.com" },
    { pattern: "*.staging.selinow.com/*", zone_name: "selinow.com" },
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

const routesBeforeCanary = [
  { id: "route-apex-0001", pattern: "selinow.com/*", script: null },
  { id: "route-wild-0002", pattern: "*.selinow.com/*", script: null },
  { id: "route-stage-0003", pattern: "*.staging.selinow.com/*", script: "selinow-com-staging" },
  { id: "route-fallback-0004", pattern: "*/*", script: "selinow-com-staging" },
];

const routesAfterCanary = [
  ...routesBeforeCanary,
  { id: "route-canary-0005", pattern: "canary.selinow.com/*", script: "selinow-com-production" },
];

const domains = stagingSpec.hostnames.map((hostname) => ({
  hostname,
  service: stagingSpec.workerName,
  zoneId: ZONE_ID,
  zoneName: "selinow.com",
}));

const repositoryState = {
  clean: true,
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
};

function trafficSnapshot() {
  return {
    accountId: ACCOUNT_ID,
    domains,
    resources: { d1: [], kv: [], queue: [], r2: [] },
    routes: routesAfterCanary.map(({ pattern, script }) => ({ pattern, script })),
    zoneId: ZONE_ID,
    zoneName: "selinow.com",
  };
}

function canaryState() {
  return {
    accountId: ACCOUNT_ID,
    appliedAt: "2026-07-30T11:00:00.000Z",
    candidateVersionId: CANDIDATE_ID,
    canaryRoute: routesAfterCanary.at(-1),
    ceremonyId: "bootstrap_20260730_reviewed",
    controlVersionId: "22222222-2222-4222-8222-222222222222",
    environment: "production",
    mode: "applied",
    planSha256: "c".repeat(64),
    routesAfter: structuredClone(routesAfterCanary),
    routesBefore: structuredClone(routesBeforeCanary),
    schemaVersion: 1,
    workerName: "selinow-com-production",
    zoneId: ZONE_ID,
  };
}

function evidence() {
  return {
    schemaVersion: 1,
    environment: "production",
    phase: "promote",
    ceremonyId: "bootstrap_20260730_reviewed",
    reviewedCommitSha: repositoryState.commitSha,
    reviewedTreeSha: repositoryState.treeSha,
    preBootstrapTrafficSnapshotRef: "private/traffic/before.json",
    previousWorkerVersion: null,
    candidateWorkerVersion: CANDIDATE_ID,
    approvals: { releaseOwner: "private/approvals/release-owner.json", supportOwner: "private/approvals/support-owner.json" },
    resourceManifestRef: "infra/generated/production.json",
    backup: {
      completedAt: "2026-07-30T09:00:00.000Z",
      emptyDatabaseBaselineVerified: true,
      providerBookmarkRecorded: true,
      restoreDrillCompletedAt: "2026-07-30T10:00:00.000Z",
      restoreDrillPassed: true,
      restoreDrillReportRef: "private/restore/report.json",
      snapshotReportRef: "private/backup/report.json",
    },
    migrations: {
      appliedAt: "2026-07-30T10:30:00.000Z",
      direction: "forward_only",
      names: ["0001_platform.sql"],
    },
    rollback: {
      strategy: "restore_pre_bootstrap_traffic_inventory",
      snapshotRef: "private/traffic/before.json",
    },
    canary: {
      accepted: true,
      acceptedAt: "2026-07-30T12:00:00.000Z",
      smokeReportRef: "private/canary/smoke.json",
      stagingRoutesPreserved: true,
      workerVersion: CANDIDATE_ID,
    },
    monitoring: { alertsReady: true, dashboardReady: true },
  };
}

function acceptance() {
  const state = canaryState();
  return {
    schemaVersion: 1,
    mode: "promotion_acceptance",
    environment: "production",
    ceremonyId: "bootstrap_20260730_reviewed",
    candidateVersionId: CANDIDATE_ID,
    acceptedAt: "2026-07-30T12:00:00.000Z",
    acceptedBy: "private/approvals/release-owner.json",
    canaryStateRef: ".wrangler/bootstrap/bootstrap_20260730_reviewed/canary-applied.json",
    canaryStateSha256: fingerprint({ routesBefore: state.routesBefore, routesAfter: state.routesAfter }),
    smokeReportRef: "private/canary/smoke.json",
    stagingRoutesPreserved: true,
    monitoring: {
      alertsReady: true,
      dashboardReady: true,
      alertsEvidenceRef: "private/monitoring/alerts.json",
      dashboardEvidenceRef: "private/monitoring/dashboard.json",
      observedAt: "2026-07-30T12:05:00.000Z",
    },
  };
}

function plan() {
  const snapshot = trafficSnapshot();
  const handoff = buildProductionRouteHandoff(productionSpec, stagingSpec);
  const current = new Map(snapshot.routes.map((route) => [route.pattern, route.script]));
  return {
    schemaVersion: 1,
    environment: "production",
    phase: "promote",
    ceremonyId: "bootstrap_20260730_reviewed",
    fingerprints: {
      evidenceSha256: fingerprint(evidence()),
      inventorySha256: fingerprint(snapshot),
      sourceSha256: fingerprint(repositoryState),
      specSha256: fingerprint(productionSpec),
      stagingSpecSha256: fingerprint(stagingSpec),
    },
    safeguards: {
      allowedMutations: ["production_shared_zone_worker_routes"],
      cutoverBlockers: [],
    },
    actions: [
      { action: "verify", code: "worker.canary_accepted" },
      ...handoff.promote.map((route) => ({
        action: current.get(route.pattern) === route.script ? "reuse" : "reconcile",
        code: "traffic.shared_zone_route",
        pattern: route.pattern,
        script: route.script,
      })),
      { action: "delete", code: "traffic.canary_route", ...handoff.canary[0] },
      { action: "verify", code: "traffic.staging_inventory_unchanged" },
    ],
  };
}

function liveInventory(routes = routesAfterCanary) {
  return {
    accountId: ACCOUNT_ID,
    activeVersionId: CANDIDATE_ID,
    domains,
    observedAt: NOW.toISOString(),
    queueConsumers: [],
    routes: structuredClone(routes),
    schedules: [],
    workerName: "selinow-com-production",
    zoneId: ZONE_ID,
    zoneName: "selinow.com",
  };
}

function common() {
  return {
    acceptanceEvidence: acceptance(),
    canaryState: canaryState(),
    evidence: evidence(),
    now: NOW,
    plan: plan(),
    productionSpec,
    repositoryState,
    stagingSpec,
    trafficSnapshot: trafficSnapshot(),
    migrationNames: ["0001_platform.sql"],
  };
}

function mutableRouteApi(initial = routesAfterCanary) {
  let routes = structuredClone(initial);
  let sequence = 10;
  return {
    create: vi.fn(({ pattern, script }: { pattern: string; script: string | null }) => {
      const route = { id: `route-created-${String(sequence++)}`, pattern, script };
      routes.push(route);
      return Promise.resolve(route);
    }),
    delete: vi.fn((routeId: string) => {
      routes = routes.filter((route) => route.id !== routeId);
      return Promise.resolve(true);
    }),
    update: vi.fn((routeId: string, change: { pattern: string; script: string | null }) => {
      const route = routes.find((candidate) => candidate.id === routeId);
      if (route !== undefined) Object.assign(route, change);
      return Promise.resolve(route);
    }),
    inventory: () => Promise.resolve(liveInventory(routes)),
    routes: () => routes,
  };
}

describe("first-production route promotion", () => {
  it("binds the reviewed plan to the exact source, snapshot, evidence, and route matrix", () => {
    const result = validateProductionPromotionPlan(common());
    expect(result.handoff.promote).toHaveLength(7);

    const candidate = common();
    candidate.plan.safeguards.allowedMutations = ["production_stable_worker_domains"];
    expect(() => validateProductionPromotionPlan(candidate)).toThrow("production_promotion_plan_invalid");
  });

  it("fails closed while any recomputed shared-zone cutover blocker remains", () => {
    const candidate = common();
    candidate.stagingSpec = {
      ...stagingSpec,
      sharedZoneDisabledRoutes: ["*.selinow.com/*"],
    };
    candidate.plan.fingerprints.stagingSpecSha256 = fingerprint(candidate.stagingSpec);
    expect(() => validateProductionPromotionPlan(candidate))
      .toThrow("production_promotion_cutover_blocked:platform_storefront_wildcard_disabled_by_staging_guard");
  });

  it("plans explicit create/delete reconciliation without a broad route replacement", async () => {
    const api = mutableRouteApi();
    const result = await runProductionPromotion({
      ...common(),
      execute: false,
      inventoryImplementation: api.inventory,
    });

    expect(result.executed).toBe(false);
    expect(result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "create", detail: "staging.selinow.com/* -> selinow-com-staging" }),
      expect.objectContaining({ action: "delete", detail: "canary.selinow.com/* -> selinow-com-production" }),
    ]));
    expect(result.actions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ detail: "*/* -> selinow-com-production" }),
    ]));
    expect(api.create).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("reconciles only the approved matrix, preserves staging, captures IDs, and verifies post-state", async () => {
    const api = mutableRouteApi();
    const result = await runProductionPromotion({
      ...common(),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      createRouteImplementation: api.create,
      deleteRouteImplementation: api.delete,
      updateRouteImplementation: api.update,
      execute: true,
      inventoryImplementation: api.inventory,
      writeReportImplementation: () => Promise.resolve("private/promotion-applied.json"),
    });
    const handoff = buildProductionRouteHandoff(productionSpec, stagingSpec);

    expect(result.ok).toBe(true);
    const appliedState = result.state as { routesBefore: unknown; changes: Array<{ before: unknown; after: unknown }> };
    expect(appliedState.routesBefore).toEqual(routesAfterCanary.slice().sort((left, right) => left.pattern.localeCompare(right.pattern)));
    expect(appliedState.changes).toHaveLength(6);
    expect(appliedState.changes.every((change) => (
      change.before !== undefined && change.after !== undefined
    ))).toBe(true);
    expect(api.routes().map(({ pattern, script }) => ({ pattern, script })).sort((left, right) => left.pattern.localeCompare(right.pattern)))
      .toEqual(handoff.promote.slice().sort((left, right) => left.pattern.localeCompare(right.pattern)));
    expect(api.routes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern: "staging.selinow.com/*", script: "selinow-com-staging" }),
      expect.objectContaining({ pattern: "*.staging.selinow.com/*", script: "selinow-com-staging" }),
      expect.objectContaining({ pattern: "*/*", script: "selinow-com-staging" }),
    ]));
  });

  it("compensates completed changes from captured state when a later update fails", async () => {
    const api = mutableRouteApi();
    const update = vi.fn((routeId: string, { pattern, script }: { pattern: string; script: string | null }) => {
      if (pattern === "selinow.com/*" && script === "selinow-com-production") {
        return Promise.reject(new Error("simulated_route_update_failure"));
      }
      return api.update(routeId, { pattern, script });
    });

    await expect(runProductionPromotion({
      ...common(),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      createRouteImplementation: api.create,
      deleteRouteImplementation: api.delete,
      updateRouteImplementation: update,
      execute: true,
      inventoryImplementation: api.inventory,
    })).rejects.toThrow("simulated_route_update_failure");
    expect(api.routes().map(({ pattern, script }) => ({ pattern, script })).sort((left, right) => left.pattern.localeCompare(right.pattern)))
      .toEqual(routesAfterCanary.map(({ pattern, script }) => ({ pattern, script })).sort((left, right) => left.pattern.localeCompare(right.pattern)));
  });

  it("reconciles a committed create whose response is lost", async () => {
    const api = mutableRouteApi();
    const create = vi.fn(({ pattern, script }: { pattern: string; script: string | null }) => (
      api.create({ pattern, script }).then(() => Promise.reject(new Error("response_lost_after_create")))
    ));
    const result = await runProductionPromotion({
      ...common(),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      createRouteImplementation: create,
      deleteRouteImplementation: api.delete,
      updateRouteImplementation: api.update,
      execute: true,
      inventoryImplementation: api.inventory,
    });
    expect(result.ok).toBe(true);
    expect(api.routes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern: "staging.selinow.com/*", script: "selinow-com-staging" }),
    ]));
  });

  it("reconciles a committed per-route update whose response is lost", async () => {
    const api = mutableRouteApi();
    const update = vi.fn((routeId: string, change: { pattern: string; script: string | null }) => (
      api.update(routeId, change).then(() => Promise.reject(new Error("response_lost_after_update")))
    ));
    const result = await runProductionPromotion({
      ...common(),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      createRouteImplementation: api.create,
      deleteRouteImplementation: api.delete,
      updateRouteImplementation: update,
      execute: true,
      inventoryImplementation: api.inventory,
    });
    expect(result.ok).toBe(true);
    expect(api.routes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern: "selinow.com/*", script: "selinow-com-production" }),
    ]));
  });

  it("rejects route-ID drift and unapproved route patterns before mutation", async () => {
    const idDrift = mutableRouteApi(routesAfterCanary.map((route) => (
      route.pattern === "*/*" ? { ...route, id: "route-drift-9999" } : route
    )));
    await expect(runProductionPromotion({
      ...common(),
      execute: false,
      inventoryImplementation: idDrift.inventory,
    })).rejects.toThrow("production_promotion_live_inventory_drift");

    const unexpected = mutableRouteApi([
      ...routesAfterCanary,
      { id: "route-unknown-777", pattern: "legacy.selinow.com/*", script: "legacy-worker" },
    ]);
    await expect(runProductionPromotion({
      ...common(),
      execute: false,
      savedInventory: liveInventory(unexpected.routes()),
      inventoryImplementation: unexpected.inventory,
    })).rejects.toThrow("production_promotion_saved_inventory_mismatch");
  });

  it("rolls an applied route state back by captured IDs and definitions", async () => {
    const api = mutableRouteApi();
    const applied = await runProductionPromotion({
      ...common(),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      createRouteImplementation: api.create,
      deleteRouteImplementation: api.delete,
      updateRouteImplementation: api.update,
      execute: true,
      inventoryImplementation: api.inventory,
    });
    const rolledBack = await runProductionPromotionRollback({
      ...common(),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      createRouteImplementation: api.create,
      deleteRouteImplementation: api.delete,
      updateRouteImplementation: api.update,
      execute: true,
      inventoryImplementation: api.inventory,
      state: applied.state as Record<string, unknown>,
    });

    expect(rolledBack.ok).toBe(true);
    expect(api.routes().map(({ pattern, script }) => ({ pattern, script })).sort((left, right) => left.pattern.localeCompare(right.pattern)))
      .toEqual(routesAfterCanary.map(({ pattern, script }) => ({ pattern, script })).sort((left, right) => left.pattern.localeCompare(right.pattern)));
  });

  it("rejects evidence drift and a structurally tampered rollback state", async () => {
    const evidenceDrift = common();
    evidenceDrift.evidence.approvals.releaseOwner = "private/approvals/changed-owner.json";
    expect(() => validateProductionPromotionPlan(evidenceDrift)).toThrow("production_promotion_plan_invalid");

    const api = mutableRouteApi();
    const applied = await runProductionPromotion({
      ...common(),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      createRouteImplementation: api.create,
      deleteRouteImplementation: api.delete,
      updateRouteImplementation: api.update,
      execute: true,
      inventoryImplementation: api.inventory,
    });
    const state = structuredClone(applied.state) as {
      changes: Array<{ after: { id: string } }>;
      [key: string]: unknown;
    };
    const firstChange = state.changes.at(0);
    if (firstChange === undefined) throw new Error("promotion_state_change_missing");
    firstChange.after.id = "route-tampered-999";
    delete state.stateSha256;
    state.stateSha256 = fingerprint(state);
    await expect(runProductionPromotionRollback({
      ...common(),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      execute: false,
      inventoryImplementation: api.inventory,
      state,
    })).rejects.toThrow("production_promotion_state_invalid");

    const coherent = structuredClone(applied.state) as Record<string, unknown> & {
      routesBefore: unknown[];
      changes: unknown[];
      stateSha256?: string;
    };
    coherent.routesBefore = structuredClone(coherent.routesAfter as unknown[]);
    coherent.changes = [];
    delete coherent.stateSha256;
    coherent.stateSha256 = fingerprint(coherent);
    await expect(runProductionPromotionRollback({
      ...common(),
      execute: false,
      inventoryImplementation: api.inventory,
      state: coherent,
    })).rejects.toThrow("production_promotion_state_invalid");
  });

  it("fails closed when a route ID changes between mutation checkpoints", async () => {
    const api = mutableRouteApi();
    let reads = 0;
    const inventory = () => {
      reads += 1;
      if (reads === 3) {
        const route = api.routes().find((candidate) => candidate.pattern === "selinow.com/*");
        if (route === undefined) throw new Error("route_for_churn_missing");
        route.id = "route-churn-0009";
      }
      return api.inventory();
    };
    await expect(runProductionPromotion({
      ...common(),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      createRouteImplementation: api.create,
      deleteRouteImplementation: api.delete,
      updateRouteImplementation: api.update,
      execute: true,
      inventoryImplementation: inventory,
    })).rejects.toThrow("production_promotion_post_mutation_drift");
  });

  it("resumes a partially failed rollback from the verified route checkpoint", async () => {
    const api = mutableRouteApi();
    const applied = await runProductionPromotion({
      ...common(),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      createRouteImplementation: api.create,
      deleteRouteImplementation: api.delete,
      updateRouteImplementation: api.update,
      execute: true,
      inventoryImplementation: api.inventory,
    });
    let fail = true;
    const update = vi.fn((routeId: string, change: { pattern: string; script: string | null }) => {
      if (fail && change.pattern === "*.selinow.com/*" && change.script === null) {
        return Promise.reject(new Error("simulated_rollback_update_failure"));
      }
      return api.update(routeId, change);
    });
    await expect(runProductionPromotionRollback({
      ...common(),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      createRouteImplementation: api.create,
      deleteRouteImplementation: api.delete,
      updateRouteImplementation: update,
      execute: true,
      inventoryImplementation: api.inventory,
      state: applied.state as Record<string, unknown>,
    })).rejects.toThrow("production_promotion_rollback_failed");

    fail = false;
    const resumed = await runProductionPromotionRollback({
      ...common(),
      confirmFirstProductionBootstrap: true,
      confirmProduction: true,
      createRouteImplementation: api.create,
      deleteRouteImplementation: api.delete,
      updateRouteImplementation: update,
      execute: true,
      inventoryImplementation: api.inventory,
      state: applied.state as Record<string, unknown>,
    });
    expect(resumed.ok).toBe(true);
    expect(update).toHaveBeenCalledWith(
      "route-wild-0002",
      { pattern: "*.selinow.com/*", script: null },
    );
  });

  it("uses only per-route POST/PUT/ID-bound DELETE Cloudflare calls", async () => {
    const fetchImplementation = vi.fn((url: string, init?: RequestInit) => {
      void url;
      return Promise.resolve(new Response(JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: init?.method === "POST" ? { id: "route-created-999", pattern: "selinow.com/*", script: "selinow-com-production" } : true,
      }), { status: 200 }));
    });

    await createProductionPromotionRoute({
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      pattern: "selinow.com/*",
      script: "selinow-com-production",
      token: "redacted-token",
      zoneId: ZONE_ID,
    });
    await updateProductionPromotionRoute({
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      pattern: "*.selinow.com/*",
      routeId: "route-created-999",
      script: "selinow-com-production",
      token: "redacted-token",
      zoneId: ZONE_ID,
    });
    await deleteProductionPromotionRoute({
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      routeId: "route-created-999",
      token: "redacted-token",
      zoneId: ZONE_ID,
    });

    expect(fetchImplementation.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "PUT", "DELETE"]);
    expect(fetchImplementation.mock.calls[2]?.[0]).toContain("/workers/routes/route-created-999");
  });

  it("keeps the route token and unrelated operator credentials out of the audit Wrangler environment", () => {
    const child = buildProductionPromotionAuditEnvironment({
      PATH: "/bin",
      CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN: "audit-value",
      CLOUDFLARE_PRODUCTION_PROMOTION_ROUTE_API_TOKEN: "route-value",
      CLOUDFLARE_API_TOKEN: "runtime-value",
      CLOUDFLARE_OAUTH_TOKEN: "oauth-value",
    }, ACCOUNT_ID, "audit-value");
    expect(child).toMatchObject({
      CI: "1",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "audit-value",
      PATH: "/bin",
    });
    expect(child.CLOUDFLARE_PRODUCTION_PROMOTION_ROUTE_API_TOKEN).toBeUndefined();
    expect(child.CLOUDFLARE_OAUTH_TOKEN).toBeUndefined();
  });

  it("writes private promotion state with mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-production-promotion-"));
    const ref = await writeProductionPromotionReport(
      root,
      "bootstrap_20260730_reviewed",
      "applied",
      { ok: true },
    );
    const metadata = await stat(join(root, ref));
    expect(ref).toBe(".wrangler/bootstrap/bootstrap_20260730_reviewed/promotion-applied.json");
    expect(metadata.mode & 0o777).toBe(0o600);
  });
});
