import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { checkoutCart, createCart, expireUnpaidOrders, quoteCart } from "../../src/lib/commerce/store";
import { listBookingSlots } from "../../src/lib/commerce/booking";
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

const NOW = "2026-09-20T00:00:00.000Z";

function createRuntime(): { database: DatabaseSync; env: AppBindings; shop: StorefrontShop } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
  database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES ('user-book', 'book@example.test', 'Book Owner', 'active', ?, ?)").run(NOW, NOW);
  database.prepare(`
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('shop-book', 'public-book', 'seller-book', 'Book Shop', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(NOW, NOW);
  database.prepare("INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at) VALUES ('shop-book', 'user-book', 'owner', 'active', ?, ?)").run(NOW, NOW);
  database.prepare("INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_end, created_at, updated_at) VALUES ('sub-book', 'shop-book', 'plan_business_v1', 'active', '2099-01-01T00:00:00.000Z', ?, ?)").run(NOW, NOW);
  // Bookable service: manual product + 45-minute variant.
  database.prepare(`
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, delivery_mode, version, created_at, updated_at)
    VALUES ('prd-book', 'shop-book', 'cat-toc', 'Cắt tóc nam', '', 'active', 'manual', 'digital', 1, ?, ?)
  `).run(NOW, NOW);
  database.prepare(`
    INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, duration_minutes, created_at, updated_at)
    VALUES ('var-book', 'shop-book', 'prd-book', 'CUT-45', '45 phút', '{}', 120000, 'VND', 1, 1, 'active', 1, 45, ?, ?)
  `).run(NOW, NOW);
  database.exec(`
    INSERT OR IGNORE INTO catalog_channel_visibility (shop_id, product_id, channel_code, status, version, updated_by_user_id, created_at, updated_at)
    VALUES ('shop-book', 'prd-book', 'website', 'visible', 1, 'user-book', '${NOW}', '${NOW}');
    INSERT INTO booking_resources (id, shop_id, name, role_label, status, created_at, updated_at)
    VALUES ('brs-a', 'shop-book', 'Anh Tuấn', 'Barber', 'active', '${NOW}', '${NOW}');
    INSERT INTO booking_resources (id, shop_id, name, role_label, status, created_at, updated_at)
    VALUES ('brs-b', 'shop-book', 'Anh Hòa', 'Barber', 'active', '${NOW}', '${NOW}');
    INSERT INTO booking_resource_schedules (id, shop_id, resource_id, weekday, start_minute, end_minute, status, created_at, updated_at)
    VALUES ('bsd-a1', 'shop-book', 'brs-a', 0, 540, 720, 'active', '${NOW}', '${NOW}'),
           ('bsd-b1', 'shop-book', 'brs-b', 0, 540, 765, 'active', '${NOW}', '${NOW}');
  `);
  const env = {
    IDENTIFIER_HMAC_SECRET: "booking-test-secret",
    PLATFORM_DB: new SqliteD1(database),
  } as unknown as AppBindings;
  const shop = {
    access: "live",
    content: { showExactStock: false },
    currency: "VND",
    currentPeriodEnd: "2099-01-01T00:00:00.000Z",
    graceEndsAt: null,
    id: "shop-book",
    lowStockThreshold: 5,
    orderExpiryMinutes: 30,
    status: "active",
    subscriptionState: "active",
    timezone: "Asia/Ho_Chi_Minh",
    trialEndsAt: null,
  } as unknown as StorefrontShop;
  return { database, env, shop };
}

async function bookCheckout(runtime: { env: AppBindings; shop: StorefrontShop }, booking: { resourceId: string; startAt: string } | undefined, idempotencyKey: string) {
  const cart = await createCart({ env: runtime.env, items: [{ quantity: 1, variantId: "var-book" }], locale: "vi", shop: runtime.shop });
  const quote = await quoteCart({ cartId: cart.cartId, cartToken: cart.cartToken, env: runtime.env, shop: runtime.shop });
  return checkoutCart({
    ...(booking === undefined ? {} : { booking }),
    cartId: cart.cartId,
    cartToken: cart.cartToken,
    customerEmail: "buyer@example.test",
    env: runtime.env,
    expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
    idempotencyKey,
    quoteEvidence: quote.quoteEvidence,
    shop: runtime.shop,
  });
}

describe("appointment booking money path", () => {
  it("computes timezone-correct slots from schedules minus busy intervals", async () => {
    const runtime = createRuntime();
    const slots = await listBookingSlots({ dateStart: "2026-09-20", dateEnd: "2026-09-20", env: runtime.env, shop: { id: "shop-book", timezone: "Asia/Ho_Chi_Minh" }, variantId: "var-book" });
    // Sunday 2026-09-20: brs-a 09:00–12:00 (4×45min), brs-b 09:00–12:45 (5×45min).
    expect(slots.filter((slot) => slot.resourceId === "brs-a")).toHaveLength(4);
    expect(slots.filter((slot) => slot.resourceId === "brs-b")).toHaveLength(5);
    // 09:00 ICT = 02:00 UTC.
    expect(slots[0]).toMatchObject({ endAt: "2026-09-20T02:45:00.000Z", resourceId: "brs-a", startAt: "2026-09-20T02:00:00.000Z" });
    expect(new Date(slots[0]?.startAt ?? "").toISOString()).toBe("2026-09-20T02:00:00.000Z");
  });

  it("books a slot atomically and blocks a same-slot double booking", async () => {
    const runtime = createRuntime();
    const first = await bookCheckout(runtime, { resourceId: "brs-a", startAt: "2026-09-20T02:00:00.000Z" }, "booking-key-0001");
    expect(first).toMatchObject({ paymentStatus: "unpaid", status: "pending_payment", totalMinor: 120000 });
    expect(runtime.database.prepare("SELECT status, start_at AS startAt FROM bookings").get()).toMatchObject({ startAt: "2026-09-20T02:00:00.000Z", status: "booked" });
    expect(runtime.database.prepare("SELECT COUNT(*) AS total FROM booking_holds WHERE status = 'active'").get()).toMatchObject({ total: 1 });
    // Same slot, other barber still books; same barber conflicts.
    await expect(bookCheckout(runtime, { resourceId: "brs-a", startAt: "2026-09-20T02:00:00.000Z" }, "booking-key-0002")).rejects.toMatchObject({ code: "booking_slot_taken", status: 409 });
    const second = await bookCheckout(runtime, { resourceId: "brs-b", startAt: "2026-09-20T02:00:00.000Z" }, "booking-key-0003");
    expect(second.status).toBe("pending_payment");
    expect(runtime.database.prepare("SELECT COUNT(*) AS total FROM orders").get()).toMatchObject({ total: 2 });
  });

  it("rejects carts without a slot, outside schedule windows, and quantity > 1", async () => {
    const runtime = createRuntime();
    await expect(bookCheckout(runtime, undefined, "booking-key-0004")).rejects.toMatchObject({ code: "validation_failed", issues: ["booking_slot_required"] });
    // 08:15 ICT does not align with any window start (09:00).
    await expect(bookCheckout(runtime, { resourceId: "brs-a", startAt: "2026-09-20T01:15:00.000Z" }, "booking-key-0005")).rejects.toMatchObject({ code: "booking_slot_invalid", status: 404 });
    const cart = await createCart({ env: runtime.env, items: [{ quantity: 1, variantId: "var-book" }, { quantity: 1, variantId: "var-book" }], locale: "vi", shop: runtime.shop }).catch(() => null);
    void cart;
    runtime.database.prepare("UPDATE product_variants SET max_per_order = 2 WHERE id = 'var-book'").run();
    const multi = await createCart({ env: runtime.env, items: [{ quantity: 2, variantId: "var-book" }], locale: "vi", shop: runtime.shop });
    const quote = await quoteCart({ cartId: multi.cartId, cartToken: multi.cartToken, env: runtime.env, shop: runtime.shop });
    await expect(checkoutCart({
      booking: { resourceId: "brs-a", startAt: "2026-09-20T02:00:00.000Z" },
      cartId: multi.cartId,
      cartToken: multi.cartToken,
      customerEmail: "buyer@example.test",
      env: runtime.env,
      expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: "booking-key-0006",
      quoteEvidence: quote.quoteEvidence,
      shop: runtime.shop,
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["booking_cart_invalid"] });
    expect(runtime.database.prepare("SELECT COUNT(*) AS total FROM orders").get()).toMatchObject({ total: 0 });
  });

  it("replays one durable order per idempotency key", async () => {
    const runtime = createRuntime();
    const cart = await createCart({ env: runtime.env, items: [{ quantity: 1, variantId: "var-book" }], locale: "vi", shop: runtime.shop });
    const quote = await quoteCart({ cartId: cart.cartId, cartToken: cart.cartToken, env: runtime.env, shop: runtime.shop });
    const request = {
      booking: { resourceId: "brs-a", startAt: "2026-09-20T02:00:00.000Z" },
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail: "buyer@example.test",
      env: runtime.env,
      expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: "booking-key-0007",
      quoteEvidence: quote.quoteEvidence,
      shop: runtime.shop,
    };
    const first = await checkoutCart(request);
    // A same-key retry re-submits the original (now converted) cart and slot.
    const replay = await checkoutCart(request);
    expect(replay.orderId).toBe(first.orderId);
    expect(runtime.database.prepare("SELECT COUNT(*) AS total FROM orders").get()).toMatchObject({ total: 1 });
    expect(runtime.database.prepare("SELECT COUNT(*) AS total FROM bookings").get()).toMatchObject({ total: 1 });
  });

  it("cancels the booking and releases the hold when the order expires unpaid", async () => {
    const runtime = createRuntime();
    const order = await bookCheckout(runtime, { resourceId: "brs-a", startAt: "2026-09-20T02:00:00.000Z" }, "booking-key-0008");
    runtime.database.prepare("UPDATE orders SET expires_at = '2026-08-15T00:00:00.000Z' WHERE public_id = ?").run(order.orderId);
    await expireUnpaidOrders(runtime.env, "2026-09-20T00:01:00.000Z");
    expect(runtime.database.prepare("SELECT status FROM orders WHERE public_id = ?").get(order.orderId)).toMatchObject({ status: "expired" });
    expect(runtime.database.prepare("SELECT status FROM bookings").get()).toMatchObject({ status: "cancelled" });
    expect(runtime.database.prepare("SELECT status FROM booking_holds").get()).toMatchObject({ status: "released" });
    // The slot is bookable again after release.
    const again = await bookCheckout(runtime, { resourceId: "brs-a", startAt: "2026-09-20T02:00:00.000Z" }, "booking-key-0009");
    expect(again.status).toBe("pending_payment");
  });
});
