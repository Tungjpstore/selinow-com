import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { setCatalogChannelVisibility } from "../../src/lib/catalog/channel-visibility";
import { getStorefrontCatalog, type StorefrontShop } from "../../src/lib/storefront/store";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = "2026-08-03T00:00:00.000Z";
const PRODUCT_A = "prd_11111111-1111-4111-8111-111111111111";
const PRODUCT_B = "prd_22222222-2222-4222-8222-222222222222";

class SqliteStatement {
  constructor(readonly database: DatabaseSync, readonly sql: string, readonly values: SQLInputValue[] = []) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values as SQLInputValue[]);
  }

  all(): Promise<{ results: unknown[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  first(): Promise<Record<string, unknown> | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as Record<string, unknown> | undefined) ?? null);
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

  batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => {
        const result = this.database.prepare(statement.sql).run(...statement.values);
        return { meta: { changes: Number(result.changes) } };
      });
      this.database.exec("COMMIT");
      return Promise.resolve(results);
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

function createRuntime(): { database: DatabaseSync; env: AppBindings } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, is_active, created_at, updated_at)
    VALUES ('plan-visibility', 'visibility', 'Visibility', '{}', '{}', 1, '${NOW}', '${NOW}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES
      ('shop-visibility-a', 'shop-visibility-public-a', 'visibility-a', 'Visibility A', 'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}'),
      ('shop-visibility-b', 'shop-visibility-public-b', 'visibility-b', 'Visibility B', 'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}');
    INSERT INTO shop_settings (shop_id, branding_json, storefront_json, version, low_stock_threshold, updated_at)
    VALUES ('shop-visibility-a', '{}', '{}', 1, 5, '${NOW}'), ('shop-visibility-b', '{}', '{}', 1, 5, '${NOW}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, created_at, updated_at)
    VALUES ('sub-visibility-a', 'shop-visibility-a', 'plan-visibility', 'active', '${NOW}', '${NOW}'),
      ('sub-visibility-b', 'shop-visibility-b', 'plan-visibility', 'active', '${NOW}', '${NOW}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-visibility-owner', 'owner@visibility.test', 'Owner', 'active', '${NOW}', '${NOW}'),
      ('user-visibility-manager', 'manager@visibility.test', 'Manager', 'active', '${NOW}', '${NOW}'),
      ('user-visibility-other', 'other@visibility.test', 'Other', 'active', '${NOW}', '${NOW}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('shop-visibility-a', 'user-visibility-owner', 'owner', 'active', '${NOW}', '${NOW}'),
      ('shop-visibility-a', 'user-visibility-manager', 'manager', 'active', '${NOW}', '${NOW}'),
      ('shop-visibility-b', 'user-visibility-other', 'owner', 'active', '${NOW}', '${NOW}');
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
    VALUES
      ('${PRODUCT_A}', 'shop-visibility-a', 'visible-a', 'Product A', '', 'active', 'manual', 1, '${NOW}', '${NOW}'),
      ('${PRODUCT_B}', 'shop-visibility-b', 'visible-b', 'Product B', '', 'active', 'manual', 1, '${NOW}', '${NOW}');
    INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
    VALUES ('var-visibility-a', 'shop-visibility-a', '${PRODUCT_A}', 'SKU-A', 'Default', '{}', 100, 'USD', 1, 10, 'active', 1, '${NOW}', '${NOW}');
  `);
  return {
    database,
    env: {
      IDENTIFIER_HMAC_SECRET: "visibility-identifier-secret",
      PLATFORM_DB: new SqliteD1(database) as unknown as D1Database,
      SESSION_SECRET: "visibility-session-secret",
    } as AppBindings,
  };
}

describe("catalog channel visibility", () => {
  it("backfills website, seeds enabled channels, and fails closed for absent channels", () => {
    const { database } = createRuntime();
    expect(database.prepare("SELECT channel_code, status FROM catalog_channel_visibility WHERE shop_id = ? AND product_id = ? ORDER BY channel_code").all("shop-visibility-a", PRODUCT_A)).toEqual([
      { channel_code: "website", status: "visible" },
    ]);
    database.prepare("INSERT INTO shop_channels (id, shop_id, channel_code, status, settings_json, version, created_at, updated_at) VALUES ('channel-mini-a', 'shop-visibility-a', 'telegram.mini_app', 'enabled', '{}', 1, ?, ?)").run(NOW, NOW);
    expect(database.prepare("SELECT status FROM catalog_channel_visibility WHERE shop_id = ? AND product_id = ? AND channel_code = 'telegram.mini_app'").get("shop-visibility-a", PRODUCT_A)).toEqual({ status: "visible" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_channel_visibility WHERE shop_id = ? AND product_id = ? AND channel_code = 'zalo.mini_app'").get("shop-visibility-a", PRODUCT_A)).toEqual({ count: 0 });
    expect(() => database.prepare("INSERT INTO catalog_channel_visibility (shop_id, product_id, channel_code, status, version, created_at, updated_at) VALUES ('shop-visibility-b', ?, 'website', 'visible', 1, ?, ?)").run(PRODUCT_A, NOW, NOW)).toThrow(/catalog_channel_visibility_scope_mismatch/u);
    expect(() => database.prepare("UPDATE catalog_channel_visibility SET status = 'hidden', version = 2, updated_at = ? WHERE shop_id = 'shop-visibility-a' AND product_id = ? AND channel_code = 'website'").run(NOW, PRODUCT_A)).toThrow(/catalog_channel_visibility_transition_invalid/u);
    expect(() => database.prepare("DELETE FROM catalog_channel_visibility WHERE shop_id = 'shop-visibility-a' AND product_id = ? AND channel_code = 'website'").run(PRODUCT_A)).toThrow(/catalog_channel_visibility_immutable/u);
  });

  it("supports owner/manager mutations, idempotent replay, and stale-version conflicts", async () => {
    const runtime = createRuntime();
    const first = await setCatalogChannelVisibility({
      channelCode: "zalo.mini_app",
      env: runtime.env,
      expectedVersion: 0,
      idempotencyKey: "visibility-write-0001",
      productId: PRODUCT_A,
      requestId: "request-visibility-0001",
      shopPublicId: "shop-visibility-public-a",
      userId: "user-visibility-owner",
      visible: true,
    });
    expect(first).toMatchObject({ replayed: false, projection: { channelCode: "zalo.mini_app", status: "visible", version: 1 } });
    const replay = await setCatalogChannelVisibility({
      channelCode: "zalo.mini_app",
      env: runtime.env,
      expectedVersion: 0,
      idempotencyKey: "visibility-write-0001",
      productId: PRODUCT_A,
      requestId: "request-visibility-0001",
      shopPublicId: "shop-visibility-public-a",
      userId: "user-visibility-owner",
      visible: true,
    });
    expect(replay).toMatchObject({ replayed: true, projection: { version: 1 } });
    await expect(setCatalogChannelVisibility({
      channelCode: "zalo.mini_app",
      env: runtime.env,
      expectedVersion: 0,
      idempotencyKey: "visibility-write-0001",
      productId: PRODUCT_A,
      requestId: "request-visibility-0002",
      shopPublicId: "shop-visibility-public-a",
      userId: "user-visibility-owner",
      visible: false,
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    const managerWrite = await setCatalogChannelVisibility({
      channelCode: "zalo.mini_app",
      env: runtime.env,
      expectedVersion: 1,
      idempotencyKey: "visibility-write-0002",
      productId: PRODUCT_A,
      requestId: "request-visibility-0003",
      shopPublicId: "shop-visibility-public-a",
      userId: "user-visibility-manager",
      visible: false,
    });
    expect(managerWrite.projection).toMatchObject({ status: "hidden", version: 2 });
    expect(runtime.database.prepare("SELECT action, resource_type, resource_id FROM audit_logs WHERE shop_id = ? AND resource_type = 'catalog_channel_visibility'").all("shop-visibility-a")).toEqual([
      { action: "catalog.channel_visibility.updated", resource_type: "catalog_channel_visibility", resource_id: PRODUCT_A },
      { action: "catalog.channel_visibility.updated", resource_type: "catalog_channel_visibility", resource_id: PRODUCT_A },
    ]);
    await expect(setCatalogChannelVisibility({
      channelCode: "zalo.mini_app",
      env: runtime.env,
      expectedVersion: 1,
      idempotencyKey: "visibility-write-0003",
      productId: PRODUCT_A,
      requestId: "request-visibility-0004",
      shopPublicId: "shop-visibility-public-a",
      userId: "user-visibility-owner",
      visible: true,
    })).rejects.toMatchObject({ code: "version_conflict", status: 409 });
    await expect(setCatalogChannelVisibility({
      channelCode: "unknown.channel",
      env: runtime.env,
      expectedVersion: 0,
      idempotencyKey: "visibility-write-0005",
      productId: PRODUCT_A,
      requestId: "request-visibility-0006",
      shopPublicId: "shop-visibility-public-a",
      userId: "user-visibility-owner",
      visible: true,
    })).rejects.toMatchObject({ code: "validation_failed", status: 400 });
    await expect(setCatalogChannelVisibility({
      channelCode: "zalo.mini_app",
      env: runtime.env,
      expectedVersion: 0,
      idempotencyKey: "visibility-write-0006",
      productId: PRODUCT_A,
      requestId: "request-visibility-0005",
      shopPublicId: "shop-visibility-public-b",
      userId: "user-visibility-other",
      visible: true,
    })).rejects.toMatchObject({ code: "resource_not_found", status: 404 });
  });

  it("does not expose products hidden from the website projection", async () => {
    const runtime = createRuntime();
    const now = "2026-08-03T00:00:00.001Z";
    runtime.database.prepare("UPDATE catalog_channel_visibility SET status = 'hidden', version = 2, updated_by_user_id = 'user-visibility-owner', updated_at = ? WHERE shop_id = 'shop-visibility-a' AND product_id = ? AND channel_code = 'website'").run(now, PRODUCT_A);
    const shop = {
      access: "live",
      content: { showExactStock: false },
      currency: "USD",
      id: "shop-visibility-a",
      lowStockThreshold: 5,
      status: "active",
      subscriptionState: "active",
    } as unknown as StorefrontShop;
    const catalog = await getStorefrontCatalog(runtime.env, shop);
    expect(catalog.products).toEqual([]);
  });
});
