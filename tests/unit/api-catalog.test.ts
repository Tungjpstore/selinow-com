import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { issueApiCredential } from "../../src/lib/api/credentials";
import type { AppBindings } from "../../src/lib/platform/bindings";

const bindings = vi.hoisted(() => ({ env: null as AppBindings | null }));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => {
    if (bindings.env === null) throw new Error("test_bindings_missing");
    return bindings.env;
  },
}));

import { GET as catalogRoute } from "../../src/pages/api/v1/catalog";

const NOW = new Date("2026-07-29T06:00:00.000Z");
const PAID_PERIOD_END = "2099-01-01T00:00:00.000Z";
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

afterEach(() => {
  bindings.env = null;
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
    VALUES ('plan-api-catalog', 'business', 'Business', '{}', '{}', '${now}', '${now}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-owner-a', 'owner-a@example.test', 'Owner A', 'active', '${now}', '${now}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('shop-a', '${SHOP_A_PUBLIC_ID}', 'catalog-a', 'Catalog Shop A', 'active',
        'vi-VN', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}'),
      ('shop-b', '${SHOP_B_PUBLIC_ID}', 'catalog-b', 'Catalog Shop B', 'active',
        'en', 'USD', 'UTC', 1, '${now}', '${now}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('shop-a', 'user-owner-a', 'owner', 'active', '${now}', '${now}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at)
    VALUES
      ('subscription-a', 'shop-a', 'plan-api-catalog', 'active', '${PAID_PERIOD_END}', '${now}', '${now}'),
      ('subscription-b', 'shop-b', 'plan-api-catalog', 'active', '${PAID_PERIOD_END}', '${now}', '${now}');
    INSERT INTO shop_settings (
      shop_id, branding_json, storefront_json, order_expiry_minutes,
      low_stock_threshold, version, updated_at
    ) VALUES
      ('shop-a', '{}', '{}', 30, 2, 1, '${now}'),
      ('shop-b', '{}', '{}', 30, 2, 1, '${now}');
    INSERT INTO product_categories (id, shop_id, slug, name, description, sort_order, status, created_at, updated_at)
    VALUES
      ('cat-a', 'shop-a', 'active', 'Active category', 'Visible', 1, 'active', '${now}', '${now}'),
      ('cat-draft', 'shop-a', 'draft', 'Draft category', 'Hidden', 2, 'draft', '${now}', '${now}'),
      ('cat-b', 'shop-b', 'other', 'Other tenant category', 'Private tenant boundary', 1, 'active', '${now}', '${now}');
    INSERT INTO products (
      id, shop_id, category_id, slug, title, description, status,
      fulfillment_type, version, created_at, updated_at
    ) VALUES
      ('prd-license', 'shop-a', 'cat-a', 'license', 'License product', 'Public description', 'active',
        'license_key', 3, '${now}', '${now}'),
      ('prd-manual', 'shop-a', 'cat-a', 'manual', 'Manual product', 'Manual description', 'active',
        'manual', 1, '${now}', '${now}'),
      ('prd-draft', 'shop-a', 'cat-a', 'draft', 'Draft product', 'Hidden description', 'draft',
        'license_key', 1, '${now}', '${now}'),
      ('prd-b', 'shop-b', 'cat-b', 'other-tenant', 'Other tenant product', 'Must not resolve', 'active',
        'manual', 1, '${now}', '${now}');
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      compare_at_minor, currency, min_per_order, max_per_order, status,
      version, created_at, updated_at
    ) VALUES
      ('var-license', 'shop-a', 'prd-license', 'LIC-001', 'License variant', '{"edition":"pro"}',
        12000, 15000, 'VND', 1, 3, 'active', 2, '${now}', '${now}'),
      ('var-manual', 'shop-a', 'prd-manual', 'MAN-001', 'Manual variant', '{}',
        5000, NULL, 'VND', 1, 1, 'active', 1, '${now}', '${now}'),
      ('var-archived', 'shop-a', 'prd-license', 'LIC-ARCHIVED', 'Archived variant', '{}',
        1000, NULL, 'VND', 1, 1, 'archived', 1, '${now}', '${now}'),
      ('var-draft', 'shop-a', 'prd-draft', 'DRAFT-001', 'Draft variant', '{}',
        1000, NULL, 'VND', 1, 1, 'active', 1, '${now}', '${now}'),
      ('var-b', 'shop-b', 'prd-b', 'OTHER-001', 'Other tenant variant', '{}',
        1000, NULL, 'USD', 1, 1, 'active', 1, '${now}', '${now}');
    INSERT INTO inventory_batches (
      id, shop_id, variant_id, source, filename_sanitized, total_count,
      accepted_count, rejected_count, created_by_user_id, created_at
    ) VALUES ('batch-a', 'shop-a', 'var-license', 'paste', NULL, 3, 3, 0, 'user-owner-a', '${now}');
    INSERT INTO inventory_keys (
      id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
      key_version, key_fingerprint, created_at
    ) VALUES
      ('key-a-1', 'shop-a', 'var-license', 'batch-a', 'available', 'secret-ciphertext', 'secret-iv',
        'v1', 'fingerprint-1', '${now}'),
      ('key-a-2', 'shop-a', 'var-license', 'batch-a', 'reserved', 'secret-ciphertext-2', 'secret-iv-2',
        'v1', 'fingerprint-2', '${now}');
  `);
  const env = {
    APP_ENV: "local",
    IDENTIFIER_HMAC_SECRET: "api-catalog-identifier-secret",
    PLATFORM_DB: new SqliteD1(database) as unknown as D1Database,
    SESSION_SECRET: "api-catalog-session-secret",
  } as AppBindings;
  bindings.env = env;
  return { database, env };
}

async function issueCatalogCredential(env: AppBindings, scopes: ("catalog:read" | "shop:read")[] = ["catalog:read"]): Promise<string> {
  const result = await issueApiCredential({
    env,
    expiresAt: null,
    idempotencyKey: `catalog-api-${scopes.join("-")}`,
    name: "Catalog integration",
    now: NOW,
    requestId: "request-api-catalog",
    scopes,
    shopPublicId: SHOP_A_PUBLIC_ID,
    userId: "user-owner-a",
  });
  if (result.token === null) throw new Error("catalog_token_missing");
  return result.token;
}

function routeContext(request: Request): Parameters<typeof catalogRoute>[0] {
  return { locals: { requestId: "request-api-catalog-route" }, params: {}, request } as never;
}

describe("public catalog API", () => {
  it("returns only active tenant catalog data and never exposes exact inventory or private fields", async () => {
    const { env } = createRuntime();
    const token = await issueCatalogCredential(env);
    const response = await catalogRoute(routeContext(new Request(
      `https://api.example.test/api/v1/catalog?shopPublicId=${SHOP_B_PUBLIC_ID}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("59");
    const body: {
      data: {
        catalog: {
          categories: { id: string; status?: string }[];
          products: { id: string; variants: Record<string, unknown>[] }[];
        };
        shop: { publicId: string };
      };
    } = await response.json();
    expect(body.data.shop.publicId).toBe(SHOP_A_PUBLIC_ID);
    expect(body.data.catalog.categories.map((category) => category.id)).toEqual(["cat-a"]);
    expect(body.data.catalog.products.map((product) => product.id)).toEqual(["prd-license", "prd-manual"]);
    expect(body.data.catalog.products[0]?.variants[0]).toMatchObject({
      currency: "VND",
      id: "var-license",
      stockState: "low_stock",
    });
    expect(body.data.catalog.products[0]?.variants[0]).not.toHaveProperty("availableStock");
    expect(body.data.catalog.products[1]?.variants[0]).toMatchObject({ stockState: "available" });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret-ciphertext");
    expect(serialized).not.toContain("private-digital-assets/");
    expect(serialized).not.toContain("fingerprint-1");
  });

  it("requires the dedicated scope and preserves suspended/subscription gates", async () => {
    const { database, env } = createRuntime();
    const shopOnlyToken = await issueCatalogCredential(env, ["shop:read"]);
    const denied = await catalogRoute(routeContext(new Request(
      "https://api.example.test/api/v1/catalog",
      { headers: { Authorization: `Bearer ${shopOnlyToken}` } },
    )));
    expect(denied.status).toBe(403);

    const token = await issueCatalogCredential(env);
    database.prepare("UPDATE shops SET status = 'suspended' WHERE id = 'shop-a'").run();
    const suspended = await catalogRoute(routeContext(new Request(
      "https://api.example.test/api/v1/catalog",
      { headers: { Authorization: `Bearer ${token}` } },
    )));
    expect(suspended.status).toBe(403);

    database.prepare("UPDATE shops SET status = 'active' WHERE id = 'shop-a'").run();
    database.prepare("UPDATE shop_subscriptions SET state = 'suspended' WHERE shop_id = 'shop-a'").run();
    const subscriptionDenied = await catalogRoute(routeContext(new Request(
      "https://api.example.test/api/v1/catalog",
      { headers: { Authorization: `Bearer ${token}` } },
    )));
    expect(subscriptionDenied.status).toBe(402);
  });
});
