import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listShopInvoices, type InvoiceStatus } from "../../src/lib/billing/invoices";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const SHOP_A = "shop-invoice-a";
const SHOP_B = "shop-invoice-b";

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: Array<string | number | null> = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values as Array<string | number | null>);
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- D1 .all<T>() shape
  all<T>(): Promise<{ results: T[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) as T[] });
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
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }
}

function applyMigrations(database: DatabaseSync, through = "0099"): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= through).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function seedShops(database: DatabaseSync): void {
  const now = NOW.toISOString();
  for (const shopId of [SHOP_A, SHOP_B]) {
    database.exec(`
      INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
      VALUES ('plan-${shopId}', 'plan_${shopId}', 'Business', '{}', '{}', '${now}', '${now}');
      INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
      VALUES ('${shopId}', '${shopId}-public', '${shopId}-slug', 'Invoice Shop', 'active', 'en', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}');
      INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at)
      VALUES ('sub-${shopId}', '${shopId}', 'plan-${shopId}', 'active', '2099-01-01T00:00:00.000Z', '${now}', '${now}');
    `);
  }
}

function seedInvoice(
  database: DatabaseSync,
  input: {
    amountMinor?: number;
    createdAt: string;
    id: string;
    paidAt?: string | null;
    providerInvoiceRef?: string | null;
    shopId: string;
    status: InvoiceStatus;
  },
): void {
  const failureCode = input.status === "failed" ? "card_declined" : null;
  const paidAt = input.status === "paid" ? input.paidAt ?? input.createdAt : input.paidAt ?? null;
  database.prepare(`
    INSERT INTO billing_invoices (
      id, shop_id, subscription_id, provider_code, provider_invoice_ref,
      provider_transaction_ref, status, amount_minor, currency,
      period_start, period_end, paid_at, failure_code, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'payos', ?, NULL, ?, ?, 'VND', NULL, NULL, ?, ?, 1, ?, ?)
  `).run(
    input.id,
    input.shopId,
    `sub-${input.shopId}`,
    input.providerInvoiceRef ?? null,
    input.status,
    input.amountMinor ?? 199_000,
    paidAt,
    failureCode,
    input.createdAt,
    input.createdAt,
  );
}

describe("billing invoice history", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    seedShops(database);
    env = { APP_ENV: "local", PLATFORM_DB: new SqliteD1(database) } as unknown as AppBindings;
  });

  afterEach(() => {
    database.close();
  });

  it("never crosses tenants: only the requested shop's invoices are returned", async () => {
    seedInvoice(database, { createdAt: "2026-08-01T09:00:00.000Z", id: "inv-a-1", shopId: SHOP_A, status: "paid" });
    seedInvoice(database, { createdAt: "2026-08-05T09:00:00.000Z", id: "inv-a-2", providerInvoiceRef: "PAYOS-A2", shopId: SHOP_A, status: "open" });
    seedInvoice(database, { createdAt: "2026-08-07T09:00:00.000Z", id: "inv-b-1", shopId: SHOP_B, status: "paid" });
    seedInvoice(database, { createdAt: "2026-08-08T09:00:00.000Z", id: "inv-b-2", shopId: SHOP_B, status: "past_due" });

    const invoices = await listShopInvoices({ env, shopId: SHOP_A });

    expect(invoices.map((invoice) => invoice.id)).toEqual(["inv-a-2", "inv-a-1"]);
    expect(JSON.stringify(invoices)).not.toContain("inv-b");
    expect(invoices[0]).toMatchObject({
      amountMinor: 199_000,
      currency: "VND",
      providerCode: "payos",
      providerInvoiceRef: "PAYOS-A2",
      status: "open",
    });
  });

  it("orders newest-first with id as the deterministic tie-breaker", async () => {
    const sameInstant = "2026-08-10T09:00:00.000Z";
    seedInvoice(database, { createdAt: sameInstant, id: "inv-tie-1", shopId: SHOP_A, status: "paid" });
    seedInvoice(database, { createdAt: sameInstant, id: "inv-tie-2", shopId: SHOP_A, status: "paid" });
    seedInvoice(database, { createdAt: "2026-08-12T09:00:00.000Z", id: "inv-newest", shopId: SHOP_A, status: "paid" });

    const invoices = await listShopInvoices({ env, shopId: SHOP_A });
    expect(invoices.map((invoice) => invoice.id)).toEqual(["inv-newest", "inv-tie-2", "inv-tie-1"]);
  });

  it("returns an empty list for a shop without invoices", async () => {
    await expect(listShopInvoices({ env, shopId: SHOP_A })).resolves.toEqual([]);
    await expect(listShopInvoices({ env, shopId: "shop-does-not-exist" })).resolves.toEqual([]);
  });

  it("supports every billing status the UI renders", async () => {
    const statuses: InvoiceStatus[] = ["draft", "failed", "open", "paid", "past_due", "refunded", "void"];
    statuses.forEach((status, index) => {
      seedInvoice(database, {
        createdAt: new Date(NOW.getTime() + index * 60_000).toISOString(),
        id: `inv-${status}`,
        shopId: SHOP_A,
        status,
      });
    });

    const invoices = await listShopInvoices({ env, shopId: SHOP_A });
    expect(new Set(invoices.map((invoice) => invoice.status))).toEqual(new Set(statuses));
  });

  it("clamps the limit at 50 invoices", async () => {
    for (let index = 0; index < 55; index += 1) {
      const padded = String(index).padStart(2, "0");
      seedInvoice(database, {
        createdAt: new Date(NOW.getTime() + index * 60_000).toISOString(),
        id: `inv-bulk-${padded}`,
        shopId: SHOP_A,
        status: "paid",
      });
    }

    const defaultList = await listShopInvoices({ env, shopId: SHOP_A });
    expect(defaultList).toHaveLength(50);
    expect(defaultList[0]?.id).toBe("inv-bulk-54");

    const oversized = await listShopInvoices({ env, limit: 500, shopId: SHOP_A });
    expect(oversized).toHaveLength(50);

    const small = await listShopInvoices({ env, limit: 3, shopId: SHOP_A });
    expect(small).toHaveLength(3);
  });
});
