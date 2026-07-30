import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-07-29T00:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(`
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES
      ('shop-a', 'public-a', 'shop-a', 'Shop A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'),
      ('shop-b', 'public-b', 'shop-b', 'Shop B', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}');
    INSERT INTO carts (id, shop_id, channel, subject_hash, locale, state, expires_at, created_at, updated_at)
    VALUES
      ('cart-a', 'shop-a', 'web', 'subject-a', 'vi', 'active', '2026-07-30T00:00:00.000Z', '${NOW}', '${NOW}'),
      ('cart-b', 'shop-b', 'web', 'subject-b', 'vi', 'active', '2026-07-30T00:00:00.000Z', '${NOW}', '${NOW}');
  `);
  return database;
}

function replayValues(overrides: Record<string, string> = {}): string[] {
  const values = {
    id: "cmr-001",
    shopId: "shop-a",
    cartId: "cart-a",
    subjectHash: "subject-a",
    idempotencyKeyHash: "key-a",
    requestHash: "request-a",
    createdAt: NOW,
    expiresAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
  return [
    values.id,
    values.shopId,
    values.cartId,
    values.subjectHash,
    values.idempotencyKeyHash,
    values.requestHash,
    values.createdAt,
    values.expiresAt,
  ];
}

describe("cart mutation replay migration", () => {
  it("creates tenant-leading replay indexes and integrity guards", () => {
    const database = createDatabase();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cart_mutations'").get()).toEqual({ name: "cart_mutations" });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cart_mutations_cart_%_guard' ORDER BY name").all()).toEqual([
      { name: "cart_mutations_cart_insert_guard" },
      { name: "cart_mutations_cart_update_guard" },
    ]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'carts_cart_mutations_update_guard'").get()).toEqual({ name: "carts_cart_mutations_update_guard" });
    expect(database.prepare("PRAGMA index_list(cart_mutations)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idx_cart_mutations_shop_created" }),
      expect.objectContaining({ name: "idx_cart_mutations_expiry" }),
    ]));
  });

  it.each([
    ["cross-shop cart", { shopId: "shop-b" }],
    ["cross-shop subject", { subjectHash: "subject-b" }],
    ["cart expiry mismatch", { expiresAt: "2026-07-31T00:00:00.000Z" }],
    ["non-positive replay window", { createdAt: "2026-07-30T00:00:00.000Z" }],
  ])("rejects %s replay rows", (_label, overrides) => {
    const database = createDatabase();
    expect(() => database.prepare(`
      INSERT INTO cart_mutations (
        id, shop_id, cart_id, subject_hash, idempotency_key_hash,
        request_hash, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...replayValues(overrides))).toThrow("cart_mutation_cart_mismatch");
    expect(database.prepare("SELECT COUNT(*) AS count FROM cart_mutations").get()).toEqual({ count: 0 });
  });

  it("rejects changing an existing replay to another cart or channel", () => {
    const database = createDatabase();
    database.prepare(`
      INSERT INTO cart_mutations (
        id, shop_id, cart_id, subject_hash, idempotency_key_hash,
        request_hash, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...replayValues());

    expect(() => database.prepare("UPDATE cart_mutations SET cart_id = 'cart-b' WHERE id = 'cmr-001'").run()).toThrow("cart_mutation_cart_mismatch");
    expect(() => database.prepare("UPDATE carts SET channel = 'telegram' WHERE id = 'cart-a'").run()).toThrow("cart_mutation_cart_mismatch");
    expect(() => database.prepare("UPDATE carts SET expires_at = '2026-07-31T00:00:00.000Z' WHERE id = 'cart-a'").run()).toThrow("cart_mutation_cart_mismatch");
    expect(() => database.prepare("UPDATE cart_mutations SET subject_hash = 'subject-other' WHERE id = 'cmr-001'").run()).toThrow("cart_mutation_cart_mismatch");
  });

  it("keeps foreign-key integrity clean for valid replay rows", () => {
    const database = createDatabase();
    database.prepare(`
      INSERT INTO cart_mutations (
        id, shop_id, cart_id, subject_hash, idempotency_key_hash,
        request_hash, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...replayValues());
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
