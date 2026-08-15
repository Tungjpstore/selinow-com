/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await, prefer-const */

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyProductionContinuationRouteHandoff,
  buildProductionContinuationRoutePlan,
  discoverProductionContinuationRouteInventory,
  fingerprintProductionContinuationRoute,
  rollbackProductionContinuationRouteHandoff,
  writeProductionContinuationRouteState,
} from "../../scripts/lib/production-continuation-route.mjs";

const productionSpec = {
  accountId: "ef250a88911fd24073cb73d1c07e0218",
  environment: "production",
  resources: { d1: "selinow-production" },
  routing: {
    externalCustomDomainFallbackRoute: "*/*",
    externalCustomDomainStrategy: "production_fallback_with_platform_staging_exceptions",
    platformApexRoute: "selinow.com/*",
    platformStorefrontWildcard: "*.selinow.com/*",
  },
  workerName: "selinow-com-production",
  zoneId: "ce1536fca500680c544662e361ed869b",
  zoneName: "selinow.com",
};

const stagingSpec = {
  environment: "staging",
  stagingRouteExceptions: [
    "staging.selinow.com/*",
    "app-staging.selinow.com/*",
    "api-staging.selinow.com/*",
    "*.staging.selinow.com/*",
  ],
  workerName: "selinow-com-staging",
};

const database = {
  databaseId: "75102e37-45f6-40ed-a32a-9e700fd184db",
  databaseName: "selinow-production",
};

const releaseBinding = {
  candidateWorkerVersion: "11111111-1111-4111-8111-111111111111",
  commitSha: "1".repeat(40),
  manifestRef: ".wrangler/releases/rel_20260811T000000Z_111111111111/release-manifest.json",
  manifestSha256: "2".repeat(64),
  releaseId: "rel_20260811T000000Z_111111111111",
  treeSha: "3".repeat(40),
};

function inventory(overrides: Record<string, unknown> = {}) {
  const routes = [
    ["r-apex-0001", "selinow.com/*", "selinow-com-staging"],
    ["r-wild-0001", "*.selinow.com/*", "selinow-com-staging"],
    ["r-fall-0001", "*/*", "selinow-com-staging"],
    ["r-stg-0001", "staging.selinow.com/*", "selinow-com-staging"],
    ["r-stg-0002", "app-staging.selinow.com/*", "selinow-com-staging"],
    ["r-stg-0003", "api-staging.selinow.com/*", "selinow-com-staging"],
    ["r-stg-0004", "*.staging.selinow.com/*", "selinow-com-staging"],
  ].map(([id, pattern, script]) => ({ id, pattern, script }));
  return {
    accountId: productionSpec.accountId,
    activeWorkerVersion: releaseBinding.candidateWorkerVersion,
    ...database,
    routes,
    workerName: productionSpec.workerName,
    zoneId: productionSpec.zoneId,
    zoneName: productionSpec.zoneName,
    ...overrides,
  };
}

function plan() {
  return buildProductionContinuationRoutePlan({ database, inventory: inventory(), productionSpec, releaseBinding, stagingSpec });
}

describe("production continuation route handoff", () => {
  it("plans only the production-owned matrix and preserves staging exceptions", () => {
    const value = plan();
    expect(value.operations).toHaveLength(3);
    expect(value.operations.map((operation: { pattern: string }) => operation.pattern)).toEqual([
      "selinow.com/*", "*.selinow.com/*", "*/*",
    ]);
    expect(value.stagingExceptions).toEqual(stagingSpec.stagingRouteExceptions);
    expect(value.commitSha).toBe(releaseBinding.commitSha);
    expect(value.databaseId).toBe(database.databaseId);
    expect(value.fingerprints.planSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed on unknown routes and staging exception drift", () => {
    expect(() => buildProductionContinuationRoutePlan({
      database, inventory: inventory({ routes: [...inventory().routes, { id: "r-extra-0001", pattern: "evil.example/*", script: "selinow-com-staging" }] }), productionSpec, releaseBinding, stagingSpec,
    })).toThrow("production_continuation_route_unapproved");
    const drifted = inventory();
    const stagingRoute = drifted.routes[3];
    if (!stagingRoute) throw new Error("missing_staging_route_fixture");
    stagingRoute.script = "selinow-com-production";
    expect(() => buildProductionContinuationRoutePlan({ database, inventory: drifted, productionSpec, releaseBinding, stagingSpec })).toThrow("staging_exception_drift");
  });

  it("requires confirmation before invoking a route mutator", async () => {
    const calls: string[] = [];
    await expect(applyProductionContinuationRouteHandoff({
      confirmProduction: false,
      database,
      inventoryImplementation: async () => inventory(),
      plan: plan(),
      productionSpec,
      releaseBinding,
      stagingSpec,
      updateRouteImplementation: async () => { calls.push("update"); return {}; },
    })).rejects.toThrow("confirmation_required");
    expect(calls).toEqual([]);
  });

  it("applies, verifies, and writes a private state artifact", async () => {
    let current = inventory();
    const stateWrites: unknown[] = [];
    const result = await applyProductionContinuationRouteHandoff({
      confirmProduction: true,
      database,
      inventoryImplementation: async () => structuredClone(current),
      now: new Date("2026-08-11T00:00:00.000Z"),
      plan: plan(),
      productionSpec,
      releaseBinding,
      stagingSpec,
      updateRouteImplementation: async (routeId: string, route: { pattern: string; script: string }) => {
        current.routes = current.routes.map((candidate) => candidate.id === routeId ? { ...candidate, ...route } : candidate);
        return { id: routeId };
      },
      writeStateImplementation: async (state: unknown) => { stateWrites.push(state); return "state-ref"; },
    });
    expect(result.ok).toBe(true);
    expect(result.stateRef).toBe("state-ref");
    expect(stateWrites).toHaveLength(1);
    expect(current.routes.find((route) => route.pattern === "*/*")?.script).toBe(productionSpec.workerName);
    expect(result.state.stateSha256).toBe(fingerprintProductionContinuationRoute({ ...result.state, stateSha256: undefined }));
  });

  it("compensates already-applied changes after a later mutation failure", async () => {
    let current = inventory();
    let updates = 0;
    await expect(applyProductionContinuationRouteHandoff({
      confirmProduction: true,
      database,
      inventoryImplementation: async () => structuredClone(current),
      plan: plan(),
      productionSpec,
      releaseBinding,
      stagingSpec,
      updateRouteImplementation: async (routeId: string, route: { pattern: string; script: string }) => {
        updates += 1;
        if (updates === 2) throw new Error("simulated_failure");
        current.routes = current.routes.map((candidate) => candidate.id === routeId ? { ...candidate, ...route } : candidate);
        return { id: routeId };
      },
      deleteRouteImplementation: async () => undefined,
    })).rejects.toThrow("simulated_failure");
    expect(current.routes).toEqual(inventory().routes);
  });

  it("rolls back only when candidate, state bindings, and exact routes still match", async () => {
    let current = inventory();
    const applied = await applyProductionContinuationRouteHandoff({
      confirmProduction: true, database, inventoryImplementation: async () => structuredClone(current), plan: plan(), productionSpec, releaseBinding, stagingSpec,
      updateRouteImplementation: async (routeId: string, route: { pattern: string; script: string }) => { current.routes = current.routes.map((candidate) => candidate.id === routeId ? { ...candidate, ...route } : candidate); return { id: routeId }; },
      writeStateImplementation: async (state: unknown) => state,
    });
    const result = await rollbackProductionContinuationRouteHandoff({
      confirmProduction: true, database, inventoryImplementation: async () => structuredClone(current), productionSpec, releaseBinding, state: applied.state, stagingSpec,
      updateRouteImplementation: async (routeId: string, route: { pattern: string; script: string }) => { current.routes = current.routes.map((candidate) => candidate.id === routeId ? { ...candidate, ...route } : candidate); return { id: routeId }; },
      deleteRouteImplementation: async () => undefined,
      createRouteImplementation: async () => ({ id: "unused-route" }),
    });
    expect(result.ok).toBe(true);
    expect(current.routes).toEqual(inventory().routes);
    const drifted = structuredClone(current);
    const driftedRoute = drifted.routes[0];
    if (!driftedRoute) throw new Error("missing_drift_route_fixture");
    driftedRoute.script = "unreviewed-worker";
    await expect(rollbackProductionContinuationRouteHandoff({
      confirmProduction: true, database, inventoryImplementation: async () => drifted, productionSpec, releaseBinding, state: applied.state, stagingSpec,
      updateRouteImplementation: async () => ({ id: "r-apex-0001" }), deleteRouteImplementation: async () => undefined, createRouteImplementation: async () => ({ id: "unused-route" }),
    })).rejects.toThrow("rollback_drift");
  });

  it("writes state artifacts with owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-continuation-route-"));
    let current = inventory();
    const state = (await applyProductionContinuationRouteHandoff({
      confirmProduction: true, database, inventoryImplementation: async () => structuredClone(current), plan: plan(), productionSpec, releaseBinding, stagingSpec,
      updateRouteImplementation: async (routeId: string, route: { pattern: string; script: string }) => { current.routes = current.routes.map((candidate) => candidate.id === routeId ? { ...candidate, ...route } : candidate); return { id: routeId }; }, writeStateImplementation: async (value: unknown) => value,
    })).state;
    const path = await writeProductionContinuationRouteState(root, state);
    const file = await stat(join(root, path));
    expect(file.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(root, path), "utf8")).stateSha256).toBe(state.stateSha256);
  });

  it("persists a bound rollback state even when the route matrix is already exact", async () => {
    const exact = inventory();
    exact.routes = exact.routes.map((route) => stagingSpec.stagingRouteExceptions.includes(route.pattern ?? "")
      ? route
      : { ...route, script: productionSpec.workerName });
    const exactPlan = buildProductionContinuationRoutePlan({ database, inventory: exact, productionSpec, releaseBinding, stagingSpec });
    const writes: unknown[] = [];
    const applied = await applyProductionContinuationRouteHandoff({
      confirmProduction: true, database, inventoryImplementation: async () => structuredClone(exact), plan: exactPlan,
      productionSpec, releaseBinding, stagingSpec, writeStateImplementation: async (state: unknown) => { writes.push(state); return "no-op-state"; },
    });
    expect(applied.changes).toEqual([]);
    expect(applied.stateRef).toBe("no-op-state");
    expect(writes).toHaveLength(1);
    const rolledBack = await rollbackProductionContinuationRouteHandoff({
      confirmProduction: true, database, inventoryImplementation: async () => structuredClone(exact), productionSpec,
      releaseBinding, stagingSpec, state: applied.state,
    });
    expect(rolledBack.ok).toBe(true);
    expect(rolledBack.restoredRoutes).toEqual(exact.routes.sort((a, b) => (a.pattern ?? "").localeCompare(b.pattern ?? "")));
  });

  it("discovers the exact live 100% candidate deployment instead of trusting local state", async () => {
    const calls: string[] = [];
    const discovered = await discoverProductionContinuationRouteInventory({
      auditToken: "audit-token",
      database,
      fetchImplementation: async (request: RequestInfo | URL) => {
        const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
        calls.push(url);
        const result = url.endsWith("/deployments")
          ? { deployments: [{ created_on: "2026-08-11T00:00:00.000Z", versions: [{ percentage: 100, version_id: releaseBinding.candidateWorkerVersion }] }] }
          : inventory().routes;
        return new Response(JSON.stringify({ result, success: true }), { headers: { "content-type": "application/json" } });
      },
      productionSpec,
    });
    expect(discovered.activeWorkerVersion).toBe(releaseBinding.candidateWorkerVersion);
    expect(calls.some((url) => url.endsWith("/deployments"))).toBe(true);
  });
});
