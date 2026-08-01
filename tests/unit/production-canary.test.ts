/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  buildCanaryBuildEnvironment,
  buildCanaryWranglerEnvironment,
  assertProductionCanaryDnsAdmission,
  assertProductionCanaryStaticIdentity,
  createProductionCanaryRoute,
  deleteProductionCanaryRoute,
  discoverProductionCanaryInventory,
  isFirstProductionPlaceholderVersionView,
  requireCanaryAuditToken,
  requireCanaryRouteToken,
  requireCanaryWorkerToken,
  resolveProductionCanaryDns,
  runProductionCanaryApply,
  runProductionCanaryRollback,
  runProductionCanaryUpload,
  validateCandidateVersionView,
  validateProductionCanaryPlan,
} from "../../scripts/lib/production-canary.mjs";
import { REQUIRED_PRODUCTION_VARS, REQUIRED_WORKER_SECRET_NAMES } from "../../scripts/lib/release.mjs";

const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const ZONE_ID = "1234567890abcdef1234567890abcdef";
const STAGING_WORKER_NAME = "selinow-com-staging";
const DATABASE_ID = "17ea8f2f-4c97-4337-8989-28b25a58ddeb";
const CONTROL_VERSION = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_VERSION = "22222222-2222-4222-8222-222222222222";
const OTHER_VERSION = "33333333-3333-4333-8333-333333333333";
const CONTROL_DEPLOYMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CANDIDATE_DEPLOYMENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROUTE_ID = "canary-route-001";
const NOW = new Date("2026-07-30T04:00:00.000Z");
const MIGRATIONS = ["0001_platform.sql", "0002_orders.sql"];
const PLATFORM_CACHE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
type TestRoute = { id: string; pattern: string; script: string | null };

const productionSpec = {
  accountId: ACCOUNT_ID,
  bootstrap: {
    canaryHostname: "canary.selinow.com",
    firstVersionRollback: "restore_pre_bootstrap_traffic_inventory",
    promotionStrategy: "canary_then_stable_domains",
  },
  environment: "production",
  hostnames: { api: "api.selinow.com", dashboard: "app.selinow.com", marketing: "selinow.com" },
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
    externalCustomDomainStrategy: "production_fallback_with_platform_staging_exceptions",
    platformApexRoute: "selinow.com/*",
    platformStorefrontWildcard: "*.selinow.com/*",
    routeHandoff: "atomic_shared_zone_route_replacement",
    stagingExternalCustomDomainInventory: "pending_inventory",
    stagingRouteExceptions: ["staging.selinow.com/*", "*.staging.selinow.com/*"],
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

const productionVars = Object.fromEntries(REQUIRED_PRODUCTION_VARS.map((name) => [name, `value-${name.toLowerCase()}`]));
const generatedManifest = {
  accountId: ACCOUNT_ID,
  environment: "production",
  resources: {
    d1: { id: DATABASE_ID, name: productionSpec.resources.d1 },
    platformCacheKv: { id: PLATFORM_CACHE_ID, name: productionSpec.resources.platformCacheKv },
    sessionKv: { id: SESSION_ID, name: productionSpec.resources.sessionKv },
  },
  workerName: productionSpec.workerName,
  zoneId: ZONE_ID,
  zoneName: productionSpec.zoneName,
};
const wranglerConfig = {
  env: {
    production: {
      name: productionSpec.workerName,
      preview_urls: false,
      send_email: [{ name: "EMAIL", allowed_sender_addresses: ["no-reply@selinow.com"] }],
      vars: productionVars,
    },
  },
};

const repositoryState = {
  clean: true,
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalize(nested)]));
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function routeSnapshot(routes = baseRoutes()) {
  return routes.map(({ pattern, script }) => ({ pattern, script }));
}

function sortedRouteSnapshot(routes = baseRoutes()) {
  return routeSnapshot(routes).sort((left, right) => left.pattern.localeCompare(right.pattern));
}

function sortedRoutes(routes = baseRoutes()) {
  return routes.map((route) => ({ ...route })).sort((left, right) => left.pattern.localeCompare(right.pattern));
}

function baseRoutes(): TestRoute[] {
  return [
    { id: "route-apex-001", pattern: "selinow.com/*", script: null },
    { id: "route-wild-001", pattern: "*.selinow.com/*", script: null },
  ];
}

function validEvidence(overrides: Record<string, unknown> = {}) {
  return {
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
    ceremonyId: "bootstrap_20260730_reviewed",
    canary: { accepted: false },
    environment: "production",
    migrations: { appliedAt: "2026-07-30T02:00:00.000Z", direction: "forward_only", names: MIGRATIONS },
    phase: "canary",
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
    ...overrides,
  };
}

function version(id: string, metadata: Record<string, unknown> = {}) {
  return { id, metadata, annotations: {}, number: null };
}

function inventory(options: {
  activeVersionId?: string;
  routes?: ReturnType<typeof baseRoutes>;
  domains?: Array<Record<string, unknown>>;
  schedules?: Array<{ cron: string }>;
  queueConsumers?: Array<{ queueName: string; consumers: unknown[] }>;
  secretNames?: string[];
  workerSubdomain?: Record<string, unknown>;
  versions?: Array<Record<string, unknown>>;
  deployments?: Array<Record<string, unknown>>;
} = {}) {
  const activeVersionId = options.activeVersionId ?? CONTROL_VERSION;
  const versions = options.versions ?? [version(CONTROL_VERSION)];
  return {
    accountId: ACCOUNT_ID,
    databaseId: DATABASE_ID,
    databaseName: productionSpec.resources.d1,
    deployments: options.deployments ?? [{ created_on: "2026-07-30T03:00:00.000Z", id: activeVersionId === CANDIDATE_VERSION ? CANDIDATE_DEPLOYMENT : CONTROL_DEPLOYMENT, versions: [{ percentage: 100, version_id: activeVersionId }] }],
    domains: options.domains ?? [],
    observedAt: NOW.toISOString(),
    queueConsumers: options.queueConsumers ?? [
      { queueName: productionSpec.resources.integrationQueue, consumers: [] },
      { queueName: productionSpec.resources.notificationQueue, consumers: [] },
      { queueName: productionSpec.resources.deadLetterQueue, consumers: [] },
    ],
    routes: options.routes ?? baseRoutes(),
    schedules: options.schedules ?? [],
    secretNames: options.secretNames ?? [...REQUIRED_WORKER_SECRET_NAMES],
    versions,
    workerName: productionSpec.workerName,
    workerSubdomain: options.workerSubdomain ?? { enabled: false, previews_enabled: false },
    zoneId: ZONE_ID,
    zoneName: productionSpec.zoneName,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  const values = {
    confirmFirstProductionBootstrap: true,
    confirmProduction: true,
    databaseId: DATABASE_ID,
    evidence: validEvidence(),
    execute: false,
    generatedManifest,
    migrationNames: MIGRATIONS,
    now: NOW,
    productionSpec,
    repositoryState,
    stagingWorkerName: STAGING_WORKER_NAME,
    tag: "canary-20260730",
    trafficSnapshot: { domains: [], routes: routeSnapshot() },
    dnsAdmissionImplementation: async (hostname: string) => ({ hostname, addresses: ["104.16.0.1"] }),
    inventoryImplementation: async () => inventory(),
    wranglerConfig,
    ...overrides,
  };
  return {
    ...values,
    plan: overrides.plan ?? canaryPlan({
      evidence: values.evidence,
      productionSpec: values.productionSpec,
      repositoryState: values.repositoryState,
      trafficSnapshot: values.trafficSnapshot,
    }),
  };
}

function canaryPlan(values: {
  evidence?: ReturnType<typeof validEvidence>;
  productionSpec?: typeof productionSpec;
  repositoryState?: typeof repositoryState;
  trafficSnapshot?: unknown;
} = {}) {
  const evidence = values.evidence ?? validEvidence();
  const trafficSnapshot = values.trafficSnapshot ?? { domains: [], routes: routeSnapshot() };
  const source = values.repositoryState ?? repositoryState;
  const spec = values.productionSpec ?? productionSpec;
  return {
    actions: [
      { action: "upload", code: "worker.candidate_canary_only" },
      { action: "create", code: "traffic.canary_route", pattern: spec.routing.canaryOverrideRoute, script: spec.workerName },
    ],
    ceremonyId: evidence.ceremonyId,
    environment: "production",
    fingerprints: {
      evidenceSha256: fingerprint({ ...evidence, candidateWorkerVersion: null }),
      inventorySha256: fingerprint(trafficSnapshot),
      sourceSha256: fingerprint(source),
      specSha256: fingerprint(spec),
    },
    phase: "canary",
    safeguards: { allowedMutations: ["production_candidate_worker_version", "production_canary_worker_route"] },
    schemaVersion: 1,
  };
}

type CandidateBinding = { name: string } & Record<string, unknown>;

function completeBindings(): CandidateBinding[] {
  return [
    ...REQUIRED_PRODUCTION_VARS.map((name) => ({ name, text: productionVars[name], type: "plain_text" })),
    ...REQUIRED_WORKER_SECRET_NAMES.map((name) => ({ name, type: "secret_text" })),
    { name: "ASSETS", type: "assets" },
    { name: "EMAIL", type: "send_email", allowed_sender_addresses: ["no-reply@selinow.com"] },
    { name: "INTEGRATION_QUEUE", type: "queue", queue_name: productionSpec.resources.integrationQueue },
    { name: "MEDIA", type: "r2_bucket", bucket_name: productionSpec.resources.r2 },
    { name: "NOTIFICATION_QUEUE", type: "queue", queue_name: productionSpec.resources.notificationQueue },
    { name: "PLATFORM_CACHE", type: "kv_namespace", namespace_id: PLATFORM_CACHE_ID },
    { name: "PLATFORM_DB", type: "d1", database_id: DATABASE_ID, id: DATABASE_ID },
    { name: "PRIVATE_EXPORTS", type: "r2_bucket", bucket_name: productionSpec.resources.privateExports },
    { name: "SESSION", type: "kv_namespace", namespace_id: SESSION_ID },
  ];
}

function candidateView(bindings: CandidateBinding[] = completeBindings()) {
  return {
    id: CANDIDATE_VERSION,
    metadata: { has_preview: false },
    resources: { bindings, script: { handlers: ["fetch", "queue", "scheduled"] } },
  };
}

describe("production canary token boundaries", () => {
  it("requires dedicated operator tokens without exposing values", () => {
    const environment = {
      CLOUDFLARE_CANARY_AUDIT_API_TOKEN: "audit-secret-value",
      CLOUDFLARE_CANARY_ROUTE_API_TOKEN: "route-secret-value",
      CLOUDFLARE_CANARY_WORKER_API_TOKEN: "worker-secret-value",
    } as NodeJS.ProcessEnv;
    expect(requireCanaryAuditToken(environment)).toBe("audit-secret-value");
    expect(requireCanaryRouteToken(environment)).toBe("route-secret-value");
    expect(requireCanaryWorkerToken(environment)).toBe("worker-secret-value");
    expect(() => requireCanaryAuditToken({})).toThrow("cloudflare_canary_audit_api_token_missing");
    expect(() => requireCanaryRouteToken({})).toThrow("cloudflare_canary_route_api_token_missing");
    expect(() => requireCanaryWorkerToken({})).toThrow("cloudflare_canary_worker_api_token_missing");
  });

  it("strips every Cloudflare and dedicated canary token from child build environments", () => {
    const environment = {
      CLOUDFLARE_API_TOKEN: "app-token",
      CLOUDFLARE_OAUTH_TOKEN: "oauth-token",
      CLOUDFLARE_PLATFORM_API_TOKEN: "platform-token",
      CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-audit-token",
      CLOUDFLARE_RELEASE_WORKER_API_TOKEN: "release-worker-token",
      CLOUDFLARE_CANARY_AUDIT_API_TOKEN: "audit-token",
      CLOUDFLARE_CANARY_ROUTE_API_TOKEN: "route-token",
      CLOUDFLARE_CANARY_WORKER_API_TOKEN: "worker-token",
      CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN: "bootstrap-token",
      CLOUDFLARE_PRODUCTION_EMPTY_BASELINE_API_TOKEN: "baseline-token",
      CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN: "promotion-audit-token",
      CLOUDFLARE_PRODUCTION_PROMOTION_ROUTE_API_TOKEN: "promotion-route-token",
    } as NodeJS.ProcessEnv;
    const child = buildCanaryBuildEnvironment(environment);
    for (const key of Object.keys(environment)) expect(child[key]).toBeUndefined();
    expect(child.CLOUDFLARE_ENV).toBe("production");
    const wrangler = buildCanaryWranglerEnvironment(environment, ACCOUNT_ID, "worker-token");
    expect(wrangler.CLOUDFLARE_API_TOKEN).toBe("worker-token");
    expect(wrangler.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT_ID);
    expect(wrangler.CLOUDFLARE_CANARY_WORKER_API_TOKEN).toBeUndefined();
    expect(wrangler.CLOUDFLARE_RELEASE_WORKER_API_TOKEN).toBeUndefined();
    expect(JSON.stringify(wrangler)).not.toContain("audit-token");
    expect(JSON.stringify(wrangler)).not.toContain("release-worker-token");
  });
});

describe("production canary static admission", () => {
  it("pins the canonical spec, manifest, and reviewed canary plan", () => {
    expect(() => {
      assertProductionCanaryStaticIdentity({
      canonicalGeneratedManifest: generatedManifest,
      canonicalProductionSpec: productionSpec,
      generatedManifest,
      productionSpec,
      });
    }).not.toThrow();
    expect(() => {
      assertProductionCanaryStaticIdentity({
      canonicalGeneratedManifest: generatedManifest,
      canonicalProductionSpec: productionSpec,
      generatedManifest: { ...generatedManifest, zoneName: "wrong.example" },
      productionSpec,
      });
    }).toThrow("production_canary_manifest_identity_mismatch");

    const plan = canaryPlan();
    const values = input({ plan });
    expect(validateProductionCanaryPlan(values)).toBe(fingerprint(plan));
    expect(() => validateProductionCanaryPlan({
      ...values,
      plan: {
        ...plan,
        actions: plan.actions.map((action) => action.code === "traffic.canary_route"
          ? { ...action, pattern: "wrong.selinow.com/*" }
          : action),
      },
    })).toThrow("production_canary_plan_invalid");

    expect(() => validateProductionCanaryPlan({
      ...values,
      evidence: validEvidence({
        backup: { ...validEvidence().backup, snapshotReportRef: "private/backup/drifted.json" },
      }),
    })).toThrow("production_canary_plan_invalid");
  });
});

describe("production canary candidate binding contract", () => {
  it("admits a first-bootstrap control version containing only the required secrets", () => {
    const placeholder = {
      bindings: null,
      resources: {
        assets: null,
        bindings: REQUIRED_WORKER_SECRET_NAMES.map((name) => ({ name, type: "secret_text" })),
      },
    };
    expect(isFirstProductionPlaceholderVersionView(placeholder)).toBe(true);
    expect(isFirstProductionPlaceholderVersionView({
      resources: { bindings: placeholder.resources.bindings },
    })).toBe(true);
    expect(isFirstProductionPlaceholderVersionView({
      ...placeholder,
      resources: { ...placeholder.resources, assets: { config: {} } },
    })).toBe(false);
    expect(isFirstProductionPlaceholderVersionView({
      ...placeholder,
      bindings: [],
    })).toBe(false);
    expect(isFirstProductionPlaceholderVersionView({
      ...placeholder,
      resources: { ...placeholder.resources, bindings: placeholder.resources.bindings.slice(1) },
    })).toBe(false);
    expect(isFirstProductionPlaceholderVersionView({
      ...placeholder,
      resources: {
        ...placeholder.resources,
        bindings: [...placeholder.resources.bindings, { name: "PLATFORM_DB", type: "d1" }],
      },
    })).toBe(false);
  });

  const contract = { generatedManifest, productionSpec, wranglerConfig };

  function replaceBinding(name: string, patch: Record<string, unknown>) {
    return completeBindings().map((binding) => binding.name === name ? { ...binding, ...patch } : binding);
  }

  it("requires exact binding types, IDs, resource names, and plain variable values", () => {
    expect(validateCandidateVersionView(candidateView(), CANDIDATE_VERSION, contract)).toContain("PLATFORM_DB");
    expect(() => validateCandidateVersionView(candidateView(), CANDIDATE_VERSION, {
      ...contract,
      wranglerConfig: {
        ...wranglerConfig,
        env: { production: { ...wranglerConfig.env.production, preview_urls: true } },
      },
    })).toThrow("production_canary_candidate_contract_invalid");
    expect(() => validateCandidateVersionView(
      candidateView(replaceBinding("MEDIA", { type: "kv_namespace" })),
      CANDIDATE_VERSION,
      contract,
    )).toThrow("production_canary_candidate_binding_mismatch:MEDIA:type");
    expect(() => validateCandidateVersionView(
      candidateView(replaceBinding("PLATFORM_DB", { database_id: OTHER_VERSION })),
      CANDIDATE_VERSION,
      contract,
    )).toThrow("production_canary_candidate_binding_mismatch:PLATFORM_DB:database_id");
    expect(() => validateCandidateVersionView(
      candidateView(replaceBinding("INTEGRATION_QUEUE", { queue_name: "wrong-production-queue" })),
      CANDIDATE_VERSION,
      contract,
    )).toThrow("production_canary_candidate_binding_mismatch:INTEGRATION_QUEUE:queue_name");
    expect(() => validateCandidateVersionView(
      candidateView(replaceBinding("APP_ENV", { text: "staging" })),
      CANDIDATE_VERSION,
      contract,
    )).toThrow("production_canary_candidate_binding_mismatch:APP_ENV:text");
  });

  it("rejects invalid static identity, handlers, duplicate, and unexpected bindings", () => {
    expect(() => validateCandidateVersionView(candidateView(), CANDIDATE_VERSION, {
      ...contract,
      generatedManifest: { ...generatedManifest, workerName: "different-worker" },
    })).toThrow("production_canary_candidate_contract_invalid");
    expect(() => validateCandidateVersionView(
      { ...candidateView(), metadata: { has_preview: true } },
      CANDIDATE_VERSION,
      contract,
    )).not.toThrow();
    expect(() => validateCandidateVersionView(
      { ...candidateView(), resources: { bindings: completeBindings(), script: { handlers: ["scheduled"] } } },
      CANDIDATE_VERSION,
      contract,
    )).toThrow("production_canary_candidate_view_invalid");
    expect(() => validateCandidateVersionView(
      candidateView([...completeBindings(), { name: "APP_ENV", type: "plain_text", text: productionVars.APP_ENV }]),
      CANDIDATE_VERSION,
      contract,
    )).toThrow("production_canary_candidate_binding_inventory_invalid");
    expect(() => validateCandidateVersionView(
      candidateView([...completeBindings(), { name: "UNPLANNED", type: "plain_text", text: "value" }]),
      CANDIDATE_VERSION,
      contract,
    )).toThrow("production_canary_candidate_binding_unexpected:UNPLANNED");
  });
});

describe("production canary live inventory", () => {
  it("admits an absent canary carrier or the exact staging-bound carrier", async () => {
    const carrier = {
      hostname: productionSpec.bootstrap.canaryHostname,
      service: STAGING_WORKER_NAME,
      zone_id: ZONE_ID,
    };
    await expect(runProductionCanaryUpload(input({
      inventoryImplementation: async () => inventory({ domains: [carrier] }),
      trafficSnapshot: { domains: [carrier], routes: routeSnapshot() },
    }))).resolves.toMatchObject({ executed: false, ok: true });

    for (const service of [productionSpec.workerName, "unapproved-worker"]) {
      const wrongCarrier = { ...carrier, service };
      await expect(runProductionCanaryUpload(input({
        inventoryImplementation: async () => inventory({ domains: [wrongCarrier] }),
        trafficSnapshot: { domains: [wrongCarrier], routes: routeSnapshot() },
      }))).rejects.toThrow(`production_canary_dns_carrier_drift:${carrier.hostname}`);
    }
  });

  it("checks account, D1, and secrets before mutable inventory commands and unwraps schedules", async () => {
    const commands: string[][] = [];
    const fetchCalls: Array<{ url: string; method: string; authorization: string }> = [];
    const runner = (args: string[]) => {
      commands.push(args);
      const joined = args.join(" ");
      if (joined.startsWith("whoami")) return { stderr: "", stdout: `Account ID: ${ACCOUNT_ID}` };
      if (joined.startsWith("d1 list")) return { stderr: "", stdout: JSON.stringify([{ name: "selinow-production", uuid: DATABASE_ID }]) };
      if (joined.startsWith("secret list")) return { stderr: "", stdout: JSON.stringify(REQUIRED_WORKER_SECRET_NAMES.map((name) => ({ name }))) };
      if (joined.startsWith("versions list")) return { stderr: "", stdout: JSON.stringify([version(CONTROL_VERSION)]) };
      return { stderr: "", stdout: "[]" };
    };
    const fetchImplementation = async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const requestOptions = options ?? {};
      fetchCalls.push({ url, method: requestOptions.method ?? "GET", authorization: String(new Headers(requestOptions.headers).get("authorization")) });
      const result = url.endsWith("/routes")
        ? baseRoutes()
        : url.endsWith("/domains")
          ? []
        : url.endsWith("/schedules")
          ? { schedules: [] }
          : url.endsWith("/subdomain")
            ? { enabled: false, previews_enabled: false }
          : { deployments: inventory().deployments };
      return new Response(JSON.stringify({ success: true, result }), { headers: { "content-type": "application/json" } });
    };
    const discovered = await discoverProductionCanaryInventory({
      auditToken: "audit-token",
      commandEnvironment: { PATH: "/bin" },
      databaseId: DATABASE_ID,
      fetchImplementation,
      now: NOW,
      productionSpec,
      repositoryRoot: process.cwd(),
      runWranglerImplementation: runner,
    });
    expect(discovered.schedules).toEqual([]);
    expect(discovered.workerSubdomain).toEqual({ enabled: false, previewsEnabled: false });
    await expect(runProductionCanaryUpload(input({
      inventoryImplementation: async () => discovered,
      trafficSnapshot: { domains: discovered.domains, routes: routeSnapshot(discovered.routes) },
    }))).resolves.toMatchObject({ executed: false, ok: true });
    expect(commands.slice(0, 3).map((args) => args.slice(0, 2).join(" "))).toEqual(["whoami --json", "d1 list", "secret list"]);
    expect(commands.findIndex((args) => args[0] === "versions")).toBeGreaterThanOrEqual(3);
    expect(fetchCalls).toHaveLength(5);
    expect(fetchCalls.every((call) => call.method === "GET" && call.authorization === "Bearer audit-token")).toBe(true);
    expect(fetchCalls.map((call) => call.url)).toEqual(expect.arrayContaining([
      `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/workers/routes`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/domains`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${productionSpec.workerName}/schedules`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${productionSpec.workerName}/deployments`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${productionSpec.workerName}/subdomain`,
    ]));
  });

  it("fails closed for account, database, secret, route, domain, and trigger drift", async () => {
    const valid = inventory();
    const invoke = (override: Record<string, unknown>) => runProductionCanaryUpload(input({
      inventoryImplementation: async () => ({ ...valid, ...override }),
    }));
    await expect(invoke({ accountId: "ffffffffffffffffffffffffffffffff" })).rejects.toThrow("production_canary_target_identity_mismatch");
    await expect(invoke({ databaseId: "27ea8f2f-4c97-4337-8989-28b25a58ddeb" })).rejects.toThrow("production_canary_target_identity_mismatch");
    await expect(invoke({ secretNames: REQUIRED_WORKER_SECRET_NAMES.slice(1) })).rejects.toThrow("production_canary_worker_secret_missing");
    const routePresent = [...valid.routes, { id: "prod-route-001", pattern: "canary.selinow.com/*", script: "selinow-com-production" }];
    await expect(runProductionCanaryUpload(input({
      inventoryImplementation: async () => ({ ...valid, routes: routePresent }),
      trafficSnapshot: { domains: [], routes: routeSnapshot(routePresent) },
    }))).rejects.toThrow("production_canary_existing_worker_route");
    const domainPresent = [{ hostname: "selinow.com", service: "selinow-com-production", zone_id: ZONE_ID }];
    await expect(runProductionCanaryUpload(input({
      inventoryImplementation: async () => ({ ...valid, domains: domainPresent }),
      trafficSnapshot: { domains: domainPresent, routes: routeSnapshot() },
    }))).rejects.toThrow("production_canary_existing_worker_domain");
    await expect(invoke({ schedules: [{ cron: "*/5 * * * *" }] })).rejects.toThrow("production_canary_cron_trigger_present");
    await expect(invoke({ queueConsumers: [{ queueName: productionSpec.resources.integrationQueue, consumers: [{ id: "consumer" }] }, ...valid.queueConsumers.slice(1)] })).rejects.toThrow("production_canary_queue_consumer_present");
    await expect(invoke({ workerSubdomain: { enabled: true, previews_enabled: false } })).rejects.toThrow("production_canary_worker_subdomain_enabled");
    await expect(invoke({ workerSubdomain: { enabled: false, previews_enabled: true } })).rejects.toThrow("production_canary_worker_subdomain_enabled");
    await expect(invoke({ workerSubdomain: { enabled: false } })).rejects.toThrow("production_canary_worker_subdomain_inventory_invalid");
  });
});

describe("production canary DNS admission", () => {
  it("accepts only the configured hostname with Cloudflare anycast addresses", () => {
    expect(assertProductionCanaryDnsAdmission({
      addresses: ["104.16.0.1", "2606:4700::1"],
      hostname: "canary.selinow.com",
    }, productionSpec)).toEqual({
      addresses: ["104.16.0.1", "2606:4700::1"],
      hostname: "canary.selinow.com",
    });
    expect(() => assertProductionCanaryDnsAdmission({
      addresses: ["192.0.2.1"],
      hostname: "canary.selinow.com",
    }, productionSpec)).toThrow("production_canary_dns_admission_invalid");
    expect(() => assertProductionCanaryDnsAdmission({
      addresses: ["104.16.0.1"],
      hostname: "other.selinow.com",
    }, productionSpec)).toThrow("production_canary_dns_admission_invalid");
  });

  it("fails closed when DNS has no answer or returns a non-Cloudflare address", async () => {
    const noAnswer = async () => {
      const error = new Error("not found");
      Object.assign(error, { code: "ENOTFOUND" });
      throw error;
    };
    await expect(resolveProductionCanaryDns({
      hostname: "canary.selinow.com.",
      resolve4Implementation: async () => ["104.16.0.1"],
      resolve6Implementation: async () => ["2606:4700::1"],
    })).resolves.toEqual({
      addresses: ["104.16.0.1", "2606:4700::1"],
      hostname: "canary.selinow.com",
    });
    await expect(resolveProductionCanaryDns({
      hostname: "canary.selinow.com",
      resolve4Implementation: noAnswer,
      resolve6Implementation: noAnswer,
    })).rejects.toThrow("production_canary_dns_unresolved");
    await expect(resolveProductionCanaryDns({
      hostname: "canary.selinow.com",
      resolve4Implementation: async () => ["192.0.2.1"],
      resolve6Implementation: noAnswer,
    })).rejects.toThrow("production_canary_dns_not_cloudflare");
  });

  it("normalizes IPv4-mapped IPv6 answers and validates public DoH payloads", async () => {
    await expect(resolveProductionCanaryDns({
      hostname: "canary.selinow.com",
      resolve4Implementation: async () => [],
      resolve6Implementation: async () => ["::ffff:104.16.0.1"],
    })).resolves.toEqual({ addresses: ["104.16.0.1"], hostname: "canary.selinow.com" });

    const fetchImplementation = vi.fn(async (request: RequestInfo | URL) => {
      const requestUrl = typeof request === "string"
        ? request
        : request instanceof URL
          ? request.href
          : request.url;
      const url = new URL(requestUrl);
      const type = url.searchParams.get("type");
      const answer = type === "A"
        ? { type: 1, data: "104.16.0.1" }
        : { type: 28, data: "2606:4700::1" };
      return new Response(JSON.stringify({ Status: 0, Answer: [answer] }), {
        headers: { "content-type": "application/dns-json" },
      });
    });
    await expect(resolveProductionCanaryDns({ hostname: "canary.selinow.com", fetchImplementation })).resolves.toEqual({
      addresses: ["104.16.0.1", "2606:4700::1"],
      hostname: "canary.selinow.com",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(4);

    const malformedFetch = async () => new Response(JSON.stringify({ Status: 0, Answer: "not-an-array" }));
    await expect(resolveProductionCanaryDns({ hostname: "canary.selinow.com", fetchImplementation: malformedFetch }))
      .rejects.toThrow("production_canary_dns_lookup_invalid");
  });

});

describe("production canary upload", () => {
  it("has a no-mutation dry-run and never needs a runner or fetch", async () => {
    const inventoryImplementation = vi.fn(async () => inventory());
    const buildImplementation = vi.fn();
    const uploadImplementation = vi.fn();
    const result = await runProductionCanaryUpload(input({ inventoryImplementation, buildImplementation, uploadImplementation }));
    expect(result).toMatchObject({ executed: false, ok: true });
    expect(inventoryImplementation).toHaveBeenCalledOnce();
    expect(buildImplementation).not.toHaveBeenCalled();
    expect(uploadImplementation).not.toHaveBeenCalled();
  });

  it("captures exactly one candidate and validates all bindings while treating version preview metadata as informational", async () => {
    const before = inventory();
    const after = inventory({ versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: false })] });
    let index = 0;
    const result = await runProductionCanaryUpload(input({
      execute: true,
      buildImplementation: vi.fn(async () => {}),
      uploadImplementation: vi.fn(async () => {}),
      inventoryImplementation: vi.fn(async () => [before, before, after][index++]),
      versionViewImplementation: vi.fn(async () => candidateView()),
      writeReportImplementation: vi.fn(async () => "report.json"),
      tag: "canary-20260730",
    }));
    expect(result.candidateVersionId).toBe(CANDIDATE_VERSION);
    expect(result.report.bindingNames).toContain("PLATFORM_DB");

    const preview = inventory({ versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: true })] });
    index = 0;
    const previewResult = await runProductionCanaryUpload(input({
      execute: true,
      buildImplementation: async () => {},
      uploadImplementation: async () => {},
      inventoryImplementation: async () => [before, before, preview][index++],
      versionViewImplementation: async () => candidateView(),
      writeReportImplementation: async () => "preview-report.json",
      tag: "canary-20260730",
    }));
    expect(previewResult.report.candidateHasPreview).toBe(true);

    const metadataMissing = inventory({ versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION)] });
    index = 0;
    const metadataMissingResult = await runProductionCanaryUpload(input({
      execute: true,
      buildImplementation: async () => {},
      uploadImplementation: async () => {},
      inventoryImplementation: async () => [before, before, metadataMissing][index++],
      versionViewImplementation: async () => ({ ...candidateView(), metadata: {} }),
      writeReportImplementation: async () => "metadata-missing-report.json",
      tag: "canary-20260730",
    }));
    expect(metadataMissingResult.report.candidateHasPreview).toBe(null);

    index = 0;
    await expect(runProductionCanaryUpload(input({
      execute: true,
      buildImplementation: async () => {},
      uploadImplementation: async () => {},
      inventoryImplementation: async () => [before, before, after][index++],
      versionViewImplementation: async () => candidateView(completeBindings().slice(1)),
      tag: "canary-20260730",
    }))).rejects.toThrow("production_canary_candidate_binding_missing");

    index = 0;
    const twoCandidates = inventory({ versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: false }), version(OTHER_VERSION, { has_preview: false })] });
    await expect(runProductionCanaryUpload(input({
      execute: true,
      buildImplementation: async () => {},
      uploadImplementation: async () => {},
      inventoryImplementation: async () => [before, before, twoCandidates][index++],
      versionViewImplementation: async () => candidateView(),
      tag: "canary-20260730",
    }))).rejects.toThrow("production_canary_candidate_capture_invalid");
  });

  it("fails closed if the Worker subdomain or preview setting changes during upload", async () => {
    const before = inventory();
    for (const workerSubdomain of [
      { enabled: true, previews_enabled: false },
      { enabled: false, previews_enabled: true },
    ]) {
      const changed = inventory({
        versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: true })],
        workerSubdomain,
      });
      let index = 0;
      await expect(runProductionCanaryUpload(input({
        execute: true,
        buildImplementation: async () => {},
        uploadImplementation: async () => {},
        inventoryImplementation: async () => [before, before, changed][index++],
        versionViewImplementation: async () => candidateView(),
        writeReportImplementation: vi.fn(),
      }))).rejects.toThrow("production_canary_worker_subdomain_enabled");
    }
  });

  it("advances from reviewed null-candidate evidence to candidate-bound apply evidence", async () => {
    const before = inventory();
    const withCandidate = inventory({
      versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: false })],
    });
    const preUploadEvidence = validEvidence();
    let index = 0;
    const upload = await runProductionCanaryUpload(input({
      evidence: preUploadEvidence,
      execute: true,
      buildImplementation: async () => {},
      uploadImplementation: async () => {},
      inventoryImplementation: async () => [before, before, withCandidate][index++],
      versionViewImplementation: async () => candidateView(),
      writeReportImplementation: async () => "upload-report.json",
    }));

    expect(upload.evidencePatch).toEqual({ candidateWorkerVersion: CANDIDATE_VERSION });
    const applyInventory = vi.fn(async () => withCandidate);
    await expect(runProductionCanaryApply(input({
      evidence: preUploadEvidence,
      uploadReport: upload.report,
      inventoryImplementation: applyInventory,
    }))).rejects.toThrow("production_canary_upload_report_invalid");
    expect(applyInventory).not.toHaveBeenCalled();

    const postUploadEvidence = { ...preUploadEvidence, ...upload.evidencePatch };
    await expect(runProductionCanaryApply(input({
      evidence: postUploadEvidence,
      uploadReport: upload.report,
      inventoryImplementation: async () => withCandidate,
    }))).resolves.toMatchObject({ executed: false, ok: true });

    const rejectedUploadInventory = vi.fn(async () => withCandidate);
    await expect(runProductionCanaryUpload(input({
      evidence: postUploadEvidence,
      inventoryImplementation: rejectedUploadInventory,
    }))).rejects.toThrow("production_canary_upload_evidence_incomplete");
    expect(rejectedUploadInventory).not.toHaveBeenCalled();
  });

  it("keeps the upload command route-neutral and forbids deploy/triggers", () => {
    const source = readFileSync("scripts/production-bootstrap-canary.mjs", "utf8");
    expect(source).toContain('"versions",\n            "upload"');
    expect(source).toContain('"--strict"');
    expect(source).toContain('"--tag"');
    expect(source).toContain('"--message"');
    expect(source).not.toContain('"triggers", "deploy"');
    expect(source).not.toMatch(/\bwrangler\s+deploy\b/u);
  });
});

describe("production canary apply and rollback", () => {
  async function uploadReport() {
    const before = inventory();
    const after = inventory({ versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: false })] });
    let index = 0;
    const result = await runProductionCanaryUpload(input({
      execute: true,
      buildImplementation: async () => {},
      uploadImplementation: async () => {},
      inventoryImplementation: async () => [before, before, after][index++],
      versionViewImplementation: async () => candidateView(),
      writeReportImplementation: async () => "upload-report.json",
      tag: "canary-20260730",
    }));
    return result.report;
  }

  it("deploys the candidate before creating exactly one canary route", async () => {
    const report = await uploadReport();
    const initial = inventory({ versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: false })] });
    const deployed = inventory({ activeVersionId: CANDIDATE_VERSION, versions: initial.versions });
    const after = inventory({ activeVersionId: CANDIDATE_VERSION, routes: [...deployed.routes, { id: ROUTE_ID, pattern: "canary.selinow.com/*", script: productionSpec.workerName }], versions: initial.versions });
    let index = 0;
    const events: string[] = [];
    const result = await runProductionCanaryApply(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      uploadReport: report,
      inventoryImplementation: async () => [initial, deployed, after][index++],
      dnsAdmissionImplementation: async (hostname: string) => {
        events.push("dns:admit");
        return { hostname, addresses: ["104.16.0.1"] };
      },
      deployVersionImplementation: async (id: string) => events.push(`deploy:${id}`),
      createRouteImplementation: async (route: Record<string, string>) => { events.push("route:create"); return { ...route, id: ROUTE_ID }; },
      writeReportImplementation: async () => "applied.json",
    }));
    expect(result.ok).toBe(true);
    expect(events).toEqual(["dns:admit", `deploy:${CANDIDATE_VERSION}`, "dns:admit", "route:create"]);
    expect(result.state.dnsAdmission).toEqual({
      addressesBeforeDeploy: ["104.16.0.1"],
      addressesBeforeRoute: ["104.16.0.1"],
      hostname: "canary.selinow.com",
    });
  });

  it("requires DNS admission before deploying and compensates if it disappears before route apply", async () => {
    const report = await uploadReport();
    const initial = inventory({ versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: false })] });
    const deployed = inventory({ activeVersionId: CANDIDATE_VERSION, versions: initial.versions });
    const restoredControl = inventory({
      activeVersionId: CONTROL_VERSION,
      deployments: [
        { created_on: "2026-07-30T03:20:00.000Z", id: CONTROL_DEPLOYMENT, versions: [{ percentage: 100, version_id: CONTROL_VERSION }] },
        { created_on: "2026-07-30T03:10:00.000Z", id: CANDIDATE_DEPLOYMENT, versions: [{ percentage: 100, version_id: CANDIDATE_VERSION }] },
      ],
      versions: initial.versions,
    });
    const deploy = vi.fn(async () => {});
    await expect(runProductionCanaryApply(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      uploadReport: report,
      inventoryImplementation: async () => initial,
      dnsAdmissionImplementation: undefined,
      deployVersionImplementation: deploy,
    }))).rejects.toThrow("production_canary_dns_admission_missing");
    expect(deploy).not.toHaveBeenCalled();
    await expect(runProductionCanaryApply(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      uploadReport: report,
      inventoryImplementation: async () => initial,
      dnsAdmissionImplementation: async (hostname: string) => ({ hostname, addresses: ["192.0.2.1"] }),
      deployVersionImplementation: deploy,
    }))).rejects.toThrow("production_canary_dns_admission_invalid");
    expect(deploy).not.toHaveBeenCalled();

    let inventoryIndex = 0;
    let dnsIndex = 0;
    await expect(runProductionCanaryApply(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      uploadReport: report,
      inventoryImplementation: async () => [initial, deployed, restoredControl][inventoryIndex++],
      dnsAdmissionImplementation: async (hostname: string) => {
        if (dnsIndex++ === 0) return { hostname, addresses: ["104.16.0.1"] };
        throw new Error("production_canary_dns_unresolved");
      },
      deployVersionImplementation: deploy,
    }))).rejects.toThrow("production_canary_dns_unresolved");
    expect(deploy).toHaveBeenNthCalledWith(1, CANDIDATE_VERSION);
    expect(deploy).toHaveBeenCalledOnce();
  });

  it("reconciles an ambiguous deploy and avoids mutation when control is still active", async () => {
    const report = await uploadReport();
    const initial = inventory({ versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: false })] });
    const candidate = inventory({ activeVersionId: CANDIDATE_VERSION, versions: initial.versions });
    const control = inventory({ versions: initial.versions });
    const deploy = vi.fn(async (versionId: string) => {
      if (versionId === CANDIDATE_VERSION) throw new Error("deploy_ambiguous");
    });
    let index = 0;
    await expect(runProductionCanaryApply(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      uploadReport: report,
      inventoryImplementation: async () => [initial, candidate, candidate, control][index++],
      deployVersionImplementation: deploy,
    }))).rejects.toThrow("deploy_ambiguous");
    expect(deploy).toHaveBeenNthCalledWith(1, CANDIDATE_VERSION);
    expect(deploy).toHaveBeenNthCalledWith(2, CONTROL_VERSION);

    index = 0;
    const stillControl = vi.fn(async () => { throw new Error("deploy_ambiguous"); });
    await expect(runProductionCanaryApply(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      uploadReport: report,
      inventoryImplementation: async () => [initial, initial, initial][index++],
      deployVersionImplementation: stillControl,
    }))).rejects.toThrow("deploy_ambiguous");
    expect(stillControl).toHaveBeenCalledOnce();
  });

  it("accepts an id-only route response and compensates if state persistence fails", async () => {
    const report = await uploadReport();
    const initial = inventory({ versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: false })] });
    const deployed = inventory({ activeVersionId: CANDIDATE_VERSION, versions: initial.versions });
    const after = inventory({ activeVersionId: CANDIDATE_VERSION, routes: [...deployed.routes, { id: ROUTE_ID, pattern: "canary.selinow.com/*", script: productionSpec.workerName }], versions: initial.versions });
    const routeRestoredCandidate = inventory({ activeVersionId: CANDIDATE_VERSION, versions: initial.versions });
    const restoredControl = inventory({ activeVersionId: CONTROL_VERSION, versions: initial.versions });
    let index = 0;
    const events: string[] = [];
    await expect(runProductionCanaryApply(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      uploadReport: report,
      inventoryImplementation: async () => [initial, deployed, after, after, routeRestoredCandidate, restoredControl][index++],
      deployVersionImplementation: async (id: string) => events.push(`deploy:${id}`),
      createRouteImplementation: async () => {
        events.push("route:create");
        return { id: ROUTE_ID };
      },
      deleteRouteImplementation: async (id: string) => {
        events.push(`delete:${id}`);
        throw new Error("delete_response_lost");
      },
      writeReportImplementation: async () => { throw new Error("state_write_failed"); },
    }))).rejects.toThrow("state_write_failed");
    expect(events).toEqual([
      `deploy:${CANDIDATE_VERSION}`,
      "route:create",
      `delete:${ROUTE_ID}`,
      `deploy:${CONTROL_VERSION}`,
    ]);
  });

  it("restores control but never deletes a route from an ambiguous unowned POST", async () => {
    const report = await uploadReport();
    const initial = inventory({ versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: false })] });
    const deployed = inventory({ activeVersionId: CANDIDATE_VERSION, versions: initial.versions });
    const after = inventory({ activeVersionId: CANDIDATE_VERSION, routes: [...deployed.routes, { id: ROUTE_ID, pattern: "canary.selinow.com/*", script: productionSpec.workerName }], versions: initial.versions });
    const restoredControl = inventory({ activeVersionId: CONTROL_VERSION, routes: after.routes, versions: initial.versions });
    let index = 0;
    const events: string[] = [];
    await expect(runProductionCanaryApply(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      uploadReport: report,
      inventoryImplementation: async () => [initial, deployed, after, restoredControl][index++],
      deployVersionImplementation: async (id: string) => events.push(`deploy:${id}`),
      createRouteImplementation: async () => {
        events.push("route:create");
        throw new Error("route_post_ambiguous");
      },
      deleteRouteImplementation: async (id: string) => events.push(`delete:${id}`),
    }))).rejects.toThrow("production_canary_apply_compensation_failed");
    expect(events).toEqual([
      `deploy:${CANDIDATE_VERSION}`,
      "route:create",
      `deploy:${CONTROL_VERSION}`,
    ]);
  });

  it("binds apply to the upload-time evidence prerequisites", async () => {
    const report = await uploadReport();
    const inventoryImplementation = vi.fn(async () => inventory({
      versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: false })],
    }));
    await expect(runProductionCanaryApply(input({
      evidence: validEvidence({
        backup: {
          ...validEvidence().backup,
          snapshotReportRef: "private/backup/changed-after-upload.json",
        },
        candidateWorkerVersion: CANDIDATE_VERSION,
      }),
      uploadReport: report,
      inventoryImplementation,
    }))).rejects.toThrow("production_canary_upload_report_invalid");
    expect(inventoryImplementation).not.toHaveBeenCalled();
  });

  it("rejects route/control/candidate drift before mutation", async () => {
    const report = await uploadReport();
    const candidateVersions = [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: false })];
    await expect(runProductionCanaryApply(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      uploadReport: report,
      inventoryImplementation: async () => inventory({ routes: [...baseRoutes(), { id: "drift-route", pattern: "drift.selinow.com/*", script: null }], versions: candidateVersions }),
      trafficSnapshot: { domains: [], routes: sortedRouteSnapshot([...baseRoutes(), { id: "drift-route", pattern: "drift.selinow.com/*", script: null }]) },
      deployVersionImplementation: vi.fn(),
      createRouteImplementation: vi.fn(),
    }))).rejects.toThrow("production_canary_upload_report_invalid");
    await expect(runProductionCanaryApply(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      uploadReport: report,
      inventoryImplementation: async () => inventory({ activeVersionId: OTHER_VERSION, versions: [...candidateVersions, version(OTHER_VERSION)] }),
      deployVersionImplementation: vi.fn(),
      createRouteImplementation: vi.fn(),
    }))).rejects.toThrow("production_canary_control_version_drift");
    await expect(runProductionCanaryApply(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      uploadReport: report,
      inventoryImplementation: async () => inventory({ versions: [version(CONTROL_VERSION)] }),
      deployVersionImplementation: vi.fn(),
      createRouteImplementation: vi.fn(),
    }))).rejects.toThrow("production_canary_candidate_missing");
  });

  it("blocks apply and rollback before mutation when the Worker subdomain is enabled", async () => {
    const report = await uploadReport();
    const versions = [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: true })];
    const applyInventory = inventory({
      versions,
      workerSubdomain: { enabled: false, previews_enabled: true },
    });
    const deploy = vi.fn();
    const createRoute = vi.fn();
    await expect(runProductionCanaryApply(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      uploadReport: report,
      inventoryImplementation: async () => applyInventory,
      deployVersionImplementation: deploy,
      createRouteImplementation: createRoute,
    }))).rejects.toThrow("production_canary_worker_subdomain_enabled");
    expect(deploy).not.toHaveBeenCalled();
    expect(createRoute).not.toHaveBeenCalled();

    const withRoute = inventory({
      activeVersionId: CANDIDATE_VERSION,
      routes: [...baseRoutes(), { id: ROUTE_ID, pattern: "canary.selinow.com/*", script: productionSpec.workerName }],
      versions,
      workerSubdomain: { enabled: true, previews_enabled: false },
    });
    const deleteRoute = vi.fn();
    await expect(runProductionCanaryRollback(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      canaryState: {
        schemaVersion: 1, mode: "applied", environment: "production", accountId: ACCOUNT_ID, zoneId: ZONE_ID,
        planSha256: fingerprint(canaryPlan()),
        workerName: productionSpec.workerName, ceremonyId: "bootstrap_20260730_reviewed", candidateVersionId: CANDIDATE_VERSION, controlVersionId: CONTROL_VERSION,
        canaryRoute: { id: ROUTE_ID, pattern: "canary.selinow.com/*", script: productionSpec.workerName },
        routesBefore: sortedRoutes(), routesAfter: sortedRoutes(withRoute.routes),
      },
      inventoryImplementation: async () => withRoute,
      deleteRouteImplementation: deleteRoute,
      deployVersionImplementation: deploy,
    }))).rejects.toThrow("production_canary_worker_subdomain_enabled");
    expect(deleteRoute).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
  });

  it("deletes only the canary route before restoring the control version", async () => {
    const before = inventory({ versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: false })] });
    const withRoute = inventory({ activeVersionId: CANDIDATE_VERSION, routes: [...baseRoutes(), { id: ROUTE_ID, pattern: "canary.selinow.com/*", script: productionSpec.workerName }], versions: before.versions });
    const restored = inventory({ activeVersionId: CANDIDATE_VERSION, versions: before.versions });
    const restoredControl = inventory({ activeVersionId: CONTROL_VERSION, versions: before.versions });
    let index = 0;
    const events: string[] = [];
    const result = await runProductionCanaryRollback(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      canaryState: {
        schemaVersion: 1,
        mode: "applied",
        environment: "production",
        planSha256: fingerprint(canaryPlan()),
        accountId: ACCOUNT_ID,
        zoneId: ZONE_ID,
        workerName: productionSpec.workerName,
        ceremonyId: "bootstrap_20260730_reviewed",
        candidateVersionId: CANDIDATE_VERSION,
        controlVersionId: CONTROL_VERSION,
        canaryRoute: { id: ROUTE_ID, pattern: "canary.selinow.com/*", script: productionSpec.workerName },
        routesBefore: sortedRoutes(before.routes),
        routesAfter: sortedRoutes(withRoute.routes),
      },
      inventoryImplementation: async () => [withRoute, restored, restoredControl][index++],
      deleteRouteImplementation: async (id: string) => {
        events.push(`delete:${id}`);
        throw new Error("delete_response_lost");
      },
      deployVersionImplementation: async (id: string) => {
        events.push(`deploy:${id}`);
        throw new Error("deploy_response_lost");
      },
      writeReportImplementation: async () => "rollback.json",
    }));
    expect(result.ok).toBe(true);
    expect(events).toEqual([`delete:${ROUTE_ID}`, `deploy:${CONTROL_VERSION}`]);
  });

  it("fails closed when rollback route state drifts", async () => {
    const withRoute = inventory({ activeVersionId: CANDIDATE_VERSION, routes: [...baseRoutes(), { id: ROUTE_ID, pattern: "canary.selinow.com/*", script: productionSpec.workerName }], versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: false })] });
    const state = {
      schemaVersion: 1, mode: "applied", environment: "production", accountId: ACCOUNT_ID, zoneId: ZONE_ID,
      planSha256: fingerprint(canaryPlan()),
      workerName: productionSpec.workerName, ceremonyId: "bootstrap_20260730_reviewed", candidateVersionId: CANDIDATE_VERSION, controlVersionId: CONTROL_VERSION,
      canaryRoute: { id: ROUTE_ID, pattern: "canary.selinow.com/*", script: productionSpec.workerName },
      routesBefore: sortedRoutes(), routesAfter: sortedRoutes(withRoute.routes),
    };
    await expect(runProductionCanaryRollback(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      canaryState: state,
      inventoryImplementation: async () => inventory({ activeVersionId: CANDIDATE_VERSION, routes: baseRoutes(), versions: withRoute.versions }),
      deleteRouteImplementation: vi.fn(),
      deployVersionImplementation: vi.fn(),
    }))).rejects.toThrow("production_canary_rollback_route_drift");

    let index = 0;
    const deleted = vi.fn();
    const deployed = vi.fn();
    await expect(runProductionCanaryRollback(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      canaryState: state,
      inventoryImplementation: async () => [withRoute, inventory({ activeVersionId: CANDIDATE_VERSION, routes: [...baseRoutes(), { id: "wrong-route", pattern: "wrong.selinow.com/*", script: productionSpec.workerName }], versions: withRoute.versions })][index++],
      deleteRouteImplementation: deleted,
      deployVersionImplementation: deployed,
    }))).rejects.toThrow("production_canary_rollback_routes_not_restored");
    expect(deleted).toHaveBeenCalledWith(ROUTE_ID);
    expect(deployed).not.toHaveBeenCalled();
  });

  it("rejects a destructive route-ID mismatch before rollback mutation", async () => {
    const withRoute = inventory({ activeVersionId: CANDIDATE_VERSION, routes: [...baseRoutes(), { id: ROUTE_ID, pattern: "canary.selinow.com/*", script: productionSpec.workerName }], versions: [version(CONTROL_VERSION), version(CANDIDATE_VERSION, { has_preview: false })] });
    const deleted = vi.fn();
    await expect(runProductionCanaryRollback(input({
      execute: true,
      evidence: validEvidence({ candidateWorkerVersion: CANDIDATE_VERSION }),
      canaryState: {
        schemaVersion: 1, mode: "applied", environment: "production", accountId: ACCOUNT_ID, zoneId: ZONE_ID,
        planSha256: fingerprint(canaryPlan()),
        workerName: productionSpec.workerName, ceremonyId: "bootstrap_20260730_reviewed", candidateVersionId: CANDIDATE_VERSION, controlVersionId: CONTROL_VERSION,
        canaryRoute: { id: "route-apex-001", pattern: "canary.selinow.com/*", script: productionSpec.workerName },
        routesBefore: sortedRoutes(), routesAfter: sortedRoutes(withRoute.routes),
      },
      inventoryImplementation: async () => withRoute,
      deleteRouteImplementation: deleted,
      deployVersionImplementation: vi.fn(),
    }))).rejects.toThrow("production_canary_state_route_mismatch");
    expect(deleted).not.toHaveBeenCalled();
  });
});

describe("production canary route API helpers", () => {
  it("uses exact POST/DELETE methods and encodes route IDs", async () => {
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    const fetchImplementation = async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const requestOptions = options ?? {};
      requests.push({ url, method: requestOptions.method ?? "GET", body: typeof requestOptions.body === "string" ? requestOptions.body : undefined });
      return new Response(JSON.stringify({ success: true, result: { id: ROUTE_ID, pattern: "canary.selinow.com/*", script: productionSpec.workerName } }), { headers: { "content-type": "application/json" } });
    };
    await createProductionCanaryRoute({ fetchImplementation, pattern: "canary.selinow.com/*", script: productionSpec.workerName, token: "route-secret", zoneId: ZONE_ID });
    await deleteProductionCanaryRoute({ fetchImplementation, routeId: "route/id+with spaces", token: "route-secret", zoneId: ZONE_ID });
    const first = requests[0];
    const second = requests[1];
    if (!first || !second) throw new Error("request_capture_failed");
    expect(first).toMatchObject({ method: "POST", url: `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/workers/routes` });
    expect(JSON.parse(first.body ?? "{}")).toEqual({ pattern: "canary.selinow.com/*", script: productionSpec.workerName });
    expect(second).toMatchObject({ method: "DELETE", url: `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/workers/routes/${encodeURIComponent("route/id+with spaces")}` });
  });

  it("does not leak route token values in errors", async () => {
    await expect(createProductionCanaryRoute({ token: "route-secret-value", pattern: "bad", script: productionSpec.workerName, zoneId: ZONE_ID, fetchImplementation: async () => { throw new Error("network down"); } })).rejects.toSatisfy((error: Error) => !error.message.includes("route-secret-value"));
  });
});
