import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { createShop, getShopForMember, updateShopProfile } from "../../src/lib/tenants/store";

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

function createD1(database: DatabaseSync): D1Database {
  return {
    async batch(statements: D1PreparedStatement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(sql: string) {
      return new SqliteStatement(database, sql) as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function applyMigrations(database: DatabaseSync, maximumVersion = Number.POSITIVE_INFINITY): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= maximumVersion)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
}

function createEnv(database: DatabaseSync): AppBindings {
  return {
    DEFAULT_CURRENCY: "VND",
    DEFAULT_LOCALE: "vi",
    DEFAULT_TIMEZONE: "Asia/Ho_Chi_Minh",
    PLATFORM_BASE_DOMAIN: "staging.selinow.test",
    PLATFORM_DB: createD1(database),
    SESSION_SECRET: "test-session-secret-for-shop-country-service",
  } as unknown as AppBindings;
}

function insertUser(database: DatabaseSync, id: string, email: string): void {
  const now = "2026-07-29T00:00:00.000Z";
  database.prepare(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(id, email, id, now, now);
}

describe("shop country configuration service", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    insertUser(database, "user-a", "a@example.test");
    insertUser(database, "user-b", "b@example.test");
    env = createEnv(database);
  });

  afterEach(() => {
    database.close();
  });

  async function createOwnedShop(input: { idempotencyKey: string; slug: string; userId: string }) {
    return createShop({
      env,
      idempotencyKey: input.idempotencyKey,
      name: `Shop ${input.slug}`,
      planCode: "store",
      requestId: `request-${input.slug}`,
      slug: input.slug,
      userId: input.userId,
    });
  }

  it("normalizes explicit ISO countries at creation and replays the same durable projection", async () => {
    const first = await createShop({
      businessCountry: " us ",
      currency: " usd ",
      env,
      idempotencyKey: "shop-country-create-a",
      merchantCountry: "jp",
      name: "Global Shop",
      planCode: "store",
      requestId: "request-create-a",
      slug: "global-shop",
      userId: "user-a",
    });
    const replay = await createShop({
      businessCountry: "US",
      currency: "USD",
      env,
      idempotencyKey: "shop-country-create-a",
      merchantCountry: "JP",
      name: "Global Shop",
      planCode: "store",
      requestId: "request-create-a-replay",
      slug: "global-shop",
      userId: "user-a",
    });

    expect(first.created).toBe(true);
    expect(first.shop).toMatchObject({ businessCountry: "US", currency: "USD", defaultLocale: "vi-VN", merchantCountry: "JP" });
    expect(replay).toEqual({ created: false, shop: first.shop });
    expect(database.prepare(`
      SELECT business_country_code AS businessCountry, currency, merchant_country_code AS merchantCountry
      FROM shops WHERE public_id = ?
    `).get(first.shop.publicId)).toEqual({ businessCountry: "US", currency: "USD", merchantCountry: "JP" });
  });

  it("updates countries through a tenant-scoped mutation and permits an explicit unknown state", async () => {
    const shopA = await createOwnedShop({ idempotencyKey: "shop-country-owner-a", slug: "owner-a", userId: "user-a" });
    const shopB = await createOwnedShop({ idempotencyKey: "shop-country-owner-b", slug: "owner-b", userId: "user-b" });

    const configured = await updateShopProfile({
      businessCountry: "de",
      env,
      merchantCountry: "sg",
      requestId: "request-country-update",
      shopPublicId: shopA.shop.publicId,
      userId: "user-a",
    });
    expect(configured).toMatchObject({ businessCountry: "DE", merchantCountry: "SG" });

    const cleared = await updateShopProfile({
      businessCountry: null,
      env,
      requestId: "request-country-clear",
      shopPublicId: shopA.shop.publicId,
      userId: "user-a",
    });
    expect(cleared).toMatchObject({ businessCountry: null, merchantCountry: "SG" });
    await expect(updateShopProfile({
      businessCountry: "FR",
      env,
      requestId: "request-cross-tenant",
      shopPublicId: shopA.shop.publicId,
      userId: "user-b",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });

    const reloadedA = await getShopForMember({ capability: "shop:read", env, shopPublicId: shopA.shop.publicId, userId: "user-a" });
    const reloadedB = await getShopForMember({ capability: "shop:read", env, shopPublicId: shopB.shop.publicId, userId: "user-b" });
    expect(reloadedA.shop).toMatchObject({ businessCountry: null, merchantCountry: "SG" });
    expect(reloadedB.shop).toMatchObject({ businessCountry: null, merchantCountry: null });
    expect(database.prepare(`
      SELECT json_extract(safe_metadata_json, '$.changedFields') AS changedFields
      FROM audit_logs WHERE shop_id = (
        SELECT id FROM shops WHERE public_id = ?
      ) AND action = 'shop.updated' ORDER BY rowid DESC LIMIT 1
    `).get(shopA.shop.publicId)).toEqual({ changedFields: '["businessCountry"]' });
  });

  it("rejects non-ISO and user-assigned country codes before mutation", async () => {
    const shop = await createOwnedShop({ idempotencyKey: "shop-country-validation", slug: "validation", userId: "user-a" });

    await expect(updateShopProfile({
      businessCountry: "ZZ",
      env,
      requestId: "request-invalid-business",
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["business_country_invalid"], status: 400 });
    await expect(updateShopProfile({
      env,
      merchantCountry: "XK",
      requestId: "request-invalid-merchant",
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["merchant_country_invalid"], status: 400 });
    expect(database.prepare(`
      SELECT business_country_code AS businessCountry, merchant_country_code AS merchantCountry
      FROM shops WHERE public_id = ?
    `).get(shop.shop.publicId)).toEqual({ businessCountry: null, merchantCountry: null });
  });

  it.each(["USD", "EUR", "JPY", "VND"])("accepts supported shop currency %s", async (currency) => {
    const shop = await createOwnedShop({ idempotencyKey: `shop-currency-${currency}`, slug: `currency-${currency.toLowerCase()}`, userId: "user-a" });
    const updated = await updateShopProfile({
      currency: currency.toLowerCase(),
      env,
      requestId: `request-currency-${currency}`,
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    });
    expect(updated.currency).toBe(currency);
    expect(database.prepare("SELECT currency FROM shops WHERE public_id = ?").get(shop.shop.publicId))
      .toEqual({ currency });
  });

  it("rejects unsupported explicit and environment-default currencies", async () => {
    const shop = await createOwnedShop({ idempotencyKey: "shop-currency-reject", slug: "currency-reject", userId: "user-a" });
    await expect(updateShopProfile({
      currency: "CAD",
      env,
      requestId: "request-currency-reject",
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["currency_invalid"], status: 400 });
    await expect(updateShopProfile({
      defaultLocale: "fr-FR",
      env,
      requestId: "request-locale-reject",
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["locale_invalid"], status: 400 });

    const invalidDefaultEnv = { ...env, DEFAULT_CURRENCY: "CAD" } as unknown as AppBindings;
    await expect(createShop({
      env: invalidDefaultEnv,
      idempotencyKey: "shop-invalid-default-currency",
      name: "Invalid Currency",
      planCode: "store",
      requestId: "request-invalid-default-currency",
      slug: "invalid-default-currency",
      userId: "user-b",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["currency_invalid"], status: 400 });
  });

  it("does not strand tenant variants when changing the shop currency", async () => {
    const shop = await createOwnedShop({ idempotencyKey: "shop-currency-variant", slug: "currency-variant", userId: "user-a" });
    const now = "2026-07-29T00:00:00.000Z";
    database.prepare(`
      INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
      VALUES ('product-currency', (SELECT id FROM shops WHERE public_id = ?), 'license', 'License', '', 'draft', 'manual', 1, ?, ?)
    `).run(shop.shop.publicId, now, now);
    database.prepare(`
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor, currency,
        min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES ('variant-currency', (SELECT id FROM shops WHERE public_id = ?), 'product-currency', 'SKU', 'License', '{}', 100, 'VND', 1, 1, 'active', 1, ?, ?)
    `).run(shop.shop.publicId, now, now);

    await expect(updateShopProfile({
      currency: "USD",
      env,
      requestId: "request-currency-variant",
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["currency_mismatch"], status: 409 });
    expect(database.prepare("SELECT currency FROM shops WHERE public_id = ?").get(shop.shop.publicId))
      .toEqual({ currency: "VND" });
  });

  it("accepts the supported locale aliases and canonicalizes the stored shop default", async () => {
    const shop = await createShop({
      defaultLocale: "en-US",
      env,
      idempotencyKey: "shop-default-locale",
      name: "Locale Shop",
      planCode: "store",
      requestId: "request-default-locale",
      slug: "locale-shop",
      userId: "user-a",
    });
    expect(shop.shop.defaultLocale).toBe("en");
    const updated = await updateShopProfile({
      defaultLocale: "vi",
      env,
      requestId: "request-default-locale-update",
      shopPublicId: shop.shop.publicId,
      userId: "user-a",
    });
    expect(updated.defaultLocale).toBe("vi-VN");
    expect(database.prepare("SELECT default_locale AS defaultLocale FROM shops WHERE public_id = ?").get(shop.shop.publicId))
      .toEqual({ defaultLocale: "vi-VN" });
  });

  it("reads legacy pre-0031 membership projections with unknown countries", async () => {
    const legacyDatabase = new DatabaseSync(":memory:");
    try {
      applyMigrations(legacyDatabase, 30);
      insertUser(legacyDatabase, "legacy-user", "legacy@example.test");
      const now = "2026-07-29T00:00:00.000Z";
      legacyDatabase.prepare(`
        INSERT INTO shops (
          id, public_id, slug, name, status, default_locale, currency, timezone,
          readiness_version, created_at, updated_at
        ) VALUES ('legacy-shop', 'legacy-public', 'legacy', 'Legacy', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
      `).run(now, now);
      legacyDatabase.prepare(`
        INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
        VALUES ('legacy-shop', 'legacy-user', 'owner', 'active', ?, ?)
      `).run(now, now);
      legacyDatabase.prepare(`
        INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, created_at, updated_at)
        VALUES ('legacy-sub', 'legacy-shop', 'plan_store_v1', 'active', ?, ?)
      `).run(now, now);

      const legacy = await getShopForMember({
        capability: "shop:read",
        env: createEnv(legacyDatabase),
        shopPublicId: "legacy-public",
        userId: "legacy-user",
      });
      expect(legacy.shop).toMatchObject({ businessCountry: null, merchantCountry: null });
    } finally {
      legacyDatabase.close();
    }
  });
});
