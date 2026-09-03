import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { checkoutCart, createCart, expireUnpaidOrders, quoteCart } from "../../src/lib/commerce/store";
import type { StorefrontShop } from "../../src/lib/storefront/store";

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

const NOW = "2026-08-16T00:00:00.000Z";

function createRuntime(): { database: DatabaseSync; env: AppBindings; shop: StorefrontShop } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
  database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES ('user-ship', 'ship@example.test', 'Ship Owner', 'active', ?, ?)").run(NOW, NOW);
  database.prepare(`
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('shop-ship', 'public-ship', 'seller-ship', 'Ship Shop', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(NOW, NOW);
  database.prepare("INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES ('shop-ship', 'user-ship', 'owner', 'active', ?, ?)").run(NOW, NOW);
  database.prepare("INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at) VALUES ('sub-ship', 'shop-ship', 'plan_business_v1', 'active', '2099-01-01T00:00:00.000Z', ?, ?)").run(NOW, NOW);
  // Physical product with stock and one shipping method.
  database.prepare(`
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, delivery_mode, version, created_at, updated_at)
    VALUES ('prd-ship', 'shop-ship', 'ao-thun', 'Áo thun cotton', '', 'active', 'manual', 'shipping', 1, ?, ?)
  `).run(NOW, NOW);
  database.prepare(`
    INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
    VALUES ('var-ship', 'shop-ship', 'prd-ship', 'AO-M', 'Size M', '{}', 250000, 'VND', 1, 10, 'active', 1, ?, ?)
  `).run(NOW, NOW);
  database.prepare(`
    INSERT INTO variant_stock_levels (id, shop_id, variant_id, on_hand, reserved, updated_at)
    VALUES ('stk-ship', 'shop-ship', 'var-ship', 3, 0, ?)
  `).run(NOW);
  database.prepare(`
    INSERT INTO shop_shipping_methods (id, shop_id, name, fee_minor, free_over_minor, status, sort_order, created_at, updated_at)
    VALUES ('shm-ship', 'shop-ship', 'Giao nhanh', 30000, 1000000, 'active', 0, ?, ?)
  `).run(NOW, NOW);
  database.exec(`
    INSERT OR IGNORE INTO catalog_channel_visibility (shop_id, product_id, channel_code, status, version, updated_by_user_id, created_at, updated_at)
    VALUES ('shop-ship', 'prd-ship', 'website', 'visible', 1, 'user-ship', '${NOW}', '${NOW}');
  `);
  const env = {
    IDENTIFIER_HMAC_SECRET: "physical-shipping-test-secret",
    PLATFORM_DB: new SqliteD1(database),
  } as unknown as AppBindings;
  const shop = {
    access: "live",
    content: { showExactStock: false },
    currency: "VND",
    currentPeriodEnd: "2099-01-01T00:00:00.000Z",
    graceEndsAt: null,
    id: "shop-ship",
    lowStockThreshold: 5,
    orderExpiryMinutes: 30,
    status: "active",
    subscriptionState: "active",
    trialEndsAt: null,
  } as unknown as StorefrontShop;
  return { database, env, shop };
}

const ADDRESS = {
  addressLine: "12 Nguyễn Huệ, Chung cư A, Tầng 3",
  district: "Quận 1",
  fullName: "Nguyễn Văn Ba",
  notes: "Gọi trước khi giao",
  phone: "+84901234567",
  province: "TP. Hồ Chí Minh",
  ward: "Phường Bến Nghé",
};

async function physicalQuote(input: { env: AppBindings; methodId?: string; quantity?: number; shop: StorefrontShop }) {
  const cart = await createCart({ env: input.env, items: [{ quantity: input.quantity ?? 2, variantId: "var-ship" }], locale: "vi", shop: input.shop });
  const quote = await quoteCart({
    cartId: cart.cartId,
    cartToken: cart.cartToken,
    env: input.env,
    ...(input.methodId === undefined ? {} : { shippingMethodId: input.methodId }),
    shop: input.shop,
  });
  return { cart, quote };
}

describe("physical shipping checkout money path", () => {
  it("reserves stock atomically, stores the address, and snapshots the shipping fee", async () => {
    const runtime = createRuntime();
    const { cart, quote } = await physicalQuote({ env: runtime.env, methodId: "shm-ship", quantity: 2, shop: runtime.shop });
    expect(quote.shipping).toMatchObject({ feeMinor: 30000, methodId: "shm-ship" });
    expect(quote.totalMinor).toBe(250000 * 2 + 30000);
    const order = await checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer@example.test",
      env: runtime.env,
      expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: "physical-checkout-key-0001",
      quoteEvidence: quote.quoteEvidence,
      shop: runtime.shop,
      shipping: { address: ADDRESS, methodId: "shm-ship" },
    });
    expect(order).toMatchObject({ paymentStatus: "unpaid", status: "pending_payment", totalMinor: 530000 });
    expect(runtime.database.prepare("SELECT reserved, on_hand FROM variant_stock_levels WHERE variant_id = 'var-ship'").get()).toEqual({ on_hand: 3, reserved: 2 });
    const orderRow = runtime.database.prepare("SELECT shipping_method_name AS name, shipping_fee_minor AS fee FROM orders WHERE public_id = ?").get(order.orderId) as { fee: number; name: string };
    expect(orderRow).toEqual({ fee: 30000, name: "Giao nhanh" });
    const addressRow = runtime.database.prepare("SELECT full_name AS fullName, phone FROM order_shipping_addresses").get() as { fullName: string; phone: string };
    expect(addressRow).toEqual({ fullName: "Nguyễn Văn Ba", phone: "0901234567" });
  });

  it("rejects checkout when stock drops between quote and checkout, leaving no order behind", async () => {
    const runtime = createRuntime();
    const { cart, quote } = await physicalQuote({ env: runtime.env, methodId: "shm-ship", quantity: 2, shop: runtime.shop });
    // The seller sells out through another channel after the quote was issued.
    runtime.database.prepare("UPDATE variant_stock_levels SET on_hand = 1, reserved = 0, updated_at = ? WHERE variant_id = 'var-ship'").run(NOW);
    await expect(checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer@example.test",
      env: runtime.env,
      expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: "physical-checkout-key-0002",
      quoteEvidence: quote.quoteEvidence,
      shop: runtime.shop,
      shipping: { address: ADDRESS, methodId: "shm-ship" },
    })).rejects.toMatchObject({ code: "inventory_unavailable", status: 409 });
    expect(runtime.database.prepare("SELECT COUNT(*) AS total FROM orders").get()).toMatchObject({ total: 0 });
    expect(runtime.database.prepare("SELECT reserved FROM variant_stock_levels WHERE variant_id = 'var-ship'").get()).toMatchObject({ reserved: 0 });
  });

  it("applies the free-shipping threshold from the post-discount amount", async () => {
    const runtime = createRuntime();
    runtime.database.prepare("UPDATE variant_stock_levels SET on_hand = 5 WHERE variant_id = 'var-ship'").run();
    const { quote } = await physicalQuote({ env: runtime.env, methodId: "shm-ship", quantity: 4, shop: runtime.shop });
    // 4 × 250,000 = 1,000,000 ≥ free_over 1,000,000 → fee 0.
    expect(quote.shipping).toMatchObject({ feeMinor: 0 });
    expect(quote.totalMinor).toBe(1_000_000);
  });

  it("defaults the first quote to the shop's primary method and rejects invented ones", async () => {
    const runtime = createRuntime();
    // No methodId: the primary method is quoted by default.
    const defaulted = await physicalQuote({ env: runtime.env, shop: runtime.shop });
    expect(defaulted.quote.shipping).toMatchObject({ feeMinor: 30000, methodId: "shm-ship" });
    await expect(physicalQuote({ env: runtime.env, methodId: "shm-other-shop", shop: runtime.shop })).rejects.toMatchObject({ code: "shipping_method_not_found", status: 404 });
    const { cart, quote } = defaulted;
    await expect(checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer@example.test",
      env: runtime.env,
      expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: "physical-checkout-key-0003",
      quoteEvidence: quote.quoteEvidence,
      shop: runtime.shop,
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["shipping_address_required"] });
    await expect(checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer@example.test",
      env: runtime.env,
      expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: "physical-checkout-key-0004",
      quoteEvidence: quote.quoteEvidence,
      shop: runtime.shop,
      shipping: { address: { ...ADDRESS, phone: "123" }, methodId: "shm-ship" },
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["shipping_phone_invalid"] });
  });

  it("fails closed when the shipping method changes between quote and checkout", async () => {
    const runtime = createRuntime();
    runtime.database.prepare(`
      INSERT INTO shop_shipping_methods (id, shop_id, name, fee_minor, free_over_minor, status, sort_order, created_at, updated_at)
      VALUES ('shm-cheap', 'shop-ship', 'Giao thường', 10000, NULL, 'active', 1, ?, ?)
    `).run(NOW, NOW);
    const { cart, quote } = await physicalQuote({ env: runtime.env, methodId: "shm-ship", quantity: 1, shop: runtime.shop });
    await expect(checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer@example.test",
      env: runtime.env,
      expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: "physical-checkout-key-0005",
      quoteEvidence: quote.quoteEvidence,
      shop: runtime.shop,
      shipping: { address: ADDRESS, methodId: "shm-ship" },
    })).resolves.toMatchObject({ totalMinor: 280000 });
    // Same key replays the durable order instead of re-charging a new fee.
    const replay = await checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer@example.test",
      env: runtime.env,
      expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: "physical-checkout-key-0005",
      quoteEvidence: quote.quoteEvidence,
      shop: runtime.shop,
      shipping: { address: ADDRESS, methodId: "shm-ship" },
    });
    expect(replay.orderId).toMatch(/order_/);
    expect(runtime.database.prepare("SELECT COUNT(*) AS total FROM orders").get()).toMatchObject({ total: 1 });
  });

  it("releases reserved stock when an unpaid physical order expires", async () => {
    const runtime = createRuntime();
    const { cart, quote } = await physicalQuote({ env: runtime.env, methodId: "shm-ship", quantity: 3, shop: runtime.shop });
    const order = await checkoutCart({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer@example.test",
      env: runtime.env,
      expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: "physical-checkout-key-0006",
      quoteEvidence: quote.quoteEvidence,
      shop: runtime.shop,
      shipping: { address: ADDRESS, methodId: "shm-ship" },
    });
    expect(runtime.database.prepare("SELECT reserved FROM variant_stock_levels WHERE variant_id = 'var-ship'").get()).toMatchObject({ reserved: 3 });
    runtime.database.prepare("UPDATE orders SET expires_at = '2026-08-15T00:00:00.000Z' WHERE public_id = ?").run(order.orderId);
    await expireUnpaidOrders(runtime.env, "2026-08-16T00:01:00.000Z");
    expect(runtime.database.prepare("SELECT status FROM orders WHERE public_id = ?").get(order.orderId)).toMatchObject({ status: "expired" });
    expect(runtime.database.prepare("SELECT reserved FROM variant_stock_levels WHERE variant_id = 'var-ship'").get()).toMatchObject({ reserved: 0 });
  });
});
