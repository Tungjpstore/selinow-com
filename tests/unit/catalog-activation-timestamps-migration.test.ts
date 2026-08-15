import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE product_variants (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return database;
}

describe("catalog activation timestamp migration", () => {
  it("backfills conservatively and records the first future active transition", () => {
    const database = setup();
    database.exec(`
      INSERT INTO products VALUES ('prd_existing', 'shp_a', 'active', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO product_variants VALUES ('var_existing', 'shp_a', 'prd_existing', 'active', '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
      INSERT INTO products VALUES ('prd_draft', 'shp_a', 'draft', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    database.exec(readFileSync("migrations/0080_catalog_activation_timestamps.sql", "utf8"));

    expect(database.prepare("SELECT activated_at AS activatedAt FROM products WHERE id = 'prd_existing'").get()).toEqual({
      activatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(database.prepare("SELECT activated_at AS activatedAt FROM product_variants WHERE id = 'var_existing'").get()).toEqual({
      activatedAt: "2026-01-03T00:00:00.000Z",
    });

    database.prepare("UPDATE products SET status = 'active', updated_at = ? WHERE id = 'prd_draft'")
      .run("2026-01-04T00:00:00.000Z");
    database.prepare("UPDATE products SET updated_at = ? WHERE id = 'prd_draft'")
      .run("2026-01-05T00:00:00.000Z");
    expect(database.prepare("SELECT activated_at AS activatedAt FROM products WHERE id = 'prd_draft'").get()).toEqual({
      activatedAt: "2026-01-04T00:00:00.000Z",
    });
  });

  it("sets active insert timestamps and rejects later mutation", () => {
    const database = setup();
    database.exec(readFileSync("migrations/0080_catalog_activation_timestamps.sql", "utf8"));
    database.exec(`
      INSERT INTO products (id, shop_id, status, created_at, updated_at)
      VALUES ('prd_new', 'shp_a', 'active', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
      INSERT INTO product_variants (id, shop_id, product_id, status, created_at, updated_at)
      VALUES ('var_new', 'shp_a', 'prd_new', 'active', '2026-02-02T00:00:00.000Z', '2026-02-02T00:00:00.000Z');
    `);

    expect(database.prepare("SELECT activated_at AS activatedAt FROM products WHERE id = 'prd_new'").get()).toEqual({
      activatedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(() => database.prepare("UPDATE products SET activated_at = ? WHERE id = 'prd_new'")
      .run("2026-02-03T00:00:00.000Z")).toThrow("products_activated_at_immutable");
  });
});
