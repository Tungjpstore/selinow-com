import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { getSellerMetricsRange, parseMetricsDays } from "../../src/lib/dashboard/metrics";
import { getSellerTodaySnapshot } from "../../src/lib/dashboard/today-snapshot";
import { AppError } from "../../src/lib/core/errors";

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
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(): SqliteD1 {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  return new SqliteD1(database);
}

const NOW = "2026-08-22T00:00:00.000Z";
const METRICS_NOW = new Date("2026-08-22T12:00:00.000Z");

function seedTenant(database: DatabaseSync): void {
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
  database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
    .run("user-a", "a@example.test", "Owner A", NOW, NOW);
  database.prepare(`
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('shop-a', 'public-a', 'seller-a', 'Shop A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(NOW, NOW);
  database.prepare("INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES ('shop-a', 'user-a', 'owner', 'active', ?, ?)").run(NOW, NOW);
  database.prepare("INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at) VALUES ('sub-a', 'shop-a', 'plan_business_v1', 'active', '2099-01-01T00:00:00.000Z', ?, ?)").run(NOW, NOW);
  database.prepare(`
    INSERT INTO shop_settings (shop_id, branding_json, storefront_json, version, updated_at, published_branding_json, published_storefront_json, published_version, published_at)
    VALUES ('shop-a', '{}', '{}', 1, ?, '{}', '{}', 1, ?)
  `).run(NOW, NOW);
  database.prepare(`
    INSERT INTO shop_domains (id, shop_id, hostname_normalized, type, status, is_primary, validation_metadata_json, activated_at, created_at, updated_at)
    VALUES ('domain-a', 'shop-a', 'seller-a.selinow.com', 'platform_subdomain', 'active', 1, '{}', ?, ?, ?)
  `).run(NOW, NOW, NOW);
}

type OrderSeed = {
  currency?: string;
  orderNumber: string;
  paymentStatus: string;
  paidAt: string | null;
  publicId: string;
  shopId?: string;
  totalMinor: number;
};

function seedOrder(database: DatabaseSync, seed: OrderSeed): void {
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status, payment_status, fulfillment_status,
      subtotal_minor, total_minor, currency, locale, checkout_subject_hash, order_token_hash, expires_at, paid_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'web', ?, ?, 'unfulfilled', ?, ?, ?, 'vi', ?, ?, ?, ?, ?, ?)
  `).run(
    seed.publicId,
    seed.publicId,
    seed.shopId ?? "shop-a",
    seed.orderNumber,
    seed.paymentStatus === "paid" ? "completed" : "pending_payment",
    seed.paymentStatus,
    seed.totalMinor,
    seed.totalMinor,
    seed.currency ?? "VND",
    `subject-${seed.orderNumber}`,
    `token-${seed.orderNumber}`,
    "2099-01-01T00:00:00.000Z",
    seed.paidAt,
    seed.paidAt ?? NOW,
    seed.paidAt ?? NOW,
  );
}

function densePoints(endDate: string, days: 7 | 30 | 90, totals: Record<string, number> = {}): Array<{ date: string; totalMinor: number }> {
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(end - (days - index - 1) * 86_400_000).toISOString().slice(0, 10);
    return { date, totalMinor: totals[date] ?? 0 };
  });
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

describe("seller metrics read model (EX3.1)", () => {
  it("returns a deterministic dense 7-day series and ignores unpaid orders", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    seedOrder(database.database, { orderNumber: "A1", paidAt: "2026-08-21T02:00:00.000Z", paymentStatus: "paid", publicId: "order_11111111-1111-4111-8111-111111111111", totalMinor: 100_000 });
    seedOrder(database.database, { orderNumber: "A2", paidAt: "2026-08-21T09:00:00.000Z", paymentStatus: "paid", publicId: "order_22222222-2222-4222-8222-222222222222", totalMinor: 50_000 });
    seedOrder(database.database, { orderNumber: "A3", paidAt: "2026-08-22T01:00:00.000Z", paymentStatus: "paid", publicId: "order_33333333-3333-4333-8333-333333333333", totalMinor: 70_000 });
    seedOrder(database.database, { orderNumber: "A4", paidAt: null, paymentStatus: "unpaid", publicId: "order_44444444-4444-4444-8444-444444444444", totalMinor: 10_000 });

    const metrics = await getSellerMetricsRange({ days: 7, env: appEnv(database), now: METRICS_NOW, shopPublicId: "public-a", userId: "user-a" });
    expect(metrics.currency).toBe("VND");
    expect(metrics.points).toEqual(densePoints("2026-08-22", 7, { "2026-08-21": 150_000, "2026-08-22": 70_000 }));
    expect(metrics.totalMinor).toBe(220_000);
    // The order-currency invariant (0044) blocks foreign rows at write time;
    // the defensive grouping surfaces 0 rather than ever summing across.
    expect(metrics.foreignCurrencyOrders).toBe(0);
  });

  it("rejects unknown windows and returns a dense 30-day zero series for a fresh shop", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    expect(parseMetricsDays("30")).toBe(30);
    expect(parseMetricsDays(null)).toBe(7);
    expect(() => parseMetricsDays("31")).toThrow(AppError);
    const metrics = await getSellerMetricsRange({ days: 30, env: appEnv(database), now: METRICS_NOW, shopPublicId: "public-a", userId: "user-a" });
    expect(metrics.points).toEqual(densePoints("2026-08-22", 30));
    expect(metrics.totalMinor).toBe(0);
  });

  it("keeps the advanced 90-day window Pro-only and dense", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    database.database.prepare("UPDATE shop_subscriptions SET plan_id = 'plan_starter_v1', version = version + 1 WHERE id = 'sub-a'").run();
    expect(parseMetricsDays("90")).toBe(90);
    await expect(getSellerMetricsRange({ days: 90, env: appEnv(database), now: METRICS_NOW, shopPublicId: "public-a", userId: "user-a" }))
      .rejects.toMatchObject({ code: "plan_feature_unavailable", status: 402 });

    database.database.prepare("UPDATE shop_subscriptions SET plan_id = 'plan_pro_v1', version = version + 1 WHERE id = 'sub-a'").run();
    const metrics = await getSellerMetricsRange({ days: 90, env: appEnv(database), now: METRICS_NOW, shopPublicId: "public-a", userId: "user-a" });
    expect(metrics.points).toEqual(densePoints("2026-08-22", 90));
    expect(metrics.totalMinor).toBe(0);
  });

  it("includes the exact oldest local midnight and excludes older and future rows", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    seedOrder(database.database, { orderNumber: "BOUNDARY", paidAt: "2026-08-15T17:00:00.000Z", paymentStatus: "paid", publicId: "order-boundary", totalMinor: 11 });
    seedOrder(database.database, { orderNumber: "TOO-OLD", paidAt: "2026-08-15T16:59:59.999Z", paymentStatus: "paid", publicId: "order-too-old", totalMinor: 100 });
    seedOrder(database.database, { orderNumber: "FUTURE", paidAt: "2026-08-22T12:00:00.001Z", paymentStatus: "paid", publicId: "order-future", totalMinor: 1_000 });

    const metrics = await getSellerMetricsRange({ days: 7, env: appEnv(database), now: METRICS_NOW, shopPublicId: "public-a", userId: "user-a" });
    expect(metrics.points).toEqual(densePoints("2026-08-22", 7, { "2026-08-16": 11 }));
    expect(metrics.totalMinor).toBe(11);
  });

  it("orders and bounds provider timestamps by instant rather than raw offset text", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    seedOrder(database.database, { orderNumber: "OFFSET-EQUAL", paidAt: "2026-08-22T19:00:00+07:00", paymentStatus: "paid", publicId: "order-offset-equal", totalMinor: 13 });
    seedOrder(database.database, { orderNumber: "OFFSET-FUTURE", paidAt: "2026-08-22T19:00:00.001+07:00", paymentStatus: "paid", publicId: "order-offset-future", totalMinor: 100 });

    const metrics = await getSellerMetricsRange({ days: 7, env: appEnv(database), now: METRICS_NOW, shopPublicId: "public-a", userId: "user-a" });
    expect(metrics.points).toEqual(densePoints("2026-08-22", 7, { "2026-08-22": 13 }));
    expect(metrics.totalMinor).toBe(13);
  });

  it.each([
    {
      boundary: "2026-03-08T05:00:00.000Z",
      beforeBoundary: "2026-03-08T04:59:59.999Z",
      endDate: "2026-03-14",
      now: "2026-03-14T16:00:00.000Z",
      repeatedHours: ["2026-03-08T06:30:00.000Z", "2026-03-08T07:30:00.000Z"],
      transitionDate: "2026-03-08",
    },
    {
      boundary: "2026-11-01T04:00:00.000Z",
      beforeBoundary: "2026-11-01T03:59:59.999Z",
      endDate: "2026-11-07",
      now: "2026-11-07T17:00:00.000Z",
      repeatedHours: ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"],
      transitionDate: "2026-11-01",
    },
  ])("keeps local-day boundaries correct across the $transitionDate DST transition", async ({ boundary, beforeBoundary, endDate, now, repeatedHours, transitionDate }) => {
    const database = createDatabase();
    seedTenant(database.database);
    database.database.prepare("UPDATE shops SET timezone = 'America/New_York' WHERE id = 'shop-a'").run();
    seedOrder(database.database, { orderNumber: "DST-BOUNDARY", paidAt: boundary, paymentStatus: "paid", publicId: `order-boundary-${transitionDate}`, totalMinor: 5 });
    seedOrder(database.database, { orderNumber: "DST-BEFORE", paidAt: beforeBoundary, paymentStatus: "paid", publicId: `order-before-${transitionDate}`, totalMinor: 100 });
    seedOrder(database.database, { orderNumber: "DST-FIRST", paidAt: repeatedHours[0] ?? null, paymentStatus: "paid", publicId: `order-first-${transitionDate}`, totalMinor: 10 });
    seedOrder(database.database, { orderNumber: "DST-SECOND", paidAt: repeatedHours[1] ?? null, paymentStatus: "paid", publicId: `order-second-${transitionDate}`, totalMinor: 20 });

    const metrics = await getSellerMetricsRange({ days: 7, env: appEnv(database), now: new Date(now), shopPublicId: "public-a", userId: "user-a" });
    expect(metrics.points).toEqual(densePoints(endDate, 7, { [transitionDate]: 35 }));
    expect(metrics.totalMinor).toBe(35);
  });

  it("uses the first valid instant when a timezone jumps across local midnight", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    database.database.prepare("UPDATE shops SET timezone = 'America/Havana' WHERE id = 'shop-a'").run();
    seedOrder(database.database, { orderNumber: "MIDNIGHT-JUMP-BEFORE", paidAt: "2026-03-08T04:59:59.999Z", paymentStatus: "paid", publicId: "order-midnight-jump-before", totalMinor: 100 });
    seedOrder(database.database, { orderNumber: "MIDNIGHT-JUMP-FIRST", paidAt: "2026-03-08T05:00:00.000Z", paymentStatus: "paid", publicId: "order-midnight-jump-first", totalMinor: 17 });

    const metrics = await getSellerMetricsRange({
      days: 7,
      env: appEnv(database),
      now: new Date("2026-03-14T16:00:00.000Z"),
      shopPublicId: "public-a",
      userId: "user-a",
    });
    expect(metrics.points).toEqual(densePoints("2026-03-14", 7, { "2026-03-08": 17 }));
    expect(metrics.totalMinor).toBe(17);
  });

  it("paginates more than 500 rows sharing the same paid_at without gaps or duplicates", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    database.database.exec("BEGIN");
    for (let index = 0; index < 501; index += 1) {
      const suffix = String(index).padStart(4, "0");
      seedOrder(database.database, {
        orderNumber: `BULK-${suffix}`,
        paidAt: "2026-08-21T04:00:00.000Z",
        paymentStatus: "paid",
        publicId: `order-bulk-${suffix}`,
        totalMinor: 1,
      });
    }
    database.database.exec("COMMIT");

    const metrics = await getSellerMetricsRange({ days: 7, env: appEnv(database), now: METRICS_NOW, shopPublicId: "public-a", userId: "user-a" });
    expect(metrics.points).toEqual(densePoints("2026-08-22", 7, { "2026-08-21": 501 }));
    expect(metrics.totalMinor).toBe(501);
  });

  it("uses the tenant-leading expression index for offset-aware paid ranges", () => {
    const database = createDatabase();
    const detail = database.database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT orders.id, orders.paid_at
      FROM orders
      WHERE orders.shop_id = ?
        AND orders.payment_status = 'paid'
        AND orders.paid_at IS NOT NULL
        AND julianday(orders.paid_at) >= julianday(?)
        AND julianday(orders.paid_at) <= julianday(?)
      ORDER BY julianday(orders.paid_at) DESC, orders.id DESC
      LIMIT 501
    `).all("shop-a", "2026-05-01T00:00:00.000Z", METRICS_NOW.toISOString())
      .map((row) => String(row.detail))
      .join("\n");

    expect(detail).toContain("idx_orders_shop_paid_julianday_id");
    expect(detail).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("denies advanced analytics when a Pro subscription is no longer paid and usable", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    database.database.prepare("UPDATE shop_subscriptions SET plan_id = 'plan_pro_v1' WHERE id = 'sub-a'").run();

    const invalidSubscriptions = [
      { currentPeriodEnd: "2026-08-22T11:59:59.999Z", state: "active" },
      { currentPeriodEnd: null, state: "active" },
      { currentPeriodEnd: "2099-01-01T00:00:00.000Z", state: "pending_payment" },
      { currentPeriodEnd: "2099-01-01T00:00:00.000Z", state: "suspended" },
    ];
    for (const subscription of invalidSubscriptions) {
      database.database.prepare("UPDATE shop_subscriptions SET state = ?, current_period_end = ?, version = version + 1 WHERE id = 'sub-a'")
        .run(subscription.state, subscription.currentPeriodEnd);
      await expect(getSellerMetricsRange({ days: 90, env: appEnv(database), now: METRICS_NOW, shopPublicId: "public-a", userId: "user-a" }))
        .rejects.toMatchObject({ code: "subscription_payment_required", status: 402 });
    }
  });

  it("keeps metrics tenant-isolated and rejects a foreign member", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    database.database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES ('user-b', 'b@example.test', 'Owner B', 'active', ?, ?)").run(NOW, NOW);
    database.database.prepare(`
      INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
      VALUES ('shop-b', 'public-b', 'seller-b', 'Shop B', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
    `).run(NOW, NOW);
    database.database.prepare("INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES ('shop-b', 'user-b', 'owner', 'active', ?, ?)").run(NOW, NOW);
    database.database.prepare("INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at) VALUES ('sub-b', 'shop-b', 'plan_pro_v1', 'active', '2099-01-01T00:00:00.000Z', ?, ?)").run(NOW, NOW);
    seedOrder(database.database, { orderNumber: "TENANT-A", paidAt: "2026-08-21T04:00:00.000Z", paymentStatus: "paid", publicId: "order-tenant-a", totalMinor: 7 });
    seedOrder(database.database, { orderNumber: "TENANT-B", paidAt: "2026-08-21T04:00:00.000Z", paymentStatus: "paid", publicId: "order-tenant-b", shopId: "shop-b", totalMinor: 900 });

    const metrics = await getSellerMetricsRange({ days: 7, env: appEnv(database), now: METRICS_NOW, shopPublicId: "public-a", userId: "user-a" });
    expect(metrics.totalMinor).toBe(7);
    await expect(getSellerMetricsRange({ days: 7, env: appEnv(database), now: METRICS_NOW, shopPublicId: "public-a", userId: "user-b" }))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });
});

describe("seller today snapshot read model (EX3.2)", () => {
  it("composes six-state sections and a severity-sorted queue from real data", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    seedOrder(database.database, { orderNumber: "B1", paidAt: "2026-08-22T02:00:00.000Z", paymentStatus: "paid", publicId: "order_21111111-1111-4111-8111-111111111111", totalMinor: 120_000 });
    seedOrder(database.database, { orderNumber: "B2", paidAt: "2026-08-21T02:00:00.000Z", paymentStatus: "partial", publicId: "order_21212121-1212-4121-8121-121212121212", totalMinor: 30_000 });

    const snapshot = await getSellerTodaySnapshot({ env: appEnv(database), now: METRICS_NOW, shopPublicId: "public-a", userId: "user-a" });
    expect(snapshot.role).toBe("owner");
    expect(snapshot.metrics.state).toBe("ready");
    expect(snapshot.metrics.data?.totalMinor).toBe(120_000);
    expect(snapshot.recentOrders.state).toBe("ready");
    expect(snapshot.recentOrders.data).toHaveLength(2);
    const kinds = snapshot.queue.data?.map((item) => item.kind) ?? [];
    expect(kinds).toContain("payment_exception");
    expect(snapshot.queue.data?.[0]?.severity).toBe("blocked");
    expect(snapshot.fetchedAt).toBeTruthy();
  });

  it("marks owner-only sections forbidden for a support member instead of empty", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    database.database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
      .run("usr_51111111-1111-4111-8111-111111111111", "s@example.test", "Support S", NOW, NOW);
    database.database.prepare("INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES ('shop-a', 'usr_51111111-1111-4111-8111-111111111111', 'support', 'active', ?, ?)").run(NOW, NOW);

    const snapshot = await getSellerTodaySnapshot({ env: appEnv(database), now: METRICS_NOW, shopPublicId: "public-a", userId: "usr_51111111-1111-4111-8111-111111111111" });
    expect(snapshot.role).toBe("support");
    expect(snapshot.activity.state).toBe("forbidden");
    expect(snapshot.activity.data).toBeUndefined();
    // Orders stay visible (masked) for support — never a fake empty.
    expect(["ready", "empty"]).toContain(snapshot.recentOrders.state);
  });
});
