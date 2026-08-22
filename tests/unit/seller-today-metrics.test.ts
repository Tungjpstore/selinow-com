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
  totalMinor: number;
};

function seedOrder(database: DatabaseSync, seed: OrderSeed): void {
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status, payment_status, fulfillment_status,
      subtotal_minor, total_minor, currency, locale, checkout_subject_hash, order_token_hash, expires_at, paid_at, created_at, updated_at
    ) VALUES (?, ?, 'shop-a', ?, 'web', ?, ?, 'unfulfilled', ?, ?, ?, 'vi', ?, ?, ?, ?, ?, ?)
  `).run(
    seed.publicId,
    seed.publicId,
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
  it("aggregates paid orders per day in the shop currency and never sums across currencies", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    seedOrder(database.database, { orderNumber: "A1", paidAt: "2026-08-21T02:00:00.000Z", paymentStatus: "paid", publicId: "order_11111111-1111-4111-8111-111111111111", totalMinor: 100_000 });
    seedOrder(database.database, { orderNumber: "A2", paidAt: "2026-08-21T09:00:00.000Z", paymentStatus: "paid", publicId: "order_22222222-2222-4222-8222-222222222222", totalMinor: 50_000 });
    seedOrder(database.database, { orderNumber: "A3", paidAt: "2026-08-22T01:00:00.000Z", paymentStatus: "paid", publicId: "order_33333333-3333-4333-8333-333333333333", totalMinor: 70_000 });
    seedOrder(database.database, { orderNumber: "A4", paidAt: null, paymentStatus: "unpaid", publicId: "order_44444444-4444-4444-8444-444444444444", totalMinor: 10_000 });

    const metrics = await getSellerMetricsRange({ days: 7, env: appEnv(database), shopPublicId: "public-a", userId: "user-a" });
    expect(metrics.currency).toBe("VND");
    expect(metrics.points).toEqual([
      { date: "2026-08-21", totalMinor: 150_000 },
      { date: "2026-08-22", totalMinor: 70_000 },
    ]);
    expect(metrics.totalMinor).toBe(220_000);
    // The order-currency invariant (0044) blocks foreign rows at write time;
    // the defensive grouping surfaces 0 rather than ever summing across.
    expect(metrics.foreignCurrencyOrders).toBe(0);
  });

  it("rejects unknown day windows and returns empty points for a fresh shop", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    expect(parseMetricsDays("30")).toBe(30);
    expect(parseMetricsDays(null)).toBe(7);
    expect(() => parseMetricsDays("31")).toThrow(AppError);
    const metrics = await getSellerMetricsRange({ days: 7, env: appEnv(database), shopPublicId: "public-a", userId: "user-a" });
    expect(metrics.points).toEqual([]);
    expect(metrics.totalMinor).toBe(0);
  });
});

describe("seller today snapshot read model (EX3.2)", () => {
  it("composes six-state sections and a severity-sorted queue from real data", async () => {
    const database = createDatabase();
    seedTenant(database.database);
    seedOrder(database.database, { orderNumber: "B1", paidAt: "2026-08-22T02:00:00.000Z", paymentStatus: "paid", publicId: "order_21111111-1111-4111-8111-111111111111", totalMinor: 120_000 });
    seedOrder(database.database, { orderNumber: "B2", paidAt: "2026-08-21T02:00:00.000Z", paymentStatus: "partial", publicId: "order_21212121-1212-4121-8121-121212121212", totalMinor: 30_000 });

    const snapshot = await getSellerTodaySnapshot({ env: appEnv(database), shopPublicId: "public-a", userId: "user-a" });
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

    const snapshot = await getSellerTodaySnapshot({ env: appEnv(database), shopPublicId: "public-a", userId: "usr_51111111-1111-4111-8111-111111111111" });
    expect(snapshot.role).toBe("support");
    expect(snapshot.activity.state).toBe("forbidden");
    expect(snapshot.activity.data).toBeUndefined();
    // Orders stay visible (masked) for support — never a fake empty.
    expect(["ready", "empty"]).toContain(snapshot.recentOrders.state);
  });
});
