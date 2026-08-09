import { describe, expect, it } from "vitest";

import { isStorefrontCacheCandidate, resolveActiveStorefrontCacheKey } from "../../src/lib/storefront/cache";
import type { AppBindings } from "../../src/lib/platform/bindings";

type DomainRow = {
  domainId: string;
  domainValidationMetadataJson: string;
  domainVersion: number;
  hostnameNormalized: string;
  publishedVersion: number;
  defaultLocale: string;
  domainType: "custom" | "platform_subdomain";
  shopStatus: string;
  status: string;
  subscriptionState: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
} | null;

function fakeEnvironment(row: DomainRow): { env: Pick<AppBindings, "PLATFORM_DB">; queries: () => { sql: string; values: unknown[] }[] } {
  const recorded: { sql: string; values: unknown[] }[] = [];
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          recorded.push({ sql, values });
          return { first: () => Promise.resolve(row) };
        },
      };
    },
  };
  return {
    env: { PLATFORM_DB: database } as unknown as Pick<AppBindings, "PLATFORM_DB">,
    queries: () => recorded,
  };
}

const cacheKeyInput = {
  hostname: "Shop.Example.com.",
  pathname: "/products/editor",
  search: "?ref=telegram",
};

function activeDomain(overrides: Partial<Exclude<DomainRow, null>> = {}): Exclude<DomainRow, null> {
  return {
    domainId: "domain-current",
    domainValidationMetadataJson: JSON.stringify({
      turnstile: {
        checkedAt: new Date(Date.now() - 60_000).toISOString(),
        hostname: "shop.example.com",
        mode: "operator_managed",
        source: "cloudflare_widget_domains",
        status: "active",
      },
    }),
    domainVersion: 7,
    defaultLocale: "vi",
    domainType: "custom",
    hostnameNormalized: "shop.example.com",
    publishedVersion: 3,
    shopStatus: "active",
    status: "active",
    subscriptionState: "active",
    trialEndsAt: null,
    graceEndsAt: null,
    ...overrides,
  };
}

describe("storefront cache domain gate", () => {
  it("builds a versioned key only after D1 confirms the domain is active", async () => {
    const { env, queries } = fakeEnvironment(activeDomain());
    const key = await resolveActiveStorefrontCacheKey({ env, ...cacheKeyInput });

    expect(key).toBe("https://storefront-cache.invalid/i/domain-current/v7-3/shop.example.com/vi-VN/products/editor?ref=telegram");
    expect(queries()).toHaveLength(1);
    expect(queries()[0]?.values).toEqual(["shop.example.com"]);
    expect(queries()[0]?.sql).toContain("shop_domains.status = 'active'");
    expect(queries()[0]?.sql).toContain("shop_domains.deleted_at IS NULL");
    expect(queries()[0]?.sql).toContain("shop_domains.type = 'platform_subdomain'");
    expect(queries()[0]?.sql).toContain("shop_domains.ownership_verified_at IS NOT NULL");
    expect(queries()[0]?.sql).toContain("$.turnstile.status");
    expect(queries()[0]?.sql).toContain("$.turnstile.hostname");
    expect(queries()[0]?.sql).toContain("$.turnstile.checkedAt");
    expect(queries()[0]?.sql).toContain("'-12 hours'");
    expect(queries()[0]?.sql).toContain("shops.status = 'active'");
    expect(queries()[0]?.sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(queries()[0]?.sql).toContain("trial_ends_at");
    expect(queries()[0]?.sql).toContain("grace_ends_at");
  });

  it("uses the authoritative shop default when no request locale hint is present", async () => {
    const { env, queries } = fakeEnvironment(activeDomain({ defaultLocale: "en" }));
    const key = await resolveActiveStorefrontCacheKey({
      env,
      hostname: "shop.example.com",
      pathname: "/products/editor",
    });

    expect(key).toContain("/shop.example.com/en/products/editor");
    expect(queries()[0]?.sql).toContain("shops.default_locale AS defaultLocale");
  });

  it("keeps an explicit request locale ahead of the shop default", async () => {
    const key = await resolveActiveStorefrontCacheKey({
      env: fakeEnvironment(activeDomain({ defaultLocale: "vi-VN" })).env,
      hostname: "shop.example.com",
      locale: "en",
      pathname: "/products/editor",
    });

    expect(key).toContain("/shop.example.com/en/products/editor");
  });

  it.each(["suspended", "deleted"])("refuses a stale cache key for a %s domain", async (status) => {
    const { env } = fakeEnvironment(activeDomain({ status }));
    await expect(resolveActiveStorefrontCacheKey({ env, ...cacheKeyInput })).resolves.toBeNull();
  });

  it("refuses stale cache for a suspended shop or ineligible current subscription", async () => {
    await expect(resolveActiveStorefrontCacheKey({ env: fakeEnvironment(activeDomain({ shopStatus: "suspended" })).env, ...cacheKeyInput })).resolves.toBeNull();
    for (const subscriptionState of ["suspended", "grace_period", "canceled"]) {
      await expect(resolveActiveStorefrontCacheKey({ env: fakeEnvironment(activeDomain({ subscriptionState })).env, ...cacheKeyInput })).resolves.toBeNull();
    }
    await expect(resolveActiveStorefrontCacheKey({ env: fakeEnvironment(activeDomain({ subscriptionState: null })).env, ...cacheKeyInput })).resolves.toBeNull();
  });

  it.each(["trialing", "active", "past_due"])("allows the %s subscription state", async (subscriptionState) => {
    const key = await resolveActiveStorefrontCacheKey({
      env: fakeEnvironment(activeDomain({
        graceEndsAt: subscriptionState === "past_due" ? "2099-01-01T00:00:00.000Z" : null,
        subscriptionState,
        trialEndsAt: subscriptionState === "trialing" ? "2099-01-01T00:00:00.000Z" : null,
      })).env,
      ...cacheKeyInput,
    });
    expect(key).toContain("/i/domain-current/v7-3/shop.example.com/");
  });

  it("misses a stale cache object after the hostname is reassigned", async () => {
    const oldKey = await resolveActiveStorefrontCacheKey({
      env: fakeEnvironment(activeDomain({ domainId: "domain-old", domainVersion: 2, publishedVersion: 1 })).env,
      ...cacheKeyInput,
    });
    const replacementKey = await resolveActiveStorefrontCacheKey({
      env: fakeEnvironment(activeDomain({ domainId: "domain-new", domainVersion: 2, publishedVersion: 1 })).env,
      ...cacheKeyInput,
    });
    const sharedCache = new Map([[oldKey, "old tenant storefront"]]);

    expect(replacementKey).not.toBe(oldKey);
    expect(sharedCache.get(replacementKey)).toBeUndefined();
  });

  it("changes the cache namespace when the domain or published settings version changes", async () => {
    const versionSeven = await resolveActiveStorefrontCacheKey({ env: fakeEnvironment(activeDomain()).env, ...cacheKeyInput });
    const versionEight = await resolveActiveStorefrontCacheKey({ env: fakeEnvironment(activeDomain({ domainVersion: 8 })).env, ...cacheKeyInput });
    const settingsFour = await resolveActiveStorefrontCacheKey({ env: fakeEnvironment(activeDomain({ publishedVersion: 4 })).env, ...cacheKeyInput });

    expect(versionSeven).not.toBe(versionEight);
    expect(versionSeven).not.toBe(settingsFour);
    expect(versionEight).toContain("/v8-3/");
    expect(settingsFour).toContain("/v7-4/");
  });

  it("fails closed for missing, mismatched or invalid domain state", async () => {
    await expect(resolveActiveStorefrontCacheKey({ env: fakeEnvironment(null).env, ...cacheKeyInput })).resolves.toBeNull();
    await expect(resolveActiveStorefrontCacheKey({ env: fakeEnvironment(activeDomain({ hostnameNormalized: "other.example.com" })).env, ...cacheKeyInput })).resolves.toBeNull();
    await expect(resolveActiveStorefrontCacheKey({ env: fakeEnvironment(activeDomain({ domainId: "" })).env, ...cacheKeyInput })).resolves.toBeNull();
    await expect(resolveActiveStorefrontCacheKey({ env: fakeEnvironment(activeDomain({ domainVersion: 0 })).env, ...cacheKeyInput })).resolves.toBeNull();
    await expect(resolveActiveStorefrontCacheKey({ env: fakeEnvironment(activeDomain({ publishedVersion: 0 })).env, ...cacheKeyInput })).resolves.toBeNull();
    await expect(resolveActiveStorefrontCacheKey({
      env: fakeEnvironment(activeDomain({ domainValidationMetadataJson: "{}" })).env,
      ...cacheKeyInput,
    })).resolves.toBeNull();
    await expect(resolveActiveStorefrontCacheKey({
      env: fakeEnvironment(activeDomain({
        domainValidationMetadataJson: JSON.stringify({
          turnstile: {
            checkedAt: new Date(Date.now() - 13 * 60 * 60_000).toISOString(),
            hostname: "shop.example.com",
            mode: "operator_managed",
            source: "cloudflare_widget_domains",
            status: "active",
          },
        }),
      })).env,
      ...cacheKeyInput,
    })).resolves.toBeNull();
  });

  it("keeps non-storefront and local requests outside the Cache API path", () => {
    expect(isStorefrontCacheCandidate({ appEnv: "staging", hostKind: "tenant-candidate", method: "GET", pathname: "/" })).toBe(true);
    expect(isStorefrontCacheCandidate({ appEnv: "staging", hostKind: "tenant-candidate", method: "GET", pathname: "/assets/app.css" })).toBe(false);
    expect(isStorefrontCacheCandidate({ appEnv: "staging", hostKind: "reserved", method: "GET", pathname: "/" })).toBe(false);
    expect(isStorefrontCacheCandidate({ appEnv: "staging", hostKind: "api", method: "GET", pathname: "/" })).toBe(false);
    expect(isStorefrontCacheCandidate({ appEnv: "staging", hostKind: "tenant-candidate", method: "POST", pathname: "/" })).toBe(false);
    expect(isStorefrontCacheCandidate({ appEnv: "local", hostKind: "tenant-candidate", method: "GET", pathname: "/" })).toBe(false);
  });
});
