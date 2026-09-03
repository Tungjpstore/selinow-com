import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import {
  attachProductImage,
  createMediaAsset,
  detachProductImage,
  getPublicMediaAsset,
  listProductImages,
  sniffImageContentType,
} from "../../src/lib/media/assets";
import { getStorefrontCatalog, resolveStorefrontShop } from "../../src/lib/storefront/store";
import type { StorefrontShop } from "../../src/lib/storefront/store";

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

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();

  bucket(): R2Bucket {
    return {
      delete: (key: string) => {
        this.objects.delete(key);
        return Promise.resolve();
      },
      get: (key: string) => {
        const bytes = this.objects.get(key);
        if (bytes === undefined) return Promise.resolve(null);
        return Promise.resolve({
          arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
          httpEtag: `etag-${key}`,
        });
      },
      put: (key: string, value: Uint8Array<ArrayBuffer>) => {
        this.objects.set(key, new Uint8Array(value));
        return Promise.resolve({ httpEtag: `etag-${key}` });
      },
    } as unknown as R2Bucket;
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const NOW = "2026-08-16T00:00:00.000Z";

function createRuntime(input: { storageBytesLimit?: number } = {}): { database: DatabaseSync; env: AppBindings; r2: MemoryR2 } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
  const planLimits = input.storageBytesLimit === undefined ? "{}" : JSON.stringify({ storageBytes: input.storageBytesLimit });
  database.prepare("UPDATE plans SET limits_json = ? WHERE id = 'plan_business_v1'").run(planLimits);
  for (const [suffix, name] of [["a", "Media A"], ["b", "Media B"]] as const) {
    database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
      .run(`user-media-${suffix}`, `media-${suffix}@example.test`, name, NOW, NOW);
    database.prepare(`
      INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
    `).run(`shop-media-${suffix}`, `public-media-${suffix}`, `seller-media-${suffix}`, name, NOW, NOW);
    database.prepare("INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'owner', 'active', ?, ?)")
      .run(`shop-media-${suffix}`, `user-media-${suffix}`, NOW, NOW);
    database.prepare("INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at) VALUES (?, ?, 'plan_business_v1', 'active', '2099-01-01T00:00:00.000Z', ?, ?)")
      .run(`sub-media-${suffix}`, `shop-media-${suffix}`, NOW, NOW);
  }
  const r2 = new MemoryR2();
  const env = {
    API_ORIGIN: "https://api.selinow.com",
    DASHBOARD_ORIGIN: "https://app.selinow.com",
    DEFAULT_LOCALE: "vi",
    PLATFORM_BASE_DOMAIN: "selinow.com",
    PLATFORM_DB: new SqliteD1(database),
    PLATFORM_ORIGIN: "https://selinow.com",
    MEDIA: r2.bucket(),
  } as unknown as AppBindings;
  return { database, env, r2 };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const AVIF_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00, 0x00]);

function buffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Uint8Array(copy);
}

function upload(runtime: { env: AppBindings }, bytes: Uint8Array, contentType: string, shop = "public-media-a", user = "user-media-a") {
  return createMediaAsset({
    bytes: buffer(bytes),
    contentType,
    env: runtime.env,
    kind: "product_image",
    requestId: "request-media-test",
    shopPublicId: shop,
    userId: user,
  });
}

describe("media asset sniffing", () => {
  it("recognizes the four allowed image formats and rejects everything else", () => {
    expect(sniffImageContentType(PNG_BYTES)).toBe("image/png");
    expect(sniffImageContentType(JPEG_BYTES)).toBe("image/jpeg");
    expect(sniffImageContentType(WEBP_BYTES)).toBe("image/webp");
    expect(sniffImageContentType(AVIF_BYTES)).toBe("image/avif");
    expect(sniffImageContentType(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x61, 0x76, 0x69, 0x66]))).toBeNull();
    expect(sniffImageContentType(new Uint8Array())).toBeNull();
  });
});

describe("media asset upload contract", () => {
  it("stores the object in R2, registers the row, and writes an audit entry", async () => {
    const runtime = createRuntime();
    const asset = await upload(runtime, PNG_BYTES, "image/png");
    expect(asset.contentType).toBe("image/png");
    expect(asset.publicId).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect([...runtime.r2.objects.keys()]).toEqual([`storefront-media/shop-media-a/${asset.id}`]);
    const row = runtime.database.prepare("SELECT kind, status, byte_size AS byteSize FROM media_assets WHERE id = ?").get(asset.id) as { byteSize: number; kind: string; status: string };
    expect(row).toMatchObject({ byteSize: PNG_BYTES.byteLength, kind: "product_image", status: "active" });
    expect(runtime.database.prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE action = 'media_asset.created' AND shop_id = 'shop-media-a'").get()).toMatchObject({ total: 1 });
    expect(await getPublicMediaAsset(runtime.env, asset.publicId)).toMatchObject({ contentType: "image/png" });
  });

  it("rejects claimed content types that do not match the payload", async () => {
    const runtime = createRuntime();
    await expect(upload(runtime, JPEG_BYTES, "image/png")).rejects.toMatchObject({ code: "validation_failed", issues: ["media_asset_content_type_invalid"], status: 400 });
    await expect(upload(runtime, PNG_BYTES, "application/octet-stream")).rejects.toMatchObject({ code: "validation_failed", status: 400 });
    expect(runtime.database.prepare("SELECT COUNT(*) AS total FROM media_assets").get()).toMatchObject({ total: 0 });
    expect(runtime.r2.objects.size).toBe(0);
  });

  it("enforces the plan storage quota across active assets", async () => {
    const runtime = createRuntime({ storageBytesLimit: PNG_BYTES.byteLength + 2 });
    await expect(upload(runtime, PNG_BYTES, "image/png")).resolves.toMatchObject({ contentType: "image/png" });
    await expect(upload(runtime, PNG_BYTES, "image/png")).rejects.toMatchObject({ code: "quota_exceeded", issues: ["storage_bytes"], status: 409 });
    // Soft-deleted assets must release their quota share.
    runtime.database.prepare("UPDATE media_assets SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE shop_id = 'shop-media-a'").run(NOW, NOW);
    await expect(upload(runtime, PNG_BYTES, "image/png")).resolves.toMatchObject({ contentType: "image/png" });
  });
});

describe("product image assignment contract", () => {
  function seedProduct(database: DatabaseSync, shopId: string, productId: string): void {
    database.prepare(`
      INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
      VALUES (?, ?, ?, 'Sản phẩm', '', 'active', 'manual', 1, ?, ?)
    `).run(productId, shopId, `slug-${productId}`, NOW, NOW);
    database.prepare(`
      INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
      VALUES (?, ?, ?, 'SKU-1', 'Default', '{}', 100000, 'VND', 1, 10, 'active', 1, ?, ?)
    `).run(`var-${productId}`, shopId, productId, NOW, NOW);
  }

  it("attaches, lists, and soft-deletes images within one shop", async () => {
    const runtime = createRuntime();
    seedProduct(runtime.database, "shop-media-a", "prd_media_a");
    const asset = await upload(runtime, PNG_BYTES, "image/png");
    const image = await attachProductImage({
      env: runtime.env,
      mediaAssetPublicId: asset.publicId,
      productId: "prd_media_a",
      requestId: "request-media-test",
      shopPublicId: "public-media-a",
      userId: "user-media-a",
    });
    expect(image).toMatchObject({ mediaUrl: `/media/${asset.publicId}`, sortOrder: 0 });
    const second = await attachProductImage({
      env: runtime.env,
      mediaAssetPublicId: asset.publicId,
      productId: "prd_media_a",
      requestId: "request-media-test",
      shopPublicId: "public-media-a",
      userId: "user-media-a",
    });
    expect(second.sortOrder).toBe(1);
    const listed = await listProductImages({ env: runtime.env, productId: "prd_media_a", shopPublicId: "public-media-a", userId: "user-media-a" });
    expect(listed).toHaveLength(2);
    await detachProductImage({ env: runtime.env, imageId: image.imageId, productId: "prd_media_a", requestId: "request-media-test", shopPublicId: "public-media-a", userId: "user-media-a" });
    await expect(detachProductImage({ env: runtime.env, imageId: image.imageId, productId: "prd_media_a", requestId: "request-media-test", shopPublicId: "public-media-a", userId: "user-media-a" }))
      .rejects.toMatchObject({ code: "resource_not_found", status: 404 });
    expect(await listProductImages({ env: runtime.env, productId: "prd_media_a", shopPublicId: "public-media-a", userId: "user-media-a" })).toHaveLength(1);
  });

  it("keeps assignments tenant-bound across shops", async () => {
    const runtime = createRuntime();
    seedProduct(runtime.database, "shop-media-a", "prd_media_a");
    seedProduct(runtime.database, "shop-media-b", "prd_media_b");
    const asset = await upload(runtime, PNG_BYTES, "image/png");
    // Shop B cannot attach shop A's media asset, even to its own product.
    await expect(attachProductImage({
      env: runtime.env,
      mediaAssetPublicId: asset.publicId,
      productId: "prd_media_b",
      requestId: "request-media-test",
      shopPublicId: "public-media-b",
      userId: "user-media-b",
    })).rejects.toMatchObject({ code: "resource_not_found", status: 404 });
    // Shop A cannot attach to shop B's product.
    await expect(attachProductImage({
      env: runtime.env,
      mediaAssetPublicId: asset.publicId,
      productId: "prd_media_b",
      requestId: "request-media-test",
      shopPublicId: "public-media-a",
      userId: "user-media-a",
    })).rejects.toMatchObject({ code: "resource_not_found", status: 404 });
  });
});

describe("storefront catalog image projection", () => {
  it("surfaces the first active image URL per product and hides deleted ones", async () => {
    const runtime = createRuntime();
    const database = runtime.database;
    database.prepare(`
      INSERT INTO shop_settings (shop_id, branding_json, storefront_json, version, updated_at,
        published_branding_json, published_storefront_json, published_version, published_at)
      VALUES ('shop-media-a', '{}', '{}', 1, ?, '{}', '{}', 1, ?)
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO shop_domains (id, shop_id, hostname_normalized, type, status, is_primary, validation_metadata_json, activated_at, created_at, updated_at)
      VALUES ('domain-media-a', 'shop-media-a', 'seller-media-a.selinow.com', 'platform_subdomain', 'active', 1, '{}', ?, ?, ?)
    `).run(NOW, NOW, NOW);
    database.prepare(`
      INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
      VALUES ('prd_media_a', 'shop-media-a', 'anh-san-pham', 'Sản phẩm có ảnh', '', 'active', 'manual', 1, ?, ?)
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
      VALUES ('var_media_a', 'shop-media-a', 'prd_media_a', 'SKU-IMG', 'Default', '{}', 100000, 'VND', 1, 10, 'active', 1, ?, ?)
    `).run(NOW, NOW);
    database.prepare(`
      INSERT OR IGNORE INTO catalog_channel_visibility (shop_id, product_id, channel_code, status, version, updated_by_user_id, created_at, updated_at)
      VALUES ('shop-media-a', 'prd_media_a', 'website', 'visible', 1, 'user-media-a', ?, ?)
    `).run(NOW, NOW);
    const shopLiteral = {
      access: "live",
      content: { showExactStock: false },
      currency: "VND",
      id: "shop-media-a",
      lowStockThreshold: 5,
      status: "active",
      subscriptionState: "active",
    } as unknown as StorefrontShop;
    expect((await getStorefrontCatalog(runtime.env, shopLiteral)).products[0]?.imageUrl).toBeNull();

    const asset = await upload(runtime, PNG_BYTES, "image/png");
    await attachProductImage({ env: runtime.env, mediaAssetPublicId: asset.publicId, productId: "prd_media_a", requestId: "request-media-test", shopPublicId: "public-media-a", userId: "user-media-a" });
    expect((await getStorefrontCatalog(runtime.env, shopLiteral)).products[0]?.imageUrl).toBe(`/media/${asset.publicId}`);

    // The live storefront resolution must produce the same projection end-to-end.
    const resolved = await resolveStorefrontShop(new Request("https://seller-media-a.selinow.com/"), runtime.env);
    expect((await getStorefrontCatalog(runtime.env, resolved)).products[0]?.imageUrl).toBe(`/media/${asset.publicId}`);

    database.prepare("UPDATE product_images SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE shop_id = 'shop-media-a'").run(NOW, NOW);
    expect((await getStorefrontCatalog(runtime.env, shopLiteral)).products[0]?.imageUrl).toBeNull();
  });
});
