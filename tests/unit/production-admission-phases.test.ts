import { describe, expect, it } from "vitest";

import {
  assertProductionWorkerVersionAdmission,
  validateProductionLiveInfrastructure,
  validateProductionWorkerRouteInventory,
} from "../../scripts/lib/platform.mjs";

const accountId = "abcdef0123456789abcdef0123456789";
const zoneId = "ce1536fca500680c544662e361ed869b";
const databaseId = "17ea8f2f-4c97-4337-8989-28b25a58ddeb";
const candidateVersion = "11111111-1111-4111-8111-111111111111";
const previousVersion = "22222222-2222-4222-8222-222222222222";
const rollbackVersion = "33333333-3333-4333-8333-333333333333";

const stagingSpec = {
  accountId,
  environment: "staging",
  hostnames: ["staging.selinow.com", "app-staging.selinow.com", "api-staging.selinow.com"],
  resources: { d1: "selinow-staging" },
  saas: {
    cnameTarget: "customers.selinow.com",
    dnsRecords: [],
    fallbackOrigin: "proxy-fallback.selinow.com",
  },
  sharedZoneDisabledRoutes: ["selinow.com/*", "*.selinow.com/*", "*/*"],
  stagingRouteExceptions: [
    "staging.selinow.com/*",
    "app-staging.selinow.com/*",
    "api-staging.selinow.com/*",
    "*.staging.selinow.com/*",
  ],
  wildcardRoute: "*.staging.selinow.com/*",
  workerName: "selinow-com-staging",
  productionWorkerName: "selinow-com-production",
  workerRoutes: [
    { custom_domain: true, pattern: "staging.selinow.com" },
    { custom_domain: true, pattern: "app-staging.selinow.com" },
    { custom_domain: true, pattern: "api-staging.selinow.com" },
    { pattern: "staging.selinow.com/*", zone_name: "selinow.com" },
    { pattern: "app-staging.selinow.com/*", zone_name: "selinow.com" },
    { pattern: "api-staging.selinow.com/*", zone_name: "selinow.com" },
    { pattern: "*.staging.selinow.com/*", zone_name: "selinow.com" },
  ],
  zoneId,
  zoneName: "selinow.com",
};

const productionSpec = {
  accountId,
  bootstrap: { canaryHostname: "canary.selinow.com" },
  environment: "production",
  hostnames: {
    api: "api.selinow.com",
    dashboard: "app.selinow.com",
    marketing: "selinow.com",
  },
  resources: { d1: "selinow-production" },
  routing: { externalCustomDomainFallbackRoute: "*/*" },
  saas: { cnameTarget: "customers.selinow.com", fallbackOrigin: "proxy-fallback.selinow.com" },
  turnstile: {
    externalCustomDomainAdmission: "verified_before_domain_activation",
    externalCustomDomainStrategy: "exact_hostname_admission_before_activation",
    platformHostname: "selinow.com",
  },
  workerName: "selinow-com-production",
  zoneId,
  zoneName: "selinow.com",
};

const wranglerConfig = {
  env: {
    production: {
      d1_databases: [{ binding: "PLATFORM_DB", database_id: databaseId, database_name: "selinow-production" }],
      name: "selinow-com-production",
      routes: [
        { pattern: "selinow.com/*", zone_name: "selinow.com" },
        { pattern: "*.selinow.com/*", zone_name: "selinow.com" },
        { pattern: "*/*", zone_name: "selinow.com" },
        { custom_domain: true, pattern: "app.selinow.com" },
        { custom_domain: true, pattern: "api.selinow.com" },
      ],
    },
  },
};

const productionRoutes = [
  { pattern: "selinow.com/*", script: "selinow-com-production" },
  { pattern: "*.selinow.com/*", script: "selinow-com-production" },
  { pattern: "staging.selinow.com/*", script: "selinow-com-staging" },
  { pattern: "app-staging.selinow.com/*", script: "selinow-com-staging" },
  { pattern: "api-staging.selinow.com/*", script: "selinow-com-staging" },
  { pattern: "*.staging.selinow.com/*", script: "selinow-com-staging" },
  { pattern: "*/*", script: "selinow-com-production" },
];

const productionDomains = [
  ...stagingSpec.hostnames.map((hostname) => ({ hostname, service: "selinow-com-staging", zone_id: zoneId, zone_name: "selinow.com" })),
  { hostname: "app.selinow.com", service: "selinow-com-production", zone_id: zoneId, zone_name: "selinow.com" },
  { hostname: "api.selinow.com", service: "selinow-com-production", zone_id: zoneId, zone_name: "selinow.com" },
];

function infrastructureFixture() {
  const customerHostname = "shop.customer.example";
  const contract = {
    criticalBindings: [
      { id: databaseId, name: "PLATFORM_DB", type: "d1" },
      { id: "cache", name: "PLATFORM_CACHE", type: "kv_namespace" },
    ],
    consumers: [
      { queue: "selinow-integration-production", script: "selinow-com-production", settings: { batchSize: 10, batchTimeout: 5, maxRetries: 5 } },
    ],
    cron: "*/15 * * * *",
    fallbackOrigin: "proxy-fallback.selinow.com",
    platformTurnstileHostname: "selinow.com",
    turnstileSiteKey: "site-key",
  };
  const domainRow = {
    cloudflare_hostname_id: "hostname-1",
    delete_requested_at: null,
    deleted_at: null,
    dns_status: "active",
    hostname_normalized: customerHostname,
    hostname_status: "active",
    is_primary: 1,
    ownership_verified_at: "2026-08-11T00:00:00.000Z",
    shop_id: "shop-1",
    ssl_status: "active",
    status: "active",
    validation_metadata_json: JSON.stringify({ turnstile: {
      checkedAt: "2026-08-11T00:00:00.000Z",
      hostname: customerHostname,
      mode: "operator_managed",
      source: "cloudflare_widget_domains",
      status: "active",
    } }),
  };
  const expectedConsumer = contract.consumers[0];
  if (expectedConsumer === undefined) throw new Error("fixture_consumer_missing");
  return {
    contract,
    customDomainRows: [domainRow],
    customHostnames: [{ hostname: customerHostname, id: "hostname-1", ssl: { status: "active" }, status: "active" }],
    fallbackOrigin: { origin: contract.fallbackOrigin, status: "active" },
    now: "2026-08-11T06:00:00.000Z",
    queueConsumers: [{ queue: expectedConsumer.queue, consumers: [{ script: "selinow-com-production", settings: expectedConsumer.settings }] }],
    schedules: [{ cron: contract.cron }],
    turnstileWidget: { domains: [contract.platformTurnstileHostname, customerHostname], sitekey: contract.turnstileSiteKey },
    workerSettings: { bindings: contract.criticalBindings },
  };
}

describe("production admission phases", () => {
  it("accepts bounded pre-candidate route, queue, and cron absence", () => {
    const result = validateProductionWorkerRouteInventory(
      productionSpec,
      stagingSpec,
      wranglerConfig,
      productionRoutes.map((route) => (
        ["selinow.com/*", "*.selinow.com/*", "*/*"].includes(route.pattern)
          ? { ...route, script: route.pattern === "*/*" ? "selinow-com-staging" : null }
          : route
      )),
      productionDomains,
      { admissionMode: "pre_candidate" },
    );
    expect(result.ok).toBe(true);

    const fixture = infrastructureFixture();
    expect(validateProductionLiveInfrastructure({
      ...fixture,
      queueConsumers: [],
      schedules: [],
      admissionMode: "pre_candidate",
    }).ok).toBe(true);
  });

  it("rejects unknown routes, wrong queue settings, and extra cron in pre-candidate mode", () => {
    expect(validateProductionWorkerRouteInventory(
      productionSpec,
      stagingSpec,
      wranglerConfig,
      [...productionRoutes, { pattern: "unknown.example/*", script: "selinow-com-staging" }],
      productionDomains,
      { admissionMode: "pre_candidate" },
    ).ok).toBe(false);

    const fixture = infrastructureFixture();
    const expectedConsumer = fixture.contract.consumers[0];
    if (expectedConsumer === undefined) throw new Error("fixture_consumer_missing");
    expect(validateProductionLiveInfrastructure({
      ...fixture,
      queueConsumers: [{
        ...fixture.queueConsumers[0],
        consumers: [{ script: "selinow-com-production", settings: { ...expectedConsumer.settings, maxRetries: 99 } }],
      }],
      admissionMode: "pre_candidate",
    }).ok).toBe(false);
    expect(validateProductionLiveInfrastructure({
      ...fixture,
      schedules: [{ cron: fixture.contract.cron }, { cron: "0 * * * *" }],
      admissionMode: "pre_candidate",
    }).ok).toBe(false);
  });

  it("keeps exact admission strict for the bounded pre-candidate drift", () => {
    const fixture = infrastructureFixture();
    expect(validateProductionLiveInfrastructure({ ...fixture, queueConsumers: [], schedules: [], admissionMode: "exact" }).ok).toBe(false);
    expect(validateProductionWorkerRouteInventory(
      productionSpec,
      stagingSpec,
      wranglerConfig,
      productionRoutes.map((route) => route.pattern === "*/*" ? { ...route, script: "selinow-com-staging" } : route),
      productionDomains,
      { admissionMode: "exact" },
    ).ok).toBe(false);
  });

  it("distinguishes pre-candidate and candidate-active Worker version admission", () => {
    const base = {
      candidateWorkerVersion: candidateVersion,
      rollbackCandidateWorkerVersion: rollbackVersion,
      deployableWorkerVersionIds: [candidateVersion, previousVersion, rollbackVersion],
    };
    expect(assertProductionWorkerVersionAdmission({
      ...base,
      currentWorkerVersion: previousVersion,
      previousWorkerVersion: previousVersion,
      workerVersionAdmissionMode: "pre_candidate",
    })).toMatchObject({ currentWorkerVersion: previousVersion });
    expect(assertProductionWorkerVersionAdmission({
      ...base,
      currentWorkerVersion: candidateVersion,
      previousWorkerVersion: previousVersion,
      workerVersionAdmissionMode: "candidate_active",
    })).toMatchObject({ currentWorkerVersion: candidateVersion });
    expect(() => assertProductionWorkerVersionAdmission({
      ...base,
      currentWorkerVersion: previousVersion,
      previousWorkerVersion: previousVersion,
      workerVersionAdmissionMode: "candidate_active",
    })).toThrow();
  });
});
