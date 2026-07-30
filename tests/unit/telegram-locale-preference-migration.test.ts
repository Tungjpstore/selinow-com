import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const databases: DatabaseSync[] = [];
const NOW = "2026-07-29T00:00:00.000Z";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 44)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES ('shop-locale', 'public-locale', 'locale-shop', 'Locale shop', 'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}');
    INSERT INTO shop_customers (id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at)
    VALUES ('customer-locale', 'shop-locale', NULL, 'Buyer', 'en', 'active', '${NOW}', '${NOW}');
  `);
  return database;
}

describe("Telegram customer locale preference migration", () => {
  it("adds a nullable, forward-only explicit preference column", () => {
    const database = createDatabase();
    database.exec(readFileSync("migrations/0045_telegram_customer_locale_preference.sql", "utf8"));

    expect(database.prepare("PRAGMA table_info(shop_customers)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "preferred_locale", notnull: 0 }),
    ]));
    expect(database.prepare("SELECT preferred_locale AS preferredLocale FROM shop_customers WHERE id = 'customer-locale'").get()).toEqual({ preferredLocale: null });
  });

  it("accepts only supported explicit locales and preserves the previous value on rejection", () => {
    const database = createDatabase();
    database.exec(readFileSync("migrations/0045_telegram_customer_locale_preference.sql", "utf8"));

    database.prepare("UPDATE shop_customers SET preferred_locale = 'vi-VN' WHERE id = 'customer-locale' AND shop_id = 'shop-locale'").run();
    expect(() => database.prepare("UPDATE shop_customers SET preferred_locale = 'fr-FR' WHERE id = 'customer-locale' AND shop_id = 'shop-locale'").run()).toThrow(/CHECK constraint failed/u);
    expect(database.prepare("SELECT preferred_locale AS preferredLocale FROM shop_customers WHERE id = 'customer-locale'").get()).toEqual({ preferredLocale: "vi-VN" });
    expect(() => database.prepare("INSERT INTO shop_customers (id, shop_id, locale, preferred_locale, status, created_at, updated_at) VALUES ('customer-invalid', 'shop-locale', 'en', 'fr', 'active', ?, ?)").run(NOW, NOW)).toThrow(/CHECK constraint failed/u);
  });
});

