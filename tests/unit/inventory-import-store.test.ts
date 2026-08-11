import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

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
                current_period_end: null,
                default_locale: "vi",
                feature_flags_json: "{}",
                grace_ends_at: null,
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
                trial_ends_at: "2099-01-01T00:00:00.000Z",
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

type InventoryQueryHook = (sql: string) => Promise<void> | void;

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string,
    private readonly values: SQLInputValue[] = [],
    private readonly beforeQuery?: InventoryQueryHook,
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    }), this.beforeQuery);
  }

  async first<T>(): Promise<T | null> {
    await this.beforeQuery?.(this.sql);
    return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  all(): Promise<{ results: unknown[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class AtomicInventoryDatabase {
  private batchTail = Promise.resolve();

  constructor(readonly database: DatabaseSync, private readonly beforeQuery?: InventoryQueryHook) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql, [], this.beforeQuery);
  }

  batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    const operation = this.batchTail.then(async () => {
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
    });
    this.batchTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

const sqliteDatabases: DatabaseSync[] = [];

function createAtomicInventoryDatabase(beforeQuery?: InventoryQueryHook): AtomicInventoryDatabase {
  const database = new DatabaseSync(":memory:");
  sqliteDatabases.push(database);
  for (const filename of [
    "migrations/0001_platform_foundation.sql",
    "migrations/0002_tenant_auth_subscription.sql",
    "migrations/0003_catalog_inventory_orders.sql",
  ]) database.exec(readFileSync(filename, "utf8"));
  database.exec(`
    CREATE TABLE moderation_actions (
      target_kind TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const now = "2026-07-26T00:00:00.000Z";
  database.exec(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-inventory', 'inventory-test', 'Inventory Test', '{}', '{}', '${now}', '${now}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-a', 'inventory-a@example.test', 'Inventory A', 'active', '${now}', '${now}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('shop-a', 'shop-public-a', 'inventory-a', 'Inventory A', 'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('shop-a', 'user-a', 'owner', 'active', '${now}', '${now}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at)
    VALUES ('subscription-inventory-a', 'shop-a', 'plan-inventory', 'active', '2099-01-01T00:00:00.000Z', '${now}', '${now}');
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
    VALUES ('product-a', 'shop-a', 'inventory-product', 'Inventory Product', '', 'active', 'license_key', 1, '${now}', '${now}');
    INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency,
      min_per_order, max_per_order, status, version, created_at, updated_at)
    VALUES ('variant-a', 'shop-a', 'product-a', 'INVENTORY-A', 'Default', '{}', 1000, 'VND', 1, 10, 'active', 1, '${now}', '${now}');
  `);
  return new AtomicInventoryDatabase(database, beforeQuery);
}

function createAtomicEnvironment(database: AtomicInventoryDatabase): AppBindings {
  return {
    IDENTIFIER_HMAC_SECRET: "identifier-secret",
    INVENTORY_KEK_V1: KEK,
    INVENTORY_KEY_VERSION: "v1",
    PLATFORM_DB: database,
    SESSION_SECRET: "session-secret",
  } as unknown as AppBindings;
}

function initialIdempotencyReadBarrier(): InventoryQueryHook {
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => { release = resolve; });
  return async (sql) => {
    if (!sql.includes("FROM idempotency_records") || !sql.includes("expires_at >") || reads >= 2) return;
    reads += 1;
    if (reads === 2) release();
    await bothRead;
  };
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
  for (const database of sqliteDatabases.splice(0)) database.close();
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

describe("inventory import transactional races", () => {
  function input(env: AppBindings, data: string, idempotencyKey: string, previewToken: string, requestId: string) {
    return {
      data,
      env,
      filename: null,
      idempotencyKey,
      previewToken,
      requestId,
      shopPublicId: "shop-public-a",
      source: "paste" as const,
      userId: "user-a",
      variantId: "variant-a",
    };
  }

  it("rolls back the batch, audit, readiness and idempotency writes after a mid-batch inventory failure", async () => {
    const database = createAtomicInventoryDatabase();
    const env = createAtomicEnvironment(database);
    const common = {
      data: "ATOMIC-ROLLBACK-KEY",
      env,
      filename: null,
      shopPublicId: "shop-public-a",
      source: "paste" as const,
      userId: "user-a",
      variantId: "variant-a",
    };
    const preview = await previewInventoryImport(common);
    database.database.exec(`
      CREATE TRIGGER reject_inventory_key_insert
      BEFORE INSERT ON inventory_keys
      BEGIN
        SELECT RAISE(ABORT, 'forced_inventory_key_failure');
      END;
    `);

    await expect(confirmInventoryImport(input(env, common.data, "inventory-atomic-rollback-0001", preview.previewToken, "request-atomic-rollback")))
      .rejects.toMatchObject({ code: "inventory_import_conflict", status: 409 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM inventory_batches").get()).toEqual({ count: 0 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys").get()).toEqual({ count: 0 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get()).toEqual({ count: 0 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM audit_logs").get()).toEqual({ count: 0 });
    expect(database.database.prepare("SELECT readiness_version AS readinessVersion FROM shops WHERE id = 'shop-a'").get())
      .toEqual({ readinessVersion: 1 });
  });

  it("commits one inventory batch when two confirmations race on the same idempotency key", async () => {
    const database = createAtomicInventoryDatabase(initialIdempotencyReadBarrier());
    const env = createAtomicEnvironment(database);
    const preview = await previewInventoryImport({
      data: "RACE-SAME-IDEMPOTENCY-KEY",
      env,
      filename: null,
      shopPublicId: "shop-public-a",
      source: "paste",
      userId: "user-a",
      variantId: "variant-a",
    });
    const outcomes = await Promise.all([
      confirmInventoryImport(input(env, "RACE-SAME-IDEMPOTENCY-KEY", "inventory-race-same-0001", preview.previewToken, "request-race-a")),
      confirmInventoryImport(input(env, "RACE-SAME-IDEMPOTENCY-KEY", "inventory-race-same-0001", preview.previewToken, "request-race-b")),
    ]);

    expect(outcomes.map((outcome) => outcome.created).sort()).toEqual([false, true]);
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM inventory_batches").get()).toEqual({ count: 1 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys").get()).toEqual({ count: 1 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get()).toEqual({ count: 1 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'inventory.imported'").get()).toEqual({ count: 1 });
    expect(database.database.prepare("SELECT readiness_version AS readinessVersion FROM shops WHERE id = 'shop-a'").get())
      .toEqual({ readinessVersion: 2 });
  });

  it("rolls back the losing batch when the same plaintext races with different idempotency keys", async () => {
    const database = createAtomicInventoryDatabase(initialIdempotencyReadBarrier());
    const env = createAtomicEnvironment(database);
    const data = "RACE-SAME-PLAINTEXT-DIFFERENT-KEYS";
    const preview = await previewInventoryImport({
      data,
      env,
      filename: null,
      shopPublicId: "shop-public-a",
      source: "paste",
      userId: "user-a",
      variantId: "variant-a",
    });
    const outcomes = await Promise.allSettled([
      confirmInventoryImport(input(env, data, "inventory-race-different-0001", preview.previewToken, "request-race-c")),
      confirmInventoryImport(input(env, data, "inventory-race-different-0002", preview.previewToken, "request-race-d")),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(rejected).toBeDefined();
    expect(rejected?.reason as { code?: string; status?: number }).toMatchObject({ code: "inventory_import_conflict", status: 409 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM inventory_batches").get()).toEqual({ count: 1 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys").get()).toEqual({ count: 1 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get()).toEqual({ count: 1 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'inventory.imported'").get()).toEqual({ count: 1 });
    expect(database.database.prepare("SELECT readiness_version AS readinessVersion FROM shops WHERE id = 'shop-a'").get())
      .toEqual({ readinessVersion: 2 });
  });
});
