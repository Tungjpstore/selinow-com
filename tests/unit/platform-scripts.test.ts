import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { parseFlags } from "../../scripts/lib/cli.mjs";
import {
  assertProductionWorkerDatabaseIdentity,
  assertProductionWorkerIdentityAdmission,
  assertStagingDeployAdmission,
  assertStagingAccountIdentity,
  assertStagingDatabaseIdentity,
  assertStagingMutationAdmission,
  assertOwnedName,
  auditStagingRouteInventory,
  buildQueueBindings,
  buildPinnedCloudflareEnvironment,
  buildWorkerBuildEnvironment,
  buildWorkerDeployEnvironment,
  buildStagingRoutes,
  buildStagingVars,
  cloudflareApiRequest,
  doctor,
  inspectStagingRoutePreflight,
  parseQueueNames,
  parseR2Names,
  parseSecretNames,
  planSaasConfiguration,
  provision,
  requireCloudflarePlatformToken,
  requireCloudflareD1Token,
  requireCloudflareRouteAuditToken,
  requireCloudflareWorkerDeployToken,
  type PlatformEnvironmentSpec,
  validateProductionWorkerRouteInventory,
  validateStagingRouteInventory,
  validateStagingRuntimeIdentity,
} from "../../scripts/lib/platform.mjs";

const STAGING_DATABASE_ID = "c86d76a0-7407-42b6-ba92-f9f9623d0730";
const PRODUCTION_DATABASE_ID = "17ea8f2f-4c97-4337-8989-28b25a58ddeb";

const stagingSpec = {
  accountId: "abcdef0123456789abcdef0123456789",
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
  resources: { d1: "selinow-staging" },
  saas: {
    cnameTarget: "customers.selinow.com",
    dnsRecords: [
      {
        content: "100::",
        key: "fallbackOrigin",
        name: "proxy-fallback.selinow.com",
        proxied: true,
        ttl: 1,
        type: "AAAA",
      },
      {
        content: "proxy-fallback.selinow.com",
        key: "cnameTarget",
        name: "customers.selinow.com",
        proxied: true,
        ttl: 1,
        type: "CNAME",
      },
    ],
    fallbackOrigin: "proxy-fallback.selinow.com",
  },
  sharedZoneDisabledRoutes: [
    "selinow.com/*",
    "*.selinow.com/*",
    "*/*",
  ],
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
    { custom_domain: true, pattern: "signal.staging.selinow.com" },
    { custom_domain: true, pattern: "canvas.staging.selinow.com" },
    { custom_domain: true, pattern: "coming-soon.staging.selinow.com" },
    { custom_domain: true, pattern: "paused.staging.selinow.com" },
    { pattern: "staging.selinow.com/*", zone_name: "selinow.com" },
    { pattern: "app-staging.selinow.com/*", zone_name: "selinow.com" },
    { pattern: "api-staging.selinow.com/*", zone_name: "selinow.com" },
    { pattern: "*.staging.selinow.com/*", zone_name: "selinow.com" },
  ],
  zoneId: "ce1536fca500680c544662e361ed869b",
  zoneName: "selinow.com",
} satisfies PlatformEnvironmentSpec;

const stagingAdmissionFixtures = {
  doctorImplementation: () => Promise.resolve({ checks: [], ok: true }),
  environment: { CLOUDFLARE_D1_API_TOKEN: "d1-token" },
  platformToken: "platform-token",
  runtimeIdentityImplementation: () => Promise.resolve({
    databaseId: STAGING_DATABASE_ID,
    databaseName: "selinow-staging",
  }),
};

function exactStagingRouteInventory() {
  return [
    { pattern: "selinow.com/*", script: stagingSpec.productionWorkerName },
    { pattern: "*.selinow.com/*", script: stagingSpec.productionWorkerName },
    { pattern: "staging.selinow.com/*", script: stagingSpec.workerName },
    { pattern: "app-staging.selinow.com/*", script: stagingSpec.workerName },
    { pattern: "api-staging.selinow.com/*", script: stagingSpec.workerName },
    { pattern: stagingSpec.wildcardRoute, script: stagingSpec.workerName },
    { pattern: "*/*", script: stagingSpec.productionWorkerName },
  ];
}

function stagingAdmissionRunner(args: string[]) {
  if (args[0] === "whoami") {
    return { stderr: "", stdout: `Account ID: ${stagingSpec.accountId}` };
  }
  if (args[0] === "d1" && args[1] === "list") {
    return {
      stderr: "",
      stdout: JSON.stringify([{ name: stagingSpec.resources.d1, uuid: STAGING_DATABASE_ID }]),
    };
  }
  throw new Error(`unexpected_test_command:${args.join("_")}`);
}

function productionSpec() {
  return {
    accountId: stagingSpec.accountId,
    bootstrap: { canaryHostname: "canary.selinow.com" },
    environment: "production",
    hostnames: {
      api: "api.selinow.com",
      dashboard: "app.selinow.com",
      marketing: "selinow.com",
    },
    resources: { d1: "selinow-production" },
    workerName: "selinow-com-production",
    zoneId: stagingSpec.zoneId,
    zoneName: stagingSpec.zoneName,
  };
}

function productionWranglerConfig() {
  const routes: Array<{ custom_domain?: true; pattern: string; zone_name?: string }> = [
    { pattern: "selinow.com/*", zone_name: "selinow.com" },
    { pattern: "*.selinow.com/*", zone_name: "selinow.com" },
    { pattern: "*/*", zone_name: "selinow.com" },
    { custom_domain: true, pattern: "app.selinow.com" },
    { custom_domain: true, pattern: "api.selinow.com" },
  ];
  return {
    env: {
      production: {
        d1_databases: [{
          binding: "PLATFORM_DB",
          database_id: PRODUCTION_DATABASE_ID,
          database_name: "selinow-production",
        }],
        name: "selinow-com-production",
        routes,
      },
    },
  };
}

function exactSharedZoneRouteInventory() {
  return [
    { pattern: "selinow.com/*", script: "selinow-com-production" },
    { pattern: "*.selinow.com/*", script: "selinow-com-production" },
    { pattern: "staging.selinow.com/*", script: stagingSpec.workerName },
    { pattern: "app-staging.selinow.com/*", script: stagingSpec.workerName },
    { pattern: "api-staging.selinow.com/*", script: stagingSpec.workerName },
    { pattern: stagingSpec.wildcardRoute, script: stagingSpec.workerName },
    { pattern: "*/*", script: stagingSpec.productionWorkerName },
  ];
}

function exactSharedZoneDomainInventory(includeCanaryCarrier = false) {
  const production = productionSpec();
  const domains = [
    ...stagingSpec.hostnames.map((hostname) => ({
      hostname,
      service: stagingSpec.workerName,
      zone_id: stagingSpec.zoneId,
      zone_name: stagingSpec.zoneName,
    })),
    ...Object.values(production.hostnames).filter((hostname) => hostname !== production.hostnames.marketing).map((hostname) => ({
      hostname,
      service: production.workerName,
      zone_id: production.zoneId,
      zone_name: production.zoneName,
    })),
  ];
  if (includeCanaryCarrier) {
    domains.push({
      hostname: production.bootstrap.canaryHostname,
      service: stagingSpec.workerName,
      zone_id: production.zoneId,
      zone_name: production.zoneName,
    });
  }
  return domains;
}

describe("platform CLI flags", () => {
  it("parses environment and dry-run without mutation defaults", () => {
    expect(parseFlags(["--env", "staging", "--dry-run", "--json"])).toMatchObject({
      dryRun: true,
      environment: "staging",
      json: true,
    });
  });

  it("rejects unsupported environments", () => {
    expect(() => parseFlags(["--env", "preview"])).toThrow("unsupported_environment:preview");
  });

  it("keeps the live-route preflight hard-limited to staging", () => {
    const result = spawnSync(process.execPath, [
      "scripts/staging-route-preflight.mjs",
      "--env",
      "production",
      "--json",
    ], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      env: {},
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      checks: [{
        code: "staging_route_preflight_failed",
        detail: "staging_route_preflight_staging_only",
        ok: false,
      }],
      environment: "production",
      ok: false,
    });
  });
});

describe("Cloudflare resource parsing", () => {
  it("keeps private exports as an owned staging R2 resource", async () => {
    const specification = JSON.parse(
      await readFile(new URL("../../infra/environments/staging.json", import.meta.url), "utf8"),
    ) as { resources: { privateExports: string; r2: string } };
    expect(specification.resources).toMatchObject({
      privateExports: "selinow-private-exports-staging",
      r2: "selinow-media-staging",
    });
  });

  it("extracts R2 names from Wrangler output", () => {
    expect(parseR2Names("name:           selinow-media-staging\ncreation_date:  today\nname: selinow-private-exports-staging\n"))
      .toEqual(["selinow-media-staging", "selinow-private-exports-staging"]);
  });

  it("extracts only owned queue names", () => {
    expect(parseQueueNames("name  selinow-integration-staging\nname selinow-dlq-staging"))
      .toEqual(["selinow-integration-staging", "selinow-dlq-staging"]);
  });

  it("enforces the independent product resource prefix", () => {
    expect(() => {
      assertOwnedName("tungjpstore-content");
    }).toThrow("resource_name_outside_product_boundary");
    expect(() => {
      assertOwnedName("selinow-staging");
    }).not.toThrow();
  });

  it("extracts Worker secret names without exposing values", () => {
    expect(parseSecretNames('[{"name":"SESSION_SECRET","type":"secret_text"},'
      + '{"name":"CLOUDFLARE_API_TOKEN","type":"secret_text"}]'))
      .toEqual(["SESSION_SECRET", "CLOUDFLARE_API_TOKEN"]);
    expect(parseSecretNames("CLOUDFLARE_API_TOKEN secret_text"))
      .toContain("CLOUDFLARE_API_TOKEN");
  });
});

describe("Cloudflare for SaaS platform configuration", () => {
  it("builds Worker routes while validating the operator-managed disabled guards", () => {
    expect(buildStagingRoutes(stagingSpec)).toBe(stagingSpec.workerRoutes);
    expect(() => buildStagingRoutes({
      ...stagingSpec,
      workerRoutes: stagingSpec.workerRoutes.slice(0, -1),
    })).toThrow("cloudflare_staging_route_contract_invalid");
    expect(() => buildStagingRoutes({
      ...stagingSpec,
      sharedZoneDisabledRoutes: ["selinow.com/*"],
    })).toThrow("cloudflare_staging_route_contract_invalid");
  });

  it("accepts only the exact live production handoff", () => {
    const exactRoutes = exactStagingRouteInventory();
    const result = validateStagingRouteInventory(stagingSpec, exactRoutes);
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "cloudflare_staging_route_guard_apex", ok: true }),
      expect.objectContaining({ code: "cloudflare_staging_route_guard_wildcard", ok: true }),
      expect.objectContaining({ code: "cloudflare_staging_route_exception_staging_selinow_com", ok: true }),
      expect.objectContaining({ code: "cloudflare_staging_route_exception_app_staging_selinow_com", ok: true }),
      expect.objectContaining({ code: "cloudflare_staging_route_exception_api_staging_selinow_com", ok: true }),
      expect.objectContaining({ code: "cloudflare_staging_route_wildcard", ok: true }),
      expect.objectContaining({ code: "cloudflare_staging_route_catch_all", ok: true }),
      expect.objectContaining({ code: "cloudflare_staging_route_script_binding", ok: true }),
      expect.objectContaining({ code: "cloudflare_staging_route_inventory_allowlist", ok: true }),
    ]));

    expect(validateStagingRouteInventory(stagingSpec, exactRoutes.slice(1)).ok).toBe(false);
    expect(validateStagingRouteInventory(stagingSpec, exactRoutes.filter((route) => (
      route.pattern !== stagingSpec.wildcardRoute
    ))).ok).toBe(false);
    expect(validateStagingRouteInventory(stagingSpec, exactRoutes.map((route) => (
      route.pattern === "*.selinow.com/*"
        ? { ...route, script: "selinow-com-staging" }
        : route
    ))).ok).toBe(false);
    expect(validateStagingRouteInventory(stagingSpec, exactRoutes.map((route) => (
      route.pattern === stagingSpec.wildcardRoute
        ? { ...route, script: "another-worker" }
        : route
    ))).ok).toBe(false);
    expect(validateStagingRouteInventory(stagingSpec, exactRoutes.map((route) => (
      route.pattern === "*/*"
        ? { ...route, script: "another-worker" }
        : route
    ))).ok).toBe(false);
    expect(validateStagingRouteInventory(stagingSpec, [...exactRoutes, exactRoutes[0]]).ok)
      .toBe(false);
  });

  it("rejects pre-handoff guards, missing exact exceptions, and bare custom-domain hosts", () => {
    const handoffRoutes = exactStagingRouteInventory();
    const preHandoffRoutes = handoffRoutes.map((route) => (
      stagingSpec.sharedZoneDisabledRoutes.includes(route.pattern)
        ? { ...route, script: null }
        : route
    ));
    expect(validateStagingRouteInventory(stagingSpec, preHandoffRoutes).ok).toBe(false);

    for (const pattern of stagingSpec.stagingRouteExceptions) {
      expect(validateStagingRouteInventory(stagingSpec, handoffRoutes.filter((route) => (
        route.pattern !== pattern
      ))).ok).toBe(false);
    }
    expect(validateStagingRouteInventory(stagingSpec, [
      ...handoffRoutes,
      { pattern: "staging.selinow.com", script: stagingSpec.workerName },
    ]).ok).toBe(false);
  });

  it("fails closed on extra or conflicting script-bound routes", () => {
    const exactRoutes = exactStagingRouteInventory();

    const extraBinding = validateStagingRouteInventory(stagingSpec, [
      ...exactRoutes,
      { pattern: "preview.selinow.com/*", script: "another-worker" },
    ]);
    expect(extraBinding.ok).toBe(false);
    expect(extraBinding.checks.find((check) => (
      check.code === "cloudflare_staging_route_script_binding" && !check.ok
    ))).toMatchObject({ ok: false });

    expect(validateStagingRouteInventory(stagingSpec, [
      ...exactRoutes,
      { pattern: "preview.selinow.com/*", script: { name: "another-worker" } },
    ]).ok).toBe(false);

    expect(validateStagingRouteInventory(stagingSpec, [
      ...exactRoutes.map((route) => (
        route.pattern === stagingSpec.wildcardRoute
          ? { ...route, script: "another-worker" }
          : route
      )),
    ]).ok).toBe(false);

    expect(validateStagingRouteInventory(stagingSpec, [
      ...exactRoutes,
      { pattern: "api-preview.selinow.com/*", script: stagingSpec.workerName },
    ]).ok).toBe(false);
  });

  it("fails closed on extra null-script, duplicate, or malformed live routes", () => {
    const exactRoutes = exactStagingRouteInventory();

    for (const route of [
      { pattern: stagingSpec.wildcardRoute, script: null },
      { pattern: "preview.selinow.com/*" },
      { pattern: stagingSpec.wildcardRoute, script: stagingSpec.workerName },
    ]) {
      const routes = route.script === stagingSpec.workerName
        ? [...exactRoutes, route, route]
        : [...exactRoutes, route];
      const result = validateStagingRouteInventory(stagingSpec, routes);
      expect(result.ok).toBe(false);
      expect(result.checks.find((check) => (
        check.code === "cloudflare_staging_route_inventory_allowlist"
      ))).toMatchObject({ ok: false });
    }
  });

  it("audits the route inventory through one read-only Cloudflare request", async () => {
    let requestMethod = "";
    let requestedUrl = "";
    const fetchImplementation: typeof fetch = (input, init) => {
      requestMethod = init?.method ?? "GET";
      requestedUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      return Promise.resolve(new Response(JSON.stringify({
        result: exactStagingRouteInventory(),
        success: true,
      }), { status: 200 }));
    };

    await expect(auditStagingRouteInventory(
      stagingSpec,
      "route-audit-token",
      fetchImplementation,
    )).resolves.toMatchObject({ ok: true });
    expect(requestMethod).toBe("GET");
    expect(requestedUrl).toBe(
      `https://api.cloudflare.com/client/v4/zones/${stagingSpec.zoneId}/workers/routes`,
    );
  });

  it("admits the exact production Worker identity alongside the checked-in staging contract", () => {
    const result = validateProductionWorkerRouteInventory(
      productionSpec(),
      stagingSpec,
      productionWranglerConfig(),
      exactSharedZoneRouteInventory(),
      exactSharedZoneDomainInventory(),
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "cloudflare_production_worker_route_inventory_allowlist",
        ok: true,
      }),
      expect.objectContaining({
        code: "cloudflare_production_worker_domain_inventory_allowlist",
        ok: true,
      }),
    ]));

    expect(validateProductionWorkerRouteInventory(
      productionSpec(),
      stagingSpec,
      productionWranglerConfig(),
      exactSharedZoneRouteInventory(),
      exactSharedZoneDomainInventory(true),
    )).toMatchObject({ ok: true });
    expect(validateProductionWorkerRouteInventory(
      productionSpec(),
      stagingSpec,
      productionWranglerConfig(),
      exactSharedZoneRouteInventory(),
      exactSharedZoneDomainInventory(true).map((domain) => (
        domain.hostname === "canary.selinow.com"
          ? { ...domain, service: "selinow-com-production" }
          : domain
      )),
    ).ok).toBe(false);

    expect(validateProductionWorkerRouteInventory(
      productionSpec(),
      stagingSpec,
      productionWranglerConfig(),
      [
        ...exactSharedZoneRouteInventory(),
        { pattern: "app.selinow.com/*", script: "unapproved-worker" },
      ],
      exactSharedZoneDomainInventory(),
    ).ok).toBe(false);
    expect(validateProductionWorkerRouteInventory(
      productionSpec(),
      stagingSpec,
      productionWranglerConfig(),
      exactSharedZoneRouteInventory(),
      exactSharedZoneDomainInventory().map((domain) => (
        domain.hostname === "api.selinow.com"
          ? { ...domain, service: "unapproved-worker" }
          : domain
      )),
    ).ok).toBe(false);

    const conflictingConfig = productionWranglerConfig();
    conflictingConfig.env.production.routes.push({
      pattern: "*.selinow.com/*",
      zone_name: "selinow.com",
    });
    expect(() => {
      validateProductionWorkerRouteInventory(
        productionSpec(),
        stagingSpec,
        conflictingConfig,
        exactSharedZoneRouteInventory(),
        exactSharedZoneDomainInventory(),
      );
    }).toThrow("production_worker_route_contract_invalid");
  });

  it("pins and rechecks production account, D1, routes, and Worker domains", async () => {
    const requestedUrls: string[] = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer route-audit-token" });
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      requestedUrls.push(url);
      const result = url.endsWith("/workers/routes")
        ? exactSharedZoneRouteInventory()
        : exactSharedZoneDomainInventory();
      return Promise.resolve(new Response(JSON.stringify({ result, success: true }), {
        status: 200,
      }));
    };
    const commands: string[][] = [];
    const runWranglerImplementation = (
      args: string[],
      options?: { env?: NodeJS.ProcessEnv },
    ) => {
      commands.push(args);
      expect(options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(stagingSpec.accountId);
      expect(options?.env?.CLOUDFLARE_ROUTE_AUDIT_API_TOKEN).toBeUndefined();
      expect(options?.env?.CLOUDFLARE_PLATFORM_API_TOKEN).toBeUndefined();
      if (args[0] === "whoami") {
        return { stderr: "", stdout: JSON.stringify({ accounts: [{ id: stagingSpec.accountId }] }) };
      }
      return {
        stderr: "",
        stdout: JSON.stringify([{
          name: "selinow-production",
          uuid: PRODUCTION_DATABASE_ID,
        }]),
      };
    };

    await expect(assertProductionWorkerIdentityAdmission({
      environment: {
        CLOUDFLARE_D1_API_TOKEN: "d1-token",
        CLOUDFLARE_PLATFORM_API_TOKEN: "platform-token",
        CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-audit-token",
      },
      fetchImplementation,
      productionSpec: productionSpec(),
      runWranglerImplementation,
      stagingSpec,
      wranglerConfig: productionWranglerConfig(),
    })).resolves.toMatchObject({
      accountId: stagingSpec.accountId,
      databaseId: PRODUCTION_DATABASE_ID,
      databaseName: "selinow-production",
      ok: true,
      workerName: "selinow-com-production",
      zoneId: stagingSpec.zoneId,
    });
    expect(commands).toEqual([
      ["whoami", "--json"],
      ["d1", "list", "--env", "production", "--json"],
    ]);
    expect(requestedUrls.sort()).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${stagingSpec.accountId}/workers/domains`,
      `https://api.cloudflare.com/client/v4/zones/${stagingSpec.zoneId}/workers/routes`,
    ].sort());
  });

  it("fails production Worker admission before route reads on missing token or D1 drift", async () => {
    const runner = vi.fn();
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(assertProductionWorkerIdentityAdmission({
      environment: {},
      fetchImplementation,
      productionSpec: productionSpec(),
      runWranglerImplementation: runner,
      stagingSpec,
      wranglerConfig: productionWranglerConfig(),
    })).rejects.toThrow("cloudflare_route_audit_api_token_missing");
    expect(runner).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();

    await expect(assertProductionWorkerIdentityAdmission({
      environment: {
        CLOUDFLARE_D1_API_TOKEN: "d1-token",
        CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-audit-token",
      },
      fetchImplementation,
      productionSpec: productionSpec(),
      runWranglerImplementation: (args) => args[0] === "whoami"
        ? { stderr: "", stdout: `Account ID: ${stagingSpec.accountId}` }
        : {
            stderr: "",
            stdout: JSON.stringify([{
              name: "selinow-production",
              uuid: "11111111-1111-4111-8111-111111111111",
            }]),
          },
      stagingSpec,
      wranglerConfig: productionWranglerConfig(),
    })).rejects.toThrow("production_worker_database_identity_mismatch");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("validates the live production D1 name and UUID without exposing provider output", () => {
    expect(() => {
      assertProductionWorkerDatabaseIdentity(JSON.stringify([{
        name: "selinow-production",
        uuid: PRODUCTION_DATABASE_ID,
      }]), PRODUCTION_DATABASE_ID, "selinow-production");
    }).not.toThrow();
    expect(() => {
      assertProductionWorkerDatabaseIdentity(
        "not-json",
        PRODUCTION_DATABASE_ID,
        "selinow-production",
      );
    })
      .toThrow("production_worker_database_identity_invalid");
  });

  it("runs a staging-only route preflight with pinned identity and no child tokens", async () => {
    const fetchImplementation: typeof fetch = (input, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      expect(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
        .toBe(`https://api.cloudflare.com/client/v4/zones/${stagingSpec.zoneId}/workers/routes`);
      expect(init?.headers).toMatchObject({ Authorization: "Bearer route-audit-token" });
      return Promise.resolve(new Response(JSON.stringify({
        result: exactStagingRouteInventory(),
        success: true,
      }), { status: 200 }));
    };
    const commands: string[][] = [];
    const runWranglerImplementation = (args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      commands.push(args);
      expect(options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(stagingSpec.accountId);
      expect(options?.env?.CLOUDFLARE_ROUTE_AUDIT_API_TOKEN).toBeUndefined();
      expect(options?.env?.CLOUDFLARE_PLATFORM_API_TOKEN).toBeUndefined();
      return stagingAdmissionRunner(args);
    };

    await expect(inspectStagingRoutePreflight({
      environment: {
        CLOUDFLARE_D1_API_TOKEN: "d1-token",
        CLOUDFLARE_PLATFORM_API_TOKEN: "platform-token",
        CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-audit-token",
      },
      fetchImplementation,
      runWranglerImplementation,
      runtimeIdentityImplementation: stagingAdmissionFixtures.runtimeIdentityImplementation,
      spec: stagingSpec,
    })).resolves.toMatchObject({
      accountId: stagingSpec.accountId,
      databaseId: STAGING_DATABASE_ID,
      databaseName: "selinow-staging",
      environment: "staging",
      ok: true,
      workerName: stagingSpec.workerName,
      zoneId: stagingSpec.zoneId,
      zoneName: stagingSpec.zoneName,
    });
    expect(commands).toEqual([
      ["whoami", "--json"],
      ["d1", "list", "--env", "staging", "--json"],
    ]);
  });

  it("accepts scoped user tokens whose Wrangler account inventory is omitted", async () => {
    const fetchImplementation: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
      result: exactStagingRouteInventory(),
      success: true,
    }), { status: 200 }));
    const runner = vi.fn((args: string[]) => {
      if (args[0] === "whoami") {
        return {
          stderr: "",
          stdout: JSON.stringify({ accounts: [], authType: "User API Token", loggedIn: true }),
        };
      }
      return {
        stderr: "",
        stdout: JSON.stringify([{
          name: stagingSpec.resources.d1,
          uuid: STAGING_DATABASE_ID,
        }]),
      };
    });

    await expect(inspectStagingRoutePreflight({
      environment: {
        CLOUDFLARE_D1_API_TOKEN: "d1-token",
        CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-audit-token",
      },
      fetchImplementation,
      runWranglerImplementation: runner,
      runtimeIdentityImplementation: stagingAdmissionFixtures.runtimeIdentityImplementation,
      spec: stagingSpec,
    })).resolves.toMatchObject({ ok: true });
    expect(runner.mock.calls.map(([args]) => args)).toEqual([
      ["whoami", "--json"],
      ["d1", "list", "--env", "staging", "--json"],
    ]);
  });

  it("fails the staging route preflight before any remote read when its token is missing", async () => {
    const runner = vi.fn();
    const fetchImplementation = vi.fn<typeof fetch>();

    await expect(inspectStagingRoutePreflight({
      environment: {},
      fetchImplementation,
      runWranglerImplementation: runner,
      spec: stagingSpec,
    })).rejects.toThrow("cloudflare_route_audit_api_token_missing");
    expect(runner).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("fails staging deploy admission closed on drift without exposing the token", async () => {
    const fetchImplementation: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
      result: [
        { pattern: "selinow.com/*", script: null },
        { pattern: "*.selinow.com/*", script: "selinow-com-staging" },
        { pattern: stagingSpec.wildcardRoute, script: stagingSpec.workerName },
        { pattern: "*/*", script: "selinow-com-staging" },
      ],
      success: true,
    }), { status: 200 }));

    const failure = await assertStagingDeployAdmission({
      ...stagingAdmissionFixtures,
      fetchImplementation,
      runWranglerImplementation: stagingAdmissionRunner,
      spec: stagingSpec,
      token: "route-audit-token",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("cloudflare_staging_route_inventory_invalid");
    expect((failure as Error).message).not.toContain("route-audit-token");
  });

  it("requires the authenticated staging account before reading live routes", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({
      result: exactStagingRouteInventory(),
      success: true,
    }), { status: 200 })));

    await expect(assertStagingMutationAdmission({
      ...stagingAdmissionFixtures,
      fetchImplementation,
      runWranglerImplementation: stagingAdmissionRunner,
      spec: stagingSpec,
      token: "route-audit-token",
    })).resolves.toMatchObject({
      accountId: stagingSpec.accountId,
      ok: true,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const mismatchedFetch = vi.fn<typeof fetch>();
    await expect(assertStagingMutationAdmission({
      ...stagingAdmissionFixtures,
      fetchImplementation: mismatchedFetch,
      runWranglerImplementation: () => ({
        stderr: "",
        stdout: "Account ID: 11111111111111111111111111111111",
      }),
      spec: stagingSpec,
      token: "route-audit-token",
    })).rejects.toThrow("staging_account_identity_mismatch");
    expect(mismatchedFetch).not.toHaveBeenCalled();
  });

  it("requires a passing full staging doctor before account and route admission", async () => {
    const runner = vi.fn();
    const fetchImplementation = vi.fn<typeof fetch>();

    await expect(assertStagingMutationAdmission({
      ...stagingAdmissionFixtures,
      doctorImplementation: () => Promise.resolve({
        checks: [{ code: "cloudflare_saas_fallback_origin", ok: false }],
        ok: false,
      }),
      fetchImplementation,
      runWranglerImplementation: runner,
      spec: stagingSpec,
      token: "route-audit-token",
    })).rejects.toThrow(
      "staging_platform_doctor_failed:cloudflare_saas_fallback_origin",
    );
    expect(runner).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("binds staging admission to the generated manifest database ID", () => {
    const manifest = {
      accountId: stagingSpec.accountId,
      environment: "staging",
      resources: {
        d1: { id: STAGING_DATABASE_ID, name: stagingSpec.resources.d1 },
      },
      version: "manifest-version",
      workerName: stagingSpec.workerName,
      zoneId: stagingSpec.zoneId,
      zoneName: stagingSpec.zoneName,
    };
    const wranglerConfig = {
      env: {
        staging: {
          d1_databases: [{
            binding: "PLATFORM_DB",
            database_id: STAGING_DATABASE_ID,
            database_name: stagingSpec.resources.d1,
            migrations_dir: "./migrations",
          }],
          name: stagingSpec.workerName,
          vars: { RESOURCE_MANIFEST_VERSION: manifest.version },
        },
      },
    };

    expect(validateStagingRuntimeIdentity(stagingSpec, manifest, wranglerConfig)).toEqual({
      databaseId: STAGING_DATABASE_ID,
      databaseName: stagingSpec.resources.d1,
    });
    expect(() => validateStagingRuntimeIdentity(stagingSpec, manifest, {
      ...wranglerConfig,
      env: {
        staging: {
          ...wranglerConfig.env.staging,
          d1_databases: [{
            ...wranglerConfig.env.staging.d1_databases[0],
            database_id: "11111111-1111-4111-8111-111111111111",
          }],
        },
      },
    })).toThrow("staging_database_target_mismatch");
  });

  it("requires exactly one live D1 name and UUID match", () => {
    const exactDatabase = { name: stagingSpec.resources.d1, uuid: STAGING_DATABASE_ID };
    expect(() => {
      assertStagingDatabaseIdentity(
        JSON.stringify([exactDatabase]),
        STAGING_DATABASE_ID,
        stagingSpec.resources.d1,
      );
    }).not.toThrow();

    for (const databases of [
      [{ ...exactDatabase, uuid: "11111111-1111-4111-8111-111111111111" }],
      [exactDatabase, exactDatabase],
      [{ name: stagingSpec.resources.d1 }],
    ]) {
      expect(() => {
        assertStagingDatabaseIdentity(
          JSON.stringify(databases),
          STAGING_DATABASE_ID,
          stagingSpec.resources.d1,
        );
      }).toThrow(/staging_database_identity_(?:invalid|mismatch)/u);
    }
  });

  it("fails admission before route audit when the live D1 UUID differs", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const runner = vi.fn((args: string[]) => {
      if (args[0] === "whoami") {
        return { stderr: "", stdout: `Account ID: ${stagingSpec.accountId}` };
      }
      return {
        stderr: "",
        stdout: JSON.stringify([{
          name: stagingSpec.resources.d1,
          uuid: "11111111-1111-4111-8111-111111111111",
        }]),
      };
    });

    await expect(assertStagingMutationAdmission({
      ...stagingAdmissionFixtures,
      fetchImplementation,
      runWranglerImplementation: runner,
      spec: stagingSpec,
      token: "route-audit-token",
    })).rejects.toThrow("staging_database_identity_mismatch");
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(runner.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ["whoami", "--json"],
      ["d1", "list"],
    ]);
  });

  it("keeps temporary admission tokens outside the Wrangler identity subprocess", async () => {
    const runner = vi.fn((args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      expect(options?.env).toMatchObject({
        CLOUDFLARE_ACCOUNT_ID: stagingSpec.accountId,
        CLOUDFLARE_API_TOKEN: "d1-token",
      });
      expect(options?.env).not.toHaveProperty("CLOUDFLARE_PLATFORM_API_TOKEN");
      expect(options?.env).not.toHaveProperty("CLOUDFLARE_ROUTE_AUDIT_API_TOKEN");
      if (args[0] === "whoami") {
        return { stderr: "", stdout: `Account ID: ${stagingSpec.accountId}` };
      }
      expect(args).toEqual(["d1", "list", "--env", "staging", "--json"]);
      return {
        stderr: "",
        stdout: JSON.stringify([{
          name: stagingSpec.resources.d1,
          uuid: STAGING_DATABASE_ID,
        }]),
      };
    });
    const fetchImplementation: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
      result: exactStagingRouteInventory(),
      success: true,
    }), { status: 200 }));

    await expect(assertStagingMutationAdmission({
      ...stagingAdmissionFixtures,
      environment: {
        CLOUDFLARE_D1_API_TOKEN: "d1-token",
        CLOUDFLARE_PLATFORM_API_TOKEN: "platform-token",
        CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-token",
        KEEP_ME: "must-not-forward",
      },
      fetchImplementation,
      runWranglerImplementation: runner,
      spec: stagingSpec,
    })).resolves.toMatchObject({ ok: true });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("keeps operator tokens out of every full-doctor Wrangler subprocess", async () => {
    const spec = JSON.parse(
      await readFile(new URL("../../infra/environments/staging.json", import.meta.url), "utf8"),
    ) as PlatformEnvironmentSpec & {
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
    };
    const observedEnvironments: NodeJS.ProcessEnv[] = [];
    const runner = (args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (options?.env === undefined) throw new Error("test_runner_environment_missing");
      observedEnvironments.push(options.env);
      if (args[0] === "whoami") {
        return { stderr: "", stdout: `Account ID: ${spec.accountId}` };
      }
      if (args[0] === "d1") {
        return { stderr: "", stdout: JSON.stringify([{ name: spec.resources.d1 }]) };
      }
      if (args[0] === "kv") {
        return {
          stderr: "",
          stdout: JSON.stringify([
            { id: "1", title: spec.resources.platformCacheKv },
            { id: "2", title: spec.resources.sessionKv },
          ]),
        };
      }
      if (args[0] === "r2") {
        return {
          stderr: "",
          stdout: `name: ${spec.resources.r2}\nname: ${spec.resources.privateExports}\n`,
        };
      }
      if (args[0] === "queues") {
        return {
          stderr: "",
          stdout: `${spec.resources.integrationQueue}\n${spec.resources.notificationQueue}\n${spec.resources.deadLetterQueue}\n`,
        };
      }
      return {
        stderr: "",
        stdout: JSON.stringify([{ name: "CLOUDFLARE_API_TOKEN" }]),
      };
    };
    const fetchImplementation: typeof fetch = (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.endsWith("/workers/routes")) {
        return Promise.resolve(new Response(JSON.stringify({
          result: [
            { pattern: "selinow.com/*", script: spec.productionWorkerName },
            { pattern: "*.selinow.com/*", script: spec.productionWorkerName },
            ...spec.stagingRouteExceptions.filter((pattern) => pattern !== spec.wildcardRoute)
              .map((pattern) => ({ pattern, script: spec.workerName })),
            { pattern: spec.wildcardRoute, script: spec.workerName },
            { pattern: "*/*", script: spec.productionWorkerName },
          ],
          success: true,
        }), { status: 200 }));
      }
      if (url.includes("/dns_records?")) {
        const requestedName = new URL(url).searchParams.get("name");
        const record = spec.saas.dnsRecords.find((candidate) => candidate.name === requestedName);
        return Promise.resolve(new Response(JSON.stringify({ result: [record], success: true }), {
          status: 200,
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        result: { origin: spec.saas.fallbackOrigin, status: "active" },
        success: true,
      }), { status: 200 }));
    };

    await expect(doctor("staging", {
      environment: {
        CLOUDFLARE_D1_API_TOKEN: "d1-token",
        CLOUDFLARE_PLATFORM_API_TOKEN: "platform-token",
        CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-token",
        KEEP_ME: "must-not-forward",
      },
      fetchImplementation,
      runWranglerImplementation: runner,
      spec,
    })).resolves.toMatchObject({ ok: true });
    expect(observedEnvironments.length).toBeGreaterThan(0);
    expect(observedEnvironments.every((environment) => (
      environment.CLOUDFLARE_ACCOUNT_ID === spec.accountId
      && environment.CLOUDFLARE_API_TOKEN === "d1-token"
      && environment.KEEP_ME === undefined
      && !Object.prototype.hasOwnProperty.call(environment, "CLOUDFLARE_PLATFORM_API_TOKEN")
      && !Object.prototype.hasOwnProperty.call(environment, "CLOUDFLARE_ROUTE_AUDIT_API_TOKEN")
    ))).toBe(true);
  });

  it("fails closed without exposing Wrangler account output", async () => {
    await expect(assertStagingMutationAdmission({
      ...stagingAdmissionFixtures,
      runWranglerImplementation: () => {
        throw new Error("provider output containing operator identity");
      },
      spec: stagingSpec,
      token: "route-audit-token",
    })).rejects.toThrow("staging_account_identity_unavailable");
  });

  it("requires and maps the dedicated D1 token for pinned Wrangler commands", () => {
    expect(() => {
      assertStagingAccountIdentity(
        `Account ID: ${stagingSpec.accountId}`,
        stagingSpec.accountId,
      );
    }).not.toThrow();

    expect(() => requireCloudflareD1Token({})).toThrow("cloudflare_d1_api_token_missing");
    expect(requireCloudflareD1Token({
      CLOUDFLARE_D1_API_TOKEN: " d1-token ",
    })).toBe("d1-token");
    expect(() => buildPinnedCloudflareEnvironment({
      CLOUDFLARE_PLATFORM_API_TOKEN: "platform-token",
      CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-token",
    }, stagingSpec.accountId)).toThrow("cloudflare_d1_api_token_missing");
    expect(buildPinnedCloudflareEnvironment({
      CLOUDFLARE_PLATFORM_API_TOKEN: "platform-token",
      CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-token",
      CLOUDFLARE_D1_API_TOKEN: "d1-token",
      PATH: "/bin",
    }, stagingSpec.accountId)).toEqual({
      CLOUDFLARE_ACCOUNT_ID: stagingSpec.accountId,
      CLOUDFLARE_API_TOKEN: "d1-token",
      PATH: "/bin",
    });
  });

  it("emits public staging bindings without embedding the API token", () => {
    const variables = buildStagingVars(stagingSpec, { version: "manifest-version" });

    expect(variables).toMatchObject({
      CLOUDFLARE_ZONE_ID: stagingSpec.zoneId,
      DEFAULT_LOCALE: "en",
      EMAIL_FROM_ADDRESS: "no-reply@selinow.com",
      EMAIL_FROM_NAME: "Selinow",
      SAAS_CNAME_TARGET: "customers.selinow.com",
    });
    expect(variables).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
  });

  it("builds the exact queue retry and dead-letter contract", () => {
    expect(buildQueueBindings({
      deadLetterQueue: "selinow-dlq-staging",
      integrationQueue: "selinow-integration-staging",
      notificationQueue: "selinow-notification-staging",
    }, 5)).toEqual({
      consumers: [
        {
          dead_letter_queue: "selinow-dlq-staging",
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 5,
          queue: "selinow-integration-staging",
          retry_delay: 60,
        },
        {
          dead_letter_queue: "selinow-dlq-staging",
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 5,
          queue: "selinow-notification-staging",
          retry_delay: 60,
        },
        {
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 100,
          queue: "selinow-dlq-staging",
        },
      ],
      producers: [
        { binding: "INTEGRATION_QUEUE", queue: "selinow-integration-staging" },
        { binding: "NOTIFICATION_QUEUE", queue: "selinow-notification-staging" },
      ],
    });
  });

  it("keeps generated staging configuration consistent and secret-free", async () => {
    const wranglerConfig = JSON.parse(
      await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"),
    ) as {
      compatibility_flags: string[];
      queues: unknown;
      env: {
        staging: {
          queues: unknown;
          r2_buckets: Array<{ binding: string; bucket_name: string }>;
          routes: Array<{ custom_domain?: boolean; pattern: string; zone_name?: string }>;
          send_email: Array<{
            allowed_sender_addresses?: string[];
            name: string;
            remote?: boolean;
          }>;
          vars: Record<string, string>;
        };
      };
    };
    const manifest = JSON.parse(
      await readFile(new URL("../../infra/generated/staging.json", import.meta.url), "utf8"),
    ) as { resources: { privateExports: { name: string } }; saas: { cnameTarget: string; fallbackOrigin: string }; version: string };

    expect(wranglerConfig.env.staging.vars).toMatchObject({
      CLOUDFLARE_ZONE_ID: stagingSpec.zoneId,
      DEFAULT_LOCALE: "en",
      RESOURCE_MANIFEST_VERSION: manifest.version,
      SAAS_CNAME_TARGET: stagingSpec.saas.cnameTarget,
    });
    expect(wranglerConfig.env.staging.routes).toEqual(buildStagingRoutes(stagingSpec));
    expect(wranglerConfig.env.staging.routes.filter((route) => route.custom_domain !== true))
      .toEqual([
        { pattern: "staging.selinow.com/*", zone_name: "selinow.com" },
        { pattern: "app-staging.selinow.com/*", zone_name: "selinow.com" },
        { pattern: "api-staging.selinow.com/*", zone_name: "selinow.com" },
        { pattern: "*.staging.selinow.com/*", zone_name: "selinow.com" },
      ]);
    expect(wranglerConfig.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(wranglerConfig.queues).toEqual(buildQueueBindings({
      deadLetterQueue: "selinow-dlq-local",
      integrationQueue: "selinow-integration-local",
      notificationQueue: "selinow-notification-local",
    }, 3));
    expect(wranglerConfig.env.staging.queues).toEqual(buildQueueBindings({
      deadLetterQueue: "selinow-dlq-staging",
      integrationQueue: "selinow-integration-staging",
      notificationQueue: "selinow-notification-staging",
    }, 5));
    expect(wranglerConfig.env.staging.send_email).toEqual([{
      allowed_sender_addresses: [wranglerConfig.env.staging.vars.EMAIL_FROM_ADDRESS],
      name: "EMAIL",
      remote: true,
    }]);
    expect(manifest.saas).toEqual({
      cnameTarget: stagingSpec.saas.cnameTarget,
      fallbackOrigin: stagingSpec.saas.fallbackOrigin,
    });
    expect(manifest.resources.privateExports).toEqual({ name: "selinow-private-exports-staging" });
    expect(wranglerConfig.env.staging.r2_buckets).toEqual(expect.arrayContaining([
      { binding: "MEDIA", bucket_name: "selinow-media-staging" },
      { binding: "PRIVATE_EXPORTS", bucket_name: "selinow-private-exports-staging" },
    ]));
    expect(JSON.stringify({ manifest, wranglerConfig })).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  it("plans missing resources once and reuses the exact active contract", () => {
    const missing = planSaasConfiguration(stagingSpec, {
      dnsRecords: {},
      fallbackOrigin: null,
    });
    expect(missing.map((action) => action.action)).toEqual(["create", "create", "create"]);

    const exact = planSaasConfiguration(stagingSpec, {
      dnsRecords: {
        cnameTarget: [{
          content: "proxy-fallback.selinow.com.",
          id: "dns-cname",
          name: "customers.selinow.com",
          proxied: true,
          ttl: 1,
          type: "CNAME",
        }],
        fallbackOrigin: [{
          content: "100::",
          id: "dns-fallback",
          name: "proxy-fallback.selinow.com",
          proxied: true,
          ttl: 1,
          type: "AAAA",
        }],
      },
      fallbackOrigin: { origin: "proxy-fallback.selinow.com", status: "active" },
    });
    expect(exact.map((action) => action.action)).toEqual(["reuse", "reuse", "reuse"]);
    expect(exact.at(-1)).toMatchObject({ status: "active" });
  });

  it("updates owned drift but fails closed on a conflicting DNS type", () => {
    const actions = planSaasConfiguration(stagingSpec, {
      dnsRecords: {
        cnameTarget: [{
          content: "192.0.2.1",
          id: "unexpected-record",
          name: "customers.selinow.com",
          proxied: true,
          ttl: 1,
          type: "A",
        }],
        fallbackOrigin: [{
          content: "100::",
          id: "dns-fallback",
          name: "proxy-fallback.selinow.com",
          proxied: false,
          ttl: 1,
          type: "AAAA",
        }],
      },
      fallbackOrigin: { origin: "old-fallback.selinow.com", status: "active" },
    });

    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "update", key: "fallbackOrigin", kind: "dns" }),
      expect.objectContaining({ action: "conflict", key: "cnameTarget" }),
      expect.objectContaining({ action: "update", kind: "fallback_origin" }),
    ]));
  });

  it("rejects SaaS DNS targets outside the fixed platform contract", () => {
    expect(() => planSaasConfiguration({
      ...stagingSpec,
      saas: { ...stagingSpec.saas, cnameTarget: "customers.example.com" },
    }, { dnsRecords: {}, fallbackOrigin: null }))
      .toThrow("cloudflare_saas_hostname_outside_zone");
  });

  it("uses the fixed Cloudflare API origin and returns only safe error codes", async () => {
    let requestedUrl = "";
    const fetchImplementation: typeof fetch = (input) => {
      requestedUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      return Promise.resolve(new Response(JSON.stringify({
        errors: [{ code: 10_000, message: "test-token must not escape" }],
        success: false,
      }), {
        headers: { "content-type": "application/json" },
        status: 403,
      }));
    };

    const failure = await cloudflareApiRequest(
      "test-token",
      `/zones/${stagingSpec.zoneId}/dns_records`,
      { fetchImplementation },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("cloudflare_api_failed:403:10000");
    expect((failure as Error).message).not.toContain("test-token");
    expect(requestedUrl).toBe(
      `https://api.cloudflare.com/client/v4/zones/${stagingSpec.zoneId}/dns_records`,
    );
  });

  it("rejects staging provisioning on the first wrong-account identity check", async () => {
    const specification = JSON.parse(
      await readFile(new URL("../../infra/environments/staging.json", import.meta.url), "utf8"),
    ) as PlatformEnvironmentSpec;
    const runner = vi.fn((args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      expect(args).toEqual(["whoami", "--json"]);
      expect(options?.env).toMatchObject({
        CLOUDFLARE_ACCOUNT_ID: specification.accountId,
        CLOUDFLARE_API_TOKEN: "d1-token",
      });
      expect(options?.env).not.toHaveProperty("CLOUDFLARE_PLATFORM_API_TOKEN");
      expect(options?.env).not.toHaveProperty("CLOUDFLARE_ROUTE_AUDIT_API_TOKEN");
      return { stderr: "", stdout: "Account ID: 11111111111111111111111111111111" };
    });

    await expect(provision("staging", true, {
      environment: {
        CLOUDFLARE_D1_API_TOKEN: "d1-token",
        CLOUDFLARE_PLATFORM_API_TOKEN: "temporary-platform-token",
        CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "temporary-route-token",
        KEEP_ME: "must-not-forward",
      },
      platformToken: "platform-token",
      runWranglerImplementation: runner,
    })).rejects.toThrow("staging_account_identity_mismatch");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("pins every staging provisioning discovery to the admitted account", async () => {
    const specification = JSON.parse(
      await readFile(new URL("../../infra/environments/staging.json", import.meta.url), "utf8"),
    ) as PlatformEnvironmentSpec & {
      resources: PlatformEnvironmentSpec["resources"] & Record<
        "deadLetterQueue" | "integrationQueue" | "notificationQueue" | "platformCacheKv"
          | "privateExports" | "r2" | "sessionKv",
        string
      >;
    };
    const runner = vi.fn((args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      expect(options?.env).toMatchObject({
        CLOUDFLARE_ACCOUNT_ID: specification.accountId,
        CLOUDFLARE_API_TOKEN: "d1-token",
      });
      expect(options?.env).not.toHaveProperty("CLOUDFLARE_PLATFORM_API_TOKEN");
      expect(options?.env).not.toHaveProperty("CLOUDFLARE_ROUTE_AUDIT_API_TOKEN");
      if (args[0] === "whoami") {
        return { stderr: "", stdout: `Account ID: ${specification.accountId}` };
      }
      if (args[0] === "d1" && args[1] === "list") {
        return {
          stderr: "",
          stdout: JSON.stringify([{
            name: specification.resources.d1,
            uuid: STAGING_DATABASE_ID,
          }]),
        };
      }
      if (args[0] === "kv" && args[2] === "list") {
        return {
          stderr: "",
          stdout: JSON.stringify([
            { id: "cache-kv-id", title: specification.resources.platformCacheKv },
            { id: "session-kv-id", title: specification.resources.sessionKv },
          ]),
        };
      }
      if (args[0] === "r2" && args[2] === "list") {
        return {
          stderr: "",
          stdout: `name: ${specification.resources.r2}\nname: ${specification.resources.privateExports}\n`,
        };
      }
      if (args[0] === "queues" && args[1] === "list") {
        return {
          stderr: "",
          stdout: [
            specification.resources.integrationQueue,
            specification.resources.notificationQueue,
            specification.resources.deadLetterQueue,
          ].join("\n"),
        };
      }
      throw new Error(`unexpected_test_command:${args.join("_")}`);
    });
    const fetchImplementation = vi.fn<typeof fetch>((input, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      const url = new URL(typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url);
      if (url.pathname.endsWith("/dns_records")) {
        const name = url.searchParams.get("name");
        const record = specification.saas.dnsRecords.find((candidate) => candidate.name === name);
        return Promise.resolve(new Response(JSON.stringify({
          result: record ? [{ ...record, id: `dns-${record.key}` }] : [],
          success: true,
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        result: { origin: specification.saas.fallbackOrigin, status: "active" },
        success: true,
      }), { status: 200 }));
    });

    const result = await provision("staging", true, {
      environment: {
        CLOUDFLARE_D1_API_TOKEN: "d1-token",
        CLOUDFLARE_PLATFORM_API_TOKEN: "temporary-platform-token",
        CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "temporary-route-token",
        KEEP_ME: "must-not-forward",
      },
      fetchImplementation,
      platformToken: "platform-token",
      runWranglerImplementation: runner,
    });
    expect(result).toMatchObject({
      environment: "staging",
      ok: true,
    });
    expect(result.actions.every((action) => action.action === "reuse")).toBe(true);
    expect(runner).toHaveBeenCalledTimes(5);
    expect(runner.mock.calls.some(([args]) => args.includes("create"))).toBe(false);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("pins mocked resource creation and writes only the reconciled staging manifest", async () => {
    const specification = JSON.parse(
      await readFile(new URL("../../infra/environments/staging.json", import.meta.url), "utf8"),
    ) as PlatformEnvironmentSpec & {
      resources: PlatformEnvironmentSpec["resources"] & Record<
        "deadLetterQueue" | "integrationQueue" | "notificationQueue" | "platformCacheKv"
          | "privateExports" | "r2" | "sessionKv",
        string
      >;
    };
    let createdResourceCount = 0;
    const runner = vi.fn((args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      expect(options?.env).toMatchObject({
        CLOUDFLARE_ACCOUNT_ID: specification.accountId,
        CLOUDFLARE_API_TOKEN: "d1-token",
      });
      expect(options?.env).not.toHaveProperty("CLOUDFLARE_PLATFORM_API_TOKEN");
      expect(options?.env).not.toHaveProperty("CLOUDFLARE_ROUTE_AUDIT_API_TOKEN");
      if (args[0] === "whoami") {
        return { stderr: "", stdout: `Account ID: ${specification.accountId}` };
      }
      if (args.includes("create")) {
        createdResourceCount += 1;
        return { stderr: "", stdout: "created" };
      }
      const resourcesExist = createdResourceCount === 8;
      if (args[0] === "d1") {
        return {
          stderr: "",
          stdout: JSON.stringify(resourcesExist ? [{
            name: specification.resources.d1,
            uuid: STAGING_DATABASE_ID,
          }] : []),
        };
      }
      if (args[0] === "kv") {
        return {
          stderr: "",
          stdout: JSON.stringify(resourcesExist ? [
            { id: "cache-kv-id", title: specification.resources.platformCacheKv },
            { id: "session-kv-id", title: specification.resources.sessionKv },
          ] : []),
        };
      }
      if (args[0] === "r2") {
        return {
          stderr: "",
          stdout: resourcesExist
            ? `name: ${specification.resources.r2}\nname: ${specification.resources.privateExports}\n`
            : "",
        };
      }
      if (args[0] === "queues") {
        return {
          stderr: "",
          stdout: resourcesExist ? [
            specification.resources.integrationQueue,
            specification.resources.notificationQueue,
            specification.resources.deadLetterQueue,
          ].join("\n") : "",
        };
      }
      throw new Error(`unexpected_test_command:${args.join("_")}`);
    });
    const dnsRecords = new Map<string, Record<string, unknown>>();
    let fallbackOrigin: Record<string, unknown> | null = null;
    const fetchImplementation = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url);
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/dns_records") && method === "GET") {
        const record = dnsRecords.get(url.searchParams.get("name") ?? "");
        return Promise.resolve(new Response(JSON.stringify({
          result: record ? [record] : [],
          success: true,
        }), { status: 200 }));
      }
      if (url.pathname.endsWith("/dns_records") && method === "POST") {
        if (typeof init?.body !== "string") throw new Error("test_dns_body_missing");
        const record = JSON.parse(init.body) as Record<string, unknown>;
        if (typeof record.name !== "string") throw new Error("test_dns_name_missing");
        dnsRecords.set(record.name, { ...record, id: `dns-${String(dnsRecords.size + 1)}` });
        return Promise.resolve(new Response(JSON.stringify({ result: record, success: true }), {
          status: 200,
        }));
      }
      if (url.pathname.endsWith("/fallback_origin") && method === "PUT") {
        fallbackOrigin = {
          origin: specification.saas.fallbackOrigin,
          status: "active",
        };
        return Promise.resolve(new Response(JSON.stringify({
          result: fallbackOrigin,
          success: true,
        }), { status: 200 }));
      }
      if (url.pathname.endsWith("/fallback_origin") && fallbackOrigin) {
        return Promise.resolve(new Response(JSON.stringify({
          result: fallbackOrigin,
          success: true,
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        errors: [{ code: 1000 }],
        success: false,
      }), { status: 404 }));
    });
    const writeGeneratedConfigImplementation = vi.fn(() => Promise.resolve());

    const result = await provision("staging", false, {
      environment: {
        CLOUDFLARE_D1_API_TOKEN: "d1-token",
        CLOUDFLARE_PLATFORM_API_TOKEN: "temporary-platform-token",
        CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "temporary-route-token",
        KEEP_ME: "must-not-forward",
      },
      fetchImplementation,
      platformToken: "platform-token",
      runWranglerImplementation: runner,
      writeGeneratedConfigImplementation,
    });

    expect(createdResourceCount).toBe(8);
    expect(runner.mock.calls.filter(([args]) => args.includes("create"))).toHaveLength(8);
    expect(writeGeneratedConfigImplementation).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      environment: "staging",
      manifest: {
        accountId: specification.accountId,
        environment: "staging",
        resources: {
          d1: { id: STAGING_DATABASE_ID, name: specification.resources.d1 },
        },
        workerName: specification.workerName,
      },
      ok: true,
    });
  });

  it("requires an explicit operator token context", () => {
    expect(() => requireCloudflarePlatformToken({}))
      .toThrow("cloudflare_platform_api_token_missing");
    expect(requireCloudflarePlatformToken({
      CLOUDFLARE_PLATFORM_API_TOKEN: " scoped-token ",
    }))
      .toBe("scoped-token");
    expect(() => requireCloudflareRouteAuditToken({}))
      .toThrow("cloudflare_route_audit_api_token_missing");
    expect(requireCloudflareRouteAuditToken({
      CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: " route-audit-token ",
    }))
      .toBe("route-audit-token");
    expect(() => requireCloudflareWorkerDeployToken({}))
      .toThrow("cloudflare_worker_deploy_api_token_missing");
    expect(requireCloudflareWorkerDeployToken({
      CLOUDFLARE_WORKER_DEPLOY_API_TOKEN: " worker-deploy-token ",
    }))
      .toBe("worker-deploy-token");
  });

  it("keeps builds and Worker sinks on explicit environment allowlists", () => {
    const accountId = "abcdef0123456789abcdef0123456789";
    const source = {
      CLOUDFLARE_API_TOKEN: "ambient-token",
      CLOUDFLARE_D1_API_TOKEN: "d1-token",
      CLOUDFLARE_OAUTH_TOKEN: "ambient-oauth",
      CLOUDFLARE_WORKER_DEPLOY_API_TOKEN: "dedicated-deploy-token",
      DODO_PAYMENTS_API_KEY: "provider-secret",
      NODE_OPTIONS: "--require=operator-hook",
      PATH: "/bin",
      RELEASE_OPERATOR_NOTE: "must-not-forward",
    };
    const build = buildWorkerBuildEnvironment(source, "production");
    expect(build).toMatchObject({ CI: "1", CLOUDFLARE_ENV: "production", PATH: "/bin" });
    expect(build).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(build).not.toHaveProperty("CLOUDFLARE_D1_API_TOKEN");
    expect(build).not.toHaveProperty("DODO_PAYMENTS_API_KEY");
    expect(build).not.toHaveProperty("NODE_OPTIONS");
    expect(build).not.toHaveProperty("RELEASE_OPERATOR_NOTE");

    const sink = buildWorkerDeployEnvironment(source, accountId);
    expect(sink).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: "dedicated-deploy-token" });
    expect(sink).not.toHaveProperty("CLOUDFLARE_WORKER_DEPLOY_API_TOKEN");
    expect(sink).not.toHaveProperty("CLOUDFLARE_D1_API_TOKEN");
    expect(sink).not.toHaveProperty("CLOUDFLARE_OAUTH_TOKEN");
    expect(sink).not.toHaveProperty("DODO_PAYMENTS_API_KEY");
  });
});
