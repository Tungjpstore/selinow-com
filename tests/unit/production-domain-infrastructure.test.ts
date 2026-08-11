import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

type Route = { custom_domain?: boolean; pattern?: string; zone_name?: string };

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

describe("production custom-domain infrastructure contract", () => {
  it("routes the external fallback to production and never staging", () => {
    const wrangler = readJson("wrangler.jsonc") as {
      env: { production: { routes: Route[] }; staging: { routes: Route[] } };
    };
    const production = wrangler.env.production.routes;
    const staging = wrangler.env.staging.routes;

    expect(production).toContainEqual({ pattern: "*/*", zone_name: "selinow.com" });
    expect(staging.some((route) => route.pattern === "*/*")).toBe(false);
    expect(staging.some((route) => route.custom_domain === true && route.pattern === "*/*")).toBe(false);
  });

  it("keeps production and staging resource bindings environment-bound", () => {
    type EnvironmentConfig = {
        name: string;
        d1_databases: Array<{ binding: string; database_name: string }>;
        r2_buckets: Array<{ binding: string; bucket_name: string }>;
        queues: { producers: Array<{ binding: string; queue: string }>; consumers: Array<{ queue: string }> };
        triggers: { crons: string[] };
    };
    const wrangler = readJson("wrangler.jsonc") as {
      env: { production: EnvironmentConfig; staging: EnvironmentConfig };
    };

    for (const environment of ["production", "staging"] as const) {
      const config = wrangler.env[environment];
      expect(config.name).toBe(`selinow-com-${environment}`);
      expect(config.d1_databases.find((binding) => binding.binding === "PLATFORM_DB")?.database_name).toBe(`selinow-${environment}`);
      expect(config.r2_buckets.map((binding) => binding.bucket_name)).toEqual(expect.arrayContaining([
        `selinow-media-${environment}`,
        `selinow-private-exports-${environment}`,
      ]));
      expect(config.queues.producers.map((binding) => binding.queue)).toEqual(expect.arrayContaining([
        `selinow-integration-${environment}`,
        `selinow-notification-${environment}`,
      ]));
      expect(config.queues.consumers.map((binding) => binding.queue)).toEqual(expect.arrayContaining([
        `selinow-integration-${environment}`,
        `selinow-notification-${environment}`,
        `selinow-dlq-${environment}`,
      ]));
      expect(config.triggers.crons).toHaveLength(1);
    }
  });

  it("requires the reviewed production route and Turnstile admission modes", () => {
    const production = readJson("infra/environments/production.json") as {
      routing: Record<string, string>;
      turnstile: Record<string, string>;
      saas: {
        cnameTarget: string;
        dnsRecords: Array<{
          content: string;
          key: string;
          name: string;
          proxied: boolean;
          ttl: number;
          type: string;
        }>;
        fallbackOrigin: string;
      };
    };
    expect(production.routing.externalCustomDomainFallbackRoute).toBe("*/*");
    expect(production.routing.externalCustomDomainStrategy).toBe("production_fallback_with_platform_staging_exceptions");
    expect(production.routing.routeHandoff).toBe("atomic_shared_zone_route_replacement");
    expect(production.routing.stagingExternalCustomDomainInventory).toBe("verified_none_active");
    expect(production.turnstile.externalCustomDomainAdmission).toBe("verified_before_domain_activation");
    expect(production.turnstile.externalCustomDomainStrategy).toBe("exact_hostname_admission_before_activation");
    expect(production.saas.cnameTarget).toBe("customers.selinow.com");
    expect(production.saas.dnsRecords).toEqual([
      {
        content: "100::",
        key: "fallbackOrigin",
        name: production.saas.fallbackOrigin,
        proxied: true,
        ttl: 1,
        type: "AAAA",
      },
      {
        content: production.saas.fallbackOrigin,
        key: "cnameTarget",
        name: production.saas.cnameTarget,
        proxied: true,
        ttl: 1,
        type: "CNAME",
      },
    ]);
  });
});
