import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { resolveStorefrontShop } from "../../src/lib/storefront/store";
import { getSellerStorefrontSettings, publishSellerStorefrontSettings, updateSellerStorefrontSettings } from "../../src/lib/tenants/storefront-settings";

class SqliteStatement {
  private values: SQLInputValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values as SQLInputValue[];
    return this;
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

function migrationFiles(maximumVersion: number): string[] {
  return readdirSync(join(process.cwd(), "migrations"))
    .filter((filename) => filename.endsWith(".sql") && Number(filename.slice(0, 4)) <= maximumVersion)
    .sort();
}

function createDatabase(maximumVersion: number): SqliteD1 {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const filename of migrationFiles(maximumVersion)) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  return new SqliteD1(database);
}

function insertShop(database: DatabaseSync, input: { id: string; publicId: string; slug: string; status: string }): void {
  const now = "2026-07-28T00:00:00.000Z";
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(input.id, input.publicId, input.slug, `Shop ${input.slug}`, input.status, now, now);
}

function appEnv(database: SqliteD1): AppBindings {
  return {
    API_ORIGIN: "https://api.selinow.com",
    DASHBOARD_ORIGIN: "https://app.selinow.com",
    DEFAULT_LOCALE: "vi",
    PLATFORM_BASE_DOMAIN: "selinow.com",
    PLATFORM_DB: database as unknown as D1Database,
    PLATFORM_ORIGIN: "https://selinow.com",
  } as unknown as AppBindings;
}

describe("storefront draft publication migration", () => {
  it("applies after 0001-0028 and backfills only previously public shops deterministically", () => {
    const database = createDatabase(28).database;
    for (const shop of [
      { id: "shop-active", publicId: "public-active", slug: "active-shop", status: "active" },
      { id: "shop-draft", publicId: "public-draft", slug: "draft-shop", status: "draft" },
      { id: "shop-suspended", publicId: "public-suspended", slug: "suspended-shop", status: "suspended" },
    ]) insertShop(database, shop);

    const rows = [
      ["shop-active", '{"primaryColor":"#176B5B"}', '{"headline":"Active"}', 4, "2026-07-01T00:00:00.000Z"],
      ["shop-draft", '{"primaryColor":"#5B5CEB"}', '{"headline":"Private draft"}', 3, "2026-07-02T00:00:00.000Z"],
      ["shop-suspended", '{"primaryColor":"#0B1020"}', '{"headline":"Suspended"}', 2, "2026-07-03T00:00:00.000Z"],
    ] as const;
    for (const row of rows) {
      database.prepare(`
        INSERT INTO shop_settings (shop_id, branding_json, storefront_json, version, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(...row);
    }

    database.exec(readFileSync("migrations/0029_storefront_draft_publication.sql", "utf8"));

    expect(database.prepare(`
      SELECT published_branding_json AS branding, published_storefront_json AS storefront,
        published_version AS version, published_at AS publishedAt
      FROM shop_settings WHERE shop_id = 'shop-active'
    `).get()).toEqual({
      branding: '{"primaryColor":"#176B5B"}',
      publishedAt: "2026-07-01T00:00:00.000Z",
      storefront: '{"headline":"Active"}',
      version: 4,
    });
    expect(database.prepare(`
      SELECT published_branding_json AS branding, published_storefront_json AS storefront,
        published_version AS version, published_at AS publishedAt
      FROM shop_settings WHERE shop_id = 'shop-draft'
    `).get()).toEqual({ branding: null, publishedAt: null, storefront: null, version: 0 });
    expect(database.prepare("SELECT published_version AS version FROM shop_settings WHERE shop_id = 'shop-suspended'").get()).toEqual({ version: 2 });
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("tenant storefront draft contract", () => {
  it("keeps draft writes tenant-bound, rejects stale versions, and serves only the published snapshot", async () => {
    const database = createDatabase(29);
    database.database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
    const now = "2026-07-28T00:00:00.000Z";
    database.database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
      .run("user-a", "a@example.test", "Owner A", now, now);
    database.database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
      .run("user-b", "b@example.test", "Owner B", now, now);
    insertShop(database.database, { id: "shop-a", publicId: "public-a", slug: "seller-a", status: "active" });
    insertShop(database.database, { id: "shop-b", publicId: "public-b", slug: "seller-b", status: "active" });

    for (const [shopId, userId, subscriptionId] of [["shop-a", "user-a", "sub-a"], ["shop-b", "user-b", "sub-b"]] as const) {
      database.database.prepare("INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'owner', 'active', ?, ?)")
        .run(shopId, userId, now, now);
      database.database.prepare("INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, created_at, updated_at) VALUES (?, ?, 'plan_business_v1', 'active', ?, ?)")
        .run(subscriptionId, shopId, now, now);
    }
    database.database.prepare(`
      INSERT INTO shop_settings (
        shop_id, branding_json, storefront_json, version, updated_at,
        published_branding_json, published_storefront_json, published_version, published_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, 1, ?)
    `).run("shop-a", '{"primaryColor":"#5B5CEB"}', '{"headline":"Draft A","seoTitle":"Draft title"}', now, '{"primaryColor":"#176B5B"}', '{"headline":"Published A","seoTitle":"Published title"}', now);
    database.database.prepare(`
      INSERT INTO shop_settings (
        shop_id, branding_json, storefront_json, version, updated_at,
        published_branding_json, published_storefront_json, published_version, published_at
      ) VALUES (?, '{}', ?, 1, ?, '{}', ?, 1, ?)
    `).run("shop-b", '{"headline":"Draft B"}', now, '{"headline":"Published B"}', now);
    database.database.prepare(`
      INSERT INTO shop_domains (
        id, shop_id, hostname_normalized, type, status, is_primary,
        validation_metadata_json, activated_at, created_at, updated_at
      ) VALUES ('domain-a', 'shop-a', 'seller-a.selinow.com', 'platform_subdomain', 'active', 1, '{}', ?, ?, ?)
    `).run(now, now, now);

    const env = appEnv(database);
    const current = await getSellerStorefrontSettings({ env, shopPublicId: "public-a", userId: "user-a" });
    expect(current).toMatchObject({ publicationState: "published", publishedVersion: 1, version: 1 });

    const updated = await updateSellerStorefrontSettings({
      data: { headline: "Draft A updated", seoTitle: "Draft title updated" },
      env,
      expectedVersion: 1,
      shopPublicId: "public-a",
      userId: "user-a",
    });
    expect(updated).toMatchObject({ publicationState: "unpublished_changes", publishedVersion: 1, version: 2 });
    await expect(updateSellerStorefrontSettings({
      data: { headline: "Stale overwrite" },
      env,
      expectedVersion: 1,
      shopPublicId: "public-a",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "resource_conflict", issues: ["storefront_draft_stale"], status: 409 });
    await expect(publishSellerStorefrontSettings({
      env,
      expectedVersion: 1,
      requestId: "request-stale-publish",
      shopPublicId: "public-a",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "resource_conflict", issues: ["storefront_draft_stale"], status: 409 });
    await expect(getSellerStorefrontSettings({ env, shopPublicId: "public-b", userId: "user-a" }))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });

    const publicShop = await resolveStorefrontShop(new Request("https://seller-a.selinow.com/"), env);
    expect(publicShop.content.headline).toBe("Published A");
    expect(publicShop.content.seoTitle).toBe("Published title");
    expect(publicShop.content.description).toContain("Khám phá sản phẩm số");
    expect(publicShop.theme.brand).toBe("#176B5B");
    expect(publicShop.settingsVersion).toBe(1);
    const englishPublicShop = await resolveStorefrontShop(new Request("https://seller-a.selinow.com/?lang=en", {
      headers: { "Accept-Language": "vi-VN" },
    }), env);
    expect(englishPublicShop.content.headline).toBe("Published A");
    expect(englishPublicShop.content.seoTitle).toBe("Published title");
    expect(englishPublicShop.content.description).toContain("Discover digital products");
    expect(englishPublicShop.content.deliveryText).toBe("Digital products are delivered after payment is verified.");
    database.database.prepare("UPDATE shops SET default_locale = 'en' WHERE id = 'shop-a'").run();
    const defaultEnglishShop = await resolveStorefrontShop(new Request("https://seller-a.selinow.com/"), env);
    expect(defaultEnglishShop.content.headline).toBe("Published A");
    expect(defaultEnglishShop.content.description).toContain("Discover digital products");
    expect(defaultEnglishShop.publicDetails.deliveryText).toBe("Digital products are delivered after payment is verified.");
    expect(database.database.prepare("SELECT storefront_json AS draft, published_storefront_json AS published FROM shop_settings WHERE shop_id = 'shop-b'").get())
      .toEqual({ draft: '{"headline":"Draft B"}', published: '{"headline":"Published B"}' });
  });
});
