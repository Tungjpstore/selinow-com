import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { checkoutCart, createCart, quoteCart } from "../../src/lib/commerce/store";
import type { AppBindings } from "../../src/lib/platform/bindings";
import type { StorefrontShop } from "../../src/lib/storefront/store";
import { FALLBACK_STOREFRONT_TEMPLATE } from "../../src/lib/storefront/templates";

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

  async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(): SqliteD1 {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  const now = "2026-07-29T00:00:00.000Z";
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('zero_total_user', 'zero-total@example.test', 'Zero total test', 'active', '${now}', '${now}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (
      'shop_zero_total', 'shop_public_zero_total', 'zero-total', 'Zero total',
      'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}'
    );
    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES
      ('product_zero_manual', 'shop_zero_total', 'zero-manual', 'Zero manual', '', 'active', 'manual', 1, '${now}', '${now}'),
      ('product_zero_license', 'shop_zero_total', 'zero-license', 'Zero license', '', 'active', 'license_key', 1, '${now}', '${now}');
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      currency, min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES
      ('variant_zero_manual', 'shop_zero_total', 'product_zero_manual', 'ZERO-MANUAL', 'Manual', '{}', 0, 'VND', 1, 5, 'active', 1, '${now}', '${now}'),
      ('variant_zero_license', 'shop_zero_total', 'product_zero_license', 'ZERO-LICENSE', 'License', '{}', 0, 'VND', 1, 5, 'active', 1, '${now}', '${now}');
    INSERT INTO inventory_batches (
      id, shop_id, variant_id, source, total_count, accepted_count,
      rejected_count, created_by_user_id, created_at
    ) VALUES (
      'batch_zero_license', 'shop_zero_total', 'variant_zero_license',
      'paste', 1, 1, 0, 'zero_total_user', '${now}'
    );
    INSERT INTO inventory_keys (
      id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
      key_version, key_fingerprint, created_at
    ) VALUES (
      'key_zero_license', 'shop_zero_total', 'variant_zero_license',
      'batch_zero_license', 'available', 'ciphertext', 'iv', 'v1',
      'fingerprint-zero-license', '${now}'
    );
  `);
  return new SqliteD1(database);
}

function shop(): StorefrontShop {
  return {
    access: "live",
    canonicalHostname: "zero-total.selinow.com",
    content: {
      announcement: null,
      deliveryText: "Giao sau xac minh",
      description: "Description",
      footerText: "Footer",
      headline: "Headline",
      seoDescription: "Description",
      seoTitle: "Zero total",
      showExactStock: false,
      supportText: "Support",
      templateId: null,
    },
    currency: "VND",
    currentHostname: "zero-total.selinow.com",
    defaultLocale: "vi",
    id: "shop_zero_total",
    lowStockThreshold: 5,
    name: "Zero total",
    orderExpiryMinutes: 30,
    publicId: "shop_public_zero_total",
    publicDetails: {
      deliveryText: "Giao sau xac minh",
      privacyUrl: null,
      refundPolicyUrl: null,
      support: { href: null, label: "Support" },
      termsUrl: null,
    },
    settingsVersion: 1,
    slug: "zero-total",
    status: "active",
    currentPeriodEnd: "2099-01-01T00:00:00.000Z",
    subscriptionState: "active",
    timezone: "Asia/Ho_Chi_Minh",
    template: FALLBACK_STOREFRONT_TEMPLATE,
    theme: {
      accent: "#0F766E",
      accentInk: "#FFFFFF",
      brand: "#115E59",
      brandInk: "#FFFFFF",
      logoUrl: null,
    },
  };
}

function envFor(database: SqliteD1): AppBindings {
  return {
    IDENTIFIER_HMAC_SECRET: "zero-total-secret",
    PLATFORM_DB: database as unknown as D1Database,
  } as AppBindings;
}

async function checkout(input: {
  database: SqliteD1;
  items: Array<{ quantity: number; variantId: string }>;
  idempotencyKey: string;
}) {
  const currentShop = shop();
  const env = envFor(input.database);
  const cart = await createCart({ env, items: input.items, locale: "vi", shop: currentShop });
  const quote = await quoteCart({ cartId: cart.cartId, cartToken: cart.cartToken, env, shop: currentShop });
  const orderInput = {
    cartId: cart.cartId,
    cartToken: cart.cartToken,
    customerEmail: "buyer-zero-total@example.test",
    env,
    expected: quote.items,
    idempotencyKey: input.idempotencyKey,
    quoteEvidence: quote.quoteEvidence,
    shop: currentShop,
  };
  return { order: await checkoutCart(orderInput), orderInput };
}

describe("website zero-total fulfillment policy", () => {
  it("keeps a free manual order paid but processing and unfulfilled", async () => {
    const database = createDatabase();
    const { order, orderInput } = await checkout({
      database,
      idempotencyKey: "checkout-zero-manual-0001",
      items: [{ quantity: 1, variantId: "variant_zero_manual" }],
    });

    expect(order).toMatchObject({ fulfillmentStatus: "unfulfilled", paymentStatus: "paid", status: "processing", totalMinor: 0 });
    const storedOrder = database.database.prepare(`
      SELECT status, payment_status AS paymentStatus,
        fulfillment_status AS fulfillmentStatus, paid_at AS paidAt, fulfilled_at AS fulfilledAt
      FROM orders WHERE shop_id = ? AND public_id = ?
    `).get("shop_zero_total", order.orderId) as {
      fulfilledAt: string | null;
      fulfillmentStatus: string;
      paidAt: string | null;
      paymentStatus: string;
      status: string;
    } | undefined;
    expect(storedOrder).toMatchObject({
      fulfillmentStatus: "unfulfilled",
      paymentStatus: "paid",
      status: "processing",
      fulfilledAt: null,
    });
    expect(typeof storedOrder?.paidAt).toBe("string");
    const manualFulfillments = database.database.prepare(`
      SELECT fulfillment_type AS fulfillmentType, state, idempotency_key AS idempotencyKey
      FROM fulfillments WHERE shop_id = ? AND order_id = (SELECT id FROM orders WHERE shop_id = ? AND public_id = ?)
    `).all("shop_zero_total", "shop_zero_total", order.orderId) as Array<{ fulfillmentType: string; idempotencyKey: string; state: string }>;
    expect(manualFulfillments).toHaveLength(1);
    expect(manualFulfillments[0]).toMatchObject({ fulfillmentType: "manual", state: "pending" });
    expect(manualFulfillments[0]?.idempotencyKey).toMatch(/^website-free:ord_[A-Za-z0-9-]+:manual$/u);

    await expect(checkoutCart(orderInput)).resolves.toEqual(order);
    expect(database.database.prepare(`
      SELECT COUNT(*) AS count FROM fulfillments
      WHERE shop_id = ? AND order_id = (SELECT id FROM orders WHERE shop_id = ? AND public_id = ?)
    `).get("shop_zero_total", "shop_zero_total", order.orderId)).toEqual({ count: 1 });
  });

  it("rejects mixed free fulfillment before creating an order", async () => {
    const database = createDatabase();
    await expect(checkout({
      database,
      idempotencyKey: "checkout-zero-mixed-0001",
      items: [{ quantity: 1, variantId: "variant_zero_license" }, { quantity: 1, variantId: "variant_zero_manual" }],
    })).rejects.toMatchObject({ code: "mixed_fulfillment_unsupported", status: 409 });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get("shop_zero_total")).toEqual({ count: 0 });
    expect(database.database.prepare("SELECT status FROM inventory_keys WHERE shop_id = ? AND id = 'key_zero_license'").get("shop_zero_total")).toEqual({ status: "available" });
  });
});
