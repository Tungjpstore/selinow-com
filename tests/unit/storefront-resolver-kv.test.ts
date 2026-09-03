import { describe, expect, it } from "vitest";

import { purgeStorefrontResolverCache, purgeStorefrontResolverCacheForShop, resolveActiveStorefrontCacheKey } from "../../src/lib/storefront/cache";
import type { AppBindings } from "../../src/lib/platform/bindings";

type DomainRow = Record<string, unknown> | null;

function fakeKv() {
  const store = new Map<string, string>();
  const ops: string[] = [];
  return {
    store,
    ops,
    binding: {
      get(key: string) {
        ops.push(`get:${key}`);
        return Promise.resolve(store.get(key) ?? null);
      },
      put(key: string, value: string) {
        ops.push(`put:${key}`);
        store.set(key, value);
        return Promise.resolve(undefined);
      },
      delete(key: string) {
        ops.push(`delete:${key}`);
        store.delete(key);
        return Promise.resolve(undefined);
      },
    },
  };
}

function fakeDb(row: DomainRow) {
  let queries = 0;
  return {
    prepare() {
      return {
        bind() {
          return {
            first: () => {
              queries += 1;
              return Promise.resolve(row);
            },
          };
        },
      };
    },
    queries: () => queries,
  };
}

function activeDomainRow(): Record<string, unknown> {
  return {
    currentPeriodEnd: "2099-01-01T00:00:00.000Z",
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
    featureFlagsJson: JSON.stringify({ customDomain: true }),
  };
}

const request = { hostname: "Shop.Example.com", pathname: "/products/editor" };

describe("storefront resolver KV tier", () => {
  it("queries D1 and seeds KV on the first resolution", async () => {
    const kv = fakeKv();
    const db = fakeDb(activeDomainRow());
    const env = { PLATFORM_DB: db, PLATFORM_CACHE: kv.binding } as unknown as StorefrontResolverEnvLike;

    const key = await resolveActiveStorefrontCacheKey({ env, ...request });
    expect(key).toBe("https://storefront-cache.invalid/i/domain-current/v7-3/shop.example.com/vi-VN/products/editor");
    expect(db.queries()).toBe(1);

    const raw = kv.store.get("storefront-resolver:shop.example.com");
    expect(raw).toBeDefined();
    const stored = JSON.parse(raw as string) as { defaultLocale: string; domainId: string; version: string };
    expect(stored).toMatchObject({ defaultLocale: "vi", domainId: "domain-current", version: "7-3" });
  });

  it("serves the version-fenced key from KV without touching D1", async () => {
    const kv = fakeKv();
    kv.store.set("storefront-resolver:shop.example.com", JSON.stringify({ defaultLocale: "en", domainId: "domain-current", version: "7-3" }));
    const db = fakeDb(activeDomainRow());
    const env = { PLATFORM_DB: db, PLATFORM_CACHE: kv.binding } as unknown as StorefrontResolverEnvLike;

    const key = await resolveActiveStorefrontCacheKey({ env, ...request });
    expect(key).toBe("https://storefront-cache.invalid/i/domain-current/v7-3/shop.example.com/en/products/editor");
    expect(db.queries()).toBe(0);
  });

  it("does not seed KV when D1 refuses the resolution", async () => {
    const kv = fakeKv();
    const refused = { ...activeDomainRow(), featureFlagsJson: JSON.stringify({ customDomain: false }) };
    const db = fakeDb(refused);
    const env = { PLATFORM_DB: db, PLATFORM_CACHE: kv.binding } as unknown as StorefrontResolverEnvLike;

    await expect(resolveActiveStorefrontCacheKey({
      env,
      hostname: "shop.example.com",
      pathname: "/",
    })).resolves.toBeNull();
    expect(kv.store.size).toBe(0);
  });

  it("rejects malformed or unsafe KV entries and falls back to D1", async () => {
    const kv = fakeKv();
    kv.store.set("storefront-resolver:shop.example.com", JSON.stringify({ domainId: "DROP TABLE shops", version: "7-3", defaultLocale: "vi" }));
    const db = fakeDb(activeDomainRow());
    const env = { PLATFORM_DB: db, PLATFORM_CACHE: kv.binding } as unknown as StorefrontResolverEnvLike;

    const key = await resolveActiveStorefrontCacheKey({ env, ...request });
    expect(key).toContain("/i/domain-current/");
    expect(db.queries()).toBe(1);
  });

  it("purges the normalized hostname keys on demand", async () => {
    const kv = fakeKv();
    kv.store.set("storefront-resolver:shop.example.com", "{}");
    kv.store.set("storefront-resolver:other.example.com", "{}");

    await purgeStorefrontResolverCache({ PLATFORM_CACHE: kv.binding } as StorefrontResolverEnvLike, ["Shop.Example.com.", ""]);

    expect(kv.store.has("storefront-resolver:shop.example.com")).toBe(false);
    expect(kv.store.has("storefront-resolver:other.example.com")).toBe(true);
  });

  it("purges every hostname of a shop through the shop-scoped helper", async () => {
    const kv = fakeKv();
    kv.store.set("storefront-resolver:a.example.com", "{}");
    const database = {
      prepare() {
        return {
          bind() {
            return {
              all: () => Promise.resolve({ results: [{ hostname: "a.example.com" }, { hostname: "b.example.com" }] }),
            };
          },
        };
      },
    };
    const env = { PLATFORM_DB: database, PLATFORM_CACHE: kv.binding } as unknown as StorefrontResolverEnvLike;

    await purgeStorefrontResolverCacheForShop(env, "shop-internal");
    expect(kv.store.has("storefront-resolver:a.example.com")).toBe(false);
  });
});

type StorefrontResolverEnvLike = Parameters<typeof resolveActiveStorefrontCacheKey>[0]["env"] & Pick<AppBindings, "PLATFORM_DB">;
