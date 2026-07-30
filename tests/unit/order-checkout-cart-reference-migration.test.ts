import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createPreMigrationDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 29)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  return database;
}

function insertShop(database: DatabaseSync, id: string): void {
  const now = "2026-07-29T00:00:00.000Z";
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(id, `public-${id}`, `slug-${id}`, `Shop ${id}`, now, now);
}

function insertCart(database: DatabaseSync, id: string, shopId: string): void {
  const now = "2026-07-29T00:00:00.000Z";
  database.prepare(`
    INSERT INTO carts (
      id, shop_id, channel, subject_hash, locale, state, expires_at, created_at, updated_at
    ) VALUES (?, ?, 'telegram', ?, 'vi', 'converted', ?, ?, ?)
  `).run(id, shopId, `subject-${id}`, "2026-07-29T01:00:00.000Z", now, now);
}

function insertOrder(database: DatabaseSync, id: string, shopId: string): void {
  const now = "2026-07-29T00:00:00.000Z";
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor, total_minor,
      currency, locale, customer_email_masked, checkout_subject_hash,
      checkout_request_hash, order_token_hash, expires_at, paid_at, fulfilled_at,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, NULL, ?, 'telegram', 'pending_payment', 'unpaid', 'reserved',
      10000, 0, 10000, 'VND', 'vi', NULL, ?, ?, ?, ?, NULL, NULL, ?, ?
    )
  `).run(
    id,
    `public-${id}`,
    shopId,
    `number-${id}`,
    `checkout-${id}`,
    `request-${id}`,
    `token-${id}`,
    "2026-07-29T01:00:00.000Z",
    now,
    now,
  );
}

describe("order checkout cart reference migration", () => {
  it("adds a nullable legacy-safe reference with a tenant-leading partial index", () => {
    const database = createPreMigrationDatabase();
    insertShop(database, "shop-a");
    insertShop(database, "shop-b");
    insertCart(database, "cart-a", "shop-a");
    insertCart(database, "cart-b", "shop-b");
    insertOrder(database, "order-a", "shop-a");
    insertOrder(database, "order-b", "shop-b");

    database.exec(readFileSync("migrations/0030_order_checkout_cart_reference.sql", "utf8"));

    const column = database.prepare("PRAGMA table_info(orders)").all()
      .find((entry) => entry.name === "checkout_cart_id");
    expect(column).toMatchObject({ dflt_value: null, name: "checkout_cart_id", notnull: 0, type: "TEXT" });
    expect(database.prepare("SELECT id, checkout_cart_id AS checkoutCartId FROM orders ORDER BY id").all())
      .toEqual([
        { checkoutCartId: null, id: "order-a" },
        { checkoutCartId: null, id: "order-b" },
      ]);

    database.prepare("UPDATE orders SET checkout_cart_id = ? WHERE shop_id = ? AND id = ?")
      .run("cart-a", "shop-a", "order-a");
    database.prepare("UPDATE orders SET checkout_cart_id = ? WHERE shop_id = ? AND id = ?")
      .run("cart-b", "shop-b", "order-b");

    expect(database.prepare("PRAGMA index_info(idx_orders_shop_checkout_cart)").all()
      .map((entry) => entry.name))
      .toEqual(["shop_id", "checkout_cart_id", "id"]);
    expect(database.prepare("PRAGMA index_list(orders)").all()
      .find((entry) => entry.name === "idx_orders_shop_checkout_cart"))
      .toMatchObject({ partial: 1, unique: 0 });
    expect(database.prepare(`
      SELECT id FROM orders WHERE shop_id = ? AND checkout_cart_id = ?
    `).all("shop-a", "cart-a")).toEqual([{ id: "order-a" }]);
    expect(database.prepare(`
      SELECT id FROM orders WHERE shop_id = ? AND checkout_cart_id = ?
    `).all("shop-b", "cart-a")).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
