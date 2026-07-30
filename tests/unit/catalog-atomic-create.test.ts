import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createProductWithInitialVariant } from "../../src/lib/catalog/store";
import type { AppBindings } from "../../src/lib/platform/bindings";

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
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(): SqliteD1 {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const filename of [
    "migrations/0001_platform_foundation.sql",
    "migrations/0002_tenant_auth_subscription.sql",
    "migrations/0003_catalog_inventory_orders.sql",
  ]) {
    database.exec(readFileSync(filename, "utf8"));
  }
  const now = "2026-07-29T00:00:00.000Z";
  database.prepare(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-test', 'test', 'Test', '{}', '{}', ?, ?)
  `).run(now, now);
  const users: Array<[string, string]> = [["user-a", "owner-a@example.test"], ["user-b", "owner-b@example.test"]];
  for (const [userId, email] of users) {
    database.prepare(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(userId, email, userId, now, now);
  }
  const shops: Array<[string, string, string]> = [
    ["shop-a", SHOP_A_PUBLIC_ID, "user-a"],
    ["shop-b", SHOP_B_PUBLIC_ID, "user-b"],
  ];
  for (const [shopId, publicId, userId] of shops) {
    database.prepare(`
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency, timezone,
        readiness_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
    `).run(shopId, publicId, shopId, shopId, now, now);
    database.prepare(`
      INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
      VALUES (?, ?, 'owner', 'active', ?, ?)
    `).run(shopId, userId, now, now);
    database.prepare(`
      INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, created_at, updated_at)
      VALUES (?, ?, 'plan-test', 'active', ?, ?)
    `).run(`sub-${shopId}`, shopId, now, now);
  }
  return new SqliteD1(database);
}

function envFor(database: SqliteD1): AppBindings {
  return {
    PLATFORM_DB: database as unknown as D1Database,
    SESSION_SECRET: "catalog-atomic-create-session-secret",
  } as unknown as AppBindings;
}

function createInput(database: SqliteD1) {
  return {
    data: {
      categoryId: null,
      description: "Safe description",
      fulfillmentType: "license_key" as const,
      slug: "atomic-product",
      status: "draft" as const,
      title: "Atomic product",
    },
    env: envFor(database),
    idempotencyKey: "catalog-atomic-create-0001",
    initialVariant: {
      compareAtMinor: null,
      currency: "VND",
      maxPerOrder: 10,
      minPerOrder: 1,
      optionsJson: "{}",
      priceMinor: 199000,
      sku: "ATOMIC-001",
      status: "active" as const,
      title: "Standard",
    },
    requestId: "request-catalog-create",
    shopPublicId: SHOP_A_PUBLIC_ID,
    userId: "user-a",
  };
}

describe("atomic product and initial variant creation", () => {
  it("commits one tenant-scoped product, variant, idempotency receipt and audit receipt", async () => {
    const database = createDatabase();
    const first = await createProductWithInitialVariant(createInput(database));
    const replay = await createProductWithInitialVariant(createInput(database));

    expect(first.created).toBe(true);
    expect(replay).toEqual({ ...first, created: false });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM products WHERE shop_id = 'shop-a'").get()).toEqual({ count: 1 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM product_variants WHERE shop_id = 'shop-a' AND product_id = ?").get(first.product.id)).toEqual({ count: 1 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE actor_user_id = 'user-a'").get()).toEqual({ count: 1 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE shop_id = 'shop-a' AND action = 'catalog.product_with_variant.created'").get()).toEqual({ count: 1 });

    await expect(createProductWithInitialVariant({
      ...createInput(database),
      data: { ...createInput(database).data, title: "Conflicting retry" },
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("rolls the product back when the initial variant cannot be inserted", async () => {
    const database = createDatabase();
    const now = "2026-07-29T00:00:00.000Z";
    database.database.prepare(`
      INSERT INTO products (
        id, shop_id, slug, title, description, status, fulfillment_type,
        version, created_at, updated_at
      ) VALUES ('existing-product', 'shop-a', 'existing-product', 'Existing', '',
        'draft', 'license_key', 1, ?, ?)
    `).run(now, now);
    database.database.prepare(`
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor,
        currency, min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES ('existing-variant', 'shop-a', 'existing-product', 'DUPLICATE-SKU',
        'Existing', '{}', 1000, 'VND', 1, 10, 'active', 1, ?, ?)
    `).run(now, now);

    await expect(createProductWithInitialVariant({
      ...createInput(database),
      initialVariant: { ...createInput(database).initialVariant, sku: "DUPLICATE-SKU" },
    })).rejects.toMatchObject({ code: "catalog_conflict", status: 409 });

    expect(database.database.prepare("SELECT COUNT(*) AS count FROM products WHERE slug = 'atomic-product'").get()).toEqual({ count: 0 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get()).toEqual({ count: 0 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM audit_logs").get()).toEqual({ count: 0 });
  });

  it("rejects cross-tenant creation before any catalog write", async () => {
    const database = createDatabase();
    await expect(createProductWithInitialVariant({
      ...createInput(database),
      shopPublicId: SHOP_B_PUBLIC_ID,
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM products").get()).toEqual({ count: 0 });
  });

  it("requires an active initial variant when the product is created active", async () => {
    const database = createDatabase();
    await expect(createProductWithInitialVariant({
      ...createInput(database),
      data: { ...createInput(database).data, status: "active" },
      initialVariant: { ...createInput(database).initialVariant, status: "suspended" },
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["active_variant_required"], status: 409 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM products").get()).toEqual({ count: 0 });
  });
});
