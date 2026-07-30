import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SUPPORTED_CURRENCY_CODES } from "../../src/lib/i18n/currency";
import { ISO_3166_ALPHA2_CODES } from "../../src/lib/tenants/country";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function applyMigrations(database: DatabaseSync, maximumVersion: number): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= maximumVersion)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  applyMigrations(database, 31);
  const now = "2026-07-29T00:00:00.000Z";
  database.prepare(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-test', 'test', 'Test', '{}', '{}', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-test', 'test@example.test', 'Test', 'active', ?, ?)
  `).run(now, now);
  const shops: Array<[string, string, string, string | null, string | null]> = [
    ["shop-a", "public-a", "VND", null, null],
    ["shop-b", "public-b", "USD", "JP", "US"],
    ["shop-legacy-invalid-country", "public-invalid-country", "VND", "ZZ", "AA"],
    ["shop-legacy-currency", "public-legacy-currency", "CAD", null, null],
  ];
  for (const [id, publicId, currency, merchantCountry, businessCountry] of shops) {
    database.prepare(`
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency, timezone,
        merchant_country_code, business_country_code, readiness_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', 'en', ?, 'UTC', ?, ?, 1, ?, ?)
    `).run(id, publicId, id, id, currency, merchantCountry, businessCountry, now, now);
    database.prepare(`
      INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
      VALUES (?, 'user-test', 'owner', 'active', ?, ?)
    `).run(id, now, now);
    database.prepare(`
      INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, created_at, updated_at)
      VALUES (?, ?, 'plan-test', 'active', ?, ?)
    `).run(`subscription-${id}`, id, now, now);
  }
  database.prepare(`
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
    VALUES ('product-legacy-currency', 'shop-legacy-currency', 'legacy', 'Legacy', '', 'draft', 'manual', 1, ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor, currency,
      min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES ('variant-legacy-currency', 'shop-legacy-currency', 'product-legacy-currency',
      'LEGACY', 'Legacy', '{}', 100, 'VND', 1, 1, 'active', 1, ?, ?)
  `).run(now, now);
  return database;
}

describe("shop globalization invariants migration", () => {
  it("keeps TypeScript and D1 ISO code sets in exact parity and preserves compatible legacy state", () => {
    const database = createDatabase();
    database.exec(readFileSync("migrations/0032_shop_globalization_invariants.sql", "utf8"));

    const rows = database.prepare("SELECT code FROM iso_3166_alpha2_country_codes ORDER BY code").all() as Array<{ code: string }>;
    expect(rows.map((row) => row.code)).toEqual([...ISO_3166_ALPHA2_CODES].sort());
    expect(rows).toHaveLength(ISO_3166_ALPHA2_CODES.length);
    expect(database.prepare(`
      SELECT id, merchant_country_code AS merchantCountry, business_country_code AS businessCountry
      FROM shops ORDER BY id
    `).all()).toEqual([
      { businessCountry: null, id: "shop-a", merchantCountry: null },
      { businessCountry: "US", id: "shop-b", merchantCountry: "JP" },
      { businessCountry: null, id: "shop-legacy-currency", merchantCountry: null },
      { businessCountry: null, id: "shop-legacy-invalid-country", merchantCountry: null },
    ]);
    expect(database.prepare("SELECT currency FROM shops WHERE id = 'shop-legacy-currency'").get()).toEqual({ currency: "CAD" });
    expect(database.prepare("SELECT currency FROM product_variants WHERE id = 'variant-legacy-currency'").get()).toEqual({ currency: "VND" });

    for (const currency of SUPPORTED_CURRENCY_CODES) {
      database.prepare("UPDATE shops SET currency = ? WHERE id = 'shop-a'").run(currency);
    }
    expect(database.prepare("SELECT currency FROM shops WHERE id = 'shop-a'").get()).toEqual({ currency: "VND" });
  });

  it("rejects unsupported currency and country writes at the D1 boundary", () => {
    const database = createDatabase();
    database.exec(readFileSync("migrations/0032_shop_globalization_invariants.sql", "utf8"));

    expect(() => database.prepare("UPDATE shops SET currency = 'GBP' WHERE id = 'shop-a'").run()).toThrow(/shop_currency_unsupported/u);
    expect(() => database.prepare("UPDATE shops SET merchant_country_code = 'ZZ' WHERE id = 'shop-a'").run()).toThrow(/shop_country_code_invalid/u);
    expect(() => database.prepare("UPDATE shops SET business_country_code = 'jP' WHERE id = 'shop-a'").run()).toThrow(/shop_country_code_invalid/u);
    expect(() => database.prepare("UPDATE iso_3166_alpha2_country_codes SET code = 'ZZ' WHERE code = 'US'").run()).toThrow(/iso_country_codes_immutable/u);
    expect(() => database.prepare("DELETE FROM iso_3166_alpha2_country_codes WHERE code = 'US'").run()).toThrow(/iso_country_codes_immutable/u);
  });

  it("requires every new or changed variant to match its authoritative shop currency", () => {
    const database = createDatabase();
    database.exec(readFileSync("migrations/0032_shop_globalization_invariants.sql", "utf8"));
    const now = "2026-07-29T00:00:00.000Z";
    database.prepare(`
      INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
      VALUES ('product-a', 'shop-a', 'product-a', 'Product A', '', 'draft', 'manual', 1, ?, ?)
    `).run(now, now);
    const variantInsert = (id: string, shopId: string, currency: string) => database.prepare(`
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor, currency,
        min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES (?, ?, 'product-a', ?, 'Variant', '{}', 100, ?, 1, 1, 'active', 1, ?, ?)
    `).run(id, shopId, id, currency, now, now);

    variantInsert("variant-a", "shop-a", "VND");
    expect(() => variantInsert("variant-unsupported", "shop-a", "GBP")).toThrow(/variant_currency_unsupported/u);
    expect(() => variantInsert("variant-mismatch", "shop-a", "USD")).toThrow(/variant_currency_shop_mismatch/u);
    expect(() => database.prepare("UPDATE product_variants SET currency = 'USD' WHERE id = 'variant-a'").run()).toThrow(/variant_currency_shop_mismatch/u);
    expect(() => database.prepare("UPDATE product_variants SET shop_id = 'shop-b' WHERE id = 'variant-a'").run()).toThrow(/variant_currency_shop_mismatch/u);
    expect(() => database.prepare("UPDATE shops SET currency = 'USD' WHERE id = 'shop-a'").run()).toThrow(/shop_currency_variant_mismatch/u);
  });
});
