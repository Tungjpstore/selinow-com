import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const databases: DatabaseSync[] = [];

function createLegacyDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number.parseInt(name.slice(0, 4), 10) <= 45)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  return database;
}

function seedLegacyManualOrder(database: DatabaseSync): void {
  const now = "2026-07-30T03:00:00.000Z";
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-migration-owner', 'migration-owner@example.test', 'Migration Owner', 'active', '${now}', '${now}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES ('shop-migration', 'shop_00000000-0000-4000-8000-0000000000c1',
      'migration-manual', 'Migration Manual', 'active', 'en', 'USD', 'UTC', 1, '${now}', '${now}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('shop-migration', 'user-migration-owner', 'owner', 'active', '${now}', '${now}');
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
    VALUES ('product-migration', 'shop-migration', 'manual', 'Manual', '', 'active', 'manual', 1, '${now}', '${now}');
    INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
    VALUES ('variant-migration', 'shop-migration', 'product-migration', 'MANUAL', 'Default', '{}', 1000, 'USD', 1, 5, 'active', 1, '${now}', '${now}');
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, paid_at, created_at, updated_at
    ) VALUES ('order-migration', 'order_00000000-0000-4000-8000-0000000000c1',
      'shop-migration', 'MIGRATION-1', 'web', 'processing', 'paid', 'unfulfilled',
      1000, 0, 1000, 'USD', 'en', 'subject-migration', 'token-migration',
      '2026-07-30T04:00:00.000Z', '${now}', '${now}', '${now}');
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title,
      variant_title, sku, unit_price_minor, quantity, line_total_minor,
      fulfillment_type, created_at
    ) VALUES ('oit_00000000-0000-4000-8000-0000000000c1', 'shop-migration',
      'order-migration', 'product-migration', 'variant-migration', 'Manual',
      'Default', 'MANUAL', 1000, 1, 1000, 'manual', '${now}');
    INSERT INTO fulfillments (id, shop_id, order_id, fulfillment_type, state, idempotency_key, created_at)
    VALUES ('fulfillment-migration', 'shop-migration', 'order-migration', 'manual',
      'pending', 'payment:migration', '${now}');
  `);
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("manual fulfillment migration 0046", () => {
  it("adds typed hash-only ledgers without reinterpreting legacy manual orders", () => {
    const database = createLegacyDatabase();
    seedLegacyManualOrder(database);

    database.exec(readFileSync("migrations/0046_manual_fulfillment_executions.sql", "utf8"));

    expect(database.prepare(`
      SELECT status, fulfillment_status AS fulfillmentStatus, fulfilled_at AS fulfilledAt
      FROM orders WHERE id = 'order-migration'
    `).get()).toEqual({ fulfilledAt: null, fulfillmentStatus: "unfulfilled", status: "processing" });
    expect(database.prepare("SELECT state, fulfilled_at AS fulfilledAt FROM fulfillments WHERE id = 'fulfillment-migration'").get())
      .toEqual({ fulfilledAt: null, state: "pending" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM manual_fulfillment_executions").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM external_fulfillment_references").get()).toEqual({ count: 0 });

    const columns = database.prepare("PRAGMA table_info(external_fulfillment_references)").all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toContain("reference_hash");
    expect(columns).not.toContain("reference");
    expect(columns).not.toContain("payload_json");
    expect(columns).not.toContain("credential");
  });
});
