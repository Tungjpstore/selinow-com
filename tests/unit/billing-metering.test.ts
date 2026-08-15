import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../../src/lib/core/errors";
import { assertQuotaAvailable, billingPeriodKey, checkQuota, getUsage, recordUsage, resolveBillingPeriod } from "../../src/lib/billing/metering";

const START = "2026-08-01T00:00:00.000Z";
const END = "2026-09-01T00:00:00.000Z";
const OCCURRED = "2026-08-03T00:00:00.000Z";

class SqliteStatement {
  constructor(private readonly database: DatabaseSync, private readonly sql: string, private readonly values: SQLInputValue[] = []) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values as SQLInputValue[]);
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  private batchTail: Promise<void> = Promise.resolve();

  constructor(private readonly database: DatabaseSync) {}

  batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const operation = this.batchTail.then(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const results: D1Result[] = [];
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

  prepare(sql: string): D1PreparedStatement {
    return new SqliteStatement(this.database, sql) as unknown as D1PreparedStatement;
  }
}

function createDatabase(): { database: DatabaseSync; d1: D1Database } {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE shop_subscriptions (
      id TEXT PRIMARY KEY NOT NULL,
      shop_id TEXT NOT NULL,
      state TEXT NOT NULL,
      current_period_start TEXT,
      current_period_end TEXT
    );
    CREATE TABLE usage_events (
      id TEXT PRIMARY KEY NOT NULL,
      shop_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      period_kind TEXT NOT NULL,
      period_key TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      delta INTEGER NOT NULL CHECK (delta > 0),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (shop_id, metric, period_key, source_kind, source_id)
    );
    CREATE TABLE usage_counters (
      shop_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      period_kind TEXT NOT NULL DEFAULT 'billing',
      period_key TEXT NOT NULL,
      value INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (shop_id, metric, period_key)
    );
  `);
  database.prepare("INSERT INTO shop_subscriptions (id, shop_id, state, current_period_start, current_period_end) VALUES (?, ?, 'active', ?, ?)").run("sub-a", "shop-a", START, END);
  database.prepare("INSERT INTO shop_subscriptions (id, shop_id, state, current_period_start, current_period_end) VALUES (?, ?, 'active', ?, ?)").run("sub-b", "shop-b", START, END);
  const d1 = new SqliteD1(database) as unknown as D1Database;
  return { database, d1 };
}

describe("billing usage metering", () => {
  let database: DatabaseSync;
  let d1: D1Database;

  beforeEach(() => {
    ({ database, d1 } = createDatabase());
  });

  afterEach(() => { database.close(); });

  it("derives a stable billing-period key from subscription boundaries", async () => {
    expect(billingPeriodKey(START, END)).toBe(`paid/${START}/${END}`);
    await expect(resolveBillingPeriod({ database: d1, shopId: "shop-a" })).resolves.toBe(`paid/${START}/${END}`);
  });

  it.each(["cancel_scheduled", "upgrade_pending", "downgrade_scheduled"] as const)("keeps %s subscriptions on their paid usage period", async (state) => {
    database.prepare("UPDATE shop_subscriptions SET state = ? WHERE shop_id = 'shop-a'").run(state);
    await expect(resolveBillingPeriod({ database: d1, shopId: "shop-a" })).resolves.toBe(`paid/${START}/${END}`);
  });

  it("records once and replays without incrementing the counter", async () => {
    const input = { database: d1, delta: 1, metric: "orders_created", occurredAt: OCCURRED, shopId: "shop-a", sourceId: "order-001", sourceKind: "order" } as const;
    const first = await recordUsage(input);
    const replay = await recordUsage(input);

    expect(first.status).toBe("applied");
    expect(replay).toMatchObject({ eventId: first.eventId, status: "replayed", value: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 1 });
    await expect(getUsage({ database: d1, metric: input.metric, shopId: input.shopId })).resolves.toMatchObject({ value: 1 });
  });

  it("treats a changed replay payload as a conflict", async () => {
    const input = { database: d1, delta: 1, metric: "orders_created", occurredAt: OCCURRED, shopId: "shop-a", sourceId: "order-002", sourceKind: "order" } as const;
    await recordUsage(input);
    await expect(recordUsage({ ...input, delta: 2 })).rejects.toMatchObject({ code: "usage_event_conflict", status: 409 });
  });

  it("keeps identical source references isolated by tenant", async () => {
    const source = { delta: 1, metric: "orders_created", occurredAt: OCCURRED, sourceId: "order-shared", sourceKind: "order" } as const;
    await Promise.all([
      recordUsage({ ...source, database: d1, shopId: "shop-a" }),
      recordUsage({ ...source, database: d1, shopId: "shop-b" }),
    ]);
    await expect(getUsage({ database: d1, metric: source.metric, shopId: "shop-a" })).resolves.toMatchObject({ value: 1 });
    await expect(getUsage({ database: d1, metric: source.metric, shopId: "shop-b" })).resolves.toMatchObject({ value: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 2 });
  });

  it("keeps legacy trial usage out of the first paid period", async () => {
    database.prepare("UPDATE shop_subscriptions SET state = 'trialing' WHERE shop_id = ?").run("shop-a");
    await recordUsage({ database: d1, delta: 1, metric: "orders_created", occurredAt: OCCURRED, shopId: "shop-a", sourceId: "trial-order", sourceKind: "order" });
    database.prepare("UPDATE shop_subscriptions SET state = 'active', current_period_start = ?, current_period_end = ? WHERE shop_id = ?").run("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "shop-a");

    await expect(getUsage({ database: d1, metric: "orders_created", shopId: "shop-a" })).resolves.toMatchObject({ value: 0, periodKey: "paid/2026-09-01T00:00:00.000Z/2026-10-01T00:00:00.000Z" });
    expect(database.prepare("SELECT period_key AS periodKey, period_kind AS periodKind, value FROM usage_counters WHERE shop_id = ?").all("shop-a")).toEqual([{ periodKey: `trial/${START}/${END}`, periodKind: "trial", value: 1 }]);
  });

  it("serializes concurrent replays without double counting", async () => {
    const input = { database: d1, delta: 1, metric: "downloads_served", occurredAt: OCCURRED, shopId: "shop-a", sourceId: "grant-001", sourceKind: "download" } as const;
    const results = await Promise.all(Array.from({ length: 8 }, () => recordUsage(input)));
    expect(results.filter((result) => result.status === "applied")).toHaveLength(1);
    expect(results.filter((result) => result.status === "replayed")).toHaveLength(7);
    await expect(getUsage({ database: d1, metric: input.metric, shopId: input.shopId })).resolves.toMatchObject({ value: 1 });
  });

  it("returns quota state and rejects exhausted quota", async () => {
    const input = { database: d1, delta: 2, metric: "orders_created", occurredAt: OCCURRED, shopId: "shop-a", sourceId: "order-003", sourceKind: "order" } as const;
    await recordUsage(input);
    await expect(checkQuota({ database: d1, limit: 3, metric: input.metric, requested: 1, shopId: input.shopId })).resolves.toMatchObject({ allowed: true, current: 2, remaining: 1 });
    await expect(assertQuotaAvailable({ database: d1, limit: 3, metric: input.metric, requested: 2, shopId: input.shopId })).rejects.toMatchObject({ code: "quota_exceeded", status: 409 });
  });

  it("fails closed when subscription period or database state is unavailable", async () => {
    await expect(checkQuota({ database: d1, limit: 5, metric: "orders_created", shopId: "unknown-shop" })).rejects.toMatchObject({ code: "billing_period_unavailable" });
    const broken = { prepare: () => { throw new Error("database_down"); } } as unknown as D1Database;
    await expect(checkQuota({ database: broken, limit: 5, metric: "orders_created", periodKey: "period-1", shopId: "shop-a" })).rejects.toMatchObject({ code: "usage_unavailable", status: 503 });
  });

  it("rejects malformed usage before touching the database", async () => {
    await expect(recordUsage({ database: d1, delta: 0, metric: "orders_created", occurredAt: OCCURRED, periodKey: "period-1", shopId: "shop-a", sourceId: "order-004", sourceKind: "order" })).rejects.toBeInstanceOf(AppError);
    await expect(recordUsage({ database: d1, delta: 1, metric: "OrdersCreated", occurredAt: OCCURRED, periodKey: "period-1", shopId: "shop-a", sourceId: "order-005", sourceKind: "order" })).rejects.toMatchObject({ code: "usage_event_invalid" });
  });
});
