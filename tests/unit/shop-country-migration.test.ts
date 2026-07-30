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
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 30)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  return database;
}

function insertLegacyShop(database: DatabaseSync, id: string): void {
  const now = "2026-07-29T00:00:00.000Z";
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(id, `public-${id}`, `slug-${id}`, `Shop ${id}`, now, now);
}

describe("shop country configuration migration", () => {
  it("keeps legacy country evidence unknown and adds tenant-leading partial indexes", () => {
    const database = createPreMigrationDatabase();
    insertLegacyShop(database, "shop-a");
    insertLegacyShop(database, "shop-b");

    database.exec(readFileSync("migrations/0031_shop_country_configuration.sql", "utf8"));

    const columns = database.prepare("PRAGMA table_info(shops)").all();
    expect(columns.find((entry) => entry.name === "merchant_country_code"))
      .toMatchObject({ dflt_value: null, notnull: 0, type: "TEXT" });
    expect(columns.find((entry) => entry.name === "business_country_code"))
      .toMatchObject({ dflt_value: null, notnull: 0, type: "TEXT" });
    expect(database.prepare(`
      SELECT id, merchant_country_code AS merchantCountry, business_country_code AS businessCountry
      FROM shops ORDER BY id
    `).all()).toEqual([
      { businessCountry: null, id: "shop-a", merchantCountry: null },
      { businessCountry: null, id: "shop-b", merchantCountry: null },
    ]);

    database.prepare(`
      UPDATE shops SET merchant_country_code = 'JP', business_country_code = 'US' WHERE id = 'shop-a'
    `).run();
    expect(() => database.prepare("UPDATE shops SET merchant_country_code = 'jP' WHERE id = 'shop-a'").run())
      .toThrow(/CHECK constraint failed/u);
    expect(() => database.prepare("UPDATE shops SET business_country_code = 'USA' WHERE id = 'shop-a'").run())
      .toThrow(/CHECK constraint failed/u);

    for (const [indexName, countryColumn] of [
      ["idx_shops_tenant_merchant_country", "merchant_country_code"],
      ["idx_shops_tenant_business_country", "business_country_code"],
    ] as const) {
      expect(database.prepare(`PRAGMA index_info('${indexName}')`).all().map((entry) => entry.name))
        .toEqual(["id", countryColumn]);
      expect(database.prepare("PRAGMA index_list(shops)").all().find((entry) => entry.name === indexName))
        .toMatchObject({ partial: 1, unique: 0 });
    }
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
