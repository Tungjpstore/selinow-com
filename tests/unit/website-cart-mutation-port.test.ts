import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommerceContext } from "../../src/lib/commerce/contracts";
import { purgeCartMutationReplays } from "../../src/lib/commerce/cart-mutation";
import { createWebsiteCommerceApplication } from "../../src/lib/commerce/website-port";
import type { AppBindings } from "../../src/lib/platform/bindings";
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
const NOW = "2026-07-29T00:00:00.000Z";

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

function createRuntime(): { database: SqliteD1; env: AppBindings; shop: StorefrontShop } {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    sqlite.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  sqlite.exec(`
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('shop-website', 'shop-public-website', 'website-shop', 'Website Shop', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}');
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
    VALUES ('product-website', 'shop-website', 'manual-product', 'Manual Product', '', 'active', 'manual', 1, '${NOW}', '${NOW}');
    INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
    VALUES ('variant-website', 'shop-website', 'product-website', 'SKU-WEBSITE', 'Default', '{}', 1000, 'VND', 1, 5, 'active', 3, '${NOW}', '${NOW}');
    INSERT INTO discounts (id, shop_id, code_normalized, type, value, currency, minimum_minor, status, created_at, updated_at)
    VALUES ('discount-website', 'shop-website', 'WELCOME10', 'percentage', 1000, 'VND', 0, 'active', '${NOW}', '${NOW}');
  `);
  const database = new SqliteD1(sqlite);
  const env = {
    IDENTIFIER_HMAC_SECRET: "website-cart-mutation-secret",
    PLATFORM_DB: database as unknown as D1Database,
  } as unknown as AppBindings;
  return { database, env, shop: { currency: "VND", currentPeriodEnd: "2099-01-01T00:00:00.000Z", id: "shop-website", orderExpiryMinutes: 30, status: "active", subscriptionState: "active" } as StorefrontShop };
}

function context(shopId = "shop-website"): CommerceContext {
  return {
    actor: { kind: "anonymous" },
    channel: { code: "website", connectionId: null },
    locale: "vi",
    requestId: "request-website-cart-001",
    shopId,
  };
}

function opaqueCart(cart: { access: { kind: "opaque_token"; token: string } | { kind: "principal" }; cartId: string }): { access: { kind: "opaque_token"; token: string }; cartId: string } {
  if (cart.access.kind !== "opaque_token") throw new Error("website_cart_access_invalid");
  return { access: cart.access, cartId: cart.cartId };
}

describe("Website canonical cart mutation port", () => {
  it("increments once and durably replays the same opaque mutation", async () => {
    const runtime = createRuntime();
    const application = createWebsiteCommerceApplication(runtime.env, runtime.shop);
    const cart = await application.createCart(context(), { items: [{ quantity: 1, variantId: "variant-website" }] });
    const cartReference = opaqueCart(cart);
    const command = {
      cart: cartReference,
      idempotencyKey: "website-mutation-0001",
      mutation: { kind: "item.increment" as const, quantity: 1, variantId: "variant-website" },
    };

    const first = await application.mutateCart(context(), command);
    const replay = await application.mutateCart(context(), command);

    expect(first).toEqual({ cart: cartReference, replayed: false });
    expect(replay).toEqual({ cart: first.cart, replayed: true });
    expect(runtime.database.database.prepare("SELECT quantity FROM cart_items WHERE cart_id = ? AND shop_id = ?").get(cart.cartId, runtime.shop.id)).toEqual({ quantity: 2 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM cart_mutations WHERE cart_id = ? AND shop_id = ?").get(cart.cartId, runtime.shop.id)).toEqual({ count: 1 });
  });

  it("fails closed when a website mutation key is reused with a different payload", async () => {
    const runtime = createRuntime();
    const application = createWebsiteCommerceApplication(runtime.env, runtime.shop);
    const cart = await application.createCart(context(), { items: [{ quantity: 1, variantId: "variant-website" }] });
    const cartReference = opaqueCart(cart);
    const command = {
      cart: cartReference,
      idempotencyKey: "website-mutation-0002",
      mutation: { kind: "item.increment" as const, quantity: 1, variantId: "variant-website" },
    };
    await application.mutateCart(context(), command);

    await expect(application.mutateCart(context(), { ...command, mutation: { ...command.mutation, quantity: 2 } })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(runtime.database.database.prepare("SELECT quantity FROM cart_items WHERE cart_id = ? AND shop_id = ?").get(cart.cartId, runtime.shop.id)).toEqual({ quantity: 2 });
  });

  it("applies the same persisted discount calculation to the website quote", async () => {
    const runtime = createRuntime();
    const application = createWebsiteCommerceApplication(runtime.env, runtime.shop);
    const cart = await application.createCart(context(), { items: [{ quantity: 2, variantId: "variant-website" }] });
    const cartReference = opaqueCart(cart);
    await application.mutateCart(context(), {
      cart: cartReference,
      idempotencyKey: "website-discount-0001",
      mutation: { code: "WELCOME10", kind: "discount.apply" },
    });

    const quote = await application.quoteCart(context(), { cart: cartReference });

    expect(quote).toMatchObject({ currency: "VND", discountMinor: 200, subtotalMinor: 2000, totalMinor: 1800 });
    expect(quote.items).toEqual([expect.objectContaining({ lineTotalMinor: 2000, quantity: 2, unitPriceMinor: 1000, variantId: "variant-website", variantVersion: 3 })]);
    expect(quote.quoteEvidence).toEqual(expect.any(String));
  });

  it("rejects checkout when discount state changes after the signed quote", async () => {
    const runtime = createRuntime();
    const application = createWebsiteCommerceApplication(runtime.env, runtime.shop);
    const cart = await application.createCart(context(), { items: [{ quantity: 1, variantId: "variant-website" }] });
    const cartReference = opaqueCart(cart);
    const quote = await application.quoteCart(context(), { cart: cartReference });
    if (quote.quoteEvidence === undefined) throw new Error("website_quote_evidence_missing");
    await application.mutateCart(context(), {
      cart: cartReference,
      idempotencyKey: "website-discount-0002",
      mutation: { code: "WELCOME10", kind: "discount.apply" },
    });

    await expect(application.checkoutCart(context(), {
      cart: cartReference,
      customerEmail: null,
      expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: "website-checkout-0001",
      quoteEvidence: quote.quoteEvidence,
    })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(runtime.shop.id)).toEqual({ count: 0 });
  });

  it("rejects cross-tenant context before mutation records or cart writes", async () => {
    const runtime = createRuntime();
    const application = createWebsiteCommerceApplication(runtime.env, runtime.shop);
    const cart = await application.createCart(context(), { items: [{ quantity: 1, variantId: "variant-website" }] });
    const cartReference = opaqueCart(cart);

    await expect(application.mutateCart(context("shop-other"), {
      cart: cartReference,
      idempotencyKey: "website-mutation-0003",
      mutation: { kind: "item.increment", quantity: 1, variantId: "variant-website" },
    })).rejects.toMatchObject({ code: "commerce_context_mismatch", status: 403 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM cart_mutations").get()).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT quantity FROM cart_items WHERE cart_id = ? AND shop_id = ?").get(cart.cartId, runtime.shop.id)).toEqual({ quantity: 1 });
  });

  it("serializes concurrent retries into one mutation and one replay record", async () => {
    const runtime = createRuntime();
    const application = createWebsiteCommerceApplication(runtime.env, runtime.shop);
    const cart = await application.createCart(context(), { items: [{ quantity: 1, variantId: "variant-website" }] });
    const command = {
      cart: opaqueCart(cart),
      idempotencyKey: "website-mutation-concurrent-0001",
      mutation: { kind: "item.increment" as const, quantity: 1, variantId: "variant-website" },
    };

    const results = await Promise.all([
      application.mutateCart(context(), command),
      application.mutateCart(context(), command),
    ]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(runtime.database.database.prepare("SELECT quantity FROM cart_items WHERE cart_id = ? AND shop_id = ?").get(cart.cartId, runtime.shop.id)).toEqual({ quantity: 2 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM cart_mutations WHERE cart_id = ? AND shop_id = ?").get(cart.cartId, runtime.shop.id)).toEqual({ count: 1 });
  });

  it("fails closed for expired replays and scheduled cleanup removes them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const runtime = createRuntime();
    const application = createWebsiteCommerceApplication(runtime.env, runtime.shop);
    const cart = await application.createCart(context(), { items: [{ quantity: 1, variantId: "variant-website" }] });
    const command = {
      cart: opaqueCart(cart),
      idempotencyKey: "website-mutation-expired-0001",
      mutation: { kind: "item.increment" as const, quantity: 1, variantId: "variant-website" },
    };
    await application.mutateCart(context(), command);
    vi.setSystemTime(new Date("2026-07-30T00:00:00.000Z"));

    await expect(application.mutateCart(context(), command)).rejects.toMatchObject({ code: "cart_not_found", status: 404 });
    await expect(purgeCartMutationReplays(runtime.env, new Date())).resolves.toBe(1);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM cart_mutations").get()).toEqual({ count: 0 });
  });
});
