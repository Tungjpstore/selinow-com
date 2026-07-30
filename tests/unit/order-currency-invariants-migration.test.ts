import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const databases: DatabaseSync[] = [];
const NOW = "2026-07-29T00:00:00.000Z";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function applyMigrationsThrough(database: DatabaseSync, maximumVersion: number): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= maximumVersion)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function applyOrderCurrencyMigration(database: DatabaseSync): void {
  database.exec(readFileSync("migrations/0044_order_currency_invariants.sql", "utf8"));
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrationsThrough(database, 43);
  database.exec(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('shop-currency-vnd', 'public-currency-vnd', 'currency-vnd', 'VND shop',
        'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'),
      ('shop-currency-usd', 'public-currency-usd', 'currency-usd', 'USD shop',
        'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}');
  `);
  return database;
}

function insertOrder(database: DatabaseSync, input: {
  currency: string;
  id: string;
  shopId: string;
}): void {
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'web', 'pending_payment', 'unpaid', 'unfulfilled',
      1000, 0, 1000, ?, 'en', ?, ?, ?, ?, ?)
  `).run(
    input.id,
    `public-${input.id}`,
    input.shopId,
    `number-${input.id}`,
    input.currency,
    `subject-${input.id}`,
    `token-${input.id}`,
    NOW,
    NOW,
    NOW,
  );
}

describe("order currency invariants migration", () => {
  it("validates persisted order snapshots before installing guards", () => {
    const database = createDatabase();
    insertOrder(database, { currency: "GBP", id: "order-unsupported", shopId: "shop-currency-vnd" });
    insertOrder(database, { currency: "USD", id: "order-mismatched", shopId: "shop-currency-vnd" });

    expect(() => {
      applyOrderCurrencyMigration(database);
    }).toThrow(/migration_0044_order_currency_valid/u);
    expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'orders_currency_%'").get()).toEqual({ count: 0 });

    database.prepare("DELETE FROM orders WHERE id IN ('order-unsupported', 'order-mismatched')").run();
    expect(() => {
      applyOrderCurrencyMigration(database);
    }).not.toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'migration_0044_order_currency_validation'").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'orders_currency_%' ORDER BY name").all()).toEqual([
      { name: "orders_currency_insert_shop_guard" },
      { name: "orders_currency_insert_unsupported_guard" },
      { name: "orders_currency_update_shop_guard" },
      { name: "orders_currency_update_unsupported_guard" },
    ]);
  });

  it("rejects unsupported and shop-mismatched order inserts without changing durable state", () => {
    const database = createDatabase();
    applyOrderCurrencyMigration(database);
    insertOrder(database, { currency: "VND", id: "order-valid", shopId: "shop-currency-vnd" });
    const before = database.prepare("SELECT id, shop_id AS shopId, currency, order_number AS orderNumber FROM orders ORDER BY id").all();

    expect(() => {
      insertOrder(database, { currency: "GBP", id: "order-unsupported", shopId: "shop-currency-vnd" });
    }).toThrow(/order_currency_unsupported/u);
    expect(() => {
      insertOrder(database, { currency: "USD", id: "order-mismatched", shopId: "shop-currency-vnd" });
    }).toThrow(/order_currency_shop_mismatch/u);

    expect(database.prepare("SELECT id, shop_id AS shopId, currency, order_number AS orderNumber FROM orders ORDER BY id").all()).toEqual(before);
  });

  it("rejects unsupported and shop-mismatched order updates without rewriting the snapshot", () => {
    const database = createDatabase();
    applyOrderCurrencyMigration(database);
    insertOrder(database, { currency: "VND", id: "order-update", shopId: "shop-currency-vnd" });

    expect(() => database.prepare("UPDATE orders SET currency = 'GBP' WHERE id = 'order-update'").run()).toThrow(/order_currency_unsupported/u);
    expect(() => database.prepare("UPDATE orders SET currency = 'USD' WHERE id = 'order-update'").run()).toThrow(/order_currency_shop_mismatch/u);
    expect(() => database.prepare("UPDATE orders SET shop_id = 'shop-currency-usd' WHERE id = 'order-update'").run()).toThrow(/order_currency_shop_mismatch/u);

    expect(database.prepare("SELECT shop_id AS shopId, currency FROM orders WHERE id = 'order-update'").get()).toEqual({ currency: "VND", shopId: "shop-currency-vnd" });
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("allows a supported order currency when it matches the authoritative shop", () => {
    const database = createDatabase();
    applyOrderCurrencyMigration(database);

    expect(() => {
      insertOrder(database, { currency: "USD", id: "order-usd", shopId: "shop-currency-usd" });
    }).not.toThrow();
    expect(database.prepare("SELECT currency FROM orders WHERE id = 'order-usd'").get()).toEqual({ currency: "USD" });
  });

  it("keeps the historical order snapshot when a shop changes currency later", () => {
    const database = createDatabase();
    applyOrderCurrencyMigration(database);
    insertOrder(database, { currency: "VND", id: "order-historical", shopId: "shop-currency-vnd" });

    database.prepare("UPDATE shops SET currency = 'USD' WHERE id = 'shop-currency-vnd'").run();

    expect(database.prepare("SELECT currency FROM orders WHERE id = 'order-historical'").get()).toEqual({ currency: "VND" });
  });
});
