import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../../src/lib/core/errors";
import { createSellerDiscount, listSellerDiscounts, parseSellerDiscountInput, setSellerDiscountStatus } from "../../src/lib/commerce/seller-discounts";
import type { AppBindings } from "../../src/lib/platform/bindings";

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
const NOW = "2026-08-22T00:00:00.000Z";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup(): { database: DatabaseSync; env: AppBindings } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
  database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES ('user-a', 'a@example.test', 'Owner A', 'active', ?, ?)").run(NOW, NOW);
  database.prepare(`
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('shop-a', 'public-a', 'seller-a', 'Shop A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(NOW, NOW);
  database.prepare("INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES ('shop-a', 'user-a', 'owner', 'active', ?, ?)").run(NOW, NOW);
  database.prepare("INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at) VALUES ('sub-a', 'shop-a', 'plan_business_v1', 'active', '2099-01-01T00:00:00.000Z', ?, ?)").run(NOW, NOW);
  database.prepare("INSERT INTO shop_settings (shop_id, branding_json, storefront_json, version, updated_at) VALUES ('shop-a', '{}', '{}', 1, ?)").run(NOW);
  const env = { PLATFORM_DB: new SqliteD1(database) as unknown as D1Database } as unknown as AppBindings;
  return { database, env };
}

describe("seller discount management (EX3.4b)", () => {
  it("validates input bounds: code, percentage cap, window ordering", () => {
    expect(() => parseSellerDiscountInput({ code: "ab", type: "percentage", value: 10 }, "VND")).toThrow(AppError);
    expect(() => parseSellerDiscountInput({ code: "SAVE10", type: "percentage", value: 95 }, "VND")).toThrow(AppError);
    expect(() => parseSellerDiscountInput({ code: "SAVE10", type: "fixed", value: 0 }, "VND")).toThrow(AppError);
    expect(() => parseSellerDiscountInput({ code: "SAVE10", type: "percentage", value: 10, endsAt: "2026-01-01T00:00:00.000Z", startsAt: "2026-02-01T00:00:00.000Z" }, "VND")).toThrow(AppError);
    const parsed = parseSellerDiscountInput({ code: " save10 ", endsAt: "2027-01-01T00:00:00Z", type: "percentage", value: 10 }, "VND");
    expect(parsed).toMatchObject({ code: "SAVE10", currency: null, type: "percentage", value: 10 });
  });

  it("creates, lists, disables, and re-enables with audit trail", async () => {
    const { database, env } = setup();
    const created = await createSellerDiscount({
      body: { code: "BUSTLE10", type: "percentage", value: 10 },
      env,
      requestId: "request-dsc-1",
      shopPublicId: "public-a",
      userId: "user-a",
    });
    expect(created).toMatchObject({ code: "BUSTLE10", status: "active", type: "percentage", value: 10 });

    const listed = await listSellerDiscounts({ env, shopPublicId: "public-a", userId: "user-a" });
    expect(listed.discounts).toHaveLength(1);

    const disabled = await setSellerDiscountStatus({ discountPublicId: created.id, env, nextStatus: "disabled", requestId: "request-dsc-2", shopPublicId: "public-a", userId: "user-a" });
    expect(disabled.status).toBe("disabled");
    const enabled = await setSellerDiscountStatus({ discountPublicId: created.id, env, nextStatus: "active", requestId: "request-dsc-3", shopPublicId: "public-a", userId: "user-a" });
    expect(enabled.status).toBe("active");

    const audit = database.prepare("SELECT action FROM audit_logs WHERE shop_id = 'shop-a' AND resource_type = 'discount'").all() as Array<{ action: string }>;
    expect([...audit.map((row) => row.action)].sort()).toEqual(["seller.discount.created", "seller.discount.disabled", "seller.discount.enabled"].sort());
  });

  it("rejects duplicate codes and stays tenant-scoped", async () => {
    const { database, env } = setup();
    await createSellerDiscount({ body: { code: "DUPE1", type: "fixed", value: 50_000 }, env, requestId: "request-dsc-4", shopPublicId: "public-a", userId: "user-a" });
    await expect(createSellerDiscount({ body: { code: "DUPE1", type: "fixed", value: 10_000 }, env, requestId: "request-dsc-5", shopPublicId: "public-a", userId: "user-a" }))
      .rejects.toMatchObject({ code: "discount_conflict" });

    database.prepare(`
      INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
      VALUES ('shop-b', 'public-b', 'seller-b', 'Shop B', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
    `).run(NOW, NOW);
    const listed = await listSellerDiscounts({ env, shopPublicId: "public-a", userId: "user-a" });
    expect(listed.discounts.every((discount) => discount.code === "DUPE1")).toBe(true);
  });

  it("returns resource_not_found for another shop's discount id", async () => {
    const { database, env } = setup();
    const created = await createSellerDiscount({ body: { code: "MINE01", type: "percentage", value: 5 }, env, requestId: "request-dsc-6", shopPublicId: "public-a", userId: "user-a" });
    database.prepare(`
      INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
      VALUES ('shop-b', 'public-b', 'seller-b', 'Shop B', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
    `).run(NOW, NOW);
    database.prepare("INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES ('shop-b', 'user-a', 'owner', 'active', ?, ?)").run(NOW, NOW);
    database.prepare("INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at) VALUES ('sub-b', 'shop-b', 'plan_business_v1', 'active', '2099-01-01T00:00:00.000Z', ?, ?)").run(NOW, NOW);
    await expect(setSellerDiscountStatus({ discountPublicId: created.id, env, nextStatus: "disabled", requestId: "request-dsc-7", shopPublicId: "public-b", userId: "user-a" }))
      .rejects.toMatchObject({ code: "resource_not_found" });
  });
});
