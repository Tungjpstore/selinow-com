import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { getSellerStorefrontPreviewCatalog } from "../../src/lib/storefront/preview";

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
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(): SqliteD1 {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((entry) => /^\d{4}_.+\.sql$/u.test(entry) && Number(entry.slice(0, 4)) <= 31)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
  return new SqliteD1(database);
}

function envFor(database: SqliteD1): AppBindings {
  return { PLATFORM_DB: database as unknown as D1Database } as unknown as AppBindings;
}

function seedShop(database: DatabaseSync, input: { id: string; publicId: string; slug: string }): void {
  const now = "2026-07-28T00:00:00.000Z";
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(input.id, input.publicId, input.slug, `Shop ${input.slug}`, now, now);
  database.prepare("INSERT INTO shop_settings (shop_id, branding_json, storefront_json, version, low_stock_threshold, updated_at) VALUES (?, '{}', '{}', 1, 2, ?)")
    .run(input.id, now);
  database.prepare("INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, created_at, updated_at) VALUES (?, ?, 'plan_business_v1', 'active', ?, ?)")
    .run(`sub-${input.id}`, input.id, now, now);
}

function seedUser(database: DatabaseSync, userId: string, shopId: string, role: "owner" | "viewer"): void {
  const now = "2026-07-28T00:00:00.000Z";
  database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
    .run(userId, `${userId}@example.test`, userId, now, now);
  database.prepare("INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
    .run(shopId, userId, role, now, now);
}

function seedCatalog(database: DatabaseSync): void {
  const now = "2026-07-28T00:00:00.000Z";
  database.prepare("INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at) VALUES ('prd-active', 'shop-a', 'active-product', 'Active product', 'Safe public description', 'active', 'license_key', 1, ?, ?)")
    .run(now, now);
  database.prepare("INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at) VALUES ('prd-draft', 'shop-a', 'draft-product', 'Draft product', 'Must stay hidden', 'draft', 'license_key', 1, ?, ?)")
    .run(now, now);
  database.prepare("INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at) VALUES ('var-active', 'shop-a', 'prd-active', 'SECRET-SKU', 'Standard', '{\"seat\":1}', 199000, 'VND', 1, 10, 'active', 1, ?, ?)")
    .run(now, now);
  database.prepare("INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at) VALUES ('var-mismatch', 'shop-a', 'prd-active', 'USD-SKU', 'USD variant', '{}', 1999, 'USD', 1, 10, 'active', 1, ?, ?)")
    .run(now, now);
  database.prepare("INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at) VALUES ('var-archived', 'shop-a', 'prd-active', 'ARCHIVED-SKU', 'Archived', '{}', 99000, 'VND', 1, 10, 'archived', 1, ?, ?)")
    .run(now, now);
  database.prepare("INSERT INTO inventory_batches (id, shop_id, variant_id, source, total_count, accepted_count, rejected_count, created_by_user_id, created_at) VALUES ('batch-a', 'shop-a', 'var-active', 'paste', 3, 3, 0, 'owner-a', ?)")
    .run(now);
  for (const [id, status] of [["key-available-1", "available"], ["key-available-2", "available"], ["key-sold", "sold"]] as const) {
    database.prepare("INSERT INTO inventory_keys (id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64, key_version, key_fingerprint, created_at) VALUES (?, 'shop-a', 'var-active', 'batch-a', ?, 'ciphertext', 'iv', 'v1', ?, ?)")
      .run(id, status, `fingerprint-${id}`, now);
  }
}

describe("seller storefront preview catalog", () => {
  it("serves a tenant-bound public-shaped projection to read-only members", async () => {
    const database = createDatabase();
    seedShop(database.database, { id: "shop-a", publicId: "public-a", slug: "seller-a" });
    seedShop(database.database, { id: "shop-b", publicId: "public-b", slug: "seller-b" });
    seedUser(database.database, "owner-a", "shop-a", "owner");
    seedUser(database.database, "viewer-a", "shop-a", "viewer");
    seedCatalog(database.database);
    database.database.exec(readFileSync("migrations/0032_shop_globalization_invariants.sql", "utf8"));

    const ownerCatalog = await getSellerStorefrontPreviewCatalog({ env: envFor(database), shopPublicId: "public-a", userId: "owner-a" });
    const viewerCatalog = await getSellerStorefrontPreviewCatalog({ env: envFor(database), shopPublicId: "public-a", userId: "viewer-a" });

    expect(viewerCatalog).toEqual(ownerCatalog);
    expect(ownerCatalog.products).toHaveLength(1);
    expect(ownerCatalog.products[0]).toMatchObject({ slug: "active-product", title: "Active product" });
    expect(ownerCatalog.products[0]?.variants).toEqual([expect.objectContaining({ availableStock: 2, stockState: "low_stock", title: "Standard" })]);
    expect(ownerCatalog.products[0]?.variants).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: "USD variant" })]));
    expect(ownerCatalog.products[0]?.variants[0]).not.toHaveProperty("sku");
    expect(ownerCatalog.products[0]?.variants[0]).not.toHaveProperty("options");
    expect(ownerCatalog.products[0]?.variants[0]).not.toHaveProperty("encryptedPayload");
    await expect(getSellerStorefrontPreviewCatalog({ env: envFor(database), shopPublicId: "public-b", userId: "owner-a" }))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });
});
