import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  getPrincipalPaymentFulfillmentEligibility,
  createOrRecoverPrincipalPaymentHandoff,
} from "../../src/lib/payments/store";
import { revealPrincipalDigitalFulfillment } from "../../src/lib/commerce/digital-fulfillment";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = "2026-07-29T00:00:00.000Z";
const SHOP_ID = "shop-telegram-guard";
const CUSTOMER_ID = "customer-telegram-guard";
const ORDER_ID = "order-telegram-guard";
const CONNECTION_A = "connection-telegram-a";
const CONNECTION_B = "connection-telegram-b";

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
}

class TrackingSqliteD1 {
  revealQueryCount = 0;

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    if (sql.includes("ciphertext_b64 AS ciphertextB64")) this.revealQueryCount += 1;
    return new SqliteStatement(this.database, sql);
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(): TrackingSqliteD1 {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }

  database.exec(`
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('${SHOP_ID}', 'shop-public-telegram-guard', 'telegram-guard', 'Telegram Guard', 'active', 'en', 'VND', 'UTC', 1, '${NOW}', '${NOW}');
    INSERT INTO shop_customers (id, shop_id, locale, status, created_at, updated_at)
    VALUES ('${CUSTOMER_ID}', '${SHOP_ID}', 'en', 'active', '${NOW}', '${NOW}');
    INSERT INTO shop_channels (id, shop_id, channel_code, status, created_at, updated_at)
    VALUES ('shop-channel-telegram', '${SHOP_ID}', 'telegram', 'enabled', '${NOW}', '${NOW}');
    INSERT INTO channel_connections (id, public_id, shop_id, shop_channel_id, provider_code, status, created_at, updated_at)
    VALUES
      ('${CONNECTION_A}', 'connection-public-a', '${SHOP_ID}', 'shop-channel-telegram', 'telegram', 'active', '${NOW}', '${NOW}'),
      ('${CONNECTION_B}', 'connection-public-b', '${SHOP_ID}', 'shop-channel-telegram', 'telegram', 'active', '${NOW}', '${NOW}');
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor, total_minor,
      currency, locale, checkout_subject_hash, order_token_hash, expires_at,
      created_at, updated_at
    ) VALUES (
      '${ORDER_ID}', 'order-public-telegram-guard', '${SHOP_ID}', '${CUSTOMER_ID}', 'TG-GUARD-1', 'telegram',
      'pending_payment', 'unpaid', 'reserved', 9000, 0, 9000, 'VND', 'en', 'subject', 'token',
      '2099-01-01T00:00:00.000Z', '${NOW}', '${NOW}'
    );
    INSERT INTO order_channel_attributions (shop_id, order_id, channel_code, adapter_version, connection_id, created_at)
    VALUES ('${SHOP_ID}', '${ORDER_ID}', 'telegram', 1, '${CONNECTION_A}', '${NOW}');
  `);
  return new TrackingSqliteD1(database);
}

function envFor(database: TrackingSqliteD1): AppBindings {
  return { PLATFORM_DB: database as unknown as D1Database } as AppBindings;
}

describe("Telegram payment and fulfillment connection guards", () => {
  it("allows the attributed connection while rejecting another bot in the same shop", async () => {
    const database = createDatabase();
    const env = envFor(database);

    await expect(getPrincipalPaymentFulfillmentEligibility({
      connectionId: CONNECTION_A,
      customerId: CUSTOMER_ID,
      env,
      orderPublicId: "order-public-telegram-guard",
      shopId: SHOP_ID,
      sourceChannel: "telegram",
    })).resolves.toEqual({ eligible: false, reason: "payment_unconfirmed" });

    await expect(getPrincipalPaymentFulfillmentEligibility({
      connectionId: CONNECTION_B,
      customerId: CUSTOMER_ID,
      env,
      orderPublicId: "order-public-telegram-guard",
      shopId: SHOP_ID,
      sourceChannel: "telegram",
    })).rejects.toMatchObject({ code: "order_not_found", status: 404 });

    await expect(createOrRecoverPrincipalPaymentHandoff({
      connectionId: CONNECTION_A,
      customerId: CUSTOMER_ID,
      env,
      orderPublicId: "order-public-telegram-guard",
      origin: "https://telegram.example.test",
      shopId: SHOP_ID,
      sourceChannel: "telegram",
    })).rejects.toMatchObject({ code: "payment_not_configured", status: 409 });

    await expect(createOrRecoverPrincipalPaymentHandoff({
      connectionId: CONNECTION_B,
      customerId: CUSTOMER_ID,
      env,
      orderPublicId: "order-public-telegram-guard",
      origin: "https://telegram.example.test",
      shopId: SHOP_ID,
      sourceChannel: "telegram",
    })).rejects.toMatchObject({ code: "order_not_found", status: 404 });
  });

  it("rejects a wrong-connection reveal before the secret-key query", async () => {
    const database = createDatabase();
    const env = envFor(database);

    await expect(revealPrincipalDigitalFulfillment({
      connectionId: CONNECTION_B,
      customerId: CUSTOMER_ID,
      env,
      orderPublicId: "order-public-telegram-guard",
      shopId: SHOP_ID,
      sourceChannel: "telegram",
    })).rejects.toMatchObject({ code: "order_not_found", status: 404 });
    expect(database.revealQueryCount).toBe(0);
  });
});
