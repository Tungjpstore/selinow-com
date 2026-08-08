import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { guardAnonymousCart, guardAnonymousCheckout } from "../../src/lib/storefront/abuse";
import type { StorefrontShop } from "../../src/lib/storefront/store";

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    const sqlValues = values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    });
    return new SqliteStatement(this.database, this.sql, sqlValues);
  }

  first<T>(): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.values) as T | undefined;
    return Promise.resolve(row ?? null);
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

type TestBindingOverrides = {
  APP_ENV?: "local" | "production";
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  STOREFRONT_CART_RATE_LIMIT?: string;
  STOREFRONT_CHECKOUT_RATE_LIMIT?: string;
  STOREFRONT_RATE_LIMIT_WINDOW_SECONDS?: string;
  STOREFRONT_TURNSTILE_THRESHOLD?: string;
};

function bindings(database: DatabaseSync, overrides: TestBindingOverrides = {}): AppBindings {
  return {
    APP_ENV: "local",
    IDENTIFIER_HMAC_SECRET: "identifier-secret-for-storefront-abuse-tests",
    PLATFORM_DB: {
      prepare(sql: string) {
        return new SqliteStatement(database, sql) as unknown as D1PreparedStatement;
      },
    } as D1Database,
    STOREFRONT_CART_RATE_LIMIT: "2",
    STOREFRONT_CHECKOUT_RATE_LIMIT: "2",
    STOREFRONT_RATE_LIMIT_WINDOW_SECONDS: "600",
    STOREFRONT_TURNSTILE_THRESHOLD: "100",
    TURNSTILE_SECRET_KEY: "",
    TURNSTILE_SITE_KEY: "",
    ...overrides,
  } as AppBindings;
}

function request(ip: string | null, userAgent?: string): Request {
  const headers = new Headers();
  if (ip !== null) headers.set("CF-Connecting-IP", ip);
  if (userAgent !== undefined) headers.set("User-Agent", userAgent);
  return new Request("https://signal.example.test/api/store/cart", { headers, method: "POST" });
}

function shop(id: string): StorefrontShop {
  return { currentHostname: "shop.example.com", id } as StorefrontShop;
}

describe("storefront anonymous request limits", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE shops (id TEXT PRIMARY KEY) STRICT;
      INSERT INTO shops (id) VALUES ('shop-a'), ('shop-b');
    `);
    database.exec(readFileSync(join(process.cwd(), "migrations/0008_storefront_abuse_controls.sql"), "utf8"));
    database.exec(`
      CREATE TABLE shop_domains (
        shop_id TEXT NOT NULL,
        hostname_normalized TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        ownership_verified_at TEXT,
        hostname_status TEXT,
        ssl_status TEXT,
        dns_status TEXT,
        delete_requested_at TEXT,
        deleted_at TEXT
      );
    `);
  });

  afterEach(() => {
    database.close();
  });

  it("shares one cart budget when the same client rotates or removes User-Agent", async () => {
    const env = bindings(database);
    await guardAnonymousCart({ env, request: request("198.51.100.10", "browser-a"), shop: shop("shop-a") });
    await guardAnonymousCart({ env, request: request("198.51.100.10", "browser-b"), shop: shop("shop-a") });
    await expect(guardAnonymousCart({ env, request: request("198.51.100.10"), shop: shop("shop-a") }))
      .rejects.toMatchObject({ code: "rate_limited", status: 429 });

    expect(database.prepare("SELECT COUNT(*) AS rows, MAX(request_count) AS requestCount FROM anonymous_request_limits").get())
      .toEqual({ requestCount: 3, rows: 1 });
  });

  it("keeps independent budgets for different Cloudflare client addresses", async () => {
    const env = bindings(database, { STOREFRONT_CART_RATE_LIMIT: "1" });
    await guardAnonymousCart({ env, request: request("198.51.100.20", "browser"), shop: shop("shop-a") });
    await guardAnonymousCart({ env, request: request("198.51.100.21", "browser"), shop: shop("shop-a") });
    await expect(guardAnonymousCart({ env, request: request("198.51.100.20", "changed"), shop: shop("shop-a") }))
      .rejects.toMatchObject({ code: "rate_limited", status: 429 });

    expect(database.prepare("SELECT COUNT(*) AS rows FROM anonymous_request_limits").get()).toEqual({ rows: 2 });
  });

  it("isolates the same address across shops and cart/checkout actions", async () => {
    const env = bindings(database, { STOREFRONT_CART_RATE_LIMIT: "1", STOREFRONT_CHECKOUT_RATE_LIMIT: "1" });
    const clientRequest = request("198.51.100.30", "browser");
    await guardAnonymousCart({ env, request: clientRequest, shop: shop("shop-a") });
    await guardAnonymousCart({ env, request: clientRequest, shop: shop("shop-b") });
    await guardAnonymousCheckout({ env, request: clientRequest, shop: shop("shop-a"), turnstileToken: null });

    await expect(guardAnonymousCart({ env, request: clientRequest, shop: shop("shop-a") }))
      .rejects.toMatchObject({ code: "rate_limited", status: 429 });
    await expect(guardAnonymousCheckout({ env, request: clientRequest, shop: shop("shop-a"), turnstileToken: null }))
      .rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(database.prepare("SELECT COUNT(*) AS rows FROM anonymous_request_limits").get()).toEqual({ rows: 3 });
  });

  it("uses one fail-safe bucket when the Cloudflare address header is unavailable", async () => {
    const env = bindings(database, { STOREFRONT_CART_RATE_LIMIT: "1" });
    await guardAnonymousCart({ env, request: request(null, "browser-a"), shop: shop("shop-a") });
    await expect(guardAnonymousCart({ env, request: request(null, "browser-b"), shop: shop("shop-a") }))
      .rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(database.prepare("SELECT COUNT(*) AS rows FROM anonymous_request_limits").get()).toEqual({ rows: 1 });
  });

  it("preserves the exact atomic count for concurrent requests", async () => {
    const env = bindings(database, { STOREFRONT_CART_RATE_LIMIT: "50" });
    await Promise.all(Array.from({ length: 24 }, (_, index) => guardAnonymousCart({
      env,
      request: request("198.51.100.40", `browser-${String(index)}`),
      shop: shop("shop-a"),
    })));

    expect(database.prepare("SELECT request_count AS requestCount FROM anonymous_request_limits").get())
      .toEqual({ requestCount: 24 });
  });

  it("admits production Turnstile only for an exact active custom hostname", async () => {
    database.exec(`
      INSERT INTO shop_domains (
        shop_id, hostname_normalized, type, status, ownership_verified_at,
        hostname_status, ssl_status, dns_status, delete_requested_at, deleted_at
      ) VALUES ('shop-a', 'shop.example.com', 'custom', 'active', '2026-07-26T00:00:00.000Z', 'active', 'active', 'active', NULL, NULL);
    `);
    const env = bindings(database, {
      APP_ENV: "production",
      STOREFRONT_CHECKOUT_RATE_LIMIT: "10",
      STOREFRONT_TURNSTILE_THRESHOLD: "1",
      TURNSTILE_SECRET_KEY: "0xSecretKeyThatLooksConfigured123456",
      TURNSTILE_SITE_KEY: "0xSiteKeyThatLooksConfigured123456",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      action: "storefront_checkout",
      hostname: "shop.example.com",
      success: true,
    }), { status: 200 }));
    await guardAnonymousCheckout({
      env,
      request: new Request("https://shop.example.com/api/store/checkout", { method: "POST" }),
      shop: shop("shop-a"),
      turnstileToken: null,
    });
    await expect(guardAnonymousCheckout({
      env,
      request: new Request("https://shop.example.com/api/store/checkout", { method: "POST" }),
      shop: shop("shop-a"),
      turnstileToken: "turnstile-token-123",
    })).resolves.toBeUndefined();
    fetchMock.mockRestore();
  });

  it("fails closed when production custom hostname readiness is incomplete", async () => {
    database.exec(`
      INSERT INTO shop_domains (
        shop_id, hostname_normalized, type, status, ownership_verified_at,
        hostname_status, ssl_status, dns_status, delete_requested_at, deleted_at
      ) VALUES ('shop-a', 'shop.example.com', 'custom', 'active', '2026-07-26T00:00:00.000Z', 'active', 'pending_validation', 'active', NULL, NULL);
    `);
    const env = bindings(database, {
      APP_ENV: "production",
      STOREFRONT_CHECKOUT_RATE_LIMIT: "10",
      STOREFRONT_TURNSTILE_THRESHOLD: "1",
      TURNSTILE_SECRET_KEY: "0xSecretKeyThatLooksConfigured123456",
      TURNSTILE_SITE_KEY: "0xSiteKeyThatLooksConfigured123456",
    });
    await guardAnonymousCheckout({
      env,
      request: new Request("https://shop.example.com/api/store/checkout", { method: "POST" }),
      shop: shop("shop-a"),
      turnstileToken: null,
    });
    await expect(guardAnonymousCheckout({
      env,
      request: new Request("https://shop.example.com/api/store/checkout", { method: "POST" }),
      shop: shop("shop-a"),
      turnstileToken: "turnstile-token-123",
    })).rejects.toMatchObject({ code: "turnstile_invalid", status: 403 });
  });
});
