import { afterEach, describe, expect, it, vi } from "vitest";

import { confirmInventoryImport, previewInventoryImport } from "../../src/lib/catalog/store";
import type { AppBindings } from "../../src/lib/platform/bindings";

const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

type IdempotencyRow = {
  request_hash: string;
  response_json: string;
};

class InventoryDatabase {
  batchCount = 0;
  readonly boundStrings: string[] = [];
  readonly idempotency = new Map<string, IdempotencyRow>();
  readonly inventory = new Map<string, Set<string>>();

  private inventoryKey(shopId: string, variantId: string): string {
    return `${shopId}:${variantId}`;
  }

  prepare(sql: string) {
    const boundStrings = this.boundStrings;
    const idempotency = this.idempotency;
    const inventory = this.inventory;
    const inventoryKey = (shopId: string, variantId: string) => this.inventoryKey(shopId, variantId);
    return {
      bind(...values: unknown[]) {
        boundStrings.push(...values.filter((value): value is string => typeof value === "string"));
        return {
          all() {
            if (sql.includes("FROM inventory_keys") && sql.includes("key_fingerprint IN")) {
              const stored = inventory.get(inventoryKey(String(values[0]), String(values[1]))) ?? new Set();
              return Promise.resolve({ results: values.slice(2).filter((value): value is string => typeof value === "string" && stored.has(value)).map((key_fingerprint) => ({ key_fingerprint })) });
            }
            return Promise.resolve({ results: [] });
          },
          first() {
            if (sql.includes("FROM shops") && sql.includes("INNER JOIN shop_members")) {
              const userId = String(values[0]);
              const shopPublicId = String(values[1]);
              const shopId = shopPublicId === "shop-public-a" ? "shop-a" : shopPublicId === "shop-public-b" ? "shop-b" : null;
              if (shopId === null || userId !== "user-a") return Promise.resolve(null);
              return Promise.resolve({
                currency: "VND",
                default_locale: "vi",
                feature_flags_json: "{}",
                limits_json: "{}",
                name: shopId,
                plan_code: "store",
                public_id: shopPublicId,
                role: "owner",
                shop_id: shopId,
                shop_status: "draft",
                slug: shopId,
                subscription_state: "trialing",
                timezone: "Asia/Ho_Chi_Minh",
              });
            }
            if (sql.includes("SELECT id FROM product_variants")) {
              const variantId = String(values[0]);
              const shopId = String(values[1]);
              if (variantId === "variant-a" && shopId === "shop-a") return Promise.resolve({ id: variantId });
              if (variantId === "variant-b" && shopId === "shop-b") return Promise.resolve({ id: variantId });
              return Promise.resolve(null);
            }
            if (sql.includes("FROM idempotency_records")) {
              return Promise.resolve(idempotency.get(`${String(values[0])}\0${String(values[1])}\0${String(values[2])}`) ?? null);
            }
            return Promise.resolve(null);
          },
          run() {
            if (sql.includes("INSERT INTO inventory_keys")) {
              const shopId = String(values[1]);
              const variantId = String(values[2]);
              const fingerprint = String(values[8]);
              const key = inventoryKey(shopId, variantId);
              const stored = inventory.get(key) ?? new Set<string>();
              if (stored.has(fingerprint)) throw new Error("duplicate_inventory_key");
              stored.add(fingerprint);
              inventory.set(key, stored);
            }
            if (sql.includes("INSERT INTO idempotency_records")) {
              const key = `${String(values[0])}\0${String(values[1])}\0${String(values[2])}`;
              if (idempotency.has(key)) throw new Error("duplicate_idempotency_key");
              idempotency.set(key, { request_hash: String(values[3]), response_json: String(values[4]) });
            }
            return Promise.resolve({ meta: { changes: 1 } });
          },
        };
      },
    };
  }

  batch(statements: Array<{ run: () => Promise<unknown> }>) {
    this.batchCount += 1;
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

function createEnvironment(database: InventoryDatabase): AppBindings {
  return {
    IDENTIFIER_HMAC_SECRET: "identifier-secret",
    INVENTORY_KEK_V1: KEK,
    INVENTORY_KEY_VERSION: "v1",
    PLATFORM_DB: database,
    SESSION_SECRET: "session-secret",
  } as unknown as AppBindings;
}

describe("inventory preview confirmation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the same batch for a same-payload replay and rejects an idempotency conflict", async () => {
    const database = new InventoryDatabase();
    const env = createEnvironment(database);
    const common = {
      env,
      filename: null,
      shopPublicId: "shop-public-a",
      source: "paste" as const,
      userId: "user-a",
      variantId: "variant-a",
    };
    const preview = await previewInventoryImport({ ...common, data: "KEY-A" });
    const first = await confirmInventoryImport({
      ...common,
      data: "KEY-A",
      idempotencyKey: "inventory-replay-0001",
      previewToken: preview.previewToken,
      requestId: "request-first",
    });
    const replay = await confirmInventoryImport({
      ...common,
      data: "KEY-A",
      idempotencyKey: "inventory-replay-0001",
      previewToken: preview.previewToken,
      requestId: "request-replay",
    });

    expect(first.created).toBe(true);
    expect(replay).toEqual({ ...first, created: false });
    expect(database.batchCount).toBe(1);
    expect(database.inventory.get("shop-a:variant-a")?.size).toBe(1);

    const conflictingPreview = await previewInventoryImport({ ...common, data: "KEY-B" });
    await expect(confirmInventoryImport({
      ...common,
      data: "KEY-B",
      idempotencyKey: "inventory-replay-0001",
      previewToken: conflictingPreview.previewToken,
      requestId: "request-conflict",
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("does not import inventory with an expired or tampered preview token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
    const database = new InventoryDatabase();
    const env = createEnvironment(database);
    const common = {
      data: "KEY-REQUIRES-PREVIEW",
      env,
      filename: null,
      shopPublicId: "shop-public-a",
      source: "paste" as const,
      userId: "user-a",
      variantId: "variant-a",
    };
    const preview = await previewInventoryImport(common);
    const tamperedSuffix = preview.previewToken.endsWith("a") ? "b" : "a";

    await expect(confirmInventoryImport({
      ...common,
      idempotencyKey: "inventory-tampered-001",
      previewToken: `${preview.previewToken.slice(0, -1)}${tamperedSuffix}`,
      requestId: "request-tampered",
    })).rejects.toMatchObject({ code: "inventory_preview_invalid", status: 400 });

    vi.setSystemTime(new Date("2026-07-26T00:16:00.000Z"));
    await expect(confirmInventoryImport({
      ...common,
      idempotencyKey: "inventory-expired-0001",
      previewToken: preview.previewToken,
      requestId: "request-expired",
    })).rejects.toMatchObject({ code: "inventory_preview_expired", status: 409 });

    expect(database.batchCount).toBe(0);
    expect(database.idempotency.size).toBe(0);
    expect(database.inventory.size).toBe(0);
  });

  it("does not bind, audit, persist or return plaintext inventory keys", async () => {
    const database = new InventoryDatabase();
    const env = createEnvironment(database);
    const plaintext = "SENSITIVE-PLAINTEXT-INVENTORY-KEY";
    const common = {
      data: plaintext,
      env,
      filename: "keys.csv",
      shopPublicId: "shop-public-a",
      source: "csv" as const,
      userId: "user-a",
      variantId: "variant-a",
    };
    const preview = await previewInventoryImport(common);
    const result = await confirmInventoryImport({
      ...common,
      idempotencyKey: "inventory-secret-0001",
      previewToken: preview.previewToken,
      requestId: "request-secret",
    });

    expect(JSON.stringify(preview)).not.toContain(plaintext);
    expect(JSON.stringify(result)).not.toContain(plaintext);
    expect(JSON.stringify(Array.from(database.idempotency.values()))).not.toContain(plaintext);
    expect(database.boundStrings.some((value) => value.includes(plaintext))).toBe(false);
  });

  it("fails closed when a token or variant is used outside its tenant", async () => {
    const database = new InventoryDatabase();
    const env = createEnvironment(database);
    const preview = await previewInventoryImport({
      data: "TENANT-A-KEY",
      env,
      filename: null,
      shopPublicId: "shop-public-a",
      source: "paste",
      userId: "user-a",
      variantId: "variant-a",
    });

    await expect(confirmInventoryImport({
      data: "TENANT-A-KEY",
      env,
      filename: null,
      idempotencyKey: "inventory-tenant-0001",
      previewToken: preview.previewToken,
      requestId: "request-tenant",
      shopPublicId: "shop-public-b",
      source: "paste",
      userId: "user-a",
      variantId: "variant-a",
    })).rejects.toMatchObject({ code: "resource_not_found", status: 404 });

    await expect(previewInventoryImport({
      data: "TENANT-A-KEY",
      env,
      filename: null,
      shopPublicId: "shop-public-a",
      source: "paste",
      userId: "user-b",
      variantId: "variant-a",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });
});
