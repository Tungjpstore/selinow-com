import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { issueApiCredential, type ApiCredentialScope } from "../../src/lib/api/credentials";
import type { AppBindings } from "../../src/lib/platform/bindings";

const bindings = vi.hoisted(() => ({ env: null as AppBindings | null }));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => {
    if (bindings.env === null) throw new Error("test_bindings_missing");
    return bindings.env;
  },
}));

import { GET as inventoryRoute } from "../../src/pages/api/v1/inventory";
import { GET as ordersRoute } from "../../src/pages/api/v1/orders";

const NOW = new Date("2026-07-29T06:00:00.000Z");
const SHOP_A_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000001";
const SHOP_B_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000002";

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values as SQLInputValue[]);
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: Record<string, SQLInputValue>[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const databases: DatabaseSync[] = [];
let credentialSequence = 0;

afterEach(() => {
  vi.useRealTimers();
  bindings.env = null;
  credentialSequence = 0;
  for (const database of databases.splice(0)) database.close();
});

function createRuntime(): { database: DatabaseSync; env: AppBindings } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  const now = NOW.toISOString();
  database.exec(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-public-api', 'business', 'Business', '{}', '{}', '${now}', '${now}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-owner-a', 'owner-a@example.test', 'Owner A', 'active', '${now}', '${now}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('shop-a', '${SHOP_A_PUBLIC_ID}', 'api-a', 'API Shop A', 'active', 'vi-VN', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}'),
      ('shop-b', '${SHOP_B_PUBLIC_ID}', 'api-b', 'API Shop B', 'active', 'en', 'USD', 'UTC', 1, '${now}', '${now}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('shop-a', 'user-owner-a', 'owner', 'active', '${now}', '${now}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, created_at, updated_at)
    VALUES
      ('subscription-a', 'shop-a', 'plan-public-api', 'active', '${now}', '${now}'),
      ('subscription-b', 'shop-b', 'plan-public-api', 'active', '${now}', '${now}');
    INSERT INTO shop_settings (
      shop_id, branding_json, storefront_json, order_expiry_minutes,
      low_stock_threshold, version, updated_at
    ) VALUES
      ('shop-a', '{}', '{}', 30, 2, 1, '${now}'),
      ('shop-b', '{}', '{}', 30, 2, 1, '${now}');
    INSERT INTO product_categories (id, shop_id, slug, name, description, sort_order, status, created_at, updated_at)
    VALUES
      ('cat-a', 'shop-a', 'active', 'Active category', 'Visible', 1, 'active', '${now}', '${now}'),
      ('cat-b', 'shop-b', 'other', 'Other category', 'Other tenant', 1, 'active', '${now}', '${now}');
    INSERT INTO products (
      id, shop_id, category_id, slug, title, description, status,
      fulfillment_type, version, created_at, updated_at
    ) VALUES
      ('prd-license', 'shop-a', 'cat-a', 'license', 'License product', 'Public description', 'active', 'license_key', 3, '${now}', '${now}'),
      ('prd-b', 'shop-b', 'cat-b', 'other-tenant', 'Other tenant product', 'Must not resolve', 'active', 'manual', 1, '${now}', '${now}');
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      compare_at_minor, currency, min_per_order, max_per_order, status,
      version, created_at, updated_at
    ) VALUES
      ('var-license', 'shop-a', 'prd-license', 'LIC-001', 'License variant', '{}', 12000, 15000, 'VND', 1, 3, 'active', 2, '${now}', '${now}'),
      ('var-manual', 'shop-a', 'prd-license', 'MAN-001', 'Manual variant', '{}', 5000, NULL, 'VND', 1, 1, 'active', 1, '${now}', '${now}'),
      ('var-b', 'shop-b', 'prd-b', 'OTHER-001', 'Other tenant variant', '{}', 1000, NULL, 'USD', 1, 1, 'active', 1, '${now}', '${now}');
    INSERT INTO inventory_batches (
      id, shop_id, variant_id, source, filename_sanitized, total_count,
      accepted_count, rejected_count, created_by_user_id, created_at
    ) VALUES ('batch-a', 'shop-a', 'var-license', 'paste', NULL, 3, 3, 0, 'user-owner-a', '${now}');
    INSERT INTO inventory_keys (
      id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
      key_version, key_fingerprint, reservation_token, created_at
    ) VALUES
      ('key-a-1', 'shop-a', 'var-license', 'batch-a', 'available', 'secret-ciphertext', 'secret-iv', 'v1', 'fingerprint-1', 'secret-reservation', '${now}'),
      ('key-a-2', 'shop-a', 'var-license', 'batch-a', 'reserved', 'secret-ciphertext-2', 'secret-iv-2', 'v1', 'fingerprint-2', 'secret-reservation-2', '${now}');
  `);
  database.prepare(`
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      compare_at_minor, currency, min_per_order, max_per_order, status,
      version, created_at, updated_at
    ) VALUES (?, 'shop-a', 'prd-license', ?, ?, '{}', 5000, NULL, 'VND', 1, 2, 'active', 1, ?, ?)
  `).run("var-old", "OLD-001", "Older variant", "2026-07-27T06:00:00.000Z", "2026-07-27T06:00:00.000Z");
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel,
      status, payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, customer_email_masked, checkout_subject_hash,
      order_token_hash, expires_at, created_at, updated_at
    ) VALUES (?, ?, 'shop-a', NULL, ?, ?, ?, ?, ?, ?, 0, ?, 'VND', 'vi-VN', ?, ?, ?, ?, ?, ?)
  `).run(
    "order-a-new", "ord_00000000-0000-4000-8000-000000000001", "SEL-A-001", "telegram",
    "processing", "paid", "fulfilled", 12000, 12000, "customer-secret@example.test",
    "secret-checkout-hash", "secret-order-token", "2026-08-01T06:00:00.000Z", NOW.toISOString(), NOW.toISOString(),
  );
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel,
      status, payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, customer_email_masked, checkout_subject_hash,
      order_token_hash, expires_at, created_at, updated_at
    ) VALUES (?, ?, 'shop-a', NULL, ?, 'web', ?, ?, ?, ?, 0, ?, 'VND', 'vi-VN', ?, ?, ?, ?, ?, ?)
  `).run(
    "order-a-old", "ord_00000000-0000-4000-8000-000000000002", "SEL-A-002",
    "completed", "paid", "fulfilled", 5000, 5000, "another-secret@example.test",
    "secret-checkout-hash-2", "secret-order-token-2", "2026-08-01T06:00:00.000Z", "2026-07-28T06:00:00.000Z", "2026-07-28T06:00:00.000Z",
  );
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel,
      status, payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, customer_email_masked, checkout_subject_hash,
      order_token_hash, expires_at, created_at, updated_at
    ) VALUES (?, ?, 'shop-b', NULL, ?, 'web', ?, ?, ?, ?, 0, ?, 'USD', 'en', ?, ?, ?, ?, ?, ?)
  `).run(
    "order-b", "ord_00000000-0000-4000-8000-000000000099", "SEL-B-001",
    "processing", "paid", "fulfilled", 99999, 99999, "tenant-b@example.test",
    "tenant-b-checkout", "tenant-b-token", "2026-08-02T06:00:00.000Z", "2026-08-02T06:00:00.000Z", "2026-08-02T06:00:00.000Z",
  );
  database.prepare(`
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title,
      variant_title, sku, unit_price_minor, quantity, line_total_minor,
      fulfillment_type, created_at
    ) VALUES (?, 'shop-a', ?, 'prd-license', 'var-license', ?, ?, ?, ?, ?, ?, 'license_key', ?)
  `).run("item-a-new", "order-a-new", "Public product", "License variant", "LIC-001", 12000, 1, 12000, NOW.toISOString());
  database.prepare(`
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title,
      variant_title, sku, unit_price_minor, quantity, line_total_minor,
      fulfillment_type, created_at
    ) VALUES (?, 'shop-a', ?, 'prd-license', 'var-old', ?, ?, ?, ?, ?, ?, 'license_key', ?)
  `).run("item-a-old", "order-a-old", "Older public product", "Older variant", "OLD-001", 5000, 1, 5000, "2026-07-28T06:00:00.000Z");
  database.prepare(`
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title,
      variant_title, sku, unit_price_minor, quantity, line_total_minor,
      fulfillment_type, created_at
    ) VALUES (?, 'shop-b', ?, 'prd-b', 'var-b', ?, ?, ?, ?, ?, ?, 'manual', ?)
  `).run("item-b", "order-b", "Tenant B private product", "Tenant B variant", "OTHER-001", 99999, 1, 99999, "2026-08-02T06:00:00.000Z");
  const env = {
    APP_ENV: "local",
    IDENTIFIER_HMAC_SECRET: "public-api-identifier-secret",
    PLATFORM_DB: new SqliteD1(database) as unknown as D1Database,
    SESSION_SECRET: "public-api-session-secret",
  } as AppBindings;
  bindings.env = env;
  return { database, env };
}

async function issueCredential(env: AppBindings, scopes: ApiCredentialScope[] = ["inventory:read"]): Promise<string> {
  credentialSequence += 1;
  const result = await issueApiCredential({
    env,
    expiresAt: null,
    idempotencyKey: `public-api-read-${String(credentialSequence)}-${scopes.join("-")}`,
    name: "Public read integration",
    now: NOW,
    requestId: "request-public-api-read",
    scopes,
    shopPublicId: SHOP_A_PUBLIC_ID,
    userId: "user-owner-a",
  });
  if (result.token === null) throw new Error("public_api_token_missing");
  return result.token;
}

function routeContext(request: Request): Parameters<typeof inventoryRoute>[0] {
  return { locals: { requestId: "request-public-api-read-route" }, params: {}, request } as never;
}

function authRequest(path: string, token: string): Request {
  return new Request(`https://api.example.test${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return response.json();
}

describe("public inventory read API", () => {
  it("returns tenant-bound aggregate inventory with pagination and redacts secrets", async () => {
    const { env } = createRuntime();
    const token = await issueCredential(env, ["inventory:read"]);
    const first = await inventoryRoute(routeContext(authRequest("/api/v1/inventory?limit=1", token)));
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(first.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(first.headers.get("X-RateLimit-Limit")).toBe("60");
    const firstBody = await jsonBody(first);
    const firstData = (firstBody.data as { inventory: { items: Array<Record<string, unknown>>; limit: number; nextCursor: string | null }; shop: { publicId: string } });
    expect(firstData.shop.publicId).toBe(SHOP_A_PUBLIC_ID);
    expect(firstData.inventory.limit).toBe(1);
    expect(firstData.inventory.items).toHaveLength(1);
    expect(firstData.inventory.items[0]).toMatchObject({ variantId: "var-manual", availableCount: 0, stockState: "out_of_stock" });
    expect(firstData.inventory.items[0]).not.toHaveProperty("ciphertextB64");
    expect(firstData.inventory.nextCursor).toEqual(expect.any(String));

    const second = await inventoryRoute(routeContext(authRequest(
      `/api/v1/inventory?limit=1&cursor=${encodeURIComponent(firstData.inventory.nextCursor as string)}`,
      token,
    )));
    const secondBody = await jsonBody(second);
    const secondData = (secondBody.data as { inventory: { items: Array<Record<string, unknown>>; nextCursor: string | null } }).inventory;
    expect(second.status).toBe(200);
    expect(secondData.items[0]).toMatchObject({ variantId: "var-license", availableCount: 1, reservedCount: 1, stockState: "low_stock" });
    expect(secondData.items[0]).not.toHaveProperty("keyFingerprint");
    expect(secondData.nextCursor).toEqual(expect.any(String));

    const third = await inventoryRoute(routeContext(authRequest(
      `/api/v1/inventory?limit=1&cursor=${encodeURIComponent(secondData.nextCursor as string)}`,
      token,
    )));
    const thirdBody = await jsonBody(third);
    const thirdData = (thirdBody.data as { inventory: { items: Array<Record<string, unknown>>; nextCursor: string | null } }).inventory;
    expect(thirdData.items[0]).toMatchObject({ variantId: "var-old", stockState: "out_of_stock" });
    expect(thirdData.nextCursor).toBeNull();
    const serialized = JSON.stringify(firstBody) + JSON.stringify(secondBody) + JSON.stringify(thirdBody);
    expect(serialized).not.toContain("secret-ciphertext");
    expect(serialized).not.toContain("secret-iv");
    expect(serialized).not.toContain("fingerprint-1");
    expect(serialized).not.toContain(SHOP_B_PUBLIC_ID);
    expect(serialized).not.toContain("OTHER-001");
  });

  it("enforces scope, query validation, tenant state, and rate limits", async () => {
    const { database, env } = createRuntime();
    const shopOnlyToken = await issueCredential(env, ["shop:read"]);
    const denied = await inventoryRoute(routeContext(authRequest("/api/v1/inventory", shopOnlyToken)));
    expect(denied.status).toBe(403);
    expect((await jsonBody(denied)).code).toBe("authorization_denied");

    const token = await issueCredential(env, ["inventory:read"]);
    for (const query of ["?limit=0", "?limit=101", "?limit=nope", "?cursor=invalid-cursor-value", "?shopPublicId=other"]) {
      const response = await inventoryRoute(routeContext(authRequest(`/api/v1/inventory${query}`, token)));
      expect(response.status).toBe(400);
      expect((await jsonBody(response)).code).toBe("validation_failed");
    }
    const duplicate = await inventoryRoute(routeContext(authRequest("/api/v1/inventory?limit=2&limit=3", token)));
    expect(duplicate.status).toBe(400);
    expect((await jsonBody(duplicate)).issues).toContain("duplicate_query_field");
    const unknown = await inventoryRoute(routeContext(authRequest(
      `/api/v1/inventory?shopPublicId=${encodeURIComponent(SHOP_B_PUBLIC_ID)}`,
      token,
    )));
    expect(unknown.status).toBe(400);
    expect((await jsonBody(unknown)).issues).toContain("query_field_unknown");

    database.prepare("UPDATE shops SET status = 'suspended' WHERE id = 'shop-a'").run();
    const suspended = await inventoryRoute(routeContext(authRequest("/api/v1/inventory", token)));
    expect(suspended.status).toBe(403);
    expect((await jsonBody(suspended)).code).toBe("tenant_suspended");
    database.prepare("UPDATE shops SET status = 'active' WHERE id = 'shop-a'").run();
    database.prepare("UPDATE shop_subscriptions SET state = 'suspended' WHERE shop_id = 'shop-a'").run();
    const subscriptionDenied = await inventoryRoute(routeContext(authRequest("/api/v1/inventory", token)));
    expect(subscriptionDenied.status).toBe(402);
    expect((await jsonBody(subscriptionDenied)).code).toBe("subscription_required");
  });

  it("returns a rate-limit response without leaking implementation details", async () => {
    const { database, env } = createRuntime();
    const token = await issueCredential(env, ["inventory:read"]);
    const credentialPublicId = token.slice("sln_local_".length, token.indexOf("."));
    const credential = database.prepare("SELECT id, token_hash AS tokenHash FROM api_credentials WHERE public_id = ?")
      .get(credentialPublicId) as { id: string; tokenHash: string };
    const limiterNow = new Date();
    vi.useFakeTimers();
    vi.setSystemTime(limiterNow);
    const windowStartedAt = new Date(Math.floor(limiterNow.getTime() / 60_000) * 60_000);
    const windowEndsAt = new Date(windowStartedAt.getTime() + 60_000);
    database.prepare(`
      INSERT INTO security_rate_limits (
        id, shop_id, scope_key, action, subject_hash, window_started_at,
        window_ends_at, request_count, blocked_count, version, created_at, updated_at
      ) VALUES (?, 'shop-a', 'api-credential:${credential.id}', 'public_api_v1', ?, ?, ?, 60, 0, 1, ?, ?)
    `).run(
      "limit-inventory",
      credential.tokenHash,
      windowStartedAt.toISOString(),
      windowEndsAt.toISOString(),
      limiterNow.toISOString(),
      limiterNow.toISOString(),
    );
    const response = await inventoryRoute(routeContext(authRequest("/api/v1/inventory", token)));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect((await jsonBody(response)).code).toBe("rate_limited");
  });
});

describe("public orders read API", () => {
  it("returns paginated tenant orders without customer, payment-provider, or token data", async () => {
    const { env } = createRuntime();
    const token = await issueCredential(env, ["orders:read"]);
    const first = await ordersRoute(routeContext(authRequest("/api/v1/orders?limit=1", token)));
    expect(first.status).toBe(200);
    const firstBody = await jsonBody(first);
    const firstData = (firstBody.data as { orders: { items: Array<Record<string, unknown>>; limit: number; nextCursor: string | null }; shop: { publicId: string } });
    expect(firstData.shop.publicId).toBe(SHOP_A_PUBLIC_ID);
    expect(firstData.orders.limit).toBe(1);
    expect(firstData.orders.items[0]).toMatchObject({
      orderId: "ord_00000000-0000-4000-8000-000000000001",
      orderNumber: "SEL-A-001",
      paymentStatus: "paid",
      itemCount: 1,
      totalMinor: 12000,
    });
    expect(firstData.orders.items[0]).not.toHaveProperty("customerEmailMasked");
    expect(firstData.orders.items[0]).not.toHaveProperty("sourceChannel");
    expect(firstData.orders.nextCursor).toEqual(expect.any(String));

    const second = await ordersRoute(routeContext(authRequest(
      `/api/v1/orders?limit=1&cursor=${encodeURIComponent(firstData.orders.nextCursor as string)}`,
      token,
    )));
    const secondBody = await jsonBody(second);
    const secondData = (secondBody.data as { orders: { items: Array<Record<string, unknown>>; nextCursor: string | null } }).orders;
    expect(second.status).toBe(200);
    expect(secondData.items[0]).toMatchObject({
      orderId: "ord_00000000-0000-4000-8000-000000000002",
      orderNumber: "SEL-A-002",
      itemCount: 1,
    });
    expect(secondData.nextCursor).toBeNull();
    const serialized = JSON.stringify(firstBody) + JSON.stringify(secondBody);
    expect(serialized).not.toContain("customer-secret@example.test");
    expect(serialized).not.toContain("another-secret@example.test");
    expect(serialized).not.toContain("secret-checkout-hash");
    expect(serialized).not.toContain("secret-order-token");
    expect(serialized).not.toContain("telegram");
    expect(serialized).not.toContain(SHOP_B_PUBLIC_ID);
    expect(serialized).not.toContain("SEL-B-001");
  });

  it("enforces the dedicated scope and rejects malformed or duplicate pagination fields", async () => {
    const { env } = createRuntime();
    const inventoryToken = await issueCredential(env, ["inventory:read"]);
    const denied = await ordersRoute(routeContext(authRequest("/api/v1/orders", inventoryToken)));
    expect(denied.status).toBe(403);
    expect((await jsonBody(denied)).code).toBe("authorization_denied");

    const token = await issueCredential(env, ["orders:read"]);
    for (const query of ["?limit=0", "?limit=101", "?limit=nope", "?cursor=invalid-cursor-value", "?shopPublicId=other"]) {
      const response = await ordersRoute(routeContext(authRequest(`/api/v1/orders${query}`, token)));
      expect(response.status).toBe(400);
      expect((await jsonBody(response)).code).toBe("validation_failed");
    }
    const duplicate = await ordersRoute(routeContext(authRequest("/api/v1/orders?cursor=a&cursor=b", token)));
    expect(duplicate.status).toBe(400);
    expect((await jsonBody(duplicate)).issues).toContain("duplicate_query_field");
  });

  it("preserves suspended, subscription, and rate-limit guards", async () => {
    const { database, env } = createRuntime();
    const token = await issueCredential(env, ["orders:read"]);
    database.prepare("UPDATE shops SET status = 'suspended' WHERE id = 'shop-a'").run();
    const suspended = await ordersRoute(routeContext(authRequest("/api/v1/orders", token)));
    expect(suspended.status).toBe(403);
    expect((await jsonBody(suspended)).code).toBe("tenant_suspended");
    database.prepare("UPDATE shops SET status = 'active' WHERE id = 'shop-a'").run();
    database.prepare("UPDATE shop_subscriptions SET state = 'suspended' WHERE shop_id = 'shop-a'").run();
    const subscriptionDenied = await ordersRoute(routeContext(authRequest("/api/v1/orders", token)));
    expect(subscriptionDenied.status).toBe(402);
    expect((await jsonBody(subscriptionDenied)).code).toBe("subscription_required");

    database.prepare("UPDATE shop_subscriptions SET state = 'active' WHERE shop_id = 'shop-a'").run();
    const credentialPublicId = token.slice("sln_local_".length, token.indexOf("."));
    const credential = database.prepare("SELECT id, token_hash AS tokenHash FROM api_credentials WHERE public_id = ?")
      .get(credentialPublicId) as { id: string; tokenHash: string };
    const limiterNow = new Date();
    vi.useFakeTimers();
    vi.setSystemTime(limiterNow);
    const windowStartedAt = new Date(Math.floor(limiterNow.getTime() / 60_000) * 60_000);
    const windowEndsAt = new Date(windowStartedAt.getTime() + 60_000);
    database.prepare(`
      INSERT INTO security_rate_limits (
        id, shop_id, scope_key, action, subject_hash, window_started_at,
        window_ends_at, request_count, blocked_count, version, created_at, updated_at
      ) VALUES (?, 'shop-a', 'api-credential:${credential.id}', 'public_api_v1', ?, ?, ?, 60, 0, 1, ?, ?)
    `).run(
      "limit-orders",
      credential.tokenHash,
      windowStartedAt.toISOString(),
      windowEndsAt.toISOString(),
      limiterNow.toISOString(),
      limiterNow.toISOString(),
    );
    const rateLimited = await ordersRoute(routeContext(authRequest("/api/v1/orders", token)));
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get("Retry-After")).toBe("60");
    expect((await jsonBody(rateLimited)).code).toBe("rate_limited");
  });
});
